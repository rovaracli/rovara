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


it("preserves Code's omitted money for reader and co-owner sessions without reviving legacy spend", () => {
 for (const coOwner of [false, true]) {
  const raw = { ...task(), runEstimate: { lowUsd: 4.37, highUsd: 10.19, runLimitUsd: 12.71, stopAtUsd: 12.71 }, runLimit: { limitUsd: 12.71 }, owner: { developerId: "stored-task-owner", name: "Owner" } };
  const view = sessionView(session, raw, { developerId: "same-company-member" }, "https://example.test", undefined, { coOwner });
  const tile = liveTile(session, raw, { developerId: "same-company-member" }, "https://example.test", undefined, { coOwner });
  for (const output of [view, tile]) {
   expect((output as { money?: unknown }).money).toBeUndefined();
   const walk = (value: unknown): number[] => typeof value === "number" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(walk) : [];
   for (const figure of [999, 4.37, 10.19, 12.71]) expect(walk(output)).not.toContain(figure);
  }
  expect(view.body.task).not.toHaveProperty("runEstimate");
  expect(view.body.task).not.toHaveProperty("spent");
  expect(view.cost).not.toHaveProperty("spentUsd");
  expect(tile).not.toHaveProperty("costUsd");
 }
});

it("retains the stored owner's estimate and limit and never invents missing spend", () => {
 const raw = { ...task(), owner: person, runEstimate: { lowUsd: 4.37, highUsd: 10.19, runLimitUsd: 12.71 }, runLimit: { limitUsd: 12.71 } };
 expect(sessionView(session, raw, person, "https://example.test")).toMatchObject({ body: { task: { runEstimate: raw.runEstimate } }, cost: { spentUsd: 999, runLimitUsd: 12.71 } });
 const missing = { ...raw }; delete missing.spent;
 expect(sessionView(session, missing, person, "https://example.test").cost).not.toHaveProperty("spentUsd");
 expect(liveTile(session, missing, person, "https://example.test")).not.toHaveProperty("costUsd");
});

it("keeps admin figures while a stale session owner cannot see the stored owner's figures", () => {
 const raw = { ...task(), owner: { developerId: "new-owner" }, runLimit: { limitUsd: 12.71 }, runEstimate: { lowUsd: 4.37, highUsd: 10.19, runLimitUsd: 12.71 } };
 for (const companyRole of ["owner", "admin"]) expect(sessionView(session, raw, { developerId: "company-admin", companyRole }, "https://example.test")).toMatchObject({ cost: { spentUsd: 999, runLimitUsd: 12.71 }, body: { task: { runEstimate: raw.runEstimate } } });
 expect(sessionView(session, raw, person, "https://example.test").body.task).not.toHaveProperty("runEstimate");
});
