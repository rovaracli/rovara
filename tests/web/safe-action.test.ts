// @vitest-environment jsdom
// HELPER-NOTES pitfall labels are kept in test names for adversarial review.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { actionLock, answerHeld, basisOf, claimLockSupported, createActionRecords, everyCovered, isCsrfFailure, fenceFor as actionFenceFor, fencedRead, fencedReadiness, itemsBound, observeRecord, recoverActionBasis, runActionPress, sameItems, withActionClaim, type PressInput } from "../../packages/ui/src/safe-action.js";
import { parsePending, parseAccepted, type PendingPress, type AcceptedAnswer } from "../../packages/ui/src/screens/session/merge-pending.js";
import "./support/render.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
const subject = "org_aaaaaaaaaaaaaaaaaaaa|person-a|subject-a";
const pending = (): PendingPress => ({ v: 1, sessionId: subject, requestId: "11111111-1111-4111-8111-111111111111", startedAt: "2026-11-20T15:00:00.000Z", heads: [{ repositoryId: "acme/repo", number: 1, headSha: "a".repeat(40) }], risk: "high", sent: ["the exact shown target"] });
const answer = (): AcceptedAnswer => ({ v: 1, subject, requestId: pending().requestId, acceptedAt: "2026-11-20T15:00:01.000Z", words: "Server's actual answer", keys: ["acme/repo#1"], heads: pending().heads });
function store() {
 return createActionRecords({ pendingPrefix: "fixture.pending:", acceptedPrefix: "fixture.accepted:", changedEvent: "fixture-changed", parsePending, parseAccepted, pendingSubject: (entry: PendingPress) => entry.sessionId, acceptedSubject: (entry: AcceptedAnswer) => entry.subject, canonicalAccepted: (entry: AcceptedAnswer) => ({ ...entry }) });
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes;reject = no; });return { promise, resolve, reject }; }
const fenceFor = (client: QueryClient, key: string) => actionFenceFor(client, key, "fixture-action");
const fence = () => fenceFor(new QueryClient(), subject);
function inputFor(overrides: Partial<PressInput<PendingPress, AcceptedAnswer>> = {}): PressInput<PendingPress, AcceptedAnswer> {
 return { recover: async () => true, lockName: subject, records: store(), pending, refusalNow: () => undefined, storageWords: "storage", claimed: () => undefined, send: async () => answer(), accepted: () => undefined, failed: () => undefined, finished: () => undefined, ...overrides };
}
beforeEach(() => {
 localStorage.clear();
 // These are existing route-owned v1 records, parsed by the production strict readers.
 expect(parsePending(JSON.stringify(pending()), subject).kind).toBe("pending");
 expect(parseAccepted(JSON.stringify(answer()), subject)).toEqual(answer());
});
afterEach(() => { vi.restoreAllMocks();localStorage.clear(); });
it("F1: older failed read cannot beat a newer success; body and fence survive remount", async () => {
 const client = new QueryClient(), f = fenceFor(client, subject), old = deferred<string>();
 const failed = fencedRead(f, () => old.promise).catch(() => undefined);
 const fresh = await fencedRead(f, async () => "new body");old.reject(new Error("old failure"));await failed;
 expect(fenceFor(client, subject)).toBe(f);expect(f.taskFailed).toBeUndefined();expect(f.latestRead).toEqual({ data: "new body", issued: fresh.issued });
});
it("L1: readiness uses issue order too, across out-of-order failure and recovery", async () => {
 const f = fence(), old = deferred<string>();const failed = fencedReadiness(f, () => old.promise).catch(() => undefined);
 await fencedReadiness(f, async () => "ready");old.reject(new Error("late"));await failed;expect(f.readinessDenied).toBeUndefined();
 const earlier = deferred<string>(), delayed = fencedReadiness(f, () => earlier.promise);
 await fencedReadiness(f, async () => { throw new Error("new refusal"); }).catch(() => undefined);
 earlier.resolve("old ready");await delayed;expect(f.readinessDenied).toBeDefined();
 await fencedReadiness(f, async () => "recovered");expect(f.readinessDenied).toBeUndefined();
});
it("P1-1: failed accepted write and reload retain pending and forbid a second request", () => {
 const records = store();expect(records.writePending(pending())).toBe(true);
 const set = Storage.prototype.setItem.bind(localStorage);vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) { if (key.startsWith("fixture.accepted:")) throw new Error("full");set(key, value); });
 expect(records.writeAccepted(answer()) && records.acceptedStoredExactly(answer())).toBe(false);
 const reload = store();expect(reload.readPendingNow(subject).kind).toBe("pending");expect(reload.claimPending(pending(), () => undefined, "storage").stop).toBe(true);
});
it("P1-1 exact acceptance: successful write without exact durable answer cannot release pending", () => {
 const records = store();records.writePending(pending());records.writeAccepted(answer());
 localStorage.setItem("fixture.accepted:" + subject, JSON.stringify({ ...answer(), words: "different answer" }));
 expect(records.acceptedStoredExactly(answer())).toBe(false);expect(records.readPendingNow(subject).kind).toBe("pending");
});
it("P1-2/M1: every covered item must be observed; partial tracking and empty coverage resolve nothing", () => {
 const covered = ["tracked", "untracked"], observed = new Set(["tracked"]);
 expect(everyCovered(covered, item => observed.has(item))).toBe(false);expect(everyCovered([], () => true)).toBe(false);
 observed.add("untracked");expect(everyCovered(covered, item => observed.has(item))).toBe(true);
});
it("P1-3: any meaningful newer snapshot invalidates the shown basis at send", async () => {
 const before = ["head-a", "digest-a", "ready", "passing", "item-a", "low"];
 for (let index = 0;index < before.length;index++) {
  const changed = [...before];changed[index] = "changed";const f = fence();await fencedRead(f, async () => basisOf(changed));
  const result = await recoverActionBasis(f, basisOf(before), body => typeof body === "string" ? body : undefined, async () => ({ issued: 999, body: basisOf(changed) }));
  expect(result.kind).toBe("changed");
 }
});
it("P1-4/M-2: exclusive claim spans pending write and entire POST until recording and finally release", async () => {
 const records = store(), sent = deferred<void>(), recording = deferred<void>(), finish = vi.fn();
 const run = runActionPress(inputFor({ records, send: async () => { sent.resolve();await recording.promise;return answer(); }, finished: finish }));
 await sent.promise;expect(records.readPendingNow(subject).kind).toBe("pending");
 const second = vi.fn();expect(await withActionClaim(subject, second)).toEqual({ kind: "busy" });expect(second).not.toHaveBeenCalled();
 recording.resolve();await run;expect(finish).toHaveBeenCalledTimes(1);expect(records.acceptedStoredExactly(answer())).toBe(true);
 await new Promise(resolve => { setTimeout(resolve, 0); });
 const next = await withActionClaim(subject, () => "released");expect(next.kind).toBe("done");if (next.kind === "done") next.release();
});
it("Low-1: absent, synchronously thrown and asynchronously rejected Web Lock APIs fail closed", async () => {
 const original = navigator.locks, claim = vi.fn();
 try {
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });expect(claimLockSupported()).toBe(false);expect(await withActionClaim(subject, claim)).toEqual({ kind: "unsupported" });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request() { throw new Error("sync"); } } });expect(await withActionClaim(subject, claim)).toEqual({ kind: "failed" });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { async request() { throw new Error("async"); } } });expect(await withActionClaim(subject, claim)).toEqual({ kind: "failed" });expect(claim).not.toHaveBeenCalled();
 } finally { Object.defineProperty(navigator, "locks", { configurable: true, writable: true, value: original }); }
});
it("P1-5: incomplete, extra, duplicate or unbound item sets cannot bind a payload", () => {
 expect(itemsBound([], ["a"])).toBe(false);expect(itemsBound(["a"], ["a", "b"])).toBe(false);expect(itemsBound(["a", "b"], ["a"])).toBe(false);expect(itemsBound(["a", "a"], ["a", "a"])).toBe(false);expect(itemsBound(["a", "b"], ["b", "a"])).toBe(true);
});
it("Sol R13/R14 P1: successful recovery compares fresh BODY and blocks old confirmation", async () => {
 const f = fence();await fencedRead(f, async () => { throw new Error("failed"); }).catch(() => undefined);
 const fresh = await recoverActionBasis(f, "shown", value => String(value), () => fencedRead(f, async () => "new blocking facts"));
 expect(fresh.kind).toBe("changed");
 const sent = vi.fn(async () => answer());await runActionPress(inputFor({ recover: async () => fresh.kind === "unchanged", send: sent }));expect(sent).not.toHaveBeenCalled();
});
it("Sol P2: retired memory-only acceptance stops refusing a valid confirmation", () => {
 expect(answerHeld(answer(), undefined)).toBe(true);expect(answerHeld(answer(), answer().requestId)).toBe(false);
 const records = store();expect(records.claimPending(pending(), () => answerHeld(answer(), answer().requestId) ? "accepted" : undefined, "storage").stop).toBe(false);
});
it("Sol R14 P2: stalled refresh does not retain claim or busy after end is recorded", async () => {
 const stalled = deferred<void>(), finish = vi.fn(), events: string[] = [];
 await runActionPress(inputFor({ accepted: () => { events.push("record");void stalled.promise.catch(() => undefined); }, finished: () => { finish();events.push("finish"); } }));
 expect(events).toEqual(["record", "finish"]);expect(finish).toHaveBeenCalledTimes(1);
 await new Promise(resolve => { setTimeout(resolve, 0); });
 const claim = await withActionClaim(subject, () => true);expect(claim.kind).toBe("done");if (claim.kind === "done") claim.release();stalled.resolve();
});
it("Opus P2-1: shown and sent values must match, including risk", () => {
 const shown = [{ key: "a", head: "sha", digest: "d", risk: "low" }], sent = [{ ...shown[0]!, risk: "high" }];
 expect(sameItems(shown, sent, item => JSON.stringify(item))).toBe(false);
 expect(store().claimPending(pending(), () => sameItems(shown, sent, item => JSON.stringify(item)) ? undefined : "changed", "storage")).toEqual({ stop: true, words: "changed" });
});
it("hard locks: unread identity, unusable storage and unknown end never offer or send", () => {
 expect(actionLock({ unresolved: false, identityUnread: true, drift: false, ready: true })).toBe("identity");
 expect(actionLock({ unresolved: true, drift: false, ready: true })).toBe("unresolved");
 expect(actionLock({ unresolved: false, storage: "unavailable", drift: false, ready: true })).toBe("storage");
 const records = store();vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
 expect(records.readPendingNow(subject).kind).toBe("unavailable");expect(records.claimPending(pending(), () => undefined, "storage").stop).toBe(true);
});
it("server backstop is not the plan: send-time authority loss prevents persistence and dispatch", async () => {
 const records = store(), send = vi.fn(async () => answer()), entry = pending();let authority = true;
 const input = inputFor({ records, pending: () => entry, recover: async () => { authority = false;return true; }, refusalNow: () => authority ? undefined : "refused", send });
 await runActionPress(input);expect(send).not.toHaveBeenCalled();expect(records.readPendingNow(subject).kind).toBe("none");
});
it("R6b/e/g: cache/old reads do not resolve an observed press; identity scopes are isolated", async () => {
 const client = new QueryClient(), f = fenceFor(client, subject), old = deferred<string>(), read = fencedRead(f, () => old.promise);
 observeRecord(f, "press");const observed = f.observed.get("press")!;observeRecord(f, "press");expect(f.observed.get("press")).toBe(observed);
 old.resolve("done before press");await read;expect(f.latestRead!.issued).toBeLessThan(observed);
 client.setQueryData(["subject", subject], "done in cache");expect(f.latestRead!.data).toBe("done before press");
 expect(fenceFor(client, subject.replace("person-a", "person-b"))).not.toBe(f);
 const records = store();records.writePending(pending());expect(records.readPendingNow(subject + "other").kind).toBe("none");
});
it("records retain stale flag, refuse corrupt records and never clear a different press", () => {
 const records = store();records.writePending(pending());const stale = records.parsePending(localStorage.getItem("fixture.pending:" + subject), subject, Date.parse(pending().startedAt) + 24 * 60 * 60 * 1000);expect(stale.kind === "pending" && stale.stale).toBe(true);
 records.clearPending(subject, pending().requestId, "another time");expect(records.readPendingNow(subject).kind).toBe("pending");
 localStorage.setItem("fixture.pending:" + subject, "corrupt");expect(records.readPendingNow(subject).kind).toBe("unreadable");expect(records.writePending(pending())).toBe(false);
});
it("Merge compatibility: the existing pending reader marks stale at exactly 24 hours", () => {
 const records = store(), raw = JSON.stringify(pending()), started = Date.parse(pending().startedAt);
 expect(records.parsePending(raw, subject, started + 86_399_999)).toEqual({ kind: "pending", entry: pending(), stale: false });
 expect(records.parsePending(raw, subject, started + 86_400_000)).toEqual({ kind: "pending", entry: pending(), stale: true });
});
it("storage subscription updates another tab and survives hook remount", () => {
 const records = store(), hook = renderHook(() => records.usePending(subject));expect(hook.result.current.kind).toBe("none");
 act(() => { localStorage.setItem("fixture.pending:" + subject, JSON.stringify(pending()));globalThis.dispatchEvent(new StorageEvent("storage", { key: "fixture.pending:" + subject })); });
 expect(hook.result.current.kind).toBe("pending");hook.unmount();const reload = renderHook(() => records.usePending(subject));expect(reload.result.current.kind).toBe("pending");reload.unmount();
});

it("R6d: pending read-back must match the entire frozen payload before dispatch", () => {
 const records = store(), original = Storage.prototype.setItem.bind(localStorage);
 vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) { const altered = { ...JSON.parse(value) as PendingPress, risk: "low" };original(key, JSON.stringify(altered)); });
 expect(records.writePending(pending())).toBe(false);
});

it("R6h: CSRF_INVALID/STALE mean nothing sent; ordinary authority refusal is distinct", () => {
 expect(isCsrfFailure(new ApiError(403, "CSRF_INVALID", "stale"))).toBe(true);
 expect(isCsrfFailure(new ApiError(403, "CSRF_STALE", "stale"))).toBe(true);
 expect(isCsrfFailure(new ApiError(403, "FORBIDDEN", "refused"))).toBe(false);
});

it("action namespaces isolate readiness refusal and body-bound facts on one subject", async () => {
 const client = new QueryClient(), one = actionFenceFor(client, subject, "one"), two = actionFenceFor(client, subject, "two");
 await fencedReadiness(one, async () => { throw new Error("denied"); }).catch(() => undefined);
 await fencedReadiness(two, async () => "ready");await fencedRead(two, async () => "other body");
 expect(one.readinessDenied).toBeDefined();expect(one.latestRead).toBeUndefined();expect(two.readinessDenied).toBeUndefined();
});
it("cleanup and presentation exceptions release the lock; recovery exceptions clear busy without dispatch", async () => {
 await expect(runActionPress(inputFor({ finished: () => { throw new Error("cleanup"); } }))).rejects.toThrow("cleanup");
 await new Promise(resolve => { setTimeout(resolve, 0); });
 const claim = await withActionClaim(subject, () => true);expect(claim.kind).toBe("done");if (claim.kind === "done") claim.release();
 const finished = vi.fn(), send = vi.fn(async () => answer());
 await expect(runActionPress(inputFor({ recover: async () => { throw new Error("recovery"); }, send, finished }))).rejects.toThrow("recovery");expect(finished).toHaveBeenCalledTimes(1);expect(send).not.toHaveBeenCalled();
});
it("unverified acceptance cannot settle retained pending via hooks or after reload", async () => {
 const records = store(), original = Storage.prototype.setItem.bind(localStorage);
 vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) { original(key, key.startsWith("fixture.accepted:") ? JSON.stringify({ ...JSON.parse(value) as AcceptedAnswer, words: "corrupt" }) : value); });
 const accepted = vi.fn();await runActionPress(inputFor({ records, accepted }));expect(accepted).toHaveBeenCalledWith(answer(), false);
 expect(store().readPendingNow(subject).kind).toBe("pending");expect(store().readAcceptedNow(subject)).toBeUndefined();
 records.clearPending(subject, pending().requestId, pending().startedAt);
 expect(records.readPendingNow(subject).kind).toBe("none");expect(records.readAcceptedNow(subject)).toBeUndefined();
 const hook = renderHook(() => records.useAccepted(subject));expect(hook.result.current).toBeUndefined();hook.unmount();
});
it("generic basis and item equality cannot collide or hide duplicate replacement", () => {
 expect(basisOf(["a|b", "c"])).not.toBe(basisOf(["a", "b|c"]));expect(sameItems(["a", "a"], ["a", "b"], item => item)).toBe(false);
});

it("failed candidate removal cannot unmask an unverified answer during observed resolution", async () => {
 const records = store(), write = Storage.prototype.setItem.bind(localStorage), remove = Storage.prototype.removeItem.bind(localStorage);
 vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) { write(key, key.startsWith("fixture.accepted:") ? JSON.stringify({ ...JSON.parse(value) as AcceptedAnswer, words: "altered" }) : value); });
 const removing = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) { if (key.startsWith("fixture.accepted:")) throw new Error("denied");remove(key); });
 await runActionPress(inputFor({ records }));records.clearPending(subject, pending().requestId, pending().startedAt);
 expect(store().readPendingNow(subject).kind).toBe("pending");expect(store().readAcceptedNow(subject)).toBeUndefined();
 removing.mockRestore();records.clearPending(subject, pending().requestId, pending().startedAt);
 expect(store().readPendingNow(subject).kind).toBe("none");expect(store().readAcceptedNow(subject)).toBeUndefined();
});
it("failed pending removal keeps a confirmed answer in the current caller's memory path", async () => {
 const records = store(), remove = Storage.prototype.removeItem.bind(localStorage), accepted = vi.fn();
 vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) { if (key.startsWith("fixture.pending:")) throw new Error("denied");remove(key); });
 await runActionPress(inputFor({ records, accepted }));expect(accepted).toHaveBeenCalledWith(answer(), false);expect(records.readPendingNow(subject).kind).toBe("pending");
});
