import type { ComputerCheckpoint, EgressPolicy, EgressRule } from './types.js';

// The part of the Sprites REST API (https://api.sprites.dev, docs at
// https://docs.fly.io/sprites/api/) the sprites provider uses, behind a
// narrow interface so tests stand in a fake. The official SDK (@fly/sprites)
// needs Node 24 and this workspace runs on Node 22 with strict engines, so
// this is a small fetch client over the same documented endpoints instead;
// moving to the SDK later only means another `SpritesApi` adapter.

/** `cold` and `warm` are paused; a request to the Sprite or the API wakes it. */
export type SpriteStatus = 'cold' | 'warm' | 'running' | (string & {});

/** Who may reach the Sprite's URL: members of the org with an org token, or anyone. */
export type SpriteUrlAuth = 'sprite' | 'public';

export interface SpriteInfo {
  name: string;
  /** `https://<name>-<org id>.sprites.app`, routed to the Sprite's HTTP port. */
  url: string;
  status: SpriteStatus;
  urlAuth?: SpriteUrlAuth;
}

/** The Sprites network policy has the shape of the provider's egress policy. */
export type SpriteEgressRule = EgressRule;
export type SpriteEgressPolicy = EgressPolicy;

export interface SpriteExecOptions {
  /** Passed in the query string, so never a secret: send those on stdin. */
  env?: Record<string, string>;
  stdin?: Uint8Array | string;
  cwd?: string;
  timeoutMs?: number;
}

export interface SpriteExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SpriteCheckpoint = ComputerCheckpoint;

export interface SpritesApi {
  create(name: string, options: { urlAuth: SpriteUrlAuth }): Promise<SpriteInfo>;
  /** Null when there is no such Sprite. */
  get(name: string): Promise<SpriteInfo | null>;
  /** A Sprite already gone is not an error. */
  delete(name: string): Promise<void>;
  setUrlAuth(name: string, auth: SpriteUrlAuth): Promise<void>;
  setNetworkPolicy(name: string, policy: SpriteEgressPolicy): Promise<void>;
  /** Runs `argv` (no shell) and waits for it; a non-zero exit is a result, not an error. */
  exec(name: string, argv: string[], options?: SpriteExecOptions): Promise<SpriteExecResult>;
  writeFile(
    name: string,
    path: string,
    data: Uint8Array,
    options?: { mode?: number },
  ): Promise<void>;
  /** Null when the file does not exist. */
  readFile(name: string, path: string): Promise<Uint8Array | null>;
  /** Resolves with the new checkpoint's id once it is saved. */
  createCheckpoint(name: string, comment?: string): Promise<string>;
  listCheckpoints(name: string): Promise<SpriteCheckpoint[]>;
  restoreCheckpoint(name: string, id: string): Promise<void>;
}

export class SpritesApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SpritesApiError';
  }
}

export const SPRITES_API_URL = 'https://api.sprites.dev';
/** The largest body `fs/write` takes (16 MiB) and `exec` takes on stdin (10 MiB). */
export const SPRITES_MAX_WRITE_BYTES = 16 * 1024 * 1024;
export const SPRITES_MAX_STDIN_BYTES = 10 * 1024 * 1024;

export interface SpritesApiOptions {
  /** A Sprites org token (`sprite auth setup --token`, or the dashboard). */
  token: string;
  baseUrl?: string;
  /** Per-request timeout for everything but `exec` and checkpoints. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;
/** Checkpoints take 10 to 30 seconds by the docs; restores are similar. */
const CHECKPOINT_TIMEOUT_MS = 10 * 60_000;

interface RawSprite {
  name: string;
  url: string;
  status: string;
  url_settings?: { auth?: string } | null;
}

export function createSpritesApi({
  token,
  baseUrl = SPRITES_API_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetch: doFetch = fetch,
}: SpritesApiOptions): SpritesApi {
  const base = baseUrl.replace(/\/+$/, '');
  const spritePath = (name: string, rest = '') => `/v1/sprites/${encodeURIComponent(name)}${rest}`;

  async function request(
    method: string,
    path: string,
    init: {
      json?: unknown;
      body?: Uint8Array;
      query?: [string, string][];
      timeoutMs?: number;
      /** Statuses answered as they are instead of thrown. */
      allow?: number[];
    } = {},
  ): Promise<Response> {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of init.query ?? []) url.searchParams.append(key, value);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let body: RequestInit['body'];
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.body !== undefined) {
      headers['content-type'] = 'application/octet-stream';
      body = init.body as Uint8Array<ArrayBuffer>;
    }
    const response = await doFetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(init.timeoutMs ?? timeoutMs),
    });
    if (!response.ok && !init.allow?.includes(response.status)) {
      const text = (await response.text().catch(() => '')).trim().slice(0, 500);
      throw new SpritesApiError(
        response.status,
        `Sprites API ${method} ${path}: ${response.status}${text ? ` ${text}` : ''}`,
      );
    }
    return response;
  }

  const info = (raw: RawSprite): SpriteInfo => ({
    name: raw.name,
    url: raw.url,
    status: raw.status,
    ...(raw.url_settings?.auth === 'sprite' || raw.url_settings?.auth === 'public'
      ? { urlAuth: raw.url_settings.auth }
      : {}),
  });

  return {
    async create(name, { urlAuth }) {
      const response = await request('POST', '/v1/sprites', {
        json: { name, url_settings: { auth: urlAuth } },
        timeoutMs: 2 * 60_000,
      });
      return info((await response.json()) as RawSprite);
    },
    async get(name) {
      const response = await request('GET', spritePath(name), { allow: [404] });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      return info((await response.json()) as RawSprite);
    },
    async delete(name) {
      const response = await request('DELETE', spritePath(name), { allow: [404] });
      await response.body?.cancel();
    },
    async setUrlAuth(name, auth) {
      const response = await request('PUT', spritePath(name), {
        json: { url_settings: { auth } },
      });
      await response.body?.cancel();
    },
    async setNetworkPolicy(name, policy) {
      const response = await request('POST', spritePath(name, '/policy/network'), {
        json: { rules: policy.rules },
      });
      await response.body?.cancel();
    },
    async exec(name, argv, options = {}) {
      if (argv.length === 0) throw new Error('exec needs a command');
      const query: [string, string][] = argv.map((arg) => ['cmd', arg]);
      query.push(['path', argv[0]!]);
      if (options.cwd) query.push(['dir', options.cwd]);
      for (const [key, value] of Object.entries(options.env ?? {})) {
        query.push(['env', `${key}=${value}`]);
      }
      let body: Uint8Array | undefined;
      if (options.stdin !== undefined) {
        body =
          typeof options.stdin === 'string'
            ? new TextEncoder().encode(options.stdin)
            : options.stdin;
        if (body.byteLength > SPRITES_MAX_STDIN_BYTES) {
          throw new Error(`exec stdin is over ${SPRITES_MAX_STDIN_BYTES} bytes`);
        }
        query.push(['stdin', 'true']);
      }
      const response = await request('POST', spritePath(name, '/exec'), {
        query,
        body,
        timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      });
      return decodeExec(response);
    },
    async writeFile(name, path, data, options = {}) {
      if (data.byteLength > SPRITES_MAX_WRITE_BYTES) {
        throw new Error(`fs/write takes at most ${SPRITES_MAX_WRITE_BYTES} bytes`);
      }
      const query: [string, string][] = [
        ['path', path],
        ['workingDir', '/'],
        ['mkdir', 'true'],
      ];
      if (options.mode !== undefined) {
        query.push(['mode', options.mode.toString(8).padStart(4, '0')]);
      }
      const response = await request('PUT', spritePath(name, '/fs/write'), {
        query,
        body: data,
        timeoutMs: 5 * 60_000,
      });
      await response.body?.cancel();
    },
    async readFile(name, path) {
      const response = await request('GET', spritePath(name, '/fs/read'), {
        query: [
          ['path', path],
          ['workingDir', '/'],
        ],
        allow: [404],
      });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async createCheckpoint(name, comment) {
      const response = await request('POST', spritePath(name, '/checkpoint'), {
        json: comment ? { comment } : {},
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
      });
      const done = await readProgress(response, 'checkpoint');
      // "Checkpoint v8 created": the id is in the completion message. If a
      // later API words it otherwise, the newest checkpoint is the one made.
      const id = /\b(v\d+)\b/.exec(done ?? '')?.[1];
      if (id) return id;
      const [newest] = (await this.listCheckpoints(name)).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      if (!newest) throw new Error('The checkpoint was made but is not listed');
      return newest.id;
    },
    async listCheckpoints(name) {
      const response = await request('GET', spritePath(name, '/checkpoints'));
      const raw = (await response.json()) as {
        id: string;
        create_time: string;
        comment?: string;
      }[];
      return raw.map((cp) => ({
        id: cp.id,
        createdAt: cp.create_time,
        ...(cp.comment ? { comment: cp.comment } : {}),
      }));
    },
    async restoreCheckpoint(name, id) {
      const response = await request(
        'POST',
        spritePath(name, `/checkpoints/${encodeURIComponent(id)}/restore`),
        { timeoutMs: CHECKPOINT_TIMEOUT_MS },
      );
      await readProgress(response, 'restore');
    },
  };
}

/**
 * Reads a checkpoint or restore NDJSON progress stream to its end. Throws on
 * an `error` event or when the stream ends without `complete`; resolves with
 * the completion message.
 */
async function readProgress(response: Response, what: string): Promise<string | undefined> {
  const text = await response.text();
  let complete: string | undefined;
  let sawComplete = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event: { type?: string; data?: string; error?: string };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type === 'error') throw new Error(`The ${what} failed: ${event.error ?? 'error'}`);
    if (event.type === 'complete') {
      sawComplete = true;
      complete = event.data;
    }
  }
  if (!sawComplete) throw new Error(`The ${what} stream ended before it completed`);
  return complete;
}

/** Stream ids of the HTTP exec body (the same as the exec WebSocket's). */
const STDOUT = 1;
const STDERR = 2;
const EXIT = 3;

/**
 * Decodes the HTTP exec body: each HTTP chunk starts with a stream id byte
 * (1 stdout, 2 stderr) followed by data, and the body ends with the exit
 * frame `[3, code]`. Frames carry no length, so a read is taken to start a
 * frame, and each read's last two bytes are held back in case they are the
 * exit frame (the SDK's reader works the same way).
 */
export async function decodeExec(response: Response): Promise<SpriteExecResult> {
  if (!response.body) throw new Error('The exec answer has no body');
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  let stream = STDOUT;
  let held = new Uint8Array(0);
  let exitCode = -1;
  const write = (data: Uint8Array) => {
    if (data.length) (stream === STDERR ? err : out).push(data);
  };
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      write(held);
      held = new Uint8Array(0);
      const frame = value[0];
      if (frame === EXIT && value.length === 2) {
        exitCode = value[1]!;
        continue;
      }
      if (frame !== STDOUT && frame !== STDERR) {
        throw new Error(`Unexpected exec frame type ${frame}`);
      }
      stream = frame;
      const split = Math.max(1, value.length - 2);
      write(value.subarray(1, split));
      held = value.subarray(split);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (held.length === 2 && held[0] === EXIT) exitCode = held[1]!;
  else write(held);
  if (exitCode < 0) throw new Error('The exec answer ended without an exit code');
  const text = (parts: Uint8Array[]) => Buffer.concat(parts).toString('utf8');
  return { exitCode, stdout: text(out), stderr: text(err) };
}
