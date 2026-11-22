// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { taskActionRecords } from "../../packages/ui/src/api/task-action.js";
import { actionSubject, fenceFor, fencedRead } from "../../packages/ui/src/safe-action.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";

for (const notify of [false, true]) it(`R3/R6b: host-backed pending removal requires this tab's later read (storage event ${notify})`, async () => {
 const f = fakeHost(), records = taskActionRecords(f.host), query = createQueryClient();
 const scope = actionSubject({ orgId: "company", developerId: "person", subjectId: "task" });
 const fence = fenceFor(query, scope, "adapter");
 const pending = { scope, requestId: "request", startedAt: "2026-11-21T10:00:00.000Z", request: { requestId: "request", action: "close", body: {}, startedAt: Date.parse("2026-11-21T10:00:00.000Z"), fence: 0 } };
 expect(records.writePending(pending)).toBe(true);
 let release: (() => void) | undefined;
 const freshRead = () => fencedRead(fence, () => new Promise<void>(resolve => { release = resolve; }));
 const ui = renderHook(() => records.usePendingWithFence(scope, fence, freshRead));
 expect(ui.result.current.kind).toBe("pending");
 const old = f.host.storage.get(scope + ":request");
 // A successful read issued before disappearance cannot authorize a new press.
 await act(async () => { await fencedRead(fence, async () => undefined); });
 act(() => {
  f.host.storage.set(scope + ":request", "null");
  if (notify) window.dispatchEvent(new StorageEvent("storage", { key: scope + ":request", oldValue: old ?? null, newValue: "null" }));
 });
 expect(records.claimPending(pending, () => undefined, "storage").stop).toBe(true);
 expect(fence.taskFailed).toBeDefined();
 await act(async () => { release?.(); });
 await waitFor(() => expect(fence.taskFailed).toBeUndefined());
 expect(records.claimPending(pending, () => undefined, "storage").stop).toBe(false);
 ui.unmount();query.clear();
});

it("R6d: the fence-aware host hook refuses unreadable storage without sending", () => {
 const f = fakeHost(), query = createQueryClient(), scope = actionSubject({ orgId: "company", developerId: "person", subjectId: "task" });
 const host = { ...f.host, storage: { get: () => { throw new Error("unavailable"); }, set: () => { throw new Error("unavailable"); } } };
 const records = taskActionRecords(host), fence = fenceFor(query, scope, "adapter");
 const ui = renderHook(() => records.usePendingWithFence(scope, fence, async () => undefined));
 expect(ui.result.current.kind).toBe("unavailable");expect(f.request).not.toHaveBeenCalled();
 ui.unmount();query.clear();
});
