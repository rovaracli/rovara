// TE-F1e item 3 and forks F2, F3, F5, F6, F8: the Cloud product meter on a DynamoDB fake with condition semantics. Each cap refuses on its own, at exactly the cap; two racing calls for the last dollar cannot both
// win; a settle is never refused and an overrun blocks the next call; the month turns on the 1st UTC; holds fund a whole run or nothing; leaked holds are recovered only after they expire.
import { describe, expect, it } from "vitest";
import {
  closeProductAiHold, isProductAiMeterKey, openProductAiHold, productAiMeterKeys, reserveInProductAiHold, reserveProductAiCall, settleInProductAiHold, settleProductAiCall, type ProductAiMeterCaps,
} from "../../packages/broker/src/product-ai/meter.js";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createOutboxPublisherHandler } from "../../packages/broker/src/aws/outbox-publisher.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as never;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as never;
const TASK = "33333333-3333-4333-8333-333333333333";
const NOV = Date.UTC(2026, 10, 14, 12);
const caps = (over: Partial<ProductAiMeterCaps> = {}): ProductAiMeterCaps => ({ taskMicros: 2_000_000, taskCalls: 200, projectMonthMicros: 50_000_000, ...over });

function meter(now = NOV) {
  const table = new FakeDynamoDb();
  let clock = now;
  const deps = { documentClient: table, tableName: "state", now: () => clock };
  return { table, deps, at: (ms: number) => { clock = ms; } };
}
const spent = (table: FakeDynamoDb, key: { pk: string; sk: string }) => table.get(key)?.spentMicros as number | undefined;
const committed = (table: FakeDynamoDb, key: { pk: string; sk: string }) => table.get(key)?.committed as number | undefined;

describe("product meter, per call", () => {
  it("reserves on the task, the project month and the company month together, then settles to the cost", async () => {
    const { table, deps } = meter();
    const reserved = await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1000, caps: caps() });
    expect(reserved.ok).toBe(true);
    for (const key of [productAiMeterKeys.task(TASK), productAiMeterKeys.project(A, "web", "2026-11"), productAiMeterKeys.company(A, "2026-11")]) expect(committed(table, key)).toBe(1000);
    if (!reserved.ok) return;
    expect(await settleProductAiCall(deps, reserved.reservation, 400)).toEqual({ overrun: false });
    for (const key of [productAiMeterKeys.task(TASK), productAiMeterKeys.project(A, "web", "2026-11"), productAiMeterKeys.company(A, "2026-11")]) {
      expect(committed(table, key)).toBe(400);
      expect(spent(table, key)).toBe(400);
      expect(table.get(key)?.reservedMicros).toBe(0);
    }
  });

  it("refuses at each cap on its own, allows exactly the cap, and writes nothing on a refusal", async () => {
    for (const [over, item] of [[{ taskMicros: 999 }, "task"], [{ projectMonthMicros: 999 }, "project"], [{ companyMonthMicros: 999 }, "company"]] as const) {
      const { table, deps } = meter();
      const refused = await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1000, caps: caps(over) });
      expect(refused, item).toMatchObject({ ok: false, reason: "cap", item });
      expect(table.find(() => true), item).toHaveLength(0);
      const exact = await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 999, caps: caps(over) });
      expect(exact.ok, item).toBe(true);
      // Spent plus reserved is now the cap: one more micro-dollar is refused, by the condition this time (the transaction).
      const next = await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1, caps: caps(over) });
      expect(next, item).toMatchObject({ ok: false, reason: "cap", item });
    }
  });

  it("names the task cap in the refusal, and refuses the call after the task's last allowed call", async () => {
    const { deps } = meter();
    expect(await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 3_000_000, caps: caps() })).toEqual({ ok: false, reason: "cap", item: "task", capMicros: 2_000_000 });
    for (let index = 0; index < 2; index += 1) expect((await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1, caps: caps({ taskCalls: 2 }) })).ok).toBe(true);
    expect(await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1, caps: caps({ taskCalls: 2 }) })).toEqual({ ok: false, reason: "calls", item: "task" });
  });

  it("two calls racing for the last dollar: exactly one wins", async () => {
    const { deps } = meter();
    const both = await Promise.all([1, 2].map(() => reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1_500_000, caps: caps() })));
    expect(both.filter((result) => result.ok)).toHaveLength(1);
    expect(both.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "cap", item: "task", capMicros: 2_000_000 }]);
  });

  it("a settle above the cap is never refused, marks the item overrun, and the next call is refused 'budget exceeded by one call'", async () => {
    const { table, deps } = meter();
    const reserved = await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1000, caps: caps() });
    if (!reserved.ok) throw new Error("reserve");
    expect(await settleProductAiCall(deps, reserved.reservation, 5_000_000)).toEqual({ overrun: true });
    expect(table.get(productAiMeterKeys.task(TASK))?.overrun).toBe(true);
    expect(await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1, caps: caps() })).toMatchObject({ ok: false, reason: "overrun", item: "task" });
    // Over the estimate but under the cap: nothing is blocked (DEC 165: the SPEND passing the cap is the overrun).
    const other = "44444444-4444-4444-8444-444444444444";
    const second = await reserveProductAiCall(deps, { orgId: A, project: "api", taskId: other, estimateMicros: 10, caps: caps() });
    if (!second.ok) throw new Error("reserve");
    expect(await settleProductAiCall(deps, second.reservation, 9_000)).toEqual({ overrun: false });
    expect((await reserveProductAiCall(deps, { orgId: A, project: "api", taskId: other, estimateMicros: 10, caps: caps() })).ok).toBe(true);
  });

  it("a reservation that never settles stays counted (errs high)", async () => {
    const { table, deps } = meter();
    await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1_900_000, caps: caps() });
    expect(committed(table, productAiMeterKeys.task(TASK))).toBe(1_900_000);
    expect(await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 200_000, caps: caps() })).toMatchObject({ ok: false, item: "task" });
  });

  it("the month turns on the 1st UTC, and a settle goes to the month its reservation was made in", async () => {
    const { table, deps, at } = meter(Date.UTC(2026, 10, 30, 23, 59, 59));
    const reserved = await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: undefined, estimateMicros: 50_000_000, caps: caps() });
    if (!reserved.ok) throw new Error("reserve");
    expect(await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: undefined, estimateMicros: 1, caps: caps() })).toMatchObject({ ok: false, item: "project" });
    at(Date.UTC(2026, 11, 1, 0, 0, 0));
    await settleProductAiCall(deps, reserved.reservation, 1000);
    expect(spent(table, productAiMeterKeys.project(A, "web", "2026-11"))).toBe(1000);
    expect(spent(table, productAiMeterKeys.project(A, "web", "2026-12"))).toBeUndefined();
    expect((await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: undefined, estimateMicros: 50_000_000, caps: caps() })).ok).toBe(true);
  });

  it("two companies with a project of the same name never share an item, and a task item refuses another company", async () => {
    const { table, deps } = meter();
    await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1000, caps: caps() });
    expect(committed(table, productAiMeterKeys.project(B, "web", "2026-11"))).toBeUndefined();
    expect(committed(table, productAiMeterKeys.company(B, "2026-11"))).toBeUndefined();
    expect(await reserveProductAiCall(deps, { orgId: B, project: "web", taskId: TASK, estimateMicros: 1, caps: caps() })).toMatchObject({ ok: false, item: "task" });
    expect(committed(table, productAiMeterKeys.project(B, "web", "2026-11"))).toBeUndefined();
  });

  it("refuses an unusable scope or number before any write", async () => {
    const { table, deps } = meter();
    await expect(reserveProductAiCall(deps, { orgId: "acme", project: "web", taskId: TASK, estimateMicros: 1, caps: caps() })).rejects.toThrow(RangeError);
    await expect(reserveProductAiCall(deps, { orgId: A, project: "we#b", taskId: TASK, estimateMicros: 1, caps: caps() })).rejects.toThrow(RangeError);
    await expect(reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1.5, caps: caps() })).rejects.toThrow(RangeError);
    await expect(reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1, caps: caps({ taskMicros: -1 }) })).rejects.toThrow(RangeError);
    expect(table.find(() => true)).toHaveLength(0);
  });

  it("every key the meter writes starts product-ai-meter#, which the State stream readers skip", async () => {
    const { table, deps } = meter();
    const reserved = await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1, caps: caps() });
    if (reserved.ok) await settleProductAiCall(deps, reserved.reservation, 1);
    await openProductAiHold(deps, { holdId: "h1", orgId: A, project: "web", purpose: "eval-hold", amountMicros: 10, maxCalls: 2, deadlineMs: NOV + 60_000, caps: caps() });
    for (const item of table.find(() => true)) {
      expect(String(item.pk).startsWith("product-ai")).toBe(true);
      expect(isProductAiMeterKey(item.pk)).toBe(true);
    }
  });
});

describe("the State stream and the meter", () => {
  it("the outbox publisher (a State stream reader) publishes nothing for a meter item; the task notifier's filter takes only DEVELOPER_TASK", async () => {
    const { table, deps } = meter();
    const reserved = await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 5, caps: caps() });
    if (reserved.ok) await settleProductAiCall(deps, reserved.reservation, 5);
    const sent: unknown[] = [];
    const handler = createOutboxPublisherHandler({ send: async (record) => { sent.push(record); }, markQueued: async () => undefined });
    const Records = table.find(() => true).map((item) => ({ eventName: "MODIFY", dynamodb: { NewImage: marshall(item) } }));
    expect(Records.length).toBeGreaterThan(0);
    expect(await handler({ Records })).toEqual({ published: 0 });
    expect(sent).toHaveLength(0);
    for (const item of table.find(() => true)) expect(item.entityType).toBeUndefined();
  });
});

describe("product meter, whole-run holds", () => {
  it("an eval hold reserves the whole amount on the months only (never the task's $2 item), or nothing", async () => {
    const { table, deps } = meter();
    const opened = await openProductAiHold(deps, { holdId: "h1", orgId: A, project: "web", taskId: TASK, purpose: "eval-hold", amountMicros: 4_000_000, maxCalls: 400, deadlineMs: NOV + 3_600_000, caps: caps() });
    expect(opened.ok).toBe(true);
    expect(committed(table, productAiMeterKeys.project(A, "web", "2026-11"))).toBe(4_000_000);
    expect(committed(table, productAiMeterKeys.company(A, "2026-11"))).toBe(4_000_000);
    expect(table.get(productAiMeterKeys.task(TASK))).toBeUndefined();
    // A second hold that the month cannot take is refused whole: no hold item, no reservation.
    const refused = await openProductAiHold(deps, { holdId: "h2", orgId: A, project: "web", purpose: "eval-hold", amountMicros: 46_000_001, maxCalls: 1, deadlineMs: NOV + 3_600_000, caps: caps() });
    expect(refused).toMatchObject({ ok: false, reason: "cap", item: "project" });
    expect(table.get(productAiMeterKeys.hold("h2"))).toBeUndefined();
    expect(committed(table, productAiMeterKeys.project(A, "web", "2026-11"))).toBe(4_000_000);
  });

  it("calls spend the hold down; the amount and the call count each refuse; an overrun blocks the next call; close releases only the unspent", async () => {
    const { table, deps } = meter();
    const opened = await openProductAiHold(deps, { holdId: "h1", orgId: A, project: "web", purpose: "eval-hold", amountMicros: 1000, maxCalls: 3, deadlineMs: NOV + 3_600_000, caps: caps() });
    if (!opened.ok) throw new Error("open");
    const first = await reserveInProductAiHold(deps, opened.hold, 600);
    if (!first.ok) throw new Error("reserve");
    expect(await reserveInProductAiHold(deps, opened.hold, 401)).toMatchObject({ ok: false, reason: "cap" });
    expect((await settleInProductAiHold(deps, first.call, 300)).overrun).toBe(false);
    const second = await reserveInProductAiHold(deps, opened.hold, 700);
    if (!second.ok) throw new Error("reserve 2");
    // The one call the hold may be overrun by (DEC 165), then nothing more.
    expect((await settleInProductAiHold(deps, second.call, 900)).overrun).toBe(true);
    expect(await reserveInProductAiHold(deps, opened.hold, 1)).toMatchObject({ ok: false, reason: "overrun", item: "hold" });
    expect(spent(table, productAiMeterKeys.project(A, "web", "2026-11"))).toBe(1200);
    expect(await closeProductAiHold(deps, opened.hold)).toBe(true);
    const project = table.get(productAiMeterKeys.project(A, "web", "2026-11"))!;
    expect(project).toMatchObject({ committed: 1200, reservedMicros: 0, spentMicros: 1200 });
    expect(await closeProductAiHold(deps, opened.hold)).toBe(false);
  });

  it("refuses a call past the hold's call count, and refuses a hold used under another scope", async () => {
    const { deps } = meter();
    const opened = await openProductAiHold(deps, { holdId: "h1", orgId: A, project: "web", purpose: "eval-hold", amountMicros: 1000, maxCalls: 1, deadlineMs: NOV + 3_600_000, caps: caps() });
    if (!opened.ok) throw new Error("open");
    expect(await reserveInProductAiHold(deps, { holdId: "h1", orgId: B, project: "web" }, 1)).toMatchObject({ ok: false });
    expect(await reserveInProductAiHold(deps, { holdId: "h1", orgId: A, project: "api" }, 1)).toMatchObject({ ok: false });
    expect((await reserveInProductAiHold(deps, opened.hold, 1)).ok).toBe(true);
    expect(await reserveInProductAiHold(deps, opened.hold, 1)).toMatchObject({ ok: false });
  });

  it("close keeps a reservation whose call never settled (errs high)", async () => {
    const { table, deps } = meter();
    const opened = await openProductAiHold(deps, { holdId: "h1", orgId: A, project: "web", purpose: "eval-hold", amountMicros: 1000, maxCalls: 3, deadlineMs: NOV + 3_600_000, caps: caps() });
    if (!opened.ok) throw new Error("open");
    await reserveInProductAiHold(deps, opened.hold, 250);
    expect(await closeProductAiHold(deps, opened.hold)).toBe(true);
    expect(table.get(productAiMeterKeys.project(A, "web", "2026-11"))).toMatchObject({ committed: 250, reservedMicros: 0, spentMicros: 250 });
  });

  it("a call that settles after its hold was closed is not counted twice (close already kept its reservation)", async () => {
    const { table, deps } = meter();
    const opened = await openProductAiHold(deps, { holdId: "h1", orgId: A, project: "web", purpose: "eval-hold", amountMicros: 1000, maxCalls: 3, deadlineMs: NOV + 3_600_000, caps: caps() });
    if (!opened.ok) throw new Error("open");
    const inFlight = await reserveInProductAiHold(deps, opened.hold, 250);
    if (!inFlight.ok) throw new Error("reserve");
    expect(await closeProductAiHold(deps, opened.hold)).toBe(true);
    expect(await settleInProductAiHold(deps, inFlight.call, 100)).toEqual({ overrun: false });
    expect(table.get(productAiMeterKeys.project(A, "web", "2026-11"))).toMatchObject({ committed: 250, reservedMicros: 0, spentMicros: 250 });
    expect(table.get(productAiMeterKeys.company(A, "2026-11"))).toMatchObject({ spentMicros: 250 });
  });

  it("a real-model run's hold is charged to the task item (its $2 and its 200 calls), all N runs funded or none", async () => {
    const { table, deps } = meter();
    expect(await openProductAiHold(deps, { holdId: "h1", orgId: A, project: "web", taskId: TASK, purpose: "real-model-run", amountMicros: 2_000_001, maxCalls: 3, deadlineMs: NOV + 3_600_000, caps: caps() })).toMatchObject({ ok: false, item: "task" });
    expect(table.get(productAiMeterKeys.hold("h1"))).toBeUndefined();
    const opened = await openProductAiHold(deps, { holdId: "h2", orgId: A, project: "web", taskId: TASK, purpose: "real-model-run", amountMicros: 1_500_000, maxCalls: 3, deadlineMs: NOV + 3_600_000, caps: caps() });
    expect(opened.ok).toBe(true);
    expect(table.get(productAiMeterKeys.task(TASK))).toMatchObject({ committed: 1_500_000, calls: 3 });
    expect(await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 600_000, caps: caps() })).toMatchObject({ ok: false, item: "task" });
  });

  it("a leaked hold blocks the month until it expires (run deadline + 15 minutes), then the next reservation recovers it", async () => {
    const { table, deps, at } = meter();
    const deadline = NOV + 60 * 60 * 1000;
    await openProductAiHold(deps, { holdId: "crashed", orgId: A, project: "web", purpose: "eval-hold", amountMicros: 49_000_000, maxCalls: 400, deadlineMs: deadline, caps: caps() });
    at(deadline + 14 * 60 * 1000);
    expect(await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1_500_000, caps: caps() })).toMatchObject({ ok: false, item: "project" });
    at(deadline + 15 * 60 * 1000 + 1);
    expect((await reserveProductAiCall(deps, { orgId: A, project: "web", taskId: TASK, estimateMicros: 1_500_000, caps: caps() })).ok).toBe(true);
    expect(table.get(productAiMeterKeys.hold("crashed"))?.state).toBe("closed");
    expect(committed(table, productAiMeterKeys.project(A, "web", "2026-11"))).toBe(1_500_000);
  });
});
