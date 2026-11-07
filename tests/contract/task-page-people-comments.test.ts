// OWNER DECISION 7 item 9: what the old review page did for a task's People and comments, on the task page in Rovara, through the same server functions:
//   GET /v1/app/tasks/{id}/people, POST .../people/role, POST .../people/take-ownership   the task's `/v1/dev` People route (Slack's flow and the MCP tool): the same view, the same pending change and its
//                                                                                          confirmation page, the same refusals;
//   GET /v1/app/tasks/{id}/comments, POST .../comments/{commentId}/remember|forget         the old page's own comment list and `rememberTaskComment` / `forgetTaskComment`, from a live browser only.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TaskPeopleDisplayReadRequest } from "@agentx/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { TASK_COMMENT_LEARNING_BROWSER_MESSAGE } from "../../packages/broker/src/aws/developer-routes/task-page-actions.js";
import { commentKey } from "../../packages/broker/src/developer/page-comments.js";
import { browserRequests } from "../support/browser-session.js";
import { createDeveloperTaskBroker, type Developer } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { seedGrant, seedProject } from "../support/learning-page.js";

const CREATOR_SLACK = "U0TPPPL001", LEE_SLACK = "U0TPPPL002";
const CREATOR: Developer = { developerId: developerIdForSlackUser(CREATOR_SLACK), name: "Maya Chen", provider: "slack", sessionId: "s-tp-creator", slackUserId: CREATOR_SLACK };
const LEE: Developer = { developerId: developerIdForSlackUser(LEE_SLACK), name: "Lee Park", provider: "slack", sessionId: "s-tp-lee", slackUserId: LEE_SLACK };
const OUTSIDER: Developer = { developerId: "e".repeat(64), name: "Out Sider", provider: "slack", sessionId: "s-tp-out", slackUserId: "U0TPOUT001" };

/** A Slack-started task with a People list (the creator owns it; Lee is in the channel), as the old page's People tests start one. */
async function slackTask() {
  const name = (id: string) => (id === CREATOR_SLACK ? CREATOR.name : "Lee Park");
  const harness = await createDeveloperTaskBroker({
    channelMembers: async (input) => ({ ok: true, memberOf: [CREATOR_SLACK, LEE_SLACK].includes(input.slackUserId) ? input.channelIds : [] }),
    developerExtra: {
      taskPeopleConfiguration: { peopleChangesEnabled: true },
      taskPersonProof: async (input) => ({ ok: true, user: { id: input.slackUserId, teamId: SLACK_TEAM, name: name(input.slackUserId) }, memberOf: input.channelIds }),
      taskPeopleDisplayRead: async (input: TaskPeopleDisplayReadRequest) => input.operation === "proof"
        ? { operation: "proof" as const, admission: { version: 1 as const, slackCallsUsed: 1 }, result: { ok: true as const, user: { id: input.request.slackUserId, teamId: SLACK_TEAM, name: name(input.request.slackUserId) }, memberOf: input.request.channelIds } }
        : { operation: "directory" as const, admission: { version: 1 as const, slackCallsUsed: 1 }, result: { ok: true as const,
          users: [CREATOR_SLACK, LEE_SLACK].map((id) => ({ id, teamId: SLACK_TEAM, name: name(id), memberOf: input.request.channelIds })) } },
    },
  });
  for (const who of [CREATOR, LEE]) {
    harness.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, slackUserId: who.slackUserId, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    harness.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  }
  const started = await harness.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000099" }, userId: CREATOR_SLACK,
    instructions: "Exercise People on the task page", workflowPath: "QUICK", requestId: randomUUID() });
  expect(started.statusCode).toBe(200);
  const taskId = (JSON.parse(started.body) as { taskId: string }).taskId;
  return { harness, taskId, web: browserRequests(harness) };
}

describe("People on the task page (OWNER DECISION 7)", () => {
  it("reads the People list as the /v1/dev route does, and proposes a role change as a pending change confirmed on its confirmation page", async () => {
    const t = await slackTask();
    const viaApp = await t.web(CREATOR, "GET", `/v1/app/tasks/${t.taskId}/people`);
    const viaDev = await t.harness.dev(CREATOR, "GET", `/v1/dev/tasks/${t.taskId}/people`);
    expect(viaApp.status, JSON.stringify(viaApp.body)).toBe(200);
    expect(viaApp.body.view).toEqual(viaDev.body.view);
    const view = viaApp.body.view as { revision: number; people: Array<{ personId: string; name: string }>; canManage: boolean };
    expect(view.canManage).toBe(true);
    const lee = view.people.find((person) => person.name === "Lee Park")!;
    const requestId = randomUUID();
    const before = t.harness.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT").length;
    const proposed = await t.web(CREATOR, "POST", `/v1/app/tasks/${t.taskId}/people/role`, { requestId, expectedPeopleRevision: view.revision, personId: lee.personId, role: "viewer" });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    expect(proposed.body.change).toMatchObject({ status: "PENDING", confirmationUrl: expect.stringContaining(`/review/${t.taskId}/task/people/confirm/${requestId}`) as unknown });
    // Nothing changes until the person confirms on that page.
    expect(t.harness.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")).toHaveLength(before);
    // A stale revision is refused, as from Slack.
    const stale = await t.web(CREATOR, "POST", `/v1/app/tasks/${t.taskId}/people/role`, { requestId: randomUUID(), expectedPeopleRevision: view.revision + 5, personId: lee.personId, role: "viewer" });
    expect(stale.body.change ?? stale.body.error).not.toMatchObject({ status: "PENDING" });
    // A body that names anyone or anything else is refused by the route's own strict schema.
    expect((await t.web(CREATOR, "POST", `/v1/app/tasks/${t.taskId}/people/role`, { requestId: randomUUID(), expectedPeopleRevision: view.revision, personId: lee.personId, role: "viewer", actorId: "x" })).status).toBe(400);
  });

  it("refuses a person who may not manage People as the /v1/dev route does, and answers another company exactly as a missing task", async () => {
    const t = await slackTask();
    const view = (await t.web(CREATOR, "GET", `/v1/app/tasks/${t.taskId}/people`)).body.view as { revision: number; people: Array<{ personId: string; name: string }> };
    const creator = view.people.find((person) => person.name === CREATOR.name)!;
    const byLee = await t.web(LEE, "POST", `/v1/app/tasks/${t.taskId}/people/role`, { requestId: randomUUID(), expectedPeopleRevision: view.revision, personId: creator.personId, role: "viewer" });
    const devLee = await t.harness.dev(LEE, "POST", `/v1/dev/tasks/${t.taskId}/people/role`, { requestId: randomUUID(), expectedPeopleRevision: view.revision, personId: creator.personId, role: "viewer" });
    // The same answer the /v1/dev route gives: never a pending change.
    expect(byLee.status, JSON.stringify([byLee.body, devLee.body])).toBe(devLee.status);
    expect((byLee.body.change as { status?: string } | undefined)?.status).not.toBe("PENDING");
    await t.harness.orgOf({ ...OUTSIDER });
    const outsider = await t.web({ ...OUTSIDER }, "GET", `/v1/app/tasks/${t.taskId}/people`);
    const missing = await t.web({ ...OUTSIDER }, "GET", `/v1/app/tasks/${randomUUID()}/people`);
    t.harness.db.set({ pk: `SESSION#${OUTSIDER.sessionId}`, sk: "META", sessionId: OUTSIDER.sessionId, developerId: OUTSIDER.developerId, amr: OUTSIDER.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    const outsiderDev = await t.harness.dev({ ...OUTSIDER }, "GET", `/v1/dev/tasks/${t.taskId}/people`);
    // SECURITY (OWNER DECISION 17): another company's person gets exactly the answer a missing task gets, on the /v1/dev route and on the task page's.
    const missingDev = await t.harness.dev({ ...OUTSIDER }, "GET", `/v1/dev/tasks/${randomUUID()}/people`);
    expect(outsiderDev.status).toBe(missingDev.status);
    expect(outsiderDev.body.error).toEqual(missingDev.body.error);
    expect(outsider.status).toBe(missing.status);
    expect(outsider.body.error).toEqual(missing.body.error);
    expect(outsider.status).toBe(outsiderDev.status);
    for (const [write, extra] of [["role", { personId: randomUUID(), role: "viewer" }], ["take-ownership", {}]] as const) {
      const real = await t.harness.dev({ ...OUTSIDER }, "POST", `/v1/dev/tasks/${t.taskId}/people/${write}`, { requestId: randomUUID(), expectedPeopleRevision: 1, ...extra });
      const none = await t.harness.dev({ ...OUTSIDER }, "POST", `/v1/dev/tasks/${randomUUID()}/people/${write}`, { requestId: randomUUID(), expectedPeopleRevision: 1, ...extra });
      expect([real.status, real.body.error], write).toEqual([none.status, none.body.error]);
    }
    expect(JSON.stringify(outsider.body)).not.toContain("Lee Park");
  });
});

describe("Remember and Forget on a comment, on the task page (OWNER DECISION 7)", () => {
  /** A person's comment on the task's current document, as the old review page stored it. */
  const seed = (t: Awaited<ReturnType<typeof slackTask>>, who: Developer, text: string) => {
    const commentId = randomUUID();
    t.harness.db.set({ ...commentKey(t.taskId, commentId), entityType: "TASK_COMMENT", schemaVersion: 1, taskId: t.taskId, commentId, document: "plan", version: 1, target: { kind: "document" },
      author: { kind: "person", developerId: who.developerId, slackUserId: who.slackUserId, name: who.name, owner: who === CREATOR }, text, createdAt: new Date().toISOString(), rev: 1 });
    return commentId;
  };

  it("lists the comments by the old page's own rule, and refuses Remember from a token, a body that says anything, and someone who may not read the task", async () => {
    const t = await slackTask();
    const commentId = seed(t, LEE, "Use the shared retry helper.");
    const listed = await t.web(CREATOR, "GET", `/v1/app/tasks/${t.taskId}/comments`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect((listed.body.comments as Array<{ id: string; text: string }>).map((comment) => [comment.id, comment.text])).toEqual([[commentId, "Use the shared retry helper."]]);
    const token = await t.harness.dev(CREATOR, "POST", `/v1/app/tasks/${t.taskId}/comments/${commentId}/remember`, {});
    expect(token.status).toBe(403);
    expect(JSON.stringify(token.body)).toContain(TASK_COMMENT_LEARNING_BROWSER_MESSAGE);
    expect((await t.web(CREATOR, "POST", `/v1/app/tasks/${t.taskId}/comments/${commentId}/remember`, { standing: "member" })).status).toBe(400);
    await t.harness.orgOf({ ...OUTSIDER });
    const outsider = await t.web({ ...OUTSIDER }, "POST", `/v1/app/tasks/${t.taskId}/comments/${commentId}/remember`, {});
    expect(outsider.status).toBeGreaterThanOrEqual(400);
    expect((await t.web({ ...OUTSIDER }, "GET", `/v1/app/tasks/${t.taskId}/comments`)).status).toBeGreaterThanOrEqual(400);
    expect(t.harness.db.find((item) => String(item.pk).startsWith("PROJECT_LEARNING#") || item.entityType === "LEARNING_SOURCE")).toEqual([]);
  });

  it("Remember and Forget reach the old page's own functions: a person with standing remembers and forgets, and the list says so", async () => {
    const t = await slackTask();
    const project = String((t.harness.db.get(`DEVTASK#${t.taskId}`, "META") as { project: string }).project);
    seedProject(t.harness.db, project);
    seedGrant(t.harness.db, { orgId: TEST_ORG, developerId: CREATOR.developerId } as never, "contributor", project);
    const commentId = seed(t, LEE, "Use the shared retry helper.");
    const remembered = await t.web(CREATOR, "POST", `/v1/app/tasks/${t.taskId}/comments/${commentId}/remember`, {});
    expect(remembered.status, JSON.stringify(remembered.body)).toBe(200);
    expect(remembered.body).toMatchObject({ correction: expect.objectContaining({ id: expect.any(String) as unknown }) as unknown });
    const after = await t.web(CREATOR, "GET", `/v1/app/tasks/${t.taskId}/comments`);
    expect(after.body.canRemember).toBe(true);
    expect((after.body.comments as Array<{ id: string; learning?: { remembered: boolean } }>).find((comment) => comment.id === commentId)?.learning?.remembered).toBe(true);
    const forgotten = await t.web(CREATOR, "POST", `/v1/app/tasks/${t.taskId}/comments/${commentId}/forget`, {});
    expect(forgotten.status, JSON.stringify(forgotten.body)).toBe(200);
    const gone = await t.web(CREATOR, "GET", `/v1/app/tasks/${t.taskId}/comments`);
    expect((gone.body.comments as Array<{ id: string; learning?: { remembered: boolean } }>).find((comment) => comment.id === commentId)?.learning?.remembered).toBe(false);
    // Lee, a commenter on the task with no standing in the project, is refused by the same rule.
    expect((await t.web(LEE, "POST", `/v1/app/tasks/${t.taskId}/comments/${commentId}/remember`, {})).status).toBeGreaterThanOrEqual(400);
  });
});
