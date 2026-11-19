import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { COMPUTER_IDLE_CLOSE_CODE } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { schema } from '../db/client.js';
import { settleComputerUses } from '../services/computer-use.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';
import { useTestSprites, type TestSprites } from '../test-computer.js';
import { attachComputerProxies, isComputerSocketPath, type ComputerProxies } from './computer.js';
import { attachGateway, type Gateway } from './gateway.js';

// The terminal and screen sockets on a Sprite (plan 9.5): an open
// connection keeps a Sprite awake and billing, so a socket that passes no
// frames for a while closes with COMPUTER_IDLE_CLOSE_CODE, agent side
// included; one that passes frames stays. Each socket is a use for the
// usage ledger.

describe('computer sockets on Sprites', () => {
  let t: TestApp;
  let sprites: TestSprites;
  let server: ServerType;
  let gateway: Gateway;
  let proxies: ComputerProxies;
  let base: string;
  let dana: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    sprites = await useTestSprites(t.ownerDeps);
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    gateway = await attachGateway(server, t.deps, { ignore: isComputerSocketPath });
    proxies = await attachComputerProxies(server, t.deps, { socketIdleMs: 300 });
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dana = (await t.signUp('dana@example.com')).cookie!;
    const res = await t.app.request('/api/v1/computer/start', {
      method: 'POST',
      headers: { cookie: dana },
    });
    expect(res.status, await res.clone().text()).toBe(200);
  });
  afterAll(async () => {
    await proxies.close();
    await gateway.close();
    await new Promise((resolve) => server.close(resolve));
    await sprites.close();
    await t.close();
  });

  const opened = (url: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { cookie: dana, origin: ORIGIN } });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  const closed = (ws: WebSocket) =>
    new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));

  it('closes an idle terminal with COMPUTER_IDLE_CLOSE_CODE, and records its use', async () => {
    const pty = `${base}/api/v1/computer/pty?cols=80&rows=24`;
    const socket = await opened(pty);
    const code = closed(socket);
    // Frames keep it open past the idle time.
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await new Promise<void>((resolve) => {
        socket.once('message', () => resolve());
        socket.send('ls');
      });
    }
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(await code).toBe(COMPUTER_IDLE_CLOSE_CODE);
    await settleComputerUses();
    await vi.waitFor(async () => {
      const used = await t.db
        .select()
        .from(schema.computerUsageIntervals)
        .where(eq(schema.computerUsageIntervals.reason, 'terminal'));
      expect(used).toEqual([expect.objectContaining({ provider: 'sprites' })]);
    });
    // The use took no hold of its own: the connection kept the Sprite awake.
    const [computer] = await t.db.select().from(schema.computers);
    expect([...sprites.api.sprites.get(computer!.containerId!)!.tasks.keys()]).toEqual([]);
  });
});
