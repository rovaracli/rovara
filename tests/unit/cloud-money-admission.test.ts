// Convergence lane A5: the money rules of Cloud's Admission adapter (packages/broker/src/cloud-adapters/money/admission.ts). Code's own conformance suite runs
// on it too (tests/conformance/adapters/admission-cloud.ts); these are the rules a budget depends on, each with the case that breaks if the rule is removed.
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import type { AdmissionRequest } from "@rovara-code/contracts";
import { spendCounterKey } from "../../packages/cloud-contracts/src/org-scoped-keys.js";
import { createCloudAdmission, holdKey, microsToUsd, monthOfMs, openHoldsPk, usdToMicros, type AdmissionLevel } from "../../packages/broker/src/cloud-adapters/money/index.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const MONTH = monthOfMs(NOW);
const dollars = (usd: number) => ({ micros: usdToMicros(usd), currency: "USD" });

function world(options: { orgLimit?: number; now?: () => number; ttl?: number } = {}) {
  const store = new MemoryDocumentStore();
  const levels: AdmissionLevel[] = [{ scope: "ORG", kind: "org", limitUsd: options.orgLimit ?? 10 }, { scope: "PROJECT#web", kind: "project", limitUsd: undefined }];
  const admission = createCloudAdmission({
    store, now: options.now ?? (() => NOW), levels: async () => levels, ...(options.ttl === undefined ? {} : { holdTtlSeconds: options.ttl }),
    actions: { "task.start": { kind: "room", minimumUsd: 0.5 }, "model.call": { kind: "hold", unknownCostUsd: 2 } },
  });
  const counter = async (company: string, scope = "ORG") => {
    const item = await store.get(spendCounterKey(company, MONTH, scope));
    return { committed: Number(((item?.committedUsd as number | undefined) ?? 0).toFixed(6)), spent: Number(((item?.spentUsd as number | undefined) ?? 0).toFixed(6)) };
  };
  return { store, admission, counter };
}

const call = (key: string, usd?: number, company = A): AdmissionRequest => ({ companyId: company, idempotencyKey: key, action: "model.call", projectName: "web", ...(usd === undefined ? {} : { estimate: { cost: dollars(usd) } }) });
const reservation = (decision: { allowed: boolean; reservationId?: string }): string => {
  if (!decision.allowed || decision.reservationId === undefined) throw new Error("expected a reservation");
  return decision.reservationId;
};

describe("Cloud Admission: holds", () => {
  it("declares that it enforces cost (decision 79)", () => {
    expect(world().admission.enforcesCost).toBe(true);
  });

  it("holds the estimate on every scope, the limited one under its limit, in Cloud's dollar rows", async () => {
    const { admission, counter } = world();
    reservation(await admission.admit(call("a", 1.25)));
    expect(await counter(A)).toEqual({ committed: 1.25, spent: 0 });
    expect(await counter(A, "PROJECT#web")).toEqual({ committed: 1.25, spent: 0 });
  });

  it("racing admissions never overspend: 25 concurrent $1 holds on a $10 month admit exactly 10", async () => {
    const { admission, counter } = world();
    const decisions = await Promise.all(Array.from({ length: 25 }, (_, index) => admission.admit(call(`race-${index}`, 1))));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
    expect(decisions.filter((decision) => !decision.allowed).every((decision) => !decision.allowed && ["org_budget_exceeded", "budget_busy"].includes(decision.code))).toBe(true);
    expect(await counter(A)).toEqual({ committed: 10, spent: 0 });
  });

  it("a retried key holds once and answers the same reservation, even when the retries race", async () => {
    const { admission, counter } = world();
    const decisions = await Promise.all(Array.from({ length: 8 }, () => admission.admit(call("same", 3))));
    expect(new Set(decisions.map(reservation)).size).toBe(1);
    expect(await counter(A)).toEqual({ committed: 3, spent: 0 });
    expect(reservation(await admission.admit(call("same", 3)))).toBe(reservation(decisions[0]!));
    expect(await counter(A)).toEqual({ committed: 3, spent: 0 });
  });

  it("answers a repeated key with its reservation only while that hold is held and is the same request", async () => {
    const store = new MemoryDocumentStore();
    const admission = createCloudAdmission({
      store, now: () => NOW, levels: async () => [{ scope: "ORG", kind: "org", limitUsd: 10 }],
      actions: { "model.call": { kind: "hold", unknownCostUsd: 2 }, "design.round": { kind: "hold", unknownCostUsd: 2 } },
    });
    const committed = async () => {
      const value = (await store.get(spendCounterKey(A, MONTH, "ORG")))?.committedUsd;
      return typeof value === "number" ? Number(value.toFixed(6)) : 0;
    };
    const id = reservation(await admission.admit(call("reuse", 1)));
    expect(await admission.admit(call("reuse", 1))).toEqual({ allowed: true, reservationId: id });
    // Another amount, or another action, under the same key: refused, nothing more held.
    expect(await admission.admit(call("reuse", 3))).toMatchObject({ allowed: false, code: "admission_key_reused" });
    expect(await admission.admit({ ...call("reuse", 1), action: "design.round" })).toMatchObject({ allowed: false, code: "admission_key_reused" });
    expect(await admission.stage(call("reuse", 3))).toMatchObject({ decision: { allowed: false }, items: [] });
    expect(await committed()).toBe(1);
    // Once released (or settled), the key no longer answers a reservation that would hold nothing.
    await admission.release(id);
    expect(await admission.admit(call("reuse", 1))).toMatchObject({ allowed: false, code: "admission_key_reused" });
    const settled = reservation(await admission.admit(call("settled", 1)));
    await admission.settle(settled, { cost: dollars(1) });
    expect(await admission.admit(call("settled", 1))).toMatchObject({ allowed: false, code: "admission_key_reused" });
    expect(await committed()).toBe(1);
  });

  it("a staged hold that the caller's transaction committed is not held again on a repeat stage", async () => {
    const { store, admission, counter } = world();
    const first = await admission.stage(call("staged", 2));
    expect((await store.transact(first.items)).applied).toBe(true);
    const again = await admission.stage(call("staged", 2));
    expect(again.items).toEqual([]);
    expect(reservation(again.decision)).toBe(reservation(first.decision));
    expect(await counter(A)).toEqual({ committed: 2, spent: 0 });
  });

  it("refuses an estimate over the room left, with the scope's code, and writes nothing", async () => {
    const { admission, counter } = world();
    reservation(await admission.admit(call("big", 9.5)));
    const refused = await admission.admit(call("more", 1));
    expect(refused).toMatchObject({ allowed: false, code: "org_budget_exceeded" });
    expect(await counter(A)).toEqual({ committed: 9.5, spent: 0 });
    expect(await admission.stage(call("more", 1))).toMatchObject({ decision: { allowed: false }, items: [] });
  });

  it("an exact fit is admitted (float dust never refuses it), and a cent more is not", async () => {
    const { admission } = world({ orgLimit: 0.3 });
    reservation(await admission.admit(call("x", 0.1)));
    reservation(await admission.admit(call("y", 0.2)));
    expect((await admission.admit(call("z", 0.01))).allowed).toBe(false);
  });
});

describe("Cloud Admission: an unknown cost is never $0 (decision 79)", () => {
  it("a request with no estimate holds the action's worst case", async () => {
    const { admission, counter } = world();
    reservation(await admission.admit(call("unknown")));
    expect(await counter(A)).toEqual({ committed: 2, spent: 0 });
  });

  it("an estimate of $0 holds the worst case too", async () => {
    const { admission, counter } = world();
    reservation(await admission.admit({ ...call("zero"), estimate: { cost: { micros: 0, currency: "USD" } } }));
    expect(await counter(A)).toEqual({ committed: 2, spent: 0 });
  });

  it("an estimate in another currency is refused, never read as dollars or as zero", async () => {
    const { admission, counter } = world();
    expect(await admission.admit({ ...call("eur"), estimate: { cost: { micros: 1, currency: "EUR" } } })).toMatchObject({ allowed: false, code: "currency_unsupported" });
    expect(await counter(A)).toEqual({ committed: 0, spent: 0 });
  });

  it("a settle that names no dollar cost charges the whole hold", async () => {
    const { admission, counter } = world();
    const id = reservation(await admission.admit(call("s", 1.5)));
    await admission.settle(id, { tokens: 1_000 });
    expect(await counter(A)).toEqual({ committed: 1.5, spent: 1.5 });
  });

  it("a settle in another currency charges the whole hold too", async () => {
    const { admission, counter } = world();
    const id = reservation(await admission.admit(call("s2", 1.5)));
    await admission.settle(id, { cost: { micros: 10, currency: "EUR" } });
    expect(await counter(A)).toEqual({ committed: 1.5, spent: 1.5 });
  });

  it("refuses to be built with a $0 worst case", () => {
    expect(() => createCloudAdmission({ store: new MemoryDocumentStore(), levels: async () => [], actions: { "model.call": { kind: "hold", unknownCostUsd: 0 } } })).toThrow(RangeError);
  });
});

describe("Cloud Admission: settle and release, exactly once", () => {
  it("settles to the actual cost: the hold's unused part goes back and the actual is spent, once", async () => {
    const { admission, counter } = world();
    const id = reservation(await admission.admit(call("s", 2)));
    await admission.settle(id, { cost: dollars(0.4) });
    await admission.settle(id, { cost: dollars(0.4) });
    await admission.release(id);
    expect(await counter(A)).toEqual({ committed: 0.4, spent: 0.4 });
  });

  it("an actual above the hold is counted whole (real spend is never dropped)", async () => {
    const { admission, counter } = world();
    const id = reservation(await admission.admit(call("over", 1)));
    await admission.settle(id, { cost: dollars(1.75) });
    expect(await counter(A)).toEqual({ committed: 1.75, spent: 1.75 });
  });

  it("a failed or cancelled run releases its hold once: a repeat or a later settle changes nothing", async () => {
    const { admission, counter } = world();
    const id = reservation(await admission.admit(call("r", 3)));
    await admission.release(id);
    await admission.release(id);
    await admission.settle(id, { cost: dollars(3) });
    expect(await counter(A)).toEqual({ committed: 0, spent: 0 });
  });

  it("a settle and a release racing apply one of the two, once", async () => {
    const { admission, counter } = world();
    const id = reservation(await admission.admit(call("both", 2)));
    await Promise.all([admission.settle(id, { cost: dollars(1) }), admission.release(id), admission.release(id), admission.settle(id, { cost: dollars(1) })]);
    const after = await counter(A);
    expect([JSON.stringify({ committed: 1, spent: 1 }), JSON.stringify({ committed: 0, spent: 0 })]).toContain(JSON.stringify(after));
  });

  it("released room is admitted again at once", async () => {
    const { admission } = world({ orgLimit: 2 });
    const id = reservation(await admission.admit(call("first", 2)));
    expect((await admission.admit(call("second", 2))).allowed).toBe(false);
    await admission.release(id);
    expect((await admission.admit(call("third", 2))).allowed).toBe(true);
  });

  it("an id that is not a reservation, or names no hold, is a no-op", async () => {
    const { admission, counter } = world();
    await admission.settle("no-such-reservation", { cost: dollars(5) });
    await admission.release(`${A}.${"0".repeat(64)}`);
    expect(await counter(A)).toEqual({ committed: 0, spent: 0 });
  });
});

describe("Cloud Admission: company isolation", () => {
  it("one company's holds, settles and releases never touch another company's counters", async () => {
    const { admission, counter } = world();
    const id = reservation(await admission.admit(call("iso", 4, A)));
    expect(await counter(B)).toEqual({ committed: 0, spent: 0 });
    await admission.settle(id, { cost: dollars(1) });
    expect(await counter(B)).toEqual({ committed: 0, spent: 0 });
    expect(await counter(A)).toEqual({ committed: 1, spent: 1 });
  });

  it("the same key in two companies is two holds", async () => {
    const { admission, counter } = world();
    const a = reservation(await admission.admit(call("shared", 1, A)));
    const b = reservation(await admission.admit(call("shared", 1, B)));
    expect(a).not.toBe(b);
    expect(await counter(A)).toEqual({ committed: 1, spent: 0 });
    expect(await counter(B)).toEqual({ committed: 1, spent: 0 });
  });

  it("a reservation id with another company's name finds no hold and changes nothing", async () => {
    const { admission, counter } = world();
    const id = reservation(await admission.admit(call("forged", 4, A)));
    const forged = `${B}.${id.split(".")[1]!}`;
    await admission.settle(forged, { cost: dollars(4) });
    await admission.release(forged);
    expect(await counter(B)).toEqual({ committed: 0, spent: 0 });
    expect(await counter(A)).toEqual({ committed: 4, spent: 0 });
  });

  it("a request with no valid company is refused", async () => {
    expect(await world().admission.admit({ ...call("bad"), companyId: "not-a-company" })).toMatchObject({ allowed: false, code: "admission_invalid_request" });
  });
});

describe("Cloud Admission: room, gates, unknown actions, expiry", () => {
  it("a task start needs the path's minimum left and holds nothing; its staged checks fail the caller's transaction when the room went meanwhile", async () => {
    const { store, admission, counter } = world({ orgLimit: 2 });
    const start: AdmissionRequest = { companyId: A, idempotencyKey: "start-1", action: "task.start", projectName: "web" };
    const staged = await admission.stage(start);
    expect(staged.decision).toEqual({ allowed: true });
    reservation(await admission.admit(call("eat", 1.75)));
    expect((await store.transact(staged.items)).applied).toBe(false);
    expect(await admission.admit({ ...start, idempotencyKey: "start-2" })).toMatchObject({ allowed: false, code: "org_budget_exceeded" });
    expect(await counter(A)).toEqual({ committed: 1.75, spent: 0 });
  });

  it("refuses an action this install has not wired (fail closed)", async () => {
    expect(await world().admission.admit({ companyId: A, idempotencyKey: "n", action: "nightly.run" })).toMatchObject({ allowed: false, code: "admission_action_unknown" });
  });

  it("a gate's refusal comes before any money", async () => {
    const store = new MemoryDocumentStore();
    const admission = createCloudAdmission({ store, now: () => NOW, levels: async () => [{ scope: "ORG", kind: "org", limitUsd: 10 }], gate: async () => ({ code: "trial_locked", message: "The trial is locked." }), actions: { "model.call": { kind: "hold", unknownCostUsd: 1 } } });
    expect(await admission.admit(call("g", 1))).toMatchObject({ allowed: false, code: "trial_locked" });
    expect(await store.get(spendCounterKey(A as never, MONTH, "ORG"))).toBeUndefined();
  });

  it("a hold whose caller died is charged in full once its time passes, once", async () => {
    let now = NOW;
    const { store, admission, counter } = world({ now: () => now, ttl: 60 });
    const id = reservation(await admission.admit(call("orphan", 1.5)));
    expect(await admission.sweepExpiredHolds(A)).toBe(0);
    now += 61_000;
    expect(await admission.sweepExpiredHolds(A)).toBe(1);
    expect(await admission.sweepExpiredHolds(A)).toBe(0);
    await admission.release(id);
    expect(await counter(A)).toEqual({ committed: 1.5, spent: 1.5 });
    expect(await store.query({ pk: openHoldsPk(A) })).toMatchObject({ items: [] });
    expect(await store.get(holdKey(A, id.split(".")[1]!))).toMatchObject({ state: "settled" });
  });
});

describe("money units match Cloud's rows", () => {
  it("millionths and Cloud's six-decimal dollars convert both ways without loss", () => {
    for (const micros of [0, 1, 999_999, 1_000_000, 123_456_789, 25_000_000, 1_000_000_000_000]) expect(usdToMicros(microsToUsd(micros))).toBe(micros);
    expect(usdToMicros(0.1 + 0.2)).toBe(300_000);
    expect(microsToUsd(300_000)).toBe(0.3);
  });
});
