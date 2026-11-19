import type { AppDeps } from '../context.js';
import { DomainError } from '../errors.js';
import type { ComputerWorkRefusal, ComputerWorkRequest } from '../extensions.js';

// Whether new work may use a member's computer (plan 9.5, 21.6). The managed
// build answers through `ServerExtensions.admitComputerWork` (its plans and
// spending limits); a self-hosted server has no extension and every request
// is admitted, exactly as before. It is asked where work begins: a run's
// first computer call, a coding session's start, the member's own start,
// wake or terminal. Work already under way is never asked about, so a
// refusal only stops what has not started yet. A run's later calls are
// asked with `continuingSince`, for a cap on the length of one run.

/** The HTTP status of a refusal: the work needs something only billing can give. */
export const COMPUTER_REFUSED_STATUS = 402;

/** The code when an extension's own is not one: upper case, digits and underscores. */
export const COMPUTER_WORK_REFUSED = 'COMPUTER_WORK_REFUSED';

const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

type Deps = Pick<AppDeps, 'extensions' | 'logger'>;

/** The refusal as a problem: 402 with the extension's stable code and its words. */
export function computerRefused(refusal: ComputerWorkRefusal): DomainError {
  return new DomainError(
    COMPUTER_REFUSED_STATUS,
    CODE.test(refusal.code) ? refusal.code : COMPUTER_WORK_REFUSED,
    refusal.message,
  );
}

/**
 * The extension's answer, or null when the work may begin. A failing
 * extension is logged and admits: the managed build never bills past what an
 * organization allowed (ee/server billing), so admitting cannot overcharge,
 * and a fault there must not stop every member's work.
 */
export async function computerWorkRefusal(
  deps: Deps,
  request: ComputerWorkRequest,
): Promise<ComputerWorkRefusal | null> {
  const admit = deps.extensions?.admitComputerWork;
  if (!admit) return null;
  try {
    return (await admit(request)) ?? null;
  } catch (error) {
    deps.logger.warn(
      { err: error, workspaceId: request.workspaceId, kind: request.kind },
      'the computer admission extension failed; the work goes ahead',
    );
    return null;
  }
}

/** Throws the refusal (402) when the work may not begin. */
export async function admitComputerWork(deps: Deps, request: ComputerWorkRequest): Promise<void> {
  const refusal = await computerWorkRefusal(deps, request);
  if (refusal) throw computerRefused(refusal);
}

/**
 * The refusal's first sentence, at most `max` bytes: a WebSocket close
 * reason holds 123, so a refused terminal carries what fits.
 */
export function shortReason(message: string, max = 123): string {
  const first = /^.*?[.!?](?=\s|$)/.exec(message.trim())?.[0] ?? message.trim();
  if (Buffer.byteLength(first) <= max) return first;
  let cut = first;
  while (Buffer.byteLength(`${cut}…`) > max) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}
