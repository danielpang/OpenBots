import { CODERS_QUEUE, REPO_FETCH_INTERVAL_MS, type JobHandler } from '@openbots/shared';
import type { AppDeps } from './context.js';
import { forEachWorkspace } from './db/scope.js';
import {
  EVENT_DELIVERIES_QUEUE,
  eventDeliveryHandler,
  requeuePendingEventDeliveries,
  startEventFanOut,
} from './hooks/outbound.js';
import { APPROVALS_QUEUE, expireDueApprovals, expiryHandler } from './services/approvals.js';
import { AUDIT_TRIM_MS, trimAuditLog } from './services/audit.js';
import { BOT_STATE_QUEUE, settleHandler } from './services/bot-state.js';
import { newLogSweep } from './services/coder-log.js';
import { recoverInterruptedCoderSessions, sweepSessionLogs } from './services/coder-recovery.js';
import { createCoderWorker } from './services/coder-runner.js';
import { PAIRING_SWEEP_MS, expireDuePairings } from './services/devices.js';
import {
  COMPUTERS_QUEUE,
  computerProvider,
  IDLE_SWEEP_MS,
  provisionHandler,
  recoverProvisioning,
  refreshSandboxImage,
  sweepIdleComputers,
} from './services/computer.js';
import {
  RETIRED_COMPUTERS_QUEUE,
  RETIRED_SWEEP_MS,
  retiredComputerHandler,
  sweepRetiredComputers,
} from './services/computer-retire.js';
import { listenForFences } from './services/computer-fence.js';
import { closeDanglingUsage } from './services/computer-usage.js';
import { endAllComputerUses } from './services/computer-use.js';
import { expireDueLoginRequests, LOGINS_QUEUE, loginExpiryHandler } from './services/logins.js';
import { MEMORIES_QUEUE, reembedHandler } from './services/memories.js';
import { startRoutineScheduler } from './services/routines.js';
import { queueRepoReconciles, queueRepoRefreshes } from './services/repos-refresh.js';
import { queueRepoScans } from './services/repos-scan.js';
import { RUNS_QUEUE } from './services/runs.js';
import { startPushWorker } from './workers/push.js';
import { createRunWorker, recoverInterruptedRuns } from './workers/runs.js';

/**
 * Job handlers by queue name. Later leaves add theirs (runs in 1.B, approval
 * expiry in 2.2, webhook deliveries in 6.3); each queue is processed by the
 * `worker` and `all` roles.
 */
export const JOB_HANDLERS: Record<
  string,
  { handler: (deps: AppDeps) => JobHandler; concurrency?: number }
> = {
  [BOT_STATE_QUEUE]: { handler: settleHandler as (deps: AppDeps) => JobHandler, concurrency: 4 },
  // One job per Bot at a time (groupKey = Bot id); this is runs across Bots.
  [RUNS_QUEUE]: { handler: (deps) => createRunWorker(deps) as JobHandler, concurrency: 8 },
  // One delayed job per approval request, due when it expires (plan 5.6).
  [APPROVALS_QUEUE]: { handler: expiryHandler as (deps: AppDeps) => JobHandler, concurrency: 2 },
  // One delayed job per sign-in request, due when it expires like an approval (plan 9.7).
  [LOGINS_QUEUE]: { handler: loginExpiryHandler as (deps: AppDeps) => JobHandler, concurrency: 2 },
  // Outbound event subscriptions, retried with backoff (plan 11, H6).
  [EVENT_DELIVERIES_QUEUE]: {
    handler: (deps) => eventDeliveryHandler(deps) as JobHandler,
    concurrency: 4,
  },
  // One job per coding session, checkout or agent sign-in (I12).
  [CODERS_QUEUE]: { handler: (deps) => createCoderWorker(deps) as JobHandler, concurrency: 8 },
  // A Bot's memories re-embedded after its embedding source changed (M1).
  [MEMORIES_QUEUE]: { handler: (deps) => reembedHandler(deps) as JobHandler, concurrency: 2 },
  // Making and provisioning Sprites (plan 9.5), one job per computer at a time (groupKey).
  [COMPUTERS_QUEUE]: { handler: (deps) => provisionHandler(deps) as JobHandler, concurrency: 4 },
  // The old machines of full resets, deleted; a deletion that failed is retried.
  [RETIRED_COMPUTERS_QUEUE]: {
    handler: (deps) => retiredComputerHandler(deps, () => computerProvider(deps)) as JobHandler,
    concurrency: 2,
  },
};

/**
 * Work for every organization (db/scope.ts): `fn` runs in each one's scope
 * in turn, and the counts add up.
 */
export async function inEveryOrganization(
  deps: Pick<AppDeps, 'db'>,
  fn: () => Promise<number>,
): Promise<number> {
  const counts = await forEachWorkspace(deps.db, fn);
  return counts.reduce((sum, n) => sum + n, 0);
}

/** Background work for the `worker` and `all` roles (queues, scheduler). */
export async function startWorkers(deps: AppDeps): Promise<{ stop(): Promise<void> }> {
  const { infra, logger } = deps;
  // One sweep of session logs across organizations: this disk is judged once in it.
  const logSweep = newLogSweep();
  // A reset in another process fences the machine it took away here too
  // (computer-fence.ts): jobs and sign-ins that read the row before it stop.
  await listenForFences(deps);
  // In-process queues cannot outlive the process, so its running runs are queued again.
  if (infra.kind === 'memory') {
    const recovered = await inEveryOrganization(deps, () => recoverInterruptedRuns(deps));
    if (recovered) logger.warn({ runs: recovered }, 'took over runs interrupted by a restart');
    const sessions = await inEveryOrganization(deps, () =>
      recoverInterruptedCoderSessions(deps, logSweep),
    );
    if (sessions) logger.warn({ sessions }, 'recovered coding sessions interrupted by a restart');
    const requeued = await inEveryOrganization(deps, () => requeuePendingEventDeliveries(deps));
    if (requeued) logger.info({ deliveries: requeued }, 'requeued pending event deliveries');
  } else if (deps.config.storage.driver === 's3') {
    // Shared queues keep their sessions; the logs in the shared store still
    // want their upkeep (recoverInterruptedCoderSessions does it above).
    await inEveryOrganization(deps, async () => {
      await sweepSessionLogs(deps, logSweep);
      return 0;
    });
  }
  // Requests that came due while no worker was up, or whose in-memory job was lost.
  const expired = await inEveryOrganization(deps, () => expireDueApprovals(deps));
  if (expired) logger.info({ approvals: expired }, 'expired overdue approval requests');
  const logins = await inEveryOrganization(deps, () => expireDueLoginRequests(deps));
  if (logins) logger.info({ logins }, 'expired overdue sign-in requests');
  // Usage intervals a process that died left open, closed at their last heartbeat (plan 9.5).
  const dangling = await inEveryOrganization(deps, () => closeDanglingUsage(deps));
  if (dangling) logger.info({ intervals: dangling }, 'closed computer usage left open');
  for (const [name, { handler, concurrency }] of Object.entries(JOB_HANDLERS)) {
    await infra.queue(name).process(handler(deps), {
      concurrency,
      onError: (err, job) => logger.error({ err, queue: name, jobId: job.id }, 'job failed'),
    });
  }
  // Provisionings a restart cut short start again; a queued one finds its work done.
  inEveryOrganization(deps, () => recoverProvisioning(deps)).then(
    (requeued) =>
      requeued && logger.warn({ computers: requeued }, 'requeued computer provisioning'),
    (err: unknown) => logger.error({ err }, 'requeueing computer provisioning failed'),
  );
  // A new release's computer image, for computers to move to at their next start (plan 16.3).
  void refreshSandboxImage(deps);
  // Idle computers stop after their timeout (plan 9.5); the home volume stays.
  const sweep = setInterval(() => {
    inEveryOrganization(deps, () => sweepIdleComputers(deps)).then(
      (stopped) => stopped && logger.info({ computers: stopped }, 'stopped idle computers'),
      (err: unknown) => logger.error({ err }, 'idle computer sweep failed'),
    );
    inEveryOrganization(deps, () => closeDanglingUsage(deps)).catch((err: unknown) =>
      logger.error({ err }, 'closing dangling computer usage failed'),
    );
  }, IDLE_SWEEP_MS);
  sweep.unref();
  // Old machines of full resets whose deletion failed or never ran are
  // deleted, now and every five minutes, in every worker (each row is
  // claimed by one).
  const sweepRetired = () =>
    inEveryOrganization(deps, () => sweepRetiredComputers(deps)).then(
      (queued) => queued && logger.info({ computers: queued }, 'queued old computers to delete'),
      (err: unknown) => logger.error({ err }, 'retired computer sweep failed'),
    );
  void sweepRetired();
  const retired = setInterval(sweepRetired, RETIRED_SWEEP_MS);
  retired.unref();
  // Every running computer gets its repositories back now (GH4): it may have
  // started while no worker ran, or its reconcile job been lost.
  inEveryOrganization(deps, () => queueRepoReconciles(deps)).catch((err: unknown) =>
    logger.error({ err }, 'queueing repository reconciles failed'),
  );
  // Each running computer's checkouts are fetched for their state every 15
  // minutes (GH3), and its clones nobody remembered looked for (GH6).
  const refreshRepos = setInterval(() => {
    inEveryOrganization(deps, () => queueRepoRefreshes(deps)).catch((err: unknown) =>
      logger.error({ err }, 'queueing repository refreshes failed'),
    );
    inEveryOrganization(deps, () => queueRepoScans(deps)).catch((err: unknown) =>
      logger.error({ err }, 'queueing repository scans failed'),
    );
  }, REPO_FETCH_INTERVAL_MS);
  refreshRepos.unref();
  // Audit rows past the workspace's retention (default 180 days, S-11); now and hourly.
  const trimAudit = () =>
    inEveryOrganization(deps, () => trimAuditLog(deps)).then(
      (trimmed) => trimmed && logger.info({ rows: trimmed }, 'trimmed the audit log'),
      (err: unknown) => logger.error({ err }, 'audit log trim failed'),
    );
  void trimAudit();
  const trim = setInterval(trimAudit, AUDIT_TRIM_MS);
  trim.unref();
  // Pairings used or past their 5 minutes are dropped; now and every few minutes (plan 4.5).
  const sweepPairings = () =>
    inEveryOrganization(deps, () => expireDuePairings(deps)).then(
      (dropped) => dropped && logger.info({ pairings: dropped }, 'dropped spent pairings'),
      (err: unknown) => logger.error({ err }, 'pairing sweep failed'),
    );
  void sweepPairings();
  const pairings = setInterval(sweepPairings, PAIRING_SWEEP_MS);
  pairings.unref();
  // Due Routines every 30 seconds, exactly once per slot across workers (plan 10.2).
  const stopScheduler = startRoutineScheduler(deps);
  // Bus events an owner subscribed to become signed outbound deliveries (H6).
  const stopFanOut = await startEventFanOut(deps);
  // Notices become encrypted pushes through the relay (RELAY_PROTOCOL.md 7), when there is one
  // and its link runs (it does not when the instance key could not be opened, server.ts).
  const push = deps.config.relayUrl && deps.relay ? await startPushWorker(deps) : null;
  logger.info({ queues: Object.keys(JOB_HANDLERS), infra: infra.kind }, 'workers started');
  // The queues themselves are closed with the infra in main.ts.
  return {
    stop: async () => {
      clearInterval(sweep);
      clearInterval(retired);
      clearInterval(refreshRepos);
      clearInterval(trim);
      clearInterval(pairings);
      stopScheduler();
      await stopFanOut();
      await push?.stop();
      await endAllComputerUses();
    },
  };
}
