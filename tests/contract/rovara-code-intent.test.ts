// Plan 6 Task 3: one entry point for intents. `startCodeIntent` starts Rovara Code work for every surface (the app route here; Slack today; Linear, offers, the CLI and MCP through
// Plan 9 and Task 25), through the same start every task uses, so the project role, the company's rules, the budget and the planning limit are the ones that already exist. A
// version 2 task starts at UNDERSTAND/READY; a version 1 task starts as it always did. The broker is built with `agents: {}` as the deployed handler is.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { startCodeIntent } from "../../packages/broker/src/rovara-code/intent.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { sessionBindingKey, sessionSurfaceKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { orgMemberKey, orgRemovedKey, developerOrgKey } from "../../packages/contracts/src/org-node.js";
import { builtinSettingsKey, projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { CodeIntentBodySchema, CodeIntentRequestSchema } from "../../packages/contracts/src/rovara-code-intent.js";
import { StartDeveloperTaskRequestSchema } from "../../packages/contracts/src/developer-tasks-node.js";
import { WorkflowSnapshotSchema, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import type { AgentXError } from "../../packages/contracts/src/errors.js";
import type { OrgId } from "../../packages/contracts/src/org.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, loadSlackBroker } from "../support/slack-broker.js";
import { seedDesignReviewCompany } from "../support/design-review-company.js";
import { designFirstRequestOf } from "../../packages/broker/src/design-review/design-first.js";

const ARJUN: Developer = { developerId: "a1".repeat(32), name: "Arjun Rao", provider: "oidc", sessionId: "s-arjun" };
const KIT: Developer = { developerId: "4".repeat(64), name: "Kit Alvarez", provider: "oidc", sessionId: "s-kit" };
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TASK_ID_A = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const NOW = "2026-10-25T12:00:00.000Z";
const PROXY_URL = "http://internal-proxy.example.test:4000";
const ISSUE = { kind: "linear_issue" as const, issueId: "ENG-412", url: "https://linear.app/acme/issue/ENG-412" };
const THREAD = { kind: "slack_thread" as const, teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000777" };

let createCodeIntentStarter: typeof BrokerModule.createCodeIntentStarter;
let createCodeIntentDependencies: typeof BrokerModule.createCodeIntentDependencies;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createCodeIntentStarter, createCodeIntentDependencies } = await import("../../packages/broker/src/aws/broker.js"));
});

type Reply = { status: number; body: Record<string, unknown> };
const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: AgentXError) => ({ code: error.code, message: error.message.replace(`${error.code}: `, "") }));

async function setup(options: { v2?: boolean; live?: boolean; proxy?: boolean; orgs?: boolean } = {}) {
  const access = options.proxy === true ? fakeModelAccess() : undefined;
  const h = await createDeveloperTaskBroker({
    ...(options.orgs === true ? { orgResolver: async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG) } : {}),
    brokerExtra: { agents: { ...((options.live ?? options.v2) === true ? { rovaraCodeV2Live: true } : {}) }, ...(access === undefined ? {} : { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true }) },
  });
  if (access !== undefined) {
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
    access.setOrgSpent(TEST_ORG, 0);
  }
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  if (options.v2 === true) {
    await store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
    h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: NOW });
  }
  /** A member of the org who is a contributor on payments (or the role named), signed in. */
  const member = async (who: Developer, role: "viewer" | "contributor" | "maintainer" | undefined = "contributor") => {
    await h.orgOf(who);
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role: "member" });
    if (role !== undefined) h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", grantId: randomUUID(), role: role === "viewer" ? "viewer" : "developer", projectRole: role });
  };
  const send = async (who: Developer, body: Record<string, unknown>, project = "payments"): Promise<Reply> => {
    const reply = await h.dev(who, "POST", `/v1/app/projects/${project}/code`, { requestId: randomUUID(), input: { text: "Fix the retry bug" }, ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const taskOf = (reply: Reply) => reply.body.task as { taskId: string; workflow?: { stage: string; definitionVersion: string } };
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & {
    workspaceId: string; origin?: string; payer?: Record<string, unknown>; startedBy?: Record<string, unknown>; sessionId?: string; budgetUsd?: number; share?: Record<string, unknown>;
    workflow?: { definitionVersion: string; stage: string; state: string; path: string; reviewPhase?: string; intent?: { rounds: number; pathFrom: string; answers: unknown[] }; programStepId?: string };
  };
  const taskCount = () => h.db.find((item) => item.entityType === "DEVELOPER_TASK").length;
  const sessions = () => h.db.find((item) => item.entityType === "AGENT_SESSION");
  const charges = () => h.db.find((item) => item.entityType === "DEVELOPER_LIMIT" || item.entityType === "SLACK_LIMIT");
  const pointer = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "DEVELOPER_TASK_POINTER")[0] as { pendingPrompt?: string; pendingWorkflowMode?: string } | undefined;
  /** The broker's entry for Plan 9: the person is named by id and org, and re-read (sign-in, revocation, membership, role) on every call. */
  const start = (who: Developer, request: unknown, orgId: OrgId = TEST_ORG, developerId: string = who.developerId) => {
    const found = createCodeIntentStarter(h.brokerInput as never);
    if (found === undefined) throw new Error("the broker has no code intent starter");
    return found(orgId, developerId, request);
  };
  const callerOf = (who: Developer, orgId: OrgId = TEST_ORG) => ({
    developerId: who.developerId, sessionId: who.sessionId, amr: who.provider, name: who.name, orgId, orgRole: "member" as const,
    ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }),
  });
  const intent = (extra: Record<string, unknown> = {}) => ({
    requestId: randomUUID(), project: "payments", input: { text: "Fix the retry bug" }, source: "app" as const, ...extra,
  });
  const bindings = () => h.db.find((item) => item.entityType === "AGENT_SESSION_BINDING" || item.entityType === "SESSION_SURFACE");
  return { ...h, access, store, member, send, taskOf, meta, taskCount, sessions, charges, pointer, start, callerOf, intent, bindings };
}

describe("the request shapes", () => {
  const base = { requestId: randomUUID(), project: "payments", input: { text: "Fix it" }, source: "app" };

  it("takes a plain app request and nothing the request itself must not say", () => {
    expect(CodeIntentRequestSchema.safeParse(base).success).toBe(true);
    expect(CodeIntentRequestSchema.safeParse({ ...base, path: "FULL" }).success).toBe(true);
    expect(CodeIntentRequestSchema.safeParse({ ...base, path: "HUGE" }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, payer: { kind: "project", project: "payments" } }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "email" }).success).toBe(false);
  });

  it("ties each extra to its own source", () => {
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "linear", binding: ISSUE, assignedBy: { developerId: ARJUN.developerId, bot: false } }).success).toBe(true);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "slack", binding: THREAD }).success).toBe(true);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "offer", offerId: "off_1" }).success).toBe(true);
    // A binding of the wrong kind, a binding on a source that has none, a source that needs its binding, an assigner on a non-Linear start, an offer id on a non-offer.
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "linear", binding: THREAD }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "app", binding: ISSUE }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "slack" }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "linear" }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, assignedBy: { bot: true } }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, offerId: "off_1" }).success).toBe(false);
  });

  it("bounds the text: an empty intent and one over 8 KB are refused", () => {
    expect(CodeIntentRequestSchema.safeParse({ ...base, input: { text: "" } }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, input: { text: "x".repeat(8193) } }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, input: { text: "x".repeat(8192) } }).success).toBe(true);
  });

  it("the route body has the request id, the input and the path, and no key that names a source, a payer or a binding", () => {
    const body = { requestId: randomUUID(), input: { text: "Fix it" } };
    expect(CodeIntentBodySchema.safeParse(body).success).toBe(true);
    expect(CodeIntentBodySchema.safeParse({ ...body, designFirst: true }).success).toBe(true);
    expect(CodeIntentBodySchema.safeParse({ ...body, designFirst: "yes" }).success).toBe(false);
    // The intent carries it for the app only, and only as true.
    const intent = { requestId: randomUUID(), project: "payments", input: { text: "Fix it" } };
    expect(CodeIntentRequestSchema.safeParse({ ...intent, source: "app", designFirst: true }).success).toBe(true);
    expect(CodeIntentRequestSchema.safeParse({ ...intent, source: "app", designFirst: false }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...intent, source: "slack", binding: THREAD, designFirst: true }).success).toBe(false);
    for (const extra of [{ source: "linear" }, { assignedBy: { bot: true } }, { binding: ISSUE }, { payer: { kind: "project", project: "payments" } }, { offerId: "off_1" }, { retryOf: TASK_ID_A }, { project: "payments" }]) {
      expect(CodeIntentBodySchema.safeParse({ ...body, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("the start request allows a workflow with no path (Understand chooses it on version 2) and still refuses a path without a workflow", () => {
    const request = { requestId: randomUUID(), project: "payments", instructions: "Fix retry handling" };
    expect(StartDeveloperTaskRequestSchema.safeParse({ ...request, workflow: true }).success).toBe(true);
    expect(StartDeveloperTaskRequestSchema.safeParse({ ...request, workflowPath: "QUICK" }).success).toBe(false);
  });
});

describe("a workflow that starts by understanding", () => {  it("starts at UNDERSTAND/READY with an empty intent, only on version 1.1.0", () => {
    const created = createWorkflowSnapshot({ taskId: TASK_ID_A, ownerId: "a".repeat(64), now: NOW, definitionVersion: "1.1.0", understand: true, pathFrom: "understand" });
    expect(created).toMatchObject({ definitionVersion: "1.1.0", stage: "UNDERSTAND", state: "READY", path: "QUICK", intent: { rounds: 0, pathFrom: "understand", answers: [] } });
    expect(WorkflowSnapshotSchema.safeParse(created).success).toBe(true);
    expect(() => createWorkflowSnapshot({ taskId: TASK_ID_A, ownerId: "a".repeat(64), now: NOW, understand: true })).toThrow(/1\.1\.0/);
    expect(() => createWorkflowSnapshot({ taskId: TASK_ID_A, ownerId: "a".repeat(64), now: NOW, pathFrom: "request" })).toThrow(/1\.1\.0/);
  });

  it("keeps the plan stage for a start that does not understand first, as before", () => {
    expect(createWorkflowSnapshot({ taskId: TASK_ID_A, ownerId: "a".repeat(64), now: NOW })).toMatchObject({ definitionVersion: "1.0.0", stage: "PLAN", state: "RUNNING" });
  });
});

describe("POST /v1/app/projects/{project}/code on a version 2 org", () => {
  it("starts a 1.1.0 workflow at UNDERSTAND/READY with a session, answering 202 with the task, the session id and its link", async () => {
    const t = await setup({ v2: true });
    const reply = await t.send(MAYA, {});
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const task = t.taskOf(reply);
    const stored = t.meta(task.taskId);
    expect(stored.workflow).toMatchObject({ definitionVersion: "1.1.0", stage: "UNDERSTAND", state: "READY", path: "QUICK", intent: { rounds: 0, pathFrom: "understand", answers: [] }, programStepId: "plan" });
    expect(stored).toMatchObject({ origin: "app", payer: { kind: "member", developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId } });
    expect(reply.body.sessionId).toBe(stored.sessionId);
    expect(reply.body.sessionId).toMatch(/^ses_[0-9a-z]{20}$/);
    expect(String(reply.body.sessionUrl)).toContain(String(reply.body.sessionId));
    expect(t.sessions()).toHaveLength(1);
    // A client that does not send x-agentx-task-view: 2 reads a stage it knows.
    expect(task.workflow).toMatchObject({ stage: "PLAN", definitionVersion: "1.0.0" });
  });

  it("queues no planning run for a task that understands first: its first step is the engine's, so no model is asked until Understand runs", async () => {
    const t = await setup({ v2: true, proxy: true });
    const reply = await t.send(MAYA, {});
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const stored = t.meta(t.taskOf(reply).taskId);
    expect(t.pointer(stored.workspaceId)?.pendingPrompt).toBeUndefined();
    expect(t.pointer(stored.workspaceId)?.pendingWorkflowMode).toBeUndefined();
    expect(t.access!.mintKey).not.toHaveBeenCalled();
  });

  it("can be read at the stage it starts in (the full view with the header, a stage older clients know without it) and cancelled before Understand has run", async () => {
    const t = await setup({ v2: true });
    const reply = await t.send(MAYA, {});
    const { taskId } = t.taskOf(reply);
    const plain = await t.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect((plain.body.task as { workflow: { stage: string } }).workflow.stage).toBe("PLAN");
    const stopped = await t.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    const again = await t.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(again.status).toBe(200);
  });

  it("records pathFrom 'request' and the FULL path when the request names one", async () => {
    const t = await setup({ v2: true });
    const reply = await t.send(MAYA, { path: "FULL" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(t.meta(t.taskOf(reply).taskId).workflow).toMatchObject({ definitionVersion: "1.1.0", stage: "UNDERSTAND", path: "FULL", reviewPhase: "REQUIREMENTS", intent: { pathFrom: "request" } });
  });

  it("starts one task for the same request id sent twice, and refuses the same id for another request", async () => {
    const t = await setup({ v2: true, proxy: true });
    const requestId = randomUUID();
    const first = await t.send(MAYA, { requestId });
    const second = await t.send(MAYA, { requestId });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(t.taskOf(second).taskId).toBe(t.taskOf(first).taskId);
    expect(second.body.sessionId).toBe(first.body.sessionId);
    expect(t.taskCount()).toBe(1);
    expect(t.sessions()).toHaveLength(1);
    expect(t.charges()).toHaveLength(2);
    const other = await t.send(MAYA, { requestId, input: { text: "Something else" } });
    expect(other.status).toBe(409);
    expect(errorOf(other).code).toBe("IDEMPOTENCY_CONFLICT");
    const otherPath = await t.send(MAYA, { requestId, path: "FULL" });
    expect(otherPath.status).toBe(409);
    expect(t.taskCount()).toBe(1);
  });

  it("refuses an unknown key, an empty or oversize intent and a bad path before anything is written", async () => {
    const t = await setup({ v2: true });
    for (const body of [{ source: "linear" }, { assignedBy: { bot: true } }, { payer: { kind: "project", project: "payments" } }, { input: { text: "" } }, { input: { text: "x".repeat(9000) } }, { path: "HUGE" }]) {
      const reply = await t.send(MAYA, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(reply).code).toBe("CONFIG_INVALID");
    }
    expect(t.taskCount()).toBe(0);
    expect(t.charges()).toEqual([]);
  });

  it("answers a project that does not exist, and a project of another org, with the same 404 and writes nothing", async () => {
    const t = await setup({ v2: true, orgs: true });
    seedMembership(t.db, OMAR.developerId, { orgId: ORG_B, role: "owner" });
    const missing = await t.send(MAYA, {}, "nothing-here");
    expect(missing.status).toBe(404);
    // The route's own answer: it never echoes the name the person typed.
    expect(errorOf(missing)).toEqual({ code: "PROJECT_NOT_FOUND", message: "project not found" });
    // OMAR is in another org: `payments` is Maya's org's project, and to him it does not exist.
    const foreign = await t.send(OMAR, {});
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(t.taskCount()).toBe(0);
    expect(t.sessions()).toEqual([]);
  });

  it("refuses a project viewer with PROJECT_ACCESS_DENIED and writes nothing", async () => {
    const t = await setup({ v2: true, proxy: true });
    await t.member(KIT, "viewer");
    const reply = await t.send(KIT, {});
    expect(reply.status).toBe(403);
    expect(errorOf(reply).code).toBe("PROJECT_ACCESS_DENIED");
    expect(t.taskCount()).toBe(0);
    expect(t.charges()).toEqual([]);
    expect(t.sessions()).toEqual([]);
    expect(t.access!.mintKey).not.toHaveBeenCalled();
  });

  it("refuses an archived project with PROJECT_ARCHIVED", async () => {
    const t = await setup({ v2: true });
    seedMembership(t.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
    const archived = await t.dev(MAYA, "POST", "/v1/app/projects/payments/archive", { requestId: randomUUID() });
    expect(archived.status, JSON.stringify(archived.body)).toBeLessThan(300);
    const reply = await t.send(MAYA, {});
    expect(errorOf(reply).code).toBe("PROJECT_ARCHIVED");
    expect(t.taskCount()).toBe(0);
  });

  it("goes through the budget: a member over their budget gets the budget refusal, with no task, no session and no charge", async () => {
    const t = await setup({ v2: true, proxy: true });
    t.access!.setMemberSpent(TEST_ORG, MAYA.developerId, 1_000_000);
    const reply = await t.send(MAYA, {});
    expect(reply.status).toBe(402);
    expect(errorOf(reply).code).toBe("BUDGET_EXCEEDED");
    expect(t.taskCount()).toBe(0);
    expect(t.sessions()).toEqual([]);
    expect(t.charges()).toEqual([]);
  });

  it("starts at the planning limit of the Quick path, as every workflow start does", async () => {
    const t = await setup({ v2: true, proxy: true });
    const quick = await t.send(MAYA, {});
    expect(t.meta(t.taskOf(quick).taskId).budgetUsd).toBe(2);
    const full = await t.send(MAYA, { path: "FULL" });
    expect(t.meta(t.taskOf(full).taskId).budgetUsd).toBe(6);
  });
});

describe("POST /v1/app/projects/{project}/code on a version 1 org", () => {
  it("refuses a start with no path in today's words, and writes nothing", async () => {
    const t = await setup();
    const reply = await t.send(MAYA, {});
    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toEqual({ code: "CONFIG_INVALID", message: "workflowPath: workflow requests require an explicit Quick or Full path" });
    expect(t.taskCount()).toBe(0);
    expect(t.charges()).toEqual([]);
    expect(t.sessions()).toEqual([]);
  });

  it("starts a 1.0.0 workflow at PLAN with a path, and queues the planning run as today", async () => {
    const t = await setup();
    const reply = await t.send(MAYA, { path: "QUICK" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const stored = t.meta(t.taskOf(reply).taskId);
    expect(stored.workflow).toMatchObject({ definitionVersion: "1.0.0", stage: "PLAN", state: "RUNNING", path: "QUICK" });
    expect(stored.workflow?.intent).toBeUndefined();
    expect(t.pointer(stored.workspaceId)).toMatchObject({ pendingPrompt: "Fix the retry bug", pendingWorkflowMode: "PLAN" });
  });

  it("starts a 1.0.0 workflow for an org that was never given a Rovara Code pin: the new-org flag is off, and a new intent does not pin version 2 itself", async () => {
    const t = await setup();
    expect(await t.store.pinnedBuiltinVersion(TEST_ORG, "rovara-code")).toBe(1);
    const reply = await t.send(MAYA, { path: "FULL" });
    expect(t.meta(t.taskOf(reply).taskId).workflow).toMatchObject({ definitionVersion: "1.0.0", stage: "PLAN", reviewPhase: "REQUIREMENTS" });
    expect(await t.store.pinnedBuiltinVersion(TEST_ORG, "rovara-code")).toBe(1);
  });
});

describe("startCodeIntent for the surfaces that call it directly", () => {
  it("a Linear intent charges the assigner, binds the issue in the start transaction, and records the surface as the origin", async () => {
    const t = await setup({ v2: true });
    await t.member(ARJUN);
    const result = await t.start(MAYA, t.intent({ source: "linear", binding: ISSUE, assignedBy: { developerId: ARJUN.developerId, bot: false } }));
    const stored = t.meta(result.task.taskId);
    expect(stored).toMatchObject({ origin: "linear", payer: { kind: "member", developerId: ARJUN.developerId }, startedBy: { developerId: MAYA.developerId } });
    expect(result.sessionId).toBe(stored.sessionId);
    expect(t.db.get(sessionBindingKey(TEST_ORG, result.sessionId as never, "linear_issue").pk, sessionBindingKey(TEST_ORG, result.sessionId as never, "linear_issue").sk)).toMatchObject({ binding: ISSUE });
    expect(t.db.get(sessionSurfaceKey(TEST_ORG, ISSUE).pk, sessionSurfaceKey(TEST_ORG, ISSUE).sk)).toMatchObject({ sessionId: result.sessionId });
  });

  it("a Linear intent from a bot charges the project, not the person who happens to be the caller", async () => {
    const t = await setup({ v2: true });
    const result = await t.start(MAYA, t.intent({ source: "linear", binding: ISSUE, assignedBy: { bot: true } }));
    expect(t.meta(result.task.taskId).payer).toEqual({ kind: "project", project: "payments" });
  });

  it("refuses an assigner who is only a viewer, and one who is not a member, before anything is written: naming a person never gives them spend", async () => {
    const t = await setup({ v2: true });
    await t.member(ARJUN, "viewer");
    const viewer = await refusal(t.start(MAYA, t.intent({ source: "linear", binding: ISSUE, assignedBy: { developerId: ARJUN.developerId, bot: false } })));
    expect(viewer?.code).toBe("PROJECT_ACCESS_DENIED");
    const stranger = await refusal(t.start(MAYA, t.intent({ source: "linear", binding: ISSUE, assignedBy: { developerId: "9".repeat(64), bot: false } })));
    expect(stranger?.code).toBe("FORBIDDEN");
    expect(t.taskCount()).toBe(0);
    expect(t.bindings()).toEqual([]);
  });

  it("an offer charges the person who accepted it, and records the offer's origin", async () => {
    const t = await setup({ v2: true });
    await t.member(KIT);
    const result = await t.start(KIT, t.intent({ source: "offer", offerId: "off_17" }));
    expect(t.meta(result.task.taskId)).toMatchObject({ origin: "offer", payer: { kind: "member", developerId: KIT.developerId }, startedBy: { developerId: KIT.developerId } });
  });

  it("a Linear issue that already follows a session cannot be bound again: the second start is refused and starts no task", async () => {
    const t = await setup({ v2: true });
    await t.start(MAYA, t.intent({ source: "linear", binding: ISSUE, assignedBy: { bot: true } }));
    const second = await refusal(t.start(MAYA, t.intent({ source: "linear", binding: ISSUE, assignedBy: { bot: true } })));
    expect(second).toEqual({ code: "CONFIG_INVALID", message: "This issue already follows another session." });
    expect(t.taskCount()).toBe(1);
    expect(t.sessions()).toHaveLength(1);
  });

  it("a repeat of a Linear start returns the first task and binds nothing twice", async () => {
    const t = await setup({ v2: true });
    const request = t.intent({ source: "linear", binding: ISSUE, assignedBy: { bot: true } });
    const first = await t.start(MAYA, request);
    const again = await t.start(MAYA, request);
    expect(again.task.taskId).toBe(first.task.taskId);
    expect(again.sessionId).toBe(first.sessionId);
    expect(t.taskCount()).toBe(1);
    expect(t.bindings()).toHaveLength(2);
    const changed = await refusal(t.start(MAYA, { ...request, assignedBy: { developerId: ARJUN.developerId, bot: false } }));
    expect(changed?.code).toBeDefined();
    expect(t.taskCount()).toBe(1);
  });

  it("another person's request id for the same body is not a replay: it is refused, never answered with someone else's task", async () => {
    const t = await setup({ v2: true });
    await t.member(KIT);
    const request = t.intent();
    const first = await t.start(MAYA, request);
    const other = await refusal(t.start(KIT, request));
    expect(other?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(t.taskCount()).toBe(1);
    expect(first.task.taskId).toBeDefined();
  });

  it("a start from another org's caller cannot reach this org's project", async () => {
    const t = await setup({ v2: true });
    await t.member(KIT, undefined);
    seedMembership(t.db, KIT.developerId, { orgId: ORG_B, role: "member" });
    const result = await refusal(t.start(KIT, t.intent(), ORG_B));
    expect(result?.code).toBe("PROJECT_NOT_FOUND");
    expect(t.taskCount()).toBe(0);
  });

  it("refuses a Slack intent from a caller that is not the Slack workflow's own, and a hand-off before that task exists (a retry after an answer is accepted: Task 6)", async () => {
    const t = await setup({ v2: true });
    const notSlack = await refusal(t.start(MAYA, t.intent({ source: "slack", binding: THREAD })));
    expect(notSlack?.code).toBe("FORBIDDEN");
    const startAt = await refusal(t.start(MAYA, t.intent({ startAt: { repository: "demo", commit: "a".repeat(40), summary: "Half done" } })));
    expect(startAt?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(t.taskCount()).toBe(0);
    // Task 6: `retryOf` (the "change anyway" start) is checked: a task that is not an answered one the caller can see is refused (the accepted case is in rovara-code-answered.test.ts).
    const retried = await refusal(t.start(MAYA, t.intent({ retryOf: TASK_ID_A })));
    expect(retried).toMatchObject({ code: "CONFIG_INVALID", message: "That task can't be followed up." });
    expect(t.taskCount()).toBe(0);
  });

  it("records the surface as the origin for every source a person can start from", async () => {
    const t = await setup({ v2: true });
    for (const source of ["app", "cli", "mcp"] as const) {
      const result = await t.start(MAYA, t.intent({ source }));
      expect(t.meta(result.task.taskId), source).toMatchObject({ origin: source, payer: { kind: "member", developerId: MAYA.developerId } });
    }
  });

  it("refuses a Slack intent whose thread is in another workspace than this one, rather than leaving the task unbound", async () => {
    const t = await setup({ v2: true });
    const slackCaller = { ...t.callerOf(MAYA), sessionId: "slack-workflow" };
    const dependencies = createCodeIntentDependencies(t.brokerInput as never, slackCaller)!;
    const refused = await refusal(startCodeIntent(dependencies, slackCaller, t.intent({ source: "slack", binding: { ...THREAD, teamId: "T0ELSEWHERE" } })));
    expect(refused).toEqual({ code: "CONFIG_INVALID", message: "this task can't be shared to that Slack thread" });
    expect(t.taskCount()).toBe(0);
    expect(t.bindings()).toEqual([]);
  });

  it("a request the schema refuses is refused before any read", async () => {
    const t = await setup({ v2: true });
    const bad = await refusal(t.start(MAYA, { ...t.intent(), source: "linear" }));
    expect(bad?.code).toBe("CONFIG_INVALID");
    expect(t.taskCount()).toBe(0);
  });
});

describe("a deployment where agents are not set up", () => {
  it("has no app route for starting work, and no Plan 9 entry", async () => {
    const h = await createDeveloperTaskBroker();
    const reply = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Fix it" } });
    expect(reply.status).toBe(404);
    expect(h.db.find((item) => item.entityType === "DEVELOPER_TASK")).toEqual([]);
    const refused = await refusal(createCodeIntentStarter(h.brokerInput as never)(TEST_ORG, MAYA.developerId, { requestId: randomUUID(), project: "payments", input: { text: "Fix it" }, source: "app", path: "QUICK" }));
    expect(refused?.code).toBe("RUNTIME_UNAVAILABLE");
    // Without sessions behind it the check itself says no.
    const caller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name, orgId: TEST_ORG, orgRole: "member" as const };
    const dependencies = createCodeIntentDependencies(h.brokerInput as never, caller);
    expect(await dependencies?.retryable?.(caller, TASK_ID_A)).toBe(false);
  });

  /** The dependencies of a deployment with no agents, with a plain start that records what it was asked. */
  const plain = () => {
    const bodies: unknown[] = [];
    const dependencies = {
      starter: undefined, origin: "https://cell.example.com",
      startPlainTask: async (_caller: unknown, body: unknown) => { bodies.push(body); return { task: { taskId: TASK_ID_A } } as never; },
      ownedTask: async () => { throw new Error("not read"); },
      projectProcess: async () => { throw new Error("not asked"); },
    };
    const caller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name, orgId: TEST_ORG, orgRole: "member" as const };
    return { bodies, dependencies, caller };
  };
  const request = (extra: Record<string, unknown>) => ({ requestId: randomUUID(), project: "payments", input: { text: "Fix it" }, source: "app", ...extra });

  it("hands a person's own start to the plain task start, with the path they chose and no session", async () => {
    const { bodies, dependencies, caller } = plain();
    const result = await startCodeIntent(dependencies, caller, request({ path: "FULL" }));
    expect(result).toEqual({ task: { taskId: TASK_ID_A } });
    expect(bodies).toEqual([expect.objectContaining({ project: "payments", instructions: "Fix it", workflow: true, workflowPath: "FULL", client: "app" })]);
  });

  it("a follow-up to an answered task needs agents: without them it says so plainly, and starts nothing", async () => {
    const { bodies, dependencies, caller } = plain();
    const refused = await refusal(startCodeIntent(dependencies, caller, request({ retryOf: TASK_ID_A })));
    expect(refused).toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "Starting the change isn't available right now." });
    expect(bodies).toEqual([]);
  });

  it("a follow-up is started only when the deployment confirms the task it names: a missing check, a refusal and a failing check all stop it", async () => {
    const started: unknown[] = [];
    const base = { starter: {} as never, origin: "https://cell.example.com", startPlainTask: async () => { throw new Error("not used"); }, ownedTask: async () => { throw new Error("not read"); }, projectProcess: async () => { throw new Error("not asked"); } };
    const caller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name, orgId: TEST_ORG, orgRole: "member" as const };
    for (const retryable of [undefined, async () => false, async () => { throw new Error("down"); }]) {
      const refused = await refusal(startCodeIntent({ ...base, ...(retryable === undefined ? {} : { retryable }) }, caller, request({ retryOf: TASK_ID_A })));
      expect(refused, String(retryable)).toMatchObject({ code: "CONFIG_INVALID", message: "That task can't be followed up." });
    }
    expect(started).toEqual([]);
  });

  it("refuses what needs the payer rules or sessions, and context it would drop, without starting anything", async () => {
    const { bodies, dependencies, caller } = plain();
    const linear = await refusal(startCodeIntent(dependencies, caller, request({ source: "linear", binding: ISSUE, assignedBy: { bot: true } })));
    expect(linear?.code).toBe("RUNTIME_UNAVAILABLE");
    const offer = await refusal(startCodeIntent(dependencies, caller, request({ source: "offer", offerId: "off_1" })));
    expect(offer?.code).toBe("RUNTIME_UNAVAILABLE");
    const withContext = await refusal(startCodeIntent(dependencies, caller, request({ input: { text: "Fix it", context: [{ kind: "text", ref: "note", body: "More" }] } })));
    expect(withContext?.code).toBe("CONFIG_INVALID");
    expect(bodies).toEqual([]);
  });
});

describe("the person is re-read on every call to the Plan 9 entry", () => {
  it("refuses a revoked person, and writes nothing", async () => {
    const t = await setup({ v2: true });
    await t.member(KIT);
    t.db.set({ pk: `DEVELOPER#${KIT.developerId}`, sk: "META", developerId: KIT.developerId, provider: KIT.provider, displayName: KIT.name, firstSignInAt: "x", lastSignInAt: "x", revoked: true });
    const refused = await refusal(t.start(KIT, t.intent()));
    expect(refused).toEqual({ code: "FORBIDDEN", message: "The person this run is for isn't a member of the organization." });
    expect(t.taskCount()).toBe(0);
    expect(t.sessions()).toEqual([]);
  });

  it("refuses a member who was removed from the org, and a person who is in another org than the one named", async () => {
    const t = await setup({ v2: true });
    await t.member(KIT);
    expect((await t.start(KIT, t.intent())).task.taskId).toBeDefined();
    await t.db.send(new DeleteCommand({ TableName: "state", Key: orgMemberKey(TEST_ORG, KIT.developerId) }));
    t.db.set({ ...orgRemovedKey(TEST_ORG, KIT.developerId), entityType: "ORG_REMOVED", removedAt: NOW });
    t.db.set({ ...developerOrgKey(KIT.developerId), entityType: "DEVELOPER_ORG", orgId: ORG_B, role: "member", joinedAt: NOW });
    const removed = await refusal(t.start(KIT, t.intent()));
    expect(removed?.code).toBe("FORBIDDEN");
    const elsewhere = await refusal(t.start(MAYA, t.intent(), ORG_B));
    expect(elsewhere?.code).toBe("FORBIDDEN");
    expect(t.taskCount()).toBe(1);
  });

  it("takes the role from the records, not from the caller: a project viewer is refused however the request is made", async () => {
    const t = await setup({ v2: true });
    await t.member(KIT, "viewer");
    const refused = await refusal(t.start(KIT, t.intent()));
    expect(refused?.code).toBe("PROJECT_ACCESS_DENIED");
    expect(t.taskCount()).toBe(0);
  });

  it("refuses an unknown person id", async () => {
    const t = await setup({ v2: true });
    const refused = await refusal(t.start(MAYA, t.intent(), TEST_ORG, "7".repeat(64)));
    expect(refused?.code).toBe("FORBIDDEN");
  });
});

describe("while Understand is not live (ROVARA_CODE_V2_FOR_NEW_ORGS is off)", () => {
  it("a task on a pinned version 2 starts on the plan step as after Task 2, with its planning run queued, and needs an explicit path", async () => {
    const t = await setup({ v2: true, live: false });
    const noPath = await t.send(MAYA, {});
    expect(noPath.status).toBe(400);
    expect(errorOf(noPath).message).toBe("workflowPath: workflow requests require an explicit Quick or Full path");
    expect(t.taskCount()).toBe(0);
    const reply = await t.send(MAYA, { path: "FULL" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const stored = t.meta(t.taskOf(reply).taskId);
    expect(stored.workflow).toMatchObject({ definitionVersion: "1.1.0", stage: "PLAN", state: "RUNNING", path: "FULL" });
    expect(stored.workflow?.intent).toBeUndefined();
    expect(t.pointer(stored.workspaceId)).toMatchObject({ pendingPrompt: "Fix the retry bug", pendingWorkflowMode: "PLAN" });
  });
});

describe("the Slack start goes through startCodeIntent", () => {
  it("starts the same task it did, shared to the thread and bound to it, with the Slack origin and the explicit path as the request's choice", async () => {
    const t = await setup({ v2: true });
    const owner = "U0SLACKOWN1";
    const developerId = developerIdForSlackUser(owner);
    seedMembership(t.db, developerId, { orgId: TEST_ORG, role: "member" });
    t.db.set({ ...projectMemberKey(TEST_ORG, developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "contributor" });
    const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000901" };
    const started = await t.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: owner, instructions: "Add a greeting", workflowPath: "FULL", requestId: randomUUID() });
    expect(started.statusCode, started.body).toBe(200);
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    const stored = t.meta(taskId);
    expect(stored).toMatchObject({ origin: "slack", payer: { kind: "member", developerId }, share: { channelId: SLACK_CHANNEL, threadTs: thread.threadTs } });
    expect(stored.workflow).toMatchObject({ definitionVersion: "1.1.0", stage: "UNDERSTAND", path: "FULL", intent: { pathFrom: "request" } });
    expect(t.db.get(sessionBindingKey(TEST_ORG, stored.sessionId as never, "slack_thread").pk, sessionBindingKey(TEST_ORG, stored.sessionId as never, "slack_thread").sk)).toMatchObject({ binding: { kind: "slack_thread", threadTs: thread.threadTs } });
  });

  it("still refuses a thread that already has a task, and now bounds the request to the run input's 8 KB", async () => {
    const t = await setup();
    const owner = "U0SLACKOWN2";
    const developerId = developerIdForSlackUser(owner);
    seedMembership(t.db, developerId, { orgId: TEST_ORG, role: "member" });
    t.db.set({ ...projectMemberKey(TEST_ORG, developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "contributor" });
    const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000902" };
    const start = (instructions: string) => t.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: owner, instructions, workflowPath: "QUICK", requestId: randomUUID() });
    const tooLong = await start("x".repeat(9000));
    expect(tooLong.statusCode).toBe(400);
    expect(JSON.parse(tooLong.body)).toMatchObject({ error: { code: "CONFIG_INVALID", message: "workflow request is empty or too long" } });
    expect(t.taskCount()).toBe(0);
    const first = await start("Add a greeting");
    expect(first.statusCode).toBe(200);
    expect(t.meta(String((JSON.parse(first.body) as { taskId: string }).taskId)).workflow).toMatchObject({ definitionVersion: "1.0.0", stage: "PLAN" });
    const again = await start("Another");
    expect(again.statusCode).toBe(409);
  });
});


// DR-UX-3: "Design first" on the web start box, the same person-decided flag as the Slack and Linear `design first:` prefix. It is offered only while `dr` is on AND the company allows design review.
describe("POST /v1/app/projects/{project}/code with Design first", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const on = (db: { set(item: Record<string, unknown>): void }, allowed = true) => { vi.stubEnv("DESIGN_REVIEW_ENABLED", "1"); seedDesignReviewCompany(db, TEST_ORG, { allowed }); };

  it("the checkbox's flag marks the task as the person's own ask (decidedBy person, by the caller) and leaves the request text alone", async () => {
    const t = await setup({ v2: true });
    await t.member(MAYA);
    on(t.db);
    const reply = await t.send(MAYA, { designFirst: true });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const stored = t.meta(t.taskOf(reply).taskId);
    expect(stored.designFirst).toMatchObject({ by: MAYA.developerId });
    expect(JSON.stringify(stored)).toContain("Fix the retry bug");
    // A task started without the flag carries no mark (positive control: the mark above came from the flag).
    const plain = await t.send(MAYA, {});
    expect(t.meta(t.taskOf(plain).taskId).designFirst).toBeUndefined();
  });

  it("the ask is written with the task row itself (by the caller, with a time), and a replay with another value is an IDEMPOTENCY_CONFLICT either way", async () => {
    const t = await setup({ v2: true });
    await t.member(MAYA);
    on(t.db);
    const requestId = randomUUID();
    const first = await t.send(MAYA, { requestId, designFirst: true });
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const stored = t.meta(t.taskOf(first).taskId);
    expect(stored.designFirst).toEqual({ by: MAYA.developerId, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/u) as unknown });
    expect(stored.designFirst).toMatchObject({ at: stored.createdAt });
    // The same request again is the same task; the same id without the ask, or with it where the first had none, is another request.
    const again = await t.send(MAYA, { requestId, designFirst: true });
    expect(again.status).toBe(202);
    expect(t.taskOf(again).taskId).toBe(t.taskOf(first).taskId);
    const without = await t.send(MAYA, { requestId });
    expect(without.status).toBe(409);
    expect(errorOf(without).code).toBe("IDEMPOTENCY_CONFLICT");
    const plainId = randomUUID();
    expect((await t.send(MAYA, { requestId: plainId })).status).toBe(202);
    const added = await t.send(MAYA, { requestId: plainId, designFirst: true });
    expect(added.status).toBe(409);
    expect(errorOf(added).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(t.taskCount()).toBe(2);
  });

  it("a project set to Off still gets the review, because the person asked (the company only has to allow it)", async () => {
    const t = await setup({ v2: true });
    await t.member(MAYA);
    on(t.db);
    seedDesignReviewCompany(t.db, TEST_ORG, { allowed: true, project: { name: "payments", mode: "never" } });
    const reply = await t.send(MAYA, { designFirst: true });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(t.meta(t.taskOf(reply).taskId).designFirst).toMatchObject({ by: MAYA.developerId });
  });

  it("is refused, and starts nothing, when the company has not allowed design review", async () => {
    const t = await setup({ v2: true });
    await t.member(MAYA);
    on(t.db, false);
    const reply = await t.send(MAYA, { designFirst: true });
    expect(reply.status).toBe(400);
    expect(errorOf(reply).code).toBe("CONFIG_INVALID");
    expect(JSON.stringify(reply.body)).not.toMatch(/admin|allow|setting|lock/iu);
    expect(t.taskCount()).toBe(0);
    expect(t.sessions()).toHaveLength(0);
  });

  it("is refused, and starts nothing, when `dr` is off, and when the company has no policy at all", async () => {
    const off = await setup({ v2: true });
    await off.member(MAYA);
    vi.stubEnv("DESIGN_REVIEW_ENABLED", "0");
    seedDesignReviewCompany(off.db, TEST_ORG, { allowed: true });
    expect((await off.send(MAYA, { designFirst: true })).status).toBe(400);
    expect(off.taskCount()).toBe(0);
    const bare = await setup({ v2: true });
    await bare.member(MAYA);
    vi.stubEnv("DESIGN_REVIEW_ENABLED", "1");
    expect((await bare.send(MAYA, { designFirst: true })).status).toBe(400);
    expect(bare.taskCount()).toBe(0);
  });

  it("a person who cannot start work on the project gets the usual refusal, not a task, with the flag on", async () => {
    const t = await setup({ v2: true });
    await t.member(MAYA, "viewer");
    on(t.db);
    const reply = await t.send(MAYA, { designFirst: true });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(t.taskCount()).toBe(0);
  });

  it("reads a leading `design first:` in the typed text the way Slack and Linear do: stripped from the stored request, the task marked", async () => {
    const t = await setup({ v2: true });
    await t.member(MAYA);
    on(t.db);
    const reply = await t.send(MAYA, { input: { text: "  Design First :  Fix the retry bug" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const stored = t.meta(t.taskOf(reply).taskId);
    expect(stored.designFirst).toMatchObject({ by: MAYA.developerId });
    const text = JSON.stringify(stored);
    expect(text).toContain("Fix the retry bug");
    expect(text).not.toMatch(/design first\s*:/iu);
  });

  it("leaves the prefix in the text, and marks nothing, while design review is not available (as Slack does)", async () => {
    const t = await setup({ v2: true });
    await t.member(MAYA);
    on(t.db, false);
    const reply = await t.send(MAYA, { input: { text: "design first: Fix the retry bug" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const stored = t.meta(t.taskOf(reply).taskId);
    expect(stored.designFirst).toBeUndefined();
    expect(JSON.stringify(stored)).toMatch(/design first: Fix the retry bug/iu);
  });

  it("a prefix with nothing after it is an empty request, refused like any other", async () => {
    const t = await setup({ v2: true });
    await t.member(MAYA);
    on(t.db);
    const reply = await t.send(MAYA, { input: { text: "design first:   " } });
    expect(reply.status).toBe(400);
    expect(t.taskCount()).toBe(0);
  });

  it("parity: the web route and the Slack and Linear reader strip the same text for the same input", async () => {
    for (const text of ["design first: add a retry", "Design-First : add a retry", "DESIGN_FIRST:add a retry", "quick: design first: add a retry", "please design first: add a retry", "design first add a retry", "design firstly: add a retry"]) {
      const t = await setup({ v2: true });
      await t.member(MAYA);
      on(t.db);
      const shared = await designFirstRequestOf({ documentClient: t.db, tableName: "state" }, TEST_ORG, text);
      const reply = await t.send(MAYA, { input: { text } });
      expect(reply.status, text).toBe(202);
      const stored = t.meta(t.taskOf(reply).taskId);
      expect(stored.designFirst !== undefined, text).toBe(shared.designFirst);
      expect(JSON.stringify(stored), text).toContain(shared.rest.trim());
    }
  });
});
