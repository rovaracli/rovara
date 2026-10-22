// Plan 2, Task 21, fix round 3: one gate for "viewers only view". A person who holds a project grant that cannot start tasks (a viewer) can
// look at a task and cancel it, but every action that changes it or starts work is refused with the viewer message, on every surface, and no
// dispatch for a viewer's task starts, tasks without a People sidecar included. People with no grant keep the share design.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectMemberKey, type ProjectRole } from "../../packages/contracts/src/index.js";
import { guardTaskDispatch, resumeTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { requireProjectWorkRole } from "../../packages/broker/src/developer/task-access.js";
import { createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace, serviceCall } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
const KIT: Developer = { developerId: "4".repeat(64), name: "Kit Alvarez", provider: "oidc", sessionId: "s-kit" };
const VIEWER_MESSAGE = "You can view `payments` but not start tasks in it. Ask a maintainer to make you a contributor.";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };

function setGrant(db: FakeDynamoDb, who: Developer, role: ProjectRole): void {
  db.set({ ...projectMemberKey(TEST_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", grantId: randomUUID(),
    role: role === "viewer" ? "viewer" : "developer", projectRole: role });
}

async function withKit(): Promise<Harness> {
  const h = await createDeveloperTaskBroker();
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
  const access = (access: "granted" | "channel", role: ProjectRole) => ({ checkAccess: async () => ({ revision: 1, policy: {} as never, access, channelIds: [], role }) });

  it("refuses an actor who holds a grant that cannot start tasks, with the viewer message", async () => {
    await expect(requireProjectWorkRole(access("granted", "viewer"), task)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
  });

  it("allows a maintainer, a contributor, and an actor with no grant (the share design is unchanged)", async () => {
    for (const role of ["maintainer", "contributor"] as const) await expect(requireProjectWorkRole(access("granted", role), task)).resolves.toBeUndefined();
    await expect(requireProjectWorkRole(access("channel", "contributor"), task)).resolves.toBeUndefined();
    // Even if the channel role were a viewer (it never is), no grant means no refusal here.
    await expect(requireProjectWorkRole(access("channel", "viewer"), task)).resolves.toBeUndefined();
  });

  it("leaves things as they were when the project check cannot be made", async () => {
    await expect(requireProjectWorkRole({ checkAccess: async () => { throw new Error("unavailable"); } }, task)).resolves.toBeUndefined();
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
