import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { labelFor, OwnerHasScreen, type ComputerServices, type StepRecord } from '@openbots/agent';
import {
  AgentError,
  browserProfileDir,
  cdpPortFor,
  createDockerProvider,
  createRemoteProvider,
  createSpritesProvider,
  FIRST_DISPLAY,
  nextDisplay,
  SANDBOX_NETWORK,
  SCREEN_SIZE,
  ScreenLocks,
  screenNumber,
  spritesEgressPolicy,
  SpritesApiError,
  volumeName,
  type ComputerAgentClient,
  type ComputerProvider,
  type ComputerRef,
} from '@openbots/computer';
import {
  CODER_CONTROL_CHANNEL,
  COMPUTER_OFF,
  wsEvent,
  type CoderControl,
  type ComputerStatus,
} from '@openbots/shared';
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  not,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { JobHandler } from '@openbots/shared';
import type { AppDeps, CurrentUser } from '../context.js';
import { inRanges } from '../client-ip.js';
import { schema, type Db } from '../db/client.js';
import { inWorkspace } from '../db/scope.js';
import { DomainError, notFound } from '../errors.js';
import { publishEvent } from '../infra/index.js';
import { assertBotOwner } from '../ownership.js';
import { decryptSecretString, encryptSecret, keyringFromConfig } from '../secrets.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from './audit.js';
import { setState } from './bot-state.js';
import { enqueueCoderJob } from './coder-jobs.js';
import {
  beginUse,
  inUseSince,
  type ComputerUse,
  type UseOptions,
  type UseReason,
} from './computer-use.js';
import { MCP_CONTROL_CHANNEL, type McpControl } from './mcp-control.js';
import {
  computerBusy,
  computerChanged,
  retireMachine,
  type ResetRecord,
  type RetiredRow,
} from './computer-retire.js';
import { bestEffort } from './best-effort.js';
import { fenceComputer, isFenced } from './computer-fence.js';
import {
  PROVISION_HEARTBEAT_MS,
  PROVISION_STALE_MS,
  STOPPING_GIVE_UP_MS,
  STOPPING_HEARTBEAT_MS,
  STOPPING_TAKEOVER_MS,
} from './computer-timing.js';
import { beginStartWork, endStartWork } from './computer-start-work.js';

export { startWorkSettled } from './computer-start-work.js';

// The account's computer (plan 4.5, 9; K1 to K7). One `computers` row per
// owner, created on first use through the configured provider (`remote` when
// OPENBOTS_COMPUTER_AGENT_URL is set, else `sprites` when
// OPENBOTS_SPRITES_TOKEN is set, else `docker` when DOCKER_HOST is set, else
// none: the computer tools are not offered). Starting it brings the machine
// up and waits for its control agent; the idle sweep stops it after
// `idle_timeout_min` (default 30) unless `always_on`, and the home volume
// stays. Status changes publish `computer.status` to the owner.
//
// A Sprite pauses itself about 30 seconds after its last activity and wakes
// on the next request to its URL, which is how every agent call reaches it,
// so the provider reads a paused Sprite as `running` and its `stop` only
// releases holds. Its row stays `running`: the idle sweep and the owner's
// idle settings do not apply to it (`idleSettingsApply`). Making and
// provisioning a Sprite takes minutes, so it runs as a `computers` job
// (`provisionComputer`), one per computer at a time, never inside a request
// or a run: those see `creating` or `starting`, wait up to
// `PROVISION_WAIT_MS`, and otherwise get `COMPUTER_STARTING`; the job's end
// publishes `computer.status`. A new provisioning version reaches a running
// Sprite once it has been unused for the default idle time. While a run, a
// coding session or a command uses it, the computer is held awake
// (computer-use.ts, `beginComputerUse`). After a cold wake the agent comes
// back without the screens it had started, so a screen is checked on the
// agent before it is trusted (`ensureScreen`).
//
// Each Bot gets a screen (`bot_screens`, K2): display `:10+n`, its own CDP
// port and Chromium profile, started on the agent the first time the Bot
// needs it after the computer starts. Screen actions take the Bot's screen
// lock. While the owner has taken the screen over (`controlled_by_user_id`,
// K3) a screen action sets the Bot `waiting`, waits a while for the hand
// back, and otherwise answers "The owner has the screen; wait".
//
// Creating, starting and stopping the computer and taking or handing back a
// screen are audited (S-11): by the owner, the Bot whose run needed it, or the
// system for the idle sweep.
//
// The remote provider is one machine for the whole install (plan 9.2): every
// row gets the same agent, so its files under /home/bot and its cookie store
// would be every account's. The first account to use it keeps it, and the
// others are refused, unless the operator sets OPENBOTS_COMPUTER_AGENT_SHARED.
// Displays are numbered per machine, so on a shared agent each account's Bots
// get displays no other account's Bot holds.

export type ComputerRow = typeof schema.computers.$inferSelect;
export type ScreenRow = typeof schema.botScreens.$inferSelect;
type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type BotRow = Pick<typeof schema.bots.$inferSelect, 'id' | 'ownerId' | 'workspaceId'>;

export const DEFAULT_IDLE_TIMEOUT_MIN = 30;
/** The idle timeout the owner can pick, in minutes: five minutes to a day. */
export const IDLE_TIMEOUT_RANGE_MIN = { min: 5, max: 24 * 60 } as const;
/** How long a screen action waits for the owner to hand the screen back. */
export const TAKEOVER_WAIT_MS = 60_000;
const TAKEOVER_POLL_MS = 500;
/** How often the worker looks for idle computers. */
export const IDLE_SWEEP_MS = 60_000;
/** How long deleting a Bot waits for its screen to stop on the agent. */
const SCREEN_STOP_TIMEOUT_MS = 10_000;
/** A failed idle stop is retried after one sweep, then twice as long each time, up to this. */
export const IDLE_STOP_RETRY_MAX_MS = 30 * 60_000;
/** The queue that makes and provisions computers off the request path (Sprites). */
export const COMPUTERS_QUEUE = 'computers';
/**
 * How long a start waits for a provisioning job before it answers
 * `COMPUTER_STARTING`: long enough for a Sprite that only needs its agent
 * checked, far short of a first provisioning.
 */
export const PROVISION_WAIT_MS = 15_000;
const PROVISION_POLL_MS = 250;
/**
 * The start's wait, changeable by tests so a queued start answers at once, and
 * how long a row may go without word from its job (queued, or its heartbeat
 * while it runs: `status_at`) before a start or the sweep queues another
 * (computer-timing.ts `PROVISION_STALE_MS`). A job that is only slow beats,
 * so it is never doubled.
 */
export const provisionTimings = {
  waitMs: PROVISION_WAIT_MS,
  staleMs: PROVISION_STALE_MS,
  /** How often a running job beats (`PROVISION_HEARTBEAT_MS`); tests set it short. */
  heartbeatMs: PROVISION_HEARTBEAT_MS,
};

/**
 * The settings a computer's container is made with (plan 9.5). They live in
 * its environment, so a change applies when the container is made again: the
 * next start of a stopped computer does that, keeping its volumes.
 */
interface SandboxEnv {
  egressProxy?: string;
  noProxy?: string;
  timezone?: string;
}

/** What `computers.spec` holds: how the machine was made, and a pending idle stop retry. */
interface MachineSpec {
  image?: string;
  /**
   * A fingerprint of the `SandboxEnv` it was made with, not the values: the
   * proxy URL may hold a password.
   */
  envKey?: string;
  /** The sandbox network it was made on; absent before it could be anything but the default. */
  network?: string;
  /** Set while a failed idle stop waits for its retry (plan 9.5). */
  idleStopRetry?: { failures: number; retryAt: string };
  /** The provider's `version` the machine was last provisioned with (Sprites). */
  provisionVersion?: string;
  /** Why the last provisioning job failed, until one succeeds. */
  error?: string;
  /**
   * The provisioning job the row waits on, while it is `creating`, `starting`
   * or `updating` for one: only the job that carries this attempt runs, so a
   * job queued twice, or one whose enqueue seemed to fail and was replaced,
   * provisions once. `at` is when it was queued.
   */
  provision?: { attempt: string; at: string };
}

const specOf = (row: ComputerRow): MachineSpec => (row.spec ?? {}) as MachineSpec;

function sandboxEnv(deps: AppDeps): SandboxEnv {
  const proxy = deps.config.sandboxProxy;
  return { egressProxy: proxy?.url, noProxy: proxy?.noProxy, timezone: deps.config.timezone };
}

function envKey({ egressProxy, noProxy, timezone }: SandboxEnv): string {
  const values = [egressProxy ?? null, noProxy ?? null, timezone ?? 'UTC'];
  return createHash('sha256').update(JSON.stringify(values)).digest('base64url');
}

/** True when the machine was made with other settings than the configured ones. */
function envChanged(deps: AppDeps, row: ComputerRow): boolean {
  // Machines made before the fingerprint was recorded have no proxy and run on UTC.
  return (specOf(row).envKey ?? envKey({})) !== envKey(sandboxEnv(deps));
}

/**
 * True when the machine was made on another sandbox network than the
 * configured one (OPENBOTS_SANDBOX_NETWORK changed, for example when the Mac
 * app moved its stack off a network another stack holds).
 */
function networkChanged(deps: AppDeps, row: ComputerRow): boolean {
  return (specOf(row).network ?? SANDBOX_NETWORK) !== deps.config.sandboxNetwork.name;
}

/** True when the machine runs another image than the configured one: OpenBots was upgraded. */
function imageChanged(deps: AppDeps, row: ComputerRow): boolean {
  return (specOf(row).image ?? deps.config.sandboxImage) !== deps.config.sandboxImage;
}

/** The spec without a pending idle stop retry, once the computer stopped or started. */
function settledSpec(row: ComputerRow): MachineSpec {
  const { idleStopRetry: _, ...spec } = specOf(row);
  return spec;
}

/** How long the sweep waits before retrying an idle stop that failed `failures` times. */
export function idleStopRetryDelayMs(failures: number) {
  return Math.min(IDLE_SWEEP_MS * 2 ** Math.max(0, failures - 1), IDLE_STOP_RETRY_MAX_MS);
}

export const computerUnavailable = (message: string) =>
  new DomainError(503, 'COMPUTER_UNAVAILABLE', message);

/** A provisioning job is making the computer ready; the caller should try again shortly (503). */
export const computerStarting = (status: string) =>
  new DomainError(
    503,
    'COMPUTER_STARTING',
    status === 'creating'
      ? 'The computer is being set up; the first time takes a few minutes. Try again shortly.'
      : 'The computer is starting. Try again shortly.',
  );

/** The owner's computer is not running, and this path does not start it (409). */
export const computerOff = () =>
  new DomainError(409, COMPUTER_OFF, 'The computer is off. Start it first.');

const NO_PROVIDER =
  'This install has no computer: set DOCKER_HOST (the docker guard), OPENBOTS_COMPUTER_AGENT_URL or OPENBOTS_SPRITES_TOKEN';

const REMOTE_TAKEN =
  "This install's computer is one remote machine, and another account already uses it. " +
  'An administrator can set OPENBOTS_COMPUTER_AGENT_SHARED=true to let every account share it, ' +
  'files and logins included.';

// One provider per process: keyed by its config, which every deps of the process shares.
const providers = new WeakMap<object, ComputerProvider | null>();

/** Replaces the provider for one `AppDeps` (tests use a mocked dockerode or the fake agent). */
export function setComputerProvider(
  deps: Pick<AppDeps, 'config'>,
  provider: ComputerProvider | null,
) {
  providers.set(deps.config, provider);
}

/**
 * The configured provider: `remote` when OPENBOTS_COMPUTER_AGENT_URL is set,
 * else `sprites` when OPENBOTS_SPRITES_TOKEN is, else `docker` when
 * DOCKER_HOST is, else none.
 */
export function computerProvider(
  deps: Pick<AppDeps, 'config' | 'logger'>,
): ComputerProvider | null {
  if (!providers.has(deps.config)) {
    const { computerAgent, sprites, dockerHost } = deps.config;
    if (computerAgent?.shared) {
      deps.logger.warn(
        'OPENBOTS_COMPUTER_AGENT_SHARED is on: every account shares the remote computer, its files and its logins',
      );
    }
    providers.set(
      deps.config,
      computerAgent
        ? createRemoteProvider(computerAgent)
        : sprites
          ? spritesProvider(deps, sprites)
          : dockerHost
            ? createDockerProvider({ dockerHost, network: deps.config.sandboxNetwork })
            : null,
    );
  }
  return providers.get(deps.config) ?? null;
}

/**
 * The sprites provider from its configuration. The provisioning files are
 * read when a Sprite is made; VERSION is read here, once per process, so a
 * new release's files provision each Sprite again at its next start.
 */
function spritesProvider(
  deps: Pick<AppDeps, 'config'>,
  sprites: NonNullable<AppDeps['config']['sprites']>,
): ComputerProvider {
  const dir = sprites.provisionDir;
  const version = readFileSync(join(dir, 'VERSION'), 'utf8').trim();
  if (!version) throw new Error(`${join(dir, 'VERSION')} is empty`);
  return createSpritesProvider({
    token: sprites.token,
    namePrefix: sprites.namePrefix,
    urlAuth: sprites.urlAuth,
    egress: spritesEgressPolicy(sprites.egress),
    provision: {
      scriptPath: join(dir, 'provision.sh'),
      bundlePath: join(dir, 'agent-bundle.tgz'),
      version,
    },
    timezone: deps.config.timezone,
  });
}

export function computerAvailable(deps: AppDeps) {
  return computerProvider(deps) !== null;
}

/**
 * Whether the provider's machines are made and started by a `computers` job
 * rather than inline (Sprites: provisioning takes minutes).
 */
function provisionsInBackground(machines: ComputerProvider) {
  return machines.name === 'sprites';
}

/**
 * Whether the owner's idle timeout and "always on" mean anything for this
 * row: not on Sprites, which pause themselves about 30 seconds after their
 * last use and wake on the next.
 */
export function idleSettingsApply(row: Pick<ComputerRow, 'provider'>) {
  return row.provider !== 'sprites';
}

/**
 * The provider as members and their organization are told it: `docker`, or
 * `remote` for a machine somewhere else. The hosted service's sandbox vendor
 * is not named to them.
 */
export function shownProvider(name: string): 'docker' | 'remote' {
  return name === 'docker' ? 'docker' : 'remote';
}

function provider(deps: AppDeps) {
  const found = computerProvider(deps);
  if (!found) throw computerUnavailable(NO_PROVIDER);
  return found;
}

const keyring = (deps: AppDeps) => keyringFromConfig(deps.config);

/** The owner's computer in an organization: one per (organization, owner) (plan 21.3). */
export async function getComputer(deps: Pick<AppDeps, 'db'>, owner: Owner) {
  const [row] = await deps.db
    .select()
    .from(schema.computers)
    .where(
      and(
        eq(schema.computers.ownerId, owner.id),
        eq(schema.computers.workspaceId, owner.workspaceId),
      ),
    );
  return row ?? null;
}

export async function listScreens(deps: Pick<AppDeps, 'db'>, computerId: string) {
  return deps.db
    .select()
    .from(schema.botScreens)
    .where(eq(schema.botScreens.computerId, computerId));
}

async function setStatus(
  deps: AppDeps,
  row: ComputerRow,
  status: ComputerStatus,
  more: Partial<ComputerRow> = {},
  error: string | null = null,
  guard?: SQL,
): Promise<ComputerRow> {
  const updated = await setStatusIf(deps, row, status, more, error, guard);
  if (!updated && guard) throw computerChangedUnderJob();
  return updated ?? row;
}

/** One more generation: what every reset, stop, start and claim writes. */
const nextGeneration = () => sql`${schema.computers.generation} + 1`;

/** The row is still at the generation `row` read: nothing reset, stopped, started or claimed it since. */
const sameGeneration = (row: Pick<ComputerRow, 'generation'>) =>
  eq(schema.computers.generation, row.generation);

/**
 * Sets the row's status (and `more`) if it still matches `guard`; the row as
 * it then is, or null when it no longer matched (nothing was written). A
 * write with no guard is a new start, stop or claim of the row, so it moves
 * the row to its next generation; a guarded one is the work of whoever holds
 * the generation the guard names, and leaves it.
 */
async function setStatusIf(
  deps: AppDeps,
  row: ComputerRow,
  status: ComputerStatus,
  more: Partial<ComputerRow> = {},
  error: string | null = null,
  guard?: SQL,
): Promise<ComputerRow | null> {
  const [updated] = await deps.db
    .update(schema.computers)
    .set({ status, ...more, ...(guard ? {} : { generation: nextGeneration() }) })
    .where(and(eq(schema.computers.id, row.id), guard))
    .returning();
  if (!updated && guard) return null;
  await publishStatus(deps, row, status, error);
  return updated ?? row;
}

/** A provisioning job whose row moved on meanwhile (another attempt, a reset). */
class StaleJobError extends Error {
  constructor() {
    super('The computer changed while its provisioning ran');
    this.name = 'StaleJobError';
  }
}
const computerChangedUnderJob = () => new StaleJobError();

/**
 * Tells the owner's apps the computer's status: best effort. The row is what
 * counts; a bus that is down never changes what a start, a stop or a reset
 * did or answers.
 */
async function publishStatus(
  deps: AppDeps,
  row: ComputerRow,
  status: ComputerStatus,
  error: string | null = null,
) {
  await bestEffort(
    publishEvent(
      deps.infra.bus,
      wsEvent(
        'computer.status',
        { computerId: row.id, status, error },
        { user_id: row.ownerId, workspace_id: row.workspaceId },
      ),
    ),
    (failure) =>
      deps.logger.warn({ err: failure, computerId: row.id, status }, 'publishing a status failed'),
  );
}

function refOf(deps: AppDeps, row: ComputerRow): ComputerRef {
  if (!row.agentUrl || !row.agentToken) throw computerUnavailable('The computer was never created');
  // A row read before a reset names the machine the reset took away (computer-fence.ts).
  if (isFenced(row)) throw computerUnavailable('The computer was reset. Try again.');
  return {
    provider: row.provider,
    containerId: row.containerId,
    agentUrl: row.agentUrl,
    agentToken: decryptSecretString(row.agentToken, keyring(deps)),
    volumeName: row.volumeName,
  };
}

/**
 * Enough of a reference for the provider to find the machine by its name or
 * container (stop, destroy, checkpoint): keyed on `containerId`, the
 * machine's existence, never on whether it has an agent.
 */
function machineRefOf(row: ComputerRow): ComputerRef {
  return {
    provider: row.provider,
    containerId: row.containerId,
    agentUrl: row.agentUrl ?? '',
    agentToken: '',
    volumeName: row.volumeName,
  };
}

export function agentFor(deps: AppDeps, row: ComputerRow): ComputerAgentClient {
  const machines = provider(deps);
  const agent = machines.agent(refOf(deps, row));
  return provisionsInBackground(machines) ? quietAgent(deps, agent, row.id) : agent;
}

/** The owner's computer row, creating the machine behind it on first use. */
export async function ensureComputer(
  deps: AppDeps,
  owner: Owner,
  by: AuditActor = { type: 'user', id: owner.id },
): Promise<ComputerRow> {
  const machines = provider(deps);
  let row = await getComputer(deps, owner);
  if (!row) {
    await deps.db.transaction(async (tx) => {
      // Two accounts asking at once: one takes the remote machine.
      if (machines.name === 'remote') {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('openbots:remote-computer'))`);
      }
      await assertRemoteFor(deps, owner, tx);
      await tx
        .insert(schema.computers)
        .values({
          workspaceId: owner.workspaceId,
          ownerId: owner.id,
          provider: machines.name,
          // A job makes it in the background: the start claims it and queues the job.
          status: provisionsInBackground(machines) ? 'stopped' : 'creating',
          idleTimeoutMin: DEFAULT_IDLE_TIMEOUT_MIN,
        })
        .onConflictDoNothing();
    });
    row = (await getComputer(deps, owner))!;
  } else {
    row = await adoptStrayRemote(deps, row);
    await assertRemoteFor(deps, owner);
  }
  if (row.agentUrl && row.agentToken) return row;
  // Made by the provisioning job, which the start queues.
  if (provisionsInBackground(machines)) return row;
  return createMachine(deps, row, by);
}

/** Whether an agent URL points at this host's loopback. */
function loopbackUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || inRanges(host, ['127.0.0.0/8', '::1']);
  } catch {
    return false;
  }
}

/**
 * A database restored from the standalone image into the compose stack (or
 * any Docker install) has `remote` computers whose agent was on the
 * standalone container's loopback (`http://127.0.0.1:7070`), which is
 * nothing here. With no OPENBOTS_COMPUTER_AGENT_URL and Docker as the
 * provider, such a row becomes a Docker computer that is made at its next
 * start, keeping its home volume's name. Any other remote row is left alone.
 */
async function adoptStrayRemote(deps: AppDeps, row: ComputerRow): Promise<ComputerRow> {
  if (row.provider !== 'remote' || deps.config.computerAgent) return row;
  if (provider(deps).name !== 'docker' || !loopbackUrl(row.agentUrl)) return row;
  const [adopted] = await deps.db
    .update(schema.computers)
    .set({
      provider: 'docker',
      containerId: null,
      agentUrl: null,
      agentToken: null,
      status: 'stopped',
      generation: nextGeneration(),
    })
    .where(and(eq(schema.computers.id, row.id), eq(schema.computers.provider, 'remote')))
    .returning();
  deps.logger.info(
    { computerId: row.id, agentUrl: row.agentUrl, volumeName: row.volumeName },
    'a remote computer on a loopback agent (a restored standalone database) becomes a Docker computer, made at this start with its volume',
  );
  return adopted ?? row;
}

/**
 * Refuses an account the remote machine when another account used it first
 * and the operator has not shared it (plan 9.2, K1). Rows from before this
 * rule keep the oldest account as the machine's.
 */
async function assertRemoteFor(deps: AppDeps, owner: Owner, db: Db = deps.db) {
  if (provider(deps).name !== 'remote' || deps.config.computerAgent?.shared) return;
  // An account in two organizations has two computers (plan 21.3): the
  // machine belongs to one of them.
  const [first] = await db
    .select({ ownerId: schema.computers.ownerId, workspaceId: schema.computers.workspaceId })
    .from(schema.computers)
    .where(eq(schema.computers.provider, 'remote'))
    .orderBy(asc(schema.computers.createdAt), asc(schema.computers.id))
    .limit(1);
  if (first && (first.ownerId !== owner.id || first.workspaceId !== owner.workspaceId)) {
    throw computerUnavailable(REMOTE_TAKEN);
  }
}

/**
 * Makes the machine behind the row, or makes it again from the configured
 * image and settings (`updating`), keeping its volumes.
 */
async function createMachine(
  deps: AppDeps,
  row: ComputerRow,
  by: AuditActor,
  status: 'creating' | 'updating' = 'creating',
  /** A provisioning job's: its writes land only while the row is still its (`jobGuard`). */
  guard?: SQL,
  /** A provisioning job's: aborted once the row is no longer its, which ends the make. */
  signal?: AbortSignal,
): Promise<ComputerRow> {
  const machines = provider(deps);
  row = await setStatus(deps, row, status, {}, null, guard);
  // Inline (Docker), this start's own generation from here: a reset meanwhile wins.
  guard ??= sameGeneration(row);
  const agentToken = randomBytes(32).toString('base64url');
  const env = sandboxEnv(deps);
  try {
    const ref = await machines.create({
      computerId: row.id,
      ownerId: row.ownerId,
      image: deps.config.sandboxImage,
      agentToken,
      volumeName: row.volumeName ?? volumeName(row.id),
      ...env,
      // Set by a full reset: the old machine is being deleted (computer-retire.ts).
      ...(row.machineKey ? { machineKey: row.machineKey } : {}),
      ...(signal ? { signal } : {}),
    });
    const created = await setStatus(
      deps,
      row,
      'stopped',
      {
        provider: ref.provider,
        containerId: ref.containerId,
        agentUrl: ref.agentUrl,
        agentToken: encryptSecret(ref.agentToken, keyring(deps)),
        volumeName: ref.volumeName,
        spec: {
          ...settledSpec(row),
          image: deps.config.sandboxImage,
          envKey: envKey(env),
          network: deps.config.sandboxNetwork.name,
        },
      },
      null,
      guard,
    );
    await auditComputer(deps, created, by, 'computer.create', {
      // As the organization's audit log shows it: the hosted service's vendor is not named.
      provider: shownProvider(ref.provider),
      ...(status === 'updating' ? { updated: true, image: deps.config.sandboxImage } : {}),
    });
    return created;
  } catch (error) {
    if (error instanceof StaleJobError) throw error;
    // Ended because the row moved on: nothing of it is this job's to write.
    if (signal?.aborted) throw computerChangedUnderJob();
    const message = failureText(deps, error);
    deps.logger.error({ err: error, computerId: row.id }, 'computer create failed');
    await setStatusIf(deps, row, 'error', {}, message, guard);
    throw computerUnavailable(`The computer could not be created: ${message}`);
  }
}

export interface Started {
  computer: ComputerRow;
  /** Set when this call had to start it. */
  durationMs: number | null;
  /** This start made the machine again from a new image or new settings first. */
  updated: boolean;
}

const starting = new Map<string, Promise<Started>>();
const startKey = (owner: Owner) => `${owner.workspaceId}:${owner.id}`;

/** Starts the owner's computer (creating it on first use) and waits for its agent. */
export function startComputer(
  deps: AppDeps,
  owner: Owner,
  by: AuditActor = { type: 'user', id: owner.id },
): Promise<Started> {
  const key = startKey(owner);
  const pending = starting.get(key);
  if (pending) return pending;
  const started = start(deps, owner, by).finally(() => starting.delete(key));
  starting.set(key, started);
  return started;
}

async function start(deps: AppDeps, owner: Owner, by: AuditActor): Promise<Started> {
  const machines = provider(deps);
  let row = await ensureComputer(deps, owner, by);
  let machine: Awaited<ReturnType<ComputerProvider['status']>>;
  try {
    machine = row.agentUrl ? await machines.status(refOf(deps, row)) : 'missing';
  } catch (error) {
    if (error instanceof DomainError) throw error;
    // The row is left as it was: nothing was asked of the machine yet.
    deps.logger.error({ err: error, computerId: row.id }, 'reading the computer status failed');
    throw computerUnavailable(`The computer did not start: ${failureText(deps, error)}`);
  }
  if (machine === 'running' && row.status === 'running') {
    return { computer: await touch(deps, row), durationMs: null, updated: false };
  }
  if (provisionsInBackground(machines)) return startInBackground(deps, row, by);
  const began = Date.now();
  // Removed behind the server's back: made again, same home volume.
  if (machine === 'missing') {
    row = await createMachine(deps, row, by).catch((error: unknown) => {
      throw error instanceof StaleJobError ? computerChanged() : error;
    });
  }
  // Made from an older image (an upgrade, plan 16.3), before the egress
  // proxy or the timezone changed, or on another sandbox network: made again,
  // same volumes. Only ever a stopped machine, so a running one moves at its
  // next stop, never mid-task.
  const updated =
    machine === 'stopped' &&
    machines.name === 'docker' &&
    (imageChanged(deps, row) ||
      envChanged(deps, row) ||
      networkChanged(deps, row) ||
      // The same tag (`latest`) on a newer build, pulled at worker start.
      (await machines.runsImage?.(refOf(deps, row), deps.config.sandboxImage)) === false);
  try {
    if (updated) row = await createMachine(deps, row, by, 'updating');
    row = await setStatus(deps, row, 'starting');
    // This start's generation: a reset meanwhile takes the row, and this start writes nothing more.
    const mine = sameGeneration(row);
    try {
      await machines.start(refOf(deps, row));
    } catch (error) {
      const message = failureText(deps, error);
      deps.logger.error({ err: error, computerId: row.id }, 'computer start failed');
      await setStatusIf(deps, row, 'error', {}, message, mine);
      throw computerUnavailable(`The computer did not start: ${message}`);
    }
    // A fresh start has no displays running yet.
    await deps.db
      .update(schema.botScreens)
      .set({ status: 'stopped' })
      .where(eq(schema.botScreens.computerId, row.id));
    row = await setStatus(
      deps,
      row,
      'running',
      { lastUsedAt: new Date(), spec: settledSpec(row) },
      null,
      mine,
    );
  } catch (error) {
    if (error instanceof StaleJobError) throw computerChanged();
    throw error;
  }
  await afterStart(deps, owner, row, by, began);
  return { computer: row, durationMs: Date.now() - began, updated };
}

/** What follows every start: the audit row, the repositories' jobs, git identity, wallpaper. */
async function afterStart(
  deps: AppDeps,
  owner: Owner,
  row: ComputerRow,
  by: AuditActor,
  began: number,
) {
  await auditComputer(deps, row, by, 'computer.start', { durationMs: Date.now() - began });
  queueRepoJobs(deps, row.id);
  // The owner's git identity in the computer's git config (git-identity.ts),
  // for commits made by hand in the terminal. Loaded here, not imported, so
  // the two modules do not import each other. A stop ends it between its
  // writes (`endStartWork`), so it never calls a stopped computer's agent,
  // which would wake a paused Sprite.
  beginStartWork(row.id, (signal) =>
    import('./git-identity.js')
      .then(({ applyGitIdentityOnComputer }) =>
        applyGitIdentityOnComputer(deps, owner, undefined, signal),
      )
      .then(
        () => undefined,
        (error: unknown) => deps.logger.warn({ err: error }, 'git identity failed'),
      ),
  );
  // The hour's wallpaper (K5) on the computer's own clock (its TZ); the agent
  // keeps it current from here.
  agentFor(deps, row)
    .setWallpaper()
    .catch((error: unknown) => deps.logger.warn({ err: error }, 'wallpaper failed'));
}

/** A `computers` job: make and provision the computer, or start it. */
export interface ProvisionJob {
  computerId: string;
  workspaceId: string;
  by: AuditActor;
  /** The row's `spec.provision.attempt` when it was queued; absent on a job from before attempts. */
  attempt?: string;
}

/**
 * Queues the provisioning job for a computer the provider makes in the
 * background, unless one is under way (the row is `creating`, `starting` or
 * `updating`), then waits up to `PROVISION_WAIT_MS` for it. A start that
 * finishes in that time answers as any start; a longer one answers
 * `COMPUTER_STARTING` and reports through `computer.status`.
 */
async function startInBackground(
  deps: AppDeps,
  row: ComputerRow,
  by: AuditActor,
): Promise<Started> {
  const began = Date.now();
  if (!BUSY.has(row.status) || row.status === 'stopping') {
    const status = row.agentUrl ? 'starting' : 'creating';
    // Two starts at once, in two processes: one claims the row and queues.
    // A stop nobody holds any more (`abandonedStop`) is taken over.
    const claimed = await claim(
      deps,
      row,
      and(
        eq(schema.computers.status, row.status),
        sameGeneration(row),
        row.status === 'stopping' ? abandonedStop() : undefined,
      ),
      status,
    );
    if (claimed) {
      await publishStatus(deps, claimed, status);
      await queueOrFail(deps, claimed, by, row.status as ComputerStatus);
    }
  } else {
    // Its job has not been heard from for long (lost with a process that
    // died, or never queued): this start queues another. Waiting for a worker
    // to restart would leave the owner pressing Start for nothing.
    await queueOrFail(deps, row, by, undefined, true);
  }
  const ready = await waitForComputer(deps, row.id, provisionTimings.waitMs);
  if (ready.status === 'running') {
    return { computer: ready, durationMs: Date.now() - began, updated: false };
  }
  if (ready.status === 'error') {
    throw computerUnavailable(
      `The computer did not start: ${specOf(ready).error ?? 'the provisioning failed'}`,
    );
  }
  throw computerStarting(ready.status);
}

/** `queueProvision` for a start: a queue that refuses answers as a computer that cannot start. */
async function queueOrFail(
  deps: AppDeps,
  row: ComputerRow,
  by: AuditActor,
  releaseTo?: ComputerStatus,
  silentOnly = false,
) {
  try {
    await queueProvision(deps, row, by, releaseTo, silentOnly);
  } catch (error) {
    deps.logger.error({ err: error, computerId: row.id }, 'queueing the provisioning failed');
    throw computerUnavailable('The computer could not be queued to start. Try again shortly.');
  }
}

/**
 * Queues the provisioning job for a row already claimed (`creating`,
 * `starting`, `updating`, or `stopping` at recovery), under a new attempt
 * written to the row first. False when another start gave the row its own
 * attempt meanwhile.
 *
 * When the queue refuses, the row goes back as it was (to `releaseTo` when
 * the caller had just claimed it), so the next start claims and queues again
 * instead of waiting on a job that does not exist. If the queue in fact took
 * the job and only its answer was lost, that job no longer carries the row's
 * attempt and does nothing, so the retry's job is the only one that
 * provisions.
 */
async function queueProvision(
  deps: AppDeps,
  row: ComputerRow,
  by: AuditActor,
  releaseTo?: ComputerStatus,
  /** Only when its job has not been heard from (`provisionSilent`). */
  silentOnly = false,
): Promise<boolean> {
  const attempt = randomUUID();
  const attemptOf = sql`${schema.computers.spec} #>> '{provision,attempt}'`;
  const [queued] = await deps.db
    .update(schema.computers)
    .set({
      spec: { ...specOf(row), provision: { attempt, at: new Date().toISOString() } },
      // A claim: any job of an earlier attempt writes nothing more, and the
      // row's busy state counts from now.
      generation: nextGeneration(),
      statusAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schema.computers.id, row.id),
        eq(schema.computers.status, row.status),
        sql`${attemptOf} is not distinct from ${specOf(row).provision?.attempt ?? null}`,
        silentOnly ? provisionSilent() : undefined,
      ),
    )
    .returning();
  if (!queued) return false;
  try {
    await deps.infra
      .queue<ProvisionJob>(COMPUTERS_QUEUE)
      .enqueue(
        'provision',
        { computerId: row.id, workspaceId: row.workspaceId, by, attempt },
        { groupKey: row.id },
      );
  } catch (error) {
    const status = releaseTo ?? (row.status as ComputerStatus);
    // Only the attempt goes back, to the one before it if there was one: the
    // job may be running after all and writing the rest of the spec.
    const before = specOf(row).provision;
    const spec = before
      ? sql`jsonb_set(${schema.computers.spec}, '{provision}', ${JSON.stringify(before)}::jsonb)`
      : sql`${schema.computers.spec} - 'provision'`;
    const [released] = await deps.db
      .update(schema.computers)
      .set({ status, spec })
      .where(and(eq(schema.computers.id, row.id), sql`${attemptOf} = ${attempt}`))
      .returning();
    if (released && status !== row.status) await publishStatus(deps, released, status);
    throw error;
  }
  return true;
}

/** Polls the row until it is `running` or `error`, or `ms` pass; the row as it then is. */
async function waitForComputer(deps: AppDeps, computerId: string, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    const [row] = await deps.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, computerId));
    if (!row) throw notFound('The computer is gone');
    if (row.status === 'running' || row.status === 'error' || Date.now() >= deadline) return row;
    await new Promise((resolve) => setTimeout(resolve, PROVISION_POLL_MS));
  }
}

/**
 * The `computers` job (Sprites): makes the machine if it has none, then
 * starts it through the provider, which provisions it again when its
 * provisioning version is not the configured one and waits for the agent.
 * A failure leaves the row `error` with the reason in `spec.error`, and the
 * next start queues the job again. A row already `running` (a job queued
 * twice, or recovered after it finished) is left alone.
 */
export async function provisionComputer(deps: AppDeps, job: ProvisionJob): Promise<void> {
  const machines = computerProvider(deps);
  const [row] = await deps.db
    .select()
    .from(schema.computers)
    .where(eq(schema.computers.id, job.computerId));
  if (!row || !machines || row.status === 'running') return;
  // Another attempt took the row's place, or this one was given up: not this job's to run.
  if (job.attempt && specOf(row).provision?.attempt !== job.attempt) return;
  const began = Date.now();
  const owner = { id: row.ownerId, workspaceId: row.workspaceId };
  // Every write of this job lands only while the row is still its own: the
  // same attempt and the same machine key. A reset that moved the
  // row on meanwhile is never overwritten by what this job read before.
  const guard = jobGuard(row);
  // Its heartbeat: `status_at` says the job runs (a start or the sweep queues
  // another only once it falls silent), and a beat that finds the row no
  // longer this job's ends it, its provider call too, so a reset that
  // cancelled it does not leave it running for long.
  const lost = new AbortController();
  const attempt = sql`${schema.computers.spec} #>> '{provision,attempt}'`;
  const beat = async () => {
    const [still] = await deps.db
      .update(schema.computers)
      .set({ statusAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(schema.computers.id, row!.id),
          guard,
          job.attempt ? sql`${attempt} = ${job.attempt}` : undefined,
        ),
      )
      .returning({ id: schema.computers.id });
    if (!still) lost.abort(computerChangedUnderJob());
  };
  await beat();
  const timer = setInterval(() => {
    beat().catch((error: unknown) =>
      deps.logger.warn(
        { err: error, computerId: job.computerId },
        'a provisioning heartbeat failed',
      ),
    );
  }, provisionTimings.heartbeatMs);
  timer.unref?.();
  try {
    await provisionWith(deps, machines, job, row, guard, lost.signal, timer, owner, began);
  } finally {
    clearInterval(timer);
  }
}

/** `provisionComputer`'s work, with its heartbeat running (`signal` ends it). */
async function provisionWith(
  deps: AppDeps,
  machines: ComputerProvider,
  job: ProvisionJob,
  row: ComputerRow,
  guard: SQL,
  signal: AbortSignal,
  timer: ReturnType<typeof setInterval>,
  owner: Owner,
  began: number,
): Promise<void> {
  try {
    if (signal.aborted) throw computerChangedUnderJob();
    const machine = row.agentUrl ? await machines.status(refOf(deps, row)) : 'missing';
    if (signal.aborted) throw computerChangedUnderJob();
    if (machine === 'missing') {
      row = await createMachine(deps, row, job.by, 'creating', guard, signal);
    }
    row = await setStatus(deps, row, 'starting', {}, null, guard);
    if (signal.aborted) throw computerChangedUnderJob();
    await machines.start(refOf(deps, row), { signal });
  } catch (error) {
    if (error instanceof StaleJobError || signal.aborted) {
      deps.logger.info({ computerId: row.id }, 'the computer moved on while its provisioning ran');
      return;
    }
    const message = failureText(deps, error);
    deps.logger.error({ err: error, computerId: row.id }, 'computer provisioning failed');
    const { provision: _, ...spec } = specOf(row);
    await setStatusIf(deps, row, 'error', { spec: { ...spec, error: message } }, message, guard);
    return;
  }
  const { error: _, provision: __, ...spec } = settledSpec(row);
  // And on the machine it started, which nothing took away meanwhile.
  const started = await setStatusIf(
    deps,
    row,
    'running',
    {
      lastUsedAt: new Date(),
      spec: { ...spec, ...(machines.version ? { provisionVersion: machines.version } : {}) },
    },
    null,
    and(guard, eq(schema.computers.containerId, row.containerId!)),
  );
  if (!started) {
    deps.logger.info({ computerId: row.id }, 'the computer moved on while its provisioning ran');
    return;
  }
  clearInterval(timer);
  row = started;
  // The agent may have been installed again, so no display runs.
  await deps.db
    .update(schema.botScreens)
    .set({ status: 'stopped' })
    .where(eq(schema.botScreens.computerId, row.id));
  await afterStart(deps, owner, row, job.by, began);
}

/**
 * What a provisioning job's writes require of the row: the generation it
 * read and its machine key. Every reset, stop, start and claim moves the
 * generation on (a soft reset and a delete of the old machine too, which keep
 * the key), so nothing that moved the row on meanwhile is overwritten. A
 * queue whose answer was lost gives the attempt back (`queueProvision`)
 * without moving the generation, so that job's work still stands.
 */
function jobGuard(row: ComputerRow): SQL {
  return and(
    sameGeneration(row),
    row.machineKey === null
      ? isNull(schema.computers.machineKey)
      : eq(schema.computers.machineKey, row.machineKey),
  )!;
}

/** The `computers` queue's handler. */
export function provisionHandler(deps: AppDeps): JobHandler<ProvisionJob> {
  return (job) => provisionComputer(deps, job.data);
}

/**
 * At worker start (in every organization's scope): queues the provisioning
 * job again for each computer a job was making or starting, since an
 * in-process queue lost it and a crashed worker may have, and for each one a
 * stop cut short left `stopping`. A job that is in
 * fact still queued finds the row `running` when it ends and does nothing.
 */
export async function recoverProvisioning(deps: AppDeps): Promise<number> {
  const machines = computerProvider(deps);
  if (!machines || !provisionsInBackground(machines)) return 0;
  const rows = await deps.db
    .select()
    .from(schema.computers)
    .where(
      and(
        eq(schema.computers.provider, machines.name),
        // `stopping` too: a start waits on it (BUSY) and, unlike a Docker
        // computer's, never takes it over, while the idle sweep skips Sprites,
        // so a stop cut short would leave the computer unusable for good.
        // A stop still held is left alone.
        or(inArray(schema.computers.status, PROVISIONING), abandonedStop()),
      ),
    );
  for (const row of rows) await queueProvision(deps, row, SYSTEM_ACTOR);
  return rows.length;
}

/**
 * After a start (GH4, GH6): remembered repositories a new home volume lost
 * are cloned again, then clones made by hand are listed. Queued, never
 * waited on; a failure to queue does not fail the start.
 */
function queueRepoJobs(deps: AppDeps, computerId: string) {
  enqueueCoderJob(deps, { kind: 'reconcile', computerId })
    .then(() => enqueueCoderJob(deps, { kind: 'scan', computerId }))
    .catch((error: unknown) =>
      deps.logger.warn({ err: error, computerId }, 'queueing repository jobs failed'),
    );
}

/** What `wakeComputer` did. */
export type Wake =
  /** No computer provider: nothing to start. */
  | 'unavailable'
  /** No computer yet, and this wake does not create one. */
  | 'none'
  /** Already running (marked used when asked). */
  | 'running'
  /** A start, an update or a stop is under way: left to finish. */
  | 'busy'
  /** A start began in the background. */
  | 'starting';

export interface WakeOptions {
  /** Creates the computer on first use (the Mac app's launch); a message never does. */
  create?: boolean;
  /** Marks a running computer used: a message is activity, the app's launch is not. */
  touch?: boolean;
  by?: AuditActor;
}

/** Statuses a wake leaves alone. */
const BUSY = new Set<string>(['creating', 'updating', 'starting', 'stopping']);
/** Statuses of a start or an update under way, which a reset cancels. */
const PROVISIONING = ['creating', 'starting', 'updating'];
/**
 * How long a computer may read `stopping` with no heartbeat from whoever
 * holds it before a reset or a start takes it over and the sweep finishes
 * the stop (computer-timing.ts). The longest a member's reset is refused as
 * busy (409 `COMPUTER_BUSY`) after a process died.
 */
export { STOPPING_TAKEOVER_MS };

/** The database's clock, or `at` where a caller (a test, a sweep) names the time. */
const clockOf = (at?: Date) => (at ? sql`${at.toISOString()}::timestamptz` : sql`now()`);

/**
 * A `stopping` row that nobody holds: its holder's heartbeat (`status_at`,
 * the database's clock) is older than `STOPPING_TAKEOVER_MS`.
 */
function abandonedStop(at?: Date): SQL {
  return and(
    eq(schema.computers.status, 'stopping'),
    sql`${schema.computers.statusAt} < ${clockOf(at)} - ${STOPPING_TAKEOVER_MS} * interval '1 millisecond'`,
  )!;
}

/** The row has had no word from its provisioning job for `provisionTimings.staleMs`. */
function provisionSilent(at?: Date): SQL {
  return sql`${schema.computers.statusAt} < ${clockOf(at)} - ${provisionTimings.staleMs} * interval '1 millisecond'`;
}

/**
 * Refreshes the `stopping` claim `row` holds (its generation): true while it
 * is still this holder's, which keeps any start, reset or sweep from taking
 * it over (`abandonedStop`).
 */
async function stillStopping(deps: AppDeps, row: ComputerRow): Promise<boolean> {
  const [held] = await deps.db
    .update(schema.computers)
    .set({ statusAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(schema.computers.id, row.id),
        eq(schema.computers.status, 'stopping'),
        sameGeneration(row),
      ),
    )
    .returning({ id: schema.computers.id });
  return held !== undefined;
}

/**
 * How a `stopping` holder refreshes its claim (computer-timing.ts); tests
 * set them short.
 */
export const stopTimings = {
  heartbeatMs: STOPPING_HEARTBEAT_MS,
  giveUpMs: STOPPING_GIVE_UP_MS,
  /** The clock refreshes are timed by; a test steps its own. */
  now: (): number => Date.now(),
  /** Arms the give-up `ms` from now; returns what disarms it. A test records it instead. */
  setTimer: (fn: () => void, ms: number): (() => void) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * The give-up of a `stopping` holder: `giveUpMs` from when the last refresh
 * that landed was sent (`heard(sentAt)`), never moved back by an older one
 * landing late. The database wrote `status_at` after the refresh was sent, so
 * the takeover cannot come sooner than that plus `STOPPING_TAKEOVER_MS`,
 * however long the answer took. Returns the deadline now armed, in the
 * clock's time; `stop` disarms it.
 */
export function stopGiveUp(onGiveUp: () => void) {
  const { giveUpMs, now, setTimer } = stopTimings;
  let deadline = 0;
  let disarm: (() => void) | undefined;
  return {
    heard(sentAt: number): number {
      if (sentAt + giveUpMs <= deadline) return deadline;
      deadline = sentAt + giveUpMs;
      disarm?.();
      disarm = setTimer(onGiveUp, Math.max(0, deadline - now()));
      return deadline;
    },
    stop() {
      disarm?.();
    },
  };
}

/**
 * Runs `fn` while holding the `stopping` claim on `row`: every
 * `STOPPING_HEARTBEAT_MS` the claim is refreshed (`stillStopping`). Should a
 * refresh find it taken (this process stalled past `STOPPING_TAKEOVER_MS`),
 * or no refresh land for `STOPPING_GIVE_UP_MS` (the database out of reach,
 * so the claim may be taken soon without this process hearing of it),
 * `fn`'s signal is aborted, which ends the provider's call where it can.
 */
async function holdingStop<T>(
  deps: AppDeps,
  row: ComputerRow,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const lost = new AbortController();
  // The give-up counts from when the last refresh that landed was sent, not
  // from when its answer came (`stopGiveUp`).
  const giveUp = stopGiveUp(() =>
    lost.abort(new Error('The computer could not be held: its claim was not refreshed')),
  );
  const refresh = async () => {
    const sentAt = stopTimings.now();
    if (!(await stillStopping(deps, row))) {
      lost.abort(new Error('The computer was taken over meanwhile'));
      return;
    }
    if (!lost.signal.aborted) giveUp.heard(sentAt);
  };
  // Once before the call: the claim is this stop's now, and the give-up
  // counts from now rather than from whenever the caller wrote it.
  await refresh();
  if (lost.signal.aborted) throw lost.signal.reason as Error;
  const timer = setInterval(() => {
    refresh().catch((error: unknown) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'refreshing a stop failed'),
    );
  }, stopTimings.heartbeatMs);
  timer.unref?.();
  try {
    return await fn(lost.signal);
  } finally {
    clearInterval(timer);
    giveUp.stop();
  }
}

/**
 * Starts the owner's computer in the background when it is off (plan 9.5):
 * the Mac app's launch on This Mac, and an owner's message to their Bots. It
 * returns once the start began, without waiting for it: a failed start is
 * logged and leaves the computer `error`, as any start does. One start runs per
 * computer at a time, and a computer already starting, updating or stopping
 * is left alone. It never changes the idle settings, so the idle sweep stops
 * the computer again once it goes unused.
 */
export async function wakeComputer(
  deps: AppDeps,
  owner: Owner,
  { create = false, touch: used = false, by = { type: 'user', id: owner.id } }: WakeOptions = {},
): Promise<Wake> {
  if (!computerAvailable(deps)) return 'unavailable';
  if (starting.has(startKey(owner))) return 'busy';
  const row = await getComputer(deps, owner);
  if (!row && !create) return 'none';
  if (row?.status === 'running') {
    if (used) await touchComputer(deps, row.id);
    return 'running';
  }
  if (row && BUSY.has(row.status)) return 'busy';
  startComputer(deps, owner, by).catch((error: unknown) =>
    deps.logger.warn(
      { err: error, ownerId: owner.id, workspaceId: owner.workspaceId },
      'computer wake failed',
    ),
  );
  return 'starting';
}

/**
 * The owner's computer when it is running, never starting it: the file
 * browser, the terminal and Preview use this, so a stale tab does not boot the
 * sandbox. Throws `COMPUTER_OFF` (409) otherwise.
 */
export async function runningComputer(deps: AppDeps, owner: Owner): Promise<ComputerRow> {
  provider(deps);
  const row = await getComputer(deps, owner);
  if (row?.status !== 'running') throw computerOff();
  await assertRemoteFor(deps, owner);
  return touch(deps, row);
}

async function touch(deps: AppDeps, row: ComputerRow) {
  const [updated] = await deps.db
    .update(schema.computers)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.computers.id, row.id))
    .returning();
  return updated ?? row;
}

/**
 * Marks the computer used now, so the idle sweep leaves it running: the
 * terminal and screen sockets call it while their frames flow (plan 9.5).
 */
export async function touchComputer(deps: Pick<AppDeps, 'db'>, computerId: string) {
  await deps.db
    .update(schema.computers)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(schema.computers.id, computerId), eq(schema.computers.status, 'running')));
}

/**
 * Begins a use of the computer (computer-use.ts): marks it used every
 * minute, holds it awake on a provider that pauses itself, and records the
 * usage interval. End it when the work ends, fails or is cancelled.
 */
export function beginComputerUse(
  deps: AppDeps,
  row: ComputerRow,
  reason: UseReason,
  options: UseOptions = {},
): ComputerUse {
  const machines = computerProvider(deps);
  let hold: Parameters<typeof beginUse>[1]['hold'];
  if (machines?.hold && machines.name === row.provider && row.agentUrl && row.agentToken) {
    // The machine the use began on, until a reset takes it off the computer
    // (its token is fenced then: the old machine is never held or woken
    // again, since it is being deleted) or the provider refuses it. Then the
    // hold moves to the machine the row has now, if any, and the use goes on
    // with that one. No read in the usual case, so the hold is in place
    // before the work's first call.
    let from: ComputerRow = row;
    let known = refOf(deps, row);
    const current = () =>
      inWorkspace(row.workspaceId, async () => {
        const [now] = await deps.db
          .select()
          .from(schema.computers)
          .where(eq(schema.computers.id, row.id));
        return now?.agentUrl && now.agentToken && now.provider === machines.name ? now : null;
      });
    const move = (now: ComputerRow) => {
      from = now;
      known = refOf(deps, now);
    };
    hold = {
      hold: async (name, seconds) => {
        if (isFenced(from)) {
          const now = await current();
          if (!now) throw computerUnavailable('The computer was reset. Try again.');
          move(now);
        }
        try {
          await machines.hold!(known, name, seconds);
        } catch (error) {
          const now = await current();
          if (!now || now.containerId === known.containerId) throw error;
          move(now);
          await machines.hold!(known, name, seconds);
        }
      },
      release: async (name) => {
        if (!isFenced(from)) await machines.release?.(known, name);
      },
    };
  }
  return beginUse(
    deps,
    {
      workspaceId: row.workspaceId,
      ownerId: row.ownerId,
      computerId: row.id,
      provider: row.provider,
      touch: () => touchComputer(deps, row.id),
      ...(hold ? { hold } : {}),
    },
    reason,
    options,
  );
}

/** A use that begins with the first computer call of some work and ends with the work. */
export interface ComputerUseScope {
  /** Begins the use on the first call; later calls do nothing. */
  begin(row: ComputerRow): void;
  end(): Promise<void>;
}

export function computerUseScope(deps: AppDeps, reason: UseReason): ComputerUseScope {
  let use: ComputerUse | null = null;
  let ended = false;
  return {
    begin(row) {
      if (!ended) use ??= beginComputerUse(deps, row, reason);
    },
    async end() {
      ended = true;
      const current = use;
      use = null;
      await current?.end();
    },
  };
}

/**
 * At worker start, after an upgrade: pulls the sandbox image again when it is
 * already present, so a tag that moves with releases (`latest`, `1.2`) brings
 * the new computer image. `docker compose pull` does not pull it, since no
 * compose service runs it. Each computer moves to it at its next start.
 */
export async function refreshSandboxImage(deps: AppDeps): Promise<void> {
  const machines = computerProvider(deps);
  if (!machines?.refreshImage) return;
  try {
    await machines.refreshImage(deps.config.sandboxImage);
  } catch (error) {
    deps.logger.warn(
      { err: error, image: deps.config.sandboxImage },
      'sandbox image refresh failed',
    );
  }
}

/** What the owner can set on their computer (plan 4.5, 9.5). */
export interface ComputerSettings {
  /** Never stopped for idleness. */
  alwaysOn?: boolean;
  /** Minutes unused before the idle sweep stops it, within `IDLE_TIMEOUT_RANGE_MIN`. */
  idleTimeoutMin?: number;
}

/** Saves the owner's settings on their computer; the next sweep applies them. */
export async function updateComputerSettings(
  deps: AppDeps,
  row: ComputerRow,
  settings: ComputerSettings,
): Promise<ComputerRow> {
  const [updated] = await deps.db
    .update(schema.computers)
    .set({
      ...(settings.alwaysOn !== undefined ? { alwaysOn: settings.alwaysOn } : {}),
      ...(settings.idleTimeoutMin !== undefined ? { idleTimeoutMin: settings.idleTimeoutMin } : {}),
    })
    .where(eq(schema.computers.id, row.id))
    .returning();
  return updated ?? row;
}

export async function stopComputer(
  deps: AppDeps,
  row: ComputerRow,
  by: AuditActor = { type: 'user', id: row.ownerId },
): Promise<ComputerRow> {
  // A claim of its own: a start or a job meanwhile writes nothing over it.
  // Only of the row as read (its status and generation): a reset, a start or
  // another stop that took it since keeps it, and a stop still held is
  // never taken over (`abandonedStop`).
  // A claim lost to a row that moved on to something a stop stops (a start
  // that finished first: `running`, or `error`) is tried again on the row as
  // it now is, a bounded number of times; a stop never answers as done while
  // the computer runs.
  let read = row;
  for (let attempt = 0; ; attempt++) {
    if (!read.agentUrl || read.status === 'stopped') return read;
    const [claimed] = await deps.db
      .update(schema.computers)
      .set({ status: 'stopping', statusAt: sql`clock_timestamp()`, generation: nextGeneration() })
      .where(
        and(
          eq(schema.computers.id, read.id),
          eq(schema.computers.status, read.status),
          sameGeneration(read),
          read.status === 'stopping' ? abandonedStop() : undefined,
        ),
      )
      .returning();
    if (claimed) {
      endStartWork(read.id);
      await publishStatus(deps, claimed, 'stopping');
      return stopMachine(deps, claimed, by);
    }
    const [now] = await deps.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, read.id));
    // Gone, stopped, or held by another stop or a reset: left as it is.
    if (!now || now.status === 'stopping' || !now.agentUrl || now.status === 'stopped') {
      return now ?? read;
    }
    if (attempt >= STOP_CLAIM_ATTEMPTS - 1) {
      throw new DomainError(
        503,
        'COMPUTER_UNAVAILABLE',
        'The computer changed while it was being stopped and is still on. Try again.',
      );
    }
    read = now;
  }
}

/** How many times a stop claims the computer when a start or a job keeps moving it on. */
const STOP_CLAIM_ATTEMPTS = 3;

/**
 * Stops the owner's computer if it is up, then starts it again; its files
 * and sign-ins are kept. A stopped computer just starts.
 */
export async function restartComputer(
  deps: AppDeps,
  owner: Owner,
  row: ComputerRow,
  by: AuditActor = { type: 'user', id: owner.id },
): Promise<Started> {
  await stopComputer(deps, row, by);
  return startComputer(deps, owner, by);
}

/** Options of `destroyComputer`. */
export interface DestroyComputerOptions {
  /** Removes the state volume too: the cookie store and the coding agents' sign-ins. */
  signIns: boolean;
  /**
   * The member's reset: where the old machine is deleted after the reset
   * (computer-retire.ts), its cleanup and audit go in the transaction that
   * takes the machine off the computer.
   */
  reset?: ResetRecord;
}

/** What `resetMachine` did: the row as it now is, and the record of an old machine to delete. */
export interface MachineReset {
  computer: ComputerRow;
  /** Set when the old machine is deleted through a record (computer-retire.ts). */
  retired: RetiredRow | null;
}

/**
 * The machine part of a reset (GH5; services/computer-reset.ts asks first).
 * The row is claimed for the reset with one conditional UPDATE that moves it
 * to its next generation: a start or an update under way (`creating`,
 * `starting`, `updating`) is cancelled, since every write of its job needs
 * the generation it read, and a stop older than `STOPPING_TAKEOVER_MS` is
 * taken over; a fresher stop is refused (409 `COMPUTER_BUSY`), so no member
 * waits longer than that to reset. Then the computer is stopped if it is up
 * (its stdio connectors and coding sessions end with it) and its machine is
 * taken away: with `signIns`, on a provider that names machines by key
 * (Sprites), the row gets a new key and the old machine is deleted through a
 * record that the retired-computers job retries (computer-retire.ts);
 * otherwise the provider removes the container and its home volume, and the
 * state volume only with `signIns`. The row stays, `stopped`, with no
 * machine, so the next start makes a fresh one; where the provider keeps the
 * machine and clears its home in place (a Sprite reset without its sign-ins),
 * the row goes on naming it (`containerId`), with no agent, so the next start
 * provisions that machine again and a later full reset deletes it. A row never
 * forgets a machine that still exists. Docker and Sprites only: the remote
 * machine is not the server's to remove (409 `RESET_UNSUPPORTED`). A stop that
 * fails does not stop the reset, since removing the machine stops it anyway.
 * Once the old machine is gone or taken off the computer, every process
 * fences its agent token (computer-fence.ts). Every branch is keyed on
 * `containerId`, the machine's existence, so a machine with no agent yet is
 * never left behind unrecorded.
 */
export async function resetMachine(
  deps: AppDeps,
  row: ComputerRow,
  options: DestroyComputerOptions,
  by: AuditActor = { type: 'user', id: row.ownerId },
): Promise<MachineReset> {
  const machines = provider(deps);
  assertResettable(deps);
  const [claimed] = await deps.db
    .update(schema.computers)
    .set({
      status: 'stopping',
      statusAt: sql`clock_timestamp()`,
      generation: nextGeneration(),
      spec: sql`${schema.computers.spec} - 'provision'`,
    })
    .where(
      and(
        eq(schema.computers.id, row.id),
        row.containerId === null
          ? isNull(schema.computers.containerId)
          : eq(schema.computers.containerId, row.containerId),
        or(
          notInArray(schema.computers.status, [...BUSY]),
          inArray(schema.computers.status, PROVISIONING),
          abandonedStop(),
        ),
      ),
    )
    .returning();
  if (!claimed) {
    const [now] = await deps.db
      .select({ status: schema.computers.status })
      .from(schema.computers)
      .where(eq(schema.computers.id, row.id));
    throw now && BUSY.has(now.status) ? computerBusy(now.status) : computerChanged();
  }
  endStartWork(row.id);
  await publishStatus(deps, claimed, 'stopping');
  // The reset holds this claim (`stopping`, this generation) to its end: the
  // stop below keeps it, and the destructive step runs while it is held, so
  // no start begins in between (`holdingStop`).
  const current = claimed;
  // `stopMachine` ends the coding sessions; with nothing to stop, they end here.
  if (claimed.agentUrl && claimed.agentToken && row.status !== 'stopped') {
    await stopMachine(deps, claimed, by, {}, { keepClaim: true }).catch((error: unknown) =>
      // Removing the machine stops it anyway.
      deps.logger.warn({ err: error, computerId: row.id }, 'stop before reset failed'),
    );
  } else {
    await bestEffort(
      deps.infra.bus.publish<CoderControl>(CODER_CONTROL_CHANNEL, {
        type: 'stop_all',
        computerId: row.id,
      }),
      (error) =>
        deps.logger.warn({ err: error, computerId: row.id }, 'stopping coding sessions failed'),
    );
  }
  // A full reset on a provider that names machines by key: the row gets a
  // new key, so its next start makes a new machine, and the old one is
  // deleted through its record, retried until it is gone (computer-retire.ts).
  if (
    options.signIns &&
    machines.machineKeyed === true &&
    current.containerId &&
    current.provider === machines.name
  ) {
    return retireMachine(deps, machines, current, {
      by,
      ...(options.reset ? { reset: options.reset } : {}),
    });
  }
  const mine = and(sameGeneration(claimed), eq(schema.computers.status, 'stopping'));
  if (current.containerId) {
    // Still this reset's, refreshed just before anything is destroyed: a
    // reset that lost the computer destroys nothing.
    if (!(await stillStopping(deps, claimed))) throw computerChanged();
    try {
      await holdingStop(deps, claimed, (signal) =>
        machines.destroy(machineRefOf(current), {
          computerId: row.id,
          home: true,
          state: options.signIns,
          signal,
        }),
      );
    } catch (error) {
      const message = failureText(deps, error);
      deps.logger.error({ err: error, computerId: row.id }, 'computer reset failed');
      await setStatusIf(deps, current, 'error', {}, message, mine);
      throw computerUnavailable(`The computer could not be reset: ${message}`);
    }
  }
  // A machine the provider kept (a Sprite whose home was cleared in place)
  // is still named on the row: it holds the state directory, the sign-ins
  // with it, so a later full reset finds it and deletes it.
  const kept = !options.signIns && machines.keepsMachineOnHomeReset === true;
  const reset = await setStatusIf(
    deps,
    current,
    'stopped',
    {
      containerId: kept ? current.containerId : null,
      agentUrl: null,
      agentToken: null,
      volumeName: current.volumeName ?? volumeName(row.id),
    },
    null,
    mine,
  );
  if (!reset) {
    // Only where this process stalled past the takeover while the provider
    // worked: its machine was (at least in part) cleared or removed though
    // the row moved on. Said, not hidden: the reset's cleanup and audit
    // follow (computer-reset.ts), and no fence, since whoever took the row
    // over may be using that machine's token now.
    deps.logger.error(
      { computerId: row.id },
      'a reset lost the computer while its machine was being reset',
    );
    const [now] = await deps.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, row.id));
    return { computer: now ?? current, retired: null };
  }
  // Out of service by a write that landed: its token is refused everywhere.
  await fenceComputer(deps, current);
  return { computer: reset, retired: null };
}

/** `resetMachine`, for the row alone. */
export async function destroyComputer(
  deps: AppDeps,
  row: ComputerRow,
  options: DestroyComputerOptions,
  by: AuditActor = { type: 'user', id: row.ownerId },
): Promise<ComputerRow> {
  return (await resetMachine(deps, row, options, by)).computer;
}

/**
 * Before a reset that keeps the machine (a Sprite reset without its sign-ins
 * clears the home in place), a checkpoint of its whole disk, so an operator
 * can undo a mistaken reset (`restore`). Returns its id, or null when the
 * provider takes none or the machine goes with the reset (a full reset,
 * whose machine is deleted with its checkpoints). A checkpoint that fails
 * does not stop the reset: a computer that will not work is when a reset
 * helps most.
 */
export async function checkpointBeforeReset(
  deps: AppDeps,
  row: ComputerRow,
  options: DestroyComputerOptions,
): Promise<string | null> {
  const machines = provider(deps);
  if (!machines.checkpoint) return null;
  if (options.signIns) return null;
  if (machines.name !== row.provider || !row.containerId) return null;
  try {
    return await machines.checkpoint(
      machineRefOf(row),
      `OpenBots: before a reset, ${new Date().toISOString()}`,
    );
  } catch (error) {
    deps.logger.warn({ err: error, computerId: row.id }, 'the checkpoint before a reset failed');
    return null;
  }
}

/**
 * Refuses a reset where the server cannot remove the machine (the remote
 * provider). A Sprite is reset by the provider's `destroy`: deleted with the
 * sign-ins, or its home cleared in place without them, then made or
 * provisioned again at the next start.
 */
export function assertResettable(deps: AppDeps) {
  if (provider(deps).name === 'remote') {
    throw new DomainError(
      409,
      'RESET_UNSUPPORTED',
      'This computer runs elsewhere, so it cannot be reset from here',
    );
  }
}

/**
 * Stops the machine of a row already set `stopping`. On failure the row is
 * `error`, with `failed` merged in (the idle sweep's retry), and it throws.
 */
async function stopMachine(
  deps: AppDeps,
  row: ComputerRow,
  by: AuditActor,
  failed: Partial<ComputerRow> = {},
  /** A reset's: the row stays `stopping`, its claim, for what the reset does next. */
  { keepClaim = false }: { keepClaim?: boolean } = {},
): Promise<ComputerRow> {
  endStartWork(row.id);
  // Its owner's stdio connectors running in it end first, in every process.
  await bestEffort(
    deps.infra.bus.publish<McpControl>(MCP_CONTROL_CHANNEL, {
      type: 'computer',
      ownerId: row.ownerId,
      workspaceId: row.workspaceId,
    }),
    (error) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'stopping stdio connectors failed'),
  );
  // And its coding sessions, wherever their jobs run (I12).
  await bestEffort(
    deps.infra.bus.publish<CoderControl>(CODER_CONTROL_CHANNEL, {
      type: 'stop_all',
      computerId: row.id,
    }),
    (error) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'stopping coding sessions failed'),
  );
  // Its writes stand only while the row is still this stop's (a reset or a
  // start that took it over meanwhile wins).
  const mine = sameGeneration(row);
  try {
    // Its signal ends the provider's stop once this stop no longer holds the
    // computer: a hold released after a takeover could be a new use's.
    await holdingStop(deps, row, (signal) => provider(deps).stop(machineRefOf(row), { signal }));
  } catch (error) {
    const message = failureText(deps, error);
    deps.logger.error({ err: error, computerId: row.id }, 'computer stop failed');
    if (!keepClaim) await setStatusIf(deps, row, 'error', failed, message, mine);
    throw computerUnavailable(`The computer did not stop: ${message}`);
  }
  await deps.db
    .update(schema.botScreens)
    .set({ status: 'stopped' })
    .where(eq(schema.botScreens.computerId, row.id));
  // A stopped screen has nothing to hold: a takeover ends with it.
  await releaseScreens(
    deps,
    by,
    and(eq(schema.botScreens.computerId, row.id), isNotNull(schema.botScreens.controlledByUserId))!,
  );
  if (keepClaim) return row;
  const stopped = await setStatusIf(deps, row, 'stopped', { spec: settledSpec(row) }, null, mine);
  if (!stopped) return row;
  await auditComputer(deps, stopped, by, 'computer.stop', {});
  return stopped;
}

/**
 * Hands back every screen matching `where` that someone holds, as a hand
 * back would (audited, `screen.control` published), so the Bots' waiting
 * screen actions go on. For a stop, a disabled member, or a takeover whose
 * tab went away. Returns the screens it released.
 */
export async function releaseScreens(
  deps: AppDeps,
  by: AuditActor,
  where: SQL,
): Promise<ScreenRow[]> {
  const released = await deps.db
    .update(schema.botScreens)
    .set({ controlledByUserId: null, controlledSince: null })
    .where(and(where, isNotNull(schema.botScreens.controlledByUserId)))
    .returning();
  for (const screen of released) {
    await recordAudit(deps.db, {
      workspaceId: screen.workspaceId,
      actor: by,
      action: 'computer.release',
      targetType: 'bot',
      targetId: screen.botId,
      metadata: { screenId: screen.id, display: screen.displayNumber },
    });
    await publishControl(deps, screen, null);
  }
  return released;
}

function publishControl(deps: AppDeps, screen: ScreenRow, userId: string | null) {
  return publishEvent(
    deps.infra.bus,
    wsEvent(
      'screen.control',
      {
        screenId: screen.id,
        controller: userId ? 'user' : 'bot',
        userId,
        botId: screen.botId,
        display: screen.displayNumber,
      },
      { bot_id: screen.botId },
    ),
  );
}

function auditComputer(
  deps: AppDeps,
  row: ComputerRow,
  by: AuditActor,
  action: 'computer.create' | 'computer.start' | 'computer.stop',
  metadata: Record<string, unknown>,
) {
  return recordAudit(deps.db, {
    workspaceId: row.workspaceId,
    actor: by,
    action,
    targetType: 'computer',
    targetId: row.id,
    metadata,
  });
}

/**
 * Stops computers idle past their `idle_timeout_min` (plan 9.5); returns how
 * many. An idle stop that fails leaves the computer `error` and is retried on
 * a later sweep, after one sweep and then twice as long each time, up to
 * `IDLE_STOP_RETRY_MAX_MS`; starting the computer again drops the retry.
 * Sprites are left alone (`idleSettingsApply`): they pause themselves, and
 * marking one stopped would only end its coding sessions and stdio
 * connectors. One whose provisioning is out of date is updated instead, once
 * unused for the default idle time (`queueSpriteUpdates`).
 */
export async function sweepIdleComputers(deps: AppDeps, at?: Date): Promise<number> {
  if (!computerAvailable(deps)) return 0;
  await recoverStaleComputers(deps, at);
  const now = at ?? new Date();
  await queueSpriteUpdates(deps, now);
  const candidates = await deps.db
    .select()
    .from(schema.computers)
    .where(
      and(
        inArray(schema.computers.status, ['running', 'error']),
        eq(schema.computers.alwaysOn, false),
        ne(schema.computers.provider, 'sprites'),
      ),
    );
  let stopped = 0;
  for (const row of candidates) {
    // An `error` row is retried only when an idle stop failed and its retry is due.
    const retry = specOf(row).idleStopRetry;
    const stopping =
      row.status === 'running'
        ? await claimIdle(deps, row, now)
        : retry && Date.parse(retry.retryAt) <= now.getTime()
          ? await claim(deps, row, eq(schema.computers.status, 'error'))
          : null;
    if (!stopping) continue;
    const failures = row.status === 'error' ? (retry?.failures ?? 0) + 1 : 1;
    const retryAt = new Date(now.getTime() + idleStopRetryDelayMs(failures)).toISOString();
    try {
      await publishStatus(deps, stopping, 'stopping');
      await stopMachine(deps, stopping, SYSTEM_ACTOR, {
        spec: { ...specOf(stopping), idleStopRetry: { failures, retryAt } },
      });
      stopped++;
    } catch (error) {
      deps.logger.warn({ err: error, computerId: row.id, failures, retryAt }, 'idle stop failed');
    }
  }
  return stopped;
}

/**
 * Every sweep (`IDLE_SWEEP_MS`, in every worker and organization): a busy
 * status a process left when it died is recovered, by its age in the
 * database (`status_at`), never by what one process remembers. A `stopping`
 * older than `STOPPING_TAKEOVER_MS` has its stop finished (or, with no
 * machine left to stop, reads `stopped`); a `creating`, `starting` or
 * `updating` older than any provisioning (`provisionTimings.staleMs`) gets its
 * job queued again under a new attempt where a job makes it (Sprites), or
 * reads `error` where the start ran in a request (Docker), so the next start
 * begins afresh. Each recovery is one conditional UPDATE on the row's
 * generation, so of several workers one recovers it, and the process that
 * left it, if it was only slow, writes nothing more. Returns how many it
 * recovered.
 */
export async function recoverStaleComputers(deps: AppDeps, now?: Date): Promise<number> {
  const machines = computerProvider(deps);
  if (!machines) return 0;
  const rows = await deps.db
    .select()
    .from(schema.computers)
    .where(
      or(
        abandonedStop(now),
        and(inArray(schema.computers.status, PROVISIONING), provisionSilent(now)),
      ),
    );
  let recovered = 0;
  for (const row of rows) {
    // Still as read, and still abandoned by the database's clock when claimed.
    const still = and(
      eq(schema.computers.status, row.status),
      sameGeneration(row),
      row.status === 'stopping' ? abandonedStop(now) : provisionSilent(now),
    );
    try {
      if (row.status === 'stopping') {
        if (row.containerId && row.agentUrl && row.provider === machines.name) {
          const claimed = await claim(deps, row, still);
          if (!claimed) continue;
          recovered++;
          deps.logger.warn({ computerId: row.id }, 'a stop was cut short; it is finished now');
          await stopMachine(deps, claimed, SYSTEM_ACTOR).catch((error: unknown) =>
            deps.logger.warn({ err: error, computerId: row.id }, 'finishing a stop failed'),
          );
        } else {
          const claimed = await claim(deps, row, still, 'stopped');
          if (!claimed) continue;
          recovered++;
          await publishStatus(deps, claimed, 'stopped');
        }
      } else if (provisionsInBackground(machines) && row.provider === machines.name) {
        if (await queueProvision(deps, row, SYSTEM_ACTOR)) {
          recovered++;
          deps.logger.warn(
            { computerId: row.id },
            'a provisioning job was lost; it is queued again',
          );
        }
      } else {
        const failed = await claim(deps, row, still, 'error');
        if (!failed) continue;
        recovered++;
        await publishStatus(
          deps,
          failed,
          'error',
          'The computer did not finish starting. Start it again.',
        );
      }
    } catch (error) {
      deps.logger.warn({ err: error, computerId: row.id }, 'recovering a computer failed');
    }
  }
  return recovered;
}

/**
 * A running Sprite provisioned with another version than the provider's (a
 * new release) is provisioned again once nobody has used it for
 * `DEFAULT_IDLE_TIMEOUT_MIN` and none of its screens is under owner control,
 * so the agent's restart never cuts into work, as a Docker computer moves to
 * a new image only at its next start.
 */
async function queueSpriteUpdates(deps: AppDeps, now: Date) {
  const machines = provider(deps);
  if (!provisionsInBackground(machines) || !machines.version) return;
  const rows = await deps.db
    .select()
    .from(schema.computers)
    .where(
      and(eq(schema.computers.status, 'running'), eq(schema.computers.provider, machines.name)),
    );
  for (const row of rows) {
    if (specOf(row).provisionVersion === machines.version) continue;
    const claimed = await claimIdle(deps, row, now, DEFAULT_IDLE_TIMEOUT_MIN, 'updating');
    if (!claimed) continue;
    deps.logger.info(
      { computerId: row.id, version: machines.version },
      'provisioning an idle Sprite again for a new release',
    );
    await publishStatus(deps, claimed, 'updating');
    await queueProvision(deps, claimed, SYSTEM_ACTOR);
  }
}

/**
 * Claims a running computer idle past its timeout, unless it was used
 * meanwhile or the owner has one of its screens (K3): a takeover is in use
 * however long the sign-in takes.
 */
function claimIdle(
  deps: AppDeps,
  row: ComputerRow,
  now: Date,
  idleMin = row.idleTimeoutMin ?? DEFAULT_IDLE_TIMEOUT_MIN,
  to: ComputerStatus = 'stopping',
) {
  const idleMs = idleMin * 60_000;
  const last = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
  if (now.getTime() - last < idleMs) return null;
  const held = deps.db
    .select({ id: schema.botScreens.id })
    .from(schema.botScreens)
    .where(
      and(
        eq(schema.botScreens.computerId, schema.computers.id),
        isNotNull(schema.botScreens.controlledByUserId),
      ),
    );
  return claim(
    deps,
    row,
    and(
      eq(schema.computers.status, 'running'),
      or(
        isNull(schema.computers.lastUsedAt),
        lt(schema.computers.lastUsedAt, new Date(now.getTime() - idleMs)),
      ),
      not(exists(held)),
    ),
    to,
  );
}

/** Sets the row `stopping` (or `to`) if it still matches, so two workers sweeping at once stop it once. */
async function claim(
  deps: AppDeps,
  row: ComputerRow,
  still: SQL | undefined,
  to: ComputerStatus = 'stopping',
) {
  const [claimed] = await deps.db
    .update(schema.computers)
    .set({ status: to, statusAt: sql`clock_timestamp()`, generation: nextGeneration() })
    .where(and(eq(schema.computers.id, row.id), still))
    .returning();
  return claimed ?? null;
}

/** The Bot's screen row, allocated on first use, with its display started on the agent. */
export async function ensureScreen(
  deps: AppDeps,
  bot: BotRow,
  computer: ComputerRow,
  agent: ComputerAgentClient,
): Promise<ScreenRow> {
  let screen = await screenOf(deps, bot.id);
  const allocated = !screen;
  for (let attempt = 0; !screen && attempt < 5; attempt++) {
    await deps.db.transaction(async (tx) => {
      // Displays belong to the machine. A remote agent is one machine for
      // every row on it, so its displays are allocated across accounts, one
      // at a time; a docker computer is its own machine.
      const shared = computer.provider === 'remote' && computer.agentUrl;
      if (shared) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`openbots:screens:${computer.agentUrl}`}))`,
        );
      }
      const taken = await tx
        .select({ display: schema.botScreens.displayNumber })
        .from(schema.botScreens)
        .innerJoin(schema.computers, eq(schema.computers.id, schema.botScreens.computerId))
        .where(
          shared
            ? eq(schema.computers.agentUrl, shared)
            : eq(schema.botScreens.computerId, computer.id),
        );
      const display = nextDisplay(taken.map((s) => s.display));
      // Unique on the Bot and on (computer, display): a racing allocation retries.
      await tx
        .insert(schema.botScreens)
        .values({
          workspaceId: bot.workspaceId,
          botId: bot.id,
          computerId: computer.id,
          displayNumber: display,
          cdpPort: cdpPortFor(display),
          browserProfileDir: browserProfileDir(display),
          status: 'stopped',
        })
        .onConflictDoNothing();
    });
    screen = await screenOf(deps, bot.id);
  }
  if (!screen) throw computerUnavailable('No screen could be allocated for this Bot');
  if (
    !allocated &&
    screen.status === 'running' &&
    !(await screenAlive(deps, computer, agent, screen))
  ) {
    screen = { ...screen, status: 'stopped' };
  }
  if (allocated || screen.status !== 'running') {
    // The agent keeps Chromium's profile per screen number; a display freed by
    // a deleted Bot must not hand its logins to the next one.
    const info = await agent.startScreen({
      n: screenNumber(screen.displayNumber),
      ...SCREEN_SIZE,
      ...(allocated ? { fresh: true } : {}),
    });
    const [updated] = await deps.db
      .update(schema.botScreens)
      .set({ status: 'running', cdpPort: info.cdpPort })
      .where(eq(schema.botScreens.id, screen.id))
      .returning();
    screen = updated ?? screen;
  }
  return screen;
}

/** When each computer's screens were last checked on its agent, in this process. */
const screensChecked = new Map<string, number>();

/**
 * Whether a screen recorded `running` still runs on the agent. Only asked of
 * a computer that pauses itself (Sprites): a cold wake restarts the agent
 * with no screens, and nothing tells the server. Asked once per stretch of
 * use in this process, so a run's screen actions do not each pay for it. A
 * screen found gone marks every screen of the computer the agent does not
 * run `stopped`, as a Docker start does.
 */
async function screenAlive(
  deps: AppDeps,
  computer: ComputerRow,
  agent: ComputerAgentClient,
  screen: ScreenRow,
): Promise<boolean> {
  if (!computerProvider(deps)?.hold || computer.provider !== 'sprites') return true;
  const since = inUseSince(computer.id);
  const checked = screensChecked.get(computer.id);
  if (since !== null && checked !== undefined && checked >= since) return true;
  const health = await agent.health();
  screensChecked.set(computer.id, Date.now());
  if (!health.screens) return true;
  const live = health.screens.map((n) => n + FIRST_DISPLAY);
  await deps.db
    .update(schema.botScreens)
    .set({ status: 'stopped' })
    .where(
      and(
        eq(schema.botScreens.computerId, computer.id),
        live.length ? not(inArray(schema.botScreens.displayNumber, live)) : undefined,
      ),
    );
  return health.screens.includes(screenNumber(screen.displayNumber));
}

export async function screenOf(deps: Pick<AppDeps, 'db'>, botId: string) {
  const [row] = await deps.db
    .select()
    .from(schema.botScreens)
    .where(eq(schema.botScreens.botId, botId));
  return row ?? null;
}

/**
 * After a Bot is deleted (B7): stops its screen if the computer is running,
 * best effort, so its Chromium and the Bot's logins do not linger. Its
 * `bot_screens` row went with the Bot (foreign-key cascade), which frees the
 * display; on a stopped computer nothing runs, and the next Bot given that
 * display starts with a fresh profile (`ensureScreen`).
 */
export async function stopDeletedBotScreen(deps: AppDeps, screen: ScreenRow | null) {
  if (!screen || !computerAvailable(deps)) return;
  try {
    const [computer] = await deps.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, screen.computerId));
    if (computer?.status !== 'running') return;
    await agentFor(deps, computer).stopScreen(
      screenNumber(screen.displayNumber),
      AbortSignal.timeout(SCREEN_STOP_TIMEOUT_MS),
    );
  } catch (error) {
    // Not running on the agent (a restart, say) is what we wanted anyway.
    if (error instanceof AgentError && error.status === 404) return;
    deps.logger.warn({ err: error, screenId: screen.id }, 'stopping a deleted Bot screen failed');
  }
}

/**
 * Take or hand back a Bot's screen (plan 9.4, K3). Taking it starts the
 * computer and the screen so the owner has something to drive, and opens
 * `url` in its browser when given (a sign-in page, K8).
 */
export async function setScreenControl(
  deps: AppDeps,
  user: Owner,
  botId: string,
  take: boolean,
  url?: string,
): Promise<ScreenRow> {
  await assertBotOwner(deps.db, user, botId);
  let screen = await screenOf(deps, botId);
  if (take) {
    const { computer } = await startComputer(deps, user);
    const agent = agentFor(deps, computer);
    screen = await ensureScreen(
      deps,
      { id: botId, ownerId: user.id, workspaceId: user.workspaceId },
      computer,
      agent,
    );
    if (url) {
      // The owner can still type the address; a page that will not load is no reason to refuse.
      await agent
        .browser(screenNumber(screen.displayNumber), { action: 'navigate', url })
        .catch((error: unknown) => deps.logger.warn({ err: error, botId }, 'navigate failed'));
    }
  }
  if (!screen) throw notFound('This Bot has no screen yet');
  const [updated] = await deps.db
    .update(schema.botScreens)
    .set(
      take
        ? { controlledByUserId: user.id, controlledSince: new Date() }
        : { controlledByUserId: null, controlledSince: null },
    )
    .where(eq(schema.botScreens.id, screen.id))
    .returning();
  await recordAudit(deps.db, {
    workspaceId: user.workspaceId,
    actor: { type: 'user', id: user.id },
    action: take ? 'computer.takeover' : 'computer.release',
    targetType: 'bot',
    targetId: botId,
    metadata: { screenId: screen.id, display: screen.displayNumber },
  });
  await publishControl(deps, updated ?? screen, take ? user.id : null);
  // What the owner did on the screen, a sign-in say, reaches the other Bots (K1).
  if (!take && screen.status === 'running') await syncCookies(deps, user, screen);
  return updated!;
}

/**
 * Spreads the cookies of `screen`'s browser, or of every running screen's,
 * to the account's other screens now (K1). The agent also syncs after each
 * action and every 30 seconds; this is for what the owner did by hand. False
 * when the computer is not running or the agent could not sync.
 */
export async function syncCookies(
  deps: AppDeps,
  owner: Owner,
  screen?: Pick<ScreenRow, 'displayNumber'>,
): Promise<boolean> {
  if (!computerAvailable(deps)) return false;
  const computer = await getComputer(deps, owner);
  if (computer?.status !== 'running') return false;
  try {
    await agentFor(deps, computer).syncCookies(
      screen ? screenNumber(screen.displayNumber) : undefined,
    );
    return true;
  } catch (error) {
    deps.logger.warn({ err: error, computerId: computer.id }, 'cookie sync failed');
    return false;
  }
}

/** Waits until nobody holds the Bot's screen; false when `timeoutMs` passes first. */
async function waitForHandBack(
  deps: AppDeps,
  botId: string,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const screen = await screenOf(deps, botId);
    if (!screen?.controlledByUserId) return true;
    if (Date.now() >= deadline) return false;
    signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  }
}

const screenLocks = new ScreenLocks();

export interface ComputerRunOptions {
  bot: BotRow;
  runId: string;
  signal?: AbortSignal;
  recordStep(step: StepRecord): Promise<void>;
  /**
   * The run had to start the computer (W3): the run posts its compact event
   * row, which says when the start updated it first. Not called when the
   * computer was already running.
   */
  onComputerStarted?(durationMs: number, updated: boolean): Promise<void>;
  /** How long a screen action waits for a hand back; `TAKEOVER_WAIT_MS` by default. */
  takeoverWaitMs?: number;
  takeoverPollMs?: number;
  /** How often a running command marks the computer used; `EXEC_TOUCH_MS` by default. */
  execTouchMs?: number;
  /** The run's use of the computer, begun at its first computer call; the run ends it. */
  use?: ComputerUseScope;
}

/** How often a command still running marks the computer used. */
export const EXEC_TOUCH_MS = 60_000;

/**
 * The agent, with a command in use of the computer while it runs: `bash`
 * may run for 30 minutes, longer than the shortest idle timeout, and the idle
 * sweep must not stop the computer under it, nor a Sprite pause (plan 9.5).
 */
function inUse(
  deps: AppDeps,
  computer: ComputerRow,
  agent: ComputerAgentClient,
  everyMs = EXEC_TOUCH_MS,
): ComputerAgentClient {
  return {
    ...agent,
    async exec(request, options) {
      const use = beginComputerUse(deps, computer, 'exec', { touchMs: everyMs });
      try {
        return await agent.exec(request, options);
      } finally {
        await use.end();
      }
    },
  };
}

/** The computer tools' backend for one run (the agent's `ComputerServices`). */
export function computerServices(deps: AppDeps, options: ComputerRunOptions): ComputerServices {
  const { bot, runId, signal } = options;
  const owner = { id: bot.ownerId, workspaceId: bot.workspaceId };
  // Calls in one step share a start; it is logged once.
  const logged = new WeakSet<Started>();
  const ready = async () => {
    const started = await startComputer(deps, owner, { type: 'bot', id: bot.id });
    const { computer, durationMs, updated } = started;
    if (durationMs !== null && !logged.has(started)) {
      logged.add(started);
      await options.recordStep({
        type: 'tool_call',
        label: labelFor('computer_start', {}, { durationMs }),
        payload: { toolName: 'computer_start', durationMs },
        durationMs,
      });
      // A missing event row never fails the tool call that needed the computer.
      await options.onComputerStarted?.(durationMs, updated).catch((error: unknown) => {
        deps.logger.warn({ err: error, runId }, 'computer started event failed');
      });
    }
    options.use?.begin(computer);
    const agent = inUse(deps, computer, agentFor(deps, computer), options.execTouchMs);
    return { computer, agent };
  };
  // While the owner holds the screen, wait for the hand back (K3).
  const holdForOwner = async (screen: ScreenRow | null, tool: string) => {
    if (!screen?.controlledByUserId) return;
    await setState(deps, bot.id, 'waiting', {
      runId,
      currentAction: 'Waiting: the owner has the screen',
    });
    const free = await waitForHandBack(
      deps,
      bot.id,
      options.takeoverWaitMs ?? TAKEOVER_WAIT_MS,
      options.takeoverPollMs ?? TAKEOVER_POLL_MS,
      signal,
    );
    if (!free) throw new OwnerHasScreen();
    await setState(deps, bot.id, 'working', {
      runId,
      currentAction: 'Back on the screen',
      currentTool: tool,
    });
  };
  return {
    ...(signal ? { signal } : {}),
    agent: async () => (await ready()).agent,
    screen: (fn) =>
      screenLocks.run(
        bot.id,
        async () => {
          const { computer, agent } = await ready();
          const screen = await ensureScreen(deps, bot, computer, agent);
          await holdForOwner(screen, 'computer');
          return fn(screenNumber(screen.displayNumber), agent);
        },
        signal,
      ),
    // A command can drive the screen too (xdotool), so bash waits as well
    // (S-7). A Bot with no screen yet has nothing the owner could hold.
    screenFree: async () => holdForOwner(await screenOf(deps, bot.id), 'bash'),
    // A command runs with the Bot's own display and no other's (S-7).
    screenNumber: async () => {
      const screen = await screenOf(deps, bot.id);
      return screen ? screenNumber(screen.displayNumber) : undefined;
    },
  };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** What the owner reads in place of a hosted machine's own failure text. */
export const HOSTED_FAILURE = 'something went wrong on our side. Try again shortly.';

/**
 * What a machine's failure reads as to its owner (the API, the status event,
 * a Bot's tool). The hosted provider's own text names the sandbox vendor and
 * carries its script's output, which the service does not show its users: it
 * goes to the log beside this call, and the owner reads `HOSTED_FAILURE`. A
 * self-hosted owner runs the machine themselves and reads the real reason.
 */
function failureText(deps: AppDeps, error: unknown) {
  return hostedMachines(deps) ? HOSTED_FAILURE : errorText(error);
}

/** `HOSTED_FAILURE` as a sentence of its own. */
export const HOSTED_FAILURE_SENTENCE = HOSTED_FAILURE[0]!.toUpperCase() + HOSTED_FAILURE.slice(1);

function hostedMachines(deps: Pick<AppDeps, 'config' | 'logger'>) {
  const machines = computerProvider(deps);
  return !!machines && provisionsInBackground(machines);
}

/**
 * Text that names the hosted service's sandbox provider or its hosts: the
 * provider's API errors, its machines' names and URLs (a socket that could
 * not reach one says its host name).
 */
const PROVIDER_WORDS = /sprite|fly\.io|fly\.dev|flyctl/i;

function namesProvider(error: unknown): boolean {
  return error instanceof SpritesApiError || PROVIDER_WORDS.test(errorText(error));
}

/**
 * A failure's text where its reader is the member or their Bot (a reset's
 * rescue, a checkout's error, a coding session's end, a sign-in, a tool's
 * result), for a failure that is not only the provider's: git's own words, an
 * agent's refusal and the server's own reasons stay as they are. On the
 * hosted service, one that comes from the sandbox provider or names it reads
 * `HOSTED_FAILURE` instead (`inline`: after a colon), as `failureText` does,
 * and the real failure goes to the log. Self-hosted, the text as it is.
 */
export function shownFailure(
  deps: Pick<AppDeps, 'config' | 'logger'>,
  error: unknown,
  { inline = false }: { inline?: boolean } = {},
): string {
  if (!hostedMachines(deps) || !namesProvider(error)) return errorText(error);
  deps.logger.warn({ err: error }, 'a failure on the hosted computer, shown in plain words');
  return inline ? HOSTED_FAILURE : HOSTED_FAILURE_SENTENCE;
}

/**
 * The agent client of a hosted computer, whose failures read as
 * `shownFailure` says: its requests and sockets go to the provider's URL
 * for the machine, so a connection that fails names that host. An agent
 * error keeps its status and code. The real failure goes to the log.
 */
function quietAgent(
  deps: AppDeps,
  agent: ComputerAgentClient,
  computerId: string,
): ComputerAgentClient {
  const quiet = (error: unknown): unknown => {
    if (!namesProvider(error)) return error;
    deps.logger.warn({ err: error, computerId }, 'the computer agent could not be reached');
    return error instanceof AgentError
      ? new AgentError(error.status, HOSTED_FAILURE_SENTENCE, error.code)
      : new Error(HOSTED_FAILURE_SENTENCE);
  };
  const said = (text: string) => {
    if (!PROVIDER_WORDS.test(text)) return text;
    deps.logger.warn({ computerId, error: text }, 'the computer agent could not be reached');
    return HOSTED_FAILURE_SENTENCE;
  };
  const rethrow = (error: unknown): never => {
    throw quiet(error);
  };
  const wrapped: Record<string, unknown> = { ...agent };
  for (const [key, value] of Object.entries(agent)) {
    if (typeof value !== 'function' || key === 'socket') continue;
    wrapped[key] = (...args: unknown[]) => {
      try {
        const out: unknown = (value as (...a: unknown[]) => unknown)(...args);
        return out instanceof Promise ? out.catch(rethrow) : out;
      } catch (error) {
        return rethrow(error);
      }
    };
  }
  const quieter = <T extends { error?: string }>(info: T): T =>
    info.error ? { ...info, error: said(info.error) } : info;
  const client = wrapped as unknown as ComputerAgentClient;
  client.mcpStdio = (launch, handlers, options) =>
    agent
      .mcpStdio(launch, { ...handlers, exit: (info) => handlers.exit(quieter(info)) }, options)
      .catch(rethrow);
  client.coder = (start, handlers, options) =>
    agent
      .coder(
        start,
        {
          ...handlers,
          exit: (info) => handlers.exit(quieter(info)),
          ...(handlers.error ? { error: (message) => handlers.error!(said(message)) } : {}),
        },
        options,
      )
      .then((proc) => {
        const started = proc.started.catch(rethrow);
        // Unread unless the caller waits for it, as the agent's own.
        started.catch(() => {});
        return { ...proc, started };
      })
      .catch(rethrow);
  return client;
}
