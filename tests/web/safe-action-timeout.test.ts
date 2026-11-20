// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { postWithTimeout } from "../../packages/ui/src/safe-action.js";
import { createSessionActions } from "../../packages/ui/src/api/session-actions.js";
import { fakeHost } from "./support/fake-host.js";
afterEach(() => { vi.useRealTimers(); });
it("timeout is UNKNOWN, never a refusal/retry, and consumes a late rejection", async () => {
 vi.useFakeTimers();
 let rejectLate!: (reason: Error) => void;
 const send = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectLate = reject; }));
 const ended = vi.fn();
 const result = postWithTimeout(send).catch(ended);
 await vi.advanceTimersByTimeAsync(29_999);expect(ended).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);
 expect(ended).toHaveBeenCalledWith(expect.objectContaining({ status: 0, code: "UNKNOWN_OUTCOME" }));
 expect(send).toHaveBeenCalledTimes(1);
 rejectLate(new Error("late"));await result;
 expect(ended).toHaveBeenCalledTimes(1);
});
it("per-action timeout leaves the operation alive and ignores a late answer", async () => {
 vi.useFakeTimers();
 let answer!: (value: string) => void;
 const ended = vi.fn();
 const result = postWithTimeout(() => new Promise<string>(resolve => { answer = resolve; }), 120_000).then(ended, ended);
 await vi.advanceTimersByTimeAsync(30_000);expect(ended).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(90_000);expect(ended).toHaveBeenCalledWith(expect.objectContaining({ code: "UNKNOWN_OUTCOME" }));
 answer("accepted late");await result;expect(ended).toHaveBeenCalledTimes(1);
});
it("a definitive early answer clears the timer", async () => {
 vi.useFakeTimers();expect(await postWithTimeout(async () => "answer")).toBe("answer");expect(vi.getTimerCount()).toBe(0);
});
it("Merge POST uses 120s, retry never, exact payload and one transport request", async () => {
 vi.useFakeTimers();
 const f = fakeHost(async () => new Promise<never>(() => undefined));
 const payload = { expectedHeads: [{ repositoryId: "acme/repo", number: 1, headSha: "a".repeat(40) }], risk: "high" as const };
 const ended = vi.fn();
 const result = createSessionActions(f.host).merge("ses_aaaaaaaaaaaaaaaaaaaa", "11111111-1111-4111-8111-111111111111", payload).catch(ended);
 await vi.advanceTimersByTimeAsync(30_000);expect(ended).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(90_000);expect(ended).toHaveBeenCalledWith(expect.objectContaining({ code: "UNKNOWN_OUTCOME" }));
 expect(f.request).toHaveBeenCalledTimes(1);
 expect(f.request.mock.calls[0]?.[0]).toMatchObject({ method: "POST", retry: "never", body: { requestId: "11111111-1111-4111-8111-111111111111", ...payload } });
 await result;
});
