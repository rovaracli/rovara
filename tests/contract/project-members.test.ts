// Plan 2, Task 21: people in a project. A person is a maintainer, contributor or viewer of a project; an org owner or admin maintains every
// project in their org without a grant. This covers the grant item's shapes (new and the two old ones), the member routes (list, set a
// role, remove), the viewer's refusal to start a task, `ProjectMembers` (what Plan 3 imports) and every cross-org case.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ProjectMemberChangeResponseSchema, ProjectMembersResponseSchema, orgMemberKey, orgMetaKey, orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey,
  type OrgId, type OrgRole, type ProjectRole,
} from "../../packages/contracts/src/index.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { projectMembersOf, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { forgetResolvedNames } from "../../packages/broker/src/developer/name-resolver.js";
import { createProjectMembers, type ProjectMembers } from "../../packages/broker/src/org/project-members.js";
import { MAYA, OMAR, createDeveloperTaskBroker, grantProject, seedMembership, type Developer } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace, serviceCall } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;

// The broker module reads its environment when first imported, so it is imported after a harness has set that up.
const brokerModule = async () => await import("../../packages/broker/src/aws/broker.js") as unknown as {
  workflowE2ECreatorAuthorityProof: (...input: unknown[]) => Promise<unknown>;
  registerProjectFor: (...input: unknown[]) => Promise<{ duplicate: boolean }>;
  requireWorkflowE2ECreatorAuthority: (...input: unknown[]) => Promise<Record<string, unknown>>;
  requireProjectAuthority: (...input: unknown[]) => Promise<Record<string, unknown>>;
};

const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const person = (letter: string, name: string): Developer => ({ developerId: letter.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const PRIYA = person("1", "Priya Raman");
const SAM = person("2", "Sam Okoye");
const LENA = person("3", "Lena Fischer");
const KIT = person("4", "Kit Alvarez");
const NEO = person("5", "Neo Tanaka");
const ZED = person("6", "Zed Moreau");
const emailOf = (who: Developer) => `${who.name.split(" ")[0]!.toLowerCase()}@example.com`;
const VIEWER_MESSAGE = "You can view `payments` but not start tasks in it. Ask a maintainer to make you a contributor.";
const NOT_IN_ORG = "that person isn't in your organization";
const OWNERS_MAINTAIN = "owners and admins already maintain every project";
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;

/** A project written the way registration writes it (revision and catalog entry), in any org. */
function seedProject(db: FakeDynamoDb, orgId: OrgId, name: string, status?: "archived"): void {
  db.set({
    ...projectRevisionKey(orgId, name, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: {
      name, revision: 1,
      repositories: [{ name: "web", url: `https://github.com/acme/${name}.git`, path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
    },
  });
  db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  if (status === "archived") {
    db.set({ ...projectMetaKey(orgId, name), entityType: "PROJECT_META", name, status, createdAt: "x", createdBy: "y", archivedAt: "z", archivedBy: "y" });
  }
}

/** Puts a person in the org (a sign-in does this): session, developer record with an email, and the member record with the given org role. */
async function admit(h: Harness, who: Developer, orgRole: OrgRole = "member", orgId: OrgId = TEST_ORG): Promise<Developer> {
  await h.orgOf(who);
  h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, email: emailOf(who), firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  seedMembership(h.db, who.developerId, { orgId, role: orgRole });
  return who;
}

/** A project grant written the way this task writes one. */
function grantRole(db: FakeDynamoDb, who: Developer, role: ProjectRole, options: { by?: Developer | "system"; project?: string; orgId?: OrgId } = {}): void {
  const project = options.project ?? "payments";
  const by = options.by ?? PRIYA;
  db.set({
    ...projectMemberKey(options.orgId ?? TEST_ORG, who.developerId, project), entityType: "MEMBERSHIP", ownerKey: who.developerId, grantId: randomUUID(), projectName: project,
    role: role === "viewer" ? "viewer" : "developer", projectRole: role,
    grantedBy: by === "system" ? { system: "admin" } : { developerId: by.developerId }, grantedAt: "2026-10-05T00:00:00.000Z",
  });
}
const grantOf = (db: FakeDynamoDb, who: { developerId: string }, project = "payments", orgId: OrgId = TEST_ORG) => db.get(projectMemberKey(orgId, who.developerId, project)) as Record<string, unknown> | undefined;

/** A response's body without the request id the broker adds to every answer. */
const dataOf = (response: { body: Record<string, unknown> }) => {
  const { requestId: _requestId, ...data } = response.body;
  void _requestId;
  return data;
};
const members = (h: Harness, who: Developer, project = "payments") => h.dev(who, "GET", `/v1/app/projects/${project}/members`);
const put = (h: Harness, who: Developer, target: string | Developer, role: unknown, options: { project?: string; requestId?: string } = {}) =>
  h.dev(who, "PUT", `/v1/app/projects/${options.project ?? "payments"}/members/${typeof target === "string" ? target : target.developerId}`, { requestId: options.requestId ?? randomUUID(), role });
const remove = (h: Harness, who: Developer, target: string | Developer, options: { project?: string; requestId?: string; body?: unknown } = {}) =>
  h.dev(who, "DELETE", `/v1/app/projects/${options.project ?? "payments"}/members/${typeof target === "string" ? target : target.developerId}`, options.body ?? { requestId: options.requestId ?? randomUUID() });
const listed = (response: { body: Record<string, unknown> }) => response.body.members as Array<{ developerId: string; name: string; email?: string; role: string; source: string; grantedBy?: { developerId: string; name: string } }>;
const start = () => ({ requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });

/** The install with a maintainer (Priya), a viewer (Sam), a contributor (Kit), an org admin (Lena) and a member with no access (Neo). */
async function team(options: Parameters<typeof createDeveloperTaskBroker>[0] = {}) {
  const h = await createDeveloperTaskBroker(options);
  for (const who of [PRIYA, SAM, LENA, KIT, NEO]) await admit(h, who, who === LENA ? "admin" : "member");
  grantRole(h.db, PRIYA, "maintainer");
  grantRole(h.db, SAM, "viewer");
  grantRole(h.db, KIT, "contributor");
  return h;
}

describe("a project's people who were erased (ERASE-NAME-2)", () => {
  it("lists an erased person (the name item's tombstone, or the ledger's alone) as 'A former member', in the list and as who added someone", async () => {
    const h = await team();
    const names = async () => Object.fromEntries(listed(await members(h, PRIYA)).map((member) => [member.developerId, { name: member.name, by: member.grantedBy?.name }]));
    expect((await names())[SAM.developerId]).toEqual({ name: "Sam Okoye", by: "Priya Raman" });
    h.db.set({ pk: `DEVELOPER_NAME#${SAM.developerId}`, sk: "NAME", entityType: "DEVELOPER_NAME", developerId: SAM.developerId, erased: true, erasedAt: "2026-11-01T00:00:00.000Z" });
    process.env["AUDIT_KEYS_TABLE_NAME"] = "keys";
    h.db.set({ pk: `ORG#${TEST_ORG}`, sk: `SUBJECT#${PRIYA.developerId}`, erasedAt: "2026-09-01T00:00:00.000Z" });
    try {
      const after = await names();
      expect(after[SAM.developerId]).toEqual({ name: "A former member", by: "A former member" });
      expect(after[PRIYA.developerId]).toEqual({ name: "A former member", by: "A former member" });
      expect(after[KIT.developerId]?.name).toBe("Kit Alvarez");
    } finally {
      delete process.env["AUDIT_KEYS_TABLE_NAME"];
      forgetResolvedNames();
    }
  });
});

describe("a viewer", () => {
  it("sees the project, its detail and its settings", async () => {
    const h = await team();
    const projects = (await h.dev(SAM, "GET", "/v1/app/projects")).body.projects as Array<{ name: string; myRole: string }>;
    expect(projects).toEqual([expect.objectContaining({ name: "payments", myRole: "viewer" })]);
    const detail = await h.dev(SAM, "GET", "/v1/app/projects/payments");
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ name: "payments", myRole: "viewer", settings: expect.objectContaining({ setupCommands: [] }) as unknown });
  });

  it("cannot start a task, and is told so in the exact words", async () => {
    const h = await team();
    const refused = await h.dev(SAM, "POST", "/v1/dev/tasks", start());
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    expect(h.db.find((item) => item.entityType === "WORKSPACE")).toHaveLength(0);
  });

  it("stays a viewer even when they are also in the project's Slack channel", async () => {
    const h = await team();
    // Maya reaches payments through its Slack channel; a viewer grant on her is an explicit, narrower role.
    await admit(h, MAYA);
    grantRole(h.db, MAYA, "viewer");
    const refused = await h.dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("cannot manage members (403) and nothing is written", async () => {
    const h = await team();
    const before = grantOf(h.db, NEO);
    const refused = await put(h, SAM, NEO, "viewer");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(grantOf(h.db, NEO)).toBe(before);
    expect((await remove(h, SAM, KIT)).status).toBe(403);
    expect(grantOf(h.db, KIT)).toBeDefined();
  });

  it("can read the member list", async () => {
    const h = await team();
    const answer = await members(h, SAM);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(listed(answer).map((member) => member.developerId)).toContain(PRIYA.developerId);
  });
});

describe("a thread started in the project's Slack channel uses the person's real project role", () => {
  const thread = (n: number) => `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.00${String(n).padStart(4, "0")}`;
  /** A person who signs in with Slack: their developer id is the one their Slack user id makes, so the channel's requester maps to them. */
  const slackPerson = (h: Harness, slackUserId: string, grant?: ProjectRole | "legacy") => {
    const developerId = developerIdForSlackUser(slackUserId);
    seedMembership(h.db, developerId, { orgId: TEST_ORG, role: "member" });
    if (grant === "legacy") h.db.set({ ...projectMemberKey(TEST_ORG, developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "payments", role: "developer" });
    else if (grant !== undefined) h.db.set({ ...projectMemberKey(TEST_ORG, developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "payments", grantId: randomUUID(), role: grant === "viewer" ? "viewer" : "developer", projectRole: grant });
    return developerId;
  };

  it("refuses a viewer who is in the bound channel, with the viewer message, and creates no workspace", async () => {
    const h = await team();
    slackPerson(h, "U0VIEWER01", "viewer");
    const refused = await ensureWorkspace(h.handler, thread(1), "U0VIEWER01");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    expect(h.db.find((item) => item.entityType === "WORKSPACE")).toHaveLength(0);
  });

  it("starts a thread for a contributor, a maintainer, an org owner without a grant, and a person who has only the channel", async () => {
    const h = await team();
    slackPerson(h, "U0CONTRIB01", "contributor");
    slackPerson(h, "U0MAINT0001", "maintainer");
    slackPerson(h, "U0LEGACY001", "legacy");
    const owner = slackPerson(h, "U0OWNER0001");
    seedMembership(h.db, owner, { orgId: TEST_ORG, role: "owner" });
    for (const [n, user] of ["U0CONTRIB01", "U0MAINT0001", "U0LEGACY001", "U0OWNER0001", "U0MAYA001"].entries()) {
      const answer = await ensureWorkspace(h.handler, thread(10 + n), user);
      expect(answer.status, `${user}: ${JSON.stringify(answer.body)}`).toBe(200);
    }
  });

  it("refuses a viewer's follow-up in an existing thread (and its operations) with the viewer message, while others keep going", async () => {
    const h = await team();
    slackPerson(h, "U0VIEWER05", "viewer");
    slackPerson(h, "U0CONTRIB05", "contributor");
    const existing = thread(40);
    const created = await ensureWorkspace(h.handler, existing, "U0MAYA001");
    expect(created.status).toBe(200);
    const workspaceId = String(created.body.workspaceId);
    // The thread's workspace is the same whoever asks; the viewer is refused, and nothing is dispatched for them.
    const operations = () => h.db.find((item) => item.entityType === "OPERATION").length;
    const before = operations();
    const refused = await ensureWorkspace(h.handler, existing, "U0VIEWER05");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    const conversation = await serviceCall(h.handler, existing, "U0MAYA001", "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
    const prompt = (user: string) => serviceCall(h.handler, existing, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
      requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "do more",
    });
    const refusedTask = await prompt("U0VIEWER05");
    expect(refusedTask.status).toBe(403);
    expect(refusedTask.body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    expect(operations()).toBe(before);
    // A contributor with a grant, and a person with no grant (the channel), still follow up.
    expect((await ensureWorkspace(h.handler, existing, "U0CONTRIB05")).status).toBe(200);
    expect((await ensureWorkspace(h.handler, existing, "U0MAYA001")).status).toBe(200);
    expect([200, 202, 409]).toContain((await prompt("U0MAYA001")).status);
  });

  it("keeps a viewer's explicit grant over the channel: they are refused although the channel would make them a contributor", async () => {
    const h = await team();
    // Maya's Slack user is in the bound channel; give the developer her Slack id derives a viewer grant.
    slackPerson(h, "U0MAYA001", "viewer");
    expect((await ensureWorkspace(h.handler, thread(30), "U0MAYA001")).status).toBe(403);
  });
});

describe("a thread reply on a Slack-started task (the legacy commenter fallback)", () => {
  async function startedTask() {
    const h = await team();
    const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000021" };
    const started = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: MAYA.slackUserId, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    const note = async (userId: string, n: number) =>
      (JSON.parse((await h.handler({ source: "agentx.slack-ingress", action: "thread-note", taskId, thread, userId, messageTs: `1695500002.00000${n}`, eventId: `Ev${userId}${n}`, text: "A reply" })).body) as { outcome: string }).outcome;
    return { h, note };
  }

  it("is kept for a teammate with no project grant (the share design is unchanged)", async () => {
    const { note } = await startedTask();
    expect(await note("U0TEAMMATE1", 1)).toBe("captured");
  });

  it("is not given to a teammate who holds a viewer grant on the task's project, who may only view", async () => {
    const { h, note } = await startedTask();
    const viewerId = developerIdForSlackUser("U0VIEWER02");
    h.db.set({ ...projectMemberKey(TEST_ORG, viewerId, "payments"), entityType: "MEMBERSHIP", ownerKey: viewerId, projectName: "payments", grantId: randomUUID(), role: "viewer", projectRole: "viewer" });
    expect(await note("U0VIEWER02", 2)).toBe("refused");
    expect(h.db.find((item) => String(item.sk).startsWith("NOTE#"))).toHaveLength(0);
    // The same person with a contributor grant is a teammate again.
    h.db.set({ ...projectMemberKey(TEST_ORG, viewerId, "payments"), entityType: "MEMBERSHIP", ownerKey: viewerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "contributor" });
    expect(await note("U0VIEWER02", 3)).toBe("captured");
  });
});

describe("an owner lowered to viewer keeps their tasks to look at and cancel, but starts no new work on them", () => {
  it("is refused continue, retry, review and send-back with the viewer message, and can still read and cancel", async () => {
    const h = await team();
    const plain = String(((await h.dev(KIT, "POST", "/v1/dev/tasks", start())).body.task as { taskId: string }).taskId);
    const flow = String(((await h.dev(KIT, "POST", "/v1/dev/tasks", { ...start(), workflow: true, workflowPath: "QUICK" })).body.task as { taskId: string }).taskId);
    await put(h, PRIYA, KIT, "viewer");
    const body = () => ({ requestId: randomUUID(), instructions: "Go on" });
    for (const [label, path] of [["continue", `${plain}/continue`], ["retry", `${flow}/workflow/retry`], ["review", `${flow}/workflow/review`], ["send-back", `${flow}/workflow/send-back`]] as const) {
      const refused = await h.dev(KIT, "POST", `/v1/dev/tasks/${path}`, body());
      expect(refused.status, label).toBe(403);
      expect(refused.body.error, label).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    }
    expect((await h.dev(KIT, "GET", `/v1/dev/tasks/${plain}`)).status).toBe(200);
    expect((await h.dev(KIT, "POST", `/v1/dev/tasks/${plain}/cancel`, { requestId: randomUUID() })).status).toBe(200);
  });

  it("is not told the viewer message about someone else's task (that reads as not found), and a contributor keeps continuing", async () => {
    const h = await team();
    const mine = String(((await h.dev(KIT, "POST", "/v1/dev/tasks", start())).body.task as { taskId: string }).taskId);
    const record = h.db.get(`DEVTASK#${mine}`, "META") as unknown as { workspaceId: string };
    const active = () => String((h.db.get(`WORKSPACE#${record.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await h.finish(record.workspaceId, active(), "SUCCEEDED");
    await h.finish(record.workspaceId, active(), "SUCCEEDED");
    const theirs = await h.dev(SAM, "POST", `/v1/dev/tasks/${mine}/continue`, { requestId: randomUUID(), instructions: "Go on" });
    expect(theirs.body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect((await h.dev(KIT, "POST", `/v1/dev/tasks/${mine}/continue`, { requestId: randomUUID(), instructions: "Go on" })).status).toBe(200);
  });
});

describe("a contributor", () => {
  it("starts a task", async () => {
    const h = await team();
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", start());
    expect(started.status, JSON.stringify(started.body)).toBe(200);
  });

  it("cannot manage members: PUT is 403, and nobody gets a role (not even the caller as a maintainer)", async () => {
    const h = await team();
    for (const [target, role] of [[NEO, "contributor"], [KIT, "maintainer"], [NEO, "maintainer"]] as const) {
      const refused = await put(h, KIT, target, role);
      expect(refused.status, `${target.name} ${role}`).toBe(403);
      expect(refused.body.error).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(grantOf(h.db, NEO)).toBeUndefined();
    expect(grantOf(h.db, KIT)).toMatchObject({ role: "developer", projectRole: "contributor" });
  });

  it("cannot remove a member either (403)", async () => {
    const h = await team();
    expect((await remove(h, KIT, SAM)).status).toBe(403);
    expect(grantOf(h.db, SAM)).toBeDefined();
  });

  it("a person who reaches the project only through its Slack channel (a contributor) is refused too", async () => {
    const h = await team();
    const refused = await put(h, MAYA, NEO, "viewer");
    expect(refused.status).toBe(403);
  });
});

describe("a person with no access", () => {
  it("is told the project does not exist, for each of the three routes, and nothing is written", async () => {
    const h = await team();
    for (const response of [await members(h, NEO), await put(h, NEO, KIT, "viewer"), await remove(h, NEO, KIT)]) {
      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    }
    expect(grantOf(h.db, KIT)).toMatchObject({ projectRole: "contributor" });
  });

  it("gets the same 404 for a project that does not exist", async () => {
    const h = await team();
    expect((await members(h, PRIYA, "no-such-project")).status).toBe(404);
    expect((await put(h, PRIYA, KIT, "viewer", { project: "no-such-project" })).status).toBe(404);
  });
});

describe("a maintainer sets roles", () => {
  it("adds a viewer, writing a grant the rest of the system can read", async () => {
    const h = await team();
    const answer = await put(h, PRIYA, NEO, "viewer");
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(ProjectMemberChangeResponseSchema.parse(answer.body)).toEqual({ member: { developerId: NEO.developerId, role: "viewer" } });
    expect(grantOf(h.db, NEO)).toEqual({
      ...projectMemberKey(TEST_ORG, NEO.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: NEO.developerId, grantId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      projectName: "payments", role: "viewer", projectRole: "viewer", grantedBy: { developerId: PRIYA.developerId }, grantedAt: expect.any(String) as string,
    });
    expect(Number.isNaN(Date.parse(String(grantOf(h.db, NEO)!.grantedAt)))).toBe(false);
    // Neo now sees the project, and cannot start a task.
    expect(((await h.dev(NEO, "GET", "/v1/app/projects")).body.projects as unknown[])).toHaveLength(1);
    expect((await h.dev(NEO, "POST", "/v1/dev/tasks", start())).body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("raises that viewer to contributor, keeping the grant id and who added them", async () => {
    const h = await team();
    await put(h, PRIYA, NEO, "viewer");
    const first = grantOf(h.db, NEO)!;
    const raised = await put(h, PRIYA, NEO, "contributor");
    expect(raised.status).toBe(200);
    expect(grantOf(h.db, NEO)).toMatchObject({ role: "developer", projectRole: "contributor", grantId: first.grantId, grantedBy: first.grantedBy, grantedAt: first.grantedAt });
    expect((await h.dev(NEO, "POST", "/v1/dev/tasks", start())).status).toBe(200);
  });

  it("lets another maintainer change a role and keeps who first added the person", async () => {
    const h = await team();
    grantRole(h.db, OMAR, "maintainer", { by: PRIYA });
    await put(h, PRIYA, NEO, "viewer");
    await put(h, OMAR, NEO, "contributor");
    expect(grantOf(h.db, NEO)).toMatchObject({ projectRole: "contributor", grantedBy: { developerId: PRIYA.developerId } });
  });

  it("makes a maintainer (role developer, projectRole maintainer), who can then manage members", async () => {
    const h = await team();
    expect((await put(h, PRIYA, KIT, "maintainer")).status).toBe(200);
    expect(grantOf(h.db, KIT)).toMatchObject({ role: "developer", projectRole: "maintainer" });
    expect((await put(h, KIT, NEO, "viewer")).status).toBe(200);
  });

  it("lowers a maintainer to viewer, who then loses the ability to manage or start", async () => {
    const h = await team();
    expect((await put(h, PRIYA, PRIYA, "viewer")).status).toBe(200);
    expect(grantOf(h.db, PRIYA)).toMatchObject({ role: "viewer", projectRole: "viewer" });
    expect((await put(h, PRIYA, NEO, "viewer")).status).toBe(403);
  });

  it("refuses a role that is not maintainer, contributor or viewer, extra fields, and a missing or malformed request id, writing nothing", async () => {
    const h = await team();
    const path = `/v1/app/projects/payments/members/${NEO.developerId}`;
    for (const body of [
      { requestId: randomUUID(), role: "developer" }, { requestId: randomUUID(), role: "owner" }, { requestId: randomUUID() }, { role: "viewer" },
      { requestId: "not-a-uuid", role: "viewer" }, { requestId: randomUUID(), role: "viewer", extra: true }, { requestId: randomUUID(), role: ["viewer"] },
    ]) {
      const refused = await h.dev(PRIYA, "PUT", path, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(grantOf(h.db, NEO)).toBeUndefined();
  });

  it("refuses a developer id that is not 64 hex characters", async () => {
    const h = await team();
    const refused = await h.dev(PRIYA, "PUT", "/v1/app/projects/payments/members/not-an-id", { requestId: randomUUID(), role: "viewer" });
    expect(refused.status).toBe(404);
  });
});

describe("the target of a role change", () => {
  it("must be a member of the org: an unknown developer id is 404 with the exact words, and nothing is written", async () => {
    const h = await team();
    const unknown = "9".repeat(64);
    const refused = await put(h, PRIYA, unknown, "viewer");
    expect(refused.status).toBe(404);
    expect(refused.body.error).toMatchObject({ code: "NOT_FOUND", message: NOT_IN_ORG });
    expect(grantOf(h.db, { developerId: unknown })).toBeUndefined();
  });

  it("is still a member of the org when the grant commits (final review M7): a removal racing the write leaves no orphaned grant", async () => {
    const h = await team();
    // Neo is removed from the org after the route read him and before its transaction commits.
    h.db.injectFault({
      command: "TransactWriteCommand",
      match: (input) => {
        if (!JSON.stringify(input).includes(NEO.developerId)) return false;
        h.db.delete(orgMemberKey(TEST_ORG, NEO.developerId));
        return false;
      },
      error: { name: "InternalServerError" },
    });
    const refused = await put(h, PRIYA, NEO, "viewer");
    expect(refused.status).toBe(404);
    expect(refused.body.error).toMatchObject({ code: "NOT_FOUND", message: NOT_IN_ORG });
    expect(grantOf(h.db, NEO)).toBeUndefined();
    // Nor does the request id stay behind: asked again once he is back, it is a fresh request.
    expect(h.db.find((item) => typeof item.sk === "string" && item.sk.startsWith("MEMBER_REQUEST#") && (item as { target?: string }).target === NEO.developerId)).toEqual([]);
  });

  it("a member of another org is not in this org: 404, and no grant appears in either org", async () => {
    const h = await createDeveloperTaskBroker({ orgResolver: async ({ developerId }) => (developerId === ZED.developerId ? OTHER_ORG : TEST_ORG) });
    await admit(h, PRIYA);
    await admit(h, ZED, "owner", OTHER_ORG);
    grantRole(h.db, PRIYA, "maintainer");
    const refused = await put(h, PRIYA, ZED, "contributor");
    expect(refused.status).toBe(404);
    expect(refused.body.error).toMatchObject({ code: "NOT_FOUND", message: NOT_IN_ORG });
    expect(grantOf(h.db, ZED, "payments", TEST_ORG)).toBeUndefined();
    expect(grantOf(h.db, ZED, "payments", OTHER_ORG)).toBeUndefined();
  });

  it("an org owner or admin already maintains every project: a role on them is CONFIG_INVALID, and nothing is written", async () => {
    const h = await team();
    for (const [target, orgRole] of [[LENA, "admin"], [OMAR, "owner"]] as const) {
      seedMembership(h.db, target.developerId, { orgId: TEST_ORG, role: orgRole });
      for (const role of ["viewer", "contributor", "maintainer"]) {
        const refused = await put(h, PRIYA, target, role);
        expect(refused.status, `${orgRole} ${role}`).toBe(400);
        expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: OWNERS_MAINTAIN });
      }
      expect(grantOf(h.db, target)).toBeUndefined();
    }
  });

  it("the Auditor holds no project access: a role on one is CONFIG_INVALID, and nothing is written (I2)", async () => {
    const h = await team();
    seedMembership(h.db, LENA.developerId, { orgId: TEST_ORG, role: "auditor" });
    for (const role of ["viewer", "contributor", "maintainer"]) {
      const refused = await put(h, PRIYA, LENA, role);
      expect(refused.status, role).toBe(400);
      expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "the Auditor role holds no project access" });
    }
    expect(grantOf(h.db, LENA)).toBeUndefined();
  });

  it("the member list shows an Auditor with a leftover grant as no one (I2 fix round 1)", async () => {
    const h = await team();
    seedMembership(h.db, KIT.developerId, { orgId: TEST_ORG, role: "auditor" });
    grantRole(h.db, KIT, "maintainer");
    const members = projectMembersOf({ documentClient: h.db, tableName: "state", developer: h.brokerInput.developer as never, now: Date.now });
    expect((await members.list(TEST_ORG, "payments")).map((row) => row.developerId)).not.toContain(KIT.developerId);
    seedMembership(h.db, KIT.developerId, { orgId: TEST_ORG, role: "member" });
    expect((await members.list(TEST_ORG, "payments")).map((row) => row.developerId)).toContain(KIT.developerId);
  });

  it("an Auditor who holds an old grant or channel access still has no project and no role on one (I2)", async () => {
    const h = await team();
    seedMembership(h.db, KIT.developerId, { orgId: TEST_ORG, role: "auditor" });
    grantRole(h.db, KIT, "maintainer");
    const members = projectMembersOf({ documentClient: h.db, tableName: "state", developer: h.brokerInput.developer as never, now: Date.now });
    expect(await members.projectsOf(TEST_ORG, { developerId: KIT.developerId, orgRole: "auditor" })).toEqual([]);
    expect(await members.roleOf(TEST_ORG, "payments", { developerId: KIT.developerId, orgRole: "auditor" })).toBeUndefined();
    // The control: the same grant, held by a member, is a role.
    expect(await members.roleOf(TEST_ORG, "payments", { developerId: KIT.developerId, orgRole: "member" })).toBe("maintainer");
  });

  it("removing an owner or admin is refused the same way", async () => {
    const h = await team();
    const refused = await remove(h, PRIYA, LENA);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: OWNERS_MAINTAIN });
  });

  it("an org admin who holds an old grant is still refused a role (their access is the org role)", async () => {
    const h = await team();
    grantRole(h.db, LENA, "viewer");
    const refused = await put(h, PRIYA, LENA, "contributor");
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: OWNERS_MAINTAIN });
    expect(grantOf(h.db, LENA)).toMatchObject({ projectRole: "viewer" });
  });

  it("a stale id of a merged developer removes the survivor's grant (DELETE)", async () => {
    const h = await team();
    const duplicate = "7".repeat(64);
    h.db.set({ pk: `DEVELOPER#${duplicate}`, sk: "META", developerId: duplicate, provider: "oidc", displayName: "Kit (old)", firstSignInAt: "x", lastSignInAt: "x", revoked: false, mergedInto: KIT.developerId, mergedAt: "x" });
    const answer = await remove(h, PRIYA, duplicate);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(dataOf(answer)).toEqual({ developerId: KIT.developerId, removed: true });
    expect(grantOf(h.db, KIT)).toBeUndefined();
  });

  it("a stale id of a developer merged into another lands on the survivor", async () => {
    const h = await team();
    const duplicate = "7".repeat(64);
    h.db.set({ pk: `DEVELOPER#${duplicate}`, sk: "META", developerId: duplicate, provider: "oidc", displayName: "Neo (old)", firstSignInAt: "x", lastSignInAt: "x", revoked: false, mergedInto: NEO.developerId, mergedAt: "x" });
    const answer = await put(h, PRIYA, duplicate, "viewer");
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(dataOf(answer)).toEqual({ member: { developerId: NEO.developerId, role: "viewer" } });
    expect(grantOf(h.db, NEO)).toMatchObject({ projectRole: "viewer", ownerKey: NEO.developerId });
    expect(grantOf(h.db, { developerId: duplicate })).toBeUndefined();
  });
});

describe("an org owner or admin with no grant", () => {
  it("manages members of any project in the org", async () => {
    const h = await team();
    expect((await put(h, LENA, NEO, "contributor")).status).toBe(200);
    expect(grantOf(h.db, NEO)).toMatchObject({ projectRole: "contributor", grantedBy: { developerId: LENA.developerId } });
    expect((await remove(h, LENA, NEO)).status).toBe(200);
    expect(grantOf(h.db, NEO)).toBeUndefined();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    expect((await put(h, OMAR, NEO, "viewer")).status).toBe(200);
  });
});

describe("removing a member", () => {
  it("deletes the grant, and the person no longer sees the project", async () => {
    const h = await team();
    const answer = await remove(h, PRIYA, KIT);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(dataOf(answer)).toEqual({ developerId: KIT.developerId, removed: true });
    expect(grantOf(h.db, KIT)).toBeUndefined();
    expect((await h.dev(KIT, "GET", "/v1/app/projects/payments")).status).toBe(404);
  });

  it("answers removed: false for a person who has no grant, and leaves the operator's administrator row alone", async () => {
    const h = await team();
    expect(dataOf(await remove(h, PRIYA, NEO))).toEqual({ developerId: NEO.developerId, removed: false });
    h.db.set({ ...projectMemberKey(TEST_ORG, NEO.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: NEO.developerId, projectName: "payments", role: "administrator", grantId: randomUUID() });
    expect(dataOf(await remove(h, PRIYA, NEO))).toEqual({ developerId: NEO.developerId, removed: false });
    expect(grantOf(h.db, NEO)).toMatchObject({ role: "administrator" });
  });

  it("refuses a role on a person who holds the operator's administrator row, which a grant would overwrite", async () => {
    const h = await team();
    h.db.set({ ...projectMemberKey(TEST_ORG, NEO.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: NEO.developerId, projectName: "payments", role: "administrator", grantId: randomUUID() });
    const refused = await put(h, PRIYA, NEO, "viewer");
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(grantOf(h.db, NEO)).toMatchObject({ role: "administrator" });
  });

  it("is refused to a body that is not exactly { requestId }", async () => {
    const h = await team();
    for (const body of [{}, { requestId: "x" }, { requestId: randomUUID(), role: "viewer" }]) {
      const refused = await remove(h, PRIYA, KIT, { body });
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    expect(grantOf(h.db, KIT)).toBeDefined();
  });
});

describe("request ids (a replay answers the stored outcome)", () => {
  it("a replayed role change applies nothing again", async () => {
    const h = await team();
    const requestId = randomUUID();
    const first = await put(h, PRIYA, NEO, "contributor", { requestId });
    expect(first.status).toBe(200);
    // Someone lowers Neo in between; the replay must not undo that.
    await put(h, PRIYA, NEO, "viewer");
    const replay = await put(h, PRIYA, NEO, "contributor", { requestId });
    expect(replay.status).toBe(200);
    expect(dataOf(replay)).toEqual(dataOf(first));
    expect(grantOf(h.db, NEO)).toMatchObject({ projectRole: "viewer" });
  });

  it("the same id for a different person or role is IDEMPOTENCY_CONFLICT", async () => {
    const h = await team();
    const requestId = randomUUID();
    await put(h, PRIYA, NEO, "contributor", { requestId });
    for (const refused of [await put(h, PRIYA, NEO, "viewer", { requestId }), await put(h, PRIYA, SAM, "contributor", { requestId }), await remove(h, PRIYA, NEO, { requestId })]) {
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    }
    expect(grantOf(h.db, NEO)).toMatchObject({ projectRole: "contributor" });
    expect(grantOf(h.db, SAM)).toMatchObject({ projectRole: "viewer" });
  });

  it("a replayed removal removes nobody again", async () => {
    const h = await team();
    const requestId = randomUUID();
    expect(dataOf(await remove(h, PRIYA, KIT, { requestId }))).toEqual({ developerId: KIT.developerId, removed: true });
    await put(h, PRIYA, KIT, "viewer");
    const replay = await remove(h, PRIYA, KIT, { requestId });
    expect(replay.status).toBe(200);
    expect(dataOf(replay)).toEqual({ developerId: KIT.developerId, removed: true });
    expect(grantOf(h.db, KIT)).toMatchObject({ projectRole: "viewer" });
  });

  it("another caller cannot read or replay someone else's request id", async () => {
    const h = await team();
    const requestId = randomUUID();
    await put(h, PRIYA, NEO, "contributor", { requestId });
    const other = await put(h, LENA, NEO, "contributor", { requestId });
    expect(other.status).toBe(409);
    expect(other.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("an id is per project", async () => {
    const h = await team();
    seedProject(h.db, TEST_ORG, "billing");
    grantRole(h.db, PRIYA, "maintainer", { project: "billing" });
    const requestId = randomUUID();
    await put(h, PRIYA, NEO, "viewer", { requestId });
    const other = await put(h, PRIYA, NEO, "contributor", { requestId, project: "billing" });
    expect(other.status).toBe(200);
    expect(grantOf(h.db, NEO, "billing")).toMatchObject({ projectRole: "contributor" });
    expect(grantOf(h.db, NEO)).toMatchObject({ projectRole: "viewer" });
  });

  it("access is checked before the replay: a maintainer who was lowered is refused on a replay", async () => {
    const h = await team();
    const requestId = randomUUID();
    await put(h, PRIYA, NEO, "viewer", { requestId });
    h.db.set({ ...grantOf(h.db, PRIYA)!, projectRole: "contributor" });
    expect((await put(h, PRIYA, NEO, "viewer", { requestId })).status).toBe(403);
  });

  it("writes the grant and the request record in one transaction, with an expiry on the record", async () => {
    const h = await team();
    const requestId = randomUUID();
    const sent: Array<{ name: string; items: number }> = [];
    const send = h.db.send.bind(h.db);
    h.db.send = (async (command: { constructor: { name: string }; input: { TransactItems?: unknown[] } }) => {
      if (command.constructor.name === "TransactWriteCommand") sent.push({ name: command.constructor.name, items: command.input.TransactItems?.length ?? 0 });
      return send(command);
    });
    expect((await put(h, PRIYA, NEO, "viewer", { requestId })).status).toBe(200);
    expect((await remove(h, PRIYA, NEO)).status).toBe(200);
    // A removal of someone with no grant still records its request.
    expect((await remove(h, PRIYA, NEO)).status).toBe(200);
    // Grant/member check/request plus approval generation; removal/request plus generation; absent grant records only the request.
    expect(sent).toEqual([{ name: "TransactWriteCommand", items: 4 }, { name: "TransactWriteCommand", items: 3 }, { name: "TransactWriteCommand", items: 1 }]);
    const stored = h.db.get({ pk: `ORG#${TEST_ORG}#PROJECT#payments`, sk: `MEMBER_REQUEST#${requestId}` });
    expect(stored).toMatchObject({ entityType: "PROJECT_MEMBER_REQUEST", action: "put", by: PRIYA.developerId, response: { developerId: NEO.developerId, role: "viewer" } });
    expect(stored!.indexExpiresAt).toBeGreaterThan(Date.now() / 1000 + 80_000);
  });

  it("a transaction that fails changes neither the grant nor the request record, so the same id applies cleanly afterwards", async () => {
    const h = await team();
    const requestId = randomUUID();
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    const failed = await put(h, PRIYA, NEO, "viewer", { requestId });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(grantOf(h.db, NEO)).toBeUndefined();
    expect(h.db.get({ pk: `ORG#${TEST_ORG}#PROJECT#payments`, sk: `MEMBER_REQUEST#${requestId}` })).toBeUndefined();
    expect((await put(h, PRIYA, NEO, "viewer", { requestId })).status).toBe(200);
  });

  it("two requests racing on one new person: the grant changed under the second is retried, not lost", async () => {
    const h = await team();
    // The first attempt's transaction is cancelled as if the grant had changed; the retry reads it again and succeeds.
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] } });
    expect((await put(h, PRIYA, NEO, "contributor")).status).toBe(200);
    expect(grantOf(h.db, NEO)).toMatchObject({ projectRole: "contributor" });
    // A change that keeps being cancelled gives CHANGE_STALE.
    h.db.injectFault({ command: "TransactWriteCommand", times: 5, error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] } });
    const stale = await put(h, PRIYA, NEO, "viewer");
    expect(stale.body.error).toMatchObject({ code: "CHANGE_STALE" });
    expect(grantOf(h.db, NEO)).toMatchObject({ projectRole: "contributor" });
  });

  it("an expired record (the State table's TTL can lag) reads as absent: the id is a fresh request", async () => {
    const h = await team();
    const requestId = randomUUID();
    await put(h, PRIYA, NEO, "contributor", { requestId });
    const key = { pk: `ORG#${TEST_ORG}#PROJECT#payments`, sk: `MEMBER_REQUEST#${requestId}` };
    // Still live: a different role with the id is a conflict.
    expect((await put(h, PRIYA, NEO, "viewer", { requestId })).status).toBe(409);
    h.db.set({ ...h.db.get(key)!, indexExpiresAt: Math.floor(Date.now() / 1000) - 10 });
    const fresh = await put(h, PRIYA, NEO, "viewer", { requestId });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(grantOf(h.db, NEO)).toMatchObject({ projectRole: "viewer" });
    expect(h.db.get(key)).toMatchObject({ role: "viewer", response: { developerId: NEO.developerId, role: "viewer" } });
    expect(h.db.get(key)!.indexExpiresAt).toBeGreaterThan(Date.now() / 1000 + 80_000);
    // The same holds for a removal.
    const removal = randomUUID();
    await remove(h, PRIYA, NEO, { requestId: removal });
    h.db.set({ ...h.db.get({ pk: key.pk, sk: `MEMBER_REQUEST#${removal}` })!, indexExpiresAt: 1 });
    await put(h, PRIYA, NEO, "contributor");
    expect(dataOf(await remove(h, PRIYA, NEO, { requestId: removal }))).toEqual({ developerId: NEO.developerId, removed: true });
  });

  it("a failed change is not stored: the same id can be retried", async () => {
    const h = await team();
    const requestId = randomUUID();
    expect((await put(h, PRIYA, "9".repeat(64), "viewer", { requestId })).status).toBe(404);
    expect((await put(h, PRIYA, NEO, "viewer", { requestId })).status).toBe(200);
  });
});

describe("GET /v1/app/projects/{name}/members", () => {
  it("lists grant holders and org owners and admins, with names, sources and who added them; emails only for an org owner or admin", async () => {
    const h = await team();
    const answer = await members(h, KIT);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(ProjectMembersResponseSchema.parse(answer.body).members).toHaveLength(4);
    const byId = new Map(listed(answer).map((member) => [member.developerId, member]));
    // Lena is an org admin, with no grant; Omar is a plain member here and does not appear.
    // Release 0.4.16 (owner decision "option A"): Priya is a project maintainer but a plain org member, so she is shown names and roles, no emails.
    expect(byId.get(LENA.developerId)).toEqual({ developerId: LENA.developerId, name: LENA.name, role: "maintainer", source: "org_role" });
    expect(byId.get(PRIYA.developerId)).toMatchObject({ developerId: PRIYA.developerId, name: PRIYA.name, role: "maintainer", source: "grant" });
    expect(byId.get(PRIYA.developerId)).not.toHaveProperty("email");
    expect(JSON.stringify(answer.body)).not.toContain("@");
    // An org admin sees them.
    const forAdmin = new Map(listed(await members(h, LENA)).map((member) => [member.developerId, member]));
    expect(forAdmin.get(LENA.developerId)).toEqual({ developerId: LENA.developerId, name: LENA.name, email: emailOf(LENA), role: "maintainer", source: "org_role" });
    expect(forAdmin.get(PRIYA.developerId)).toMatchObject({ name: PRIYA.name, email: emailOf(PRIYA), role: "maintainer", source: "grant" });
    expect(byId.get(SAM.developerId)).toMatchObject({ role: "viewer", source: "grant", grantedBy: { developerId: PRIYA.developerId, name: PRIYA.name } });
    expect(byId.get(KIT.developerId)).toMatchObject({ role: "contributor", source: "grant", grantedBy: { developerId: PRIYA.developerId, name: PRIYA.name } });
    expect(byId.has(NEO.developerId)).toBe(false);
    expect(byId.has(OMAR.developerId)).toBe(false);
  });

  it("sorts maintainers first, then contributors, then viewers, each by name", async () => {
    const h = await team();
    expect(listed(await members(h, PRIYA)).map((member) => member.name)).toEqual([LENA.name, PRIYA.name, KIT.name, SAM.name]);
  });

  it("reports an owner or admin who also holds a grant once, as org_role", async () => {
    const h = await team();
    grantRole(h.db, LENA, "viewer");
    const rows = listed(await members(h, PRIYA)).filter((member) => member.developerId === LENA.developerId);
    expect(rows).toEqual([expect.objectContaining({ role: "maintainer", source: "org_role" })]);
  });

  it("reads an old grant (role developer, no projectRole) as a contributor, with no grantedBy", async () => {
    const h = await team();
    grantProject(h.db, NEO);
    expect(listed(await members(h, LENA)).find((member) => member.developerId === NEO.developerId)).toEqual({
      developerId: NEO.developerId, name: NEO.name, email: emailOf(NEO), role: "contributor", source: "grant",
    });
    expect(listed(await members(h, PRIYA)).find((member) => member.developerId === NEO.developerId)).toEqual({
      developerId: NEO.developerId, name: NEO.name, role: "contributor", source: "grant",
    });
  });

  it("does not list an old administrator row (the operator's, not a project role)", async () => {
    const h = await team();
    h.db.set({ ...projectMemberKey(TEST_ORG, NEO.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: NEO.developerId, projectName: "payments", role: "administrator", grantId: randomUUID() });
    expect(listed(await members(h, PRIYA)).some((member) => member.developerId === NEO.developerId)).toBe(false);
  });

  it("reads an old grantedBy { issuer, subject } as the developer that identity is", async () => {
    const h = await team();
    const issuer = "https://idp.example.com";
    const subject = "priya-subject";
    h.db.set({ pk: `DEVELOPER#${ownerKeyForSubject(issuer, subject)}`, sk: "META", developerId: ownerKeyForSubject(issuer, subject), provider: "oidc", displayName: "Admin Alma", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    h.db.set({ ...projectMemberKey(TEST_ORG, NEO.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: NEO.developerId, projectName: "payments", role: "developer", grantId: randomUUID(), grantedBy: { issuer, subject }, grantedAt: "2026-09-01T00:00:00.000Z" });
    expect(listed(await members(h, PRIYA)).find((member) => member.developerId === NEO.developerId)!.grantedBy).toEqual({ developerId: ownerKeyForSubject(issuer, subject), name: "Admin Alma" });
  });

  it("leaves grantedBy out for a grant the operator console made ({ system: admin }) and for one with none", async () => {
    const h = await team();
    grantRole(h.db, NEO, "contributor", { by: "system" });
    expect(listed(await members(h, PRIYA)).find((member) => member.developerId === NEO.developerId)).not.toHaveProperty("grantedBy");
  });

  it("follows who added a person through a merge: a grant made by a developer later merged into another names the survivor", async () => {
    const h = await team();
    const duplicate = "7".repeat(64);
    h.db.set({ pk: `DEVELOPER#${duplicate}`, sk: "META", developerId: duplicate, provider: "oidc", displayName: "Priya (old)", firstSignInAt: "x", lastSignInAt: "x", revoked: false, mergedInto: PRIYA.developerId, mergedAt: "x" });
    h.db.set({ ...grantOf(h.db, KIT)!, grantedBy: { developerId: duplicate } });
    expect(listed(await members(h, SAM)).find((member) => member.developerId === KIT.developerId)!.grantedBy).toEqual({ developerId: PRIYA.developerId, name: PRIYA.name });
    // And whoami: the survivor who made their own grant under the old id still created it.
    h.db.set({ ...grantOf(h.db, PRIYA)!, grantedBy: { developerId: duplicate } });
    const projects = (await h.dev(PRIYA, "GET", "/v1/dev/projects")).body.projects as Array<Record<string, unknown>>;
    expect(projects.find((project) => project.name === "payments")).toMatchObject({ addedBy: { developerId: PRIYA.developerId, name: PRIYA.name } });
  });

  it("names a person whose record is gone 'Unknown' rather than failing", async () => {
    const h = await team();
    h.db.delete(`DEVELOPER#${KIT.developerId}`, "META");
    expect(listed(await members(h, PRIYA)).find((member) => member.developerId === KIT.developerId)).toMatchObject({ name: "Unknown" });
  });

  it("is open to anyone who can see the project, including a person who reaches it only through its Slack channel", async () => {
    const h = await team();
    expect((await members(h, MAYA)).status).toBe(200);
    expect((await members(h, LENA)).status).toBe(200);
  });

  it("reaches only this org's project of that name: another org's same-named project and its people never appear", async () => {
    const h = await createDeveloperTaskBroker({ orgResolver: async ({ developerId }) => (developerId === ZED.developerId ? OTHER_ORG : TEST_ORG) });
    await admit(h, PRIYA);
    await admit(h, ZED, "owner", OTHER_ORG);
    await admit(h, SAM, "admin", OTHER_ORG);
    seedProject(h.db, OTHER_ORG, "payments");
    grantRole(h.db, PRIYA, "maintainer");
    grantRole(h.db, SAM, "contributor", { orgId: OTHER_ORG, by: ZED });
    const answer = listed(await members(h, PRIYA));
    expect(answer.map((member) => member.developerId)).toEqual([PRIYA.developerId]);
    const theirs = listed(await members(h, ZED));
    expect(theirs.map((member) => member.developerId).sort()).toEqual([SAM.developerId, ZED.developerId].sort());
  });

  it("is 404 for a project that exists only in another org", async () => {
    const h = await createDeveloperTaskBroker({ orgResolver: async ({ developerId }) => (developerId === ZED.developerId ? OTHER_ORG : TEST_ORG) });
    await admit(h, PRIYA);
    await admit(h, ZED, "owner", OTHER_ORG);
    seedProject(h.db, OTHER_ORG, "elsewhere");
    const hidden = await members(h, PRIYA, "elsewhere");
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    // Not even the other org's owner reaches this org's project.
    expect((await members(h, ZED, "payments")).status).toBe(404);
  });
});

describe("cross-org writes", () => {
  async function twoOrgs() {
    const h = await createDeveloperTaskBroker({ orgResolver: async ({ developerId }) => ([ZED.developerId, KIT.developerId].includes(developerId as string) ? OTHER_ORG : TEST_ORG) });
    await admit(h, PRIYA);
    await admit(h, NEO);
    await admit(h, ZED, "owner", OTHER_ORG);
    seedProject(h.db, OTHER_ORG, "payments");
    grantRole(h.db, PRIYA, "maintainer");
    return h;
  }

  it("an owner of another org cannot set or remove a role in this org's project (404), though they own a same-named one", async () => {
    const h = await twoOrgs();
    expect((await put(h, ZED, NEO, "viewer")).status).toBe(404);
    expect((await remove(h, ZED, PRIYA)).status).toBe(404);
    expect(grantOf(h.db, NEO)).toBeUndefined();
    expect(grantOf(h.db, PRIYA)).toBeDefined();
  });

  it("a role set in one org's project writes only that org's partition", async () => {
    const h = await twoOrgs();
    await admit(h, KIT, "member", OTHER_ORG);
    // Zed maintains their own org's payments as an owner and gives Kit a role there.
    expect((await put(h, ZED, KIT, "viewer")).status).toBe(200);
    expect(grantOf(h.db, KIT, "payments", OTHER_ORG)).toMatchObject({ projectRole: "viewer" });
    expect(grantOf(h.db, KIT, "payments", TEST_ORG)).toBeUndefined();
    // And Priya cannot reach Kit in her org, since Kit belongs to the other.
    const refused = await put(h, PRIYA, KIT, "contributor");
    expect(refused.status).toBe(404);
    expect(refused.body.error).toMatchObject({ message: NOT_IN_ORG });
    expect(grantOf(h.db, KIT, "payments", TEST_ORG)).toBeUndefined();
  });

  it("removing someone who belongs to the other org is a 404 and touches nothing there", async () => {
    const h = await twoOrgs();
    await admit(h, KIT, "member", OTHER_ORG);
    grantRole(h.db, KIT, "contributor", { orgId: OTHER_ORG, by: ZED });
    const refused = await remove(h, PRIYA, KIT);
    expect(refused.status).toBe(404);
    expect(grantOf(h.db, KIT, "payments", OTHER_ORG)).toBeDefined();
  });

  it("a request id used in one org is not a replay in the other", async () => {
    const h = await twoOrgs();
    await admit(h, KIT, "member", OTHER_ORG);
    const requestId = randomUUID();
    expect((await put(h, PRIYA, NEO, "viewer", { requestId })).status).toBe(200);
    // Zed's same-named project is another partition: the same id is a fresh request there (a different target is no conflict).
    expect((await put(h, ZED, KIT, "contributor", { requestId })).status).toBe(200);
    expect(grantOf(h.db, KIT, "payments", OTHER_ORG)).toMatchObject({ projectRole: "contributor" });
  });
});

describe("removing an org member (Task 4)", () => {
  it("removes their project grants, viewer grants included", async () => {
    const h = await team();
    const removed = await h.dev(LENA, "DELETE", `/v1/app/org/members/${SAM.developerId}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(grantOf(h.db, SAM)).toBeUndefined();
    const removedKit = await h.dev(LENA, "DELETE", `/v1/app/org/members/${KIT.developerId}`);
    expect(removedKit.status).toBe(200);
    expect(grantOf(h.db, KIT)).toBeUndefined();
    expect(listed(await members(h, PRIYA)).map((member) => member.developerId)).toEqual([LENA.developerId, PRIYA.developerId]);
  });
});

describe("the grant item and the E2E direct-membership proof", () => {
  const proof = async (h: Harness, who: Developer) =>
    (await brokerModule()).workflowE2ECreatorAuthorityProof(h.brokerInput, { taskId: randomUUID(), developerId: who.developerId, developerName: who.name, provider: who.provider, project: "payments" }, grantOf(h.db, who), { access: "granted", channelIds: [] }, undefined);

  it("a contributor or maintainer grant written by the route is a direct-membership proof", async () => {
    const h = await team();
    for (const role of ["contributor", "maintainer"] as const) {
      await put(h, PRIYA, NEO, role);
      const grant = grantOf(h.db, NEO)!;
      expect(grant).toMatchObject({ entityType: "MEMBERSHIP", ownerKey: NEO.developerId, projectName: "payments", role: "developer" });
      expect(grant.grantId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(await proof(h, NEO)).toEqual({ kind: "direct-membership", developerId: NEO.developerId, project: "payments", role: "developer", grantId: grant.grantId });
    }
  });

  it("an old grant upgraded by a role change becomes a complete item", async () => {
    const h = await team();
    h.db.set({ ...projectMemberKey(TEST_ORG, NEO.developerId, "payments"), role: "developer" });
    await put(h, PRIYA, NEO, "contributor");
    const grant = grantOf(h.db, NEO)!;
    expect(grant).toMatchObject({ entityType: "MEMBERSHIP", ownerKey: NEO.developerId, projectName: "payments", role: "developer", projectRole: "contributor" });
    expect(grant.grantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await proof(h, NEO)).toMatchObject({ kind: "direct-membership", grantId: grant.grantId });
  });

  it("a creator lowered to viewer is told TASK_ACCESS_DENIED with the reason on the next E2E round, not that the runtime is unavailable", async () => {
    const h = await team();
    const task = { developerId: KIT.developerId, developerName: KIT.name, provider: KIT.provider, project: "payments", orgId: TEST_ORG, taskId: randomUUID() };
    const { requireWorkflowE2ECreatorAuthority } = await brokerModule();
    h.db.set({ ...(h.db.get(`DEVELOPER#${KIT.developerId}`, "META") as Record<string, unknown>), entityType: "DEVELOPER" });
    expect(await requireWorkflowE2ECreatorAuthority(h.brokerInput, task)).toMatchObject({ kind: "direct-membership", role: "developer" });
    // A maintainer lowered to contributor keeps going (the same grant id and role).
    await put(h, PRIYA, KIT, "contributor");
    expect(await requireWorkflowE2ECreatorAuthority(h.brokerInput, task)).toMatchObject({ kind: "direct-membership" });
    await put(h, PRIYA, KIT, "viewer");
    await expect(requireWorkflowE2ECreatorAuthority(h.brokerInput, task)).rejects.toMatchObject({
      code: "TASK_ACCESS_DENIED", message: expect.stringContaining("the original creator can now only view this task's project and can no longer run its checks") as string,
    });
  });

  it("a viewer grant is no direct-membership proof (a viewer starts no work)", async () => {
    const h = await team();
    expect(await proof(h, SAM)).toBeUndefined();
  });

  it("the creator's grant from creating a project is a maintainer grant naming them", async () => {
    const h = await createDeveloperTaskBroker({ register: false });
    h.db.set({ ...h.db.get(orgMetaKey(TEST_ORG)), ...orgMetaKey(TEST_ORG), entityType: "ORG", approvalMembershipVersion: 8 });
    await (await brokerModule()).registerProjectFor(h.brokerInput, { orgId: TEST_ORG, ownerKey: OMAR.developerId }, {
      definition: { name: "web", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate." },
      runtimeBinding: BINDING,
    }, { creatorMembership: "developer", requireNewName: true });
    expect(h.db.get(orgMetaKey(TEST_ORG))?.approvalMembershipVersion).toBe(9);
    expect(grantOf(h.db, OMAR, "web")).toMatchObject({
      entityType: "MEMBERSHIP", ownerKey: OMAR.developerId, projectName: "web", role: "developer", projectRole: "maintainer", grantedBy: { developerId: OMAR.developerId }, grantedAt: expect.any(String) as string,
    });
  });

  it("starting a task keeps the person's role on their grant", async () => {
    const h = await team();
    const before = grantOf(h.db, KIT)!;
    expect((await h.dev(KIT, "POST", "/v1/dev/tasks", start())).status).toBe(200);
    expect(grantOf(h.db, KIT)).toMatchObject({ projectRole: "contributor", role: "developer", grantedBy: before.grantedBy, grantedAt: before.grantedAt });
    expect((await h.dev(PRIYA, "POST", "/v1/dev/tasks", start())).status).toBe(200);
    expect(grantOf(h.db, PRIYA)).toMatchObject({ projectRole: "maintainer" });
  });
});

describe("requireProjectAuthority (the task paths' gate)", () => {
  it("never counts a viewer's row as authority: it is NOT_FOUND, though a maintainer's, a contributor's, an old and an operator's row are", async () => {
    const h = await team();
    const { requireProjectAuthority } = await brokerModule();
    const authority = (who: Developer) => requireProjectAuthority(h.brokerInput, TEST_ORG, who.developerId, "payments");
    await expect(authority(SAM)).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("project not found") as string });
    expect(await authority(PRIYA)).toMatchObject({ kind: "grant" });
    expect(await authority(KIT)).toMatchObject({ kind: "grant" });
    grantProject(h.db, NEO);
    expect(await authority(NEO)).toMatchObject({ kind: "grant" });
    h.db.set({ ...projectMemberKey(TEST_ORG, ZED.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: ZED.developerId, projectName: "payments", role: "administrator", grantId: randomUUID() });
    expect(await authority(ZED)).toMatchObject({ kind: "grant" });
  });

  it("falls to the org role for a viewer who is an org owner or admin", async () => {
    const h = await team();
    const { requireProjectAuthority } = await brokerModule();
    grantRole(h.db, LENA, "viewer");
    expect(await requireProjectAuthority(h.brokerInput, TEST_ORG, LENA.developerId, "payments")).toMatchObject({ kind: "org-role", role: "admin" });
  });
});

describe("the operator console's grant and revoke", () => {
  it("writes a contributor grant naming the operator console, and revokes a viewer grant too", async () => {
    const h = await team();
    const { grantProjectAccess, revokeProjectAccess } = await import("../../packages/broker/src/aws/admin-actions.js");
    const adminDeps = { documentClient: h.db, tableName: "state", now: () => Date.now() } as never;
    await grantProjectAccess(adminDeps, TEST_ORG, { issuer: "https://idp.example.com", subject: "alma" }, "payments", NEO.developerId);
    expect(grantOf(h.db, NEO)).toMatchObject({ entityType: "MEMBERSHIP", ownerKey: NEO.developerId, role: "developer", projectRole: "contributor", grantedBy: { system: "admin" }, grantedAt: expect.any(String) as string });
    expect(await revokeProjectAccess(adminDeps, TEST_ORG, "payments", NEO.developerId)).toEqual({ revoked: true });
    expect(await revokeProjectAccess(adminDeps, TEST_ORG, "payments", SAM.developerId)).toEqual({ revoked: true });
    expect(grantOf(h.db, SAM)).toBeUndefined();
  });

  it("will not turn a viewer into a contributor on its own: it says to change the role instead", async () => {
    const h = await team();
    const { grantProjectAccess } = await import("../../packages/broker/src/aws/admin-actions.js");
    await expect(grantProjectAccess({ documentClient: h.db, tableName: "state", now: () => Date.now() } as never, TEST_ORG, { issuer: "i", subject: "s" }, "payments", SAM.developerId))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(grantOf(h.db, SAM)).toMatchObject({ projectRole: "viewer" });
  });
});

describe("what whoami is told (GET /v1/dev/projects)", () => {
  const roleOfProject = async (h: Harness, who: Developer) => ((await h.dev(who, "GET", "/v1/dev/projects")).body.projects as Array<Record<string, unknown>>).find((project) => project.name === "payments");

  it("says maintainer, who added them, for a grant", async () => {
    const h = await team();
    expect(await roleOfProject(h, PRIYA)).toMatchObject({ role: "maintainer", roleSource: "grant", addedBy: { developerId: PRIYA.developerId, name: PRIYA.name } });
    expect(await roleOfProject(h, SAM)).toMatchObject({ role: "viewer", roleSource: "grant", addedBy: { developerId: PRIYA.developerId, name: PRIYA.name } });
  });

  it("says maintainer through the org role for an owner or admin, even with no grant, and lists the whole catalog for them", async () => {
    const h = await team();
    seedProject(h.db, TEST_ORG, "billing");
    const lena = (await h.dev(LENA, "GET", "/v1/dev/projects")).body.projects as Array<Record<string, unknown>>;
    expect(lena.map((project) => [project.name, project.role, project.roleSource])).toEqual([["billing", "maintainer", "org_role"], ["payments", "maintainer", "org_role"]]);
    // A member does not get the catalog.
    expect(((await h.dev(KIT, "GET", "/v1/dev/projects")).body.projects as unknown[])).toHaveLength(1);
  });

  it("says contributor through the channel for a Slack channel member, and an old grant is a contributor with no 'added by'", async () => {
    const h = await team();
    expect(await roleOfProject(h, MAYA)).toMatchObject({ role: "contributor", roleSource: "channel" });
    grantProject(h.db, NEO);
    const old = await roleOfProject(h, NEO);
    expect(old).toMatchObject({ role: "contributor", roleSource: "grant" });
    expect(old).not.toHaveProperty("addedBy");
  });
});

describe("ProjectMembers", () => {
  const caller = (who: Developer, orgRole: OrgRole = "member") => ({ developerId: who.developerId, orgRole });
  const routeDeps = (h: Harness): DeveloperRouteDependencies => ({ documentClient: h.db, tableName: "state", developer: h.brokerInput.developer as never, now: Date.now });
  const real = (h: Harness): ProjectMembers => projectMembersOf(routeDeps(h));

  it("is injected as deps.projectMembers when given, and built from the route dependencies otherwise", async () => {
    const h = await team();
    const injected: ProjectMembers = { roleOf: async () => "viewer", list: async () => [], projectsOf: async () => [] };
    expect(projectMembersOf({ ...routeDeps(h), projectMembers: injected })).toBe(injected);
    expect(real(h)).not.toBe(injected);
  });

  describe("list", () => {
    it("returns the maintainer grant and the org admin, with sources grant and org_role", async () => {
      const h = await createDeveloperTaskBroker();
      await admit(h, PRIYA); await admit(h, LENA, "admin");
      grantRole(h.db, PRIYA, "maintainer");
      expect(await real(h).list(TEST_ORG, "payments")).toEqual(expect.arrayContaining([
        { developerId: PRIYA.developerId, role: "maintainer", source: "grant" },
        { developerId: LENA.developerId, role: "maintainer", source: "org_role" },
      ]));
      expect(await real(h).list(TEST_ORG, "payments")).toHaveLength(2);
    });

    it("reports an owner or admin who also holds a grant once, as org_role", async () => {
      const h = await createDeveloperTaskBroker();
      await admit(h, LENA, "admin"); await admit(h, OMAR, "owner");
      grantRole(h.db, LENA, "viewer"); grantRole(h.db, OMAR, "contributor");
      const rows = await real(h).list(TEST_ORG, "payments");
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        { developerId: LENA.developerId, role: "maintainer", source: "org_role" },
        { developerId: OMAR.developerId, role: "maintainer", source: "org_role" },
      ]));
    });

    it("has exactly developerId, role and source on each row", async () => {
      const h = await team();
      for (const row of await real(h).list(TEST_ORG, "payments")) expect(Object.keys(row).sort()).toEqual(["developerId", "role", "source"]);
    });

    it("lists contributors and viewers, and not a member with no grant", async () => {
      const h = await team();
      const rows = await real(h).list(TEST_ORG, "payments");
      expect(rows.find((row) => row.developerId === KIT.developerId)).toEqual({ developerId: KIT.developerId, role: "contributor", source: "grant" });
      expect(rows.find((row) => row.developerId === SAM.developerId)).toEqual({ developerId: SAM.developerId, role: "viewer", source: "grant" });
      expect(rows.some((row) => row.developerId === NEO.developerId)).toBe(false);
    });

    it("is empty for a project that does not exist, even though owners and admins maintain every project", async () => {
      const h = await team();
      expect(await real(h).list(TEST_ORG, "no-such-project")).toEqual([]);
    });

    it("counts a grant of a developer who left the org for nothing (their grants went with them; a stray one is not listed)", async () => {
      const h = await team();
      const gone = person("8", "Gone Girl");
      grantRole(h.db, gone, "maintainer");
      expect((await real(h).list(TEST_ORG, "payments")).some((row) => row.developerId === gone.developerId)).toBe(false);
    });

    it("never returns another org's people or grants", async () => {
      const h = await createDeveloperTaskBroker({ orgResolver: async ({ developerId }) => (developerId === ZED.developerId ? OTHER_ORG : TEST_ORG) });
      await admit(h, PRIYA); await admit(h, ZED, "owner", OTHER_ORG);
      seedProject(h.db, OTHER_ORG, "payments");
      grantRole(h.db, PRIYA, "maintainer");
      grantRole(h.db, ZED, "contributor", { orgId: OTHER_ORG });
      expect((await real(h).list(TEST_ORG, "payments")).map((row) => row.developerId)).toEqual([PRIYA.developerId]);
      expect((await real(h).list(OTHER_ORG, "payments")).map((row) => row.developerId)).toEqual([ZED.developerId]);
    });
  });

  describe("roleOf", () => {
    it("is maintainer for an org owner or admin with no grant", async () => {
      const h = await team();
      expect(await real(h).roleOf(TEST_ORG, "payments", caller(LENA, "admin"))).toBe("maintainer");
      expect(await real(h).roleOf(TEST_ORG, "payments", caller(OMAR, "owner"))).toBe("maintainer");
    });

    it("is the grant's role: maintainer, contributor, viewer, and an old grant is a contributor", async () => {
      const h = await team();
      expect(await real(h).roleOf(TEST_ORG, "payments", caller(PRIYA))).toBe("maintainer");
      expect(await real(h).roleOf(TEST_ORG, "payments", caller(KIT))).toBe("contributor");
      expect(await real(h).roleOf(TEST_ORG, "payments", caller(SAM))).toBe("viewer");
      grantProject(h.db, NEO);
      expect(await real(h).roleOf(TEST_ORG, "payments", caller(NEO))).toBe("contributor");
    });

    it("is contributor for a caller who has only the project's Slack channel", async () => {
      const h = await team();
      expect(await real(h).roleOf(TEST_ORG, "payments", caller(MAYA))).toBe("contributor");
    });

    it("is undefined for a caller with no grant and no channel", async () => {
      const h = await team();
      expect(await real(h).roleOf(TEST_ORG, "payments", caller(NEO))).toBeUndefined();
    });

    it("keeps a viewer grant when the same person is also in the channel", async () => {
      const h = await team();
      grantRole(h.db, MAYA, "viewer");
      expect(await real(h).roleOf(TEST_ORG, "payments", caller(MAYA))).toBe("viewer");
    });

    it("is undefined for an unknown project, for everyone, owners and admins included", async () => {
      const h = await team();
      for (const who of [caller(LENA, "admin"), caller(OMAR, "owner"), caller(PRIYA), caller(MAYA)]) expect(await real(h).roleOf(TEST_ORG, "no-such-project", who)).toBeUndefined();
    });

    it("is undefined for a project that exists only in another org", async () => {
      const h = await team();
      seedProject(h.db, OTHER_ORG, "elsewhere");
      expect(await real(h).roleOf(TEST_ORG, "elsewhere", caller(OMAR, "owner"))).toBeUndefined();
      expect(await real(h).roleOf(OTHER_ORG, "elsewhere", caller(OMAR, "owner"))).toBe("maintainer");
      // Nor does a grant in this org's partition answer for the other org's same-named project.
      seedProject(h.db, OTHER_ORG, "payments");
      expect(await real(h).roleOf(OTHER_ORG, "payments", caller(PRIYA))).toBeUndefined();
    });

    it("answers for an archived project (it still has people)", async () => {
      const h = await team();
      seedProject(h.db, TEST_ORG, "old", "archived");
      grantRole(h.db, KIT, "contributor", { project: "old" });
      expect(await real(h).roleOf(TEST_ORG, "old", caller(KIT))).toBe("contributor");
    });

    it("reads a grant held by a developer merged into someone as the survivor's", async () => {
      const h = await team();
      const duplicate = "7".repeat(64);
      h.db.set({ pk: `DEVELOPER#${duplicate}`, sk: "META", developerId: duplicate, provider: "oidc", displayName: "Neo (old)", firstSignInAt: "x", lastSignInAt: "x", revoked: false, mergedInto: NEO.developerId, mergedAt: "x" });
      // The duplicate holds a stranded grant (a merge moves grants first, so this should not happen). It counts only for a call that names
      // the duplicate's id, not for the survivor's own id.
      h.db.set({ ...projectMemberKey(TEST_ORG, duplicate, "payments"), entityType: "MEMBERSHIP", ownerKey: duplicate, projectName: "payments", role: "developer", projectRole: "maintainer", grantId: randomUUID() });
      expect(await real(h).roleOf(TEST_ORG, "payments", caller(NEO))).toBeUndefined();
      expect(await real(h).roleOf(TEST_ORG, "payments", { developerId: duplicate, orgRole: "member" })).toBe("maintainer");
      // And the survivor's own grant is what a call with the duplicate's id reads when there is one.
      grantRole(h.db, NEO, "viewer");
      expect(await real(h).roleOf(TEST_ORG, "payments", { developerId: duplicate, orgRole: "member" })).toBe("viewer");
    });
  });

  describe("projectsOf", () => {
    it("reads the grants of a merged developer's survivor (and the duplicate's own stranded ones) for a call that names the duplicate", async () => {
      const h = await team();
      seedProject(h.db, TEST_ORG, "billing");
      seedProject(h.db, TEST_ORG, "ledger");
      const duplicate = "7".repeat(64);
      h.db.set({ pk: `DEVELOPER#${duplicate}`, sk: "META", developerId: duplicate, provider: "oidc", displayName: "Kit (old)", firstSignInAt: "x", lastSignInAt: "x", revoked: false, mergedInto: KIT.developerId, mergedAt: "x" });
      grantRole(h.db, KIT, "viewer", { project: "billing" });
      // A stranded grant under the duplicate's id on one project, and one on a project the survivor also holds (the survivor's wins).
      h.db.set({ ...projectMemberKey(TEST_ORG, duplicate, "ledger"), entityType: "MEMBERSHIP", ownerKey: duplicate, projectName: "ledger", role: "developer", projectRole: "maintainer", grantId: randomUUID() });
      h.db.set({ ...projectMemberKey(TEST_ORG, duplicate, "billing"), entityType: "MEMBERSHIP", ownerKey: duplicate, projectName: "billing", role: "developer", projectRole: "maintainer", grantId: randomUUID() });
      expect(await real(h).projectsOf(TEST_ORG, { developerId: duplicate, orgRole: "member" })).toEqual([
        { project: "billing", role: "viewer" }, { project: "ledger", role: "maintainer" }, { project: "payments", role: "contributor" },
      ]);
      // Called with the survivor's own id, the stranded grants do not count.
      expect(await real(h).projectsOf(TEST_ORG, caller(KIT))).toEqual([{ project: "billing", role: "viewer" }, { project: "payments", role: "contributor" }]);
    });

    it("lists every active project of the org for an owner or admin, as maintainer, and none of another org's", async () => {
      const h = await team();
      seedProject(h.db, TEST_ORG, "billing");
      seedProject(h.db, TEST_ORG, "old", "archived");
      seedProject(h.db, OTHER_ORG, "elsewhere");
      const projects = await real(h).projectsOf(TEST_ORG, caller(OMAR, "owner"));
      expect(projects).toEqual([{ project: "billing", role: "maintainer" }, { project: "payments", role: "maintainer" }]);
      expect(await real(h).projectsOf(TEST_ORG, caller(LENA, "admin"))).toEqual(projects);
    });

    it("lists a member's grants with their roles, and a channel-only person's channel project as contributor", async () => {
      const h = await team();
      seedProject(h.db, TEST_ORG, "billing");
      grantRole(h.db, KIT, "viewer", { project: "billing" });
      expect(await real(h).projectsOf(TEST_ORG, caller(KIT))).toEqual([{ project: "billing", role: "viewer" }, { project: "payments", role: "contributor" }]);
      expect(await real(h).projectsOf(TEST_ORG, caller(MAYA))).toEqual([{ project: "payments", role: "contributor" }]);
      expect(await real(h).projectsOf(TEST_ORG, caller(NEO))).toEqual([]);
    });

    it("leaves out archived projects and projects with no revision, for members too", async () => {
      const h = await team();
      seedProject(h.db, TEST_ORG, "old", "archived");
      grantRole(h.db, KIT, "contributor", { project: "old" });
      grantRole(h.db, KIT, "contributor", { project: "ghost" });
      expect(await real(h).projectsOf(TEST_ORG, caller(KIT))).toEqual([{ project: "payments", role: "contributor" }]);
    });

    it("does not list an old administrator row as a project role", async () => {
      const h = await team();
      h.db.set({ ...projectMemberKey(TEST_ORG, NEO.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: NEO.developerId, projectName: "payments", role: "administrator", grantId: randomUUID() });
      expect(await real(h).projectsOf(TEST_ORG, caller(NEO))).toEqual([]);
    });

    it("reads grants in the asked org only", async () => {
      const h = await team();
      seedProject(h.db, OTHER_ORG, "payments");
      expect(await real(h).projectsOf(OTHER_ORG, caller(KIT))).toEqual([]);
    });
  });

  it("is built by createProjectMembers from a table, with channel access only when it is given", async () => {
    const h = await team();
    const bare = createProjectMembers({ documentClient: h.db, tableName: "state" });
    expect(await bare.roleOf(TEST_ORG, "payments", caller(MAYA))).toBeUndefined();
    const withChannels = createProjectMembers({ documentClient: h.db, tableName: "state", channelAccess: async (_org, _project, developerId) => developerId === MAYA.developerId });
    expect(await withChannels.roleOf(TEST_ORG, "payments", caller(MAYA))).toBe("contributor");
    expect(await bare.roleOf(TEST_ORG, "payments", caller(KIT))).toBe("contributor");
  });
});
