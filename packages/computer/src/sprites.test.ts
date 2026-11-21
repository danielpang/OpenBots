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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPRITES_MAX_WRITE_BYTES } from './sprites-api.js';
import {
  createSpritesProvider,
  isEgressDomain,
  PROVISION_LOCKED_EXIT,
  PROVISION_STAGING_DIR,
  PROVISION_VERSION_FILE,
  prepareStaging,
  SPRITES_AGENT_SERVICE,
  SPRITES_AGENT_TOKEN_FILES,
  SPRITES_DENY_ALL,
  SPRITES_RETIRED_LABEL,
  SPRITES_RETIRED_MARKER,
  SpriteRetiredError,
  SPRITES_CUT_CALL_MS,
  SPRITES_INSIDE_CALL_MS,
  SPRITES_PROVISION_BUDGET_MS,
  SPRITES_RETIRE_INSIDE_MAX_MS,
  SPRITES_RETIRE_MAX_MS,
  PROVISION_LOCK_FILE,
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

  describe('retire', () => {
    /** A provisioned Sprite in use: a hold, a file in the home and the agent's token. */
    async function retired() {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      await provider.hold!(ref, 'run-1', 600);
      const sprite = api.sprites.get(NAME)!;
      sprite.files.set('/home/bot/notes.md', new Uint8Array([1]));
      // Where provision.sh stores the agent token, and the copy the agent reads.
      for (const file of SPRITES_AGENT_TOKEN_FILES) sprite.files.set(file, new Uint8Array([2]));
      const checkpoint = await provider.checkpoint!(ref, 'OpenBots: before a full reset, 1');
      await provider.retire!(ref);
      await provider.retireInside!(ref);
      return { api, provider, ref, sprite, checkpoint };
    }

    it('takes the Sprite out of service and keeps its disk and checkpoints', async () => {
      const { api, sprite, checkpoint } = await retired();
      expect(api.sprites.has(NAME)).toBe(true);
      expect(sprite.labels).toContain(SPRITES_RETIRED_LABEL);
      // Its holds are gone, so it pauses; its URL is private; it may reach nothing.
      expect([...sprite.tasks.keys()]).toEqual([]);
      expect(sprite.urlAuth).toBe('sprite');
      expect(sprite.policy).toEqual(SPRITES_DENY_ALL);
      expect(sprite.policy).toEqual({ rules: [{ domain: '*', action: 'deny' }] });
      // The member's files stay, and so does the checkpoint taken before.
      expect(sprite.files.has('/home/bot/notes.md')).toBe(true);
      expect(sprite.checkpoints.map((c) => c.id)).toEqual([checkpoint]);
    });

    it('revokes the agent: its service is removed and its token deleted from the disk', async () => {
      const { api, sprite } = await retired();
      expect(sprite.services.has(SPRITES_AGENT_SERVICE)).toBe(false);
      for (const file of SPRITES_AGENT_TOKEN_FILES) expect(sprite.files.has(file)).toBe(false);
      const script = execs(api).find((line) => line.includes('services delete'))!;
      expect(script).toContain(`sprite-env services stop ${SPRITES_AGENT_SERVICE}`);
      expect(script).toContain('pkill -KILL -u bot');
      // The token itself never travels in a command line.
      expect(execs(api).join('\n')).not.toContain(spec.agentToken);
    });

    it('refuses everything on a retired Sprite without waking it', async () => {
      const { api, provider, ref, sprite } = await retired();
      sprite.status = 'cold';
      api.calls.length = 0;
      await expect(provider.start(ref)).rejects.toBeInstanceOf(SpriteRetiredError);
      await expect(provider.hold!(ref, 'run-2', 60)).rejects.toThrow(/is retired/);
      await expect(provider.checkpoint!(ref, 'x')).rejects.toThrow(/is retired/);
      await expect(provider.applyEgressPolicy!(ref, spritesEgressPolicy())).rejects.toThrow(
        /is retired/,
      );
      await expect(
        provider.destroy(ref, { computerId: spec.computerId, home: true }),
      ).rejects.toThrow(/is retired/);
      await expect(provider.create(spec)).rejects.toThrow(/is retired/);
      await provider.stop(ref);
      await provider.release!(ref, 'run-1');
      await provider.destroy(ref);
      // It serves nothing, so it reads as missing.
      expect(await provider.status(ref)).toBe('missing');
      // Only metadata was read: no command ran, nothing was written, it is still paused.
      expect(new Set(api.calls.map((c) => c.op))).toEqual(new Set(['get']));
      expect(sprite.status).toBe('cold');
      expect(sprite.policy).toEqual(SPRITES_DENY_ALL);
    });

    it('cuts off reach first, with metadata calls that need no command and do not wake it', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      const sprite = api.sprites.get(NAME)!;
      sprite.status = 'cold';
      // Commands fail: a Sprite that will not wake, or an exec API that is down.
      api.execHook = () => {
        throw new Error('exec is down');
      };
      api.calls.length = 0;
      await provider.retire!(ref);
      expect(api.calls.map((c) => c.op)).toEqual([
        'get',
        'setLabels',
        'setUrlAuth',
        'setNetworkPolicy',
      ]);
      expect(sprite.labels).toContain(SPRITES_RETIRED_LABEL);
      expect(sprite.urlAuth).toBe('sprite');
      expect(sprite.policy).toEqual(SPRITES_DENY_ALL);
      expect(sprite.status).toBe('cold');
      // What needs a command inside it is a step of its own, which a retry finishes.
      await expect(provider.retireInside!(ref)).rejects.toThrow(/exec is down/);
      api.execHook = undefined;
      await provider.retireInside!(ref);
      expect(sprite.services.has(SPRITES_AGENT_SERVICE)).toBe(false);
    });

    it('bounds every call inside, and the whole, within its limit', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      await provider.hold!(ref, 'run-1', 600);
      await provider.retire!(ref);
      const from = api.calls.length;
      await provider.retireInside!(ref);
      const calls = api.calls.slice(from);
      const inside = calls.filter((c) => c.op === 'exec');
      expect(inside.length).toBeGreaterThanOrEqual(4);
      for (const call of inside) {
        const { timeoutMs } = call.args[1] as { timeoutMs?: number };
        expect(timeoutMs).toBeDefined();
        expect(timeoutMs!).toBeLessThanOrEqual(SPRITES_INSIDE_CALL_MS);
      }
      // The label read again before every step that changes it.
      expect(calls.filter((c) => c.op === 'get').length).toBeGreaterThanOrEqual(inside.length);
      expect(SPRITES_RETIRE_INSIDE_MAX_MS).toBeLessThan(5 * 60_000);
    });

    it('stops at the step where it finds the Sprite put back in service', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      const sprite = api.sprites.get(NAME)!;
      await provider.retire!(ref);
      // An operator's restore lands after the mark: the agent must not be removed.
      const exec = api.exec.bind(api);
      let restored = false;
      api.exec = async (name, argv, options) => {
        const out = await exec(name, argv, options);
        if (!restored && argv.join(' ').includes(`touch -- ${SPRITES_RETIRED_MARKER}`)) {
          restored = true;
          await provider.unretire!(ref);
        }
        return out;
      };
      await expect(provider.retireInside!(ref)).rejects.toThrow(/not retired/);
      expect(sprite.services.has(SPRITES_AGENT_SERVICE)).toBe(true);
    });

    it("stops before a step once its caller's check says it no longer holds the machine", async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      const sprite = api.sprites.get(NAME)!;
      await provider.retire!(ref);
      let checks = 0;
      const lost = new Error('the claim was taken');
      await expect(
        provider.retireInside!(ref, {
          check: async () => {
            if (++checks > 1) throw lost;
          },
        }),
      ).rejects.toBe(lost);
      expect(sprite.files.has(SPRITES_RETIRED_MARKER)).toBe(true);
      expect(sprite.services.has(SPRITES_AGENT_SERVICE)).toBe(true);
    });

    it('removes the agent under the provisioning lock', async () => {
      const { api } = await retired();
      const script = execs(api).find((line) => line.includes('services delete'))!;
      expect(script).toContain(`exec 9>>${PROVISION_LOCK_FILE}`);
      expect(script.indexOf('flock')).toBeLessThan(script.indexOf('services stop'));
    });

    it('reads every part of the cut back: a policy that lets anything out is not retired', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      await provider.retire!(ref);
      expect(await provider.retiredState!(ref)).toBe('retired');
      api.sprites.get(NAME)!.policy = { rules: [{ domain: '*', action: 'allow' }] };
      expect(await provider.retiredState!(ref)).toBe('in_service');
      api.sprites.get(NAME)!.policy = null;
      expect(await provider.retiredState!(ref)).toBe('in_service');
    });

    it('a provisioning on a Sprite marked retired registers no agent', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      const sprite = api.sprites.get(NAME)!;
      sprite.services.clear();
      sprite.files.delete(PROVISION_VERSION_FILE);
      sprite.files.set(SPRITES_RETIRED_MARKER, new Uint8Array());
      await expect(provider.start(ref)).rejects.toBeInstanceOf(SpriteRetiredError);
      expect(sprite.services.has(SPRITES_AGENT_SERVICE)).toBe(false);
    });

    it('a make whose caller gave it up ends at its next call, and ends the provisioning command', async () => {
      const { api, provider } = setup();
      const stop = new AbortController();
      const exec = api.exec.bind(api);
      let provisioning: AbortSignal | undefined;
      api.exec = async (name, argv, options) => {
        if (argv[2]?.includes('read -r OPENBOTS_AGENT_TOKEN')) {
          provisioning = options?.signal;
          stop.abort(new Error('the computer moved on'));
          if (options?.signal?.aborted) throw new Error('exec was ended by its caller');
        }
        return exec(name, argv, options);
      };
      await expect(provider.create({ ...spec, signal: stop.signal })).rejects.toThrow(
        /ended by its caller/,
      );
      expect(provisioning).toBe(stop.signal);
      expect(api.sprites.get(NAME)!.services.has(SPRITES_AGENT_SERVICE)).toBe(false);
      // Already given up: not a single call.
      const calls = api.calls.length;
      await expect(provider.create({ ...spec, signal: stop.signal })).rejects.toThrow();
      expect(api.calls.length).toBe(calls);
    });

    it('never runs the inside steps on a Sprite that was not retired first', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      await expect(provider.retireInside!(ref)).rejects.toThrow(/not retired/);
      expect(api.sprites.get(NAME)!.services.has(SPRITES_AGENT_SERVICE)).toBe(true);
    });

    it('a hold placed while the Sprite is being retired does not outlive the retire', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      const sprite = api.sprites.get(NAME)!;
      // The hold read the metadata before the label; its command lands after the retire.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const exec = api.exec.bind(api);
      let held = false;
      api.exec = async (name, argv, options) => {
        if (!held && argv.some((arg) => arg.includes('"expire"'))) {
          held = true;
          await gate;
        }
        return exec(name, argv, options);
      };
      const hold = provider.hold!(ref, 'run-9', 900).then(
        () => 'held',
        (error: Error) => error.name,
      );
      await vi.waitFor(() => expect(held).toBe(true));
      await provider.retire!(ref);
      await provider.retireInside?.(ref);
      release();
      expect(await hold).toBe('SpriteRetiredError');
      expect([...sprite.tasks.keys()].filter((t) => t.startsWith('openbots-'))).toEqual([]);
    });

    it('is safe to repeat, and does nothing for a Sprite already gone', async () => {
      const { api, provider, ref, sprite } = await retired();
      await provider.retire!(ref);
      await provider.retireInside!(ref);
      expect(sprite.labels.filter((l) => l === SPRITES_RETIRED_LABEL)).toHaveLength(1);
      api.sprites.delete(NAME);
      await provider.retire!(ref);
      await provider.retireInside!(ref);
      expect(api.sprites.has(NAME)).toBe(false);
    });

    it("counts a Sprite as gone only on the API's own 404, never on a read that found nothing", async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      const sprite = api.sprites.get(NAME)!;
      // A read that answers nothing for a Sprite that is there (a stale cache, a proxy).
      const get = api.get.bind(api);
      let blind = 1;
      api.get = async (name, options) => (blind-- > 0 ? null : get(name, options));
      await provider.retire!(ref);
      expect(sprite.labels).toContain(SPRITES_RETIRED_LABEL);
      expect(sprite.urlAuth).toBe('sprite');
      expect(sprite.policy).toEqual(SPRITES_DENY_ALL);
      // A read that keeps answering nothing while the Sprite is there fails the retire.
      api.get = async () => null;
      await expect(provider.retire!(ref)).rejects.toThrow(/could not be read/);
      // Any other failure is a failure.
      api.get = get;
      const setUrlAuth = api.setUrlAuth.bind(api);
      api.get = async () => null;
      api.setUrlAuth = async () => {
        throw Object.assign(new Error('Sprites API: URL settings failed (503)'), { status: 503 });
      };
      await expect(provider.retire!(ref)).rejects.toThrow(/503/);
      api.get = get;
      api.setUrlAuth = setUrlAuth;
    });

    it('limits each call that cuts or restores reach, so the longest each takes is known', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      api.calls.length = 0;
      const seen: unknown[] = [];
      for (const op of ['get', 'setLabels', 'setUrlAuth', 'setNetworkPolicy'] as const) {
        const inner = api[op].bind(api) as (...args: unknown[]) => Promise<unknown>;
        (api as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => {
          seen.push([op, args.at(-1)]);
          return inner(...args);
        };
      }
      await provider.retire!(ref);
      await provider.unretire!(ref);
      expect(seen.length).toBeGreaterThanOrEqual(7);
      for (const [, options] of seen as [string, unknown][]) {
        expect(options).toEqual({ timeoutMs: SPRITES_CUT_CALL_MS });
      }
      const exec = api.calls.find((c) => c.op === 'exec')!;
      expect((exec.args[1] as { timeoutMs?: number }).timeoutMs).toBe(SPRITES_CUT_CALL_MS);
      expect(SPRITES_RETIRE_MAX_MS).toBe(5 * SPRITES_CUT_CALL_MS);
    });

    it('makes at most five calls, a first read that finds nothing included', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      // The first read finds nothing; the next still shows the URL public (a stale read).
      const get = api.get.bind(api);
      let reads = 0;
      api.get = async (name, options) => {
        reads++;
        if (reads === 1) return null;
        const info = await get(name, options);
        return info && { ...info, urlAuth: 'public' };
      };
      api.calls.length = 0;
      let calls = 0;
      for (const op of ['setLabels', 'setUrlAuth', 'setNetworkPolicy'] as const) {
        const inner = api[op].bind(api) as (...args: unknown[]) => Promise<unknown>;
        (api as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => {
          calls++;
          return inner(...args);
        };
      }
      await provider.retire!(ref);
      api.get = get;
      expect(reads + calls).toBeLessThanOrEqual(SPRITES_RETIRE_MAX_MS / SPRITES_CUT_CALL_MS);
      const sprite = api.sprites.get(NAME)!;
      expect(sprite.labels).toContain(SPRITES_RETIRED_LABEL);
      expect(sprite.urlAuth).toBe('sprite');
      expect(sprite.policy).toEqual(SPRITES_DENY_ALL);
    });

    it('a provisioning that a retire overtakes puts the cut back and is refused', async () => {
      const { api, provider } = setup();
      const ref = await provider.create(spec);
      const sprite = api.sprites.get(NAME)!;
      // The provisioning read the Sprite before the retire; its own calls land after the cut.
      const setNetworkPolicy = api.setNetworkPolicy.bind(api);
      let raced = false;
      api.setNetworkPolicy = async (name, policy, options) => {
        if (!raced && policy !== SPRITES_DENY_ALL) {
          raced = true;
          await provider.retire!(ref);
        }
        return setNetworkPolicy(name, policy, options);
      };
      await expect(provider.create({ ...spec, agentToken: 'late' })).rejects.toBeInstanceOf(
        SpriteRetiredError,
      );
      expect(raced).toBe(true);
      expect(sprite.labels).toContain(SPRITES_RETIRED_LABEL);
      expect(sprite.urlAuth).toBe('sprite');
      expect(sprite.policy).toEqual(SPRITES_DENY_ALL);
      expect(api.provisions.map((p) => p.token)).not.toContain('late');
    });

    it('is deleted for good with destroy, home and state', async () => {
      const { api, provider, ref } = await retired();
      await provider.destroy(ref, { computerId: spec.computerId, home: true, state: true });
      expect(api.sprites.has(NAME)).toBe(false);
    });

    it('lets an operator restore its checkpoint and put it back, with a new token', async () => {
      const { api, provider, ref, sprite, checkpoint } = await retired();
      sprite.files.delete('/home/bot/notes.md');
      await provider.restore!(ref, checkpoint!);
      expect(sprite.files.has('/home/bot/notes.md')).toBe(true);
      await provider.unretire!(ref);
      expect(sprite.labels).not.toContain(SPRITES_RETIRED_LABEL);
      expect(sprite.files.has(SPRITES_RETIRED_MARKER)).toBe(false);
      expect(sprite.urlAuth).toBe('public');
      expect(sprite.policy).toEqual(spritesEgressPolicy());
      // The next create provisions the same Sprite again, with the new token.
      const back = await provider.create({ ...spec, agentToken: 'a-new-agent-token' });
      expect(back.containerId).toBe(NAME);
      expect(api.provisions.at(-1)!.token).toBe('a-new-agent-token');
      expect(sprite.services.has(SPRITES_AGENT_SERVICE)).toBe(true);
    });

    it('a Sprite another process put back is usable here: no process remembers it retired', async () => {
      // The API process ran the reset; the operator's CLI, another process,
      // restores the same Sprite. Two providers over one API, as two processes.
      const { api, provider, ref } = await retired();
      const cli = createSpritesProvider({
        token: 'org-token',
        api,
        readyTimeoutMs: 2000,
        pollMs: 10,
      });
      await cli.unretire!(ref);
      expect(await provider.status(ref)).toBe('running');
      expect(() => provider.agent(ref)).not.toThrow();
      expect(await provider.retiredState!(ref)).toBe('in_service');
      await provider.retire!(ref);
      // Retired again by the other: it says so from the Sprite's own metadata.
      expect(await cli.retiredState!(ref)).toBe('retired');
      expect(await cli.status(ref)).toBe('missing');
      await cli.unretire!(ref);
      // A restored Sprite is made ready again by its name, recorded as the key.
      const other = { ...spec, computerId: '44444444-4444-4444-8444-444444444444' };
      const back = await provider.create({ ...other, machineKey: NAME });
      expect(back.containerId).toBe(NAME);
      expect(api.sprites.size).toBe(1);
      // A key that only looks like a name elsewhere is a key, named as usual.
      const key = '55555555-5555-4555-8555-555555555555';
      expect((await provider.create({ ...other, machineKey: key })).containerId).toBe(
        spriteName(key),
      );
    });

    it('names the next machine from its key, leaving the retired one alone', async () => {
      const { api, provider } = await retired();
      const key = '33333333-3333-4333-8333-333333333333';
      const fresh = await provider.create({ ...spec, machineKey: key });
      expect(fresh.containerId).toBe(spriteName(key));
      expect(fresh.containerId).not.toBe(NAME);
      expect(api.sprites.get(NAME)!.labels).toContain(SPRITES_RETIRED_LABEL);
      expect(api.sprites.size).toBe(2);
      // A create retried after a crash finds the same new Sprite, not a third.
      await provider.create({ ...spec, machineKey: key });
      expect(api.sprites.size).toBe(2);
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

describe('the provisioning time bound', () => {
  /** Records the limit each call is given: the options it was passed, last. */
  function limits(api: FakeSpritesApi) {
    const seen: [string, number | undefined][] = [];
    const ops = ['get', 'setUrlAuth', 'setNetworkPolicy', 'exec', 'writeFile', 'readFile'] as const;
    for (const op of ops) {
      const inner = api[op].bind(api) as (...args: unknown[]) => Promise<unknown>;
      (api as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => {
        const last = args.at(-1) as { timeoutMs?: number } | undefined;
        seen.push([op, typeof last === 'object' && last ? last.timeoutMs : undefined]);
        return inner(...args);
      };
    }
    return seen;
  }

  it('gives every call of a make and a start a limit within the budget', async () => {
    const { api, provider } = setup();
    agent = await startFakeAgent({ token: spec.agentToken });
    api.urlFor = () => agent!.url;
    const seen = limits(api);
    const ref = await provider.create(spec);
    // A new version makes the start provision again.
    api.sprites.get(NAME)!.files.delete(PROVISION_VERSION_FILE);
    await provider.start(ref);
    expect(seen.length).toBeGreaterThan(8);
    for (const [op, ms] of seen) {
      expect(ms, op).toBeDefined();
      expect(ms!, op).toBeLessThanOrEqual(SPRITES_PROVISION_BUDGET_MS);
    }
  });

  it('starts no call past the budget but the removal of its staging directory', async () => {
    const { api, provider } = setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const writeFile = api.writeFile.bind(api);
      api.writeFile = async (...args) => {
        // The first upload takes the whole budget.
        vi.setSystemTime(Date.now() + SPRITES_PROVISION_BUDGET_MS + 1);
        return writeFile(...args);
      };
      await expect(provider.create(spec)).rejects.toThrow(/ran out of time/);
    } finally {
      vi.useRealTimers();
    }
    const after = api.calls.slice(api.calls.findIndex((c) => c.op === 'writeFile') + 1);
    expect(after.map((c) => c.op)).toEqual(['exec']);
    expect(execs(api).at(-1)).toMatch(/rm -rf/);
    expect(api.provisions).toHaveLength(0);
  });
});
