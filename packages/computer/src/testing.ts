import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpStdioSession } from '@openbots/computer-agent/mcp-stdio';
import {
  AGENT_TOKEN_HEADER,
  BROWSER_ACTIONS,
  BrowserActionSchemas,
  CoderClientMessageSchema,
  CookieSyncRequestSchema,
  ExecRequestSchema,
  InputActionSchema,
  StartScreenSchema,
  type BrowserActionName,
  type CoderClientMessage,
  type CoderServerMessage,
  type CoderStart,
  type ExecRequest,
  type FsEntry,
  type InputAction,
  type McpStdioStart,
  type ScreenInfo,
} from '@openbots/computer-agent/protocol';
import type Docker from 'dockerode';
import { WebSocketServer, type WebSocket } from 'ws';
import { GUARD_NAME, GUARD_PATH, type DockerApi } from './docker.js';
import type {
  SpriteExecOptions,
  SpriteExecResult,
  SpriteInfo,
  SpritesApi,
  SpriteStatus,
  SpriteUrlAuth,
} from './sprites-api.js';
import type { ComputerCheckpoint, EgressPolicy } from './types.js';

// Test doubles: an in-process control agent speaking
// `@openbots/computer-agent/protocol` (requests are validated with the agent's
// own schemas, so a client that drifts from the agent fails here), with a
// memory filesystem under the home, scripted exec, screens, a 1x1 PNG
// screenshot, echoing pty and vnc sockets, the agent's own `/mcp/stdio`
// running real processes on this machine, and a scripted `/coder` that runs
// nothing (`FakeAgent.coderScript`); and a dockerode stand-in that records
// every call. Server and agent tests use these; no daemon needed.

/** A 1x1 transparent PNG. */
export const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  ),
);

export interface FakeAgentCall {
  method: string;
  path: string;
  body?: unknown;
}

/** One `WS /coder` connection to the fake agent, for a `coderScript` to play. */
export interface FakeCoderSession {
  /** The start frame, defaults filled in by the agent's schema. */
  start: CoderStart;
  /** Every frame after the start, in order. */
  frames: CoderClientMessage[];
  /** Sends a frame as the agent would. */
  send(msg: CoderServerMessage): void;
  /** The next client frame of `type` not yet taken, waiting for it if need be. */
  next<T extends CoderClientMessage['type']>(
    type: T,
  ): Promise<Extract<CoderClientMessage, { type: T }>>;
  /** Closes the socket as the agent does after `exit`. */
  close(): void;
  closed: boolean;
}

/**
 * What `/coder` does with each session: frames to send in order (the socket
 * closes after an `exit`), or a function that plays the agent's side.
 */
export type FakeCoderScript =
  CoderServerMessage[] | ((session: FakeCoderSession) => void | Promise<void>);

export interface FakeAgent {
  url: string;
  /** The token it accepts; tests may set it to the one the server generated. */
  token: string;
  /** Files by path relative to the home (`notes/a.md`). */
  files: Map<string, Uint8Array>;
  screens: Map<number, ScreenInfo>;
  inputs: { n: number; action: InputAction }[];
  browser: { n: number; action: { action: BrowserActionName } & Record<string, unknown> }[];
  /** Each `POST /cookies/sync`: its screen, null for every screen. */
  cookieSyncs: (number | null)[];
  calls: FakeAgentCall[];
  /** Replace to script `/exec`; the default echoes the command. */
  exec: (request: ExecRequest) => { stdout?: string; stderr?: string; exitCode?: number };
  /** Answers `/healthz` with 503 while false. */
  healthy: boolean;
  /** Each `/mcp/stdio` start, as the agent received it (secrets included: tests only). */
  mcpStdio: McpStdioStart[];
  /**
   * What a start runs instead; as received by default. Tests point catalog
   * binaries, which live only in the computer image, at a local server.
   */
  mcpLaunch: (start: McpStdioStart) => McpStdioStart;
  /** A real temporary directory standing in for the home, for `/mcp/stdio` (`dirs`, `cwd`). */
  home: string;
  /** Each `/coder` start, as the agent received it (secrets included: tests only). */
  coderStarts: CoderStart[];
  /** Every `/coder` frame after a start (stdin, answer, credential, signal, resize), all sessions. */
  coderFrames: CoderClientMessage[];
  coderSessions: FakeCoderSession[];
  /**
   * How `/coder` answers; by default `started` (pid 1, a session directory
   * under /tmp/openbots/coders) and then `exit` with code 0. Nothing runs.
   */
  coderScript: FakeCoderScript;
  close(): Promise<void>;
}

const defaultCoderScript: FakeCoderScript = (session) => {
  session.send({
    type: 'started',
    pid: 1,
    session_dir: `/tmp/openbots/coders/${session.start.session_id}`,
  });
  session.send({ type: 'exit', code: 0, signal: null });
  session.close();
};

function fakeCoderSession(ws: WebSocket, agent: FakeAgent): void {
  let session: FakeCoderSession | undefined;
  const taken = new Set<number>();
  const waiters: (() => void)[] = [];
  ws.on('message', (raw) => {
    let frame: CoderClientMessage;
    try {
      frame = CoderClientMessageSchema.parse(JSON.parse(raw.toString()));
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Not a valid coder message' }));
      return ws.close(1007);
    }
    if (!session) {
      if (frame.type !== 'start') {
        ws.send(JSON.stringify({ type: 'error', message: 'The first frame must be start' }));
        return ws.close(1008);
      }
      const s: FakeCoderSession = {
        start: frame,
        frames: [],
        closed: false,
        send: (msg) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        },
        next: (type) =>
          new Promise((resolve) => {
            const look = () => {
              const i = s.frames.findIndex((f, n) => f.type === type && !taken.has(n));
              if (i < 0) return false;
              taken.add(i);
              resolve(s.frames[i] as never);
              return true;
            };
            if (!look()) {
              const waiter = () => {
                if (look()) waiters.splice(waiters.indexOf(waiter), 1);
              };
              waiters.push(waiter);
            }
          }),
        close: () => {
          s.closed = true;
          ws.close(1000);
        },
      };
      session = s;
      agent.coderStarts.push(frame);
      agent.coderSessions.push(s);
      const script = agent.coderScript;
      void (async () => {
        if (typeof script === 'function') return script(s);
        for (const msg of script) s.send(msg);
        if (script.some((msg) => msg.type === 'exit')) s.close();
      })().catch((error: unknown) => {
        s.send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        s.close();
      });
      return;
    }
    session.frames.push(frame);
    agent.coderFrames.push(frame);
    for (const waiter of [...waiters]) waiter();
  });
  ws.on('close', () => {
    if (session) session.closed = true;
  });
}

export async function startFakeAgent({ token = 'agent-token' } = {}): Promise<FakeAgent> {
  const agent: FakeAgent = {
    url: '',
    token,
    files: new Map(),
    screens: new Map(),
    inputs: [],
    browser: [],
    cookieSyncs: [],
    calls: [],
    exec: (request) => ({ stdout: `ran: ${request.command}\n`, exitCode: 0 }),
    healthy: true,
    mcpStdio: [],
    mcpLaunch: (start) => start,
    home: mkdtempSync(join(tmpdir(), 'openbots-fake-home-')),
    coderStarts: [],
    coderFrames: [],
    coderSessions: [],
    coderScript: defaultCoderScript,
    close: async () => {},
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const status = (error as { status?: number }).status ?? (isZod(error) ? 400 : 500);
      problem(res, status, error instanceof Error ? error.message : String(error));
    });
  });

  // As the real agent: `Authorization: Bearer`, or X-OpenBots-Agent-Token
  // behind a proxy that keeps `Authorization` (a private Sprite URL).
  const authorized = (req: IncomingMessage) =>
    req.headers.authorization === `Bearer ${agent.token}` ||
    req.headers[AGENT_TOKEN_HEADER] === agent.token;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!authorized(req)) {
      return problem(res, 401, 'Send the agent token', 'UNAUTHORIZED');
    }
    const url = new URL(req.url ?? '/', 'http://agent');
    const method = req.method ?? 'GET';
    const raw = await readBody(req);
    const isJson = req.headers['content-type']?.includes('application/json');
    const body: unknown = isJson
      ? raw.length
        ? JSON.parse(Buffer.from(raw).toString())
        : {}
      : undefined;
    agent.calls.push({ method, path: url.pathname, ...(body !== undefined ? { body } : {}) });

    if (url.pathname === '/healthz') {
      return agent.healthy
        ? send(res, 200, { status: 'ok', version: 'fake', screens: [...agent.screens.values()] })
        : problem(res, 503, 'starting');
    }
    if (url.pathname === '/exec' && method === 'POST') {
      const result = agent.exec(ExecRequestSchema.parse(body));
      const line = (event: unknown) => `${JSON.stringify(event)}\n`;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(line({ type: 'start', pid: 1 }));
      if (result.stdout) res.write(line({ type: 'stdout', data: result.stdout }));
      if (result.stderr) res.write(line({ type: 'stderr', data: result.stderr }));
      const exit = { exitCode: result.exitCode ?? 0, signal: null, timedOut: false, durationMs: 1 };
      return res.end(line({ type: 'exit', ...exit }));
    }
    if (url.pathname === '/fs' || url.pathname.startsWith('/fs/')) {
      const rel = decodeURIComponent(url.pathname.slice(4)).replace(/^\/+|\/+$/g, '');
      if (rel.split('/').includes('..')) {
        return problem(res, 403, 'The path leaves the home directory', 'PATH_OUTSIDE_HOME');
      }
      if (method === 'GET') {
        const file = agent.files.get(rel);
        if (file) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          return res.end(Buffer.from(file));
        }
        const entries = listDir(agent.files, rel);
        if (!entries) return problem(res, 404, `No such path: /${rel}`, 'NOT_FOUND');
        return send(res, 200, { path: rel, entries });
      }
      if (method === 'PUT') {
        agent.files.set(rel, raw);
        return send(res, 201, fileEntry(rel, raw));
      }
      if (method === 'DELETE') {
        for (const path of [...agent.files.keys()]) {
          if (path === rel || path.startsWith(`${rel}/`)) agent.files.delete(path);
        }
        res.writeHead(204);
        return res.end();
      }
    }
    if (url.pathname === '/screens' && method === 'POST') {
      const { n, width = 1280, height = 800 } = StartScreenSchema.parse(body);
      const created = !agent.screens.has(n);
      const info: ScreenInfo = {
        n,
        display: `:${10 + n}`,
        width,
        height,
        vncPort: 5910 + n,
        cdpPort: 9222 + n,
      };
      agent.screens.set(n, info);
      return send(res, created ? 201 : 200, info);
    }
    const screen = /^\/screens\/(\d+)(\/.*)?$/.exec(url.pathname);
    if (screen) {
      const n = Number(screen[1]);
      const rest = screen[2] ?? '';
      const notRunning = () =>
        problem(res, 404, `Screen ${n} is not running`, 'SCREEN_NOT_RUNNING');
      if (rest === '' && method === 'DELETE') {
        if (!agent.screens.delete(n)) return notRunning();
        res.writeHead(204);
        return res.end();
      }
      if (!agent.screens.has(n)) return notRunning();
      if (rest === '/screenshot' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from(TINY_PNG));
      }
      if (rest === '/input' && method === 'POST') {
        InputActionSchema.parse(body);
        agent.inputs.push({ n, action: body as InputAction });
        return send(res, 200, { ok: true });
      }
      const browser = /^\/browser\/(\w+)$/.exec(rest);
      if (browser && method === 'POST') {
        const name = browser[1] as BrowserActionName;
        if (!(BROWSER_ACTIONS as readonly string[]).includes(name)) {
          return problem(res, 404, `No browser action "${name}"`, 'UNKNOWN_BROWSER_ACTION');
        }
        const input = BrowserActionSchemas[name].parse(body) as Record<string, unknown>;
        agent.browser.push({ n, action: { action: name, ...input } });
        if (name === 'navigate') {
          return send(res, 200, { url: input.url, title: `Title of ${String(input.url)}` });
        }
        if (name === 'snapshot') {
          return send(res, 200, {
            url: 'https://example.com/',
            title: 'Example',
            snapshot: '- heading "Example" [ref=e1]\n- link "More" [ref=e2]',
          });
        }
        return send(res, 200, { url: 'https://example.com/', title: 'Example' });
      }
    }
    if (url.pathname === '/cookies/sync' && method === 'POST') {
      const { screen } = CookieSyncRequestSchema.parse(body);
      if (screen !== undefined && !agent.screens.has(screen)) {
        return problem(res, 404, `Screen ${screen} is not running`, 'SCREEN_NOT_RUNNING');
      }
      agent.cookieSyncs.push(screen ?? null);
      const screens = screen === undefined ? [...agent.screens.keys()] : [screen];
      return send(res, 200, { screens, cookies: 0 });
    }
    if (url.pathname === '/wallpaper' && method === 'POST') {
      const hour = (body as { hour?: number }).hour ?? 12;
      return send(res, 200, { hour, screens: [...agent.screens.keys()] });
    }
    return problem(res, 404, 'No such endpoint', 'NOT_FOUND');
  }

  // `/pty` and `/vnc/:n` echo what they receive, prefixed, so proxies can be tested.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://agent').pathname;
    const vnc = /^\/vnc\/(\d+)$/.exec(path);
    const known =
      path === '/pty' ||
      path === '/mcp/stdio' ||
      path === '/coder' ||
      (vnc && agent.screens.has(Number(vnc[1])));
    if (!authorized(req) || !known) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    if (path === '/mcp/stdio') {
      wss.handleUpgrade(req, socket, head, (ws) =>
        mcpStdioSession(ws, {
          home: agent.home,
          graceMs: 200,
          prepare: (start) => {
            agent.mcpStdio.push(start);
            return agent.mcpLaunch(start);
          },
        }),
      );
      return;
    }
    if (path === '/coder') {
      wss.handleUpgrade(req, socket, head, (ws) => fakeCoderSession(ws, agent));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => {
        ws.send(isBinary ? data : `${path}:${data.toString()}`, { binary: isBinary });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  agent.close = async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(agent.home, { recursive: true, force: true });
  };
  return agent;
}

function fileEntry(rel: string, data: Uint8Array): FsEntry {
  return {
    name: rel.split('/').at(-1) ?? rel,
    path: rel,
    type: 'file',
    size: data.byteLength,
    modifiedAt: new Date(0).toISOString(),
  };
}

/** Directories exist where files are under them; the home always exists. */
function listDir(files: Map<string, Uint8Array>, dir: string): FsEntry[] | null {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, FsEntry>();
  for (const [path, data] of files) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...rest] = path.slice(prefix.length).split('/');
    if (!name) continue;
    const at = `${prefix}${name}`;
    entries.set(
      name,
      rest.length
        ? { name, path: at, type: 'dir', size: 0, modifiedAt: new Date(0).toISOString() }
        : fileEntry(at, data),
    );
  }
  if (!entries.size && dir !== '') return null;
  return [...entries.values()].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
}

function isZod(error: unknown) {
  return (error as { name?: string } | null)?.name === 'ZodError';
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function problem(res: ServerResponse, status: number, detail: string, code = 'ERROR') {
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify({ type: 'about:blank', title: 'Error', status, code, detail }));
}

export interface MockDocker extends DockerApi {
  calls: { op: string; args: unknown[] }[];
  images: Set<string>;
  /** Image ids by name, `sha256:<name>` unless set: change one to stand for a moved tag. */
  imageIds: Map<string, string>;
  networks: Set<string>;
  volumes: Set<string>;
  containers: Map<
    string,
    {
      spec: Docker.ContainerCreateOptions;
      running: boolean;
      /** The id of the image it was made from. */
      image: string;
      /** The last archive put into it, by the path it went to. */
      archives?: Map<string, Buffer>;
    }
  >;
  /** Whether it answers as the docker guard; set false to stand for an unfiltered daemon. */
  guarded: boolean;
}

/** A dockerode stand-in; containers get ids `c-<name>`. Errors carry `statusCode` like dockerode's. */
export function mockDocker(): MockDocker {
  const notFound = () => Object.assign(new Error('no such object'), { statusCode: 404 });
  const imageIdOf = (name: string) => docker.imageIds.get(name) ?? `sha256:${name}`;
  const docker: MockDocker = {
    calls: [],
    images: new Set(),
    imageIds: new Map(),
    networks: new Set(),
    volumes: new Set(),
    containers: new Map(),
    guarded: true,
    getImage: (name) => ({
      inspect: async () => {
        if (!docker.images.has(name)) throw notFound();
        return { Id: imageIdOf(name) };
      },
    }),
    pull: async (image) => {
      docker.calls.push({ op: 'pull', args: [image] });
      docker.images.add(image);
      const { Readable } = await import('node:stream');
      return Readable.from([]);
    },
    modem: {
      followProgress: (_stream, done) => done(null),
      dial: (options, done) => {
        if (docker.guarded && options.path === GUARD_PATH) done(null, { guard: GUARD_NAME });
        else done(Object.assign(new Error('(HTTP code 404) unexpected'), { statusCode: 404 }));
      },
    },
    getNetwork: (name) => ({
      inspect: async () => {
        if (!docker.networks.has(name)) throw notFound();
        return {};
      },
    }),
    createNetwork: async (options) => {
      docker.calls.push({ op: 'createNetwork', args: [options] });
      docker.networks.add(options.Name);
      return {};
    },
    getVolume: (name) => ({
      inspect: async () => {
        if (!docker.volumes.has(name)) throw notFound();
        return {};
      },
      remove: async () => {
        docker.calls.push({ op: 'removeVolume', args: [name] });
        if (!docker.volumes.delete(name)) throw notFound();
        return {};
      },
    }),
    createVolume: async (options) => {
      docker.calls.push({ op: 'createVolume', args: [options] });
      docker.volumes.add(String(options.Name));
      return {};
    },
    createContainer: async (spec) => {
      docker.calls.push({ op: 'createContainer', args: [spec] });
      const id = `c-${spec.name}`;
      docker.containers.set(id, { spec, running: false, image: imageIdOf(String(spec.Image)) });
      return { id };
    },
    getContainer: (id) => {
      const find = () => docker.containers.get(id) ?? docker.containers.get(`c-${id}`);
      return {
        start: async () => {
          docker.calls.push({ op: 'start', args: [id] });
          const c = find();
          if (!c) throw notFound();
          if (c.running) throw Object.assign(new Error('already started'), { statusCode: 304 });
          c.running = true;
          return {};
        },
        putArchive: async (file, options) => {
          docker.calls.push({ op: 'putArchive', args: [id, options] });
          const c = find();
          if (!c) throw notFound();
          (c.archives ??= new Map()).set(options.path, file);
          return {};
        },
        stop: async () => {
          docker.calls.push({ op: 'stop', args: [id] });
          const c = find();
          if (!c) throw notFound();
          if (!c.running) throw Object.assign(new Error('already stopped'), { statusCode: 304 });
          c.running = false;
          return {};
        },
        remove: async (options) => {
          docker.calls.push({ op: 'remove', args: [id, options] });
          const c = find();
          if (!c) throw notFound();
          docker.containers.delete(`c-${String(c.spec.name)}`);
          return {};
        },
        inspect: async () => {
          const c = find();
          if (!c) throw notFound();
          return { State: { Running: c.running }, Image: c.image };
        },
      };
    },
  };
  return docker;
}

/** One Sprite in `fakeSpritesApi`: its files, policy, holds and checkpoints. */
export interface FakeSprite {
  name: string;
  url: string;
  status: SpriteStatus;
  urlAuth: SpriteUrlAuth;
  files: Map<string, Uint8Array>;
  policy: EgressPolicy | null;
  /** Live Tasks API tasks by name, with their expiry in seconds. */
  tasks: Map<string, number>;
  checkpoints: (ComputerCheckpoint & { files: Map<string, Uint8Array> })[];
  /** Sprite services by name; the provision script registers the agent's. */
  services: Set<string>;
}

export interface FakeSpritesCall {
  op: keyof SpritesApi;
  name: string;
  args: unknown[];
}

export interface FakeSpritesApi extends SpritesApi {
  sprites: Map<string, FakeSprite>;
  calls: FakeSpritesCall[];
  /**
   * What the provision script does; by default it records its version in
   * /opt/openbots/provision.version, as docker/sprites/provision.sh does.
   * `token` is what it read on stdin.
   */
  provisionScript: (
    sprite: FakeSprite,
    run: { token: string; env: Record<string, string>; script: string; bundle: string },
  ) => SpriteExecResult;
  /** Each provision run, in order. */
  provisions: { name: string; token: string; env: Record<string, string> }[];
  /** Answers an exec before the built-in commands; return undefined to fall through. */
  execHook?: (
    sprite: FakeSprite,
    argv: string[],
    options: SpriteExecOptions,
  ) => SpriteExecResult | undefined;
  /** The url each new Sprite gets; a test points it at a fake agent. */
  urlFor: (name: string) => string;
}

/**
 * A stand-in for the Sprites API (packages/computer/src/sprites-api.ts), so
 * the sprites provider is tested without Fly. Exec understands the commands
 * the provider runs: mkdir, rm, the upload join, the provision script, the
 * Tasks API curl calls and the home wipe; anything else exits 0 silently.
 */
export function fakeSpritesApi(): FakeSpritesApi {
  const ok = (stdout = ''): SpriteExecResult => ({ exitCode: 0, stdout, stderr: '' });
  const missing = (name: string) =>
    Object.assign(new Error(`Sprites API: 404 no sprite ${name}`), { status: 404 });
  const info = (sprite: FakeSprite): SpriteInfo => ({
    name: sprite.name,
    url: sprite.url,
    status: sprite.status,
    urlAuth: sprite.urlAuth,
  });
  const decode = (data: Uint8Array | string | undefined) =>
    typeof data === 'string' ? data : data ? new TextDecoder().decode(data) : '';
  let checkpoints = 0;

  const api: FakeSpritesApi = {
    sprites: new Map(),
    calls: [],
    provisions: [],
    urlFor: (name) => `https://${name}-abc123.sprites.app`,
    provisionScript: (sprite, run) => {
      sprite.files.set(
        '/opt/openbots/provision.version',
        new TextEncoder().encode(`${run.env.OPENBOTS_PROVISION_VERSION ?? ''}\n`),
      );
      // As docker/sprites/provision.sh: the agent's service.
      sprite.services.add('openbots-agent');
      return ok('provisioned');
    },
    async create(name, { urlAuth }) {
      api.calls.push({ op: 'create', name, args: [{ urlAuth }] });
      if (api.sprites.has(name)) throw Object.assign(new Error('409 taken'), { status: 409 });
      const sprite: FakeSprite = {
        name,
        url: api.urlFor(name),
        status: 'running',
        urlAuth,
        files: new Map(),
        policy: null,
        tasks: new Map(),
        checkpoints: [],
        services: new Set(),
      };
      api.sprites.set(name, sprite);
      return info(sprite);
    },
    async get(name) {
      api.calls.push({ op: 'get', name, args: [] });
      const sprite = api.sprites.get(name);
      return sprite ? info(sprite) : null;
    },
    async delete(name) {
      api.calls.push({ op: 'delete', name, args: [] });
      api.sprites.delete(name);
    },
    async setUrlAuth(name, auth) {
      api.calls.push({ op: 'setUrlAuth', name, args: [auth] });
      const sprite = api.sprites.get(name);
      if (!sprite) throw missing(name);
      sprite.urlAuth = auth;
    },
    async setNetworkPolicy(name, policy) {
      api.calls.push({ op: 'setNetworkPolicy', name, args: [policy] });
      const sprite = api.sprites.get(name);
      if (!sprite) throw missing(name);
      sprite.policy = structuredClone(policy);
    },
    async exec(name, argv, options = {}) {
      api.calls.push({ op: 'exec', name, args: [argv, options] });
      const sprite = api.sprites.get(name);
      if (!sprite) throw missing(name);
      if (options.signal?.aborted) throw new Error('exec was ended by its caller');
      // A request wakes a paused Sprite.
      sprite.status = 'running';
      const hooked = api.execHook?.(sprite, argv, options);
      if (hooked) return hooked;
      const [command, ...args] = argv;
      if (command === 'curl' && args.includes('/.sprite/api.sock')) {
        const method = args[args.indexOf('-X') + 1];
        const url = args.find((arg) => arg.startsWith('http://sprite'))!;
        const task = url.replace('http://sprite/v1/tasks', '').replace(/^\//, '');
        if (method === 'GET') {
          return ok(JSON.stringify({ tasks: [...sprite.tasks.keys()].map((n) => ({ name: n })) }));
        }
        if (method === 'PUT') {
          const body = JSON.parse(args[args.indexOf('-d') + 1]!) as { expire: number };
          const created = !sprite.tasks.has(task);
          sprite.tasks.set(task, body.expire);
          return ok(created ? '201' : '200');
        }
        if (method === 'DELETE') return ok(sprite.tasks.delete(task) ? '204' : '404');
      }
      if (command === 'bash' && args[1]?.includes('read -r OPENBOTS_AGENT_TOKEN')) {
        const token = decode(options.stdin).replace(/\n$/, '');
        const env = options.env ?? {};
        api.provisions.push({ name, token, env });
        return api.provisionScript(sprite, { token, env, script: args[2]!, bundle: args[3]! });
      }
      if (command === 'bash' && args[2] === 'join') {
        const [out, ...parts] = args.slice(3);
        const joined = Buffer.concat(
          parts.map((part) => sprite.files.get(part) ?? new Uint8Array()),
        );
        for (const part of parts) sprite.files.delete(part);
        sprite.files.set(out!, new Uint8Array(joined));
        return ok();
      }
      if (command === 'bash' && args[2] === 'as-root') {
        // The home wipe (`find <home> -mindepth 1 -delete`) and `rm -rf <dir>`.
        const home = /^find (\S+) -mindepth 1 -delete$/m.exec(args[3] ?? '')?.[1];
        const removed = /^rm -rf (\S+)$/m.exec(args[3] ?? '')?.[1];
        for (const path of [...sprite.files.keys()]) {
          if (home && path.startsWith(`${home}/`)) sprite.files.delete(path);
          if (removed && (path === removed || path.startsWith(`${removed}/`))) {
            sprite.files.delete(path);
          }
        }
        return ok();
      }
      if (command === 'rm') {
        const target = args[args.length - 1]!;
        for (const path of [...sprite.files.keys()]) {
          if (path === target || path.startsWith(`${target}/`)) sprite.files.delete(path);
        }
      }
      return ok();
    },
    async writeFile(name, path, data, options) {
      api.calls.push({ op: 'writeFile', name, args: [path, data.byteLength, options] });
      const sprite = api.sprites.get(name);
      if (!sprite) throw missing(name);
      sprite.files.set(path, new Uint8Array(data));
    },
    async readFile(name, path) {
      api.calls.push({ op: 'readFile', name, args: [path] });
      const sprite = api.sprites.get(name);
      if (!sprite) throw missing(name);
      sprite.status = 'running';
      return sprite.files.get(path) ?? null;
    },
    async createCheckpoint(name, comment) {
      api.calls.push({ op: 'createCheckpoint', name, args: [comment] });
      const sprite = api.sprites.get(name);
      if (!sprite) throw missing(name);
      const id = `v${++checkpoints}`;
      sprite.checkpoints.push({
        id,
        createdAt: new Date().toISOString(),
        ...(comment ? { comment } : {}),
        files: new Map(sprite.files),
      });
      return id;
    },
    async listCheckpoints(name) {
      api.calls.push({ op: 'listCheckpoints', name, args: [] });
      const sprite = api.sprites.get(name);
      if (!sprite) throw missing(name);
      return sprite.checkpoints.map(({ files: _, ...checkpoint }) => checkpoint);
    },
    async restoreCheckpoint(name, id) {
      api.calls.push({ op: 'restoreCheckpoint', name, args: [id] });
      const sprite = api.sprites.get(name);
      const checkpoint = sprite?.checkpoints.find((c) => c.id === id);
      if (!sprite || !checkpoint) throw missing(name);
      sprite.files = new Map(checkpoint.files);
    },
  };
  return api;
}
