import { randomBytes } from 'node:crypto';
import type { AppDeps } from '../context.js';
import { inWorkspace } from '../db/scope.js';
import {
  closeUsageInterval,
  heartbeatUsageInterval,
  openUsageInterval,
  SPRITE_PAUSE_TAIL_MS,
  USAGE_HEARTBEAT_MS,
  type UsageTarget,
} from './computer-usage.js';

// A computer in use (plan 9.5): the one seam that a Bot's run, a coding
// session, a long command and an open terminal or screen socket go through
// while they need the computer. A use
//
// - marks the computer used every `touchMs` (the idle sweep's `last_used_at`),
//   as a command did every minute before;
// - on a provider that pauses itself when idle (Sprites), holds it awake under
//   this process's hold name while any use that asks for it lasts, refreshing
//   the hold before it expires and releasing it when the last such use ends;
// - opens a usage interval (computer-usage.ts) with the computer's first use
//   in this process and closes it when the last one ends, plus the pause tail
//   on a provider that pauses itself; a use that begins within the tail
//   carries on the same interval.
//
// Uses are counted per computer in this process; each process holds under
// its own name, so one process's release never drops another's hold. A
// process that dies leaves its hold to expire (`USE_HOLD_SECONDS`) and its
// interval to be closed at its last heartbeat. Shutdown ends every use
// (`endAllComputerUses`).

/** How long one hold keeps the computer awake; refreshed well before it runs out. */
export const USE_HOLD_SECONDS = 15 * 60;
/** How often a held computer's hold is renewed. */
export const USE_HOLD_REFRESH_MS = 5 * 60_000;
/** The hold refresh, changeable by tests so they need not wait minutes. */
export const useTimings = { holdRefreshMs: USE_HOLD_REFRESH_MS };
/** How often a use marks the computer used, unless it says otherwise. */
export const USE_TOUCH_MS = 60_000;
/** This process's hold name: a provider keeps one hold per name. */
export const USE_HOLD_NAME = `use-${randomBytes(4).toString('hex')}`;

/** What a use is for; the interval it opens keeps the first one's. */
export type UseReason = 'run' | 'coding_session' | 'exec' | 'terminal' | 'screen';

type Deps = Pick<AppDeps, 'db' | 'logger' | 'extensions'>;

/** The computer a use is of, and what the provider offers for it. */
export interface UseTarget extends UsageTarget {
  /** Marks the computer used now (`touchComputer`). */
  touch(): Promise<void>;
  /** Set when the provider pauses the computer itself when idle and can hold it awake. */
  hold?: {
    hold(name: string, seconds: number): Promise<void>;
    release(name: string): Promise<void>;
  };
}

export interface UseOptions {
  /** How often this use marks the computer used; `null` never (a socket's frames do). */
  touchMs?: number | null;
  /** Holds a computer that pauses itself awake; a socket needs not, its connection does. */
  hold?: boolean;
}

export interface ComputerUse {
  /** Ends the use; resolves once its hold, if it was the last, is released. Safe to call twice. */
  end(): Promise<void>;
}

interface Entry {
  deps: Deps;
  target: UseTarget;
  uses: number;
  holders: number;
  /** When the current run of uses began: the computer has been awake since. */
  since: number;
  interval: Promise<string | null>;
  heartbeat: ReturnType<typeof setInterval>;
  refresh: ReturnType<typeof setInterval> | null;
  /** The interval's close, waiting out the pause tail. */
  tail: ReturnType<typeof setTimeout> | null;
  /** Where the interval ends if nothing uses the computer again before the tail runs out. */
  tailEnd: Date | null;
  /** Holds and releases in order, so a release never overtakes its hold. */
  holdChain: Promise<void>;
  closed: boolean;
}

const entries = new Map<string, Entry>();
const pending = new Set<Promise<unknown>>();

function track<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  void promise.finally(() => pending.delete(promise)).catch(() => {});
  return promise;
}

/** For tests: resolves once every hold, release and interval write under way is done. */
export async function settleComputerUses(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** When this process's current run of uses of the computer began, or null if none. */
export function inUseSince(computerId: string): number | null {
  return entries.get(computerId)?.since ?? null;
}

function scoped<T>(entry: Entry, fn: () => Promise<T>): Promise<T> {
  return inWorkspace(entry.target.workspaceId, fn);
}

function changeHold(entry: Entry, acquire: boolean) {
  const hold = entry.target.hold;
  if (!hold) return entry.holdChain;
  const { deps, target } = entry;
  entry.holdChain = track(
    entry.holdChain
      .then(() =>
        acquire ? hold.hold(USE_HOLD_NAME, USE_HOLD_SECONDS) : hold.release(USE_HOLD_NAME),
      )
      .catch((error: unknown) =>
        deps.logger.warn(
          { err: error, computerId: target.computerId },
          acquire ? 'holding the computer awake failed' : 'releasing the hold failed',
        ),
      ),
  );
  return entry.holdChain;
}

function startHolding(entry: Entry) {
  void changeHold(entry, true);
  entry.refresh = setInterval(() => void changeHold(entry, true), useTimings.holdRefreshMs);
  entry.refresh.unref();
}

function stopHolding(entry: Entry) {
  if (entry.refresh) clearInterval(entry.refresh);
  entry.refresh = null;
  return changeHold(entry, false);
}

/** Closes the entry's interval at `endedAt` and forgets the entry. */
function closeEntry(entry: Entry, endedAt: Date) {
  entry.closed = true;
  clearInterval(entry.heartbeat);
  if (entry.refresh) clearInterval(entry.refresh);
  if (entry.tail) clearTimeout(entry.tail);
  if (entries.get(entry.target.computerId) === entry) entries.delete(entry.target.computerId);
  return track(
    entry.interval.then(async (id) => {
      if (!id) return;
      try {
        await scoped(entry, () => closeUsageInterval(entry.deps, id, endedAt));
      } catch (error) {
        entry.deps.logger.warn(
          { err: error, computerId: entry.target.computerId },
          'closing a computer usage interval failed',
        );
      }
    }),
  );
}

function entryFor(deps: Deps, target: UseTarget, reason: UseReason): Entry {
  const known = entries.get(target.computerId);
  if (known) {
    if (known.tail) {
      // Used again before its pause tail ran out: the same stretch goes on.
      clearTimeout(known.tail);
      known.tail = null;
      known.tailEnd = null;
    }
    return known;
  }
  const now = new Date();
  const entry: Entry = {
    deps,
    target,
    uses: 0,
    holders: 0,
    since: now.getTime(),
    interval: Promise.resolve(null),
    heartbeat: setInterval(() => {
      void track(
        entry.interval.then((id) =>
          id
            ? scoped(entry, () => heartbeatUsageInterval(deps, id)).catch((error: unknown) =>
                deps.logger.warn({ err: error }, 'computer usage heartbeat failed'),
              )
            : undefined,
        ),
      );
    }, USAGE_HEARTBEAT_MS),
    refresh: null,
    tail: null,
    tailEnd: null,
    holdChain: Promise.resolve(),
    closed: false,
  };
  entry.heartbeat.unref();
  const { touch: _touch, hold: _hold, ...usage } = target;
  entry.interval = track(
    scoped(entry, () => openUsageInterval(deps, usage, reason, now)).catch((error: unknown) => {
      deps.logger.warn(
        { err: error, computerId: target.computerId },
        'opening a computer usage interval failed',
      );
      return null;
    }),
  );
  entries.set(target.computerId, entry);
  return entry;
}

/** Begins a use of the computer; end it when the work ends, fails or is cancelled. */
export function beginUse(
  deps: Deps,
  target: UseTarget,
  reason: UseReason,
  { touchMs = USE_TOUCH_MS, hold = true }: UseOptions = {},
): ComputerUse {
  const entry = entryFor(deps, target, reason);
  entry.uses++;
  const holds = hold && !!target.hold;
  if (holds && entry.holders++ === 0) startHolding(entry);
  const touch =
    touchMs === null
      ? null
      : setInterval(() => {
          target
            .touch()
            .catch((error: unknown) =>
              deps.logger.warn(
                { err: error, computerId: target.computerId },
                'marking the computer used failed',
              ),
            );
        }, touchMs);
  touch?.unref();
  let ended: Promise<void> | null = null;
  return {
    end() {
      ended ??= (async () => {
        if (touch) clearInterval(touch);
        if (entry.closed) return;
        const released = holds && --entry.holders === 0 ? stopHolding(entry) : null;
        if (--entry.uses === 0) {
          const tailMs = target.hold ? SPRITE_PAUSE_TAIL_MS : 0;
          const end = new Date(Date.now() + tailMs);
          if (tailMs === 0) void closeEntry(entry, end);
          else {
            entry.tailEnd = end;
            entry.tail = setTimeout(() => void closeEntry(entry, end), tailMs);
            entry.tail.unref();
          }
        }
        await released;
      })();
      return ended;
    },
  };
}

/**
 * Ends every use in this process now (shutdown): releases its holds and
 * closes its intervals, at the end of the pause tail for a computer already
 * unused, else now. Uses ended after this do nothing.
 */
export async function endAllComputerUses(): Promise<void> {
  const now = Date.now();
  for (const entry of [...entries.values()]) {
    const releasing = entry.holders > 0 ? stopHolding(entry) : null;
    entry.holders = 0;
    void closeEntry(entry, entry.uses === 0 && entry.tailEnd ? entry.tailEnd : new Date(now));
    await releasing;
  }
  await settleComputerUses();
}
