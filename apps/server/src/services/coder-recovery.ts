import type { CodingSessionStatus } from '@openbots/shared';
import { widgetToolResult } from '@openbots/widgets';
import { inArray } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { expireSessionApprovals } from './approvals.js';
import { newLogSweep, removeOrphanLogs, storeLeftoverSpools, type LogSweep } from './coder-log.js';
import { enqueueCoderJob } from './coder-jobs.js';
import { resumeWaitingRun } from './coder-run-resume.js';
import { settleSession, type CodingSessionRow } from './coder-state.js';

// Sessions an interrupted process left behind (docs/plans/TECHNICAL_PLAN.md 22.8):
// at worker start, and when a job finds a live session no process runs.

export const RESTART_NOTE =
  'The server restarted during the session; continue it to pick up where it left off';

/** The statuses a session runs in; a job finding one it does not run treats it as interrupted. */
export const LIVE: CodingSessionStatus[] = ['starting', 'running', 'waiting'];

/** A session left running by a process that is gone: failed with the note, its run told. */
export async function interruptSession(
  deps: AppDeps,
  row: CodingSessionRow,
  { runWaitMs = 0 }: { runWaitMs?: number } = {},
) {
  await expireSessionApprovals(deps, row.id);
  const state = await settleSession(deps, row.id, { status: 'failed', error: RESTART_NOTE });
  if (row.runId) {
    await resumeWaitingRun(deps, row.runId, widgetToolResult('coding_session', state), {
      waitMs: runWaitMs,
    });
  }
}

/**
 * Sessions an interrupted process left behind, at worker start (in-memory
 * infra, as `recoverInterruptedRuns`): a session that was running fails
 * with RESTART_NOTE and its run resumes with that (its log stays, since the
 * owner can continue it); a queued one, whose job died with the process, is
 * queued again. With the s3 storage driver, the log spools a run on this
 * machine left behind are stored (coder-log.ts). Logs whose session is gone
 * are removed.
 */
export async function recoverInterruptedCoderSessions(
  deps: AppDeps,
  sweep: LogSweep = newLogSweep(),
): Promise<number> {
  const rows = await deps.db
    .select()
    .from(schema.codingSessions)
    .where(inArray(schema.codingSessions.status, [...LIVE, 'queued']));
  for (const row of rows) {
    if (row.status === 'queued') {
      await enqueueCoderJob(deps, { kind: 'session', sessionId: row.id });
    } else {
      await interruptSession(deps, row);
    }
  }
  await sweepSessionLogs(deps, sweep);
  return rows.length;
}

/**
 * The upkeep of session logs at a worker's start, in an organization's
 * scope: spools left on this machine stored (s3 driver), then logs whose
 * session is gone removed, the files on this disk once per `sweep` (one
 * for every organization's pass) and a bounded share of the organization's
 * stored parts. Never fails the start.
 */
export async function sweepSessionLogs(
  deps: AppDeps,
  sweep: LogSweep = newLogSweep(),
): Promise<void> {
  await storeLeftoverSpools(deps).catch((error: unknown) =>
    deps.logger.warn({ err: error }, 'coding session log spools not stored'),
  );
  await removeOrphanLogs(deps, { sweep }).catch((error: unknown) =>
    deps.logger.warn({ err: error }, 'coding session logs not swept'),
  );
}

export { removeOrphanLogs } from './coder-log.js';
