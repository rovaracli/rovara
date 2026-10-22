// Follow-up N3: runs `work` over `items` with at most `limit` in flight, and settles every one (a rejection is kept, never thrown), in the items' order.
// For the scheduled egress reconciles, whose reads can go side by side but whose writes must not (they all touch the one sync marker).
/** Reads in flight at once in the scheduled egress reconciles. */
export const RECONCILE_READ_CONCURRENCY = 8;

export async function settleBounded<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const settled = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        settled[index] = { status: "fulfilled", value: await work(items[index]!) };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return settled;
}
