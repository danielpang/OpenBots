/**
 * How long a status or control message on the bus is waited for in a path
 * that must answer (a reset, a stop): past it the path goes on, and the
 * message still goes out once the bus takes it. A bus that is down (Redis
 * retries a command for tens of seconds before it fails) delays nothing.
 */
export const BUS_WAIT_MS = 500;

/**
 * Waits for `work` at most `ms`. What it throws, then or later, goes to
 * `log`, never to the caller: for what is best effort, such as telling the
 * apps a status, which never changes what was done or answered.
 */
export async function bestEffort(
  work: Promise<unknown>,
  log: (error: unknown) => void,
  ms = BUS_WAIT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = work.then(
    () => undefined,
    (error: unknown) => log(error),
  );
  await Promise.race([
    settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}
