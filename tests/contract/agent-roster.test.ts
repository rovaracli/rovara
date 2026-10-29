import { fixtureActor } from "../support/money-authority.js";
// Plan 3 Task 10: which agents work on a project (the roster), and how the agent a run uses is chosen and checked. The routes go through
// the broker's handler; `resolveAgentForTask` and `resolveAgentForAutonomousRun` are called with the same dependencies the routes use.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentStore, resolveAgent } from "../../packages/broker/src/agents/store.js";
import type { ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import type { AgentCaller } from "../../packages/broker/src/agents/access.js";
import { writeGuardrails } from "../../packages/broker/src/agents/guardrails.js";
import { requireRecipeAllowed, resolveAgentForAutonomousRun, resolveAgentForTask } from "../../packages/broker/src/agents/roster.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { agentXError } from "@agentx/contracts";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import type { AgentId } from "../../packages/contracts/src/agent-node.js";
import { DEFAULT_AGENT_GUARDRAILS, type AgentGuardrails } from "../../packages/contracts/src/agent-guardrails.js";
import { BUILTIN_AGENTS } from "../../packages/contracts/src/agent-templates.js";
import { recipeDigest, type RecipeOverlay, type ResolvedRecipe } from "../../packages/contracts/src/agent-recipe-node.js";
import type { ModelIdentifier } from "../../packages/contracts/src/models-node.js";
import type { OrgId, OrgRole } from "../../packages/contracts/src/org-node.js";
import { agentRequestKey, orgProjectCatalogKey, projectAgentKey, projectMetaKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const MAX = person("2", "Max"); // maintainer of web and old
const CARL = person("3", "Carl"); // contributor on web and old
const EVE = person("4", "Eve"); // a member with no role anywhere
const VIV = person("5", "Viv"); // viewer on web and old
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);

const claude = (modelId: string): ModelIdentifier => ({ provider: "anthropic", modelId });
const SONNET = claude("claude-sonnet-4-6");
const OPUS = claude("claude-opus-4-7");

const agentStep = (id: string, settings: Record<string, unknown> = {}) => ({ id, name: id, kind: "agent" as const, workspace: "none" as const, ...(Object.keys(settings).length === 0 ? {} : { settings }) });
const overlayWith = (settings: Record<string, unknown> = {}, extra: Partial<RecipeOverlay> = {}): RecipeOverlay => ({ instructions: "Summarise the open tickets.", sequence: [agentStep("work", settings)], ...extra });
const SAFE = overlayWith();

beforeAll(async () => { await loadSlackBroker(); });

type Reply = { status: number; body: Record<string, unknown> };
const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };
const callerOf = (who: Developer, orgRole: OrgRole = "member"): AgentCaller => ({ orgId: TEST_ORG, developerId: who.developerId, orgRole });

/** The refusal a promise ends in: its code and its message without the `CODE: ` prefix the error class adds. */
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

async function setup(options: { builtins?: ConstructorParameters<typeof AgentStore>[0]["builtins"] } = {}) {
  const members = new FakeProjectMembers();
  const h = await createDeveloperTaskBroker({
    orgResolver, register: false,
    brokerExtra: { agents: { projectMembers: members, ...(options.builtins === undefined ? {} : { builtins: options.builtins }) } },
  });
  const enroll = async (who: Developer, role: OrgRole) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
  };
  await enroll(DANA, "admin");
  for (const who of [MAX, CARL, EVE, VIV]) await enroll(who, "member");
  for (const project of ["web", "old"]) {
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, project), entityType: "PROJECT_CATALOG", name: project });
    members.grant(TEST_ORG, project, MAX.developerId, "maintainer");
    members.grant(TEST_ORG, project, CARL.developerId, "contributor");
    members.grant(TEST_ORG, project, VIV.developerId, "viewer");
  }
  // `old` is archived: it refuses new work and any change of who works on it.
  h.db.set({ ...projectMetaKey(TEST_ORG, "old"), entityType: "PROJECT_META", name: "old", status: "archived", createdAt: "2026-01-01T00:00:00.000Z", createdBy: DANA.developerId, archivedAt: "2026-02-01T00:00:00.000Z", archivedBy: DANA.developerId });
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now, ...(options.builtins === undefined ? {} : { builtins: options.builtins }) });
  const deps: ApprovalDependencies = {
    store, projectMembers: members, documentClient: h.db, tableName: "state", now: Date.now, confirmOrigin: "https://cell.example.com",
    signInStore: new DeveloperSignInStore({ documentClient: h.db, tableName: "signin", now: Date.now }),
  };
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const create = async (who: Developer, overlay: RecipeOverlay = SAFE, name = `Agent ${randomUUID().slice(0, 8)}`): Promise<AgentId> => {
    const created = await call(who, "POST", "/v1/app/agents", { name, overlay });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body.agent as { agentId: AgentId }).agentId;
  };
  /** Publishes `overlay` as the agent's next version directly in the store, skipping the guardrails, as a version from before they tightened. */
  const seed = async (agentId: AgentId, overlay: RecipeOverlay = SAFE) => {
    const draft = (await store.getDraft(TEST_ORG, agentId))!;
    await store.saveDraft({ orgId: TEST_ORG, agentId, overlay, expectedRevision: draft.revision, by: DANA.developerId });
    const agent = (await store.get(TEST_ORG, agentId))!;
    await store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")), by: DANA.developerId });
  };
  /** A published agent owned by Max, shared with the web project (`use`), so a contributor there may run it. */
  const sharedWithWeb = async (overlay: RecipeOverlay = SAFE) => {
    const agentId = await create(MAX, overlay);
    await seed(agentId, overlay);
    const shared = await call(MAX, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "project", project: "web" }, level: "use" }] });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    return agentId;
  };
  const addToRoster = async (who: Developer, project: string, agentId: AgentId): Promise<Reply> => call(who, "PUT", `/v1/app/projects/${project}/agents/${agentId}`, {});
  const setGuardrails = (changes: Partial<AgentGuardrails>) => writeGuardrails(deps, TEST_ORG, { ...structuredClone(DEFAULT_AGENT_GUARDRAILS), ...changes }, fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
  const rosterOf = async (who: Developer, project = "web") => {
    const listed = await call(who, "GET", `/v1/app/projects/${project}/agents`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    return listed.body.agents as Array<{ agentId: AgentId; name: string; builtin: boolean; disabled?: boolean; status: string }>;
  };
  return { ...h, members, store, deps, call, create, seed, sharedWithWeb, addToRoster, setGuardrails, rosterOf };
}

const WEB_AGENT_PATH = (agentId: string, project = "web") => `/v1/app/projects/${project}/agents/${agentId}`;

describe("the roster routes", () => {
  it("lists the enabled built-ins first, then the agents added to the project", async () => {
    const { rosterOf, sharedWithWeb, addToRoster, store } = await setup();
    const first = await sharedWithWeb();
    const second = await sharedWithWeb();
    expect((await addToRoster(MAX, "web", second)).status).toBe(200);
    expect((await addToRoster(MAX, "web", first)).status).toBe(200);
    const listed = await rosterOf(VIV);
    const builtins = Object.keys(BUILTIN_AGENTS);
    expect(listed.slice(0, builtins.length).map((entry) => entry.agentId)).toEqual(builtins);
    expect(listed.slice(0, builtins.length).every((entry) => entry.builtin)).toBe(true);
    // The custom ones follow, in the order of their ids.
    expect(listed.slice(builtins.length).map((entry) => entry.agentId)).toEqual([first, second].sort());
    expect(listed.slice(builtins.length)[0]).toMatchObject({ builtin: false, status: "active", name: (await store.get(TEST_ORG, [first, second].sort()[0] as AgentId))!.name });
  });

  it("shows nothing of a project to someone with no role on it, and nothing of an unknown project", async () => {
    const { call } = await setup();
    for (const path of ["/v1/app/projects/web/agents", "/v1/app/projects/nope/agents"]) {
      const reply = await call(EVE, "GET", path);
      expect(reply.status, path).toBe(404);
      expect(errorOf(reply).code).toBe("PROJECT_NOT_FOUND");
    }
  });

  it("lets only a maintainer add or remove an agent", async () => {
    const { call, sharedWithWeb, addToRoster, rosterOf } = await setup();
    const agentId = await sharedWithWeb();
    for (const who of [CARL, VIV]) {
      const refused = await addToRoster(who, "web", agentId);
      expect(refused.status, who.name).toBe(403);
      expect(errorOf(refused)).toEqual({ code: "FORBIDDEN", message: "Only a maintainer of web can change which agents work on it." });
    }
    expect((await addToRoster(EVE, "web", agentId)).status).toBe(404);
    expect((await rosterOf(MAX)).some((entry) => entry.agentId === agentId)).toBe(false);

    const added = await addToRoster(MAX, "web", agentId);
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.agent).toMatchObject({ agentId, builtin: false, addedBy: MAX.developerId });
    expect((await rosterOf(CARL)).some((entry) => entry.agentId === agentId)).toBe(true);

    expect((await call(CARL, "DELETE", WEB_AGENT_PATH(agentId), {})).status).toBe(403);
    const removed = await call(MAX, "DELETE", WEB_AGENT_PATH(agentId), {});
    expect(removed).toEqual({ status: 200, body: { removed: true } });
    expect((await rosterOf(CARL)).some((entry) => entry.agentId === agentId)).toBe(false);
    // Removing what is not there is not an error.
    expect(await call(MAX, "DELETE", WEB_AGENT_PATH(agentId), {})).toEqual({ status: 200, body: { removed: false } });
  });

  it("lets an org admin add an agent to any project", async () => {
    const { sharedWithWeb, addToRoster } = await setup();
    expect((await addToRoster(DANA, "web", await sharedWithWeb())).status).toBe(200);
  });

  it("needs use on the agent, and answers 404 for one the maintainer cannot see", async () => {
    const { create, addToRoster, call } = await setup();
    const carls = await create(CARL);
    const hidden = await addToRoster(MAX, "web", carls);
    expect(hidden.status).toBe(404);
    // View alone is not enough either.
    await call(CARL, "PUT", `/v1/app/agents/${carls}/shares`, { shares: [{ principal: { kind: "member", developerId: MAX.developerId }, level: "view" }] });
    const viewOnly = await addToRoster(MAX, "web", carls);
    expect(viewOnly.status).toBe(403);
    expect(errorOf(viewOnly).code).toBe("FORBIDDEN");
    await call(CARL, "PUT", `/v1/app/agents/${carls}/shares`, { shares: [{ principal: { kind: "member", developerId: MAX.developerId }, level: "use" }] });
    expect((await addToRoster(MAX, "web", carls)).status).toBe(200);
  });

  it("answers 404 for an agent of another company, and refuses a built-in, which is on every project already", async () => {
    const { store, addToRoster } = await setup();
    const other = await store.create({ orgId: ORG_B, name: "Other company agent", owner: { kind: "member", developerId: OMAR.developerId }, createdBy: OMAR.developerId });
    expect((await addToRoster(DANA, "web", other.agentId)).status).toBe(404);
    const builtin = await addToRoster(MAX, "web", "rovara-code");
    expect(builtin.status).toBe(400);
    expect(errorOf(builtin)).toEqual({ code: "CONFIG_INVALID", message: "Built-in agents are on every project already." });
  });

  it("refuses an archived agent", async () => {
    const { sharedWithWeb, addToRoster, call } = await setup();
    const agentId = await sharedWithWeb();
    expect((await call(MAX, "POST", `/v1/app/agents/${agentId}/archive`, {})).status).toBe(200);
    const refused = await addToRoster(MAX, "web", agentId);
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe("AGENT_UNAVAILABLE");
  });

  it("refuses to change the roster of an archived project, and still shows it", async () => {
    const { create, call, rosterOf } = await setup();
    const agentId = await create(MAX);
    for (const [who, method] of [[MAX, "PUT"], [MAX, "DELETE"], [DANA, "PUT"]] as const) {
      const refused = await call(who, method, WEB_AGENT_PATH(agentId, "old"), {});
      expect(refused.status, `${who.name} ${method}`).toBe(409);
      expect(errorOf(refused).code).toBe("PROJECT_ARCHIVED");
    }
    expect((await rosterOf(VIV, "old")).length).toBe(Object.keys(BUILTIN_AGENTS).length);
  });

  it("hides a built-in the company turned off from members, and shows it to an admin marked", async () => {
    const { rosterOf, setGuardrails } = await setup();
    await setGuardrails({ disabledBuiltins: ["service-reviewer"] });
    expect((await rosterOf(VIV)).map((entry) => entry.agentId)).not.toContain("service-reviewer");
    const forAdmin = await rosterOf(DANA);
    expect(forAdmin.find((entry) => entry.agentId === "service-reviewer")).toMatchObject({ builtin: true, disabled: true });
    expect(forAdmin.find((entry) => entry.agentId === "rovara-code")?.disabled).toBeUndefined();
  });

  it("answers a repeated request with the first answer and writes it once, with the request item in the same change", async () => {
    const { sharedWithWeb, dev, db } = await setup();
    const agentId = await sharedWithWeb();
    const body = { requestId: randomUUID() };
    const first = await dev(MAX, "PUT", WEB_AGENT_PATH(agentId), body);
    expect(first.status).toBe(200);
    expect(db.get(projectAgentKey(TEST_ORG, "web", agentId))).toMatchObject({ addedBy: MAX.developerId });
    expect(db.get(agentRequestKey(TEST_ORG, MAX.developerId, body.requestId))).toBeDefined();
    // Someone else removes it; the repeat is still answered from the mark and adds nothing back.
    expect((await dev(DANA, "DELETE", WEB_AGENT_PATH(agentId), { requestId: randomUUID() })).status).toBe(200);
    const again = await dev(MAX, "PUT", WEB_AGENT_PATH(agentId), body);
    expect(again.status).toBe(200);
    expect(again.body.agent).toEqual(first.body.agent);
    expect(db.get(projectAgentKey(TEST_ORG, "web", agentId))).toBeUndefined();
    // The same id for another request is a mistake.
    const other = await sharedWithWeb();
    const mixed = await dev(MAX, "PUT", WEB_AGENT_PATH(other), body);
    expect(mixed.status).toBe(400);
    expect(errorOf(mixed)).toEqual({ code: "CONFIG_INVALID", message: "requestId: this request ID was already used for a different request" });
  });

  it("writes a removal's request item with it, and adding an agent already on the roster changes nothing", async () => {
    const { sharedWithWeb, addToRoster, dev, db } = await setup();
    const agentId = await sharedWithWeb();
    await addToRoster(MAX, "web", agentId);
    const addedAt = (db.get(projectAgentKey(TEST_ORG, "web", agentId)) as { addedAt: string }).addedAt;
    const second = await addToRoster(DANA, "web", agentId);
    expect(second.status).toBe(200);
    expect(db.get(projectAgentKey(TEST_ORG, "web", agentId))).toMatchObject({ addedBy: MAX.developerId, addedAt });
    const body = { requestId: randomUUID() };
    expect((await dev(MAX, "DELETE", WEB_AGENT_PATH(agentId), body)).body).toMatchObject({ removed: true });
    expect(db.get(agentRequestKey(TEST_ORG, MAX.developerId, body.requestId))).toBeDefined();
  });

  it("refuses a body it does not know, and leaves the other project paths to the tasks that build them", async () => {
    const { call, sharedWithWeb } = await setup();
    const agentId = await sharedWithWeb();
    expect((await call(MAX, "PUT", WEB_AGENT_PATH(agentId), { surprise: 1 })).status).toBe(400);
    // Task 13 built the connectors route: a maintainer of web on an install that isn't Rovara Cloud is told to ask an administrator.
    expect((await call(MAX, "GET", "/v1/app/projects/web/connectors")).status).toBe(403);
    expect((await call(MAX, "GET", `${WEB_AGENT_PATH(agentId)}/more`)).status).toBe(404);
  });
});

describe("resolveAgentForTask", () => {
  it("runs Rovara Code at the company's pinned version when no agent is named", async () => {
    const { deps, store } = await setup();
    const resolved = await resolveAgentForTask(deps, callerOf(CARL), { project: "web" });
    expect(resolved.testRun).toBe(false);
    expect(resolved.ref).toEqual({ agentId: "rovara-code", name: BUILTIN_AGENTS["rovara-code"].name, version: store.builtinDefaultPin("rovara-code"), builtin: true, digest: recipeDigest(resolved.recipe) });
    expect(resolved.digest).toBe(resolved.ref.digest);
    expect(resolved.recipe).toEqual(await resolveAgent(store, TEST_ORG, "rovara-code", "current"));
  });

  it("refuses new work in an archived project first, then a viewer, with Plan 2's messages", async () => {
    const { deps } = await setup();
    expect(await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "old" }))).toEqual({ code: "PROJECT_ARCHIVED", message: "Project `old` is archived. Ask a project maintainer to restore it." });
    // The archive refusal comes before the viewer's.
    expect((await refusal(resolveAgentForTask(deps, callerOf(VIV), { project: "old" })))?.code).toBe("PROJECT_ARCHIVED");
    expect(await refusal(resolveAgentForTask(deps, callerOf(VIV), { project: "web" }))).toEqual({
      code: "PROJECT_ACCESS_DENIED", message: "You can view `web` but not start tasks in it. Ask a maintainer to make you a contributor.",
    });
  });

  it("refuses someone with no role on the project, or a project that does not exist", async () => {
    const { deps } = await setup();
    expect((await refusal(resolveAgentForTask(deps, callerOf(EVE), { project: "web" })))?.code).toBe("PROJECT_NOT_FOUND");
    expect((await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "nope" })))?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("lets the caller's own access check stand in for step 1 when the role is passed", async () => {
    const { deps, members } = await setup();
    const before = members.calls.length;
    // The run route has already checked access and new work; nothing is read again, even where the project is archived.
    const resolved = await resolveAgentForTask(deps, callerOf(CARL), { project: "old", role: "contributor" });
    expect(resolved.ref.agentId).toBe("rovara-code");
    expect(members.calls.slice(before)).toEqual([]);
  });

  it("uses the access check it is given in place of the project members", async () => {
    const { deps } = await setup();
    const asked: string[] = [];
    const checking = { ...deps, checkProjectAccess: async (_caller: AgentCaller, project: string) => { asked.push(project); return { role: "contributor" as const }; } };
    await resolveAgentForTask(checking, callerOf(EVE), { project: "web" });
    expect(asked).toEqual(["web"]);
  });

  it("says a custom agent isn't on the project yet, and runs it once a maintainer adds it", async () => {
    const { deps, sharedWithWeb, addToRoster, store } = await setup();
    const agentId = await sharedWithWeb();
    const name = (await store.get(TEST_ORG, agentId))!.name;
    expect(await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId } }))).toEqual({
      code: "AGENT_NOT_ON_PROJECT", message: `${name} isn't working on web yet. Ask a project maintainer to add it.`,
    });
    expect((await addToRoster(MAX, "web", agentId)).status).toBe(200);
    const resolved = await resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId } });
    expect(resolved.testRun).toBe(false);
    expect(resolved.ref).toEqual({ agentId, name, version: 1, builtin: false, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, 1)) });
    expect(resolved.digest).toBe(resolved.ref.digest);
  });

  it("is not on the project for a different project: the roster is per project", async () => {
    const { deps, sharedWithWeb, addToRoster, call } = await setup();
    const agentId = await sharedWithWeb();
    await call(MAX, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "project", project: "web" }, level: "use" }, { principal: { kind: "member", developerId: CARL.developerId }, level: "use" }] });
    await addToRoster(MAX, "web", agentId);
    expect((await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "old", role: "contributor", agent: { agentId } })))?.code).toBe("AGENT_NOT_ON_PROJECT");
  });

  it("gives an agent the caller cannot see the same 404 as one that does not exist, and a cross-company agent too", async () => {
    const { deps, create, store } = await setup();
    const carls = await create(CARL);
    expect((await refusal(resolveAgentForTask(deps, callerOf(EVE, "member"), { project: "web", role: "contributor", agent: { agentId: carls } })))?.code).toBe("NOT_FOUND");
    const other = await store.create({ orgId: ORG_B, name: "Other company agent", owner: { kind: "member", developerId: OMAR.developerId }, createdBy: OMAR.developerId });
    expect((await refusal(resolveAgentForTask(deps, callerOf(DANA, "admin"), { project: "web", agent: { agentId: other.agentId } })))?.code).toBe("NOT_FOUND");
  });

  it("asks for use: a view-only share is refused", async () => {
    const { deps, create, call } = await setup();
    const agentId = await create(MAX);
    await call(MAX, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "member", developerId: CARL.developerId }, level: "view" }] });
    expect((await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId } })))?.code).toBe("FORBIDDEN");
  });

  it("refuses a built-in the company turned off, and still runs a custom agent built on it", async () => {
    const { deps, setGuardrails, seed, addToRoster, call } = await setup();
    const built = await call(MAX, "POST", "/v1/app/agents", { name: "On code", extends: "service-reviewer", overlay: SAFE });
    expect(built.status, JSON.stringify(built.body)).toBe(201);
    const onTop = (built.body.agent as { agentId: AgentId }).agentId;
    await seed(onTop);
    await setGuardrails({ disabledBuiltins: ["service-reviewer"] });
    expect(await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId: "service-reviewer" } }))).toEqual({
      code: "AGENT_UNAVAILABLE", message: `${BUILTIN_AGENTS["service-reviewer"].name} is turned off in your company. Ask an admin to turn it on.`,
    });
    expect((await addToRoster(MAX, "web", onTop)).status).toBe(200);
    expect((await resolveAgentForTask(deps, callerOf(MAX), { project: "web", agent: { agentId: onTop } })).ref.agentId).toBe(onTop);
  });

  it("runs an enabled built-in at a version asked for, and refuses one that does not exist", async () => {
    const { deps } = await setup();
    const resolved = await resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId: "rovara-code", version: 1 } });
    expect(resolved.ref).toMatchObject({ agentId: "rovara-code", version: 1, builtin: true });
    expect((await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId: "rovara-code", version: 99 } })))?.code).toBe("NOT_FOUND");
  });

  it("refuses an archived agent, and one nothing has been published for", async () => {
    const { deps, sharedWithWeb, addToRoster, call, create } = await setup();
    const archived = await sharedWithWeb();
    await addToRoster(MAX, "web", archived);
    await call(MAX, "POST", `/v1/app/agents/${archived}/archive`, {});
    // The owner may still see it (manage), but it starts no new work.
    expect(await refusal(resolveAgentForTask(deps, callerOf(MAX), { project: "web", agent: { agentId: archived } }))).toMatchObject({ code: "AGENT_UNAVAILABLE" });

    const unpublished = await create(MAX);
    await addToRoster(MAX, "web", unpublished);
    const refused = await refusal(resolveAgentForTask(deps, callerOf(MAX), { project: "web", agent: { agentId: unpublished } }));
    expect(refused).toMatchObject({ code: "AGENT_UNAVAILABLE" });
    expect(refused?.message).toContain("has no published version");
  });

  describe("a draft test run", () => {
    it("is refused to someone who may only use the agent", async () => {
      const { deps, sharedWithWeb, addToRoster } = await setup();
      const agentId = await sharedWithWeb();
      await addToRoster(MAX, "web", agentId);
      const refused = await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId, version: "draft" } }));
      expect(refused?.code).toBe("FORBIDDEN");
      expect(refused?.message).toContain("edit needs");
    });

    it("lets an owner test their own draft on a project it isn't on, as a test run", async () => {
      const { deps, create, store } = await setup();
      const agentId = await create(CARL);
      const resolved = await resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId, version: "draft" } });
      expect(resolved.testRun).toBe(true);
      expect(resolved.ref).toEqual({ agentId, name: (await store.get(TEST_ORG, agentId))!.name, version: "draft", builtin: false, draftRevision: 1, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")) });
    });

    it("still needs the project to take new work, and a built-in has no draft", async () => {
      const { deps, create } = await setup();
      const agentId = await create(MAX);
      expect((await refusal(resolveAgentForTask(deps, callerOf(MAX), { project: "old", agent: { agentId, version: "draft" } })))?.code).toBe("PROJECT_ARCHIVED");
      expect((await refusal(resolveAgentForTask(deps, callerOf(DANA, "admin"), { project: "web", agent: { agentId: "rovara-code", version: "draft" } })))?.code).toBe("FORBIDDEN");
    });

    it("resolves the draft's skills as they are now, where a published version keeps the digest it was published with", async () => {
      const { deps, store, create, seed, addToRoster } = await setup();
      const skillText = (line: string) => `---\nname: triage-notes\ndescription: Use when triaging tickets.\n---\n${line}\n`;
      const skill = await store.skills.create({ orgId: TEST_ORG, content: skillText("1. Read the ticket."), owner: { kind: "member", developerId: MAX.developerId }, by: MAX.developerId });
      const withSkill = overlayWith({}, { skills: { add: [{ skillId: skill.skillId }] } });
      const agentId = await create(MAX, withSkill);
      await seed(agentId, withSkill);
      await addToRoster(MAX, "web", agentId);
      await store.skills.putContent({ orgId: TEST_ORG, skillId: skill.skillId, content: skillText("1. Read the ticket. 2. Reply."), expectedDigest: skill.currentDigest, by: MAX.developerId });
      const digestOf = (resolved: Awaited<ReturnType<typeof resolveAgentForTask>>) => resolved.recipe.skills.map((entry) => entry.digest);
      const published = await resolveAgentForTask(deps, callerOf(MAX), { project: "web", agent: { agentId } });
      const draft = await resolveAgentForTask(deps, callerOf(MAX), { project: "web", agent: { agentId, version: "draft" } });
      expect(digestOf(published)).toEqual([skill.currentDigest]);
      expect(digestOf(draft)).toHaveLength(1);
      expect(digestOf(draft)).not.toEqual(digestOf(published));
    });
  });

  it("runs published version 1 of an agent shared for use as a normal run, while a later version is current", async () => {
    const { deps, sharedWithWeb, addToRoster, seed, store } = await setup();
    const agentId = await sharedWithWeb();
    await seed(agentId, overlayWith({}, { instructions: "A second version." }));
    await addToRoster(MAX, "web", agentId);
    const pinned = await resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId, version: 1 } });
    expect(pinned.testRun).toBe(false);
    expect(pinned.ref).toMatchObject({ version: 1, builtin: false });
    expect(pinned.ref).not.toHaveProperty("draftRevision");
    const current = await resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId } });
    expect(current.ref.version).toBe(2);
    expect(current.digest).not.toBe(pinned.digest);
    expect(pinned.digest).toBe(recipeDigest(await resolveAgent(store, TEST_ORG, agentId, 1)));
    expect((await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId, version: 7 } })))?.code).toBe("NOT_FOUND");
  });

  describe("the guardrails as they stand now", () => {
    it("refuses a model forbidden since the version was published as MODEL_NOT_ALLOWED, naming the step", async () => {
      const { deps, sharedWithWeb, addToRoster, setGuardrails, store } = await setup();
      const agentId = await sharedWithWeb(overlayWith({ model: OPUS }));
      await addToRoster(MAX, "web", agentId);
      expect((await resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId } })).ref.version).toBe(1);
      await setGuardrails({ forbiddenModels: [OPUS] });
      const name = (await store.get(TEST_ORG, agentId))!.name;
      expect(await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId } }))).toEqual({
        code: "MODEL_NOT_ALLOWED", message: `${name}'s work step uses anthropic/claude-opus-4-7, which isn't allowed on web. Ask the agent's owner to pick another model.`,
      });
    });

    it("names the fallback model when that is the one", async () => {
      const { deps, sharedWithWeb, addToRoster, setGuardrails } = await setup();
      const agentId = await sharedWithWeb(overlayWith({ model: SONNET, fallbackModel: OPUS }));
      await addToRoster(MAX, "web", agentId);
      await setGuardrails({ forbiddenModels: [OPUS] });
      const refused = await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId } }));
      expect(refused?.code).toBe("MODEL_NOT_ALLOWED");
      expect(refused?.message).toContain("work step uses anthropic/claude-opus-4-7");
    });

    it("refuses anything else the guardrails now forbid as CONFIG_INVALID, with its path", async () => {
      const { deps, sharedWithWeb, addToRoster, setGuardrails } = await setup();
      const agentId = await sharedWithWeb(overlayWith({ stepBudgetUsd: 4 }));
      await addToRoster(MAX, "web", agentId);
      await setGuardrails({ maxStepBudgetUsd: 3 });
      expect(await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId } }))).toEqual({
        code: "CONFIG_INVALID", message: "steps.0.settings.stepBudgetUsd: $4 is more than your company allows for one step ($3)",
      });
    });

    it("checks a built-in's recipe against them too", async () => {
      const { deps, setGuardrails } = await setup();
      // Rovara Code builds, so a company that has forbidden every autonomy above `suggest` refuses it too.
      await setGuardrails({ maxAutonomy: "suggest" });
      const refused = await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "web" }));
      expect(refused?.code).toBe("CONFIG_INVALID");
      expect(refused?.message).toMatch(/^autonomy: /);
    });
  });
});

describe("resolveAgentForAutonomousRun", () => {
  it("refuses an archived project", async () => {
    const { deps } = await setup();
    expect(await refusal(resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "old", agentId: "rovara-code" }))).toEqual({
      code: "PROJECT_ARCHIVED", message: "Project `old` is archived. Ask a project maintainer to restore it.",
    });
  });

  it("refuses a custom agent that is off the roster, and runs it once it is on", async () => {
    const { deps, sharedWithWeb, addToRoster, store } = await setup();
    const agentId = await sharedWithWeb();
    const name = (await store.get(TEST_ORG, agentId))!.name;
    expect(await refusal(resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId }))).toEqual({
      code: "AGENT_NOT_ON_PROJECT", message: `${name} isn't working on web yet. Ask a project maintainer to add it.`,
    });
    await addToRoster(MAX, "web", agentId);
    const resolved = await resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId });
    expect(resolved.ref).toEqual({ agentId, name, version: 1, builtin: false, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, 1)) });
    expect(resolved.recipe.chain.at(-1)).toMatchObject({ agentId });
  });

  it("needs no person: a built-in is on every roster, at the pinned version unless one is named", async () => {
    const { deps, store } = await setup();
    const pinned = await resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId: "ticket-triage" });
    expect(pinned.ref).toMatchObject({ agentId: "ticket-triage", builtin: true, version: store.builtinLatestVersion("ticket-triage") });
    const named = await resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId: "ticket-triage", version: 1 });
    expect(named.ref.version).toBe(1);
  });

  it("runs the version it is told to, not the current one", async () => {
    const { deps, sharedWithWeb, addToRoster, seed } = await setup();
    const agentId = await sharedWithWeb();
    await seed(agentId, overlayWith({}, { instructions: "A second version." }));
    await addToRoster(MAX, "web", agentId);
    expect((await resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId, version: 1 })).ref.version).toBe(1);
    expect((await resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId })).ref.version).toBe(2);
  });

  it("refuses a turned-off built-in, an archived agent, an agent of another company and a model now forbidden", async () => {
    const { deps, sharedWithWeb, addToRoster, call, setGuardrails, store } = await setup();
    const archived = await sharedWithWeb();
    await addToRoster(MAX, "web", archived);
    await call(MAX, "POST", `/v1/app/agents/${archived}/archive`, {});
    expect((await refusal(resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId: archived })))?.code).toBe("AGENT_UNAVAILABLE");

    const other = await store.create({ orgId: ORG_B, name: "Other company agent", owner: { kind: "member", developerId: OMAR.developerId }, createdBy: OMAR.developerId });
    expect((await refusal(resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId: other.agentId })))?.code).toBe("NOT_FOUND");

    const risky = await sharedWithWeb(overlayWith({ model: OPUS }));
    await addToRoster(MAX, "web", risky);
    await setGuardrails({ disabledBuiltins: ["ticket-triage"], forbiddenModels: [OPUS] });
    expect((await refusal(resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId: "ticket-triage" })))?.code).toBe("AGENT_UNAVAILABLE");
    expect((await refusal(resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId: risky })))?.code).toBe("MODEL_NOT_ALLOWED");
  });

  it("does not read a person's access: no role lookup is made", async () => {
    const { deps, members, sharedWithWeb, addToRoster } = await setup();
    const agentId = await sharedWithWeb();
    await addToRoster(MAX, "web", agentId);
    const before = members.calls.length;
    await resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId });
    expect(members.calls.slice(before)).toEqual([]);
  });
});

// ---- fix round 1

/** ticket-triage with a second release that adds a read_write grant: what an admin has to adopt before anyone runs it. */
function twoReleases() {
  const shipped = BUILTIN_AGENTS["ticket-triage"].versions[0]!.recipe;
  const widened: ResolvedRecipe = { ...structuredClone(shipped), tools: [...structuredClone(shipped.tools), { connector: { name: "docs" }, access: "read_write" }] };
  const state = { latest: 1 };
  return {
    state,
    source: {
      currentVersion: (id: string) => (id === "ticket-triage" ? state.latest : 1),
      defaultPin: (id: string) => (id === "ticket-triage" ? state.latest : 1),
      recipe: (id: string, version: number) => {
        const found = id === "ticket-triage" ? [undefined, shipped, widened][version] : BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].versions[version - 1]?.recipe;
        if (found === undefined) throw agentXError("NOT_FOUND", `${id} has no version ${String(version)}`);
        return structuredClone(found);
      },
      name: (id: string) => BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].name,
    },
  };
}

describe("a built-in runs only at a version the company has adopted", () => {
  const unadopted = (name: string, version: number) => ({
    code: "FORBIDDEN", message: `${name} version ${String(version)} hasn't been adopted by your company yet. An org admin can adopt it first.`,
  });

  it("refuses a release above the company's pin for a person and for an autonomous run, and allows the pin and anything below it", async () => {
    const { source, state } = twoReleases();
    const { deps, store } = await setup({ builtins: source });
    // The company is pinned to release 1 before release 2 ships.
    await store.ensureBuiltinSettings(TEST_ORG, "ticket-triage");
    state.latest = 2;
    const name = BUILTIN_AGENTS["ticket-triage"].name;
    expect(await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId: "ticket-triage", version: 2 } }))).toEqual(unadopted(name, 2));
    expect(await refusal(resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId: "ticket-triage", version: 2 }))).toEqual(unadopted(name, 2));
    // A release that does not exist is still not found.
    expect((await refusal(resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId: "ticket-triage", version: 9 } })))?.code).toBe("NOT_FOUND");
    expect((await resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId: "ticket-triage", version: 1 } })).ref.version).toBe(1);
    expect((await resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId: "ticket-triage" } })).ref.version).toBe(1);

    await store.adoptBuiltinVersion({ orgId: TEST_ORG, agentId: "ticket-triage", version: 2, expectedPinnedVersion: 1, by: DANA.developerId });
    expect((await resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId: "ticket-triage", version: 2 } })).ref.version).toBe(2);
    expect((await resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "web", agentId: "ticket-triage", version: 1 })).ref.version).toBe(1);
  });
});

describe("the roster list shows only what the caller can see", () => {
  it("leaves out an agent shared with someone else, with no placeholder, and shows it to those who can see it", async () => {
    const { create, call, addToRoster, rosterOf } = await setup();
    const hidden = await create(CARL, SAFE, "Private to Carl and Max");
    await call(CARL, "PUT", `/v1/app/agents/${hidden}/shares`, { shares: [{ principal: { kind: "member", developerId: MAX.developerId }, level: "use" }] });
    const added = await addToRoster(MAX, "web", hidden);
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    for (const who of [MAX, CARL, DANA]) expect((await rosterOf(who)).some((entry) => entry.agentId === hidden), who.name).toBe(true);
    const seen = await rosterOf(VIV);
    expect(seen.some((entry) => entry.agentId === hidden)).toBe(false);
    expect(JSON.stringify(seen)).not.toContain("Private to Carl and Max");
    // Nothing tells Viv how many were left out.
    expect(seen).toHaveLength(Object.keys(BUILTIN_AGENTS).length);
  });
});

describe("a draft test run reads the draft once", () => {
  it("uses one read of the draft for the revision it records and the recipe it resolves", async () => {
    const { deps, store, create } = await setup();
    const agentId = await create(CARL);
    const read = vi.spyOn(store, "getDraft");
    const resolved = await resolveAgentForTask(deps, callerOf(CARL), { project: "web", agent: { agentId, version: "draft" } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(resolved.ref.draftRevision).toBe(1);
  });
});

describe("an autonomous run needs the project to exist", () => {
  it("refuses a project that is not in the company, for a built-in too", async () => {
    const { deps } = await setup();
    for (const agentId of ["rovara-code", "ticket-triage"] as const) {
      expect((await refusal(resolveAgentForAutonomousRun(deps, { orgId: TEST_ORG, project: "gone", agentId })))?.code, agentId).toBe("PROJECT_NOT_FOUND");
    }
    expect((await refusal(resolveAgentForAutonomousRun(deps, { orgId: ORG_B, project: "web", agentId: "rovara-code" })))?.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("a repeated roster request that changed nothing is still remembered", () => {
  it("does not let a retried add put an agent back after someone else removed it", async () => {
    const { sharedWithWeb, addToRoster, dev, db, rosterOf } = await setup();
    const agentId = await sharedWithWeb();
    await addToRoster(DANA, "web", agentId);
    const body = { requestId: randomUUID() };
    const first = await dev(MAX, "PUT", WEB_AGENT_PATH(agentId), body);
    expect(first.status).toBe(200);
    expect(db.get(agentRequestKey(TEST_ORG, MAX.developerId, body.requestId))).toBeDefined();
    expect((await dev(DANA, "DELETE", WEB_AGENT_PATH(agentId), { requestId: randomUUID() })).status).toBe(200);
    expect((await dev(MAX, "PUT", WEB_AGENT_PATH(agentId), body)).status).toBe(200);
    expect((await rosterOf(MAX)).some((entry) => entry.agentId === agentId)).toBe(false);
  });

  it("does not let a retried removal take out an agent someone added since", async () => {
    const { sharedWithWeb, addToRoster, dev, db, rosterOf } = await setup();
    const agentId = await sharedWithWeb();
    const body = { requestId: randomUUID() };
    expect((await dev(MAX, "DELETE", WEB_AGENT_PATH(agentId), body)).body).toMatchObject({ removed: false });
    expect(db.get(agentRequestKey(TEST_ORG, MAX.developerId, body.requestId))).toBeDefined();
    await addToRoster(DANA, "web", agentId);
    expect((await dev(MAX, "DELETE", WEB_AGENT_PATH(agentId), body)).body).toMatchObject({ removed: false });
    expect((await rosterOf(MAX)).some((entry) => entry.agentId === agentId)).toBe(true);
  });
});

describe("requireRecipeAllowed, for a check made again while a task runs", () => {
  it("gives MODEL_NOT_ALLOWED for a forbidden model and CONFIG_INVALID for another problem, and passes a recipe that is allowed", async () => {
    const { deps, setGuardrails } = await setup();
    const recipe = await resolveAgent(deps.store, TEST_ORG, "rovara-code", "current");
    await expect(requireRecipeAllowed(deps, TEST_ORG, "web", "Rovara Code", recipe)).resolves.toBeUndefined();
    const withModel: ResolvedRecipe = { ...recipe, steps: [{ id: "work", name: "Work", kind: "agent", workspace: "none", settings: { instructions: [], model: OPUS } }] };
    await setGuardrails({ forbiddenModels: [OPUS] });
    expect(await refusal(requireRecipeAllowed(deps, TEST_ORG, "web", "Helper", withModel))).toEqual({
      code: "MODEL_NOT_ALLOWED", message: "Helper's Work step uses anthropic/claude-opus-4-7, which isn't allowed on web. Ask the agent's owner to pick another model.",
    });
  });
});
