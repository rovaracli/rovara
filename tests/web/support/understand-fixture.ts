import { createWorkflowSnapshot } from "@agentx/cloud-contracts";
import { sessionFixture, taskFixture, sessionPerson } from "./session-fixture.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const AT = "2026-10-23T12:00:00.000Z";
export const HOSTILE = "Which <img src=x onerror=window.__pwned=1> table\u202E?";
const QUESTIONS = [
  { id: "q1", text: HOSTILE, options: [{ id: "a", label: "The payments table" }, { id: "b", label: "The refunds table" }], recommended: "b" },
  { id: "q2", text: "Should old refunds be migrated?" },
] as const;

/** A task at Understand: waiting on a round of questions (revision 4, round 1 unless `round` says a later one), or understanding again once they are answered. */
export function understandSession(options: { waiting?: boolean; level?: "view" | "use" | "edit"; revision?: number; round?: number } = {}) {
  const waiting = options.waiting ?? true, level = options.level ?? "edit";
  const workflow = {
    ...createWorkflowSnapshot({ taskId: TASK, ownerId: sessionPerson.developerId, now: AT, definitionVersion: "1.1.0", understand: true }),
    revision: options.revision ?? 4, state: waiting ? "WAITING" : "RUNNING",
    intent: { rounds: options.round ?? 1, pathFrom: "understand", answers: [], ...(waiting ? { assessment: { kind: "questions", restatement: "Fix refunds", questions: QUESTIONS } } : {}) },
  };
  const task = taskFixture({ workflow });
  return sessionFixture({ kind: "task", status: waiting ? "needs_person" : "running", step: "Understanding", display: waiting ? { state: "needs_you", reason: "Rovara needs answers to its questions" } : { state: "understanding" }, where: { kind: "cloud" }, body: { kind: "task", task }, you: { level, owner: level === "edit", following: false, actions: ["watch", "comment"] }, revision: options.revision ?? 4 });
}

