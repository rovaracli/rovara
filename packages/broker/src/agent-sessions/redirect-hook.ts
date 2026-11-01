// Stop & redirect: the one place the broker's terminal-result path and the stuck-cancel path ask "has a stop that a redirect is waiting for landed?" (live-interaction design 3.1, phase 2).
// Those paths hold the table client and little else, so the broker registers the continuation against its client when the `rd` switch is on, and they call `continueRedirectAfterStop(client, taskId)`.
// With the switch off nothing is registered and the call returns at once, reading nothing. It never throws: a result must not fail for a redirect.
type Continuation = (taskId: string) => Promise<void>;

const continuations = new WeakMap<object, Continuation>();

/** Registers (or, with `undefined`, removes) the continuation for the broker whose table client this is. */
export function registerRedirectContinuation(client: object, continuation: Continuation | undefined): void {
  if (continuation === undefined) continuations.delete(client);
  else continuations.set(client, continuation);
}

/** Asks the continuation registered for this table client, if any, to carry on the task's redirect. */
export async function continueRedirectAfterStop(client: object, taskId: string): Promise<void> {
  const continuation = continuations.get(client);
  if (continuation === undefined) return;
  try {
    await continuation(taskId);
  } catch {
    // A redirect that could not be carried on stays `stopping`; the sweep closes it. The result that called this is not failed for it.
  }
}
