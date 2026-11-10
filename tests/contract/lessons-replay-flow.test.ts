// Lane 7 (DECISIONS 68): a replay copy is driven through the real first dispatches of a workflow: the arm's snapshot lessons reach the planner (they did not when the copy was a plain task), the waiting plan is
// approved by the one guarded route, the state follows the workflow and not the latest operation, and the copy is closed after grading.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decideTaskWorkflow } from "../../packages/broker/src/aws/developer-tasks/decide.js";
import { startTaskWorkflowBranchSyncFromSystem, startTaskWorkflowPublicationFromSystem } from "../../packages/broker/src/aws/developer-tasks/publication.js";
import { tableTaskVisibilityPort } from "../../packages/broker/src/team-record/live-audience-port.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { InMemoryEvalSnapshotStore, InMemorySnapshotStore, buildEvalSnapshot } from "../../packages/broker/src/lessons/replay-snapshot-store.js";
import { NO_VECTORS } from "../../packages/broker/src/lessons/runtime.js";
import { InMemoryLessonStore } from "../../packages/broker/src/lessons/store.js";
import { orgMemberKey } from "../../packages/contracts/src/org-node.js";
import { defaultSpendPolicy } from "../../packages/contracts/src/spend.js";
import { orgSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { Audit, Clock, allowAllAccess, lessonRecord, settings } from "../unit/lessons/lesson-helpers.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { TEST_ORG } from "../support/orgs.js";
import { call, issuer } from "../support/slack-broker.js";

const ADMIN = { subject: "admin-subject", admin: true };
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };

async function world(options: { proxy?: { perTestCapUsd: number } } = {}) {
  const audit = new Audit();
  const store = new InMemoryLessonStore();
  const evalSnapshots = new InMemoryEvalSnapshotStore();
  const snapshots = new InMemorySnapshotStore();
  const clock = new Clock();
  const load = { store, vectors: NO_VECTORS, settings: settings({ mode: "On" }), access: allowAllAccess, audit, now: clock.now };
  const access = options.proxy === undefined ? undefined : fakeModelAccess();
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {}, lessons: { store, snapshots, evalSnapshots, load, routes: { audit } }, ...(access === undefined ? {} : { modelAccess: { access, proxyUrl: "https://proxy.test" }, cloud: true }) } });
  if (access !== undefined) {
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
    access.setOrgSpent(TEST_ORG, 0);
    h.db.set({ ...orgSettingsKey(TEST_ORG, "SPEND_POLICY"), entityType: "ORG_SPEND_POLICY", ...defaultSpendPolicy(), perTestCapUsd: options.proxy?.perTestCapUsd ?? 2, revision: 1, updatedBy: "test", updatedAt: "2026-11-01T00:00:00.000Z" });
  }
  const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed HTTP calls in the api service", client: "claude-code", workflow: true, workflowPath: "QUICK" });
  const sourceId = (started.body.task as { taskId: string }).taskId;
  const operator = ownerKeyForSubject(issuer, "admin-subject");
  h.db.set({ ...orgMemberKey(TEST_ORG, operator), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: operator, role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" });
  const lesson = lessonRecord({ id: "les_dddddddddddddddddd01", workspaceId: TEST_ORG, project: "payments", type: "convention", tier: 1, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], scope: {}, approvals: [{ approvalId: "ap-ann", by: "ann", at: 1, mode: "one" }], title: "Retries go through withRetry", body: "Use withRetry for HTTP retries." });
  const snapshot = buildEvalSnapshot({ key: { workspaceId: TEST_ORG, project: "payments" }, pipeline: "consolidated", day: "2026-09-01", lessons: [lesson], createdBy: "op", at: "2026-11-01T00:00:00.000Z" });
  await evalSnapshots.put(snapshot);
  const post = (id: string, body: unknown, sub = "") => call(h.handler, { method: "POST", path: `/v1/admin/tasks/${id}/lessons-replay${sub}`, user: ADMIN, body });
  const get = (id: string, sub = "") => call(h.handler, { method: "GET", path: `/v1/admin/tasks/${id}/lessons-replay${sub}`, user: ADMIN });
  const meta = (id: string) => h.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: { stage: string; state: string; revision: number } };
  const ops = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const opWhere = (workspaceId: string, predicate: (item: Record<string, unknown>) => boolean) => { const found = ops(workspaceId).filter(predicate).at(-1); if (found === undefined) throw new Error("no such operation"); return String(found.id); };
  const copy = async (memory: unknown, maxUsd = 2) => {
    const made = await post(sourceId, { requestId: randomUUID(), memory, maxUsd });
    expect(made.status, JSON.stringify(made.body)).toBe(202);
    return (made.body.replay as { taskId: string }).taskId;
  };
  return { h, audit, snapshot, post, get, meta, ops, opWhere, copy, sourceId, access };
}

describe("a workflow copy through its first dispatches", () => {
  it("the arm's snapshot lessons are delivered at the PLAN dispatch; a copy with memory off is delivered none", async () => {
    const w = await world();
    const withLessons = await w.copy({ mode: "snapshot", snapshotId: w.snapshot.snapshotId });
    const without = await w.copy({ mode: "off" });
    for (const id of [withLessons, without]) await w.h.finish(w.meta(id).workspaceId, w.opWhere(w.meta(id).workspaceId, (item) => item.kind === "prepare"), "SUCCEEDED", PREPARED);
    const plan = (id: string) => w.ops(w.meta(id).workspaceId).filter((item) => item.workflowMode === "PLAN" || item.workflowMode === "UNDERSTAND").at(-1) as { learnedLoad?: { stage: string; taskId: string } } | undefined;
    expect(plan(withLessons)?.learnedLoad, "the PLAN (or UNDERSTAND) stage of a workflow copy loads").toMatchObject({ taskId: withLessons });
    expect(plan(without)?.learnedLoad).toBeUndefined();
    // The load is an eval load, filed apart from the live ones.
    expect(w.h.db.find((item) => typeof item.sk === "string" && item.sk.startsWith("LOAD#")).length).toBe(0);
  });
});

describe("approving the plan, and where the copy stands", () => {
  async function planned() {
    const w = await world();
    const id = await w.copy({ mode: "off" });
    const workspaceId = w.meta(id).workspaceId;
    await w.h.finish(workspaceId, w.opWhere(workspaceId, (item) => item.kind === "prepare"), "SUCCEEDED", PREPARED);
    const planOp = w.opWhere(workspaceId, (item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED");
    await w.h.artifact(workspaceId, planOp, "plan.md", planAnswer(planDocument({})));
    await w.h.finish(workspaceId, planOp, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    return { w, id, workspaceId };
  }
  it("a plan that waits is awaiting_plan; the approve route decides it as the operator and the copy goes on to implementation", async () => {
    const { w, id } = await planned();
    const before = (await w.get(id)).body.replay as { state: string; stage: string };
    expect(before.state, JSON.stringify(before)).toBe("awaiting_plan");
    const approved = await w.post(id, {}, "/approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(202);
    expect(w.meta(id).workflow.stage).toBe("IMPLEMENT");
    expect(((await w.get(id)).body.replay as { state: string }).state).toBe("running");
    // Nothing waits any more: a repeat is refused, not decided twice.
    expect((await w.post(id, {}, "/approve")).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("the approve route cannot approve a normal task's plan, and a normal task cannot reach the automatic path", async () => {
    const { w } = await planned();
    const workspaceId = w.meta(w.sourceId).workspaceId;
    await w.h.finish(workspaceId, w.opWhere(workspaceId, (item) => item.kind === "prepare"), "SUCCEEDED", PREPARED);
    expect((await w.post(w.sourceId, {}, "/approve")).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(w.meta(w.sourceId).workflow.stage).not.toBe("IMPLEMENT");
  });
  it("starts the close of a copy after grading", async () => {
    const { w, id } = await planned();
    const closed = await w.post(id, {}, "/close");
    expect(closed.status, JSON.stringify(closed.body)).toBe(202);
    // Closing is a request to the workspace (it checks for unpublished work, and a copy never has any it may keep): the answer is the task's state now, and a repeat of the close is the same close.
    expect(typeof closed.body.closed).toBe("boolean");
    expect(w.ops(w.meta(id).workspaceId).some((item) => item.kind === "close")).toBe(true);
    expect((await w.post(id, {}, "/close")).status).toBe(202);
  });
  it("reads the evidence a grader needs: the copy's request, never lesson text", async () => {
    const { w, id } = await planned();
    const evidence = (await w.get(id, "/evidence")).body.evidence as { request: string };
    expect(evidence.request).toContain("Retry failed HTTP calls");
    expect(JSON.stringify(evidence)).not.toContain("withRetry");
  });
});

describe("approving the plan of a copy whose run limit is above the planning limit (a model proxy is set up, so the limit is settled)", () => {
  it("the approval accepts the plan's run limit, which the copy's own limit already caps, so the copy goes on to implementation instead of waiting for a raise", async () => {
    const w = await world({ proxy: { perTestCapUsd: 20 } });
    const id = await w.copy({ mode: "off" }, 8);
    const workspaceId = w.meta(id).workspaceId;
    expect(w.meta(id)).toMatchObject({ budgetUsd: 2, requestedRunLimitUsd: 8 });
    await w.h.finish(workspaceId, w.opWhere(workspaceId, (item) => item.kind === "prepare"), "SUCCEEDED", PREPARED);
    const planOp = w.opWhere(workspaceId, (item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED");
    await w.h.artifact(workspaceId, planOp, "plan.md", planAnswer(planDocument({})));
    await w.h.finish(workspaceId, planOp, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const approved = await w.post(id, {}, "/approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(202);
    expect(w.meta(id).workflow.stage, JSON.stringify(w.meta(id).workflow)).toBe("IMPLEMENT");
    expect(w.meta(id).workflow.state).not.toBe("BLOCKED");
    // The limit it runs under is the copy's own, never more.
    expect((w.meta(id) as { budgetUsd?: number }).budgetUsd).toBeLessThanOrEqual(8);
    expect(((await w.get(id)).body.replay as { state: string }).state).toBe("running");
  });
  it("the copy-only check is inside the decision itself: even called with the option, a normal task's raise of the run limit is refused without the amount, while the same call on a copy is accepted", async () => {
    const w = await world({ proxy: { perTestCapUsd: 20 } });
    const deciding = async (taskId: string, withOption: boolean) => {
      const workspaceId = w.meta(taskId).workspaceId;
      await w.h.finish(workspaceId, w.opWhere(workspaceId, (item) => item.kind === "prepare"), "SUCCEEDED", PREPARED);
      const planOp = w.opWhere(workspaceId, (item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED");
      await w.h.artifact(workspaceId, planOp, "plan.md", planAnswer(planDocument({})));
      await w.h.finish(workspaceId, planOp, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
      const workflow = (w.h.db.get(`DEVTASK#${taskId}`, "META") as unknown as { workflow: { revision: number; artifacts: Array<{ sha256: string }> } }).workflow;
      const deps = { documentClient: w.h.db, tableName: "state", actions: w.h.actions, log: () => undefined, orgId: TEST_ORG, modelAccess: w.access,
        checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [], now: () => Date.now() };
      const owner = (w.h.db.get(`DEVTASK#${taskId}`, "META") as unknown as { developerId: string }).developerId;
      const caller = { orgId: TEST_ORG, developerId: owner, orgRole: "owner", name: "Owner", amr: "oidc", sessionId: "s" };
      return decideTaskWorkflow(deps as never, caller as never, taskId, { requestId: randomUUID(), expectedRevision: workflow.revision, decision: "APPROVE", reason: "ok", artifactDigest: workflow.artifacts.at(-1)!.sha256 }, withOption ? { acceptCopyRunLimit: true } : {});
    };
    await expect(deciding(w.sourceId, true)).rejects.toMatchObject({ message: expect.stringMatching(/raises the run limit/u) as unknown });
    const copy = await w.copy({ mode: "off" }, 8);
    await expect(deciding(copy, true)).resolves.toBeDefined();
    expect(w.meta(copy).workflow.stage).toBe("IMPLEMENT");
  });
});

describe("what a copy has cost, and the limit it started under (the harness reserves planning plus the run limit)", () => {
  it("the start answers the planning limit the copy started under, and says none when there is no model proxy", async () => {
    const withProxy = await world({ proxy: { perTestCapUsd: 20 } });
    const made = await withProxy.post(withProxy.sourceId, { requestId: randomUUID(), memory: { mode: "off" }, maxUsd: 8 });
    expect((made.body.replay as { startLimitUsd: number | null }).startLimitUsd).toBe(2);
    const bare = await world();
    const plain = await bare.post(bare.sourceId, { requestId: randomUUID(), memory: { mode: "off" }, maxUsd: 2 });
    expect((plain.body.replay as { startLimitUsd: number | null }).startLimitUsd, "an install with no proxy bounds nothing: the executor stops the replay on null").toBeNull();
  });
  it("a copy that is still running shows what it has cost over every stage (checks included) and the proxy's own figure, whichever is larger", async () => {
    const w = await world({ proxy: { perTestCapUsd: 20 } });
    const id = await w.copy({ mode: "off" }, 4);
    const workspaceId = w.meta(id).workspaceId;
    await w.h.finish(workspaceId, w.opWhere(workspaceId, (item) => item.kind === "prepare"), "SUCCEEDED", PREPARED);
    // A usage record on the planning step; then the same step seen as a CHECKS step (a checks run that calls a model costs money too, and one that recorded nothing costs nothing, not a round's estimate).
    const planOp = w.opWhere(workspaceId, (item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED");
    const opItem = w.h.db.find((item) => item.id === planOp && item.entityType === "OPERATION")[0]!;
    const shown = async () => ((await w.get(id)).body.replay as { state: string; costUsd: number | null });
    w.h.db.set({ pk: `OPERATION#${planOp}`, sk: "EVENT#0001", type: "usage", payload: { costUsd: 0.75 } });
    const first = await shown();
    expect(first.state).toBe("running");
    expect(first.costUsd, JSON.stringify(first)).toBeCloseTo(0.75);
    w.h.db.set({ ...opItem, workflowMode: "CHECKS" });
    expect((await shown()).costUsd).toBeCloseTo(0.75);
    w.h.db.set({ pk: `OPERATION#${planOp}`, sk: "EVENT#0001", type: "other", payload: {} });
    expect((await shown()).costUsd, "a checks step with no usage record is free, not a round's estimate").toBeCloseTo(0);
    w.h.db.set({ pk: `OPERATION#${planOp}`, sk: "EVENT#0001", type: "usage", payload: { costUsd: 0.75 } });
    // The proxy says more than the records (they lag): the larger is shown.
    w.h.db.set({ ...w.meta(id), modelKeyIds: ["key-1"] });
    w.access!.keySpend.mockResolvedValue(3.1);
    expect((await shown()).costUsd).toBeCloseTo(3.1);
    // And when the proxy cannot say, the records stand.
    w.access!.keySpend.mockRejectedValue(new Error("proxy down"));
    expect((await shown()).costUsd).toBeCloseTo(0.75);
  });
});

describe("a copy that reached the end of its checks is never published", () => {
  it("the dispatcher's publication, update and branch-sync starts answer STALE for a copy, so their rows are dropped, and make no operation", async () => {
    const w = await world();
    const id = await w.copy({ mode: "off" });
    const workspaceId = w.meta(id).workspaceId;
    const deps = { documentClient: w.h.db, tableName: "state" } as never;
    const before = w.ops(workspaceId).length;
    expect(await startTaskWorkflowPublicationFromSystem(deps, id, { workflowRevision: 1, candidateDigest: "a".repeat(64) }, {})).toBe("STALE");
    expect(await startTaskWorkflowBranchSyncFromSystem(deps, id, { workflowRevision: 1 })).toBe("STALE");
    expect(w.ops(workspaceId)).toHaveLength(before);
  });
});

describe("who can see a copy (L5)", () => {
  it("a copy is private to the operator who started it: no more visible than its source, whoever the source was shared with, and a source whose people list was narrowed stays narrow", async () => {
    const w = await world();
    const id = await w.copy({ mode: "off" });
    const port = tableTaskVisibilityPort({ documentClient: w.h.db, tableName: "state", now: Date.now });
    const read = async (taskId: string) => (await port.read(TEST_ORG, [taskId])).get(taskId);
    const operator = ownerKeyForSubject(issuer, "admin-subject");
    expect(await read(id)).toEqual({ kind: "private", ownerDeveloperId: operator });
    // The source's own people list is narrowed to one person (MAYA only): the copy is still not shared with anyone else.
    w.h.db.set({ pk: `DEVTASK#${w.sourceId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: MAYA.developerId, slackUserId: "U0PERSON00", name: MAYA.name, role: "denied" }] });
    expect(await read(id)).toEqual({ kind: "private", ownerDeveloperId: operator });
  });
});
