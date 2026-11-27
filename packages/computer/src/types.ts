import type { ComputerProviderName } from '@openbots/shared';
import type { ComputerAgentClient } from './agent-client.js';

// The provider interface (plan 9.2). `docker` is v1; `remote` points at a
// control agent already running on some machine; `sprites` makes one Fly
// Sprite per account (the hosted service); firecracker, e2b and daytona are
// later providers (K6). The server owns the `computers` row and calls a
// provider to make the machine behind it exist, run and stop.

/** Resource limits for one computer (plan 9.5). */
export interface ComputerLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  /** /dev/shm, which Chromium needs much more of than Docker's 64 MB default. */
  shmMb: number;
  /** Size of the /tmp tmpfs. */
  tmpMb: number;
}

export const DEFAULT_LIMITS: ComputerLimits = {
  memoryMb: 4096,
  cpus: 2,
  pids: 1024,
  shmMb: 1024,
  tmpMb: 1024,
};

/** What to create: one computer for one account (K1). */
export interface ComputerSpec {
  computerId: string;
  ownerId: string;
  image: string;
  /** The bearer token the control agent accepts; the server keeps it sealed. */
  agentToken: string;
  /** The persistent volume mounted at /home/bot (K7); kept when the computer stops. */
  volumeName: string;
  limits?: Partial<ComputerLimits>;
  /**
   * An HTTP proxy the sandbox's web traffic goes through (plan 9.5, optional
   * allowlist), e.g. `http://172.30.255.3:8888`. Set as `HTTP_PROXY` and
   * `HTTPS_PROXY` in both cases, which the browser and the usual command line
   * tools read. docker/sandbox-firewall.sh lets the computers reach it.
   */
  egressProxy?: string;
  /** Hosts that skip `egressProxy` (`NO_PROXY`); defaults to `DEFAULT_NO_PROXY`. */
  noProxy?: string;
  timezone?: string;
  /**
   * What names the machine where the provider names it (Sprites), instead of
   * `computerId`. A full reset gives the computer a new key, so its next
   * machine is a new one while the old one is being deleted. Absent on
   * computers never fully reset there.
   */
  machineKey?: string;
  /**
   * Ends the make where the provider can (Sprites: between its calls, and the
   * provisioning command itself): a job whose computer moved on stops at once.
   */
  signal?: AbortSignal;
}

/** What `ComputerProvider.start` takes besides the machine. */
export interface StartOptions {
  /** As `ComputerSpec.signal`. */
  signal?: AbortSignal;
}

/** What `ComputerProvider.stop` takes besides the machine. */
export interface StopOptions {
  /** As `ComputerSpec.signal`. */
  signal?: AbortSignal;
}

/** What skips the egress proxy unless `noProxy` says otherwise: the computer itself. */
export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1';

/** Where a created computer lives; stored on the `computers` row. */
export interface ComputerRef {
  provider: ComputerProviderName;
  containerId: string | null;
  agentUrl: string;
  agentToken: string;
  volumeName: string | null;
}

/**
 * What a reset removes besides the machine (GH5). The home volume
 * (`ref.volumeName`) goes with `home`; the computer's state volume, which
 * holds the cookie store and the coding agents' sign-ins, only with `state`
 * too. A provider with no volumes of its own ignores both.
 */
export interface DestroyOptions {
  /** The computer whose volumes go. */
  computerId: string;
  home: boolean;
  state?: boolean;
  /**
   * Ends a home clearing where the provider can (Sprites: the command): a
   * reset that lost its claim on the computer stops before it clears more.
   */
  signal?: AbortSignal;
}

/** What the provider sees; the server's own status adds `creating`, `starting`, `stopping`, `error`. */
export type MachineStatus = 'running' | 'stopped' | 'missing';

/**
 * A DNS egress rule (the Sprites network policy): an exact host, `*.host` or
 * `*` with `allow` or `deny`, or `include` a provider's preset.
 */
export interface EgressRule {
  domain?: string;
  action?: 'allow' | 'deny';
  include?: string;
}

/** What a computer may reach; an empty rule list means no enforcement. */
export interface EgressPolicy {
  rules: EgressRule[];
}

/** A snapshot of a computer's whole disk. */
export interface ComputerCheckpoint {
  id: string;
  /** ISO timestamp. */
  createdAt: string;
  comment?: string;
}

export interface ComputerProvider {
  readonly name: ComputerProviderName;
  /**
   * What a made machine runs when it differs per release and the server
   * cannot see it in the image: the Sprites provisioning version
   * (docker/sprites/dist/VERSION). The server records it on the row once a
   * provisioning succeeded, and provisions again when it changes.
   */
  readonly version?: string;
  create(spec: ComputerSpec): Promise<ComputerRef>;
  /** Starts the machine and resolves once its control agent answers. */
  start(ref: ComputerRef, options?: StartOptions): Promise<void>;
  /**
   * Stops the machine. Its signal ends the stop at the next call that could
   * still change the machine (Sprites: before each hold it releases), for a
   * caller that no longer holds it; a provider that cannot stop part way
   * (Docker) ignores it.
   */
  stop(ref: ComputerRef, options?: StopOptions): Promise<void>;
  /**
   * Removes the machine; the home volume is kept (K7) unless `options` says
   * otherwise (a reset, GH5).
   */
  destroy(ref: ComputerRef, options?: DestroyOptions): Promise<void>;
  /**
   * True when `destroy` with `home` and without `state` keeps the machine and
   * clears its home in place (Sprites), so the server goes on naming it:
   * its state directory, with the sign-ins, is still there.
   */
  readonly keepsMachineOnHomeReset?: boolean;
  /**
   * True when the provider names a machine by `ComputerSpec.machineKey`
   * (Sprites): a full reset gives the computer a new key and deletes the old
   * machine by its name afterwards, retried until it is gone, so the member
   * can start the new one at once. Without it (Docker), a full reset removes
   * the machine before it answers.
   */
  readonly machineKeyed?: boolean;
  status(ref: ComputerRef): Promise<MachineStatus>;
  agent(ref: ComputerRef): ComputerAgentClient;
  /** Fetches the sandbox image ahead of the first `create` (the setup wizard); Docker only. */
  prepareImage?(image: string): Promise<void>;
  /**
   * Pulls an image already present again, so a tag that moves with releases
   * (`latest`, `1.2`) reaches the new release after an upgrade; Docker only.
   */
  refreshImage?(image: string): Promise<void>;
  /**
   * False when the machine was made from another build of `image` than the
   * local one (the tag moved since), so it is made again; Docker only.
   */
  runsImage?(ref: ComputerRef, image: string): Promise<boolean>;
  /**
   * Keeps a machine that pauses itself when idle running for `seconds` (at
   * most an hour; call again to extend), under `name`, so a run is not paused
   * mid-task. Sprites only.
   */
  hold?(ref: ComputerRef, name: string, seconds: number): Promise<void>;
  /** Drops the hold `name`; one already gone is fine. Sprites only. */
  release?(ref: ComputerRef, name: string): Promise<void>;
  /**
   * Snapshots the machine's whole disk; resolves with the checkpoint's id, or
   * null when it was made but cannot be told apart from others (give a unique
   * `comment`). Sprites only.
   */
  checkpoint?(ref: ComputerRef, comment?: string): Promise<string | null>;
  /** Puts the whole disk back as it was at checkpoint `id`. Sprites only. */
  restore?(ref: ComputerRef, id: string): Promise<void>;
  listCheckpoints?(ref: ComputerRef): Promise<ComputerCheckpoint[]>;
  /** Replaces what the machine may reach. Sprites only. */
  applyEgressPolicy?(ref: ComputerRef, policy: EgressPolicy): Promise<void>;
}

// The computer's paths and the coding agents' users, paths and environment
// variable names (I2, I3, I5, I11) are defined in @openbots/shared
// (coder-runtime.ts), which the control agent imports too. The `coder` user
// runs every coding agent and every login; its config directories live on
// the root-only state volume, so the Bot's shell, running as `bot`, cannot
// read the owner's vendor sign-ins (the same arrangement as the cookie
// store, plan 9.6).
export {
  CODER_APPROVAL_TTL_ENV,
  CODER_CONFIG_DIRS,
  CODER_CONFIG_ENV,
  CODER_CREDENTIAL_SOCKET_ENV,
  CODER_HOME,
  CODER_HOME_NAME,
  CODER_ID,
  CODER_MODE_ENV,
  CODER_PERMISSION_MCP,
  CODER_PI_EXTENSION,
  CODER_SESSION_DIR_ENV,
  CODER_SESSION_ENV,
  CODER_SOCKET_ENV,
  CODER_STATE_DIR,
  CODER_STATE_NAME,
  CODERS_GID,
  COMPUTER_HOME,
  COMPUTER_STATE_DIR as STATE_DIR,
  coderApprovalTtlMs,
  DEFAULT_CODER_APPROVAL_TTL_MS,
  GIT_CREDENTIAL_HELPER,
  REPOS_DIR,
  REPOS_REL,
  RUNNER_HOME,
  RUNNER_HOME_NAME,
  RUNNER_ID,
} from '@openbots/shared';
