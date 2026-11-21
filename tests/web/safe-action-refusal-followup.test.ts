// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { actionSubject, createActionRecords, fenceFor, fencedRead, isFinalActionRefusal } from "../../packages/ui/src/safe-action.js";
import { parsePending, parseAccepted, type PendingPress, type AcceptedAnswer } from "../../packages/ui/src/screens/session/merge-pending.js";
import "./support/render.js";
const subject = actionSubject({ orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "person-a", subjectId: "ses_aaaaaaaaaaaaaaaaaaaa" });
afterEach(() => { localStorage.clear(); });
it.each(["stop", "close", "take-over"])("%s: Cloud's pre-forward request validation and missing session are final", action => {
 const route = `/v1/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa/${action}`;
 expect(isFinalActionRefusal(new ApiError(400, "CONFIG_INVALID", "requestId must be a UUID."), { route })).toBe(true);
 expect(isFinalActionRefusal(new ApiError(404, "SESSION_NOT_FOUND", "That session doesn't exist, or you can't see it."), { route })).toBe(true);
 // These Codes may also come from later work inside Code itself: no guess from the status alone.
 expect(isFinalActionRefusal(new ApiError(404, "TASK_NOT_FOUND", "no such task"), { route })).toBe(false);
 expect(isFinalActionRefusal(new ApiError(400, "CONFIG_INVALID", "A later Code operation failed"), { route })).toBe(false);
});
it("pending removal in another tab installs that tab's own fence and fresh read before use", async () => {
 const records = createActionRecords({ lockPrefix: "cross.claim:", pendingPrefix: "cross.pending:", acceptedPrefix: "cross.accepted:", changedEvent: "cross-change", parsePending, parseAccepted, pendingSubject: (p: PendingPress) => p.sessionId, acceptedSubject: (a: AcceptedAnswer) => a.subject, canonicalAccepted: (a: AcceptedAnswer) => ({ ...a }) });
 const entry: PendingPress = { v: 1, sessionId: subject, requestId: "11111111-1111-4111-8111-111111111111", startedAt: new Date().toISOString(), heads: [{ repositoryId: "a/b", number: 1, headSha: "a".repeat(40) }], risk: "high", sent: ["shown"] };
 records.writePending(entry);
 const otherTab = fenceFor(new QueryClient(), subject, "retry");
 await fencedRead(otherTab, async () => "old body");
 let resolve!: (value: string) => void;
 const read = () => fencedRead(otherTab, () => new Promise<string>(yes => { resolve = yes; }));
 const { result } = renderHook(() => records.usePendingWithFence(subject, otherTab, read));
 expect(result.current.kind).toBe("pending");
 const oldValue = localStorage.getItem("cross.pending:" + subject);
 // Another tab's storage mutation can be read before its StorageEvent arrives.
 // The claim must refuse that interval too, not only react to event delivery.
 const next = { ...entry, requestId: "22222222-2222-4222-8222-222222222222" };
 localStorage.removeItem("cross.pending:" + subject);
 act(() => {
  expect(records.claimPending(next, () => undefined, "storage").stop).toBe(true);
 });
 expect(localStorage.getItem("cross.pending:" + subject)).toBeNull();
 // StorageEvent is what the other tab receives; no cross-tab clock or server receipt is invented.
 act(() => {
  globalThis.dispatchEvent(new StorageEvent("storage", { key: "cross.pending:" + subject, oldValue, newValue: null }));
 });
 expect(result.current.kind).toBe("none"); expect(otherTab.taskFailed).toBeDefined();
 expect(otherTab.latestRead?.data).toBe("old body");
 await act(async () => { resolve("other tab's own fresh body"); await Promise.resolve(); });
 expect(otherTab.taskFailed).toBeUndefined(); expect(otherTab.latestRead?.data).toBe("other tab's own fresh body");
 act(() => { expect(records.claimPending(next, () => undefined, "storage").stop).toBe(false); });
});
