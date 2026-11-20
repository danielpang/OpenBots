import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createSpritesApi, SpritesApiError, type SpritesApi } from './sprites-api.js';

// The SDK adapter against a local stand-in for the Sprites API: plain HTTP
// for the REST calls and the exec WebSocket's binary protocol (a stream id
// byte, then data: 0 stdin, 1 stdout, 2 stderr, 3 exit code, 4 stdin EOF).
// No network: the SDK is pointed at it with `baseUrl`.

const TOKEN = 'org-token-0123456789';

interface Seen {
  method: string;
  url: URL;
  authorization: string | undefined;
  body: Buffer;
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
  execRequests: { url: URL; authorization: string | undefined }[];
  close(): Promise<void>;
}

let api: FakeApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

async function startFakeApi(): Promise<FakeApi> {
  const wss = new WebSocketServer({ noServer: true });
  const fake: FakeApi = {
    url: '',
    seen: [],
    route: () => false,
    exec: (socket) => socket.send(Buffer.from([3, 0])),
    refuseExec: false,
    execRequests: [],
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const seen: Seen = {
        method: req.method ?? '',
        url: new URL(req.url ?? '/', 'http://fake'),
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks),
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
    fake.execRequests.push({ url, authorization: req.headers.authorization });
    wss.handleUpgrade(req, socket, head, (ws) => {
      const stdin: Buffer[] = [];
      const eof = new Promise<Buffer>((resolve) => {
        ws.on('message', (data: Buffer) => {
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

async function setup(timeoutMs?: number): Promise<{ fake: FakeApi; client: SpritesApi }> {
  api = await startFakeApi();
  return {
    fake: api,
    client: createSpritesApi({
      token: TOKEN,
      baseUrl: api.url,
      ...(timeoutMs ? { timeoutMs } : {}),
    }),
  };
}

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

    it('falls back to the newest listed checkpoint when the completion names none', async () => {
      const { fake, client } = await setup();
      fake.route = (seen, res) => {
        if (seen.url.pathname === '/v1/sprites/s1/checkpoint') {
          return ndjson(res, [{ type: 'complete', data: 'done' }]);
        }
        if (seen.url.pathname === '/v1/sprites/s1/checkpoints') {
          return json(res, 200, [
            { id: 'v2', create_time: '2026-01-04T09:00:00Z' },
            { id: 'v3', create_time: '2026-01-05T10:30:00Z' },
          ]);
        }
        return false;
      };
      expect(await client.createCheckpoint('s1')).toBe('v3');
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
