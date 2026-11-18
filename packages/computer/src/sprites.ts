import { readFile } from 'node:fs/promises';
import { createAgentClient } from './agent-client.js';
import { waitForAgent } from './docker.js';
import {
  createSpritesApi,
  SPRITES_MAX_WRITE_BYTES,
  type SpriteEgressPolicy,
  type SpritesApi,
  type SpriteUrlAuth,
} from './sprites-api.js';
import {
  COMPUTER_HOME,
  type ComputerProvider,
  type ComputerRef,
  type MachineStatus,
} from './types.js';

// The sprites provider (plan 9.2): one Fly Sprite per computer, for the
// hosted service. A Sprite is a persistent VM with its own disk; it pauses
// itself about 30 seconds after the last activity and wakes on the next
// request to its URL or the API, so OpenBots never stops or starts it.
//
// Made: the Sprite is created (named from the computer id), its DNS egress
// policy applied, then provisioned: the provision script and the agent
// bundle (docker/sprites/) are uploaded and the script run with the agent
// token, which installs the control agent as a Sprite service on port 8080,
// the port the Sprite's URL routes to. The service comes back on every wake.
// The script records its version in PROVISION_VERSION_FILE; a start whose
// installed version differs from the configured one provisions again.
//
// Reached: the server talks to the agent through the Sprite's URL. By
// default the URL is public and only our per-computer bearer token guards the
// agent (as with the remote provider): a private URL wants the org token in
// `Authorization`, which would then travel to the Sprite as well, and an org
// token can act on every Sprite in the org. `urlAuth: 'sprite'` keeps the URL
// private and sends the org token in `Authorization` and the agent token in
// `X-OpenBots-Agent-Token`; use it once the Sprites proxy is known to strip
// `Authorization` before the request reaches the Sprite
// (scripts/sprites-smoke.ts checks).

/** Where the provision script records the version it installed. */
export const PROVISION_VERSION_FILE = '/opt/openbots/provision.version';
/** Where the script and bundle are uploaded before the script runs; removed after. */
export const PROVISION_STAGING_DIR = '/var/tmp/openbots-provision';
/** The control agent's port: the one HTTP port a Sprite's URL routes to. */
export const SPRITES_AGENT_PORT = 8080;
export const DEFAULT_SPRITES_NAME_PREFIX = 'ob';
/** Holds made through `hold` are Tasks API tasks named with this prefix. */
export const SPRITES_HOLD_PREFIX = 'openbots-';
/** The Tasks API's longest hold; a longer one is refreshed by the caller. */
export const SPRITES_MAX_HOLD_SECONDS = 3600;

/**
 * Hosts the coding agents and their sign-ins reach, on top of the Sprites
 * `defaults` set (GitHub, npm, PyPI, Docker Hub, the major AI APIs). The
 * sign-in hosts are the ones in apps/server/src/services/coder-adapters
 * (claude.ts, codex.ts); xAI's are for pi on a Grok subscription.
 */
export const SPRITES_VENDOR_DOMAINS = [
  'anthropic.com',
  '*.anthropic.com',
  'claude.ai',
  '*.claude.ai',
  'claude.com',
  '*.claude.com',
  'openai.com',
  '*.openai.com',
  'chatgpt.com',
  '*.chatgpt.com',
  'x.ai',
  '*.x.ai',
  'grok.com',
  '*.grok.com',
] as const;

/** A domain rule the Sprites network policy accepts: a host, `*.host`, or `*`. */
export function isEgressDomain(domain: string): boolean {
  return (
    domain === '*' ||
    /^(\*\.)?[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(
      domain,
    )
  );
}

/**
 * The egress policy: the Sprites defaults, the vendors' hosts and `extra`
 * (OPENBOTS_SPRITES_EGRESS). Everything else is refused at DNS, and private
 * addresses always are.
 */
export function spritesEgressPolicy(extra: readonly string[] = []): SpriteEgressPolicy {
  const domains = [...new Set([...SPRITES_VENDOR_DOMAINS, ...extra])];
  for (const domain of domains) {
    if (!isEgressDomain(domain)) throw new Error(`Not an egress domain: ${domain}`);
  }
  return {
    rules: [
      { include: 'defaults' },
      ...domains.map((domain) => ({ domain, action: 'allow' as const })),
    ],
  };
}

/** A Sprite name prefix: short, lower case, so `<name>-<org id>` stays one DNS label. */
export function isSpriteNamePrefix(prefix: string): boolean {
  return /^[a-z][a-z0-9-]{0,15}$/.test(prefix);
}

/** The Sprite of a computer: the prefix and the computer id without its dashes. */
export function spriteName(computerId: string, prefix = DEFAULT_SPRITES_NAME_PREFIX): string {
  const id = computerId.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!id) throw new Error(`Not a computer id: ${computerId}`);
  return `${prefix}-${id}`;
}

/** What `create` and an outdated `start` install in the Sprite (docker/sprites/). */
export interface SpritesProvisioning {
  /** The local provision script, run as `bash <script> <bundle>`. */
  scriptPath: string;
  /** The local agent bundle tarball. */
  bundlePath: string;
  /** Written by the script to PROVISION_VERSION_FILE; a different one provisions again. */
  version: string;
}

export interface SpritesProviderOptions {
  /** The Sprites org token; used for the API, and for a private URL. */
  token: string;
  /** Injected for tests; otherwise the REST client over `token`. */
  api?: SpritesApi;
  baseUrl?: string;
  namePrefix?: string;
  /** `public` (default): our agent token alone guards the URL. See the header. */
  urlAuth?: SpriteUrlAuth;
  /** Defaults to `spritesEgressPolicy()`. */
  egress?: SpriteEgressPolicy;
  /** Without it the Sprite is made bare, and the agent has to be installed by other means. */
  provision?: SpritesProvisioning;
  /** The computers' TZ when a spec gives none. */
  timezone?: string;
  /** How long `start` waits for the agent's /health, a cold wake included. */
  readyTimeoutMs?: number;
  pollMs?: number;
  provisionTimeoutMs?: number;
  /** How long `destroy` waits for a deleted Sprite to be gone. */
  deleteTimeoutMs?: number;
  /** Reads the local provisioning files; tests stand in their own. */
  readLocalFile?(path: string): Promise<Uint8Array>;
}

export function createSpritesProvider(options: SpritesProviderOptions): ComputerProvider {
  const api = options.api ?? createSpritesApi({ token: options.token, baseUrl: options.baseUrl });
  const prefix = options.namePrefix ?? DEFAULT_SPRITES_NAME_PREFIX;
  if (!isSpriteNamePrefix(prefix)) {
    throw new Error('The Sprite name prefix must be lower case letters, digits or -, up to 16');
  }
  const urlAuth = options.urlAuth ?? 'public';
  const egress = options.egress ?? spritesEgressPolicy();
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 500;
  const provisionTimeoutMs = options.provisionTimeoutMs ?? 15 * 60_000;
  const deleteTimeoutMs = options.deleteTimeoutMs ?? 60_000;
  const readLocal =
    options.readLocalFile ?? (async (path: string) => new Uint8Array(await readFile(path)));

  /** Runs a command that must succeed; the error carries its output. */
  async function run(name: string, argv: string[], what: string, stdin?: string) {
    const result = await api.exec(name, argv, stdin === undefined ? {} : { stdin });
    if (result.exitCode !== 0) {
      throw new Error(`${what} failed (exit ${result.exitCode}): ${tail(result)}`);
    }
    return result.stdout;
  }

  /** Uploads one file, in parts when it is larger than one `fs/write` takes. */
  async function upload(name: string, path: string, data: Uint8Array, mode: number) {
    if (data.byteLength <= SPRITES_MAX_WRITE_BYTES) {
      await api.writeFile(name, path, data, { mode });
      return;
    }
    const parts: string[] = [];
    for (let at = 0; at < data.byteLength; at += SPRITES_MAX_WRITE_BYTES) {
      const part = `${path}.part${String(parts.length).padStart(4, '0')}`;
      await api.writeFile(name, part, data.subarray(at, at + SPRITES_MAX_WRITE_BYTES), { mode });
      parts.push(part);
    }
    await run(
      name,
      ['bash', '-c', 'out="$1"; shift; cat "$@" > "$out" && rm -f "$@"', 'join', path, ...parts],
      'Joining the upload',
    );
  }

  async function installedVersion(name: string): Promise<string | null> {
    const data = await api.readFile(name, PROVISION_VERSION_FILE);
    return data ? new TextDecoder().decode(data).trim() : null;
  }

  /**
   * Uploads the script and the bundle and runs the script with the agent
   * token. The token goes on stdin, not in the exec's query string, which
   * the API may log. Idempotent: the script is written to be run again.
   */
  async function provision(name: string, agentToken: string, timezone: string) {
    const setup = options.provision;
    if (!setup) return;
    const [script, bundle] = await Promise.all([
      readLocal(setup.scriptPath),
      readLocal(setup.bundlePath),
    ]);
    const scriptPath = `${PROVISION_STAGING_DIR}/provision.sh`;
    const bundlePath = `${PROVISION_STAGING_DIR}/agent-bundle.tgz`;
    // Neither file holds a secret (the token goes on stdin), and the API may
    // write them as another user than the one exec runs as: readable by all.
    await run(name, ['mkdir', '-p', PROVISION_STAGING_DIR], 'Preparing the provisioning');
    await upload(name, scriptPath, script, 0o644);
    await upload(name, bundlePath, bundle, 0o644);
    const result = await api.exec(
      name,
      [
        'bash',
        '-c',
        'IFS= read -r OPENBOTS_AGENT_TOKEN; export OPENBOTS_AGENT_TOKEN; exec bash "$0" "$1"',
        scriptPath,
        bundlePath,
      ],
      {
        stdin: `${agentToken}\n`,
        env: {
          OPENBOTS_AGENT_PORT: String(SPRITES_AGENT_PORT),
          OPENBOTS_PROVISION_VERSION: setup.version,
          TZ: timezone,
        },
        timeoutMs: provisionTimeoutMs,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Provisioning the Sprite failed (exit ${result.exitCode}): ${tail(result)}`);
    }
    const installed = await installedVersion(name);
    if (installed !== setup.version) {
      throw new Error(
        `Provisioning the Sprite recorded version ${installed ?? 'none'}, not ${setup.version}: ${tail(result)}`,
      );
    }
    await api.exec(name, ['rm', '-rf', PROVISION_STAGING_DIR]).catch(() => undefined);
  }

  /** Our holds on the Sprite (Tasks API tasks with our prefix); none unless it runs. */
  async function holds(name: string): Promise<string[]> {
    const info = await api.get(name);
    if (info?.status !== 'running') return [];
    const out = await run(name, tasksCurl('GET', '/v1/tasks'), 'Listing holds');
    const listed = (JSON.parse(out || '{}') as { tasks?: { name?: string }[] }).tasks ?? [];
    return listed
      .map((task) => task.name ?? '')
      .filter((task) => task.startsWith(SPRITES_HOLD_PREFIX));
  }

  async function deleteTask(name: string, task: string) {
    const out = await run(
      name,
      [...tasksCurl('DELETE', `/v1/tasks/${task}`), '-o', '/dev/null', '-w', '%{http_code}'],
      'Releasing the hold',
    );
    if (out !== '204' && out !== '200' && out !== '404') {
      throw new Error(`Releasing the hold failed: HTTP ${out}`);
    }
  }

  const nameOf = (ref: ComputerRef) =>
    ref.provider === 'sprites' && ref.containerId ? ref.containerId : null;
  const required = (ref: ComputerRef) => {
    const name = nameOf(ref);
    if (!name) throw new Error('The computer has no Sprite');
    return name;
  };

  const provider: ComputerProvider = {
    name: 'sprites',
    async create(spec) {
      const name = spriteName(spec.computerId, prefix);
      // A Sprite left from an earlier row (same id), or kept by a reset that
      // kept the sign-ins: made ready again, files kept.
      let info = await api.get(name);
      if (!info) info = await api.create(name, { urlAuth });
      else if (info.urlAuth !== urlAuth) await api.setUrlAuth(name, urlAuth);
      await api.setNetworkPolicy(name, egress);
      await provision(name, spec.agentToken, spec.timezone ?? options.timezone ?? 'UTC');
      return {
        provider: 'sprites',
        containerId: name,
        agentUrl: info.url,
        agentToken: spec.agentToken,
        volumeName: null,
      };
    },
    async start(ref) {
      const name = required(ref);
      // Reading the version wakes a paused Sprite.
      const setup = options.provision;
      if (setup && (await installedVersion(name)) !== setup.version) {
        await provision(name, ref.agentToken, options.timezone ?? 'UTC');
      }
      await waitForAgent(provider.agent(ref), readyTimeoutMs, pollMs);
    },
    // A Sprite pauses itself once idle, so there is nothing to stop; only our
    // holds go, which would otherwise keep it running for up to an hour.
    async stop(ref) {
      const name = nameOf(ref);
      if (!name) return;
      for (const task of await holds(name)) await deleteTask(name, task);
    },
    // The home lives on the Sprite's own disk, not a volume. `home` and
    // `state` both: the Sprite is deleted, every file and checkpoint with it.
    // `home` alone (a reset that keeps the sign-ins): the files under
    // /home/bot are deleted in place and the Sprite stays, with the state
    // directory (cookie store, coding agents' sign-ins) and the installed
    // agent; the next `create` provisions it again. Neither: the machine and
    // its home stay (K7) and only our holds go.
    async destroy(ref, destroyOptions) {
      const name = nameOf(ref);
      if (!name) return;
      if (!destroyOptions?.home) {
        await provider.stop(ref);
        return;
      }
      if (!destroyOptions.state) {
        await provider.stop(ref);
        await run(name, asRoot(`find ${COMPUTER_HOME} -mindepth 1 -delete`), 'Clearing the home');
        return;
      }
      await api.delete(name);
      // Deleting may finish after the call returns; the next `create` reuses
      // the name, so wait until it is free.
      const deadline = Date.now() + deleteTimeoutMs;
      while (await api.get(name)) {
        if (Date.now() >= deadline) throw new Error(`The Sprite ${name} was not deleted in time`);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
    // A paused Sprite (`warm` or `cold`) reads `running`: a request to its
    // URL wakes it, and its agent is a Sprite service that comes back on the
    // wake, so it is as ready as a running one. Only a deleted one is
    // `missing`; a Sprite is never `stopped`.
    async status(ref): Promise<MachineStatus> {
      const name = nameOf(ref);
      if (!name) return 'missing';
      return (await api.get(name)) ? 'running' : 'missing';
    },
    agent: (ref) =>
      createAgentClient({
        url: ref.agentUrl,
        token: ref.agentToken,
        ...(urlAuth === 'sprite' ? { proxyToken: options.token } : {}),
      }),
    async hold(ref, holdName, seconds) {
      const name = required(ref);
      const task = holdTask(holdName);
      const expire = Math.max(1, Math.min(SPRITES_MAX_HOLD_SECONDS, Math.round(seconds)));
      const out = await run(
        name,
        [
          ...tasksCurl('PUT', `/v1/tasks/${task}`),
          '-H',
          'content-type: application/json',
          '-d',
          JSON.stringify({ expire }),
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
        ],
        'Holding the Sprite',
      );
      if (out !== '200' && out !== '201') throw new Error(`Holding the Sprite failed: HTTP ${out}`);
    },
    async release(ref, holdName) {
      const name = nameOf(ref);
      if (!name) return;
      await deleteTask(name, holdTask(holdName));
    },
    checkpoint: (ref, comment) => api.createCheckpoint(required(ref), comment),
    restore: (ref, id) => api.restoreCheckpoint(required(ref), id),
    listCheckpoints: (ref) => api.listCheckpoints(required(ref)),
    applyEgressPolicy: (ref, policy) => api.setNetworkPolicy(required(ref), policy),
  };
  return provider;
}

/** A Tasks API call over the management socket inside the Sprite. */
function tasksCurl(method: string, path: string): string[] {
  return [
    'curl',
    '-sS',
    '--unix-socket',
    '/.sprite/api.sock',
    '-X',
    method,
    `http://sprite${path}`,
  ];
}

function holdTask(holdName: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(holdName))
    throw new Error(`Not a hold name: ${holdName}`);
  return `${SPRITES_HOLD_PREFIX}${holdName}`;
}

/** Runs a shell command as root: directly when exec already is, else through sudo. */
function asRoot(command: string): string[] {
  return [
    'bash',
    '-c',
    'if [ "$(id -u)" = 0 ]; then exec bash -c "$1"; else exec sudo -n bash -c "$1"; fi',
    'as-root',
    command,
  ];
}

/** The end of a command's output, for an error message. */
function tail({ stdout, stderr }: { stdout: string; stderr: string }) {
  const text = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trim();
  return text.length > 2000 ? `...${text.slice(-2000)}` : text || '(no output)';
}
