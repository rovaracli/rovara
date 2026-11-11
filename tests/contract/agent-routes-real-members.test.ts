// PF6: Plan 3's agent routes on Plan 2 Task 21's real `ProjectMembers`. The broker is built with `agents: {}` (as the deployed handler is), so
// it builds `createProjectMembers` itself over the table, and the people are real items: org members, a project's revision, and grants. One
// block per route family (agents, skills, roster, AI settings, approvals), each checking a role that comes from a grant and one from the org role.
import { StoredProjectDefinitionSchema } from "@agentx/cloud-contracts";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { agentApprovers } from "../../packages/broker/src/agents/changes.js";
import type { ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { createProjectMembers } from "../../packages/broker/src/org/project-members.js";
import type { AgentId } from "@rovara-code/contracts";
import type { OrgId } from "@rovara-code/contracts";
import type { OrgRole } from "../../packages/cloud-contracts/src/org-node.js";
import type { ProjectRole } from "@rovara-code/contracts";
import { orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey } from "@rovara-code/contracts";
import { OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const MAX = person("2", "Max"); // maintainer of web (a grant)
const CARL = person("3", "Carl"); // contributor on web (a grant)
const EVE = person("4", "Eve"); // a member with no role anywhere
const VIV = person("5", "Viv"); // viewer on web (a grant)
const COLE = person("7", "Cole"); // collaborator on web (a grant: role viewer, projectRole collaborator; decision 103)
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);

const SAFE = { instructions: "Summarise the open tickets.", sequence: [{ id: "work", name: "work", kind: "agent" as const, workspace: "none" as const }] };
const skillFile = (name: string) => `---\nname: ${name}\ndescription: Notes for ${name}\n---\nKeep notes short.\n`;

beforeAll(async () => { await loadSlackBroker(); });

type Reply = { status: number; body: Record<string, unknown> };
const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };

async function setup() {
  // No `projectMembers`: the broker builds the real ones.
  const h = await createDeveloperTaskBroker({ orgResolver, register: false, brokerExtra: { agents: {} } });
  const enroll = async (who: Developer, role: OrgRole) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
  };
  await enroll(DANA, "admin");
  for (const who of [MAX, CARL, EVE, VIV, COLE]) await enroll(who, "member");
  const project = (name: string, archived = false) => {
    h.db.set({ ...projectRevisionKey(TEST_ORG, name, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", definition: StoredProjectDefinitionSchema.parse({ name, revision: 1, repositories: [{ name: "repo", url: "https://github.example/example/repo", path: "repo", defaultBranch: "main", credentialRef: "test" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." }) });
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1 });
    if (archived) h.db.set({ ...projectMetaKey(TEST_ORG, name), entityType: "PROJECT_META", name, status: "archived", createdAt: "x", createdBy: DANA.developerId, archivedAt: "y", archivedBy: DANA.developerId });
  };
  const grant = (name: string, who: Developer, role: ProjectRole) => h.db.set({
    ...projectMemberKey(TEST_ORG, who.developerId, name), entityType: "MEMBERSHIP", ownerKey: who.developerId, grantId: randomUUID(), projectName: name,
    role: role === "viewer" ? "viewer" : "developer", projectRole: role, grantedBy: { developerId: DANA.developerId }, grantedAt: "2026-10-05T00:00:00.000Z",
  });
  project("web");
  project("old", true);
  for (const name of ["web", "old"]) { grant(name, MAX, "maintainer"); grant(name, CARL, "contributor"); grant(name, VIV, "viewer"); }
  h.db.set({ ...projectMemberKey(TEST_ORG, COLE.developerId, "web"), entityType: "MEMBERSHIP", ownerKey: COLE.developerId, grantId: randomUUID(), projectName: "web", role: "viewer", projectRole: "collaborator", grantedBy: { developerId: DANA.developerId }, grantedAt: "2026-10-05T00:00:00.000Z" });
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const create = async (who: Developer, extra: Record<string, unknown> = {}): Promise<AgentId> => {
    const created = await call(who, "POST", "/v1/app/agents", { name: `Agent ${randomUUID().slice(0, 8)}`, overlay: SAFE, ...extra });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body.agent as { agentId: AgentId }).agentId;
  };
  const real = createProjectMembers({ documentClient: h.db, tableName: "state" });
  return { ...h, call, create, real };
}

describe("the agent routes on the real project members", () => {
  it("gives a collaborator exactly a viewer's agent access: no use of a project's agent and no agent of its own for the project (decision 103)", async () => {
    const { call, create } = await setup();
    const owner = { kind: "project", project: "web" };
    const made = await create(MAX, { owner, accountable: { developerId: MAX.developerId } });
    const viewer = await call(VIV, "GET", `/v1/app/agents/${made}`);
    const collaborator = await call(COLE, "GET", `/v1/app/agents/${made}`);
    expect(collaborator).toEqual(viewer);
    expect(await call(CARL, "GET", `/v1/app/agents/${made}`)).not.toEqual(viewer);
    expect((await call(COLE, "POST", "/v1/app/agents", { name: "By Cole", overlay: SAFE, owner, accountable: { developerId: COLE.developerId } })).status).toBe(403);
  });

  it("agents: a project's maintainer (by grant) owns an agent for it, a contributor and an outsider may not, and an org admin may", async () => {
    const { call, create } = await setup();
    const owner = { kind: "project", project: "web" };
    const accountable = { developerId: MAX.developerId };
    const made = await create(MAX, { owner, accountable });
    expect((await call(CARL, "POST", "/v1/app/agents", { name: "By Carl", overlay: SAFE, owner, accountable })).status).toBe(403);
    expect((await call(VIV, "POST", "/v1/app/agents", { name: "By Viv", overlay: SAFE, owner, accountable })).status).toBe(403);
    expect([403, 404]).toContain((await call(EVE, "POST", "/v1/app/agents", { name: "By Eve", overlay: SAFE, owner, accountable })).status);
    await create(DANA, { owner, accountable });
    // A project's agent is seen and managed through the project: Max (maintainer) can read it, Eve (no role) cannot reach it.
    expect((await call(MAX, "GET", `/v1/app/agents/${made}`)).status).toBe(200);
    expect((await call(EVE, "GET", `/v1/app/agents/${made}`)).status).toBe(404);
  });

  it("skills: the owner rules read a maintainer's role from the grant", async () => {
    const { call } = await setup();
    const project = { kind: "project", project: "web" };
    expect((await call(CARL, "POST", "/v1/app/skills", { content: skillFile("a-skill"), owner: project })).status).toBe(403);
    const mine = await call(MAX, "POST", "/v1/app/skills", { content: skillFile("a-skill"), owner: project });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(mine.body.skill).toMatchObject({ owner: project });
    expect((await call(DANA, "POST", "/v1/app/skills", { content: skillFile("b-skill"), owner: project })).status).toBe(201);
    expect(errorOf(await call(CARL, "POST", "/v1/app/skills", { content: skillFile("c-skill"), owner: project })).message).toBe("Only a maintainer of web can make it a skill's owner.");
  });

  it("roster: anyone with a role lists it, only a maintainer changes it, an outsider sees no such project, and an archived one takes no change", async () => {
    const { call, create } = await setup();
    const agentId = await create(MAX);
    expect((await call(MAX, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "project", project: "web" }, level: "use" }] })).status).toBe(200);
    const listed = await call(VIV, "GET", "/v1/app/projects/web/agents");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    for (const path of ["/v1/app/projects/web/agents", "/v1/app/projects/nope/agents"]) {
      const reply = await call(EVE, "GET", path);
      expect(reply.status, path).toBe(404);
      expect(errorOf(reply).code).toBe("PROJECT_NOT_FOUND");
    }
    expect((await call(CARL, "PUT", `/v1/app/projects/web/agents/${agentId}`, {})).status).toBe(403);
    expect((await call(MAX, "PUT", `/v1/app/projects/web/agents/${agentId}`, {})).status).toBe(200);
    expect((await call(DANA, "PUT", `/v1/app/projects/web/agents/${agentId}`, {})).status).toBe(200);
    const old = await call(MAX, "PUT", `/v1/app/projects/old/agents/${agentId}`, {});
    expect(old.status, JSON.stringify(old.body)).toBeGreaterThanOrEqual(400);
  });

  it("AI settings: a role on the project reads them, an org admin changes them, an outsider is told nothing", async () => {
    const { call } = await setup();
    expect((await call(VIV, "GET", "/v1/app/projects/web/ai")).status).toBe(200);
    expect((await call(MAX, "PUT", "/v1/app/projects/web/ai", { projectPays: true })).status).toBe(403);
    expect((await call(DANA, "PUT", "/v1/app/projects/web/ai", { monthlyBudgetUsd: 200, projectPays: true })).status).toBe(200);
    expect(errorOf(await call(EVE, "GET", "/v1/app/projects/web/ai")).code).toBe("PROJECT_NOT_FOUND");
  });

  it("approvals: a project agent's change is shown to its maintainers and the org's admins, each once", async () => {
    const { db, create, real } = await setup();
    const agentId = await create(MAX, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    const store = new AgentStore({ documentClient: db, tableName: "state", now: Date.now });
    const deps: ApprovalDependencies = {
      store, projectMembers: real, documentClient: db, tableName: "state", now: Date.now, confirmOrigin: "https://cell.example.com",
      signInStore: new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: Date.now }),
    };
    const agent = (await store.get(TEST_ORG, agentId))!;
    const spec = await agentApprovers(deps, agent, "agent_publish");
    if (spec.kind !== "rule") throw new Error("expected a rule");
    expect([...spec.candidates].sort()).toEqual([DANA.developerId, MAX.developerId].sort());
  });
});
