import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { workTask, detailedRow } from "../../packages/cloud-server/src/work-reads.js";
import { liveTile, sessionView, type CodeTask } from "../../packages/cloud-server/src/session-view.js";
import type { WorkSession } from "../../packages/cloud-server/src/work-sessions.js";
import { type TaskMoneyV1, parseTaskMoneyV1, taskMoneyWords, mergeTaskMoney } from "../../packages/contracts/src/task-money.js";
const sample = () => (JSON.parse(readFileSync(new URL("../../contracts/shared/task-money.v1.json", import.meta.url), "utf8")) as { examples: TaskMoneyV1[] }).examples[0]!;
const task = (money?: unknown) => ({ taskId: "money-task", title: "Task", project: "payments", status: "CLOSED", createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z", money, spent: { usd: 999 } }) as CodeTask;
const person = { developerId: "owner", name: "Owner" };
const session = { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", taskId: "money-task", owner: person, startedBy: person, revision: 1, createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z" } as unknown as WorkSession;
it("preserves identical money revision and value across detailed list, work, session and terminal receipt tile", () => {
 const money = sample(), row = detailedRow(task(money));
 expect(workTask(row)?.money).toEqual(money);
 expect(sessionView(session, task(money), person, "https://example.test")).toMatchObject({ money });
 expect(liveTile(session, task(money), person, "https://example.test")).toMatchObject({ money });
 expect(taskMoneyWords(money)).toBe("under $0.01 (not yet confirmed)");
});
it("old Code and malformed or cross-task money are unavailable, regardless of legacy dollars", () => {
 for (const money of [undefined, { ...sample(), injected: true }, { ...sample(), taskId: "other-task" }]) {
  expect(workTask(task(money))?.money).toBeUndefined();
  expect(sessionView(session, task(money), person, "https://example.test").money).toBeUndefined();
 }
 expect(taskMoneyWords(undefined)).toBe("Cost unavailable");
});
it("keeps current, partial, awaiting-only and unavailable states distinct and safe", () => {
 const p = sample(), a = (value: number) => ({ state: "available" as const, value });
 const current: TaskMoneyV1 = { ...p, state: "current", spentMicros: a(80), finalMicros: a(80), estimatedMicros: a(0), awaitingUsageMicros: a(0), awaitingUsageCalls: a(0), heldMicros: a(0), coverage: { expectedCalls: a(1), finalCalls: 1, estimatedCalls: 0, awaitingUsageCalls: 0, incompatibleCurrencyCalls: 0 }, stop: { ...p.stop, coverage: "complete" }, finality: "final" };
 expect(parseTaskMoneyV1(current)).toEqual(current);
 expect(taskMoneyWords(current)).toBe("under $0.01");
 const unavailable: TaskMoneyV1 = { ...p, state: "unavailable", spentMicros: { state: "unavailable", reason: "not_measured" }, finalMicros: { state: "unavailable", reason: "not_measured" }, estimatedMicros: { state: "unavailable", reason: "not_measured" }, awaitingUsageMicros: { state: "unavailable", reason: "not_measured" }, finality: "unavailable" };
 expect(parseTaskMoneyV1(unavailable)).toEqual(unavailable);
 expect(taskMoneyWords(unavailable)).toBe("Cost unavailable");
 expect(mergeTaskMoney({ ...p, revision: 8 }, { ...p, revision: 7 })).toMatchObject({ revision: 8 });
 expect(mergeTaskMoney(p, undefined)).toBeUndefined();
});
