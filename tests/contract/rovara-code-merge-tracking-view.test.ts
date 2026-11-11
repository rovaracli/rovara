// Rovara Code (Plan 6 Task 14): the task view of a version 2 task carries what merge tracking read from GitHub, without the merge claim; an older client never sees it, a
// version 1 task has none, and the verification report says which checks counted.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DeveloperTaskViewSchema } from "../../packages/cloud-contracts/src/developer-tasks.js";
import { mergeTrackingKey } from "@rovara-code/contracts";
import { mergeTrackingDecisionDigest } from "../../packages/cloud-contracts/src/rovara-code-node.js";
import type { MergeTrackingItem } from "../../packages/cloud-contracts/src/rovara-code.js";
import { taskViewForClient } from "../../packages/broker/src/rovara-code/task-view-compat.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { builtinSettingsKey } from "@rovara-code/contracts";
import { MAYA, bearerFor, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { createCandidateManifest } from "@rovara-code/contracts";
import { TEST_ORG } from "../support/orgs.js";

const now = "2026-10-25T12:00:00.000Z";
const HEAD = "a".repeat(40);

function trackingItem(taskId: string, extra: Partial<MergeTrackingItem> = {}, repositoryId = "payments", number = 7): MergeTrackingItem {
  const fields = {
    orgId: TEST_ORG, taskId, repositoryId, number, headSha: HEAD, draft: false, state: "open" as const, baseBranch: "main", ci: "passing" as const, ciBasis: "required" as const,
    checksEverSeen: true, failingChecks: [], review: "not_requested" as const, branch: "up_to_date" as const, headByRovara: true, nudges: { count: 0 },
    syncs: { day: "2026-10-25", count: 0 }, ...extra,
  };
  return { ...fields, version: 1, decisionDigest: mergeTrackingDecisionDigest(fields), observedAt: now };
}

describe("the task view and merge tracking", () => {
  beforeAll(async () => { await loadSlackBroker(); });

  async function v2Task() {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    const store = new AgentStore({ documentClient: harness.db, tableName: "state", now: Date.now });
    await store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
    harness.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: now });
    const reply = await harness.dev(MAYA, "POST", "/v1/app/agents/rovara-code/runs", { requestId: randomUUID(), project: "payments", input: { text: "Fix the retry bug" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const id = (reply.body.task as { taskId: string }).taskId;
    const record = () => harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { workflow: Record<string, unknown> };
    const withPullRequests = () => harness.db.set({ ...record(), workflow: { ...record().workflow, pullRequests: [
      { repositoryId: "payments", number: 7, url: "https://github.com/acme/payments/pull/7", candidateDigest: "c".repeat(64), required: true, state: "OPEN", headSha: HEAD },
      { repositoryId: "web", number: 3, url: "https://github.com/acme/web/pull/3", candidateDigest: "c".repeat(64), required: true, state: "OPEN", headSha: HEAD },
    ] } });
    return { harness, id, record, withPullRequests };
  }

  const read = async (harness: Awaited<ReturnType<typeof v2Task>>["harness"], id: string, headers: Record<string, string> = {}) => {
    const org = await harness.orgOf(MAYA);
    const response = await harness.handler({
      version: "2.0", rawPath: `/v1/dev/tasks/${id}`, rawQueryString: "", headers: { authorization: await bearerFor(MAYA, org), ...headers },
      requestContext: { requestId: randomUUID(), http: { method: "GET" } },
    });
    expect(response.statusCode, response.body).toBe(200);
    return (JSON.parse(response.body) as { task: Record<string, unknown> }).task;
  };

  it("lists each pull request's tracking item, in repository order and without the merge claim, to a version 2 client only", async () => {
    const { harness, id, withPullRequests } = await v2Task();
    withPullRequests();
    harness.db.set({ ...mergeTrackingKey(id, "web", 3), entityType: "MERGE_TRACKING", ...trackingItem(id, {}, "web", 3) });
    harness.db.set({ ...mergeTrackingKey(id, "payments", 7), entityType: "MERGE_TRACKING", ...trackingItem(id, { mergeClaim: { headSha: HEAD, by: "someone", at: now } }) });
    const view = await read(harness, id, { "x-agentx-task-view": "2" });
    const items = view.mergeTracking as Array<Record<string, unknown>>;
    expect(items.map((item) => `${String(item.repositoryId)}#${String(item.number)}`)).toEqual(["payments#7", "web#3"]);
    expect(JSON.stringify(view)).not.toContain("mergeClaim");
    expect(items[0]).toMatchObject({ ci: "passing", headByRovara: true, version: 1 });
    expect(items[0]).not.toHaveProperty("pk");
    expect(DeveloperTaskViewSchema.safeParse(view).success).toBe(true);
    expect(await read(harness, id)).not.toHaveProperty("mergeTracking");
  });

  it("leaves out an item of another org or another task, and shows none before the task has a pull request", async () => {
    const { harness, id, record, withPullRequests } = await v2Task();
    harness.db.set({ ...mergeTrackingKey(id, "payments", 7), entityType: "MERGE_TRACKING", ...trackingItem(id) });
    expect(await read(harness, id, { "x-agentx-task-view": "2" })).not.toHaveProperty("mergeTracking");
    withPullRequests();
    harness.db.set({ ...mergeTrackingKey(id, "payments", 7), entityType: "MERGE_TRACKING", ...trackingItem(id), orgId: "org_zzzzzzzzzzzzzzzzzzzz" });
    harness.db.set({ ...mergeTrackingKey(id, "web", 3), entityType: "MERGE_TRACKING", ...trackingItem("00000000-0000-4000-8000-000000000009", {}, "web", 3) });
    expect(await read(harness, id, { "x-agentx-task-view": "2" })).not.toHaveProperty("mergeTracking");
    expect(record().workflow).toBeDefined();
  });

  it("passes the checks basis it found to the verification report", async () => {
    const { harness, id, record, withPullRequests } = await v2Task();
    withPullRequests();
    const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const unit = { id: "unit", label: "Unit tests", command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
    harness.db.set({ ...record(), workflow: { ...record().workflow, stage: "REVIEW", state: "WAITING", programStepId: "review", candidate: code,
      checkPolicy: { required: [unit], optional: [], selectedOptionalIds: [], proposed: [] },
      verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] } },
      // Not running: the report is hidden while the task's operation runs, when the changed files are not known (Task 12 review).
      closedAt: now, outcome: "CLOSED" });
    const before = await read(harness, id, { "x-agentx-task-view": "2" });
    expect(before.verificationReport).toBeDefined();
    expect(before.verificationReport).not.toHaveProperty("ciBasis");
    harness.db.set({ ...mergeTrackingKey(id, "payments", 7), entityType: "MERGE_TRACKING", ...trackingItem(id, { ciBasis: "all_checks" }) });
    expect((await read(harness, id, { "x-agentx-task-view": "2" })).verificationReport).toMatchObject({ ciBasis: "all_checks" });
    harness.db.set({ ...mergeTrackingKey(id, "payments", 7), entityType: "MERGE_TRACKING", ...trackingItem(id, { ciBasis: "required" }) });
    expect((await read(harness, id, { "x-agentx-task-view": "2" })).verificationReport).toMatchObject({ ciBasis: "required" });
  });

  it("drops the field for a client without the version 2 header, whatever else the view holds", () => {
    const view = { taskId: "t", title: "x", project: "p", status: "RUNNING", startingRevision: 1, client: "c", shared: false, createdAt: now, updatedAt: now, events: [], mergeTracking: [] };
    expect(taskViewForClient(view as never, {})).not.toHaveProperty("mergeTracking");
    expect(taskViewForClient(view as never, { "x-agentx-task-view": "2" })).toHaveProperty("mergeTracking");
  });

  it("a version 1 task shows none, even with items stored", async () => {
    const harness = await createDeveloperTaskBroker();
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Add a greeting", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const id = (started.body.task as { taskId: string }).taskId;
    const record = harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { workflow: Record<string, unknown> };
    harness.db.set({ ...record, workflow: { ...record.workflow, pullRequests: [{ repositoryId: "payments", number: 7, url: "https://github.com/acme/payments/pull/7", candidateDigest: "c".repeat(64), required: true, state: "OPEN", headSha: HEAD }] } });
    harness.db.set({ ...mergeTrackingKey(id, "payments", 7), entityType: "MERGE_TRACKING", ...trackingItem(id) });
    expect(await read(harness, id, { "x-agentx-task-view": "2" })).not.toHaveProperty("mergeTracking");
  });
});
