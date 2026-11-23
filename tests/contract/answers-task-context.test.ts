import { expect, it } from "vitest";
import { AnswerAskBodySchema, AnswerTaskCitationSchema, AnswerHistoryResponseSchema } from "../../packages/contracts/src/app-answers.js";
const taskId = "00000000-0000-0000-0000-000000000000";
const source = { n: 1, kind: "task_state", taskId, quote: "The plan is waiting for approval." };
const entry = { answerId: "answer-1", threadId: "thread-1", question: "Why?", answer: "Waiting. [1]", createdAt: "2026-11-22T12:00:00.000Z", sources: [source] };
it("keeps legacy Ask inputs and Code's published task and history inputs working", () => {
 expect(AnswerAskBodySchema.parse({ requestId: "request-1", question: "Why?" })).toEqual({ requestId: "request-1", question: "Why?" });
 expect(AnswerAskBodySchema.parse({ requestId: "request-1", question: "Why?", taskId }).taskId).toBe(taskId);
 expect(AnswerTaskCitationSchema.parse(source)).toEqual(source);
 expect(AnswerHistoryResponseSchema.parse({ entries: [entry], more: false })).toEqual({ entries: [entry], more: false });
 expect(AnswerHistoryResponseSchema.parse({ entries: [], more: true })).toEqual({ entries: [], more: true });
});
it.each(["invalid", "11111111-1111-4111-8111-11111111111A", 1, null])("rejects a malformed task input %j", value => {
 expect(AnswerAskBodySchema.safeParse({ requestId: "request-1", question: "Why?", taskId: value }).success).toBe(false);
});
it.each([{ n: 0 }, { n: 9 }, { kind: "code" }, { taskId: "bad" }, { quote: "short" }, { quote: "x".repeat(601) }, { quote: "hidden\u0000control characters" }, { extra: true }])("rejects a malformed task source %j", change => {
 expect(AnswerTaskCitationSchema.safeParse({ ...source, ...change }).success).toBe(false);
});
it.each([{ answerId: "!" }, { threadId: "!" }, { question: "x".repeat(2001) }, { question: "hidden\u0000" }, { answer: "x".repeat(6001) }, { answer: "hidden\u0000" }, { createdAt: "yesterday" }, { sources: Array(9).fill(source) }, { sources: [{ ...source, kind: "unknown" }] }, { extra: true }])("rejects a malformed history entry %j", change => {
 expect(AnswerHistoryResponseSchema.safeParse({ entries: [{ ...entry, ...change }], more: false }).success).toBe(false);
});
it.each([{ entries: Array(1001).fill(entry), more: false }, { entries: [], more: "false" }, { entries: [], more: false, extra: true }])("rejects a malformed history envelope", value => {
 expect(AnswerHistoryResponseSchema.safeParse(value).success).toBe(false);
});
