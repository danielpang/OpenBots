import { createHash } from 'node:crypto';
import type { Unsubscribe } from '@openbots/shared';
import type { AppDeps } from '../context.js';

// The fence a reset puts around the machine it took away (computer-retire.ts,
// computer.ts `destroyComputer`). Once the machine is out of reach, nothing in
// any process may talk to its agent again: not a request or job that read the
// computer's row before the reset, not an open terminal or screen socket, not
// a sign-in still running in a worker.
//
// The fence is the row's sealed agent token as it was (its SHA-256: the
// ciphertext is unique to the machine's provisioning). A row read before the
// reset still carries it, and `isFenced` refuses it; the computer's next
// machine is provisioned with a new token, so the fence never has to be lifted,
// even when an operator restores the old machine. The reset publishes it on
// `COMPUTER_FENCE_CHANNEL`, so every process adds it and closes what it has
// open on that machine (ws/computer.ts, coder-login-driver.ts). A process that
// starts later reads rows that have no token, so it needs no history.

export const COMPUTER_FENCE_CHANNEL = 'openbots:computer:fenced';

export interface ComputerFence {
  computerId: string;
  /** The SHA-256, hex, of the row's sealed agent token at the reset. */
  fence: string;
}

/** Fences this process knows of; a few per reset, so a bounded set is plenty. */
const fenced = new Set<string>();
const FENCES_KEPT = 10_000;
const listening = new WeakMap<object, Promise<Unsubscribe>>();
const watchers = new Set<(fence: ComputerFence) => void>();

/** The fence of a row's sealed agent token; null when it has none. */
export function fenceOf(agentToken: Uint8Array | null | undefined): string | null {
  return agentToken ? createHash('sha256').update(agentToken).digest('hex') : null;
}

function remember(fence: string) {
  if (fenced.size >= FENCES_KEPT) fenced.delete(fenced.values().next().value!);
  fenced.add(fence);
}

/** Whether a row read before a reset names the machine that reset took away. */
export function isFenced(row: { agentToken: Uint8Array | null }): boolean {
  const fence = fenceOf(row.agentToken);
  return fence !== null && fenced.has(fence);
}

function deliver(message: ComputerFence) {
  remember(message.fence);
  for (const watcher of watchers) {
    try {
      watcher(message);
    } catch {
      // One watcher's failure does not stop the others.
    }
  }
}

/**
 * Subscribes this process to the fences other processes publish; once per
 * bus. The API and worker roles call it as they start.
 */
export function listenForFences(deps: {
  infra: Pick<AppDeps['infra'], 'bus'>;
}): Promise<Unsubscribe> {
  const bus = deps.infra.bus;
  let ready = listening.get(bus);
  if (!ready) {
    ready = bus.subscribe<ComputerFence>(COMPUTER_FENCE_CHANNEL, (msg) => {
      if (typeof msg?.computerId !== 'string' || typeof msg.fence !== 'string') return;
      deliver({ computerId: msg.computerId, fence: msg.fence });
    });
    listening.set(bus, ready);
  }
  return ready;
}

/**
 * Called with every fence this process learns of, its own included; for what
 * holds a machine open (sockets, a sign-in). Returns the way to stop.
 */
export function watchFences(watcher: (fence: ComputerFence) => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/**
 * Fences the machine `row` had: here at once, then in every other process.
 * A bus that fails is logged, not thrown: the machine itself is already out
 * of reach, which is what the fence backs up.
 */
export async function fenceComputer(
  deps: Pick<AppDeps, 'logger'> & { infra: Pick<AppDeps['infra'], 'bus'> },
  row: { id: string; agentToken: Uint8Array | null },
): Promise<void> {
  const fence = fenceOf(row.agentToken);
  if (!fence) return;
  const message = { computerId: row.id, fence };
  deliver(message);
  await deps.infra.bus
    .publish<ComputerFence>(COMPUTER_FENCE_CHANNEL, message)
    .catch((error: unknown) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'publishing a computer fence failed'),
    );
}
