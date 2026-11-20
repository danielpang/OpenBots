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
   * `computerId`. A full reset that keeps the old machine for a while
   * (`retire`) gives the computer a new key, so its next machine is a new one
   * and the old one is left alone. Absent on computers never reset that way.
   * It may also be the provider's own name of an existing machine (the one an
   * operator restored), which then names exactly that machine.
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

/** What `ComputerProvider.retireInside` takes besides the machine. */
export interface RetireInsideOptions {
  /**
   * Called before each step that changes the machine; throws when the caller
   * no longer holds it (its claim on the record ran out), which ends the call.
   */
  check?: () => Promise<void>;
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

/**
 * What the provider sees; the server's own status adds `creating`, `starting`, `stopping`, `error`.
 * A retired machine reads `missing`: it serves nothing until it is put back.
 */
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
  stop(ref: ComputerRef): Promise<void>;
  /**
   * Removes the machine; the home volume is kept (K7) unless `options` says
   * otherwise (a reset, GH5).
   */
  destroy(ref: ComputerRef, options?: DestroyOptions): Promise<void>;
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
  /**
   * Takes a machine a full reset replaces out of reach, at once and without
   * waking it: from then on no request from outside reaches it (its URL is
   * private), it reaches nothing (its egress policy denies everything), and
   * every call on it but `status`, `listCheckpoints`, `restore`,
   * `retireInside`, `unretire` and `destroy` is refused. Only metadata calls,
   * no command inside it, so it works on a machine that will not wake. Its
   * disk and checkpoints are kept, so an operator can bring it back
   * (`unretire`) until the server deletes it with `destroy` (home and state).
   * Safe to call again. A provider that has it keeps a machine through a full
   * reset; one without it (Docker) removes it as before. Sprites only.
   */
  retire?(ref: ComputerRef): Promise<void>;
  /**
   * What the provider itself says of the machine, from metadata that does
   * not wake it: `retired` (every part of the cut read back as `retire`
   * leaves it: label, private URL, an egress policy that denies everything),
   * `in_service`, or `gone`. For a check that must not take the server's
   * record on trust.
   */
  retiredState?(ref: ComputerRef): Promise<'retired' | 'in_service' | 'gone'>;
  /**
   * The rest of a retire, inside the machine (it wakes it): its holds are
   * dropped so it pauses, a hold racing with this one is refused, and its
   * agent is stopped and removed and its agent token deleted. Refused on a
   * machine `retire` did not take out of reach first, checked again before
   * each step, as is `options.check`. Its time is bounded (Sprites:
   * `SPRITES_RETIRE_INSIDE_MAX_MS`). Safe to call again.
   */
  retireInside?(ref: ComputerRef, options?: RetireInsideOptions): Promise<void>;
  /**
   * Puts a retired machine back in service as far as the provider goes: its
   * URL and egress policy as configured. Its agent comes back with the next
   * `create` for the same machine, which provisions it with a new token.
   */
  unretire?(ref: ComputerRef): Promise<void>;
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
