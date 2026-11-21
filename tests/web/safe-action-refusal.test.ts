// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { actionLock, actionSubject, createActionRecords, fenceFor, fencedRead, handleActionFailure, isFinalActionRefusal, recordUnknownActionCheck, useUnknownActionExit } from "../../packages/ui/src/safe-action.js";
import { parseAccepted, parsePending, type AcceptedAnswer, type PendingPress } from "../../packages/ui/src/screens/session/merge-pending.js";
import "./support/render.js";

const sid = "ses_aaaaaaaaaaaaaaaaaaaa", task = "11111111-1111-4111-8111-111111111111";
const subject = actionSubject({ orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "person-a", subjectId: sid });
const route = (act: string) => `/v1/app/sessions/${sid}/${act}`;
const decision = "/v1/app/decisions/approve_plan/task-a/approve";
const entry = (): PendingPress => ({ v: 1, sessionId: subject, requestId: "22222222-2222-4222-8222-222222222222", startedAt: new Date().toISOString(), heads: [{ repositoryId: "acme/repo", number: 1, headSha: "a".repeat(40) }], risk: "high", sent: ["shown"] });
function fixture() {
 const records = createActionRecords({ lockPrefix: "refusal.claim:", pendingPrefix: "refusal.pending:", acceptedPrefix: "refusal.accepted:", changedEvent: "refusal-changed", parsePending, parseAccepted, pendingSubject: (p: PendingPress) => p.sessionId, acceptedSubject: (a: AcceptedAnswer) => a.subject, canonicalAccepted: (a: AcceptedAnswer) => ({ ...a }) });
 const pending = entry(), fence = fenceFor(new QueryClient(), subject, "retry");
 expect(records.writePending(pending)).toBe(true);
 return { records, pending, fence };
}
beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks();vi.useRealTimers();localStorage.clear(); });

// Literal tuples from Code answer-request, owner-round, retry/send-back/review-findings,
// decision routes and Cloud routes; removing one guard must retain pending and fail its row.
const finals: Array<[string, number, string, string?]> = [
 [route("retry"), 403, "FORBIDDEN", "Only Ada can retry this session."], [route("retry"), 400, "CONFIG_INVALID", "requestId must be a UUID."],
 [route("send-back"), 404, "NOT_FOUND", "this task does not have a workflow record"], [route("retry"), 404, "SESSION_NOT_FOUND"],
 [route("retry"), 409, "IDEMPOTENCY_CONFLICT"], [route("retry"), 409, "CONFLICT"],
 [route("retry"), 403, "SESSION_LEVEL_REQUIRED"],
 [route("retry"), 409, "CONFIG_INVALID"],
 [route("send-back"), 409, "CONFLICT"], [route("accept-findings"), 409, "CONFLICT"],
 [route("accept-findings"), 409, "SECURITY_ACCEPT_NOT_HERE"],
 [route("answers"), 409, "INTENT_NOT_WAITING"], [`/v1/app/tasks/${task}/answers`, 409, "INTENT_NOT_WAITING"],
 [route("send-back"), 409, "PROJECT_ARCHIVED"], [route("send-back"), 402, "BUDGET_EXCEEDED"],
 [route("send-back"), 402, "ORG_BUDGET_EXCEEDED"], [route("send-back"), 402, "PROJECT_BUDGET_EXCEEDED"],
 [route("send-back"), 402, "AGENT_BUDGET_EXCEEDED"], [route("send-back"), 402, "MACHINE_TIME_EXCEEDED"], [route("send-back"), 403, "TRIAL_LOCKED"],
 [decision, 409, "CHANGE_STALE"], [decision, 409, "MERGE_NOT_READY"], [decision, 404, "NOT_FOUND"],
 [decision, 400, "CONFIG_INVALID"], [decision, 403, "FORBIDDEN"],
 [route("merge"), 409, "IDEMPOTENCY_CONFLICT"], [route("merge"), 403, "FORBIDDEN"],
 [route("merge"), 404, "TASK_NOT_FOUND"], [route("merge"), 404, "SESSION_NOT_FOUND"], [route("merge"), 400, "CONFIG_INVALID"],
];
it.each(finals)("%s %s %s clears only this press, keeps server words, and permits use only after a fresh read", async (path, status, code, serverWords) => {
 const f = fixture(), words: string[] = [];
 let finish!: (value: string) => void;
 const read = () => fencedRead(f.fence, () => new Promise<string>(resolve => { finish = resolve; }));
 const wordsFromServer = serverWords ?? `Server says: ${code}`;
 const failure = new ApiError(status, code, wordsFromServer);
 expect(handleActionFailure({ ...f, entry: f.pending, subject, failure, route: path, pullCount: 1, message: word => { words.push(word); }, read, readIdentity: async () => undefined })).toBe("refused");
 expect(f.records.readPendingNow(subject).kind).toBe("none");
 expect(words).toEqual([wordsFromServer]);
 expect(f.fence.taskFailed).toBeDefined();
 expect(actionLock({ unresolved: false, drift: false, ready: f.fence.taskFailed === undefined })).toBe("not_ready");
 finish("fresh task body"); await Promise.resolve(); await Promise.resolve();
 expect(f.fence.taskFailed).toBeUndefined(); expect(f.fence.latestRead?.data).toBe("fresh task body");
 expect(actionLock({ unresolved: false, drift: false, ready: true })).toBeUndefined();
 expect(f.records.claimPending({ ...f.pending, requestId: "33333333-3333-4333-8333-333333333333" }, () => undefined, "storage").stop).toBe(false);
});

// Keep the pre-dispatch validations usable, but bind the sentence to its own route.
it.each([
 ...["retry", "send-back", "accept-findings", "answers"].map(action => [route(action), "requestId must be a UUID."]),
 [route("send-back"), "The note is at most 1,000 characters."],
 [route("accept-findings"), "Give a reason of up to 500 characters for accepting the findings."],
 ...[route("answers"), `/v1/app/tasks/${task}/answers`].flatMap(path => [
  "The answers must be a JSON object.", "requestId must be a UUID.",
  "round must be a whole number from 1 to 1,000,000.", "revision must be a whole number from 0 to 1,000,000.",
  "answers must list 1 to 3 answers.", "Each answer needs a questionId (q1 to q3) and an optionId (a to d), some text, or both.",
  "An answer's text is 1 to 2,000 characters.",
 ].map(words => [path, words])),
])("%s: exact Cloud validation %s stays final and route-scoped", (path, words) => {
 expect(isFinalActionRefusal(new ApiError(400, "CONFIG_INVALID", words), { route: path })).toBe(true);
 expect(isFinalActionRefusal(new ApiError(400, "CONFIG_INVALID", words), { route: "/v1/app/unreviewed" })).toBe(false);
 expect(isFinalActionRefusal(new ApiError(400, "CONFIG_INVALID", words + " after applying"), { route: path })).toBe(false);
});

it.each([
 [route("retry"), 404, "TASK_NOT_FOUND", 1], [route("retry"), 403, "TASK_ACCESS_DENIED", 1],
 [route("retry"), 404, "NOT_FOUND", 1], [route("retry"), 403, "FORBIDDEN", 1],
 [route("accept-findings"), 403, "FORBIDDEN", 1], [route("retry"), 400, "CONFIG_INVALID", 1],
 [route("merge"), 409, "MERGE_NOT_READY", 1], [route("merge"), 400, "CONFIG_INVALID", 2],
 [route("merge"), 400, "CONFIG_INVALID", undefined], [route("merge"), 404, "NOT_FOUND", 1],
 ["/v1/app/decisions/merge/task-a/approve", 409, "MERGE_NOT_READY", 1],
 [route("close"), 404, "TASK_NOT_FOUND", 1], // Code close can raise this after applying.
 [route("people/add"), 409, "CHANGE_STALE", 1], // Code can already have invited on Slack.
 [route("retry"), 401, "AUTH_REQUIRED", 1], [route("retry"), 408, "CONFIG_INVALID", 1],
 [route("retry"), 429, "FORBIDDEN", 1], [route("retry"), 503, "CONFLICT", 1],
 [route("retry"), 500, "FORBIDDEN", 1], [route("retry"), 502, "INVALID_RESPONSE", 1],
 [route("retry"), 200, "CONFIG_INVALID", 1], [route("retry"), 202, "FORBIDDEN", 1],
 [route("retry"), 0, "UNKNOWN_OUTCOME", 1], [route("retry"), 403, "CONFIG_INVALID", 1],
 [route("retry"), 409, "UNREVIEWED_CODE", 1], ["/v1/app/unreviewed", 403, "FORBIDDEN", 1],
 ["https://elsewhere.test" + route("retry"), 403, "FORBIDDEN", 1],
] as const)("%s %s %s (%s pulls) stays held without reread, clear or resend", (path, status, code, pullCount) => {
 const f = fixture(), before = localStorage.getItem("refusal.pending:" + subject), message = vi.fn(), read = vi.fn(async () => undefined);
 expect(handleActionFailure({ ...f, entry: f.pending, subject, failure: new ApiError(status, code, "Unknown"), route: path, ...(pullCount === undefined ? {} : { pullCount }), message, read, readIdentity: read })).toBe("unknown");
 expect(localStorage.getItem("refusal.pending:" + subject)).toBe(before);
 expect(f.records.claimPending(f.pending, () => undefined, "storage").stop).toBe(true);
 expect(read).not.toHaveBeenCalled(); expect(message).not.toHaveBeenCalled();
});

it("network failure and status/code lookalikes remain unknown; browser API aliases share the exact tuple", () => {
 expect(isFinalActionRefusal(new Error("lost network"), { route: route("retry") })).toBe(false);
 expect(isFinalActionRefusal({ status: 403, code: "FORBIDDEN" }, { route: route("retry") })).toBe(false);
 expect(isFinalActionRefusal(new ApiError(409, "CONFLICT", "nothing"), { route: `/v1/web/sessions/${sid}/retry` })).toBe(true);
});
it.each(["CSRF_INVALID", "CSRF_STALE"])("%s clears a pre-dispatch press and re-reads identity without calling it an authority refusal", async code => {
 const f = fixture();let identityReads = 0;
 expect(handleActionFailure({ ...f, entry: f.pending, subject, route: route("retry"), failure: new ApiError(403, code, "Refresh this sign-in"), message: () => undefined, read: () => fencedRead(f.fence, async () => "fresh"), readIdentity: async () => { identityReads += 1; } })).toBe("csrf");
 await Promise.resolve(); expect(identityReads).toBe(1); expect(f.records.readPendingNow(subject).kind).toBe("none");
});
it("a refused re-read retains the fence; a later read recovers without permanent lock", async () => {
 const f = fixture();
 handleActionFailure({ ...f, entry: f.pending, subject, route: route("retry"), failure: new ApiError(409, "CONFLICT", "Nothing to retry"), message: () => undefined, read: () => fencedRead(f.fence, async () => { throw new ApiError(403, "FORBIDDEN", "Cannot read"); }), readIdentity: async () => undefined });
 await Promise.resolve(); await Promise.resolve(); expect(f.fence.taskFailed).toBeDefined();
 await fencedRead(f.fence, async () => "recovered"); expect(f.fence.taskFailed).toBeUndefined();
});

it("after exactly three unknown checks the exit links to the task; Check and the held record remain", () => {
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-21T00:00:00.000Z"));
 const f = fixture(), href = `/s/${sid}`;
 const { result, unmount } = renderHook(() => useUnknownActionExit(f.fence, f.pending, href));
 const before = localStorage.getItem("refusal.pending:" + subject);
 expect(result.current).toBeUndefined();
 act(() => { recordUnknownActionCheck(f.fence, f.pending); recordUnknownActionCheck(f.fence, f.pending); });
 expect(result.current).toBeUndefined();
 act(() => { recordUnknownActionCheck(f.fence, f.pending); });
 expect(result.current).toEqual({ message: "We couldn't confirm this. Open the task to check", href });
 unmount(); const remount = renderHook(() => useUnknownActionExit(f.fence, f.pending, href));
 remount.rerender(); // A remount must retain counts on the next render, too (M4).
 expect(remount.result.current?.href).toBe(href); // the subject fence survives navigation
 expect(localStorage.getItem("refusal.pending:" + subject)).toBe(before);
 expect(f.records.claimPending(f.pending, () => undefined, "storage").stop).toBe(true);
});
it("after exactly ten minutes the exit appears without a check; reload uses the pending start time", () => {
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-21T00:00:00.000Z"));
 const f = fixture(), href = `/s/${sid}`;
 const { result } = renderHook(() => useUnknownActionExit(f.fence, f.pending, href));
 act(() => { vi.advanceTimersByTime(599_999); }); expect(result.current).toBeUndefined();
 act(() => { vi.advanceTimersByTime(1); }); expect(result.current).toEqual({ message: "We couldn't confirm this. Open the task to check", href });
 const reloadFence = fenceFor(new QueryClient(), subject, "retry");
 const reload = renderHook(() => useUnknownActionExit(reloadFence, f.pending, href));
 expect(reload.result.current?.href).toBe(href); expect(f.records.readPendingNow(subject).kind).toBe("pending");
});
it("unknown checks cannot leak to a new press, another person or a resolved record", () => {
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-21T00:00:00.000Z"));
 const f = fixture(), href = `/s/${sid}`;
 act(() => { for (let n = 0; n < 3; n += 1) recordUnknownActionCheck(f.fence, f.pending); });
 const next = { ...f.pending, requestId: "33333333-3333-4333-8333-333333333333" };
 const other = fenceFor(new QueryClient(), "other-person", "retry");
 expect(renderHook(() => useUnknownActionExit(f.fence, next, href)).result.current).toBeUndefined();
 expect(renderHook(() => useUnknownActionExit(other, f.pending, href)).result.current).toBeUndefined();
 const resolved = renderHook(() => useUnknownActionExit(f.fence, undefined, href));
 expect(resolved.result.current).toBeUndefined();
});

// Option (a): even Code's pre-commit words cannot unlock these two routes.
it.each(["send-back", "accept-findings"].flatMap(action => [
 "People changed; refresh the task and try again",
 "this request ID was already used for another decision on this task; use a new one",
 "this send-back is out of date; refresh the task and try again",
 "these findings are out of date; refresh the task and try again", "", "Unreviewed words",
].flatMap(words => ["app", "web"].map(alias => [action, words, alias]))))(
 "%s IDEMPOTENCY_CONFLICT (%s, %s) never matches message text", (action, words, alias) => {
 expect(isFinalActionRefusal(new ApiError(409, "IDEMPOTENCY_CONFLICT", words), { route: `/v1/${alias}/sessions/${sid}/${action}` })).toBe(false);
});
