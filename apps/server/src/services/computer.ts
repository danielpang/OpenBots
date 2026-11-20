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
import { retainsOnReset, retireMachine } from './computer-retire.js';

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
 * how long a row may wait on its job before a start queues another: longer
 * than the longest provisioning (15 minutes), so a job that is only slow is
 * not doubled.
 */
export const provisionTimings = { waitMs: PROVISION_WAIT_MS, staleMs: 20 * 60_000 };

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
  /** Names the machine instead of the row's id (`ComputerSpec.machineKey`). */
  machineKey?: string;
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
): Promise<ComputerRow> {
  const [updated] = await deps.db
    .update(schema.computers)
    .set({ status, ...more })
    .where(eq(schema.computers.id, row.id))
    .returning();
  await publishStatus(deps, row, status, error);
  return updated ?? row;
}

function publishStatus(
  deps: AppDeps,
  row: ComputerRow,
  status: ComputerStatus,
  error: string | null = null,
) {
  return publishEvent(
    deps.infra.bus,
    wsEvent(
      'computer.status',
      { computerId: row.id, status, error },
      { user_id: row.ownerId, workspace_id: row.workspaceId },
    ),
  );
}

function refOf(deps: AppDeps, row: ComputerRow): ComputerRef {
  if (!row.agentUrl || !row.agentToken) throw computerUnavailable('The computer was never created');
  return {
    provider: row.provider,
    containerId: row.containerId,
    agentUrl: row.agentUrl,
    agentToken: decryptSecretString(row.agentToken, keyring(deps)),
    volumeName: row.volumeName,
  };
}

export function agentFor(deps: AppDeps, row: ComputerRow): ComputerAgentClient {
  return provider(deps).agent(refOf(deps, row));
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
): Promise<ComputerRow> {
  const machines = provider(deps);
  row = await setStatus(deps, row, status);
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
      // Set by a full reset that kept the old machine (computer-retire.ts).
      ...(specOf(row).machineKey ? { machineKey: specOf(row).machineKey } : {}),
    });
    const created = await setStatus(deps, row, 'stopped', {
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
    });
    await auditComputer(deps, created, by, 'computer.create', {
      provider: ref.provider,
      ...(status === 'updating' ? { updated: true, image: deps.config.sandboxImage } : {}),
    });
    return created;
  } catch (error) {
    const message = failureText(deps, error);
    deps.logger.error({ err: error, computerId: row.id }, 'computer create failed');
    await setStatus(deps, row, 'error', {}, message);
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
  const machine = row.agentUrl ? await machines.status(refOf(deps, row)) : 'missing';
  if (machine === 'running' && row.status === 'running') {
    return { computer: await touch(deps, row), durationMs: null, updated: false };
  }
  if (provisionsInBackground(machines)) return startInBackground(deps, row, by);
  const began = Date.now();
  // Removed behind the server's back: made again, same home volume.
  if (machine === 'missing') row = await createMachine(deps, row, by);
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
  if (updated) row = await createMachine(deps, row, by, 'updating');
  row = await setStatus(deps, row, 'starting');
  try {
    await machines.start(refOf(deps, row));
  } catch (error) {
    const message = failureText(deps, error);
    deps.logger.error({ err: error, computerId: row.id }, 'computer start failed');
    await setStatus(deps, row, 'error', {}, message);
    throw computerUnavailable(`The computer did not start: ${message}`);
  }
  // A fresh start has no displays running yet.
  await deps.db
    .update(schema.botScreens)
    .set({ status: 'stopped' })
    .where(eq(schema.botScreens.computerId, row.id));
  row = await setStatus(deps, row, 'running', { lastUsedAt: new Date(), spec: settledSpec(row) });
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
  // the two modules do not import each other.
  void import('./git-identity.js')
    .then(({ applyGitIdentityOnComputer }) => applyGitIdentityOnComputer(deps, owner))
    .catch((error: unknown) => deps.logger.warn({ err: error }, 'git identity failed'));
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
  if (!BUSY.has(row.status)) {
    const status = row.agentUrl ? 'starting' : 'creating';
    // Two starts at once, in two processes: one claims the row and queues.
    const claimed = await claim(deps, row, eq(schema.computers.status, row.status), status);
    if (claimed) {
      await publishStatus(deps, claimed, status);
      await queueOrFail(deps, claimed, by, row.status as ComputerStatus);
    }
  } else if (row.status !== 'stopping' && provisionStale(row)) {
    // Its job was queued long ago and never ended (lost with a process that
    // died, or never queued): this start queues another. Waiting for a worker
    // to restart would leave the owner pressing Start for nothing.
    await queueOrFail(deps, row, by);
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

/** True when the row has waited on its provisioning job for longer than any job takes. */
function provisionStale(row: ComputerRow): boolean {
  const at = specOf(row).provision?.at;
  return at !== undefined && Date.now() - new Date(at).getTime() >= provisionTimings.staleMs;
}

/** `queueProvision` for a start: a queue that refuses answers as a computer that cannot start. */
async function queueOrFail(
  deps: AppDeps,
  row: ComputerRow,
  by: AuditActor,
  releaseTo?: ComputerStatus,
) {
  try {
    await queueProvision(deps, row, by, releaseTo);
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
): Promise<boolean> {
  const attempt = randomUUID();
  const attemptOf = sql`${schema.computers.spec} #>> '{provision,attempt}'`;
  const [queued] = await deps.db
    .update(schema.computers)
    .set({ spec: { ...specOf(row), provision: { attempt, at: new Date().toISOString() } } })
    .where(
      and(
        eq(schema.computers.id, row.id),
        eq(schema.computers.status, row.status),
        sql`${attemptOf} is not distinct from ${specOf(row).provision?.attempt ?? null}`,
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
  let [row] = await deps.db
    .select()
    .from(schema.computers)
    .where(eq(schema.computers.id, job.computerId));
  if (!row || !machines || row.status === 'running') return;
  // Another attempt took the row's place, or this one was given up: not this job's to run.
  if (job.attempt && specOf(row).provision?.attempt !== job.attempt) return;
  const began = Date.now();
  const owner = { id: row.ownerId, workspaceId: row.workspaceId };
  try {
    const machine = row.agentUrl ? await machines.status(refOf(deps, row)) : 'missing';
    if (machine === 'missing') row = await createMachine(deps, row, job.by);
    row = await setStatus(deps, row, 'starting');
    await machines.start(refOf(deps, row));
  } catch (error) {
    const message = failureText(deps, error);
    deps.logger.error({ err: error, computerId: row.id }, 'computer provisioning failed');
    const { provision: _, ...spec } = specOf(row);
    await setStatus(deps, row, 'error', { spec: { ...spec, error: message } }, message);
    return;
  }
  // The agent may have been installed again, so no display runs.
  await deps.db
    .update(schema.botScreens)
    .set({ status: 'stopped' })
    .where(eq(schema.botScreens.computerId, row.id));
  const { error: _, provision: __, ...spec } = settledSpec(row);
  row = await setStatus(deps, row, 'running', {
    lastUsedAt: new Date(),
    spec: { ...spec, ...(machines.version ? { provisionVersion: machines.version } : {}) },
  });
  await afterStart(deps, owner, row, job.by, began);
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
        inArray(schema.computers.status, ['creating', 'starting', 'updating', 'stopping']),
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
    // The machine the use began on, until the provider refuses it: a reset
    // may have retired it, which the provider refuses without waking it.
    // Then the hold moves to the machine the row has now, if any, and the
    // use goes on with that one. No read in the usual case, so the hold is
    // in place before the work's first call.
    let known = refOf(deps, row);
    const current = () =>
      inWorkspace(row.workspaceId, async () => {
        const [now] = await deps.db
          .select()
          .from(schema.computers)
          .where(eq(schema.computers.id, row.id));
        return now?.agentUrl && now.agentToken && now.provider === machines.name
          ? refOf(deps, now)
          : null;
      });
    hold = {
      hold: async (name, seconds) => {
        try {
          await machines.hold!(known, name, seconds);
        } catch (error) {
          const now = await current();
          if (!now || now.containerId === known.containerId) throw error;
          known = now;
          await machines.hold!(known, name, seconds);
        }
      },
      release: async (name) => machines.release?.(known, name),
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
  if (!row.agentUrl || row.status === 'stopped') return row;
  return stopMachine(deps, await setStatus(deps, row, 'stopping'), by);
}

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
   * The checkpoint taken just before (`checkpointBeforeReset`), recorded
   * with a machine that is retired rather than removed.
   */
  checkpointId?: string | null;
}

/**
 * The machine part of a reset (GH5; services/computer-reset.ts asks first):
 * stops the computer if it is up (its stdio connectors and coding sessions
 * end with it), then removes the container and its home volume through the
 * provider, and the state volume only with `signIns`. The row stays,
 * `stopped`, with no machine, so the next start makes a fresh one with the
 * same volume name. Docker and Sprites only: the remote machine is not the
 * server's to remove (409 `RESET_UNSUPPORTED`). A stop that fails does not stop the reset,
 * since removing the container stops it anyway.
 */
export async function destroyComputer(
  deps: AppDeps,
  row: ComputerRow,
  options: DestroyComputerOptions,
  by: AuditActor = { type: 'user', id: row.ownerId },
): Promise<ComputerRow> {
  const machines = provider(deps);
  assertResettable(deps);
  // `stopMachine` ends the coding sessions; with nothing to stop, they end here.
  const stops = !!row.agentUrl && row.status !== 'stopped';
  if (stops) {
    row = await stopComputer(deps, row, by).catch(async (error: unknown) => {
      deps.logger.warn({ err: error, computerId: row.id }, 'stop before reset failed');
      const [now] = await deps.db
        .select()
        .from(schema.computers)
        .where(eq(schema.computers.id, row.id));
      return now ?? row;
    });
  } else {
    await deps.infra.bus
      .publish<CoderControl>(CODER_CONTROL_CHANNEL, { type: 'stop_all', computerId: row.id })
      .catch((error: unknown) =>
        deps.logger.warn({ err: error, computerId: row.id }, 'stopping coding sessions failed'),
      );
  }
  // A full reset on a provider that can retire the machine keeps it for
  // RETIRED_COMPUTER_DAYS instead (computer-retire.ts); the row gets a new
  // machine key, so its next start makes a new machine.
  if (options.signIns && retainsOnReset(machines) && row.containerId) {
    if (row.provider === machines.name) {
      try {
        const { computer } = await retireMachine(deps, machines, row, {
          checkpointId: options.checkpointId ?? null,
          by,
          reason: 'reset',
        });
        return computer;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        const message = failureText(deps, error);
        deps.logger.error({ err: error, computerId: row.id }, 'computer reset failed');
        await setStatus(deps, row, 'error', {}, message);
        throw computerUnavailable(`The computer could not be reset: ${message}`);
      }
    }
  }
  if (row.agentUrl && row.agentToken && row.containerId) {
    try {
      await machines.destroy(refOf(deps, row), {
        computerId: row.id,
        home: true,
        state: options.signIns,
      });
    } catch (error) {
      const message = failureText(deps, error);
      deps.logger.error({ err: error, computerId: row.id }, 'computer reset failed');
      await setStatus(deps, row, 'error', {}, message);
      throw computerUnavailable(`The computer could not be reset: ${message}`);
    }
  }
  return setStatus(deps, row, 'stopped', {
    containerId: null,
    agentUrl: null,
    agentToken: null,
    volumeName: row.volumeName ?? volumeName(row.id),
  });
}

/**
 * Before a reset that keeps the machine (a Sprite reset without its
 * sign-ins clears the home in place; one with them retires the Sprite, kept
 * seven days), a checkpoint of its whole disk, so an operator can undo a
 * mistaken reset (`restore`). Returns its id, or null when the provider
 * takes none or the machine goes with the reset (one that cannot retire it).
 * A checkpoint that fails does not stop the reset: a computer that will not
 * work is when a reset helps most.
 */
export async function checkpointBeforeReset(
  deps: AppDeps,
  row: ComputerRow,
  options: DestroyComputerOptions,
): Promise<string | null> {
  const machines = provider(deps);
  if (!machines.checkpoint || !row.agentUrl || !row.agentToken) return null;
  if (options.signIns && !retainsOnReset(machines)) return null;
  if (machines.name !== row.provider || !row.containerId) return null;
  try {
    return await machines.checkpoint(
      refOf(deps, row),
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
): Promise<ComputerRow> {
  // Its owner's stdio connectors running in it end first, in every process.
  await deps.infra.bus
    .publish<McpControl>(MCP_CONTROL_CHANNEL, {
      type: 'computer',
      ownerId: row.ownerId,
      workspaceId: row.workspaceId,
    })
    .catch((error: unknown) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'stopping stdio connectors failed'),
    );
  // And its coding sessions, wherever their jobs run (I12).
  await deps.infra.bus
    .publish<CoderControl>(CODER_CONTROL_CHANNEL, { type: 'stop_all', computerId: row.id })
    .catch((error: unknown) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'stopping coding sessions failed'),
    );
  try {
    await provider(deps).stop(refOf(deps, row));
  } catch (error) {
    const message = failureText(deps, error);
    deps.logger.error({ err: error, computerId: row.id }, 'computer stop failed');
    await setStatus(deps, row, 'error', failed, message);
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
  const stopped = await setStatus(deps, row, 'stopped', { spec: settledSpec(row) });
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
export async function sweepIdleComputers(deps: AppDeps, now = new Date()): Promise<number> {
  if (!computerAvailable(deps)) return 0;
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
    .set({ status: to })
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
  const machines = computerProvider(deps);
  return machines && provisionsInBackground(machines) ? HOSTED_FAILURE : errorText(error);
}
