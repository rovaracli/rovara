// @vitest-environment jsdom
// Understand's questions answered from the Work list and Home (Code #1057's round on each `?detail=1` row). The rows are Code's REAL rows (tests/fixtures/code-inline-understand.json),
// which Cloud's list passes on with the same round, outcome and workflow fields (tests/unit/cloud-server-inline-understand.test.ts proves Cloud's answer for them): the questions show inline with option buttons (the recommended one marked) and free text, the answers go to
// `POST /v1/app/tasks/{taskId}/answers` with the row's workflow revision and round (the session page's body), the row is read again after, a row with no round sends the person to the
// task's page, and the workflow's outcome is a short label on the row.
import { afterEach, expect, it } from "vitest";
import { openRoundOf, readRound, readTaskList, workRow } from "../../packages/ui/src/api/work.js";
import { QuietCard } from "../../packages/ui/src/screens/work/TaskPane.js";
import { readFileSync } from "node:fs";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

interface Answer { status: number; body: Record<string, unknown> }
const F = JSON.parse(readFileSync("tests/fixtures/code-inline-understand.json", "utf8")) as Record<"waitingList" | "answeredList" | "closedList" | "noAccessList" | "staleAnswer" | "noAccessAnswer", Answer> & { taskId: string; noAccessTaskId: string; round: number; revision: number };
/** Cloud's list answer for Code's detailed list: for these rows, Code's own fields (the server test checks Cloud passes them on). */
const cloudList = (code: Answer) => ({ status: 200, body: { tasks: code.body["tasks"] as Array<Record<string, unknown>> } });
let close: (() => void) | undefined;
afterEach(() => { close?.();close = undefined; });

it("reads Cloud's round from Code's real rows; a row is answerable inline only while a question is unanswered and the row names its revision", () => {
 const [waiting] = readTaskList(cloudList(F.waitingList).body), [answered] = readTaskList(cloudList(F.answeredList).body), [refused] = readTaskList(cloudList(F.noAccessList).body), [closed] = readTaskList(cloudList(F.closedList).body);
 expect(openRoundOf(waiting!)).toEqual({ round: 1, revision: 3, questions: waiting!.round!.questions });
 expect(waiting!.round!.questions.map(question => question.recommended)).toEqual(["b", undefined]);
 expect(openRoundOf(answered!)).toBeUndefined();
 expect(openRoundOf({ ...waiting!, workflow: { stage: "UNDERSTAND", state: "WAITING" } })).toBeUndefined();
 // Only while Understand waits on a task that has not ended: a round a row still carries past that is not answerable.
 expect(openRoundOf({ ...waiting!, workflow: { ...waiting!.workflow!, stage: "PLAN" } })).toBeUndefined();
 expect(openRoundOf({ ...waiting!, workflow: { ...waiting!.workflow!, state: "RUNNING" } })).toBeUndefined();
 for (const status of ["CLOSED", "CANCELLED", "FAILED", "INTERRUPTED"] as const) expect(openRoundOf({ ...waiting!, status })).toBeUndefined();
 expect(refused!.round).toBeUndefined();
 expect(closed!.outcome).toBe("CLOSED");
 expect(readTaskList({ tasks: [{ ...(cloudList(F.closedList).body.tasks[0] as object), outcome: "SOMETHING" }] })[0]!.outcome).toBeUndefined();
 const real = cloudList(F.waitingList).body.tasks[0]!["round"];
 expect(readRound(real)).toEqual(waiting!.round);
 for (const bad of [{ round: 1, questions: [] }, { round: 0, questions: waiting!.round!.questions }, { round: 1, questions: [{ id: "q1", text: "x", answered: false, recommended: "a" }] }, { round: 1, questions: [{ id: "q1", text: "x" }] }]) expect(readRound(bad)).toBeUndefined();
 // The row asks the person, under Needs you, while a question waits; once answered it is Rovara's again.
 expect(workRow(waiting!, undefined, new Date("2026-11-15T12:00:00.000Z"))).toMatchObject({ group: "you", need: "Answer questions", tone: "wait" });
 expect(workRow(answered!, undefined, new Date("2026-11-15T12:00:00.000Z"))).toMatchObject({ group: "run" });
 expect(workRow(refused!, undefined, new Date("2026-11-15T12:00:00.000Z"))).toMatchObject({ group: "others" });
 // The side pane says where the questions are answered, not that a decision card is missing.
 const pane = renderUi(h(QuietCard, { row: workRow(waiting!, undefined, new Date("2026-11-15T12:00:00.000Z")), decisionsError: undefined }));
 expect(pane.container.textContent).toContain("Rovara has questions before it plans this. Answer them under this task in the list, or on the task's page.");
 expect(pane.container.textContent).not.toContain("decision card");
 pane.unmount();
});
