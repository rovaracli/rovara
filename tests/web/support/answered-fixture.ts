import { answerWorkflowIntent, createWorkflowSnapshot, startWorkflowUnderstand } from "@agentx/cloud-contracts";
import { sessionFixture, taskFixture, sessionPerson } from "./session-fixture.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const AT = "2026-10-23T12:00:00.000Z";
export const HOSTILE_ANSWER = "It turns retries on <img src=x onerror=window.__pwned=1> for the payment worker.‮\nSecond line stays a line.";
export const ANSWER_SOURCES = [{ repository: "payments", path: "src/retry.ts", line: 4 }, { repository: "payments", path: "docs/flags.md" }] as const;
/** A source from a model that is not a plain file: markup, an angle bracket pair and control characters (a bell, a right-to-left override). It must show as one line of text. */
export const HOSTILE_SOURCE = { repository: "pay<img src=x onerror=window.__pwned=2>", path: "src/a>b\u0007\u202Ec.ts", line: 9 } as const;

/** A task Understand answered (CLOSED / COMPLETE / ANSWERED) as the web reads it, or an ordinary task still running when `answered` is false. */
export function answeredSession(options: { answered?: boolean; level?: "view" | "use" | "edit"; onMac?: boolean; answer?: string } = {}) {
  const answered = options.answered ?? true, level = options.level ?? "edit";
  const started = startWorkflowUnderstand(createWorkflowSnapshot({ taskId: TASK, ownerId: sessionPerson.developerId, now: AT, definitionVersion: "1.1.0", understand: true, pathFrom: "understand" }), AT);
  const workflow = answered
    ? answerWorkflowIntent(started, { expectedRevision: started.revision, assessment: { kind: "answer", restatement: "What does the retry flag do?", answer: options.answer ?? HOSTILE_ANSWER, sources: [...ANSWER_SOURCES, HOSTILE_SOURCE] }, artifact: { id: "art-1", objectKey: "private/owner/ws/intent.json", createdAt: AT }, now: AT })
    : started;
  const task = taskFixture({ workflow, status: answered ? "CLOSED" : "RUNNING" });
  return sessionFixture({ kind: "task", status: answered ? "succeeded" : "running", step: answered ? "Answered" : "Understanding", where: options.onMac === true ? { kind: "mac", label: "Priya's MacBook", offline: false } : { kind: "cloud" }, body: { kind: "task", task }, you: { level, owner: level === "edit", following: false, actions: ["watch", "comment"] }, revision: 3 });
}
