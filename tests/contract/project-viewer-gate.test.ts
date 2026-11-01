// Plan 2, Task 21, fix round 3: one gate for "viewers only view". A person who holds a project grant that cannot start tasks (a viewer) can
// look at a task and cancel it, but every action that changes it or starts work is refused with the viewer message, on every surface, and no
// dispatch for a viewer's task starts, tasks without a People sidecar included. People with no grant keep the share design.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectMemberKey, type ProjectRole } from "../../packages/contracts/src/index.js";
import { guardTaskDispatch, resumeTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { pageAccess, requireProjectWorkRole } from "../../packages/broker/src/developer/task-access.js";
import { registerRevision } from "../support/developer-task-broker.js";
import type { createDeveloperTaskBroker} from "../support/developer-task-broker.js";
import { createSingleAnswerPlanBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace, serviceCall } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
const KIT: Developer = { developerId: "4".repeat(64), name: "Kit Alvarez", provider: "oidc", sessionId: "s-kit" };
describe("I2: a Slack-linked Auditor is read-only on every Slack route that starts or changes work", () => {
  const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000701`;
  const AUDITOR = "U0AUDITSL01";

  it("the service routes refuse an Auditor who also holds a contributor grant (it was resolved to a contributor)", async () => {
    const h = await withKit();
    const developerId = developerIdForSlackUser(AUDITOR);
    seedMembership(h.db, developerId, { orgId: TEST_ORG, role: "auditor" });
    setGrant(h.db, { ...KIT, developerId }, "contributor");
    const created = await ensureWorkspace(h.handler, thread, "U0MAYA001");
    expect(created.status).toBe(200);
    const workspaceId = String(created.body.workspaceId);
    const calls: Array<[string, string, string, unknown]> = [
      ["PUT", "/v1/service/project/model", "model", { provider: "openai", modelId: "gpt-5" }],
      ["POST", "/v1/service/evals/swebench", "swebench run", {}],
      ["POST", "/v1/service/evals/batches", "swebench batch", {}],
      ["POST", "/v1/service/threads/workspace/prepare", "prepare (start work)", { requestId: randomUUID() }],
      ["POST", `/v1/service/workspaces/${workspaceId}/pull-requests`, "pull request", { requestId: randomUUID(), repository: "demo", title: "Fix" }],
      ["POST", `/v1/service/workspaces/${workspaceId}/connectors/github/call`, "connector call", { tool: "x", arguments: {} }],
      ["POST", `/v1/service/workspaces/${workspaceId}/pull-request-actions`, "pull request action", { requestId: randomUUID(), repository: "demo", pullRequestNumber: 1, action: "sync" }],
    ];
    for (const [method, path, label, body] of calls) {
      const refused = await serviceCall(h.handler, thread, AUDITOR, method, path, body);
      expect(refused.status, `${label} ${JSON.stringify(refused.body)}`).toBe(403);
      expect(refused.body.error, label).toMatchObject({ code: "TASK_ACCESS_DENIED" });
    }
  });

  it("the same Auditor with no grant at all (the channel would have made it a contributor) is refused too", async () => {
    const h = await withKit();
    seedMembership(h.db, developerIdForSlackUser(AUDITOR), { orgId: TEST_ORG, role: "auditor" });
    const refused = await serviceCall(h.handler, thread, AUDITOR, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID() });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it("cannot start a task or decide one from a Slack thread", async () => {
    const h = await withKit();
    const slackThread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000702" };
    const owner = "U0SLACKOWN2";
    const ownerId = developerIdForSlackUser(owner), auditorId = developerIdForSlackUser(AUDITOR);
    seedMembership(h.db, ownerId, { orgId: TEST_ORG, role: "member" });
    setGrant(h.db, { ...KIT, developerId: ownerId }, "contributor");
    seedMembership(h.db, auditorId, { orgId: TEST_ORG, role: "auditor" });
    setGrant(h.db, { ...KIT, developerId: auditorId }, "contributor");
    const refusedStart = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { ...slackThread, threadTs: "1695500000.000703" }, userId: AUDITOR, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    expect(refusedStart.statusCode).toBe(403);
    const started = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: slackThread, userId: owner, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    for (const taskAction of ["decide", "retry", "publish", "feedback"]) {
      const answer = await h.handler({ source: "agentx.slack-ingress", action: "task-people-authorize", taskAction, taskId, userId: AUDITOR, thread: slackThread });
      expect(answer.statusCode, taskAction).toBe(403);
    }
  });
});

const RESUMED_ORIGINAL = "This task was paused while you could only view the project. It has resumed with its original instructions; the instructions you just sent were not used, so send them again once it finishes.";
const VIEWER_MESSAGE = "You can view `payments` but not start tasks in it. Ask a maintainer to make you a contributor.";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };

function setGrant(db: FakeDynamoDb, who: Developer, role: ProjectRole): void {
  db.set({ ...projectMemberKey(TEST_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", grantId: randomUUID(),
    role: role === "viewer" ? "viewer" : "developer", projectRole: role });
}

async function withKit(): Promise<Harness> {
  const h = await createSingleAnswerPlanBroker();
  await h.orgOf(KIT);
  h.db.set({ pk: `SESSION#${KIT.sessionId}`, sk: "META", sessionId: KIT.sessionId, developerId: KIT.developerId, amr: KIT.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  h.db.set({ pk: `DEVELOPER#${KIT.developerId}`, sk: "META", developerId: KIT.developerId, provider: "oidc", displayName: KIT.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  seedMembership(h.db, KIT.developerId, { orgId: TEST_ORG, role: "member" });
  setGrant(h.db, KIT, "contributor");
  return h;
}

const operations = (h: Harness, workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");

/** Kit's Quick workflow task (no People sidecar: a legacy task), planned and waiting for the owner's decision on the plan. */
async function planWaiting(h: Harness) {
  const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const workspaceId = String(h.db.get(`DEVTASK#${taskId}`, "META")?.workspaceId);
  await h.finish(workspaceId, String(operations(h, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const plan = "# Plan\n\n1. Fix retry handling.\n";
  await finishPlanningWithMarkdown(h, workspaceId, String(operations(h, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
  const revision = (h.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { revision: number } }).workflow.revision;
  return { taskId, workspaceId, revision, digest: createHash("sha256").update(plan).digest("hex") };
}

describe("requireProjectWorkRole: the one gate", () => {
  const task = { project: "payments" };
  const actor = (orgRole: "member" | "admin" = "member") => ({ developerId: KIT.developerId, orgId: TEST_ORG, orgRole });
  const rows = (item?: Record<string, unknown>) => ({ send: async () => ({ Item: item }) });
  const failing = { send: async () => { throw new Error("DynamoDB is down"); } };
  const deps = (checkAccess: () => Promise<unknown>, documentClient: { send(command: unknown): Promise<unknown> } = rows()) =>
    ({ checkAccess, documentClient, tableName: "state" }) as never;
  const access = (granted: "granted" | "channel", role: ProjectRole) => async () => ({ revision: 1, policy: {}, access: granted, channelIds: [], role });
  const refuse = (code: string) => { const error = Object.assign(new Error(code), { code }); return async () => { throw error; }; };
  const grantRow = (role: "viewer" | "developer", projectRole: ProjectRole) => ({ role, projectRole });

  it("refuses an actor who holds a grant that cannot start tasks, with the viewer message", async () => {
    await expect(requireProjectWorkRole(deps(access("granted", "viewer")), task, actor())).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
  });

  it("allows a maintainer, a contributor, and an actor with no grant (the share design is unchanged)", async () => {
    for (const role of ["maintainer", "contributor"] as const) await expect(requireProjectWorkRole(deps(access("granted", role)), task, actor())).resolves.toBeUndefined();
    await expect(requireProjectWorkRole(deps(access("channel", "contributor")), task, actor())).resolves.toBeUndefined();
    await expect(requireProjectWorkRole(deps(access("channel", "viewer")), task, actor())).resolves.toBeUndefined();
  });

  it("when the project check throws (tasks turned off, a transient error), reads the actor's grant and org role directly: a viewer is refused", async () => {
    for (const code of ["PROJECT_TASKS_DISABLED", "SLACK_UNAVAILABLE", "PROJECT_ACCESS_DENIED"]) {
      await expect(requireProjectWorkRole(deps(refuse(code), rows(grantRow("viewer", "viewer"))), task, actor()), code).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    }
  });

  it("when the project check throws, a contributor, a maintainer, an old grant, an org admin with a stray viewer row and a grantless actor keep today's behaviour", async () => {
    for (const item of [grantRow("developer", "contributor"), grantRow("developer", "maintainer"), { role: "developer" }, undefined]) {
      await expect(requireProjectWorkRole(deps(refuse("PROJECT_TASKS_DISABLED"), rows(item)), task, actor())).resolves.toBeUndefined();
    }
    await expect(requireProjectWorkRole(deps(refuse("PROJECT_TASKS_DISABLED"), rows(grantRow("viewer", "viewer"))), task, actor("admin"))).resolves.toBeUndefined();
  });

  it("refuses when the fallback read fails too: the gate never fails open", async () => {
    await expect(requireProjectWorkRole(deps(refuse("SLACK_UNAVAILABLE"), failing), task, actor())).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("an owner lowered to viewer on a task with no People sidecar", () => {
  it("cannot approve the plan: nothing changes and nothing is dispatched; a contributor's approval works", async () => {
    const h = await withKit();
    const { taskId, workspaceId, revision, digest } = await planWaiting(h);
    expect(h.db.get(`DEVTASK#${taskId}`, "PEOPLE")).toBeUndefined();
    const before = JSON.stringify(h.db.get(`DEVTASK#${taskId}`, "META"));
    const dispatchedBefore = operations(h, workspaceId).length;
    setGrant(h.db, KIT, "viewer");
    const decision = { requestId: randomUUID(), expectedRevision: revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest };
    const refused = await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, decision);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    expect(JSON.stringify(h.db.get(`DEVTASK#${taskId}`, "META"))).toBe(before);
    expect(operations(h, workspaceId)).toHaveLength(dispatchedBefore);
    // The same request from the owner once they are a contributor again goes through and starts the implementation.
    setGrant(h.db, KIT, "contributor");
    expect((await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, decision)).status).toBe(200);
    expect(operations(h, workspaceId).some((item) => item.workflowMode === "IMPLEMENT")).toBe(true);
  });

  it("cannot resolve findings (FIX), decide PR feedback, retry a publication, keep pull requests, open a pull request or share", async () => {
    const h = await withKit();
    const { taskId } = await planWaiting(h);
    const before = JSON.stringify(h.db.get(`DEVTASK#${taskId}`, "META"));
    setGrant(h.db, KIT, "viewer");
    const post = (path: string, body: unknown) => h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/${path}`, body);
    const findings = { requestId: randomUUID(), expectedRevision: 1, candidateDigest: "a".repeat(64), resolutions: [{ findingId: "b".repeat(64), action: "FIX", note: "" }] };
    const attempts: Array<[string, unknown]> = [
      ["workflow/review-findings", findings],
      ["workflow/feedback-decision", { requestId: randomUUID(), expectedRevision: 1, reviewDigest: "a".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: ["c".repeat(64)], decision: "APPROVE", selectedFindingIds: ["finding-1"] }],
      ["workflow/feedback-retry", { reviewDigest: "a".repeat(64) }],
      ["workflow/publish-retry", { requestId: randomUUID(), expectedRevision: 1 }],
      ["workflow/keep-pull-requests", { requestId: randomUUID(), expectedRevision: 1 }],
      ["pull-requests", { requestId: randomUUID(), title: "Fix", repository: "demo" }],
      ["share", { requestId: randomUUID(), shareMode: "view" }],
    ];
    for (const [path, body] of attempts) {
      const refused = await post(path, body);
      expect(refused.status, path).toBe(403);
      expect(refused.body.error, path).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    }
    expect(JSON.stringify(h.db.get(`DEVTASK#${taskId}`, "META"))).toBe(before);
    // Looking and cancelling stay open.
    expect((await h.dev(KIT, "GET", `/v1/dev/tasks/${taskId}`)).status).toBe(200);
    expect((await post("cancel", { requestId: randomUUID() })).status).toBe(200);
  });

  it("is refused the task page's ask, and posts no comment with it", async () => {
    const h = await withKit();
    const { taskId } = await planWaiting(h);
    setGrant(h.db, KIT, "viewer");
    const { createPageComment } = await import("../../packages/broker/src/aws/developer-tasks.js");
    const routeDeps = (await import("../../packages/broker/src/aws/developer-routes.js")).developerTaskRouteDependencies;
    const caller = { developerId: KIT.developerId, sessionId: KIT.sessionId, amr: KIT.provider, name: KIT.name, orgId: TEST_ORG, orgRole: "member" as const };
    const deps = routeDeps({ documentClient: h.db, tableName: "state", developer: h.brokerInput.developer as never, now: Date.now, tasks: h.actions }, caller);
    await expect(createPageComment(deps, caller, taskId, { text: "What does step 1 do?", ask: true, anchor: { document: "plan" } } as never)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    expect(h.db.find((item) => item.pk === `DEVTASK#${taskId}` && String(item.sk).startsWith("COMMENT#"))).toHaveLength(0);
  });

  it("gets no dispatch: the guard parks the operation, and a raised owner can resume it", async () => {
    const h = await withKit();
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as never;
    const workspaceId = String((task as { workspaceId: string }).workspaceId);
    expect(h.db.get(`DEVTASK#${taskId}`, "PEOPLE")).toBeUndefined();
    const record = h.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === workspaceId)[0] as never;
    const outboxId = (record as { id: string }).id;
    const deps = { documentClient: h.db, tableName: "state", orgId: TEST_ORG, now: () => Date.now() } as never;
    // A contributor owner is allowed (a task with no People sidecar).
    expect(await guardTaskDispatch(deps, record)).toBe("ALLOWED");
    setGrant(h.db, KIT, "viewer");
    expect(await guardTaskDispatch(deps, record)).toBe("PARKED");
    expect(h.db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_TASK_ACCESS" });
    // Raised again, the owner resumes the one parked operation, which goes back to PENDING and is allowed.
    setGrant(h.db, KIT, "contributor");
    const current = h.db.get(`DEVTASK#${taskId}`, "META") as never;
    expect(await resumeTaskDispatch(deps, { task: current, peopleRevision: 0, actorId: `owner-${taskId}`, requestId: randomUUID(), payloadHash: "p" })).toBe(true);
    expect(h.db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "PENDING" });
    expect(await guardTaskDispatch(deps, record)).toBe("ALLOWED");
  });

  it("does not park a close or a cancel: cleanup is independent of the role", async () => {
    const h = await withKit();
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const workspaceId = String(h.db.get(`DEVTASK#${(started.body.task as { taskId: string }).taskId}`, "META")?.workspaceId);
    setGrant(h.db, KIT, "viewer");
    const deps = { documentClient: h.db, tableName: "state", orgId: TEST_ORG, now: () => Date.now() } as never;
    const record = h.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === workspaceId)[0]!;
    for (const kind of ["close", "cancel"]) {
      expect(await guardTaskDispatch(deps, { ...record, invocation: { ...(record.invocation as object), kind } } as never)).toBe("ALLOWED");
    }
  });
});

describe("the Slack service routes that change a project or start work refuse a project viewer", () => {
  const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000501`;
  const asSlackPerson = (h: Harness, slackUserId: string, role?: ProjectRole) => {
    const developerId = developerIdForSlackUser(slackUserId);
    seedMembership(h.db, developerId, { orgId: TEST_ORG, role: "member" });
    if (role !== undefined) setGrant(h.db, { ...KIT, developerId }, role);
  };

  it("PUT /v1/project/model, SWE-bench run and batch starts, preparing the thread workspace and both pull request routes", async () => {
    const h = await withKit();
    asSlackPerson(h, "U0VIEWERSL1", "viewer");
    asSlackPerson(h, "U0CONTRIBSL1", "contributor");
    const created = await ensureWorkspace(h.handler, thread, "U0MAYA001");
    expect(created.status).toBe(200);
    const workspaceId = String(created.body.workspaceId);
    const calls: Array<[string, string, string, unknown]> = [
      ["PUT", "/v1/service/project/model", "model", { provider: "openai", modelId: "gpt-5" }],
      ["POST", "/v1/service/evals/swebench", "swebench run", {}],
      ["POST", "/v1/service/evals/batches", "swebench batch", {}],
      ["POST", "/v1/service/threads/workspace/prepare", "prepare", { requestId: randomUUID() }],
      ["POST", `/v1/service/workspaces/${workspaceId}/pull-requests`, "pull request", { requestId: randomUUID(), repository: "demo", title: "Fix" }],
      ["POST", `/v1/service/workspaces/${workspaceId}/connectors/github/call`, "connector call", { tool: "x", arguments: {} }],
      ["POST", `/v1/service/workspaces/${workspaceId}/pull-request-actions`, "pull request action", { requestId: randomUUID(), repository: "demo", pullRequestNumber: 1, action: "sync" }],
    ];
    for (const [method, path, label, body] of calls) {
      const refused = await serviceCall(h.handler, thread, "U0VIEWERSL1", method, path, body);
      expect(refused.status, `${label} ${JSON.stringify(refused.body)}`).toBe(403);
      expect(refused.body.error, label).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    }
    // Others are not refused for their role (their request may fail for other reasons, such as an unapproved model).
    for (const [method, path, label, body] of calls) {
      const answered = await serviceCall(h.handler, thread, "U0CONTRIBSL1", method, path, body);
      expect(answered.body.error ?? {}, label).not.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    }
  });
});

describe("round 4: the org role, a disabled project, the pre-checks and resuming a plain task", () => {
  const startWorkflowTask = async (h: Harness) => {
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const workspaceId = String(h.db.get(`DEVTASK#${taskId}`, "META")?.workspaceId);
    return { taskId, workspaceId, record: h.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === workspaceId)[0] as never };
  };
  const guardDeps = (h: Harness) => ({ documentClient: h.db, tableName: "state", orgId: TEST_ORG, now: () => Date.now() }) as never;

  it("PROBE A: an org owner or admin with a stray viewer row is never parked by the dispatch guard (they maintain every project); a plain viewer still is", async () => {
    for (const orgRole of ["member", "admin", "owner"] as const) {
      const h = await withKit();
      const { record } = await startWorkflowTask(h);
      setGrant(h.db, KIT, "viewer");
      seedMembership(h.db, KIT.developerId, { orgId: TEST_ORG, role: orgRole });
      expect(await guardTaskDispatch(guardDeps(h), record), orgRole).toBe(orgRole === "member" ? "PARKED" : "ALLOWED");
    }
  });

  it("PROBE B: when the project turns off tasks from AI tools, a lowered owner still cannot approve the plan; a contributor owner still can", async () => {
    const h = await withKit();
    const first = await planWaiting(h);
    const decision = (taskId: string, revision: number, digest: string) => ({ requestId: randomUUID(), expectedRevision: revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest });
    await registerRevision(h.handler, 2, { enabled: false, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true });
    setGrant(h.db, KIT, "viewer");
    const before = JSON.stringify(h.db.get(`DEVTASK#${first.taskId}`, "META"));
    const refused = await h.dev(KIT, "POST", `/v1/dev/tasks/${first.taskId}/workflow/decision`, decision(first.taskId, first.revision, first.digest));
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    expect(JSON.stringify(h.db.get(`DEVTASK#${first.taskId}`, "META"))).toBe(before);
    // A contributor on the same project keeps today's behaviour (the decision is not blocked by the gate).
    setGrant(h.db, KIT, "contributor");
    const allowed = await h.dev(KIT, "POST", `/v1/dev/tasks/${first.taskId}/workflow/decision`, decision(first.taskId, first.revision, first.digest));
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  it("the task page does not offer decide or ask to an owner lowered to viewer, and still does to a contributor", async () => {
    const h = await withKit();
    const { taskId } = await planWaiting(h);
    const { getTaskPageState } = await import("../../packages/broker/src/aws/developer-tasks.js");
    const routeDeps = (await import("../../packages/broker/src/aws/developer-routes.js")).developerTaskRouteDependencies;
    const caller = { developerId: KIT.developerId, sessionId: KIT.sessionId, amr: KIT.provider, name: KIT.name, orgId: TEST_ORG, orgRole: "member" as const };
    const state = () => getTaskPageState(routeDeps({ documentClient: h.db, tableName: "state", developer: h.brokerInput.developer as never, now: Date.now, tasks: h.actions }, caller), caller, taskId);
    expect(await state()).toMatchObject({ canDecide: true });
    setGrant(h.db, KIT, "viewer");
    expect(await state()).toMatchObject({ canRead: true, canDecide: false, canAsk: false });
  });

  it("pageAccess offers decide and ask only where work is allowed (commenting is unaffected)", () => {
    const open = { task: { closedAt: undefined, workflow: undefined } as never, role: "owner" as const, ownerActorIds: [] };
    expect(pageAccess(open)).toMatchObject({ canComment: true, canDecide: true, canAsk: true });
    expect(pageAccess(open, false)).toEqual({ role: "owner", canComment: true, canSuggest: false, canDecide: false, canAsk: false });
  });

  it("the Slack pre-check does not authorize decide, retry, publish or feedback for a lowered owner, and still authorizes stop and close", async () => {
    const h = await withKit();
    const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000601" };
    const owner = "U0SLACKOWN1";
    const developerId = developerIdForSlackUser(owner);
    seedMembership(h.db, developerId, { orgId: TEST_ORG, role: "member" });
    setGrant(h.db, { ...KIT, developerId }, "contributor");
    const started = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: owner, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    const authorize = async (taskAction: string) => (await h.handler({ source: "agentx.slack-ingress", action: "task-people-authorize", taskAction, taskId, userId: owner, thread })).statusCode;
    for (const action of ["decide", "retry", "publish", "feedback"]) expect(await authorize(action), action).toBe(200);
    setGrant(h.db, { ...KIT, developerId }, "viewer");
    for (const action of ["decide", "retry", "publish", "feedback"]) expect(await authorize(action), action).toBe(403);
    for (const action of ["close", "control"]) expect(await authorize(action), action).toBe(200);
  });

  it("canvas closeout retry is a step of close, which a lowered owner may still do: it is not refused as new work", async () => {
    const h = await withKit();
    const { taskId } = await planWaiting(h);
    setGrant(h.db, KIT, "viewer");
    const answer = await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/canvas-closeout/retry`, { requestId: randomUUID(), workflowRevision: 1 });
    expect((answer.body.error as { code?: string } | undefined)?.code).not.toBe("PROJECT_ACCESS_DENIED");
  });

  it("a parked plain task (no workflow) resumes when its creator is a contributor again, instead of only being cancellable", async () => {
    const h = await withKit();
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as unknown as { workspaceId: string; workflow?: unknown };
    expect(task.workflow).toBeUndefined();
    const record = h.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === task.workspaceId)[0] as never;
    const outboxId = (record as { id: string }).id;
    setGrant(h.db, KIT, "viewer");
    expect(await guardTaskDispatch(guardDeps(h), record)).toBe("PARKED");
    // A viewer owner cannot continue it; once raised, continue brings the parked operation back instead of reporting the task busy.
    expect((await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "Go on" })).status).toBe(403);
    setGrant(h.db, KIT, "contributor");
    const resumed = await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "Go on" });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(h.db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "PENDING" });
  });

  // Task 22, folded in from the Task 21 re-check: a continue that resumes a parked plain task runs the ORIGINAL instructions (the parked operation is
  // redriven as it was; rewriting its stored invocation is not safe). The new instructions are not used, and the person is told so in the task's own
  // events, which every client (the app, the CLI, an AI tool) already shows, rather than in a field some of them drop.
  it("a continue that resumes a parked plain task says, in the task's events, that it resumed with the original instructions", async () => {
    const h = await withKit();
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as unknown as { workspaceId: string };
    const record = h.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === task.workspaceId)[0] as never;
    setGrant(h.db, KIT, "viewer");
    expect(await guardTaskDispatch(guardDeps(h), record)).toBe("PARKED");
    setGrant(h.db, KIT, "contributor");
    const requestId = randomUUID();
    const resumed = await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId, instructions: "Actually, also fix the timeout" });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    const events = (resumed.body.task as { events: Array<{ kind: string; text: string }> }).events;
    expect(events).toContainEqual({ at: expect.any(String) as string, kind: "progress", text: RESUMED_ORIGINAL });
    // A repeat of the same request adds the note once.
    await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId, instructions: "Actually, also fix the timeout" });
    const stored = h.db.find((item) => item.entityType === "EVENT" && JSON.stringify(item.payload).includes("original instructions"));
    expect(stored).toHaveLength(1);
  });

  it("a continue that finds nothing parked says nothing about original instructions", async () => {
    const h = await withKit();
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as unknown as { workspaceId: string };
    const prepareId = String((h.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await h.finish(task.workspaceId, prepareId, "SUCCEEDED", PREPARED);
    const taskOperation = String((h.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await h.finish(task.workspaceId, taskOperation, "SUCCEEDED");
    const next = await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "Go on" });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(JSON.stringify(next.body)).not.toContain("original instructions");
  });
});
