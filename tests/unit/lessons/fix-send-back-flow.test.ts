// LP-13 C4: the whole send-back flow with the decisions in MIXED order. A task's decision history interleaves a person's plain send-back, a person's resolve-findings "to fix" (a FIX), Rovara's own automatic fixes and
// retries, approvals and accept-all findings. The production subject source lists the person's send-backs (and only those) in the order they were made, the reflector's subject reads each one's own row, and no
// automatic or approving decision is ever read as a person's words, whatever the order. (The pieces are tested alone in lesson-subject-source.test.ts and task-subject; this holds them together.)
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { lessonSubjectSource } from "../../../packages/broker/src/aws/broker/lesson-subject-source.js";
import { taskKey, taskOwnerKey } from "../../../packages/broker/src/developer/task-records.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { subjectForTask, type TaskLearningDeps } from "../../../packages/broker/src/lessons/task-end.js";
import type { OutcomeRowReader } from "../../../packages/broker/src/lessons/task-outcome-rows.js";
import type { SendBackFact } from "../../../packages/broker/src/lessons/task-subject.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { WS } from "./lesson-helpers.js";

const PROJECT = "proj-1";
const TASK = randomUUID();
const CREATOR = "creator-1";
const ANN = "a".repeat(64);
const BOB = "b".repeat(64);

const decision = (over: Record<string, unknown> = {}) => ({ requestId: randomUUID(), workflowRevision: 1, decision: "REQUEST_CHANGES", actorId: taskOwnerKey(CREATOR, TASK), actorRole: "TASK_OWNER", reason: "ignored", source: "SEND_BACK", at: "2026-11-01T00:00:00.000Z", ...over });
const auto = (source: "AUTO_FIX" | "AUTO_RETRY" | "GATE" | "FINDINGS", over: Record<string, unknown> = {}) => decision({ source, actorRole: "AGENTX", actorId: "f".repeat(64), auto: { stage: "VERIFY" }, ...over });

function record(decisions: unknown[]) {
  return {
    ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: WS, project: PROJECT, developerId: CREATOR, developerName: "Creator", provider: "oidc", client: "web",
    requestText: "Make the retries use withRetry", title: "Retries", agent: { agentId: "a" }, startedBy: { developerId: CREATOR }, ownerKey: taskOwnerKey(CREATOR, TASK),
    workflow: {
      schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: TASK, ownerId: taskOwnerKey(CREATOR, TASK), revision: 3, stage: "WAIT_FOR_MERGE", state: "COMPLETE", outcome: "MERGED",
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", artifacts: [], decisions,
      reviewBase: [{ repositoryId: "api", baseCommitSha: "a".repeat(40) }],
      pullRequests: [{ repositoryId: "api", number: 7, url: "https://github.com/acme/api/pull/7", candidateDigest: "b".repeat(64), required: true, state: "MERGED" }],
    },
  };
}

/** The rows the record holds, by request id. A request with no entry has no row (its sender was erased, or the write never landed). */
function rowsFor(facts: Map<string, SendBackFact>): OutcomeRowReader & { asked: string[] } {
  const asked: string[] = [];
  return { asked, async sendBack(input) { asked.push(input.requestId); return facts.get(input.requestId); }, async revertedBy() { return undefined; } };
}

async function subjectOf(decisions: unknown[], rows: OutcomeRowReader) {
  const db = new FakeDynamoDb();
  db.set(record(decisions));
  const source = lessonSubjectSource({
    documentClient: db, tableName: "state", repositoriesOf: async () => ["api"], standing: async () => "member", isErased: async () => false, visibility: async () => ({ kind: "shared" }), now: () => 1_800_000_000_000,
  });
  const deps = { source, rows, process: { store: new InMemoryLessonStore() } } as unknown as TaskLearningDeps;
  return { base: await source.read({ workspaceId: WS, taskId: TASK }), subject: await subjectForTask(deps, { workspaceId: WS, taskId: TASK }) };
}

describe("FIX send-backs among automatic fixes, retries and approvals, in mixed order", () => {
  const plain = decision({ reason: "plain send-back" });
  const fix = decision({ source: "FINDINGS", reason: "1 accepted, 1 to fix" });
  const erased = decision({ reason: "sender erased" });
  const autoFix = auto("AUTO_FIX"), autoRetry = auto("AUTO_RETRY"), autoFindings = auto("FINDINGS"), gate = auto("GATE", { decision: "APPROVE" });
  const acceptAll = decision({ source: "FINDINGS", decision: "APPROVE", reason: "2 accepted, 0 to fix" });
  const facts = (): Map<string, SendBackFact> => new Map<string, SendBackFact>([
    [plain.requestId, { id: `task:${TASK}:sendback:${plain.requestId}`, origin: "human", actorDeveloperId: ANN, actorTrust: "member", reasonText: "Use the shared retry helper." }],
    [fix.requestId, { id: `task:${TASK}:sendback:${fix.requestId}`, origin: "human", actorDeveloperId: BOB, actorTrust: "member", reasonText: "Fix the timeout in the client." }],
  ]);
  /** The person's decisions in the order they were made; everything else is placed between them in several ways. */
  const orders: Array<[string, unknown[]]> = [
    ["autos first", [autoFix, autoRetry, gate, plain, autoFindings, fix, acceptAll, erased]],
    ["autos last", [plain, fix, erased, acceptAll, autoFix, autoRetry, autoFindings, gate]],
    ["interleaved", [autoFix, plain, autoFindings, acceptAll, fix, autoRetry, gate, erased, autoFix]],
  ];

  it.each(orders)("%s: the source lists exactly the person's send-backs in the order they were made, and only those rows are read", async (_name, decisions) => {
    const rows = rowsFor(facts());
    const { base } = await subjectOf(decisions, rows);
    expect(base!.sendBackRequestIds).toEqual([plain.requestId, fix.requestId, erased.requestId]);
    const { subject } = await subjectOf(decisions, rows);
    // positive control: rows were read, and only the person's
    expect(rows.asked).toEqual([plain.requestId, fix.requestId, erased.requestId, plain.requestId, fix.requestId, erased.requestId]);
    for (const skipped of [autoFix, autoRetry, autoFindings, gate, acceptAll]) expect(rows.asked).not.toContain(skipped.requestId);
    // each span carries its own row's person and words, in order; the send-back whose row is gone adds no span (it is still counted from the decision list: `countOutcome` uses the list's length)
    const spans = subject!.spans.filter((span) => span.kind === "send_back");
    expect(spans.map((span) => [span.text, span.authorId])).toEqual([["Use the shared retry helper.", ANN], ["Fix the timeout in the client.", BOB]]);
    expect(spans.map((span) => span.eventId)).toEqual([`task:${TASK}:sendback:${plain.requestId}`, `task:${TASK}:sendback:${fix.requestId}`]);
  });

  it("an automatic send-back's row, if one were ever asked for, would never become words: an automatic fact makes no span", async () => {
    const rows = rowsFor(new Map<string, SendBackFact>([[plain.requestId, { id: "row-plain", origin: "automatic" }]]));
    const { subject } = await subjectOf([autoFix, plain], rows);
    expect(subject!.spans.some((span) => span.kind === "send_back")).toBe(false);
  });

  it("the order of the automatic decisions changes nothing: the same person's send-backs, the same spans", async () => {
    const results: string[] = [];
    for (const [, decisions] of orders) {
      const { subject } = await subjectOf(decisions, rowsFor(facts()));
      results.push(JSON.stringify(subject!.spans.filter((span) => span.kind === "send_back")));
    }
    expect(new Set(results).size).toBe(1);
  });
});
