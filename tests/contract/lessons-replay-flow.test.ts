// Lane 7 (DECISIONS 68): a replay copy is driven through the real first dispatches of a workflow: the arm's snapshot lessons reach the planner (they did not when the copy was a plain task), the waiting plan is
// approved by the one guarded route, the state follows the workflow and not the latest operation, and the copy is closed after grading.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startTaskWorkflowBranchSyncFromSystem, startTaskWorkflowPublicationFromSystem } from "../../packages/broker/src/aws/developer-tasks/publication.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { InMemoryEvalSnapshotStore, InMemorySnapshotStore, buildEvalSnapshot } from "../../packages/broker/src/lessons/replay-snapshot-store.js";
import { NO_VECTORS } from "../../packages/broker/src/lessons/runtime.js";
import { InMemoryLessonStore } from "../../packages/broker/src/lessons/store.js";
import { orgMemberKey } from "../../packages/contracts/src/org-node.js";
import { Audit, Clock, allowAllAccess, lessonRecord, settings } from "../unit/lessons/lesson-helpers.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { TEST_ORG } from "../support/orgs.js";
import { call, issuer } from "../support/slack-broker.js";

const ADMIN = { subject: "admin-subject", admin: true };
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };

async function world() {
  const audit = new Audit();
  const store = new InMemoryLessonStore();
  const evalSnapshots = new InMemoryEvalSnapshotStore();
  const snapshots = new InMemorySnapshotStore();
  const clock = new Clock();
  const load = { store, vectors: NO_VECTORS, settings: settings({ mode: "On" }), access: allowAllAccess, audit, now: clock.now };
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {}, lessons: { store, snapshots, evalSnapshots, load, routes: { audit } } } });
  const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed HTTP calls in the api service", client: "claude-code", workflow: true, workflowPath: "QUICK" });
  const sourceId = (started.body.task as { taskId: string }).taskId;
  const operator = ownerKeyForSubject(issuer, "admin-subject");
  h.db.set({ ...orgMemberKey(TEST_ORG, operator), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: operator, role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" });
  const lesson = lessonRecord({ id: "les_dddddddddddddddddd01", workspaceId: TEST_ORG, project: "payments", type: "convention", tier: 1, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], scope: {}, title: "Retries go through withRetry", body: "Use withRetry for HTTP retries." });
  const snapshot = buildEvalSnapshot({ key: { workspaceId: TEST_ORG, project: "payments" }, pipeline: "consolidated", day: "2026-09-01", lessons: [lesson], createdBy: "op", at: "2026-11-01T00:00:00.000Z" });
  await evalSnapshots.put(snapshot);
  const post = (id: string, body: unknown, sub = "") => call(h.handler, { method: "POST", path: `/v1/admin/tasks/${id}/lessons-replay${sub}`, user: ADMIN, body });
  const get = (id: string, sub = "") => call(h.handler, { method: "GET", path: `/v1/admin/tasks/${id}/lessons-replay${sub}`, user: ADMIN });
  const meta = (id: string) => h.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: { stage: string; state: string; revision: number } };
  const ops = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const opWhere = (workspaceId: string, predicate: (item: Record<string, unknown>) => boolean) => { const found = ops(workspaceId).filter(predicate).at(-1); if (found === undefined) throw new Error("no such operation"); return String(found.id); };
  const copy = async (memory: unknown) => {
    const made = await post(sourceId, { requestId: randomUUID(), memory, maxUsd: 2 });
    expect(made.status, JSON.stringify(made.body)).toBe(202);
    return (made.body.replay as { taskId: string }).taskId;
  };
  return { h, audit, snapshot, post, get, meta, ops, opWhere, copy, sourceId };
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
