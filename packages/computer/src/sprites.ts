import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createAgentClient } from './agent-client.js';
import { waitForAgent } from './docker.js';
import {
  createSpritesApi,
  SPRITES_CALL_MS,
  SPRITES_CHECKPOINT_CALL_MS,
  SPRITES_CREATE_CALL_MS,
  SPRITES_EXEC_CALL_MS,
  SPRITES_EXEC_KILL_MS,
  SPRITES_MAX_WRITE_BYTES,
  SPRITES_WRITE_CALL_MS,
  type SpriteEgressPolicy,
  type SpriteInfo,
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
/**
 * Where the script and bundle are uploaded before the script runs, with a
 * suffix of its own per attempt (`stagingDir`); removed after. Its own, so a
 * write from an earlier attempt that lands late (a timed out upload the API
 * still completes) cannot replace this attempt's files.
 */
export const PROVISION_STAGING_DIR = '/var/tmp/openbots-provision';
/** provision.sh's exit code when another provisioning holds its lock past the wait. */
export const PROVISION_LOCKED_EXIT = 75;
/**
 * provision.sh's exit code when the Sprite is marked retired
 * (`SPRITES_RETIRED_MARKER`): it registers no agent on a retired machine.
 */
export const PROVISION_RETIRED_EXIT = 76;
/** Where provision.sh takes its lock; `retireInside` takes it too before it removes the agent. */
export const PROVISION_LOCK_FILE = '/opt/openbots/provision.lock';
/**
 * How long a provisioning may run on once the connection to it is gone: as
 * short as the API takes. Nobody reads its output then, no retry can attach
 * to it, and a later attempt would wait on its lock.
 */
export const PROVISION_MAX_RUN_AFTER_DISCONNECT = '1s';
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

/**
 * Hosts docker/sprites/provision.sh downloads from: Node's official builds,
 * the Ubuntu archive (ports.ubuntu.com on arm64) and Playwright's Chromium
 * mirrors. The policy is in force before the first provisioning (`create`
 * applies it first, so a reused Sprite gets the current one) and at every
 * later one, and the Sprites `defaults` set is not documented host by host,
 * so these are listed rather than assumed. The npm registry is in `defaults`.
 */
export const SPRITES_PROVISION_DOMAINS = [
  'nodejs.org',
  'archive.ubuntu.com',
  '*.archive.ubuntu.com',
  'security.ubuntu.com',
  'ports.ubuntu.com',
  'cdn.playwright.dev',
  'playwright.download.prss.microsoft.com',
] as const;

/** The control agent's Sprite service, as docker/sprites/provision.sh registers it. */
export const SPRITES_AGENT_SERVICE = 'openbots-agent';

/**
 * The label a retired Sprite carries (`retire`). The provider reads it from
 * the API's metadata, which does not wake the Sprite, and refuses to act on
 * the Sprite while it is there.
 */
export const SPRITES_RETIRED_LABEL = 'openbots-retired';
/**
 * A file `retireInside` writes before it drops the holds: a hold whose command
 * finds it after placing its task takes the task back, so of a hold and a
 * retire racing, either the retire sees the hold or the hold sees the file.
 * Root's to write; anyone may test for it. `unretire` removes it.
 */
export const SPRITES_RETIRED_MARKER = '/opt/openbots/retired';
/** A retired Sprite's egress policy: nothing at all. */
export const SPRITES_DENY_ALL: SpriteEgressPolicy = { rules: [{ domain: '*', action: 'deny' }] };
/**
 * Where docker/sprites/provision.sh keeps the agent token: its store, and the
 * copy the agent reads (and deletes) at start.
 */
export const SPRITES_AGENT_TOKEN_FILES = ['/etc/openbots/agent-token', '/var/lib/openbots/token'];

/**
 * The time limit of each API call that cuts a Sprite's reach or puts it back
 * (`retire`, `unretire`): short, so the longest either can take is known
 * (`SPRITES_RETIRE_MAX_MS`, `SPRITES_UNRETIRE_MAX_MS`) and the server's claim
 * on the record outlasts it. A call past it is ended, not left running.
 */
export const SPRITES_CUT_CALL_MS = 15_000;
/** The longest `retire` takes: five metadata calls at most. */
export const SPRITES_RETIRE_MAX_MS = 5 * SPRITES_CUT_CALL_MS;
/**
 * The longest `unretire` takes: four metadata calls and a command, which is
 * ended at its limit and may take `SPRITES_EXEC_KILL_MS` more to be gone.
 */
export const SPRITES_UNRETIRE_MAX_MS = 5 * SPRITES_CUT_CALL_MS + SPRITES_EXEC_KILL_MS;
/** The time limit of each call `retireInside` makes. */
export const SPRITES_INSIDE_CALL_MS = 30_000;
/** What `retireInside` may spend: it starts no call past it, and each call ends by it. */
const SPRITES_INSIDE_BUDGET_MS = 2 * 60_000;
/**
 * The longest `retireInside` takes: its budget, then the last call's end
 * (`SPRITES_EXEC_KILL_MS`). The server's claim on the record outlasts a cut
 * and this together.
 */
export const SPRITES_RETIRE_INSIDE_MAX_MS = SPRITES_INSIDE_BUDGET_MS + SPRITES_EXEC_KILL_MS;
/**
 * What one `create` or one `start` may spend on its calls: it starts none
 * past it, and limits each to what is left (`create`'s own, which cannot be
 * shortened, only while it fits).
 */
export const SPRITES_PROVISION_BUDGET_MS = 25 * 60_000;
/**
 * The longest one `create` or `start` takes: its budget, then the end of its
 * last command (`SPRITES_EXEC_KILL_MS`), then the removal of its staging
 * directory, a command of its own limited to `SPRITES_CUT_CALL_MS`.
 */
export const SPRITES_PROVISION_MAX_MS =
  SPRITES_PROVISION_BUDGET_MS + SPRITES_EXEC_KILL_MS + SPRITES_CUT_CALL_MS + SPRITES_EXEC_KILL_MS;
/** The longest `checkpoint` takes: a read, the checkpoint, and a list to find its id. */
export const SPRITES_CHECKPOINT_MAX_MS =
  SPRITES_CALL_MS + SPRITES_CHECKPOINT_CALL_MS + SPRITES_CALL_MS;
/** The longest `restore` of a checkpoint takes. */
export const SPRITES_RESTORE_MAX_MS = SPRITES_CHECKPOINT_CALL_MS;
/** The longest `status` takes: one read. */
export const SPRITES_STATUS_MAX_MS = SPRITES_CALL_MS;

/** A time budget for one `create` or `start` (`SPRITES_PROVISION_BUDGET_MS`). */
interface Budget {
  /** `ms`, or what is left of the budget if less; throws once nothing is left. */
  limit(ms: number): number;
  /** `ms` for a call whose own limit cannot be shortened; throws unless it fits in what is left. */
  need(ms: number): number;
}

function budget(ms = SPRITES_PROVISION_BUDGET_MS): Budget {
  const deadline = Date.now() + ms;
  const outOfTime = () => new Error('The provisioning ran out of time');
  return {
    limit(own) {
      const left = deadline - Date.now();
      if (left <= 0) throw outOfTime();
      return Math.min(own, left);
    },
    need(own) {
      if (deadline - Date.now() < own) throw outOfTime();
      return own;
    },
  };
}

/** How long the agent's removal waits for a provisioning that holds the lock. */
const SPRITES_LOCK_WAIT_S = 20;

/** Thrown for a call on a retired Sprite. */
export class SpriteRetiredError extends Error {
  constructor(name: string) {
    super(`The Sprite ${name} is retired`);
    this.name = 'SpriteRetiredError';
  }
}

const isRetired = (info: SpriteInfo | null) =>
  info?.labels?.includes(SPRITES_RETIRED_LABEL) ?? false;

/** A policy that lets nothing out: a deny of everything, and no rule that allows. */
export const deniesAll = (policy: SpriteEgressPolicy | null) =>
  !!policy &&
  policy.rules.some((rule) => rule.domain === '*' && rule.action === 'deny') &&
  policy.rules.every((rule) => rule.action === 'deny' && !rule.include);

/** Whether the API answered that there is no such Sprite (404), as opposed to failing. */
const notFound = (error: unknown) => (error as { status?: unknown } | null)?.status === 404;

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
 * The egress policy: the Sprites defaults, the vendors' hosts, the
 * provisioning's download hosts and `extra` (OPENBOTS_SPRITES_EGRESS).
 * Everything else is refused at DNS, and private addresses always are.
 */
export function spritesEgressPolicy(extra: readonly string[] = []): SpriteEgressPolicy {
  const domains = [...new Set([...SPRITES_VENDOR_DOMAINS, ...SPRITES_PROVISION_DOMAINS, ...extra])];
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
  /** Injected for tests; otherwise the SDK adapter over `token` (sprites-api.ts). */
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
  async function run(
    name: string,
    argv: string[],
    what: string,
    stdin?: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    const result = await api.exec(name, argv, {
      ...(stdin === undefined ? {} : { stdin }),
      ...options,
    });
    if (result.exitCode !== 0) {
      throw new Error(`${what} failed (exit ${result.exitCode}): ${tail(result)}`);
    }
    return result.stdout;
  }

  /** Uploads one file, in parts when it is larger than one `fs/write` takes. */
  async function upload(name: string, path: string, data: Uint8Array, mode: number, b: Budget) {
    const write = (to: string, bytes: Uint8Array) =>
      api.writeFile(name, to, bytes, { mode, timeoutMs: b.limit(SPRITES_WRITE_CALL_MS) });
    if (data.byteLength <= SPRITES_MAX_WRITE_BYTES) {
      await write(path, data);
      return;
    }
    const parts: string[] = [];
    for (let at = 0; at < data.byteLength; at += SPRITES_MAX_WRITE_BYTES) {
      const part = `${path}.part${String(parts.length).padStart(4, '0')}`;
      await write(part, data.subarray(at, at + SPRITES_MAX_WRITE_BYTES));
      parts.push(part);
    }
    await run(
      name,
      ['bash', '-c', 'out="$1"; shift; cat "$@" > "$out" && rm -f "$@"', 'join', path, ...parts],
      'Joining the upload',
      undefined,
      { timeoutMs: b.limit(SPRITES_EXEC_CALL_MS) },
    );
  }

  async function installedVersion(name: string, b: Budget): Promise<string | null> {
    const data = await api.readFile(name, PROVISION_VERSION_FILE, {
      timeoutMs: b.limit(SPRITES_CALL_MS),
    });
    return data ? new TextDecoder().decode(data).trim() : null;
  }

  /**
   * Uploads the script and the bundle and runs the script with the agent
   * token. The token goes on stdin, not in the exec's query string, which
   * the API may log. Idempotent: the script is written to be run again.
   */
  async function provision(
    name: string,
    agentToken: string,
    timezone: string,
    b: Budget,
    signal?: AbortSignal,
  ) {
    const setup = options.provision;
    if (!setup) return;
    signal?.throwIfAborted();
    const [script, bundle] = await Promise.all([
      readLocal(setup.scriptPath),
      readLocal(setup.bundlePath),
    ]);
    const staging = stagingDir();
    const scriptPath = `${staging}/provision.sh`;
    const bundlePath = `${staging}/agent-bundle.tgz`;
    // Neither file holds a secret (the token goes on stdin), and the API may
    // write them as another user than the one exec runs as: readable by all.
    await run(name, asRoot(prepareStaging(staging)), 'Preparing the provisioning', undefined, {
      timeoutMs: b.limit(SPRITES_EXEC_CALL_MS),
      ...(signal ? { signal } : {}),
    });
    try {
      signal?.throwIfAborted();
      await upload(name, scriptPath, script, 0o644, b);
      signal?.throwIfAborted();
      await upload(name, bundlePath, bundle, 0o644, b);
      signal?.throwIfAborted();
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
          timeoutMs: b.limit(provisionTimeoutMs),
          maxRunAfterDisconnect: PROVISION_MAX_RUN_AFTER_DISCONNECT,
          ...(signal ? { signal } : {}),
        },
      );
      // Marked retired meanwhile (a reset took it): the script registered no agent.
      if (result.exitCode === PROVISION_RETIRED_EXIT) throw new SpriteRetiredError(name);
      if (result.exitCode === PROVISION_LOCKED_EXIT) {
        throw new Error(
          `Another provisioning of the Sprite is still running; try again once it ends: ${tail(result)}`,
        );
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `Provisioning the Sprite failed (exit ${result.exitCode}): ${tail(result)}`,
        );
      }
      const installed = await installedVersion(name, b);
      if (installed !== setup.version) {
        throw new Error(
          `Provisioning the Sprite recorded version ${installed ?? 'none'}, not ${setup.version}: ${tail(result)}`,
        );
      }
    } finally {
      // As root: the API may have written the files as root, in a directory
      // exec made as another user. One left by a failure here goes with the
      // next attempt's sweep of old staging directories.
      // Limited on its own, past the budget: it runs after a failure too.
      await api
        .exec(name, asRoot(`rm -rf ${staging}`), { timeoutMs: SPRITES_CUT_CALL_MS })
        .catch(() => undefined);
    }
  }

  /** Our holds on the Sprite (Tasks API tasks with our prefix); none unless it runs. */
  async function holds(name: string, signal?: AbortSignal): Promise<string[]> {
    const info = await api.get(name);
    // A retired Sprite has none (`retire` dropped them), and a call would wake it.
    if (info?.status !== 'running' || isRetired(info)) return [];
    signal?.throwIfAborted();
    const out = await run(
      name,
      tasksCurl('GET', '/v1/tasks'),
      'Listing holds',
      undefined,
      signal ? { signal } : {},
    );
    const listed = (JSON.parse(out || '{}') as { tasks?: { name?: string }[] }).tasks ?? [];
    return listed
      .map((task) => task.name ?? '')
      .filter((task) => task.startsWith(SPRITES_HOLD_PREFIX));
  }

  async function deleteTask(name: string, task: string, signal?: AbortSignal) {
    const out = await run(
      name,
      [...tasksCurl('DELETE', `/v1/tasks/${task}`), '-o', '/dev/null', '-w', '%{http_code}'],
      'Releasing the hold',
      undefined,
      signal ? { signal } : {},
    );
    if (out !== '204' && out !== '200' && out !== '404') {
      throw new Error(`Releasing the hold failed: HTTP ${out}`);
    }
  }

  /**
   * Whether `key` is a Sprite name this provider gives: the prefix, a dash,
   * then letters and digits only. No computer id or machine key (a UUID, with
   * four dashes) can read as one, since the prefix is at most 16 characters.
   */
  const isOwnName = (key: string) =>
    key.startsWith(`${prefix}-`) && /^[a-z0-9]+$/.test(key.slice(prefix.length + 1));
  const cut = { timeoutMs: SPRITES_CUT_CALL_MS };
  const nameOf = (ref: ComputerRef) =>
    ref.provider === 'sprites' && ref.containerId ? ref.containerId : null;
  const required = (ref: ComputerRef) => {
    const name = nameOf(ref);
    if (!name) throw new Error('The computer has no Sprite');
    return name;
  };
  /** The Sprite's name, once its metadata (which does not wake it) shows it is not retired. */
  const serving = async (ref: ComputerRef) => {
    const name = required(ref);
    if (isRetired(await api.get(name))) throw new SpriteRetiredError(name);
    return name;
  };

  const provider: ComputerProvider = {
    name: 'sprites',
    ...(options.provision ? { version: options.provision.version } : {}),
    // `destroy` without `state` clears the home and keeps the Sprite.
    keepsMachineOnHomeReset: true,
    async create(spec) {
      const key = spec.machineKey ?? spec.computerId;
      // A key that is already one of our names (a restored Sprite's) names it as it is.
      const name = isOwnName(key) ? key : spriteName(key, prefix);
      // A Sprite left from an earlier row (same id), or kept by a reset that
      // kept the sign-ins: made ready again, files kept. A retired one is
      // put back with `unretire` first, never here by accident.
      const signal = spec.signal;
      const b = budget();
      const call = () => ({ timeoutMs: b.limit(SPRITES_CALL_MS) });
      signal?.throwIfAborted();
      let info = await api.get(name, call());
      if (isRetired(info)) throw new SpriteRetiredError(name);
      signal?.throwIfAborted();
      if (!info) {
        b.need(SPRITES_CREATE_CALL_MS);
        info = await api.create(name, { urlAuth });
      } else if (info.urlAuth !== urlAuth) await api.setUrlAuth(name, urlAuth, call());
      signal?.throwIfAborted();
      await api.setNetworkPolicy(name, egress, call());
      // A retire that began after the read above (a reset that cancelled
      // this provisioning) labels the Sprite before it cuts anything, so a
      // label here means the two calls above may have landed after its cut:
      // the cut is put back, and the Sprite is refused.
      if (isRetired(await api.get(name, call()))) {
        // Put back whatever the budget says: a cut is never left half undone.
        await api.setUrlAuth(name, 'sprite', cut);
        await api.setNetworkPolicy(name, SPRITES_DENY_ALL, cut);
        throw new SpriteRetiredError(name);
      }
      await provision(name, spec.agentToken, spec.timezone ?? options.timezone ?? 'UTC', b, signal);
      return {
        provider: 'sprites',
        containerId: name,
        agentUrl: info.url,
        agentToken: spec.agentToken,
        volumeName: null,
      };
    },
    async start(ref, startOptions) {
      const signal = startOptions?.signal;
      const b = budget();
      const name = required(ref);
      if (isRetired(await api.get(name, { timeoutMs: b.limit(SPRITES_CALL_MS) }))) {
        throw new SpriteRetiredError(name);
      }
      // Reading the version wakes a paused Sprite.
      const setup = options.provision;
      signal?.throwIfAborted();
      if (setup && (await installedVersion(name, b)) !== setup.version) {
        await provision(name, ref.agentToken, options.timezone ?? 'UTC', b, signal);
      }
      signal?.throwIfAborted();
      await waitForAgent(provider.agent(ref), b.limit(readyTimeoutMs), pollMs);
    },
    // A Sprite pauses itself once idle, so there is nothing to stop; only our
    // holds go, which would otherwise keep it running for up to an hour. A
    // caller that no longer holds the computer (its signal) releases none
    // after that: they may be the holds of a use that has just begun.
    async stop(ref, stopOptions) {
      const name = nameOf(ref);
      if (!name) return;
      const signal = stopOptions?.signal;
      signal?.throwIfAborted();
      for (const task of await holds(name, signal)) {
        signal?.throwIfAborted();
        await deleteTask(name, task, signal);
      }
    },
    // The home lives on the Sprite's own disk, not a volume. `home` and
    // `state` both: the Sprite is deleted, every file and checkpoint with it.
    // A full reset does not come here: it retires the Sprite (`retire`) and
    // the server deletes it this way once it has been kept long enough.
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
        // Clearing the home wakes the Sprite and needs its agent stopped; a
        // retired one is only ever deleted.
        const signal = destroyOptions.signal;
        if (isRetired(await api.get(name))) throw new SpriteRetiredError(name);
        signal?.throwIfAborted();
        await provider.stop(ref, signal ? { signal } : {});
        signal?.throwIfAborted();
        // The agent and what it started go first, as removing the container
        // ends them, so nothing writes into the home while it is cleared.
        // The service stays stopped until the next `create` provisions the
        // Sprite again and registers it anew with the new token.
        await run(name, asRoot(clearHome()), 'Clearing the home', undefined, {
          ...(signal ? { signal } : {}),
        });
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
    // A retired Sprite reads `missing` too: it serves nothing.
    async status(ref): Promise<MachineStatus> {
      const name = nameOf(ref);
      if (!name) return 'missing';
      const info = await api.get(name);
      return info && !isRetired(info) ? 'running' : 'missing';
    },
    // Whether a machine is retired is not this process's to remember: an
    // operator's restore in another process puts the same Sprite back. The
    // server refuses a retired machine's reference itself (its fence, from
    // the database), and the Sprite refuses the request (its URL is private
    // and its agent and token are gone).
    agent: (ref) =>
      createAgentClient({
        url: ref.agentUrl,
        token: ref.agentToken,
        ...(urlAuth === 'sprite' ? { proxyToken: options.token } : {}),
      }),
    async hold(ref, holdName, seconds) {
      const name = await serving(ref);
      const task = holdTask(holdName);
      const expire = Math.max(1, Math.min(SPRITES_MAX_HOLD_SECONDS, Math.round(seconds)));
      // The metadata said it is not retired, but a retire may begin before
      // the task is placed: the command takes it back if it finds the
      // marker `retireInside` writes before it drops the holds.
      const out = (
        await run(name, holdCommand(task, JSON.stringify({ expire })), 'Holding the Sprite')
      ).trim();
      if (out === 'retired') throw new SpriteRetiredError(name);
      if (out !== '200' && out !== '201') throw new Error(`Holding the Sprite failed: HTTP ${out}`);
    },
    async release(ref, holdName) {
      const name = nameOf(ref);
      if (!name) return;
      // A retired Sprite holds nothing, and the call would wake it.
      if (isRetired(await api.get(name))) return;
      await deleteTask(name, holdTask(holdName));
    },
    checkpoint: async (ref, comment) => api.createCheckpoint(await serving(ref), comment),
    // Allowed on a retired Sprite: an operator's restore puts its disk back first.
    restore: (ref, id) => api.restoreCheckpoint(required(ref), id),
    listCheckpoints: (ref) => api.listCheckpoints(required(ref)),
    applyEgressPolicy: async (ref, policy) => api.setNetworkPolicy(await serving(ref), policy),
    // Reach is cut first, with metadata calls that neither wake the Sprite
    // nor run anything inside it: the label (from then on a hold, a start or
    // a create is refused), the URL private (no request from outside reaches
    // the agent), and the egress policy that denies everything. Each step is
    // safe to repeat. A Sprite already gone has nothing to retire, but only
    // the API's own 404 says it is gone: a read that finds nothing is checked
    // with a write, and anything else is a failure, never a success. Each
    // call is limited to SPRITES_CUT_CALL_MS.
    async retire(ref) {
      const name = required(ref);
      let info = await api.get(name, cut);
      // Set by the write that checks a read that found nothing: not set twice,
      // so the calls stay within five (SPRITES_RETIRE_MAX_MS).
      let urlPrivate = false;
      if (!info) {
        try {
          await api.setUrlAuth(name, 'sprite', cut);
        } catch (error) {
          if (notFound(error)) return;
          throw error;
        }
        urlPrivate = true;
        info = await api.get(name, cut);
        if (!info) throw new Error(`The Sprite ${name} could not be read`);
      }
      const labels = info.labels ?? [];
      if (!labels.includes(SPRITES_RETIRED_LABEL)) {
        await api.setLabels(name, [...labels, SPRITES_RETIRED_LABEL], cut);
      }
      if (!urlPrivate && info.urlAuth !== 'sprite') await api.setUrlAuth(name, 'sprite', cut);
      await api.setNetworkPolicy(name, SPRITES_DENY_ALL, cut);
    },
    // Every part of the cut, read back: the label, the private URL and the
    // policy that denies everything.
    async retiredState(ref) {
      const name = required(ref);
      const info = await api.get(name, cut);
      if (!info) return 'gone';
      if (!isRetired(info) || info.urlAuth !== 'sprite') return 'in_service';
      return deniesAll(await api.getNetworkPolicy(name, cut)) ? 'retired' : 'in_service';
    },
    // Then, inside it (exec goes through the Sprites API, not the Sprite's
    // own network, so the deny-all policy does not stop it): the marker that
    // turns away a racing hold, our holds, so it pauses, and the agent and
    // its token, so nothing that knew the token reaches anything even if the
    // URL were opened again. Only on a Sprite `retire` labelled, read again
    // before each step (an operator's restore may have put it back meanwhile),
    // and after the caller's own check (`check`: that it still holds the
    // machine). Each call is limited, and the whole within
    // SPRITES_RETIRE_INSIDE_MAX_MS. The agent is removed under provision.sh's
    // lock, so a provisioning that began before the mark either ends first
    // (and its agent is removed) or finds the mark and registers none.
    async retireInside(ref, insideOptions) {
      const name = required(ref);
      const deadline = Date.now() + SPRITES_INSIDE_BUDGET_MS;
      const limit = (ms: number) => {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`Retiring ${name} inside ran out of time`);
        return Math.min(ms, left);
      };
      /** False when the Sprite is gone; throws unless it is still retired. */
      const step = async () => {
        await insideOptions?.check?.();
        const info = await api.get(name, { timeoutMs: limit(SPRITES_CUT_CALL_MS) });
        if (!info) return false;
        if (!isRetired(info)) throw new Error(`The Sprite ${name} is not retired`);
        return true;
      };
      const inside = (argv: string[], what: string) =>
        run(name, argv, what, undefined, { timeoutMs: limit(SPRITES_INSIDE_CALL_MS) });
      if (!(await step())) return;
      await inside(asRoot(markRetired()), 'Marking the Sprite retired');
      if (!(await step())) return;
      // `holds` skips a retired Sprite, so these are listed directly.
      const out = await inside(tasksCurl('GET', '/v1/tasks'), 'Listing holds');
      const listed = (JSON.parse(out || '{}') as { tasks?: { name?: string }[] }).tasks ?? [];
      for (const task of listed) {
        if (!task.name?.startsWith(SPRITES_HOLD_PREFIX)) continue;
        if (!(await step())) return;
        const code = (
          await inside(
            [
              ...tasksCurl('DELETE', `/v1/tasks/${task.name}`),
              '-o',
              '/dev/null',
              '-w',
              '%{http_code}',
            ],
            'Releasing the hold',
          )
        ).trim();
        if (code !== '204' && code !== '200' && code !== '404') {
          throw new Error(`Releasing the hold failed: HTTP ${code}`);
        }
      }
      if (!(await step())) return;
      await inside(asRoot(disableAgent()), 'Stopping the retired agent');
    },
    // The label goes last: until then the Sprite is still refused.
    async unretire(ref) {
      const name = required(ref);
      const info = await api.get(name, cut);
      if (!info) throw new Error(`The Sprite ${name} is gone`);
      await api.setUrlAuth(name, urlAuth, cut);
      await api.setNetworkPolicy(name, egress, cut);
      const cleared = await api.exec(name, asRoot(`rm -f -- ${SPRITES_RETIRED_MARKER}`), {
        timeoutMs: SPRITES_CUT_CALL_MS,
      });
      if (cleared.exitCode !== 0) {
        throw new Error(
          `Clearing the retired mark failed (exit ${cleared.exitCode}): ${tail(cleared)}`,
        );
      }
      const labels = info.labels ?? [];
      if (labels.includes(SPRITES_RETIRED_LABEL)) {
        await api.setLabels(
          name,
          labels.filter((label) => label !== SPRITES_RETIRED_LABEL),
          cut,
        );
      }
    },
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

/**
 * Places the hold `task`, then takes it back and prints `retired` if the
 * Sprite is marked retired (`retireInside`), else prints the HTTP status.
 */
function holdCommand(task: string, body: string): string[] {
  return [
    'bash',
    '-c',
    [
      'code=$(curl -sS --unix-socket /.sprite/api.sock -X PUT "http://sprite/v1/tasks/$1" ' +
        '-H "content-type: application/json" -d "$2" -o /dev/null -w "%{http_code}") || exit 1',
      'if [ -e "$3" ]; then',
      '  curl -sS --unix-socket /.sprite/api.sock -X DELETE "http://sprite/v1/tasks/$1" -o /dev/null',
      '  echo retired; exit 0',
      'fi',
      'echo "$code"',
    ].join('\n'),
    'openbots-hold',
    task,
    body,
    SPRITES_RETIRED_MARKER,
  ];
}

/** Writes the retired marker. Run as root. */
function markRetired(): string {
  const dir = SPRITES_RETIRED_MARKER.slice(0, SPRITES_RETIRED_MARKER.lastIndexOf('/'));
  return [`mkdir -p -- ${dir}`, `touch -- ${SPRITES_RETIRED_MARKER}`].join('\n');
}

function holdTask(holdName: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(holdName))
    throw new Error(`Not a hold name: ${holdName}`);
  return `${SPRITES_HOLD_PREFIX}${holdName}`;
}

/**
 * Stops the agent's service, ends what it started (its cgroup, as
 * provision.sh's launcher sets it up, else the bot user's processes) and
 * deletes everything under the home. Run as root.
 */
function clearHome(): string {
  return [
    `sprite-env services stop ${SPRITES_AGENT_SERVICE} >/dev/null 2>&1 || true`,
    'cg=/sys/fs/cgroup/openbots-computer',
    'if [ -e "$cg/cgroup.kill" ]; then echo 1 >"$cg/cgroup.kill" || true; fi',
    'pkill -KILL -u bot || true',
    `find ${COMPUTER_HOME} -mindepth 1 -delete`,
  ].join('\n');
}

/**
 * Stops the agent's service and removes it, so it does not come back on the
 * next wake, ends what it started and deletes the agent token from the disk.
 * The token the server sealed is forgotten with the row, so nothing can reach
 * the agent again even if the disk is put back as it was. Run as root.
 */
function disableAgent(): string {
  return [
    // Under provision.sh's lock: a provisioning running now ends first.
    `exec 9>>${PROVISION_LOCK_FILE}`,
    `flock -w ${SPRITES_LOCK_WAIT_S} 9 || { echo 'a provisioning holds the lock' >&2; exit ${PROVISION_LOCKED_EXIT}; }`,
    `sprite-env services stop ${SPRITES_AGENT_SERVICE} >/dev/null 2>&1 || true`,
    `sprite-env services delete ${SPRITES_AGENT_SERVICE} >/dev/null 2>&1 || true`,
    'cg=/sys/fs/cgroup/openbots-computer',
    'if [ -e "$cg/cgroup.kill" ]; then echo 1 >"$cg/cgroup.kill" || true; fi',
    'pkill -KILL -u bot || true',
    `rm -f -- ${SPRITES_AGENT_TOKEN_FILES.join(' ')}`,
  ].join('\n');
}

/** A staging directory of its own for one provisioning attempt. */
export function stagingDir(): string {
  return `${PROVISION_STAGING_DIR}-${randomBytes(8).toString('hex')}`;
}

/**
 * Makes the staging directory afresh, as root. It sits in /var/tmp, where the
 * Bots' commands can write: a directory or link they left at the path would
 * otherwise take the upload, and they could swap the script that then runs as
 * root. `mkdir` without -p fails if one appears again after the `rm`. It
 * belongs to the user exec runs as (sudo's caller), as `mkdir -p` made it before.
 * Staging directories over an hour old (attempts that could not clean up,
 * long past any provisioning's time limit) go first.
 */
export function prepareStaging(dir: string): string {
  const parent = dir.slice(0, dir.lastIndexOf('/')) || '/';
  const stem = PROVISION_STAGING_DIR.slice(PROVISION_STAGING_DIR.lastIndexOf('/') + 1);
  return [
    `{ find ${parent} -mindepth 1 -maxdepth 1 -name '${stem}*' -mmin +60 -exec rm -rf -- {} + || true; }`,
    `rm -rf -- ${dir}`,
    `mkdir -m 0755 -- ${dir}`,
    `chown -- "\${SUDO_USER:-root}" ${dir}`,
  ].join(' && ');
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
