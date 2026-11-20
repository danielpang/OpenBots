import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createSpritesApi } from './sprites-api.js';

// The SDK reads its client signals once per process, on its first request,
// so this file has a process of its own (vitest runs each file apart) and
// sets the environment before anything here calls the API. The variables are
// ones the SDK reads to name the agent or CI it runs under.

const saved = { ...process.env };
const headers: IncomingHttpHeaders[] = [];
const wss = new WebSocketServer({ noServer: true });
const server = createServer((req, res) => {
  headers.push(req.headers);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});
server.on('upgrade', (req, socket, head) => {
  headers.push(req.headers);
  wss.handleUpgrade(req, socket, head, (ws) => ws.send(Buffer.from([3, 0])));
});

beforeAll(async () => {
  delete process.env.SPRITES_CLIENT_SIGNALS;
  process.env.FLY_INVOKED_BY = 'some-agent';
  process.env.CLAUDECODE = '1';
  process.env.CI = 'true';
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  process.env = saved;
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('the Sprites SDK client signals', () => {
  it('are off unless the operator turns them on', async () => {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = createSpritesApi({ token: 'org-token-0123456789', baseUrl });
    expect(await client.get('s1')).toBeNull();
    await client.exec('s1', ['true']);
    expect(headers).toHaveLength(2);
    for (const seen of headers) {
      expect(Object.keys(seen).filter((name) => name.startsWith('fly-client'))).toEqual([]);
      expect(seen['user-agent']).toMatch(/^sprites-js\/[\d.]+$/);
    }
    expect(process.env.SPRITES_CLIENT_SIGNALS).toBe('0');
  });

  it('leave a setting the operator made alone', () => {
    process.env.SPRITES_CLIENT_SIGNALS = '1';
    createSpritesApi({ token: 'org-token-0123456789' });
    expect(process.env.SPRITES_CLIENT_SIGNALS).toBe('1');
  });
});
