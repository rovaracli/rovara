// Lane 7 (DECISIONS 68): the lessons replay routes through the real handler. Only a company OWNER or ADMIN may use them (not a project administrator, not staff with no company role); a copy is a marked workflow TEST
// billed to the project and started by the operator, audited first, read back as a copy only, and its plan is approved by the one guarded route.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { InMemoryEvalSnapshotStore, InMemorySnapshotStore } from "../../packages/broker/src/lessons/replay-snapshot-store.js";
import { InMemoryLessonStore } from "../../packages/broker/src/lessons/store.js";
import { orgMemberKey } from "../../packages/cloud-contracts/src/org-node.js";
import { projectAiKey } from "../../packages/cloud-contracts/src/org-scoped-keys.js";
import type { OrgRole } from "../../packages/cloud-contracts/src/org-node.js";
import { Audit, lessonRecord } from "../unit/lessons/lesson-helpers.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { call, issuer } from "../support/slack-broker.js";

const ADMIN = { subject: "admin-subject", admin: true };
const roleOf = (subject: string) => ownerKeyForSubject(issuer, subject);

async function world(withLessons = true, evalModel?: { model: unknown; spend: unknown }) {
  const audit = new Audit();
  const store = new InMemoryLessonStore();
  const snapshots = new InMemorySnapshotStore();
  const evalSnapshots = new InMemoryEvalSnapshotStore();
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {}, ...(withLessons ? { lessons: { store, snapshots, evalSnapshots, routes: { audit }, ...(evalModel === undefined ? {} : { evalModel }) } } : {}) } });
  const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "claude-code", workflow: true, workflowPath: "FULL" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const taskId = (started.body.task as { taskId: string }).taskId;
  const setRole = (subject: string, role: OrgRole): void => { h.db.set({ ...orgMemberKey(TEST_ORG, roleOf(subject)), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: roleOf(subject), role, joinedAt: "2026-01-01T00:00:00.000Z" }); };
  setRole("admin-subject", "owner");
  const metas = () => h.db.find((item) => item.sk === "META" && typeof item.pk === "string" && item.pk.startsWith("DEVTASK#"));
  const post = (id: string, user: { subject: string; admin?: boolean }, body: unknown, sub = "") => call(h.handler, { method: "POST", path: `/v1/admin/tasks/${id}/lessons-replay${sub}`, user, body });
  const get = (id: string, user: { subject: string; admin?: boolean } = ADMIN, sub = "") => call(h.handler, { method: "GET", path: `/v1/admin/tasks/${id}/lessons-replay${sub}`, user });
  const ok = () => ({ requestId: randomUUID(), memory: { mode: "off" }, maxUsd: 2 });
  return { ...h, taskId, audit, store, snapshots, evalSnapshots, metas, post, get, ok, setRole };
}

describe("who may start a copy (DECISIONS 68)", () => {
  it("a company owner or admin may; a member, a project administrator with no company role, and staff with no company role may not; nothing is started", async () => {
    const w = await world();
    const before = w.metas().length;
    // A project administrator of the task's project who is no company owner or admin (the old rule let this through).
    w.setRole("project-admin", "member");
    w.db.set({ pk: `ORG#${TEST_ORG}`, sk: `PROJECT_MEMBER#${roleOf("project-admin")}#payments`, role: "administrator" });
    expect((await w.post(w.taskId, { subject: "someone", admin: false }, w.ok())).body.error).toEqual({ code: "FORBIDDEN", message: "administrator claim is required" });
    expect((await w.post(w.taskId, { subject: "project-admin", admin: true }, w.ok())).body.error).toMatchObject({ code: "FORBIDDEN", message: "a company owner or admin is required to replay tasks" });
    expect((await w.post(w.taskId, { subject: "rovara-staff", admin: true }, w.ok())).body.error).toMatchObject({ code: "FORBIDDEN", message: "a company owner or admin is required to replay tasks" });
    expect((await w.get(w.taskId, { subject: "rovara-staff", admin: true })).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect((await w.post(randomUUID(), ADMIN, w.ok())).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(w.metas()).toHaveLength(before);
    expect(w.audit.actions()).toEqual([]);
    // Positive controls: an owner and an admin each start one.
    expect((await w.post(w.taskId, ADMIN, w.ok())).status).toBe(202);
    w.setRole("company-admin", "admin");
    expect((await w.post(w.taskId, { subject: "company-admin", admin: true }, w.ok())).status).toBe(202);
  });
  it("refuses to start a copy where the agent runtime is not set up (the start would fall back to the operator as payer, and their own plan could pay)", async () => {
    const audit = new Audit();
    const h = await createSingleAnswerPlanBroker({ brokerExtra: { lessons: { store: new InMemoryLessonStore(), snapshots: new InMemorySnapshotStore(), evalSnapshots: new InMemoryEvalSnapshotStore(), routes: { audit } } } });
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "claude-code", workflow: true, workflowPath: "FULL" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    h.db.set({ ...orgMemberKey(TEST_ORG, roleOf("admin-subject")), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: roleOf("admin-subject"), role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" });
    const reply = await call(h.handler, { method: "POST", path: `/v1/admin/tasks/${taskId}/lessons-replay`, user: ADMIN, body: { requestId: randomUUID(), memory: { mode: "off" }, maxUsd: 2 } });
    expect(reply.body.error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(audit.actions()).toEqual([]);
  });
  it("answers nothing where lessons are not set up", async () => {
    const w = await world(false);
    expect((await w.post(w.taskId, ADMIN, w.ok())).body.error).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("what a copy is (H1, H2)", () => {
  it("a WORKFLOW of the past task's shape, a TEST billed to the project and started by the operator (never the past task's member), marked at creation, audited first", async () => {
    const w = await world();
    const started = await w.post(w.taskId, ADMIN, w.ok());
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const replay = started.body.replay as { taskId: string; evalRun: boolean; memory: string };
    expect(replay).toMatchObject({ evalRun: true, memory: "off" });
    const record = w.db.get(`DEVTASK#${replay.taskId}`, "META") as Record<string, unknown> & { workflow: { path: string; stage: string } };
    expect(record).toMatchObject({ evalRun: true, evalMemory: { mode: "off" }, evalSource: w.taskId, project: "payments", shared: false, developerId: roleOf("admin-subject"), origin: "test_run", payer: { kind: "project", project: "payments" } });
    expect(record.developerId).not.toBe(MAYA.developerId);
    expect(record.startedBy).toMatchObject({ developerId: roleOf("admin-subject") });
    expect(record.workflow).toMatchObject({ path: "FULL" });
    expect(w.audit.events.map((e) => e.action)).toEqual(["lesson.replay_started"]);
    expect(w.audit.events[0]!.facts).toMatchObject({ memory: "off", maxCents: 200, sourceTask: w.taskId });
  });
  it("in a project where the MEMBER pays, the copy is still the project's: never charged to the past task's member or the operator's own budget, and no personal plan is named", async () => {
    const w = await world();
    w.db.set({ ...projectAiKey(TEST_ORG, "payments"), entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: 1000, revision: 1 });
    const started = await w.post(w.taskId, ADMIN, w.ok());
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const record = w.db.get(`DEVTASK#${(started.body.replay as { taskId: string }).taskId}`, "META") as Record<string, unknown>;
    expect(record).toMatchObject({ origin: "test_run", payer: { kind: "project", project: "payments" } });
    expect(JSON.stringify(record.payer)).not.toContain(MAYA.developerId);
    // The plain control: the same project's ordinary start is charged to its member.
    const ordinary = (await w.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Ordinary", client: "claude-code", workflow: true, workflowPath: "QUICK" })).body.task as { taskId: string };
    expect(w.db.get(`DEVTASK#${ordinary.taskId}`, "META")).toMatchObject({ payer: { kind: "member", developerId: MAYA.developerId } });
  });
  it("a copy of a past task that was not a workflow, and a run limit above the company's per-test cap, are refused and start nothing", async () => {
    const w = await world();
    const plain = await w.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Look at it", client: "claude-code" });
    const plainId = (plain.body.task as { taskId: string }).taskId;
    const before = w.metas().length;
    expect((await w.post(plainId, ADMIN, w.ok())).body.error).toMatchObject({ code: "CONFIG_INVALID", message: "that task has no workflow to repeat" });
    expect((await w.post(w.taskId, ADMIN, { ...w.ok(), maxUsd: 500 })).body.error).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("per-test cap") as unknown });
    expect(w.metas()).toHaveLength(before);
  });
  it("an unmarked start is impossible through the route; a copy cannot be copied, and only a copy is read, approved, closed or given evidence", async () => {
    const w = await world();
    const before = w.metas().length;
    for (const extra of [{ evalRun: false }, { evalRun: true }, { shareToChannel: true }, { workflow: false }, { origin: "slack" }, { lessonsFile: { path: "x", content: "y" } }]) {
      expect((await w.post(w.taskId, ADMIN, { ...w.ok(), ...extra })).body.error, JSON.stringify(extra)).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect((await w.post(w.taskId, ADMIN, { ...w.ok(), memory: { mode: "live" } })).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.metas()).toHaveLength(before);
    const copy = ((await w.post(w.taskId, ADMIN, w.ok())).body.replay as { taskId: string }).taskId;
    expect((await w.post(copy, ADMIN, w.ok())).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    // The past task itself (a normal task) answers as if none of these routes existed.
    expect((await w.get(w.taskId)).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect((await w.post(w.taskId, ADMIN, {}, "/approve")).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect((await w.post(w.taskId, ADMIN, {}, "/close")).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect((await w.get(w.taskId, ADMIN, "/evidence")).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
  });
  it("a start that cannot be audited starts nothing", async () => {
    const w = await world();
    w.audit.emit = async () => { throw new Error("ledger down"); };
    const before = w.metas().length;
    expect((await w.post(w.taskId, ADMIN, w.ok())).body.error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.metas()).toHaveLength(before);
  });
  it("another owner or admin cannot read, approve or close a copy that is not theirs", async () => {
    const w = await world();
    const copy = ((await w.post(w.taskId, ADMIN, w.ok())).body.replay as { taskId: string }).taskId;
    w.setRole("other-owner", "owner");
    const other = { subject: "other-owner", admin: true };
    expect((await w.get(copy, other)).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect((await w.post(copy, other, {}, "/close")).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
  });
  it("reads a copy as running while its workflow runs (not completed after one step)", async () => {
    const w = await world();
    const copy = ((await w.post(w.taskId, ADMIN, w.ok())).body.replay as { taskId: string }).taskId;
    const view = await w.get(copy);
    expect(view.status).toBe(200);
    expect(view.body.replay).toMatchObject({ taskId: copy, evalRun: true, state: "running", loadedKeys: [] });
  });
});

describe("the snapshot import (DECISIONS 68)", () => {
  it("takes an arm's offline lessons for a project, apart from the live lessons, only from an owner or admin, and a copy can then be started on it", async () => {
    const w = await world();
    const offline = [lessonRecord({ id: "les_cccccccccccccccccc01", workspaceId: TEST_ORG, project: "payments", title: "Consolidated", body: "Retries go through withRetry." })];
    const body = { pipeline: "consolidated", day: "2026-09-01", lessons: offline };
    const path = "/v1/admin/projects/payments/lessons-replay/snapshots";
    expect((await call(w.handler, { method: "POST", path, user: { subject: "someone", admin: false }, body })).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect((await call(w.handler, { method: "POST", path, user: { subject: "rovara-staff", admin: true }, body })).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect((await call(w.handler, { method: "POST", path: "/v1/admin/projects/nope/lessons-replay/snapshots", user: ADMIN, body })).body.error).toBeDefined();
    expect((await call(w.handler, { method: "POST", path, user: ADMIN, body: { ...body, lessons: [{ id: "bad" }] } })).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect((await call(w.handler, { method: "POST", path, user: ADMIN, body: { ...body, lessons: [{ ...offline[0], project: "other" }] } })).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    const imported = await call(w.handler, { method: "POST", path, user: ADMIN, body });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    const snapshotId = (imported.body.snapshot as { snapshotId: string }).snapshotId;
    expect(snapshotId).toMatch(/^snp_[0-9a-f]{20}$/);
    expect(await w.store.list({ workspaceId: TEST_ORG, project: "payments" })).toEqual([]);
    expect(w.audit.actions()).toContain("lesson.snapshot_created");
    const started = await w.post(w.taskId, ADMIN, { requestId: randomUUID(), memory: { mode: "snapshot", snapshotId }, maxUsd: 2 });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(w.db.get(`DEVTASK#${(started.body.replay as { taskId: string }).taskId}`, "META")).toMatchObject({ evalMemory: { mode: "snapshot", snapshotId } });
  });
});

describe("the replay's model call (grading and offline pipelines)", () => {
  const fakeModel = (over: { quote?: unknown; text?: string } = {}) => {
    const calls: Array<Record<string, unknown>> = [];
    return { calls, model: { quote: async () => over.quote ?? { ok: true, usd: 0.1 }, complete: async (request: Record<string, unknown>) => { calls.push(request); return { text: over.text ?? "{\"resolved\":true,\"mistakes\":[]}", costUsd: 0.07, model: "m" }; } } };
  };
  const spend = (answer: "ok" | "month_full" = "ok") => ({ admit: async () => answer === "ok", look: async () => answer });
  const path = "/v1/admin/projects/payments/lessons-replay/model";
  const body = { purpose: "grade", system: "You grade.", user: "<<data x>>hi<</data x>>", maxOutputTokens: 300, maxUsd: 0.5 };

  it("answers the text and the cost, for a company owner or admin only, with the install's lessons switch OFF (a grading is not learning)", async () => {
    const m = fakeModel();
    const w = await world(true, { model: m.model, spend: spend() });
    const asked = await call(w.handler, { method: "POST", path, user: ADMIN, body });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toMatchObject({ text: expect.stringContaining("resolved") as unknown, costUsd: 0.07 });
    expect(m.calls[0]).toMatchObject({ workspaceId: TEST_ORG, project: "payments", budgetUsd: 0.1, maxHoldUsd: 0.5 });
    for (const user of [{ subject: "someone", admin: false }, { subject: "rovara-staff", admin: true }]) {
      expect((await call(w.handler, { method: "POST", path, user, body })).body.error, JSON.stringify(user)).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(m.calls).toHaveLength(1);
  });
  it("writes one audit line before the call (ids, a fixed word, the hold in cents), names the model that answered, and makes no call when the line cannot be written", async () => {
    const m = fakeModel();
    const w = await world(true, { model: m.model, spend: spend() });
    const asked = await call(w.handler, { method: "POST", path, user: ADMIN, body });
    expect(asked.body).toMatchObject({ model: "m" });
    const line = w.audit.events.find((e) => e.action === "lesson.replay_read")!;
    expect(line).toMatchObject({ workspaceId: TEST_ORG, project: "payments", facts: { what: "model_grade", maxCents: 50 } });
    expect(JSON.stringify(line)).not.toContain("You grade");
    await call(w.handler, { method: "POST", path, user: ADMIN, body: { ...body, purpose: "learn" } });
    expect(w.audit.events.filter((e) => e.action === "lesson.replay_read").map((e) => e.facts["what"])).toEqual(["model_grade", "model_learn"]);
    const broken = await world(true, { model: m.model, spend: spend() });
    broken.audit.emit = async () => { throw new Error("ledger down"); };
    expect((await call(broken.handler, { method: "POST", path, user: ADMIN, body })).body.error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(m.calls).toHaveLength(2);
  });
  it("refuses before the call when there is no model, it is too dear, the learning month is full, or the request is malformed", async () => {
    const none = fakeModel({ quote: { ok: false, code: "no_provider" } });
    expect((await call((await world(true, { model: none.model, spend: spend() })).handler, { method: "POST", path, user: ADMIN, body })).body.error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const dear = fakeModel({ quote: { ok: true, usd: 9 } });
    expect((await call((await world(true, { model: dear.model, spend: spend() })).handler, { method: "POST", path, user: ADMIN, body })).body.error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const full = fakeModel();
    expect((await call((await world(true, { model: full.model, spend: spend("month_full") })).handler, { method: "POST", path, user: ADMIN, body })).body.error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(none.calls.length + dear.calls.length + full.calls.length).toBe(0);
    const ok = await world(true, { model: fakeModel().model, spend: spend() });
    for (const bad of [{ ...body, purpose: "other" }, { ...body, maxOutputTokens: 100_000 }, { ...body, maxUsd: 500 }, { ...body, extra: 1 }, { ...body, user: "" }]) {
      expect((await call(ok.handler, { method: "POST", path, user: ADMIN, body: bad })).body.error, JSON.stringify(bad).slice(0, 60)).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect((await call((await world(true)).handler, { method: "POST", path, user: ADMIN, body })).body.error).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a historical task as the reflector sees it (offline pipelines)", () => {
  const TASK = "11111111-1111-4111-8111-111111111111";
  async function withLearning(rest: Record<string, unknown> = {}, project = "payments") {
    const audit = new Audit();
    const store = new InMemoryLessonStore();
    const base = { facts: { workspaceId: TEST_ORG, project, taskId: TASK, repositories: ["api"], outcome: "merged", task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } },
      rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", spans: [{ kind: "send_back", text: "Use withRetry.", trust: "member", authorId: "rae", eventId: "ev-1" }], ...rest } }, sendBackRequestIds: [] };
    const learning = { source: { read: async () => base }, rows: { sendBack: async () => undefined, revertedBy: async () => undefined }, process: { store }, settings: { read: async () => ({ mode: "On" }) } };
    const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {}, learning, lessons: { store, snapshots: new InMemorySnapshotStore(), evalSnapshots: new InMemoryEvalSnapshotStore(), routes: { audit }, settings: { read: async () => ({ mode: "On" }) }, load: {} } } });
    const operator = roleOf("admin-subject");
    h.db.set({ ...orgMemberKey(TEST_ORG, operator), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: operator, role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" });
    const read = (user: { subject: string; admin?: boolean } = ADMIN) => call(h.handler, { method: "GET", path: `/v1/admin/projects/payments/lessons-replay/subjects/${TASK}`, user });
    const settings = (user: { subject: string; admin?: boolean } = ADMIN, project = "payments") => call(h.handler, { method: "GET", path: `/v1/admin/projects/${project}/lessons-replay/settings`, user });
    return { read, settings, audit };
  }
  it("a company owner or admin reads a real past task's subject; anyone else does not", async () => {
    const w = await withLearning();
    const answered = await w.read();
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.subject).toMatchObject({ id: TASK, project: "payments", outcome: "merged" });
    expect((await w.read({ subject: "someone", admin: false })).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect((await w.read({ subject: "rovara-staff", admin: true })).body.error).toMatchObject({ code: "FORBIDDEN" });
  });
  it("reading a past task's private content leaves an audit line with the operator and the task id and nothing of the content, and is not made if the line cannot be written", async () => {
    const w = await withLearning();
    await w.read();
    expect(w.audit.events.filter((e) => e.action === "lesson.replay_read")).toEqual([expect.objectContaining({ facts: expect.objectContaining({ what: "subject", target: TASK }) as unknown })]);
    expect(JSON.stringify(w.audit.events)).not.toContain("Use withRetry");
    w.audit.emit = async () => { throw new Error("ledger down"); };
    expect((await w.read()).body.error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
  it("the project's learning settings are read by a company owner or admin only, with whether auto-apply and an embedder are on, and the read is audited", async () => {
    const w = await withLearning();
    const asked = await w.settings();
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toMatchObject({ settings: { mode: "On" }, autoApply: expect.any(Boolean) as unknown, embedder: false });
    expect(w.audit.events.some((e) => e.action === "lesson.replay_read" && e.facts["what"] === "settings")).toBe(true);
    for (const user of [{ subject: "someone", admin: false }, { subject: "rovara-staff", admin: true }]) expect((await w.settings(user)).body.error, JSON.stringify(user)).toMatchObject({ code: "FORBIDDEN" });
    expect((await w.settings(ADMIN, "other")).body.error).toBeDefined();
  });
  it("a replay copy's subject, and a task of another project, answer as if there were none", async () => {
    expect((await (await withLearning({ evalRun: true })).read()).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect((await (await withLearning({}, "other")).read()).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});
