import { createHash } from 'node:crypto';
import type { Unsubscribe } from '@openbots/shared';
import { sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import type { Db } from '../db/client.js';
import { outsideScope, rowsOf } from '../db/scope.js';
import { bestEffort } from './best-effort.js';

// The fence a reset puts around the machine it took away (computer-retire.ts,
// computer.ts `destroyComputer`). Once the machine is off the computer,
// nothing in any process may talk to its agent again, while it is being
// deleted and after: not a request or job that read the computer's row before
// the reset, not an open terminal or screen socket, not a sign-in still
// running in a worker, not a use's hold.
//
// The fence is the row's sealed agent token as it was (its SHA-256: the
// ciphertext is unique to the machine's provisioning). A row read before the
// reset still carries it, and `isFenced` refuses it; the computer's next
// machine is provisioned with a new token, so the fence never has to be lifted.
//
// The database is where a fence lives: the record of the old machine
// (`retired_computers.fence`) is written in the same transaction that takes
// the machine off the computer's row. Every process reads the fences from
// there when it starts listening and then every `FENCE_POLL_MS`
// (openbots_computer_fences(), drizzle/0045), so a process that started later
// or missed a message still refuses the token; the bus
// (`COMPUTER_FENCE_CHANNEL`) is the fast path, so every process adds it at once
// and closes what it has open on that machine (ws/computer.ts,
// coder-login-driver.ts). A reset that deletes the machine with no record
// (Docker) fences it over the bus only: its machine is gone with it.

export const COMPUTER_FENCE_CHANNEL = 'openbots:computer:fenced';

export interface ComputerFence {
  computerId: string;
  /** The SHA-256, hex, of the row's sealed agent token at the reset. */
  fence: string;
  /** The computer's owner and organization, for what ends the owner's work on it. */
  ownerId?: string;
  workspaceId?: string;
}

/**
 * Fences this process knows of, each with when it may be forgotten
 * (`FENCE_HISTORY_MS` after its record), far past any read of a row made
 * before the reset. Only an expired one is ever dropped, so no number of
 * resets can push a live fence out.
 */
const fenced = new Map<string, number>();
/** How often each process reads the fences recorded since its last read. */
export const FENCE_POLL_MS = 10_000;
/** How far back a read reaches past the last one: a record committed late is still seen. */
const FENCE_POLL_OVERLAP_MS = 10 * 60_000;
/** How far back the first read reaches, and how long a fence is kept. */
export const FENCE_HISTORY_MS = 8 * 24 * 60 * 60_000;
/** How often the expired fences are looked for. */
const FENCE_PRUNE_MS = 60 * 60_000;
let pruned = 0;
const listening = new WeakMap<object, Promise<Unsubscribe>>();
const watchers = new Set<(fence: ComputerFence) => void>();

/** For tests: forgets every fence, as a process that just started would know none. */
export function forgetFences(): void {
  fenced.clear();
}

/** The fence of a row's sealed agent token; null when it has none. */
export function fenceOf(agentToken: Uint8Array | null | undefined): string | null {
  return agentToken ? createHash('sha256').update(agentToken).digest('hex') : null;
}

function remember(fence: string, since: number) {
  const now = Date.now();
  if (now - pruned >= FENCE_PRUNE_MS) {
    pruned = now;
    for (const [known, until] of fenced) if (until <= now) fenced.delete(known);
  }
  fenced.set(fence, Math.max(fenced.get(fence) ?? 0, since + FENCE_HISTORY_MS));
}

/** Whether a row read before a reset names the machine that reset took away. */
export function isFenced(row: { agentToken: Uint8Array | null }): boolean {
  const fence = fenceOf(row.agentToken);
  return fence !== null && fenced.has(fence);
}

function deliver(message: ComputerFence, since = Date.now()) {
  if (fenced.has(message.fence)) return;
  remember(message.fence, since);
  for (const watcher of watchers) {
    try {
      watcher(message);
    } catch {
      // One watcher's failure does not stop the others.
    }
  }
}

/**
 * Reads the fences recorded since `since` (every organization's; hashes and
 * computer ids only) and adds the new ones, telling the watchers. Returns
 * how many it read.
 */
export async function loadFences(db: Db, since: Date): Promise<number> {
  const result = await outsideScope(() =>
    db.execute(
      sql`select computer_id, owner_id, workspace_id, fence, created_at from openbots_computer_fences(${since.toISOString()}::timestamptz)`,
    ),
  );
  const rows = rowsOf<{
    computer_id: string | null;
    owner_id: string;
    workspace_id: string;
    fence: string;
    created_at: string | Date;
  }>(result);
  for (const row of rows) {
    deliver(
      {
        computerId: row.computer_id ?? '',
        fence: row.fence,
        ownerId: row.owner_id,
        workspaceId: row.workspace_id,
      },
      new Date(row.created_at).getTime(),
    );
  }
  return rows.length;
}

/**
 * Subscribes this process to the fences other processes publish, and reads
 * the recorded ones now and every `FENCE_POLL_MS`; once per bus. The API and
 * worker roles call it as they start, and it settles once the first read
 * is done. Its result stops both.
 */
export function listenForFences(deps: {
  db: Db;
  logger: Pick<AppDeps['logger'], 'warn'>;
  infra: Pick<AppDeps['infra'], 'bus'>;
}): Promise<Unsubscribe> {
  const bus = deps.infra.bus;
  let ready = listening.get(bus);
  if (!ready) {
    ready = (async () => {
      const unsubscribe = await bus.subscribe<ComputerFence>(COMPUTER_FENCE_CHANNEL, (msg) => {
        if (typeof msg?.computerId !== 'string' || typeof msg.fence !== 'string') return;
        deliver({
          computerId: msg.computerId,
          fence: msg.fence,
          ...(typeof msg.ownerId === 'string' && typeof msg.workspaceId === 'string'
            ? { ownerId: msg.ownerId, workspaceId: msg.workspaceId }
            : {}),
        });
      });
      let since = new Date(Date.now() - FENCE_HISTORY_MS);
      const poll = async () => {
        const started = Date.now();
        try {
          await loadFences(deps.db, since);
          since = new Date(started - FENCE_POLL_OVERLAP_MS);
        } catch (error) {
          deps.logger.warn({ err: error }, 'reading the computer fences failed');
        }
      };
      await poll();
      const timer = setInterval(() => void poll(), FENCE_POLL_MS);
      timer.unref?.();
      return async () => {
        clearInterval(timer);
        listening.delete(bus);
        await unsubscribe();
      };
    })();
    listening.set(bus, ready);
  }
  return ready;
}

/**
 * Called with every fence this process learns of, its own included, from the
 * bus or from the database: for what holds a machine open (sockets, a
 * sign-in, coding sessions, stdio connectors). Returns the way to stop.
 */
export function watchFences(watcher: (fence: ComputerFence) => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/**
 * Fences the machine `row` had in this process only, at once (no I/O). The
 * message, or null when the row had no token.
 */
export function fenceHere(row: {
  id: string;
  agentToken?: Uint8Array | null;
  fence?: string | null;
  ownerId?: string;
  workspaceId?: string;
}): ComputerFence | null {
  const fence = row.fence ?? fenceOf(row.agentToken);
  if (!fence) return null;
  const message: ComputerFence = {
    computerId: row.id,
    fence,
    ...(row.ownerId && row.workspaceId
      ? { ownerId: row.ownerId, workspaceId: row.workspaceId }
      : {}),
  };
  deliver(message);
  return message;
}

/**
 * Fences the machine `row` had (its agent token, or the `fence` a record
 * holds): here at once, then in every other process. A bus that fails is
 * logged, not thrown: the record holds the fence, which every process reads
 * within `FENCE_POLL_MS`.
 */
export async function fenceComputer(
  deps: Pick<AppDeps, 'logger'> & { infra: Pick<AppDeps['infra'], 'bus'> },
  row: {
    id: string;
    agentToken?: Uint8Array | null;
    fence?: string | null;
    ownerId?: string;
    workspaceId?: string;
  },
): Promise<void> {
  const message = fenceHere(row);
  if (!message) return;
  await bestEffort(
    deps.infra.bus.publish<ComputerFence>(COMPUTER_FENCE_CHANNEL, message),
    (error) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'publishing a computer fence failed'),
  );
}
