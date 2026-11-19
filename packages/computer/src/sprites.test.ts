import { afterEach, describe, expect, it } from 'vitest';
import { createSpritesApi, decodeExec, SPRITES_MAX_WRITE_BYTES } from './sprites-api.js';
import {
  createSpritesProvider,
  isEgressDomain,
  PROVISION_STAGING_DIR,
  PROVISION_VERSION_FILE,
  spriteName,
  spritesEgressPolicy,
  type SpritesProviderOptions,
} from './sprites.js';
import { fakeSpritesApi, startFakeAgent, type FakeAgent, type FakeSpritesApi } from './testing.js';
import type { ComputerRef, ComputerSpec } from './types.js';

const spec: ComputerSpec = {
  computerId: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  image: 'unused',
  agentToken: 'secret-agent-token',
  volumeName: 'unused',
  timezone: 'Europe/London',
};
const NAME = 'ob-11111111111141118111111111111111';
const SCRIPT = new TextEncoder().encode('#!/bin/bash\necho provision\n');
const BUNDLE = new Uint8Array([1, 2, 3, 4]);

let agent: FakeAgent | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
});

function setup(options: Partial<SpritesProviderOptions> = {}) {
  const api = fakeSpritesApi();
  const local = new Map<string, Uint8Array>([
    ['/prov/provision.sh', SCRIPT],
    ['/prov/agent-bundle.tgz', BUNDLE],
  ]);
  const provider = createSpritesProvider({
    token: 'org-token',
    api,
    provision: {
      scriptPath: '/prov/provision.sh',
      bundlePath: '/prov/agent-bundle.tgz',
      version: '7',
    },
    readLocalFile: async (path) => {
      const data = local.get(path);
      if (!data) throw new Error(`no ${path}`);
      return data;
    },
    readyTimeoutMs: 2000,
    pollMs: 10,
    deleteTimeoutMs: 200,
    ...options,
  });
  return { api, provider, local };
}

const execs = (api: FakeSpritesApi) =>
  api.calls.filter((c) => c.op === 'exec').map((c) => (c.args[0] as string[]).join(' '));

describe('Sprite names and egress', () => {
  it('derives the name from the computer id, lower case, without dashes', () => {
    expect(spriteName(spec.computerId)).toBe(NAME);
    expect(spriteName('AAAA-bbbb', 'dev')).toBe('dev-aaaabbbb');
    expect(() => spriteName('---')).toThrow();
  });

  it('refuses a prefix that is not a short lower case label', () => {
    expect(() =>
      createSpritesProvider({ token: 't', api: fakeSpritesApi(), namePrefix: 'Ob' }),
    ).toThrow();
    expect(() =>
      createSpritesProvider({ token: 't', api: fakeSpritesApi(), namePrefix: 'a'.repeat(17) }),
    ).toThrow();
  });

  it('allows the Sprites defaults, the vendors and extra domains', () => {
    const policy = spritesEgressPolicy(['example.com', '*.example.org']);
    expect(policy.rules[0]).toEqual({ include: 'defaults' });
    const allowed = policy.rules.slice(1).map((r) => r.domain);
    for (const host of ['*.anthropic.com', 'claude.ai', 'chatgpt.com', '*.openai.com', '*.x.ai']) {
      expect(allowed).toContain(host);
    }
    // What provision.sh downloads, since it runs behind the policy.
    for (const host of ['nodejs.org', 'archive.ubuntu.com', 'cdn.playwright.dev']) {
      expect(allowed).toContain(host);
    }
    expect(allowed).toContain('example.com');
    expect(allowed).toContain('*.example.org');
    expect(policy.rules.slice(1).every((r) => r.action === 'allow')).toBe(true);
    expect(() => spritesEgressPolicy(['http://bad'])).toThrow(/egress domain/);
    expect(isEgressDomain('*')).toBe(true);
    expect(isEgressDomain('10.0.0.1')).toBe(true);
    expect(isEgressDomain('a..b')).toBe(false);
  });
});

describe('the sprites provider', () => {
  it('creates the Sprite, applies the egress policy and provisions it', async () => {
    const { api, provider } = setup();
    const ref = await provider.create(spec);
    expect(ref).toEqual({
      provider: 'sprites',
      containerId: NAME,
      agentUrl: `https://${NAME}-abc123.sprites.app`,
      agentToken: 'secret-agent-token',
      volumeName: null,
    });
    const sprite = api.sprites.get(NAME)!;
    expect(sprite.urlAuth).toBe('public');
    expect(sprite.policy).toEqual(spritesEgressPolicy());
    // Policy before provisioning: the script already runs behind it.
    const ops = api.calls.map((c) => c.op);
    expect(ops.indexOf('setNetworkPolicy')).toBeLessThan(ops.indexOf('writeFile'));
    expect(api.provisions).toEqual([
      {
        name: NAME,
        token: 'secret-agent-token',
        env: { OPENBOTS_AGENT_PORT: '8080', OPENBOTS_PROVISION_VERSION: '7', TZ: 'Europe/London' },
      },
    ]);
    // The token is never in the exec's query (argv or env), only on stdin.
    const run = api.calls.find(
      (c) => c.op === 'exec' && JSON.stringify(c.args[0]).includes('read -r'),
    )!;
    expect(JSON.stringify(run.args[0])).not.toContain('secret-agent-token');
    expect(JSON.stringify((run.args[1] as { env: unknown }).env)).not.toContain(
      'secret-agent-token',
    );
    expect(run.args[0]).toEqual([
      'bash',
      '-c',
      expect.stringContaining('exec bash "$0" "$1"'),
      `${PROVISION_STAGING_DIR}/provision.sh`,
      `${PROVISION_STAGING_DIR}/agent-bundle.tgz`,
    ]);
    // The staging directory goes once the script succeeded.
    expect(execs(api).at(-1)).toContain(`rm -rf ${PROVISION_STAGING_DIR}`);
    expect([...sprite.files.keys()]).toEqual([PROVISION_VERSION_FILE]);
  });

  it('uploads a bundle larger than one write in parts and joins them', async () => {
    const big = new Uint8Array(SPRITES_MAX_WRITE_BYTES + 5).fill(7);
    const { api, provider, local } = setup();
    local.set('/prov/agent-bundle.tgz', big);
    let seen: number | undefined;
    api.provisionScript = (sprite, run) => {
      seen = sprite.files.get(run.bundle)?.byteLength;
      sprite.files.set(PROVISION_VERSION_FILE, new TextEncoder().encode('7'));
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await provider.create(spec);
    expect(seen).toBe(big.byteLength);
    const writes = api.calls.filter((c) => c.op === 'writeFile').map((c) => c.args[0]);
    expect(writes).toEqual([
      `${PROVISION_STAGING_DIR}/provision.sh`,
      `${PROVISION_STAGING_DIR}/agent-bundle.tgz.part0000`,
      `${PROVISION_STAGING_DIR}/agent-bundle.tgz.part0001`,
    ]);
  });

  it('reports a failed provisioning with the script output', async () => {
    const { api, provider } = setup();
    api.provisionScript = () => ({ exitCode: 3, stdout: 'step 1 ok', stderr: 'apt failed' });
    await expect(provider.create(spec)).rejects.toThrow(
      /Provisioning the Sprite failed \(exit 3\): step 1 ok\napt failed/,
    );
  });

  it('refuses a provisioning that did not record the version', async () => {
    const { api, provider } = setup();
    api.provisionScript = () => ({ exitCode: 0, stdout: 'done', stderr: '' });
    await expect(provider.create(spec)).rejects.toThrow(/recorded version none, not 7/);
  });

  it('reuses a Sprite left from an earlier row and provisions it again with the new token', async () => {
    const { api, provider } = setup({ urlAuth: 'sprite' });
    await api.create(NAME, { urlAuth: 'public' });
    api.sprites.get(NAME)!.files.set('/home/bot/notes.md', new Uint8Array([1]));
    api.calls.length = 0;
    await provider.create({ ...spec, agentToken: 'new-token' });
    expect(api.calls.some((c) => c.op === 'create')).toBe(false);
    expect(api.sprites.get(NAME)!.urlAuth).toBe('sprite');
    expect(api.provisions.at(-1)!.token).toBe('new-token');
    expect(api.sprites.get(NAME)!.files.has('/home/bot/notes.md')).toBe(true);
  });

  it('makes a bare Sprite without provisioning configured', async () => {
    const { api, provider } = setup({ provision: undefined });
    await provider.create(spec);
    expect(api.provisions).toEqual([]);
  });

  describe('start', () => {
    it('waits for the agent through the Sprite URL, without provisioning when current', async () => {
      agent = await startFakeAgent({ token: spec.agentToken });
      const { api, provider } = setup();
      api.urlFor = () => agent!.url;
      const ref = await provider.create(spec);
      api.sprites.get(NAME)!.status = 'cold';
      await provider.start(ref);
      expect(api.provisions).toHaveLength(1);
      expect(agent.calls.some((c) => c.path === '/healthz')).toBe(true);
    });

    it('provisions again when the installed version is another', async () => {
      agent = await startFakeAgent({ token: spec.agentToken });
      const { api, provider } = setup();
      api.urlFor = () => agent!.url;
      const ref = await provider.create(spec);
      api.sprites.get(NAME)!.files.set(PROVISION_VERSION_FILE, new TextEncoder().encode('6\n'));
      await provider.start(ref);
      expect(api.provisions).toHaveLength(2);
      expect(api.provisions[1]!.token).toBe(spec.agentToken);
    });

    it('fails when the agent never answers', async () => {
      agent = await startFakeAgent({ token: spec.agentToken });
      agent.healthy = false;
      const { api, provider } = setup({ readyTimeoutMs: 50 });
      api.urlFor = () => agent!.url;
      const ref = await provider.create(spec);
      await expect(provider.start(ref)).rejects.toThrow(/did not answer within 50ms/);
    });
  });

  describe('status', () => {
    it('reads a paused Sprite as running and a deleted one as missing', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      for (const status of ['running', 'warm', 'cold']) {
        api.sprites.get(NAME)!.status = status;
        expect(await provider.status(ref)).toBe('running');
      }
      api.sprites.delete(NAME);
      expect(await provider.status(ref)).toBe('missing');
    });

    it('reads a row from another provider as missing, so it is made again here', async () => {
      const { api, provider } = setup();
      const docker: ComputerRef = {
        provider: 'docker',
        containerId: 'abc',
        agentUrl: 'http://openbots-computer-x:7070',
        agentToken: 't',
        volumeName: 'v',
      };
      expect(await provider.status(docker)).toBe('missing');
      expect(api.calls).toEqual([]);
    });
  });

  describe('holds', () => {
    it('holds with the Tasks API, at most an hour, and releases', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      await provider.hold!(ref, 'run-1', 7200);
      expect([...api.sprites.get(NAME)!.tasks]).toEqual([['openbots-run-1', 3600]]);
      await provider.release!(ref, 'run-1');
      expect(api.sprites.get(NAME)!.tasks.size).toBe(0);
      // Gone already: fine.
      await provider.release!(ref, 'run-1');
      await expect(provider.hold!(ref, '../x', 60)).rejects.toThrow(/Not a hold name/);
    });

    it('stop releases our holds and leaves the Sprite and other tasks alone', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      await provider.hold!(ref, 'a', 60);
      await provider.hold!(ref, 'b', 60);
      api.sprites.get(NAME)!.tasks.set('someone-else', 60);
      await provider.stop(ref);
      expect([...api.sprites.get(NAME)!.tasks.keys()]).toEqual(['someone-else']);
      expect(api.sprites.has(NAME)).toBe(true);
    });

    it('stop does not wake a paused Sprite: it cannot be holding', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      api.sprites.get(NAME)!.status = 'warm';
      api.calls.length = 0;
      await provider.stop(ref);
      expect(api.calls.map((c) => c.op)).toEqual(['get']);
    });
  });

  describe('destroy', () => {
    it('deletes the Sprite for a reset that takes the sign-ins too', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      await provider.destroy(ref, { computerId: spec.computerId, home: true, state: true });
      expect(api.sprites.has(NAME)).toBe(false);
    });

    it('clears only the home for a reset that keeps the sign-ins', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      const files = api.sprites.get(NAME)!.files;
      files.set('/home/bot/notes.md', new Uint8Array([1]));
      files.set('/var/lib/openbots/cookies.db', new Uint8Array([2]));
      await provider.destroy(ref, { computerId: spec.computerId, home: true });
      expect(api.sprites.has(NAME)).toBe(true);
      expect(files.has('/home/bot/notes.md')).toBe(false);
      expect(files.has('/var/lib/openbots/cookies.db')).toBe(true);
      // The agent's service stops and what it started ends before the wipe.
      const wipe = execs(api).at(-1)!;
      expect(wipe).toContain('sprite-env services stop openbots-agent');
      expect(wipe).toContain('pkill -KILL -u bot');
      expect(wipe.indexOf('pkill')).toBeLessThan(
        wipe.indexOf('find /home/bot -mindepth 1 -delete'),
      );
    });

    it('keeps the Sprite and its home without a reset (K7)', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      await provider.destroy(ref);
      expect(api.sprites.has(NAME)).toBe(true);
    });

    it('waits for a deletion that finishes late, and gives up after the timeout', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      const remove = api.delete.bind(api);
      api.delete = async () => {};
      await expect(
        provider.destroy(ref, { computerId: spec.computerId, home: true, state: true }),
      ).rejects.toThrow(/was not deleted in time/);
      api.delete = async (name) => {
        setTimeout(() => void remove(name), 30);
      };
      await provider.destroy(ref, { computerId: spec.computerId, home: true, state: true });
      expect(api.sprites.has(NAME)).toBe(false);
    });
  });

  it('checkpoints, lists and restores the whole disk', async () => {
    const { api, provider } = setup();
    const ref = await provider.create(spec);
    const files = () => api.sprites.get(NAME)!.files;
    files().set('/home/bot/a', new Uint8Array([1]));
    const id = await provider.checkpoint!(ref, 'before upgrade');
    files().delete('/home/bot/a');
    expect(await provider.listCheckpoints!(ref)).toEqual([
      { id, createdAt: expect.any(String), comment: 'before upgrade' },
    ]);
    await provider.restore!(ref, id);
    expect(files().has('/home/bot/a')).toBe(true);
  });

  it('replaces the egress policy', async () => {
    const { api, provider } = setup();
    const ref = await provider.create(spec);
    await provider.applyEgressPolicy!(ref, { rules: [{ domain: '*', action: 'allow' }] });
    expect(api.sprites.get(NAME)!.policy).toEqual({ rules: [{ domain: '*', action: 'allow' }] });
  });

  describe('the agent client', () => {
    it('sends only our token on a public URL', async () => {
      const { provider } = setup();
      const ref = await provider.create(spec);
      expect(provider.agent(ref).socket('/pty').headers).toEqual({
        authorization: 'Bearer secret-agent-token',
      });
    });

    it('on a private URL, sends the org token for the proxy and ours in its own header', async () => {
      agent = await startFakeAgent({ token: spec.agentToken });
      const { api, provider } = setup({ urlAuth: 'sprite' });
      api.urlFor = () => agent!.url;
      const ref = await provider.create(spec);
      expect(api.sprites.get(NAME)!.urlAuth).toBe('sprite');
      expect(provider.agent(ref).socket('/pty').headers).toEqual({
        authorization: 'Bearer org-token',
        'x-openbots-agent-token': 'secret-agent-token',
      });
      expect((await provider.agent(ref).health()).ok).toBe(true);
    });
  });
});

describe('the Sprites REST client', () => {
  const frames = (...chunks: number[][]) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
          controller.close();
        },
      }),
    );
  const bytes = (text: string) => [...new TextEncoder().encode(text)];

  it('decodes stdout, stderr and the exit code of an HTTP exec', async () => {
    expect(
      await decodeExec(
        frames([1, ...bytes('hello ')], [2, ...bytes('oops')], [1, ...bytes('world')], [3, 2]),
      ),
    ).toEqual({ exitCode: 2, stdout: 'hello world', stderr: 'oops' });
  });

  it('finds the exit frame merged onto the last read', async () => {
    expect(await decodeExec(frames([1, ...bytes('ok'), 3, 0]))).toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    await expect(decodeExec(frames([1, ...bytes('cut')]))).rejects.toThrow(/without an exit code/);
  });

  it('sends the org token, the argv as cmd and the stdin flag', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const api = createSpritesApi({
      token: 'org-token',
      fetch: (async (url: URL, init: RequestInit) => {
        seen.push({ url: String(url), init });
        if (String(url).includes('/exec')) return frames([1, ...bytes('hi')], [3, 0]);
        if (String(url).endsWith('/v1/sprites/gone')) return new Response('', { status: 404 });
        return new Response('{}', { status: 500 });
      }) as typeof fetch,
    });
    expect(await api.exec('s1', ['echo', 'a b'], { stdin: 'x', env: { A: '1' } })).toEqual({
      exitCode: 0,
      stdout: 'hi',
      stderr: '',
    });
    const exec = new URL(seen[0]!.url);
    expect(exec.pathname).toBe('/v1/sprites/s1/exec');
    expect(exec.searchParams.getAll('cmd')).toEqual(['echo', 'a b']);
    expect(exec.searchParams.get('stdin')).toBe('true');
    expect(exec.searchParams.getAll('env')).toEqual(['A=1']);
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer org-token',
    );
    expect(await api.get('gone')).toBeNull();
    await expect(api.setUrlAuth('s1', 'public')).rejects.toThrow(/500/);
  });
});
