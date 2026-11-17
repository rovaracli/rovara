// Fixtures for the Work page: contract v0 task, plan, proof and decision shapes (packages/contracts/src/code-contract-v0.ts), trimmed the way Cloud answers them.
import type { DecisionCard, DecisionsResponse } from "../../../packages/contracts/src/code-contract-v0.js";

export const NOW = new Date("2026-11-15T12:00:00.000Z");
export const ID = { plan: "11111111-1111-4111-8111-111111111111", running: "22222222-2222-4222-8222-222222222222", merge: "44444444-4444-4444-8444-444444444444", question: "55555555-5555-4555-8555-555555555555", checks: "66666666-6666-4666-8666-666666666666", waiting: "77777777-7777-4777-8777-777777777777", merged: "88888888-8888-4888-8888-888888888888", stale: "99999999-9999-4999-8999-999999999999" } as const;
/** Cloud's session for the question task (the answer goes to the session route, never the task id). */
export const QUESTION_SESSION = "ses_qqqqqqqqqqqqqqqqqqqq";
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 6e4).toISOString();

export function task(taskId: string, title: string, patch: Record<string, unknown> = {}, stage = "IMPLEMENT", state = "RUNNING", updatedMinutesAgo = 5) {
  return { taskId, title, project: "web", status: "RUNNING", workflow: { stage, state, revision: 3, path: "STANDARD" }, pullRequests: [], createdAt: ago(600), updatedAt: ago(updatedMinutesAgo), ...patch };
}
export const TASKS = [
  task(ID.plan, "Add a retry to the billing webhook", { workflow: { stage: "PLAN_REVIEW", state: "WAITING", revision: 4, path: "QUICK" } }, "PLAN_REVIEW", "WAITING", 2),
  task(ID.running, "Speed up the search index", {}, "IMPLEMENT", "RUNNING", 25),
  task(ID.merge, "Fix the README typo", { status: "SUCCEEDED", workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 12, path: "STANDARD" }, pullRequests: [{ repository: "example/web", number: 42, url: "https://github.com/example/web/pull/42", state: "open" }] }, "WAIT_FOR_MERGE", "WAITING", 40),
  task(ID.question, "Add a toxicity eval to the release gate", { sessionId: QUESTION_SESSION, workflow: { stage: "UNDERSTAND", state: "WAITING", revision: 2, path: "STANDARD", round: 2 } }, "UNDERSTAND", "WAITING", 60),
  task(ID.checks, "Rate-limit the public API", { workflow: { stage: "VERIFY", state: "BLOCKED", revision: 9, path: "STANDARD" } }, "VERIFY", "BLOCKED", 90),
  task(ID.waiting, "Document the router fallbacks", { workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 8, path: "STANDARD" } }, "WAIT_FOR_MERGE", "WAITING", 180),
  task(ID.merged, "Add request IDs to eval logs", { status: "SUCCEEDED", workflow: { stage: "MERGED", state: "COMPLETE", revision: 20, path: "STANDARD", outcome: "MERGED" }, pullRequests: [{ repository: "example/web", number: 40, state: "merged" }] }, "MERGED", "COMPLETE", 2000),
];

const NO = { expandEvidenceFirst: false, freshSignIn: false, secondPerson: false };
const act = (id: string, kind: "approve" | "reject", label: string) => ({ kind, label, href: `/v1/app/decisions/${id.replace(":", "/")}/${kind}`, method: "POST" as const });
function card(kind: string, taskId: string, patch: Partial<DecisionCard> & { id: string }): DecisionCard {
  return {
    kind, taskId, project: "web", title: "A decision", question: "Decide?", recommended: { action: "approve", why: "ok" }, next: { text: "Rovara goes on", minutes: 5 }, evidence: [{ kind: "cost", label: "Estimate", value: "$0.10 to $0.30", state: "good" }],
    risk: "low", riskReasons: [], friction: NO, actions: [act(patch.id, "approve", "Approve and build"), act(patch.id, "reject", "Reject")], rejectReasons: ["not_now", "other"], status: "pending", createdAt: ago(5), ...patch,
  };
}
export const CARDS: DecisionCard[] = [
  card("approve_plan", ID.plan, { id: `approve_plan:${ID.plan}`, title: "Add a retry to the billing webhook", question: "Approve this quick spec. Rovara makes the change, proves both criteria and opens the pull request.", next: { text: "Builds in 5 minutes", minutes: 5 }, createdAt: ago(2) }),
  card("merge", ID.merge, { id: `merge:${ID.merge}`, title: "Fix the README typo", question: "Merge the pull request?", risk: "medium", riskReasons: ["Changes the main branch"], friction: { ...NO, expandEvidenceFirst: true }, actions: [act(`merge:${ID.merge}`, "approve", "Merge"), act(`merge:${ID.merge}`, "reject", "Reject")], next: { text: "Merges into main", minutes: 1 }, createdAt: ago(40) }),
  card("answer_question", ID.question, { id: `answer_question:${ID.question}`, title: "Add a toxicity eval", question: "Should a toxicity score under 0.92 block the release, or only warn?", actions: [{ kind: "answer", label: "Block", href: "/app/live", method: "GET" }], next: { text: "Rovara keeps writing the other criteria" }, createdAt: ago(60) }),
  card("choose_checks", ID.checks, { id: `choose_checks:${ID.checks}`, title: "Rate-limit the public API", question: "Answer quality is 96.4%, under the 97% bar. Rovara tried 2 fixes and stopped.", next: { text: "Another approach costs about $1.50", minutes: 10 }, actions: [act(`choose_checks:${ID.checks}`, "approve", "Try another approach"), act(`choose_checks:${ID.checks}`, "reject", "Stop the task")], createdAt: ago(90) }),
];
export function decisionsView(cards: readonly DecisionCard[] = CARDS): DecisionsResponse {
  return { cards: [...cards], total: cards.length, tabs: {}, details: {}, digests: Object.fromEntries(cards.map(entry => [entry.id, "b".repeat(64)])), dropped: 0 };
}

export const PLAN = {
  taskId: ID.plan, document: "plan", version: 1, approved: false, current: true, summary: { headline: "One small change, one new test", checks: ["Unit tests", "Type check"] }, estimate: "about $0.10 to $0.30, 3 to 5 minutes", runLimitUsd: 2,
  requirements: [{ id: "R1", title: "Retries are bounded", criteria: [{ id: "R1.1", when: "the webhook fails", then: "it is retried three times", taskIds: ["T1"] }, { id: "R1.2", when: "all retries fail", then: "the event is dead-lettered", taskIds: ["T2"] }] }],
  tasks: [{ id: "T1", title: "Add the retry loop", status: "done", criterionIds: ["R1.1"] }, { id: "T2", title: "Dead-letter the event", status: "running", criterionIds: ["R1.2"] }],
  questions: [{ questionId: "Q1", text: "Keep the old behaviour behind a flag?", options: [{ optionId: "yes", label: "Yes, behind a flag" }, { optionId: "no", label: "No, replace it" }], criterionId: "R1.2", defaultOptionId: "no" }],
};
export const PROOF = { taskId: ID.plan, items: [
  { sha256: "d".repeat(64), title: "Unit tests", kind: "test_report", verdict: "pass", criterionIds: ["R1.1"], commit: "c".repeat(40) },
  { sha256: "e".repeat(64), title: "Release eval", kind: "eval", verdict: "fail", criterionIds: ["R1.2"], passed: 405, total: 420, bar: 0.97, commit: "c".repeat(40) },
  { sha256: "f".repeat(64), title: "Type check", kind: "check_result", verdict: "pass", criterionIds: [] },
] };
export const EVENTS = { events: [
  { seq: 1, at: "2026-11-15T11:00:00.000Z", kind: "status", text: "Task started" },
  { seq: 2, at: "2026-11-15T11:20:00.000Z", kind: "progress", text: "Writing the dead-letter writer", taskItemId: "T2", attempt: 1 },
] };
