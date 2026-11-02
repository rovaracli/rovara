// Setup and test health SH17: the auto-fix runner records a Fix setup card when it ASKS about a fault of the test environment, and only then. With the port absent (vx off) the ask is exactly what it was.
import { describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_AGENTX_ACTOR_ID, WORKFLOW_BLOCK_REASONS, WorkflowDecisionRecordSchema, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowDecision, type WorkflowSnapshot,
} from "@agentx/contracts";

vi.mock("../../packages/broker/src/aws/developer-tasks.js", () => ({
  autoSendBackToCodingFromSystem: vi.fn(async () => "STARTED" as const), autoRetryChecksFromSystem: vi.fn(async () => "STARTED" as const), autoRetryReviewsFromSystem: vi.fn(async () => "STARTED" as const),
}));

import { runWorkflowAutofix, type AutofixDependencies } from "../../packages/broker/src/aws/workflow-autofix-runner.js";
import { AutoFixAskSchema } from "../../packages/broker/src/developer/autofix-messages.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const OWNER = "a".repeat(64);
const NOW = "2026-11-02T12:00:00.000Z";
const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const approval = (): WorkflowDecision => WorkflowDecisionRecordSchema.parse({ requestId: uuid(1), workflowRevision: 2, decision: "APPROVE", actorId: OWNER, actorRole: "TASK_OWNER", reason: "approved", artifactDigest: "b".repeat(64), at: NOW });
const retry = (): WorkflowDecision => WorkflowDecisionRecordSchema.parse({
  requestId: uuid(2), workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX", reason: "automatic", source: "AUTO_RETRY", at: NOW, auto: { stage: "VERIFY", candidateDigest: candidate.digest },
});
const workflow = (reason: string, decisions: WorkflowDecision[]): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId: TASK, ownerId: OWNER, now: NOW }), revision: 7, stage: "VERIFY", state: "BLOCKED", blockReason: reason, candidate, decisions,
});
const taskOf = (flow: WorkflowSnapshot): DeveloperTaskRecord => ({ taskId: TASK, workspaceId: "w", orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "web", closedAt: undefined, workflow: flow } as unknown as DeveloperTaskRecord);

type Recorded = { reason: string; codes: readonly string[]; stage: string };
function bench(flow: WorkflowSnapshot, options: { fixSetup?: "record" | "throws" | "absent"; moved?: boolean; ownerStopped?: boolean } = {}) {
  const records: Recorded[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const fixSetup = options.fixSetup === "absent" ? undefined : { record: async (_task: DeveloperTaskRecord, ask: Recorded) => { records.push(ask); if (options.fixSetup === "throws") throw new Error("boom"); } };
  const deps: AutofixDependencies = {
    config: { enabled: true, capUsd: 15, roundEstimateUsd: 3 }, route: {} as never,
    store: { tableName: "t", documentClient: { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "GetCommand") return { Item: taskOf(flow) };
      writes.push(command.input);
      if (options.moved === true) throw Object.assign(new Error("moved"), { name: "ConditionalCheckFailedException" });
      return {};
    } } as never },
    taskSpendUsd: async () => 1, dayBudgetHasRoom: async () => true, scenarioResults: async () => undefined, ownerCancelledChecks: async () => options.ownerStopped === true, baselineSourceReady: async () => false, readArtifactText: async () => undefined,
    ...(fixSetup === undefined ? {} : { fixSetup }),
    now: () => Date.parse("2026-11-02T12:05:00.000Z"), log: (entry) => logs.push(entry),
  };
  const run = (cause?: "run-lost") => runWorkflowAutofix(deps, taskOf(flow), { expectedRevision: 7, startedAt: NOW, ...(cause === undefined ? {} : { cause }) });
  return { run, records, writes, logs };
}
const asked = (writes: Array<Record<string, unknown>>) => AutoFixAskSchema.parse((writes.at(-1)!.ExpressionAttributeValues as { ":ask": unknown })[":ask"]);
const USED = () => workflow(WORKFLOW_BLOCK_REASONS.checkRunnerFailed, [approval(), retry()]);

describe("the runner records a Fix setup card when it asks about the test environment", () => {
  it("records it once, with the ask's own reason and codes, after the ask is stored", async () => {
    const t = bench(USED());
    expect(await t.run()).toBe("ASKED");
    expect(asked(t.writes)).toMatchObject({ reason: "retry-limit", codes: ["check-runner-failed"] });
    expect(t.records).toEqual([{ reason: "retry-limit", codes: ["check-runner-failed"], stage: "VERIFY" }]);
  });

  it("does not record while the retry is still to come (the runner retries first, and the ask is exactly the generic one)", async () => {
    const t = bench(workflow(WORKFLOW_BLOCK_REASONS.checkRunnerFailed, [approval()]));
    expect(await t.run()).toBe("RETRIED");
    expect(t.records).toEqual([]);
  });

  it("does not record a code fault, an owner's stop, or a limit (they keep the generic ask)", async () => {
    const regression = bench(workflow(WORKFLOW_BLOCK_REASONS.regressionFound, [approval()]));
    expect(await regression.run()).toBe("SENT_BACK");
    expect(regression.records).toEqual([]);
    // The owner stopped the run (a lost run after their cancel): a person's stop is never a Fix setup card.
    const stopped = bench(USED(), { ownerStopped: true });
    expect(await stopped.run("run-lost")).toBe("ASKED");
    expect(asked(stopped.writes)).toMatchObject({ reason: "owner-stopped" });
    expect(stopped.records).toEqual([]);
  });

  it("does not record when the task moved on before the ask could be stored (nothing was asked)", async () => {
    const t = bench(USED(), { moved: true });
    expect(await t.run()).toBe("ASKED");
    expect(t.records).toEqual([]);
  });

  it("a failure to record never changes the outcome or the stored ask, and is logged without a message", async () => {
    const t = bench(USED(), { fixSetup: "throws" });
    expect(await t.run()).toBe("ASKED");
    expect(asked(t.writes)).toMatchObject({ reason: "retry-limit" });
    expect(t.logs.find((entry) => entry.event === "fixsetup.record_failed")).toEqual({ event: "fixsetup.record_failed", taskId: TASK, error: "Error" });
  });

  it("with no port (vx off) the ask is stored exactly the same and nothing else happens", async () => {
    const off = bench(USED(), { fixSetup: "absent" });
    const on = bench(USED());
    expect(await off.run()).toBe("ASKED");
    await on.run();
    expect(off.writes).toEqual(on.writes);
    expect(off.records).toEqual([]);
  });
});
