// Bug H (staging 0.4.11): a pull request the owner merged on GitHub was recorded as merged (the milestone, the task's MERGED stage) but the merge-tracking row and the task's pull request
// record still said "open", and nothing said the pull request merged with no approval. The transaction that records a merge now moves both to merged, and when the pull request merged on
// GitHub, not by Rovara's Merge, with no approval recorded, the session's timeline says so, as a fact.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, mergeTrackingKey, mergeTrackingDecisionDigest, type MergeTrackingItem, type WorkflowSnapshot } from "@agentx/contracts";
import { reconcileTaskPullRequestFeedback } from "../../packages/broker/src/aws/github-webhooks.js";
import { ORG_A, sessionWorld } from "../support/agent-session-world.js";
import { MAYA, mergeButtonBroker } from "../support/merge-button-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const NOW = "2026-10-26T22:20:00.000Z";
const HEAD = "a".repeat(40);
const WORKSPACE = "workspace";
const URL_ = "https://github.com/acme/api/pull/1";

function harness(options: { mergedBy?: string | undefined; tracking?: "approved" | "none" | "claimed" | "absent"; record?: boolean } = {}) {
  const w = sessionWorld();
  const { taskId, sessionId } = w.seedSession();
  const candidate = createCandidateManifest([{ repositoryId: "api", commitSha: HEAD, treeSha: "b".repeat(40) }]);
  let workflow: WorkflowSnapshot = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now: NOW, definitionVersion: "1.1.0" }), candidate, stage: "WAIT_FOR_MERGE", state: "WAITING",
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "fixture", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: taskId, candidateDigest: candidate.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW })),
    pullRequests: [{ repositoryId: "api", number: 1, url: URL_, headSha: HEAD, headTreeSha: "b".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" }],
  });
  w.db.set({ pk: "GITHUB_PR#acme/api", sk: `PR#${"1".padStart(10, "0")}`, entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/api", repositoryId: "api", number: 1, url: URL_, taskId, workspaceId: WORKSPACE, candidateDigest: candidate.digest });
  if (options.record !== false) w.db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: `PULL_REQUEST#api#${"1".padStart(12, "0")}`, entityType: "PULL_REQUEST", repository: "api", number: 1, url: URL_, state: "open", expectedHeadCommit: HEAD });
  const tracking = (change: Partial<MergeTrackingItem> = {}): MergeTrackingItem => {
    const fields = {
      orgId: ORG_A, taskId, repositoryId: "api", number: 1, headSha: HEAD, draft: false, state: "open" as const, baseBranch: "main", ci: "passing" as const, ciBasis: "required" as const,
      checksEverSeen: true, failingChecks: [] as string[], review: "not_requested" as const, branch: "up_to_date" as const, headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-10-26", count: 0 }, ...change,
    };
    return { ...fields, version: 3, decisionDigest: mergeTrackingDecisionDigest(fields), observedAt: "2026-10-26T22:16:10.000Z" };
  };
  const mode = options.tracking ?? "none";
  if (mode !== "absent") {
    const item = mode === "approved" ? tracking({ review: "approved", approval: { githubUserId: "1004", login: "arjun-gh", commitId: HEAD } })
      : mode === "claimed" ? tracking({ review: "approved", approval: { githubUserId: "1004", login: "arjun-gh", commitId: HEAD }, mergeClaim: { headSha: HEAD, by: "d".repeat(64), at: NOW } })
        : tracking();
    w.db.set({ ...mergeTrackingKey(taskId, "api", 1), entityType: "MERGE_TRACKING", ...item });
  }
  let remote: "open" | "merged" = "open";
  let revision = 0;
  const reconcile = () => reconcileTaskPullRequestFeedback({
    documentClient: w.db, tableName: "state", repositoryFullName: "acme/api", number: 1, deliveryId: randomUUID(), observationMode: "merge", now: NOW,
    loadTask: async () => ({ project: "web", startingRevision: 1, orgId: ORG_A, sessionId, workflow }),
    repositoryUrl: async () => "https://github.com/acme/api.git",
    getCurrentFeedback: async () => ({
      pullRequest: { number: 1, url: URL_, state: remote, headBranch: "feature", baseBranch: "main", headCommit: HEAD, headTreeSha: "b".repeat(40), title: "t", body: "", ...(options.mergedBy === undefined ? {} : { mergedBy: options.mergedBy }) },
      comments: [], threads: [],
    }),
    persistBundle: async () => { throw new Error("no feedback is collected on a merge"); },
    saveWorkflow: async (_taskId, expectedRevision, next, extraItems = []) => {
      if (expectedRevision !== workflow.revision) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
      revision += 1;
      await w.db.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: "state", Item: { pk: "TASK", sk: "META", revision } } }, ...extraItems] }));
      workflow = next;
    },
  });
  const trackingNow = () => w.db.get(mergeTrackingKey(taskId, "api", 1)) as unknown as (MergeTrackingItem & Record<string, unknown>) | undefined;
  const recordNow = () => w.db.get(`WORKSPACE#${WORKSPACE}`, `PULL_REQUEST#api#${"1".padStart(12, "0")}`) as Record<string, unknown> | undefined;
  const timeline = () => w.db.find((item) => typeof item.pk === "string" && item.pk.includes(sessionId) && String(item.sk).startsWith("EVENT#") && typeof item.text === "string").map((item) => String(item.text));
  return { w, taskId, sessionId, reconcile, merge: () => { remote = "merged"; }, trackingNow, recordNow, timeline, workflow: () => workflow };
}

describe("a merge recorded from GitHub updates what was kept about the pull request", () => {
  it("moves the merge-tracking row to merged, with a new version and digest, in the transaction that records the merge", async () => {
    const h = harness({ tracking: "approved" });
    h.merge();
    expect(await h.reconcile()).toBe(true);
    expect(h.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    const item = h.trackingNow()!;
    expect(item).toMatchObject({ state: "merged", version: 4, review: "approved" });
    expect(item.observedAt).toBe(NOW);
    const { pk: _pk, sk: _sk, entityType: _entityType, ...fields } = item as unknown as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- the key is not part of the item
    expect(item.decisionDigest).toBe(mergeTrackingDecisionDigest(fields as unknown as MergeTrackingItem));
    expect(item.decisionDigest).not.toBe(mergeTrackingDecisionDigest({ ...fields, state: "open" } as unknown as MergeTrackingItem));
    // The reconcile is idempotent: a second observation changes nothing.
    expect(await h.reconcile()).toBe(false);
    expect(h.trackingNow()!.version).toBe(4);
  });

  it("moves the task's pull request record to merged, which is what the task view's pull request list reads", async () => {
    const h = harness();
    h.merge();
    await h.reconcile();
    expect(h.recordNow()).toMatchObject({ state: "merged", number: 1 });
    expect(h.recordNow()!.expectedHeadCommit).toBe(HEAD);
  });

  it("does not stop recording a merge for a task with no tracking row or no pull request record (an older task)", async () => {
    const h = harness({ tracking: "absent", record: false });
    h.merge();
    expect(await h.reconcile()).toBe(true);
    expect(h.workflow()).toMatchObject({ stage: "MERGED" });
    expect(h.trackingNow()).toBeUndefined();
    expect(h.recordNow()).toBeUndefined();
  });

  it("leaves the pull request open everywhere while it is open", async () => {
    const h = harness({ tracking: "approved" });
    expect(await h.reconcile()).toBe(false);
    expect(h.trackingNow()).toMatchObject({ state: "open", version: 3 });
    expect(h.recordNow()).toMatchObject({ state: "open" });
  });
});

describe("a merge on GitHub with no approval recorded is said on the timeline, as a fact", () => {
  const NOTE = (login: string) => `Merged on GitHub by ${login}; no approval was recorded.`;

  it("names who merged it", async () => {
    const h = harness({ mergedBy: "octo-owner", tracking: "none" });
    h.merge();
    await h.reconcile();
    expect(h.timeline()).toContain(NOTE("octo-owner"));
    expect(h.timeline().filter((text) => text.includes("no approval"))).toHaveLength(1);
  });

  it("says it without a name when GitHub gave none", async () => {
    const h = harness({ tracking: "none" });
    h.merge();
    await h.reconcile();
    expect(h.timeline()).toContain("Merged on GitHub; no approval was recorded.");
  });

  it("says nothing when an approval was recorded", async () => {
    const h = harness({ mergedBy: "octo-owner", tracking: "approved" });
    h.merge();
    await h.reconcile();
    expect(h.timeline().filter((text) => text.includes("no approval"))).toEqual([]);
  });

  it("says nothing when Rovara's own Merge merged it", async () => {
    const h = harness({ mergedBy: "rovara[bot]", tracking: "claimed" });
    h.merge();
    await h.reconcile();
    expect(h.timeline().filter((text) => text.includes("no approval"))).toEqual([]);
  });

  it("says nothing for a task that has no merge tracking, which has no approvals to compare with", async () => {
    const h = harness({ mergedBy: "octo-owner", tracking: "absent" });
    h.merge();
    await h.reconcile();
    expect(h.timeline().filter((text) => text.includes("no approval"))).toEqual([]);
  });

  it("is written once, however often the merge is observed", async () => {
    const h = harness({ mergedBy: "octo-owner", tracking: "none" });
    h.merge();
    await h.reconcile();
    await h.reconcile();
    expect(h.timeline().filter((text) => text.includes("no approval"))).toHaveLength(1);
  });

  it("keeps a login that is not one GitHub could have issued out of the timeline", async () => {
    const h = harness({ mergedBy: "x <script>alert(1)</script> @everyone", tracking: "none" });
    h.merge();
    await h.reconcile();
    expect(h.timeline()).toContain("Merged on GitHub; no approval was recorded.");
    expect(h.timeline().join("\n")).not.toContain("<script>");
  });
});

// ---- the real broker: the merge sweep finds the owner's merge on GitHub, and the clients read it

describe("through the real broker", () => {
  let reconcileWorkflowMergeRecoveryTask: (dependencies: never, taskId: string, budget: never) => Promise<{ kind: string }>;
  beforeAll(async () => { reconcileWorkflowMergeRecoveryTask = (await loadSlackBroker() as unknown as { reconcileWorkflowMergeRecoveryTask: typeof reconcileWorkflowMergeRecoveryTask }).reconcileWorkflowMergeRecoveryTask; });

  it("after the owner merges on GitHub, the task view's pull request list and merge tracking say merged, and the timeline says it merged with no approval", async () => {
    const h = await mergeButtonBroker({ approver: "none" });
    const read = async () => {
      const answer = await h.dev(MAYA, "GET", `/v1/dev/tasks/${h.taskId}`, undefined, { "x-agentx-task-view": "2" });
      return answer.body.task as { workflow: { stage: string }; pullRequests?: Array<{ state: string }>; mergeTracking?: Array<{ state: string }> };
    };
    expect((await read()).pullRequests).toMatchObject([{ state: "open" }]);
    // The owner squash-merges the pull request on GitHub.
    h.observed.state = "merged";
    h.observed.mergedBy = "octo-owner";
    const result = await reconcileWorkflowMergeRecoveryTask(h.brokerInput as never, h.taskId, {} as never);
    expect(result.kind).toBe("TERMINAL");
    const task = await read();
    expect(task.workflow.stage).toBe("MERGED");
    expect(task.pullRequests).toMatchObject([{ state: "merged" }]);
    expect(task.mergeTracking).toMatchObject([{ state: "merged" }]);
    const events = await h.dev(MAYA, "GET", `/v1/app/sessions/${h.sessionId}/events`);
    const texts = (events.body.events as Array<{ text?: string }>).map((event) => event.text ?? "");
    expect(texts).toContain("Merged on GitHub by octo-owner; no approval was recorded.");
    expect(texts.some((text) => text.startsWith("Merged: https://github.com/example/demo/pull/7"))).toBe(true);
  });

  it("says nothing about approvals when the pull request had one", async () => {
    const h = await mergeButtonBroker();
    h.observed.state = "merged";
    h.observed.mergedBy = "octo-owner";
    await reconcileWorkflowMergeRecoveryTask(h.brokerInput as never, h.taskId, {} as never);
    const events = await h.dev(MAYA, "GET", `/v1/app/sessions/${h.sessionId}/events`);
    expect((events.body.events as Array<{ text?: string }>).map((event) => event.text ?? "").filter((text) => text.includes("no approval"))).toEqual([]);
  });
});
