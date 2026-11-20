import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SPRITES_MAX_WRITE_BYTES } from './sprites-api.js';
import {
  createSpritesProvider,
  isEgressDomain,
  PROVISION_LOCKED_EXIT,
  PROVISION_STAGING_DIR,
  PROVISION_VERSION_FILE,
  prepareStaging,
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

/** The staging directories the uploads went to, in order. */
const stagings = (api: FakeSpritesApi) => [
  ...new Set(
    api.calls
      .filter((c) => c.op === 'writeFile')
      .map((c) => (c.args[0] as string).replace(/\/[^/]+$/, '')),
  ),
];
const STAGING = new RegExp(`^${PROVISION_STAGING_DIR}-[0-9a-f]{16}$`);

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
    const [staging] = stagings(api);
    expect(staging).toMatch(STAGING);
    expect(run.args[0]).toEqual([
      'bash',
      '-c',
      expect.stringContaining('exec bash "$0" "$1"'),
      `${staging}/provision.sh`,
      `${staging}/agent-bundle.tgz`,
    ]);
    // It may not run on unobserved once our connection to it is gone.
    expect(run.args[1]).toMatchObject({ maxRunAfterDisconnect: '1s' });
    // The staging directory goes once the script succeeded.
    expect(execs(api).at(-1)).toContain(`rm -rf ${staging}`);
    expect([...sprite.files.keys()]).toEqual([PROVISION_VERSION_FILE]);
  });

  it('makes the staging directory afresh as root, whatever a Bot left at its path', async () => {
    const { api, provider } = setup();
    await provider.create(spec);
    const first = api.calls.find((c) => c.op === 'exec')!.args[0] as string[];
    expect(first).toEqual([
      'bash',
      '-c',
      expect.any(String),
      'as-root',
      prepareStaging(stagings(api)[0]!),
    ]);

    // Run for real on a stand-in path: a directory the Bot made (with its own
    // script in it) and a link it planted both give way to a new directory.
    const root = mkdtempSync(join(tmpdir(), 'staging-'));
    // On a Sprite the command runs under sudo, which names its caller. Here that
    // is whoever runs the tests, so the chown also works without root.
    const asSudo = { ...process.env, SUDO_USER: userInfo().username };
    try {
      const dir = join(root, 'openbots-provision');
      mkdirSync(dir, { mode: 0o777 });
      writeFileSync(join(dir, 'provision.sh'), 'echo planted');
      execFileSync('bash', ['-c', prepareStaging(dir)], { env: asSudo });
      expect(readdirSync(dir)).toEqual([]);
      expect(statSync(dir).mode & 0o777).toBe(0o755);

      const elsewhere = join(root, 'bot-owned');
      mkdirSync(elsewhere);
      rmSync(dir, { recursive: true });
      symlinkSync(elsewhere, dir);
      execFileSync('bash', ['-c', prepareStaging(dir)], { env: asSudo });
      expect(lstatSync(dir).isSymbolicLink()).toBe(false);
      expect(lstatSync(dir).isDirectory()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    const [staging] = stagings(api);
    expect(writes).toEqual([
      `${staging}/provision.sh`,
      `${staging}/agent-bundle.tgz.part0000`,
      `${staging}/agent-bundle.tgz.part0001`,
    ]);
  });

  it('stages each attempt apart, so a late upload from an earlier one cannot replace its files', async () => {
    const { api, provider } = setup();
    let attempt = 0;
    const ran: string[] = [];
    api.provisionScript = (sprite, run) => {
      attempt += 1;
      ran.push(new TextDecoder().decode(sprite.files.get(run.script)));
      if (attempt === 1) {
        // The first attempt times out; its upload of an older script lands
        // only now, after the second attempt staged its own.
        return { exitCode: 1, stdout: '', stderr: 'timed out' };
      }
      sprite.files.set(PROVISION_VERSION_FILE, new TextEncoder().encode('7'));
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    api.execHook = (sprite, argv) => {
      // Before the second attempt's script runs, a straggler from the first.
      if (attempt === 1 && argv.join(' ').includes('read -r')) {
        const [first] = stagings(api);
        sprite.files.set(`${first}/provision.sh`, new TextEncoder().encode('echo stale'));
      }
      return undefined;
    };
    await expect(provider.create(spec)).rejects.toThrow(/exit 1/);
    await provider.create(spec);
    const [first, second] = stagings(api);
    expect(first).toMatch(STAGING);
    expect(second).toMatch(STAGING);
    expect(second).not.toBe(first);
    expect(ran).toEqual([new TextDecoder().decode(SCRIPT), new TextDecoder().decode(SCRIPT)]);
    // Each attempt removes its own directory, the failed one too.
    expect(execs(api).filter((e) => e.includes(`rm -rf ${first}`))).toHaveLength(1);
    expect(execs(api).filter((e) => e.includes(`rm -rf ${second}`))).toHaveLength(1);
  });

  it('reports another provisioning that holds the lock as a failure, not as done', async () => {
    const { api, provider } = setup();
    api.provisionScript = (sprite) => {
      // Even with a version on the disk from the run that holds the lock.
      sprite.files.set(PROVISION_VERSION_FILE, new TextEncoder().encode('7'));
      return {
        exitCode: PROVISION_LOCKED_EXIT,
        stdout: '',
        stderr: 'another provisioning is still running',
      };
    };
    await expect(provider.create(spec)).rejects.toThrow(/Another provisioning of the Sprite/);
  });

  it('sweeps staging directories left over an hour ago, and only those', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    const asSudo = { ...process.env, SUDO_USER: userInfo().username };
    try {
      const old = join(root, 'openbots-provision-00000000000000aa');
      const recent = join(root, 'openbots-provision-00000000000000bb');
      const other = join(root, 'something-else');
      for (const dir of [old, recent, other]) mkdirSync(dir);
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      utimesSync(old, twoHoursAgo, twoHoursAgo);
      utimesSync(other, twoHoursAgo, twoHoursAgo);
      const mine = join(root, 'openbots-provision-00000000000000cc');
      execFileSync('bash', ['-c', prepareStaging(mine)], { env: asSudo });
      expect(existsSync(old)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      expect(existsSync(other)).toBe(true);
      expect(existsSync(mine)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    const id = (await provider.checkpoint!(ref, 'before upgrade'))!;
    expect(id).toEqual(expect.any(String));
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
