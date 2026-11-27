// The git identity writes a start leaves running on a computer (computer.ts
// `afterStart`), by computer id. Whatever takes a machine out of service (a
// stop, a reset) ends them first with `endStartWork`, so none of them calls a
// machine that is stopped, paused or being deleted, which would wake it.

const startWork = new Map<string, { controller: AbortController; done: Promise<void> }>();

/** Ends the writes a start left running on the computer: none begins after this. */
export function endStartWork(computerId: string): void {
  startWork.get(computerId)?.controller.abort();
}

/** Settles once the git identity writes a start left running on the computer have ended. */
export async function startWorkSettled(computerId: string): Promise<void> {
  await startWork.get(computerId)?.done;
}

/** Runs `work` as the computer's start work, ending any earlier one first. */
export function beginStartWork(
  computerId: string,
  work: (signal: AbortSignal) => Promise<void>,
): void {
  endStartWork(computerId);
  const controller = new AbortController();
  const done = work(controller.signal).finally(() => {
    if (startWork.get(computerId)?.controller === controller) startWork.delete(computerId);
  });
  startWork.set(computerId, { controller, done });
}
