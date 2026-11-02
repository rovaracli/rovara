// Setup and test health (owner decision, M2), the runner: with the broker's port (vx on) a check that failed before AND has a new failing test is sent back to coding; without it (vx off) the same block is asked
// about exactly as before. A port that fails or names no check leaves everything as it was; at the cap a person is asked.
import { describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_AGENTX_ACTOR_ID, WorkflowDecisionRecordSchema, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowDecision, type WorkflowSnapshot,
} from "@agentx/contracts";

const moves = vi.hoisted(() => ({ sendBack: vi.fn(async () => "STARTED" as const), retryChecks: vi.fn(async () => "STARTED" as const), retryReviews: vi.fn(async () => "STARTED" as const) }));
vi.mock("../../packages/broker/src/aws/developer-tasks.js", () => ({ autoSendBackToCodingFromSystem: moves.sendBack, autoRetryChecksFromSystem: moves.retryChecks, autoRetryReviewsFromSystem: moves.retryReviews }));

import { runWorkflowAutofix, type AutofixDependencies } from "../../packages/broker/src/aws/workflow-autofix-runner.js";
import { AutoFixAskSchema } from "../../packages/broker/src/developer/autofix-messages.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const NOW = "2026-11-02T12:00:00.000Z";
const OWNER = "a".repeat(64);
const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const approval = (): WorkflowDecision => WorkflowDecisionRecordSchema.parse({ requestId: uuid(1), workflowRevision: 2, decision: "APPROVE", actorId: OWNER, actorRole: "TASK_OWNER", reason: "approved", artifactDigest: "b".repeat(64), at: NOW });
const sentBack = (n: number): WorkflowDecision => WorkflowDecisionRecordSchema.parse({
  requestId: uuid(n), workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX", reason: "automatic", source: "AUTO_FIX", at: NOW, auto: { stage: "VERIFY", candidateDigest: candidate.digest },
});
const flow = (decisions: WorkflowDecision[] = [approval()]): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId: TASK, ownerId: OWNER, now: NOW }), revision: 7, stage: "VERIFY", state: "BLOCKED", candidate, decisions,
  verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: [{ checkId: "unit", status: "FAILED" }] },
});
const taskOf = (workflow: WorkflowSnapshot): DeveloperTaskRecord => ({ taskId: TASK, workspaceId: "w", orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "web", closedAt: undefined, workflow } as unknown as DeveloperTaskRecord);

function bench(workflow: WorkflowSnapshot, port?: AutofixDependencies["newFailingChecks"]) {
  const writes: Array<Record<string, unknown>> = [];
  const deps: AutofixDependencies = {
    config: { enabled: true, capUsd: 15, roundEstimateUsd: 3 }, route: {} as never,
    store: { tableName: "t", documentClient: { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "GetCommand") return { Item: taskOf(workflow) };
      writes.push(command.input);
      return {};
    } } as never },
    taskSpendUsd: async () => 1, dayBudgetHasRoom: async () => true, scenarioResults: async () => undefined, ownerCancelledChecks: async () => false, baselineSourceReady: async () => false, readArtifactText: async () => undefined,
    ...(port === undefined ? {} : { newFailingChecks: port }),
    now: () => Date.parse("2026-11-02T12:05:00.000Z"), log: () => undefined,
  };
  return { run: () => runWorkflowAutofix(deps, taskOf(workflow), { expectedRevision: 7, startedAt: NOW }), writes };
}
const asked = (writes: Array<Record<string, unknown>>) => AutoFixAskSchema.parse((writes.at(-1)!.ExpressionAttributeValues as { ":ask": unknown })[":ask"]);

describe("the runner and a check that failed before with a new failing test", () => {
  it("sends the task back to coding when the port names the failed check (vx on)", async () => {
    moves.sendBack.mockClear();
    const t = bench(flow(), async () => ["unit"]);
    expect(await t.run()).toBe("SENT_BACK");
    expect(moves.sendBack).toHaveBeenCalledTimes(1);
    expect(t.writes).toEqual([]);
  });

  it("hands the port the original-code facts the runner has (the port uses them for a check the pack does not name)", async () => {
    const seen: unknown[] = [];
    const t = bench(flow(), async (_task, originals) => { seen.push(originals); return ["unit"]; });
    expect(await t.run()).toBe("SENT_BACK");
    expect(seen).toHaveLength(1);
    expect(seen[0] === undefined || typeof seen[0] === "object").toBe(true);
  });

  it("without the port (vx off) the same block is asked about exactly as before, and nothing is sent back", async () => {
    moves.sendBack.mockClear();
    const t = bench(flow());
    expect(await t.run()).toBe("ASKED");
    expect(moves.sendBack).not.toHaveBeenCalled();
    expect(asked(t.writes)).toMatchObject({ reason: "unclear-fault", codes: ["check-failed-cause-unknown"] });
  });

  it("a port that names no check, names another one, or fails changes nothing", async () => {
    for (const port of [async () => [], async () => ["other"], async () => { throw new Error("pack down"); }] as Array<NonNullable<AutofixDependencies["newFailingChecks"]>>) {
      moves.sendBack.mockClear();
      const t = bench(flow(), port);
      expect(await t.run()).toBe("ASKED");
      expect(moves.sendBack).not.toHaveBeenCalled();
      expect(asked(t.writes)).toMatchObject({ reason: "unclear-fault" });
    }
  });

  it("is asked, naming the limit, after two automatic send backs, and the send back is not made", async () => {
    moves.sendBack.mockClear();
    const t = bench(flow([approval(), sentBack(2), sentBack(3)]), async () => ["unit"]);
    expect(await t.run()).toBe("ASKED");
    expect(moves.sendBack).not.toHaveBeenCalled();
    expect(asked(t.writes)).toMatchObject({ reason: "send-back-limit", codes: ["new-failing-test"] });
  });

  it("asks the port only when the block is about a failed check", async () => {
    const port = vi.fn(async () => ["unit"]);
    const other = WorkflowSnapshotSchema.parse({ ...flow(), blockReason: "x", verification: undefined });
    const t = bench(other, port);
    await t.run();
    expect(port).not.toHaveBeenCalled();
  });
});
