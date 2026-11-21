import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createSpritesApi,
  SPRITES_MAX_EXEC_OUTPUT_BYTES,
  SpritesApiError,
  type SpritesApi,
  type SpritesApiOptions,
} from './sprites-api.js';

// The SDK adapter against a local stand-in for the Sprites API: plain HTTP
// for the REST calls and the exec WebSocket's binary protocol (a stream id
// byte, then data: 0 stdin, 1 stdout, 2 stderr, 3 exit code, 4 stdin EOF).
// No network: the SDK is pointed at it with `baseUrl`.

const TOKEN = 'org-token-0123456789';

interface Seen {
  method: string;
  url: URL;
  authorization: string | undefined;
  headers: IncomingMessage['headers'];
  body: Buffer;
  /** Resolves when the client closes the request's connection or the answer ends. */
  closed: Promise<void>;
}

/** How the stand-in answers one exec: what it got on stdin, and the query. */
type ExecScript = (socket: WebSocket, stdin: Promise<Buffer>, url: URL) => void;

interface FakeApi {
  url: string;
  seen: Seen[];
  /** Answers a REST call; return false to fall through to a 404. */
  route: (seen: Seen, res: ServerResponse) => boolean | void;
  exec: ExecScript;
  /** Answers the exec upgrade with 401 instead. */
  refuseExec: boolean;
  /** Reads the exec upgrade request and never answers it. */
  hangExec: boolean;
  execRequests: ExecRequest[];
  close(): Promise<void>;
}

interface ExecRequest {
  url: URL;
  authorization: string | undefined;
  headers: IncomingMessage['headers'];
  /** The text (JSON) messages the client sent, such as a signal. */
  texts: string[];
  /** Resolves when the connection closes, from either side. */
  closed: Promise<void>;
}

let api: FakeApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

async function startFakeApi(): Promise<FakeApi> {
  const wss = new WebSocketServer({ noServer: true });
  const hung: Duplex[] = [];
  const fake: FakeApi = {
    url: '',
    seen: [],
    route: () => false,
    exec: (socket) => socket.send(Buffer.from([3, 0])),
    refuseExec: false,
    hangExec: false,
    execRequests: [],
    close: async () => {
      for (const client of wss.clients) client.terminate();
      for (const socket of hung) socket.destroy();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    const closed = new Promise<void>((resolve) => res.on('close', () => resolve()));
    req.on('end', () => {
      const seen: Seen = {
        method: req.method ?? '',
        url: new URL(req.url ?? '/', 'http://fake'),
        authorization: req.headers.authorization,
        headers: req.headers,
        body: Buffer.concat(chunks),
        closed,
      };
      fake.seen.push(seen);
      if (fake.route(seen, res) === false && !res.headersSent) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found', message: 'no such sprite' }));
      }
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (fake.refuseExec || !/^\/v1\/sprites\/[^/]+\/exec$/.test(url.pathname)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    // `end` is the client's FIN: a closed connection, though a server that
    // never answers does not close its own side.
    const closed = new Promise<void>((resolve) => {
      socket.on('end', () => resolve());
      socket.on('close', () => resolve());
    });
    const request: ExecRequest = {
      url,
      authorization: req.headers.authorization,
      headers: req.headers,
      texts: [],
      closed,
    };
    fake.execRequests.push(request);
    if (fake.hangExec) {
      // Read (so a close from the client is seen) but never answer.
      socket.resume();
      hung.push(socket);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const stdin: Buffer[] = [];
      const eof = new Promise<Buffer>((resolve) => {
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (!isBinary) {
            request.texts.push(data.toString());
            return;
          }
          if (data[0] === 0) stdin.push(data.subarray(1));
          if (data[0] === 4) resolve(Buffer.concat(stdin));
        });
      });
      fake.exec(ws, eof, url);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const frame = (id: number, text = '') => Buffer.concat([Buffer.from([id]), Buffer.from(text)]);

async function setup(
  timeoutMs?: number,
  more: Partial<SpritesApiOptions> = {},
): Promise<{ fake: FakeApi; client: SpritesApi }> {
  api = await startFakeApi();
  return {
    fake: api,
    client: createSpritesApi({
      token: TOKEN,
      baseUrl: api.url,
      ...(timeoutMs ? { timeoutMs } : {}),
      ...more,
    }),
  };
}

/** Resolves true once `closed` does, false if it has not within `ms`. */
const closesWithin = (closed: Promise<void>, ms: number) =>
  Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

/** The session_info message the API sends when an exec starts. */
const sessionInfo = (id: string) =>
  JSON.stringify({
    type: 'session_info',
    session_id: id,
    command: 'bash',
    created: 1767609000,
    cols: 0,
    rows: 0,
    is_owner: true,
    tty: false,
  });

describe('the Sprites SDK adapter', () => {
  describe('exec', () => {
    it('runs the argv with the org token, the env and stdin, and keeps the streams apart', async () => {
      const { fake, client } = await setup();
      fake.exec = (socket, stdin) => {
        void stdin.then((input) => {
          socket.send(frame(1, `read ${input.toString()}`));
          socket.send(frame(2, 'a warning'));
          socket.send(frame(1, ' and done'));
          socket.send(Buffer.from([3, 2]));
        });
      };
      const result = await client.exec('s1', ['bash', '-c', 'echo "a b"'], {
        stdin: 'token-on-stdin\n',
        env: { TZ: 'Europe/Berlin' },
        cwd: '/home/bot',
      });
      // A non-zero exit is a result, not an error.
      expect(result).toEqual({
        exitCode: 2,
        stdout: 'read token-on-stdin\n and done',
        stderr: 'a warning',
      });
      const [request] = fake.execRequests;
      expect(request!.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request!.url.pathname).toBe('/v1/sprites/s1/exec');
      expect(request!.url.searchParams.getAll('cmd')).toEqual(['bash', '-c', 'echo "a b"']);
      expect(request!.url.searchParams.get('path')).toBe('bash');
      expect(request!.url.searchParams.getAll('env')).toEqual(['TZ=Europe/Berlin']);
      expect(request!.url.searchParams.get('dir')).toBe('/home/bot');
      // stdin never travels in the URL.
      expect(request!.url.search).not.toContain('token-on-stdin');
    });

    it('closes stdin when there is none, so a command reading it ends', async () => {
      const { fake, client } = await setup();
      fake.exec = (socket, stdin) => {
        void stdin.then((input) => {
          socket.send(frame(1, `got ${input.length} bytes`));
          socket.send(Buffer.from([3, 0]));
        });
      };
      expect(await client.exec('s1', ['cat'])).toEqual({
        exitCode: 0,
        stdout: 'got 0 bytes',
        stderr: '',
      });
    });

    it('fails when the connection closes without an exit code', async () => {
      const { fake, client } = await setup();
      fake.exec = (socket) => {
        socket.send(frame(1, 'cut'));
        setTimeout(() => socket.close(1011, 'gone'), 20);
      };
      await expect(client.exec('s1', ['true'])).rejects.toThrow(/without an exit code/);
    });

    it('gives up after its time limit', async () => {
      const { fake, client } = await setup();
      fake.exec = () => undefined;
      const error = await client.exec('s1', ['sleep', '600'], { timeoutMs: 200 }).catch((e) => e);
      expect(error).toBeInstanceOf(SpritesApiError);
      expect(String(error)).toMatch(/timed out after 200 ms/);
    });

    it('fails cleanly when the API refuses the connection', async () => {
      const { fake, client } = await setup();
      fake.refuseExec = true;
      const error = (await client.exec('s1', ['true']).catch((e) => e)) as SpritesApiError;
      expect(error).toBeInstanceOf(SpritesApiError);
      expect(error.message).not.toContain(TOKEN);
    });

    it('bounds how long a command outlives a dropped connection', async () => {
      const { fake, client } = await setup();
      await client.exec('s1', ['true']);
      await client.exec('s1', ['true'], { maxRunAfterDisconnect: '1s' });
      expect(
        fake.execRequests.map((r) => r.url.searchParams.get('max_run_after_disconnect')),
      ).toEqual(['10s', '1s']);
    });

    it('on its time limit signals the command, kills its session and closes the socket', async () => {
      const { fake, client } = await setup();
      const kills: Seen[] = [];
      fake.route = (seen, res) => {
        if (seen.method === 'POST' && seen.url.pathname === '/v1/sprites/s1/exec/1847/kill') {
          kills.push(seen);
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.end(
            [
              { type: 'signal', message: 'Signaling SIGTERM', signal: 'SIGTERM', pid: 1847 },
              { type: 'exited', message: 'Process exited' },
              { type: 'complete', exit_code: 143 },
            ]
              .map((e) => `${JSON.stringify(e)}\n`)
              .join(''),
          );
          return;
        }
        return false;
      };
      fake.exec = (socket) => socket.send(sessionInfo('1847'));
      const error = await client.exec('s1', ['sleep', '600'], { timeoutMs: 200 }).catch((e) => e);
      expect(error).toBeInstanceOf(SpritesApiError);
      expect(String(error)).toMatch(/timed out after 200 ms/);
      const [request] = fake.execRequests;
      expect(request!.texts.map((t) => JSON.parse(t) as unknown)).toContainEqual({
        type: 'signal',
        signal: 'SIGTERM',
      });
      expect(kills).toHaveLength(1);
      expect(kills[0]!.authorization).toBe(`Bearer ${TOKEN}`);
      expect(await closesWithin(request!.closed, 1000)).toBe(true);
    });

    it('closes the socket when the handshake does not answer in time', async () => {
      const { fake, client } = await setup();
      fake.hangExec = true;
      const error = await client.exec('s1', ['true'], { timeoutMs: 200 }).catch((e) => e);
      expect(error).toBeInstanceOf(SpritesApiError);
      expect(await closesWithin(fake.execRequests[0]!.closed, 1000)).toBe(true);
    });

    it('stops reading past the output limit, stdout and stderr together', async () => {
      const { fake, client } = await setup();
      const kills: string[] = [];
      fake.route = (seen, res) => {
        if (seen.url.pathname.endsWith('/kill')) {
          kills.push(seen.url.pathname);
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.end(`${JSON.stringify({ type: 'complete', exit_code: 137 })}\n`);
          return;
        }
        return false;
      };
      const half = Math.ceil(SPRITES_MAX_EXEC_OUTPUT_BYTES / 2);
      let sent = 0;
      fake.exec = (socket) => {
        socket.send(sessionInfo('77'));
        // Neither stream alone passes the limit; both together do. Then it
        // keeps going, as a runaway command would.
        const chunk = 256 * 1024;
        const pump = () => {
          if (socket.readyState !== socket.OPEN || sent > 4 * SPRITES_MAX_EXEC_OUTPUT_BYTES) return;
          socket.send(Buffer.concat([Buffer.from([sent < half ? 1 : 2]), Buffer.alloc(chunk, 97)]));
          sent += chunk;
          setImmediate(pump);
        };
        pump();
      };
      const error = (await client.exec('s1', ['yes']).catch((e) => e)) as SpritesApiError;
      expect(error).toBeInstanceOf(SpritesApiError);
      expect(error.message).toMatch(/output passed/);
      expect(kills).toEqual(['/v1/sprites/s1/exec/77/kill']);
      expect(await closesWithin(fake.execRequests[0]!.closed, 1000)).toBe(true);
      expect(sent).toBeLessThan(2 * SPRITES_MAX_EXEC_OUTPUT_BYTES);
    });

    it('fails on an exit frame without an exit code', async () => {
      const { fake, client } = await setup();
      fake.exec = (socket) => {
        socket.send(frame(1, 'partial'));
        socket.send(Buffer.from([3]));
      };
      await expect(client.exec('s1', ['true'])).rejects.toThrow(/without an exit code/);
    });

    it('keeps the command line and its env out of the error, naming the Sprite instead', async () => {
      const { fake, client } = await setup();
      fake.refuseExec = true;
      const error = (await client
        .exec('ob-7', ['bash', '-c', 'echo private-argument'], { env: { SECRETISH: 'env-value' } })
        .catch((e) => e)) as SpritesApiError;
      expect(error).toBeInstanceOf(SpritesApiError);
      expect(error.message).toMatch(/^Sprites API: exec failed for ob-7/);
      for (const leak of ['private-argument', 'env-value', 'SECRETISH', 'cmd=', 'ws://', 'url:']) {
        expect(error.message).not.toContain(leak);
      }
    });
  });

  describe('Sprites', () => {
    it('creates with the URL setting and reads the URL, status and setting back', async () => {
      const { fake, client } = await setup();
      fake.route = (seen, res) => {
        if (seen.method === 'POST' && seen.url.pathname === '/v1/sprites') {
          json(res, 201, {
            name: 'ob-1',
            url: 'https://ob-1-abc.sprites.app',
            status: 'cold',
            url_settings: { auth: 'public' },
          });
          return;
        }
        return false;
      };
      expect(await client.create('ob-1', { urlAuth: 'public' })).toEqual({
        name: 'ob-1',
        url: 'https://ob-1-abc.sprites.app',
        status: 'cold',
        urlAuth: 'public',
      });
      expect(JSON.parse(fake.seen[0]!.body.toString())).toEqual({
        name: 'ob-1',
        url_settings: { auth: 'public' },
      });
      expect(fake.seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('reads a missing Sprite as null and deleting one already gone as done', async () => {
      const { client } = await setup();
      expect(await client.get('gone')).toBeNull();
      await expect(client.delete('gone')).resolves.toBeUndefined();
    });

    it('maps a failure to its status, with no token in the text', async () => {
      const { fake, client } = await setup();
      // An upstream that echoes the request's credentials into its error.
      fake.route = (seen, res) => json(res, 500, { message: `boom for ${seen.authorization}` });
      const error = (await client.setUrlAuth('s1', 'sprite').catch((e) => e)) as SpritesApiError;
      expect(error).toBeInstanceOf(SpritesApiError);
      expect(error.status).toBe(500);
      expect(error.message).toMatch(/^Sprites API: URL settings failed \(500\)/);
      expect(error.message).not.toContain(TOKEN);
      const got = (await client.get('s1').catch((e) => e)) as SpritesApiError;
      expect(got.status).toBe(500);
      expect(got.message).not.toContain(TOKEN);
    });

    it('redacts the token in every form an upstream answer may carry it', async () => {
      // A token shaped like a real one (`<org>/<id>/<secret>`), so its
      // URL-encoded and base64 forms differ from it.
      const token = 'my-org/tok_1/s3cr+t/xyz==';
      api = await startFakeApi();
      const fake = api;
      const client = createSpritesApi({ token, baseUrl: fake.url });
      const forms = [
        token,
        encodeURIComponent(token),
        encodeURIComponent(token).toLowerCase(),
        new URLSearchParams({ t: token }).toString().slice(2),
        Buffer.from(token).toString('base64'),
        Buffer.from(token).toString('base64url'),
      ];
      fake.route = (seen, res) => {
        if (seen.url.pathname === '/v1/sprites/s1/policy/network') {
          return json(res, 400, { error: `bad rule; you sent ${forms.join(' and ')}` });
        }
        if (seen.url.pathname === '/v1/sprites/s1/checkpoint') {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.end(`${JSON.stringify({ type: 'error', error: `denied for ${forms.join(' ')}` })}\n`);
          return;
        }
        if (seen.url.pathname === '/v1/sprites/s1') {
          // The token at the very end of a long answer, where a clip cuts it.
          return json(res, 500, { message: `${'x'.repeat(480)} ${token}` });
        }
        return false;
      };
      const errors = [
        await client
          .setNetworkPolicy('s1', { rules: [{ domain: 'a.b', action: 'allow' }] })
          .catch((e: unknown) => e),
        await client.createCheckpoint('s1', 'c').catch((e: unknown) => e),
        await client.get('s1').catch((e: unknown) => e),
      ] as SpritesApiError[];
      for (const error of errors) {
        expect(error).toBeInstanceOf(SpritesApiError);
        for (const form of forms) expect(error.message).not.toContain(form.slice(0, 12));
      }
      expect(errors[1]!.message).toMatch(/denied for \[token\]/);
    });

    it('gives up on a call that does not answer within its time limit', async () => {
      const { fake, client } = await setup(200);
      fake.route = () => undefined; // never answers
      const error = (await client.get('s1').catch((e) => e)) as SpritesApiError;
      expect(error).toBeInstanceOf(SpritesApiError);
      expect(error.status).toBe(0);
    });
  });

  describe('the network policy', () => {
    it('sends the rules and takes 200 or 204 as done', async () => {
      const { fake, client } = await setup();
      const statuses = [200, 204];
      fake.route = (seen, res) => {
        if (seen.url.pathname !== '/v1/sprites/s1/policy/network') return false;
        const status = statuses.shift()!;
        if (status === 204) {
          res.writeHead(204);
          res.end();
        } else json(res, 200, JSON.parse(seen.body.toString()));
      };
      const policy = {
        rules: [{ include: 'defaults' }, { domain: 'x.ai', action: 'allow' as const }],
      };
      await client.setNetworkPolicy('s1', policy);
      await client.setNetworkPolicy('s1', policy);
      expect(fake.seen.map((s) => [s.method, s.authorization])).toEqual([
        ['POST', `Bearer ${TOKEN}`],
        ['POST', `Bearer ${TOKEN}`],
      ]);
      expect(JSON.parse(fake.seen[0]!.body.toString())).toEqual(policy);
    });

    it('reports a refused policy with its status', async () => {
      const { fake, client } = await setup();
      fake.route = (_, res) => json(res, 400, { error: 'invalid rule' });
      await expect(
        client.setNetworkPolicy('s1', { rules: [{ domain: 'bad', action: 'allow' }] }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('files', () => {
    it('writes with the mode from the root and reads back, a missing file as null', async () => {
      const { fake, client } = await setup();
      const files = new Map<string, Buffer>();
      fake.route = (seen, res) => {
        const path = seen.url.searchParams.get('path')!;
        if (seen.url.pathname === '/v1/sprites/s1/fs/write') {
          files.set(path, seen.body);
          return json(res, 200, { path, size: seen.body.length });
        }
        if (seen.url.pathname === '/v1/sprites/s1/fs/read') {
          const data = files.get(path);
          if (!data) return json(res, 404, { error: 'not found', code: 'ENOENT', path });
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(data);
          return;
        }
        return false;
      };
      await client.writeFile('s1', '/var/tmp/x/a.sh', new Uint8Array([1, 2, 3]), { mode: 0o644 });
      const write = fake.seen[0]!.url.searchParams;
      expect(write.get('mode')).toBe('0644');
      expect(write.get('workingDir')).toBe('/');
      expect(await client.readFile('s1', '/var/tmp/x/a.sh')).toEqual(new Uint8Array([1, 2, 3]));
      expect(await client.readFile('s1', '/nope')).toBeNull();
    });

    it('refuses a write larger than the API takes, before sending it', async () => {
      const { fake, client } = await setup();
      await expect(
        client.writeFile('s1', '/big', new Uint8Array(16 * 1024 * 1024 + 1)),
      ).rejects.toThrow(/at most/);
      expect(fake.seen).toEqual([]);
    });

    it('abandons a write or a read on its time limit, so a late one cannot land', async () => {
      const { fake, client } = await setup(200, { writeTimeoutMs: 200 });
      fake.route = () => undefined; // takes the body, never answers
      const write = await client
        .writeFile('s1', '/var/tmp/x/b', new Uint8Array([1]))
        .catch((e: unknown) => e);
      expect(write).toBeInstanceOf(SpritesApiError);
      expect(String(write)).toMatch(/timed out/);
      expect(await closesWithin(fake.seen[0]!.closed, 1000)).toBe(true);
      const read = await client.readFile('s1', '/var/tmp/x/b').catch((e: unknown) => e);
      expect(read).toBeInstanceOf(SpritesApiError);
      expect(await closesWithin(fake.seen[1]!.closed, 1000)).toBe(true);
    });

    it('reports a refused write with its status', async () => {
      const { fake, client } = await setup();
      fake.route = (_, res) => json(res, 507, { error: 'no space left', code: 'ENOSPC' });
      await expect(client.writeFile('s1', '/a', new Uint8Array([1]))).rejects.toMatchObject({
        status: 507,
      });
    });
  });

  describe('checkpoints', () => {
    const ndjson = (res: ServerResponse, events: object[]) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(events.map((e) => `${JSON.stringify(e)}\n`).join(''));
    };

    it('reads the new id from the completion and lists and restores', async () => {
      const { fake, client } = await setup();
      fake.route = (seen, res) => {
        if (seen.url.pathname === '/v1/sprites/s1/checkpoint') {
          expect(JSON.parse(seen.body.toString())).toEqual({ comment: 'before' });
          return ndjson(res, [
            { type: 'info', data: 'Creating checkpoint' },
            { type: 'complete', data: 'Checkpoint v8 created' },
          ]);
        }
        if (seen.url.pathname === '/v1/sprites/s1/checkpoints') {
          return json(res, 200, [
            { id: 'v8', create_time: '2026-01-05T10:30:00Z', comment: 'before' },
            { id: 'v7', create_time: '2026-01-04T09:00:00Z' },
          ]);
        }
        if (seen.url.pathname === '/v1/sprites/s1/checkpoints/v8/restore') {
          return ndjson(res, [{ type: 'complete', data: 'Restored' }]);
        }
        return false;
      };
      expect(await client.createCheckpoint('s1', 'before')).toBe('v8');
      expect(await client.listCheckpoints('s1')).toEqual([
        { id: 'v8', createdAt: '2026-01-05T10:30:00.000Z', comment: 'before' },
        { id: 'v7', createdAt: '2026-01-04T09:00:00.000Z' },
      ]);
      await expect(client.restoreCheckpoint('s1', 'v8')).resolves.toBeUndefined();
    });

    it('finds the new checkpoint by its comment when the completion names none', async () => {
      const { fake, client } = await setup();
      fake.route = (seen, res) => {
        if (seen.url.pathname === '/v1/sprites/s1/checkpoint') {
          return ndjson(res, [{ type: 'complete', data: 'done' }]);
        }
        if (seen.url.pathname === '/v1/sprites/s1/checkpoints') {
          // Newer than ours: an automatic one and one someone else made.
          return json(res, 200, [
            { id: 'v2', create_time: '2026-01-04T09:00:00Z', comment: 'ours 1' },
            { id: 'v3', create_time: '2026-01-05T10:30:00Z', comment: 'someone else' },
            { id: 'v4', create_time: '2026-01-05T10:31:00Z', is_auto: true },
          ]);
        }
        return false;
      };
      expect(await client.createCheckpoint('s1', 'ours 1')).toBe('v2');
      // No guess: without a comment, or with one no checkpoint carries.
      expect(await client.createCheckpoint('s1')).toBeNull();
      expect(await client.createCheckpoint('s1', 'ours 2')).toBeNull();
    });

    it('closes a checkpoint stream that runs past its time limit', async () => {
      const { fake, client } = await setup(undefined, { checkpointTimeoutMs: 200 });
      fake.route = (seen, res) => {
        if (seen.url.pathname === '/v1/sprites/s1/checkpoint') {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.write(`${JSON.stringify({ type: 'info', data: 'Creating checkpoint' })}\n`);
          return; // and never ends
        }
        if (seen.url.pathname === '/v1/sprites/s1/checkpoints/v1/restore') {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.write(`${JSON.stringify({ type: 'info', data: 'Restoring' })}\n`);
          return;
        }
        return false;
      };
      const made = await client.createCheckpoint('s1', 'c').catch((e: unknown) => e);
      expect(made).toBeInstanceOf(SpritesApiError);
      expect(String(made)).toMatch(/timed out/);
      expect(await closesWithin(fake.seen[0]!.closed, 1000)).toBe(true);
      const restored = await client.restoreCheckpoint('s1', 'v1').catch((e: unknown) => e);
      expect(restored).toBeInstanceOf(SpritesApiError);
      expect(await closesWithin(fake.seen[1]!.closed, 1000)).toBe(true);
    });

    it('fails on an error event and on a stream cut short', async () => {
      const { fake, client } = await setup();
      fake.route = (seen, res) => {
        if (seen.url.pathname === '/v1/sprites/s1/checkpoint') {
          return ndjson(res, [{ type: 'error', error: 'disk full' }]);
        }
        if (seen.url.pathname === '/v1/sprites/s1/checkpoints/v1/restore') {
          return ndjson(res, [{ type: 'info', data: 'Restoring' }]);
        }
        return false;
      };
      await expect(client.createCheckpoint('s1')).rejects.toThrow(/checkpoint failed: disk full/);
      await expect(client.restoreCheckpoint('s1', 'v1')).rejects.toBeInstanceOf(SpritesApiError);
    });
  });
});
