// Plan 6 Task 2: what a Rovara Code version 2 task does that a version 1 task does not, and the proof that version 1 is untouched. Version 2 tasks are created
// as "1.1.0" workflows that follow the program of the v2 recipe; the Understand and plan-check results are Tasks 4 and 8, so here those stages are stood in for
// by the snapshots the engine already accepts. The v1 golden fixtures and the digest of their SHA256SUMS are checked by rovara-code-golden.test.ts, which this task changes by one line; this
// file adds that an org with no settings still starts a "1.0.0" task on version 1.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentStore, updateAvailable } from "../../packages/broker/src/agents/store.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { codingProgram, recipeDigest, type ResolvedRecipe } from "../../packages/contracts/src/agent-recipe-node.js";
import { ROVARA_CODE_V2_FOR_NEW_ORGS, builtinDefaultPin, builtinRecipe } from "../../packages/contracts/src/agent-templates.js";
import { builtinSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, decideWorkflow, recordWorkflowVerification, blockWorkflow, submitPlanCritique, submitWorkflowArtifact, submitWorkflowReview, type WorkflowProgram, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { MAYA, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const now = "2026-10-25T12:00:00.000Z";
const OPERATION = "11111111-1111-4111-8111-111111111111";
const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "b".repeat(64), producer: "agentx-planner", objectKey: `tasks/${taskId}/plan-v1.md`, createdAt: now };
const finding = { text: "The token is logged.", origin: "INTRODUCED" as const, file: "src/log.ts", line: 4 };

const v2 = (): ResolvedRecipe => builtinRecipe("rovara-code", 2);
const v2Program = (): WorkflowProgram => codingProgram(v2()) as WorkflowProgram;
const candidateOf = (letter: string) => createCandidateManifest([{ repositoryId: "payments", commitSha: letter.repeat(40), treeSha: letter.repeat(40), baseCommitSha: "e".repeat(40) }]);
const report = (role: "CRITIC" | "SECURITY", status: "PASS" | "FINDINGS", digest: string, findings: unknown[] = []) =>
  ({ operationId: OPERATION, candidateDigest: digest, role, provider: "scripted", version: "1", status, findings, readOnly: true, recordedAt: now });
const verified = (workflow: WorkflowSnapshot, candidate: ReturnType<typeof candidateOf>): WorkflowSnapshot => recordWorkflowVerification(
  { ...blockWorkflow(workflow, "candidate checks are being recorded", now), stage: "VERIFY" as const },
  { candidate, checks: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] }, now },
);
const reviewedWith = (workflow: WorkflowSnapshot, candidate: ReturnType<typeof candidateOf>, findings: unknown[]): WorkflowSnapshot =>
  (["CRITIC", "SECURITY"] as const).map((role) => report(role, findings.length > 0 ? "FINDINGS" : "PASS", candidate.digest, findings)).reduce<WorkflowSnapshot>((current, next) => submitWorkflowReview(current, next, now), workflow);

/** A coding plan after its plan check (Task 8) found nothing to say: the person's approval is next. */
function submittedAndChecked(created: WorkflowSnapshot): WorkflowSnapshot {
  const submitted = submitWorkflowArtifact(created, { expectedRevision: created.revision, artifact: plan, now });
  expect(submitted).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY" });
  const running: WorkflowSnapshot = { ...submitted, revision: submitted.revision + 1, state: "RUNNING" };
  return submitPlanCritique(running, { expectedRevision: running.revision, critique: { verdict: "ok", points: [], model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-6-v1", company: "anthropic" } }, now });
}

describe("a version 2 task in the workflow engine", () => {
  const start = () => createWorkflowSnapshot({ taskId, ownerId, now, definitionVersion: "1.1.0", path: "QUICK", program: v2Program() });

  it("starts as a 1.1.0 workflow on the plan step, and the plan's approval goes to IMPLEMENT on the build step, not to the plan check", () => {
    const created = start();
    expect(created).toMatchObject({ definitionVersion: "1.1.0", stage: "PLAN", state: "RUNNING", programStepId: "plan" });
    const waiting = submittedAndChecked(created);
    const approved = decideWorkflow(waiting, { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: waiting.revision, decision: "APPROVE", reason: "Go", artifactDigest: plan.sha256 },
      { actorId: ownerId, role: "TASK_OWNER" }, { now, allowedSkipStages: [] });
    expect(approved).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "build" });
  });

  it("holds the two new stages: PLAN_CRITIQUE and UNDERSTAND snapshots parse on 1.1.0 and never on 1.0.0 (the results come with Tasks 4 and 8)", () => {
    const created = start();
    const critiquing = { ...created, stage: "PLAN_CRITIQUE", state: "READY", programStepId: "plan_critic" };
    expect(WorkflowSnapshotSchema.safeParse(critiquing).success).toBe(true);
    expect(WorkflowSnapshotSchema.safeParse({ ...critiquing, definitionVersion: "1.0.0" }).success).toBe(false);
    const { programStepId: _programStepId, ...withoutStep } = created; // eslint-disable-line @typescript-eslint/no-unused-vars -- Understand runs before any recipe step
    const understanding = { ...withoutStep, stage: "UNDERSTAND", state: "READY" };
    expect(WorkflowSnapshotSchema.safeParse(understanding).success).toBe(true);
    expect(WorkflowSnapshotSchema.safeParse({ ...understanding, definitionVersion: "1.0.0" }).success).toBe(false);
  });
});

/** The v2 workflow with its plan approved: the build is ready. */
function approvedV2(): WorkflowSnapshot {
  const created = createWorkflowSnapshot({ taskId, ownerId, now, definitionVersion: "1.1.0", program: v2Program() });
  const waiting = submittedAndChecked(created);
  return decideWorkflow(waiting, { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: waiting.revision, decision: "APPROVE", reason: "Go", artifactDigest: plan.sha256 },
    { actorId: ownerId, role: "TASK_OWNER" }, { now, allowedSkipStages: [] });
}

describe("review rounds on the v2 program", () => {
  it("a Quick task goes IMPLEMENT, CHECKS, REVIEW; findings dispatch IMPLEMENT again with no owner action; the third failing round blocks", () => {
    let workflow = approvedV2();
    expect(workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "build" });
    for (const letter of ["1", "2"]) {
      const candidate = candidateOf(letter);
      workflow = verified(workflow, candidate);
      expect(workflow).toMatchObject({ stage: "REVIEW", state: "WAITING", programStepId: "review" });
      workflow = reviewedWith(workflow, candidate, [finding]);
      expect(workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "build" });
      expect(workflow.blockReason).toBeUndefined();
    }
    const third = candidateOf("3");
    const blocked = reviewedWith(verified(workflow, third), third, [finding]);
    expect(blocked).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: "the code and security reviews did not pass", programRounds: { review: 3 } });
    expect(WorkflowSnapshotSchema.safeParse(blocked).success).toBe(true);
  });

  it("a review that passes goes to the pull request", () => {
    const candidate = candidateOf("1");
    const done = reviewedWith(verified(approvedV2(), candidate), candidate, []);
    expect(done).toMatchObject({ stage: "PULL_REQUEST", state: "READY", programStepId: "pull_request", definitionVersion: "1.1.0" });
  });
});

describe("which version a task starts on", () => {
  beforeAll(async () => { await loadSlackBroker(); });

  async function setup(agents: Record<string, unknown> = {}) {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents } });
    const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
    const run = async (who: Developer = MAYA) => {
      const reply = await h.dev(who, "POST", "/v1/app/agents/rovara-code/runs", { requestId: randomUUID(), project: "payments", input: { text: "Fix the retry bug" } });
      expect(reply.status, JSON.stringify(reply.body)).toBe(202);
      const task = reply.body.task as { taskId: string };
      return h.db.get(`DEVTASK#${task.taskId}`, "META") as { workflow?: { definitionVersion: string; stage: string; program?: { steps: Array<{ kind: string }> }; programStepId?: string }; agent?: { version: number; digest: string } };
    };
    return { ...h, store, run };
  }

  it("an org with no settings item starts a 1.0.0 task on version 1: no program, and the version 1 digest", async () => {
    const t = await setup();
    expect(await t.store.pinnedBuiltinVersion(TEST_ORG, "rovara-code")).toBe(1);
    const meta = await t.run();
    expect(meta.workflow).toMatchObject({ definitionVersion: "1.0.0", stage: "PLAN" });
    expect(meta.workflow?.program).toBeUndefined();
    expect(meta.agent).toMatchObject({ version: 1, digest: recipeDigest(builtinRecipe("rovara-code", 1)) });
  });

  it("an org pinned to 2 starts a 1.1.0 task that follows the six-step program, and an org pinned to 1 keeps 1.0.0", async () => {
    const t = await setup();
    await t.store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
    t.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: now });
    const meta = await t.run();
    // Until Understand is live (Task 4), a 1.1.0 task starts on the plan step as it did after Task 2.
    expect(meta.workflow).toMatchObject({ definitionVersion: "1.1.0", stage: "PLAN", programStepId: "plan" });
    expect(meta.workflow?.program?.steps.map((step) => step.kind)).toEqual(["plan", "plan_critic", "build", "check", "review", "pull_request"]);
    expect(meta.agent).toMatchObject({ version: 2, digest: recipeDigest(v2()) });

    t.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 1, updatedBy: "test", updatedAt: now });
    const old = await t.run();
    expect(old.workflow).toMatchObject({ definitionVersion: "1.0.0" });
    expect(old.workflow?.program).toBeUndefined();
  });

  it("the flag for new orgs is off until Task 8 flips it: a newly created org gets no Rovara Code pin and runs version 1 exactly as before", async () => {
    expect(ROVARA_CODE_V2_FOR_NEW_ORGS).toBe(false);
    const db = new FakeDynamoDb();
    const orgs = new OrgStore({ documentClient: db, tableName: "state", now: Date.now });
    const orgId = await orgs.createOrgWithOwner({ name: "Acme", developerId: "dev-1" });
    const key = builtinSettingsKey(orgId, "rovara-code");
    expect(db.get(key.pk, key.sk)).toMatchObject({ stopKind: "inherit", revision: 1 });
    expect(db.get(key.pk, key.sk)?.pinnedVersion).toBeUndefined();
    const store = new AgentStore({ documentClient: db, tableName: "state", now: Date.now });
    expect(await store.pinnedBuiltinVersion(orgId, "rovara-code")).toBe(1);
  });

  it("with the flag on, a newly created org has an explicit pin of 2, written in the creating transaction, and the templates are not touched", async () => {
    const db = new FakeDynamoDb();
    const orgs = new OrgStore({ documentClient: db, tableName: "state", now: Date.now, rovaraCodeV2ForNewOrgs: true });
    const orgId = await orgs.createOrgWithOwner({ name: "Acme", developerId: "dev-1" });
    const key = builtinSettingsKey(orgId, "rovara-code");
    expect(db.get(key.pk, key.sk)).toMatchObject({ pinnedVersion: 2, entityType: "BUILTIN_AGENT_SETTINGS" });
    const store = new AgentStore({ documentClient: db, tableName: "state", now: Date.now });
    expect(await store.pinnedBuiltinVersion(orgId, "rovara-code")).toBe(2);
    expect(await store.getBuiltinSettings(orgId, "ticket-triage")).toMatchObject({ stopKind: "inherit", revision: 1 });
    expect((await store.getBuiltinSettings(orgId, "ticket-triage"))?.pinnedVersion).toBeUndefined();
  });

  it("R3-4: an org with no settings item sees version 1 in the roster, and (once version 2 is available) adopting it writes a pin of 2 so its next task is 1.1.0", async () => {
    const t = await setup({ rovaraCodeV2Live: true });
    seedMembership(t.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
    const listed = await t.dev(MAYA, "GET", "/v1/app/agents?scope=builtin");
    const entry = (listed.body.agents as Array<{ agentId: string; pinnedVersion: number; latestVersion: number }>).find((agent) => agent.agentId === "rovara-code")!;
    expect(entry).toMatchObject({ pinnedVersion: 1, latestVersion: 2 });
    expect(builtinDefaultPin("rovara-code")).toBe(1);

    const adopted = await t.dev(MAYA, "POST", "/v1/app/agents/rovara-code/adopt", { requestId: randomUUID(), version: 2 });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    expect(adopted.body).toMatchObject({ pinnedVersion: 2 });
    expect(t.db.get(builtinSettingsKey(TEST_ORG, "rovara-code").pk, builtinSettingsKey(TEST_ORG, "rovara-code").sk)).toMatchObject({ pinnedVersion: 2 });
    const meta = await t.run();
    expect(meta.workflow).toMatchObject({ definitionVersion: "1.1.0" });
  });

  it("while version 2 is not available (ROVARA_CODE_V2_FOR_NEW_ORGS is off) an org admin cannot adopt it, and nothing is written", async () => {
    const t = await setup();
    seedMembership(t.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
    const adopted = await t.dev(MAYA, "POST", "/v1/app/agents/rovara-code/adopt", { requestId: randomUUID(), version: 2 });
    expect(adopted.status).toBe(400);
    expect(adopted.body.error).toEqual({ code: "CONFIG_INVALID", message: "Version 2 of Rovara Code is not available yet." });
    expect(t.db.get(builtinSettingsKey(TEST_ORG, "rovara-code").pk, builtinSettingsKey(TEST_ORG, "rovara-code").sk)).toBeUndefined();
    expect(await t.store.pinnedBuiltinVersion(TEST_ORG, "rovara-code")).toBe(1);
    // Version 1 can still be adopted (a no-op) and the other built-ins are untouched by the gate.
    const same = await t.dev(MAYA, "POST", "/v1/app/agents/rovara-code/adopt", { requestId: randomUUID(), version: 1 });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
  });

  it("R3-4: a custom agent built on Rovara Code sees no update while the org is still on version 1", async () => {
    const t = await setup();
    const created = await t.dev(MAYA, "POST", "/v1/app/agents", { requestId: randomUUID(), name: `Mine ${randomUUID().slice(0, 6)}`, extends: "rovara-code", overlay: {} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agentId = (created.body.agent as { agentId: string }).agentId;
    expect((await t.store.getDraft(TEST_ORG, agentId as never))?.extends).toEqual({ agentId: "rovara-code", version: 1 });
    expect(await updateAvailable(t.store, TEST_ORG, agentId as never)).toBeUndefined();
  });
});
