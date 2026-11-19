import type { OpenAPIHono } from '@hono/zod-openapi';
import type { BetterAuthPlugin } from 'better-auth';
import type { Config } from './config.js';
import type { AppEnv } from './context.js';
import type { Db } from './db/client.js';
import type { Infra } from './infra/index.js';
import type { Logger } from './logger.js';
import type { ComputerProviderName, Limits } from '@openbots/shared';
import type { Workspace } from './workspace.js';

// Extension points for the managed build (plan 21.5). The core never imports
// ee/: `ee/server` imports the core and passes these to `runServer`, the
// test app or `createApp`. A self-hosted server passes none.

export interface ExtensionContext {
  config: Config;
  db: Db;
  logger: Logger;
  infra: Infra;
}

/** A stretch of a member's computer use that ended (services/computer-usage.ts). */
export interface ComputerUsageEvent {
  workspaceId: string;
  ownerId: string;
  computerId: string;
  provider: ComputerProviderName;
  startedAt: Date;
  endedAt: Date;
  /**
   * Seconds of the interval no earlier closed interval of the computer
   * covered: summed per computer, the time it was in use, each second once.
   */
  seconds: number;
}

/** What new computer work is: a Bot's run, a coding session, or the member's own use. */
export type ComputerWorkKind = 'run' | 'coding_session' | 'manual';

/**
 * New work that would use a member's computer (services/computer-admission.ts),
 * asked before it begins: a run's first computer call (and, with
 * `continuingSince`, each later one), a coding session's start, and the
 * member's own start, wake or terminal.
 */
export interface ComputerWorkRequest {
  workspaceId: string;
  /** The member whose computer it is. */
  ownerId: string;
  kind: ComputerWorkKind;
  botId?: string;
  runId?: string;
  sessionId?: string;
  /**
   * Set for a run's later computer calls: when the run's use of the computer
   * began. Work in progress is never refused on the organization's grounds,
   * only by a cap on one run's own length.
   */
  continuingSince?: Date;
}

/** Why new computer work may not start: a stable code and a plain sentence for the person. */
export interface ComputerWorkRefusal {
  /** Upper case letters, digits and underscores, such as `SPENDING_CEILING_REACHED`. */
  code: string;
  /** Plain sentences. The first one stands alone, since a closing socket carries only it. */
  message: string;
}

export interface ServerExtensions {
  /**
   * The extension manages organizations: creating them, invitations and
   * roles. `OPENBOTS_DEPLOYMENT=managed` needs it (`runServer` refuses
   * otherwise), since the core alone has no way to make an organization.
   */
  organizations?: boolean;
  /**
   * Every request needs an account whose email is verified (403
   * EMAIL_NOT_VERIFIED otherwise), its API keys included. The managed build
   * verifies email at sign-up.
   */
  requireVerifiedEmail?: boolean;
  /** better-auth plugins added after the core's; they may bring database hooks. */
  authPlugins?(context: ExtensionContext): BetterAuthPlugin[];
  /** Mounts more routes on the app, before the SPA fallback. */
  routes?(app: OpenAPIHono<AppEnv>): void;
  /** Hides secrets in a request path before it is logged, as webhook tokens are. */
  redactPath?(path: string): string;
  /** The web build to serve instead of `apps/web/dist`. */
  webDist?: string;
  /**
   * The most an organization's limits may be (plan 21.6): its plan's on the
   * managed service (ee/server billing). Without it the operator's limits (OPENBOTS_LIMITS_*) are
   * every organization's ceiling. Owners and admins may lower limits under
   * it, never raise them above it. `db` is the caller's handle, a transaction
   * when the caller is in one, so a read here never waits on it.
   */
  limitsCeiling?(workspace: Workspace, config: Config, db: Db): Limits | Promise<Limits>;
  /**
   * Asked before new work uses a member's computer (plan 9.5, 21.6): null
   * lets it begin, a refusal stops it before it starts (402 with the
   * refusal's code, or the tool's error in a run). Never asked about work
   * already under way, except a run's own later calls (`continuingSince`).
   * A throw is logged and the work goes ahead, as with no extension.
   */
  admitComputerWork?(
    request: ComputerWorkRequest,
  ): ComputerWorkRefusal | null | Promise<ComputerWorkRefusal | null>;
  /**
   * Called once each time a computer usage interval closes, after it is
   * stored (plan 9.5): for usage billing. A throw is logged, never retried,
   * and the interval stays; the ledger table is the record to reconcile from.
   */
  onComputerUsage?(event: ComputerUsageEvent): void | Promise<void>;
}
