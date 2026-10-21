// Plan 3 Task 7: the app's agent routes (`/v1/app/agents*`), through the broker's handler with two orgs. Less-safe changes answer
// 202 with a confirmation link and change nothing; deciding them is Task 21a's page (its tests cover the decide side).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentStore, resolveAgent } from "../../packages/broker/src/agents/store.js";
import type { ApprovalDependencies, ApprovalRecord, ApproverSpec } from "../../packages/broker/src/agents/approvals.js";
import { getApprovalSubjectHandler, getApproverRule } from "../../packages/broker/src/agents/approvals.js";
import { isAgentRoute } from "../../packages/broker/src/agents/routes.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import type { AgentId, AgentOwner } from "../../packages/contracts/src/agent.js";
import { BUILTIN_AGENTS } from "../../packages/contracts/src/agent-templates.js";
import { recipeDigest, type RecipeOverlay, type ResolvedRecipe } from "../../packages/contracts/src/agent-recipe.js";
import type { OrgId, OrgRole } from "../../packages/contracts/src/org.js";
import { approvalKey, orgProjectCatalogKey } from "../../packages/contracts/src/org-scoped-keys.js";
// The broker runs on the built package, so an error a fake throws into it must come from there too.
import { agentXError } from "@agentx/contracts";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const MAX = person("2", "Max"); // maintainer of web
const CARL = person("3", "Carl"); // contributor on web
const EVE = person("4", "Eve"); // a member with no role anywhere
const VIV = person("5", "Viv"); // viewer on web
const OLD_EVE = "6".repeat(64); // a sign-in Eve was merged from
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);

const agentStep = (id: string, name = "Work", workspace: "none" | "read" = "none") => ({ id, name, kind: "agent" as const, workspace });
const gateStep = { id: "gate", name: "Gate", kind: "approval" as const, prompt: "Go on?" };
const SAFE: RecipeOverlay = { instructions: "Summarise the open tickets.", sequence: [agentStep("work")] };
const codingSequence = (maxRounds = 3): NonNullable<RecipeOverlay["sequence"]> => [
  { id: "plan", name: "Plan", kind: "plan" }, { id: "build", name: "Build", kind: "build" }, { id: "check", name: "Check", kind: "check" },
  { id: "review", name: "Review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds } },
  { id: "pr", name: "Pull request", kind: "pull_request" },
];

beforeAll(async () => { await loadSlackBroker(); });

type Reply = { status: number; body: Record<string, unknown> };

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
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web" });
  members.grant(TEST_ORG, "web", MAX.developerId, "maintainer");
  members.grant(TEST_ORG, "web", CARL.developerId, "contributor");
  members.grant(TEST_ORG, "web", VIV.developerId, "viewer");
  // Beside the broker's own store: the same table, so a test can seed a published version without going through the routes.
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now, ...(options.builtins === undefined ? {} : { builtins: options.builtins }) });
  const deps: ApprovalDependencies = {
    store, projectMembers: members, documentClient: h.db, tableName: "state", now: Date.now, confirmOrigin: "https://cell.example.com",
    signInStore: new DeveloperSignInStore({ documentClient: h.db, tableName: "signin", now: Date.now }),
  };
  // The envelope's own requestId is not part of an answer.
  const unwrapped = async (reply: Promise<Reply>): Promise<Reply> => {
    const { requestId: _requestId, ...body } = (await reply).body; // eslint-disable-line @typescript-eslint/no-unused-vars
    return { status: (await reply).status, body };
  };
  const call = (who: Developer, method: string, path: string, body?: Record<string, unknown>): Promise<Reply> =>
    unwrapped(h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body }));
  const create = async (who: Developer, overlay: RecipeOverlay = SAFE, extra: Record<string, unknown> = {}) => {
    const created = await call(who, "POST", "/v1/app/agents", { name: `Agent ${randomUUID().slice(0, 8)}`, overlay, ...extra });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body.agent as { agentId: AgentId }).agentId;
  };
  /** Publishes `overlay` as the agent's next version directly in the store, as an earlier confirmed or safe publish would have. */
  const seed = async (agentId: AgentId, overlay: RecipeOverlay) => {
    const draft = (await store.getDraft(TEST_ORG, agentId))!;
    await store.saveDraft({ orgId: TEST_ORG, agentId, overlay, expectedRevision: draft.revision, by: MAYA.developerId });
    const agent = (await store.get(TEST_ORG, agentId))!;
    await store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")), by: MAYA.developerId });
  };
  const saveDraft = async (who: Developer, agentId: AgentId, overlay: RecipeOverlay): Promise<Reply> => {
    const draft = await call(who, "GET", `/v1/app/agents/${agentId}/draft`);
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    return call(who, "PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: (draft.body.draft as { revision: number }).revision, overlay });
  };
  const publish = async (who: Developer, agentId: AgentId): Promise<Reply> => {
    const draft = await call(who, "GET", `/v1/app/agents/${agentId}/draft`);
    return call(who, "POST", `/v1/app/agents/${agentId}/publish`, { expectedRevision: (draft.body.draft as { revision: number }).revision });
  };
  const state = async (agentId: AgentId) => (await store.get(TEST_ORG, agentId))!;
  const approvals = () => h.db.find((item) => item.entityType === "APPROVAL") as unknown as ApprovalRecord[];
  return { ...h, members, store, deps, call, create, seed, saveDraft, publish, state, approvals };
}

const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };
const candidatesOf = (record: ApprovalRecord): string[] => [...(record.approvers as Extract<ApproverSpec, { kind: "rule" }>).candidates];

describe("create, draft, publish, diff and rollback", () => {
  it("builds an agent, saves its draft, publishes it, compares versions and rolls back", async () => {
    const { call, create, saveDraft, publish, state } = await setup();
    const created = await call(MAYA, "POST", "/v1/app/agents", { name: "Ticket notes", description: "Notes on tickets", overlay: SAFE });
    expect(created.status).toBe(201);
    const agent = created.body.agent as { agentId: AgentId; access: string; draftRevision: number; owner: AgentOwner; latestVersion: number };
    expect(agent).toMatchObject({ access: "manage", draftRevision: 1, latestVersion: 0, owner: { kind: "member", developerId: MAYA.developerId } });
    expect(Object.keys(agent)).not.toContain("orgId");

    const edited = await saveDraft(MAYA, agent.agentId, { ...SAFE, instructions: "Summarise the open tickets, newest first." });
    expect(edited.status).toBe(200);
    expect((edited.body.draft as { revision: number }).revision).toBe(2);

    const first = await publish(MAYA, agent.agentId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.version).toMatchObject({ version: 1, publishedBy: MAYA.developerId });
    expect(first.body.agent).toMatchObject({ currentVersion: 1, latestVersion: 1 });

    await saveDraft(MAYA, agent.agentId, { ...SAFE, instructions: "Summarise the open tickets, and say which are urgent." });
    const second = await publish(MAYA, agent.agentId);
    expect(second.status).toBe(200);
    expect((await state(agent.agentId)).currentVersion).toBe(2);

    const diff = await call(MAYA, "GET", `/v1/app/agents/${agent.agentId}/diff?from=1&to=2`);
    expect(diff.status).toBe(200);
    expect(diff.body).toMatchObject({ from: 1, to: 2, lessSafe: [] });
    expect((diff.body.changes as string[]).some((path) => path.startsWith("/instructions"))).toBe(true);
    // A draft equal to the published version differs from nothing.
    const draftDiff = await call(MAYA, "GET", `/v1/app/agents/${agent.agentId}/diff?from=2&to=draft`);
    expect(draftDiff.body.changes).toEqual([]);
    expect((await call(MAYA, "GET", `/v1/app/agents/${agent.agentId}/diff?from=base&to=2`)).body.changes).toEqual(expect.arrayContaining([expect.stringMatching(/^\/steps/)]));

    const versions = await call(MAYA, "GET", `/v1/app/agents/${agent.agentId}/versions`);
    expect((versions.body.versions as Array<{ version: number; current: boolean }>).map((v) => [v.version, v.current])).toEqual([[1, false], [2, true]]);
    const one = await call(MAYA, "GET", `/v1/app/agents/${agent.agentId}/versions/1`);
    expect(one.status).toBe(200);
    expect((one.body.recipe as ResolvedRecipe).instructions[0]?.text).toBe("Summarise the open tickets, newest first.");

    const rolled = await call(MAYA, "POST", `/v1/app/agents/${agent.agentId}/rollback`, { version: 1 });
    expect(rolled.status, JSON.stringify(rolled.body)).toBe(200);
    expect(rolled.body.agent).toMatchObject({ currentVersion: 1 });
    const shown = await call(MAYA, "GET", `/v1/app/agents/${agent.agentId}`);
    expect(shown.body).toMatchObject({ current: { version: 1, changed: true }, suggestedMaxPerRunUsd: 4 });
    expect(shown.body).not.toHaveProperty("maxPerRunUsd");
    expect(await create(MAYA)).toMatch(/^agt_/);
  });

  it("answers a stale draft or publish with the revision conflict", async () => {
    const { call, create } = await setup();
    const agentId = await create(MAYA);
    const stale = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: 5, overlay: SAFE });
    expect(stale.status).toBe(409);
    expect(errorOf(stale).code).toBe("AGENT_REVISION_CONFLICT");
    expect((await call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, { expectedRevision: 9 })).status).toBe(409);
  });

  it("renames an agent and refuses a taken name", async () => {
    const { call, create } = await setup();
    const a = await create(MAYA);
    await create(MAYA, SAFE, { name: "Taken" });
    const renamed = await call(MAYA, "PATCH", `/v1/app/agents/${a}`, { name: "Notes", description: "New words" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.agent).toMatchObject({ name: "Notes", description: "New words" });
    const clash = await call(MAYA, "PATCH", `/v1/app/agents/${a}`, { name: "taken" });
    expect(clash.status).toBe(400);
    expect(errorOf(clash).message).toBe("name: another agent in your company is called taken");
    expect((await call(MAYA, "PATCH", `/v1/app/agents/${a}`, {})).status).toBe(400);
  });

  it("refuses a recipe that can't run when it is published, with its first problem and path", async () => {
    const { create, saveDraft, publish, call, state } = await setup();
    const agentId = await create(MAYA);
    const sequence = codingSequence().map((step) => (step.id === "review" ? { ...step, settings: { tools: ["write"] } } : step)) as NonNullable<RecipeOverlay["sequence"]>;
    // A draft may be saved half-finished.
    expect((await saveDraft(MAYA, agentId, { sequence })).status).toBe(200);
    const refused = await publish(MAYA, agentId);
    expect(refused.status).toBe(400);
    expect(errorOf(refused)).toEqual({
      code: "CONFIG_INVALID",
      message: 'steps.3.settings.tools: the "review" step (review) can\'t use write; it can use read, grep, find, ls',
    });
    expect((await state(agentId)).currentVersion).toBeUndefined();
    expect((await call(MAYA, "GET", `/v1/app/agents/${agentId}/versions`)).body.versions).toEqual([]);
  });

  it("requires a strict body with a request id", async () => {
    const { call, create } = await setup();
    const agentId = await create(MAYA);
    const post = (path: string, body: Record<string, unknown>) => call(MAYA, "POST", path, body);
    for (const reply of [
      await post("/v1/app/agents", { name: "X", surprise: 1 }),
      await post(`/v1/app/agents/${agentId}/publish`, { expectedRevision: 1, extra: true }),
      await post(`/v1/app/agents/${agentId}/rollback`, { version: "1" }),
      await call(MAYA, "PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: 1, overlay: { instructions: "x", secrets: {} } }),
    ]) expect(reply.status, JSON.stringify(reply.body)).toBe(400);
    const noRequestId = await (await setup()).dev(MAYA, "POST", "/v1/app/agents", { name: "X" });
    expect(noRequestId.status).toBe(400);
    expect(errorOf(noRequestId).message).toMatch(/^requestId: /);
    const notUuid = await (await setup()).dev(MAYA, "POST", "/v1/app/agents", { requestId: "nope", name: "X" });
    expect(errorOf(notUuid).message).toMatch(/^requestId: /);
  });
});

describe("access", () => {
  it("answers 404 without access, the same as for an agent that does not exist, and across orgs", async () => {
    const { call, create } = await setup();
    const agentId = await create(MAYA);
    const missing = await call(EVE, "GET", `/v1/app/agents/agt_00000000000000000000`);
    for (const reply of [await call(EVE, "GET", `/v1/app/agents/${agentId}`), await call(OMAR, "GET", `/v1/app/agents/${agentId}`)]) {
      expect(reply.status).toBe(404);
      expect(reply.body).toEqual(missing.body);
    }
    for (const [method, path, body] of [
      ["PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: 1, overlay: SAFE }],
      ["POST", `/v1/app/agents/${agentId}/publish`, { expectedRevision: 1 }],
      ["PUT", `/v1/app/agents/${agentId}/shares`, { shares: [] }],
      ["POST", `/v1/app/agents/${agentId}/archive`, {}],
    ] as const) {
      expect((await call(OMAR, method, path, body)).status, path).toBe(404);
      expect((await call(EVE, method, path, body)).status, path).toBe(404);
    }
    expect((await call(EVE, "GET", `/v1/app/agents/not-an-id`)).status).toBe(404);
  });

  it("gives a view sharee the agent but not its draft, and refuses what needs more", async () => {
    const { call, create } = await setup();
    const agentId = await create(MAYA);
    expect((await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "view" }] })).status).toBe(200);
    expect((await call(EVE, "GET", `/v1/app/agents/${agentId}`)).body.agent).toMatchObject({ access: "view" });
    const refused = await call(EVE, "PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: 1, overlay: SAFE });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("FORBIDDEN");
    expect((await call(EVE, "GET", `/v1/app/agents/${agentId}/draft`)).status).toBe(403);
    expect((await call(EVE, "GET", `/v1/app/agents/${agentId}/diff?from=base&to=draft`)).status).toBe(403);
    expect((await call(EVE, "POST", `/v1/app/agents/${agentId}/publish`, { expectedRevision: 1 })).status).toBe(403);
    expect((await call(EVE, "GET", `/v1/app/agents/${agentId}/shares`)).status).toBe(403);
    expect((await call(EVE, "POST", `/v1/app/agents/${agentId}/archive`, {})).status).toBe(403);
  });

  it("lets an edit sharee change the draft but not the shares, owner or archive", async () => {
    const { call, create, saveDraft } = await setup();
    const agentId = await create(MAYA);
    await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "edit" }] });
    expect((await saveDraft(EVE, agentId, { ...SAFE, instructions: "Edited by Eve." })).status).toBe(200);
    expect((await call(EVE, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [] })).status).toBe(403);
    expect((await call(EVE, "PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "member", developerId: EVE.developerId } })).status).toBe(403);
    expect((await call(EVE, "POST", `/v1/app/agents/${agentId}/archive`, {})).status).toBe(403);
  });

  it("refuses to build on an agent the caller can only view, and builds on one they can use", async () => {
    const { call, create, seed } = await setup();
    const base = await create(MAYA);
    await seed(base, SAFE);
    await call(MAYA, "PUT", `/v1/app/agents/${base}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "view" }] });
    const refused = await call(EVE, "POST", "/v1/app/agents", { name: "Eve's", extends: base });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("FORBIDDEN");
    await call(MAYA, "PUT", `/v1/app/agents/${base}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "use" }] });
    const built = await call(EVE, "POST", "/v1/app/agents", { name: "Eve's", extends: base });
    expect(built.status, JSON.stringify(built.body)).toBe(201);
    // Changing an existing draft to another base needs `use` on the new base too.
    const other = await create(MAYA);
    await seed(other, SAFE);
    const mine = (built.body.agent as { agentId: AgentId }).agentId;
    // Not shared with Eve at all: she can't tell it exists. Shared to view: she can see it but not build on it.
    expect((await call(EVE, "PUT", `/v1/app/agents/${mine}/draft`, { expectedRevision: 1, overlay: {}, extends: other })).status).toBe(404);
    await call(MAYA, "PUT", `/v1/app/agents/${other}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "view" }] });
    expect((await call(EVE, "PUT", `/v1/app/agents/${mine}/draft`, { expectedRevision: 1, overlay: {}, extends: other })).status).toBe(403);
  });

  it("lists built-ins at their pinned version, and agents by scope", async () => {
    const { call, create, seed } = await setup();
    const builtin = await call(EVE, "GET", "/v1/app/agents?scope=builtin");
    const agents = builtin.body.agents as Array<{ agentId: string; builtin: boolean; pinnedVersion: number; access: string; name: string }>;
    expect(agents).toHaveLength(6);
    expect(agents.every((agent) => agent.builtin && agent.pinnedVersion === 1 && agent.access === "use")).toBe(true);
    expect(agents.find((agent) => agent.agentId === "ticket-triage")?.name).toBe(BUILTIN_AGENTS["ticket-triage"].name);
    expect((await call(DANA, "GET", "/v1/app/agents?scope=builtin")).body.agents).toEqual(expect.arrayContaining([expect.objectContaining({ access: "manage" })]));

    const mine = await create(MAYA, SAFE, { name: "Mine" });
    const shared = await create(DANA, SAFE, { name: "Shared with Maya" });
    await seed(mine, SAFE);
    await call(DANA, "PUT", `/v1/app/agents/${shared}/shares`, { shares: [{ principal: { kind: "member", developerId: MAYA.developerId }, level: "use" }] });
    const names = async (who: Developer, scope: string) => ((await call(who, "GET", `/v1/app/agents?scope=${scope}`)).body.agents as Array<{ name: string }>).map((agent) => agent.name).sort();
    expect(await names(MAYA, "mine")).toEqual(["Mine"]);
    expect(await names(MAYA, "shared")).toEqual(["Shared with Maya"]);
    expect(await names(MAYA, "all")).toEqual(expect.arrayContaining(["Mine", "Shared with Maya", "Rovara Code"]));
    expect(await names(EVE, "all")).not.toContain("Mine");
    expect(await names(OMAR, "all")).not.toContain("Mine");
    expect((await call(MAYA, "GET", "/v1/app/agents?scope=everything")).status).toBe(400);
    const summary = ((await call(MAYA, "GET", "/v1/app/agents?scope=mine")).body.agents as Array<Record<string, unknown>>)[0]!;
    expect(summary).toMatchObject({ builtin: false, currentVersion: 1, status: "active", access: "manage" });
  });

  it("refuses to edit a built-in agent, with the words that say what to do", async () => {
    const { call } = await setup();
    for (const who of [MAYA, DANA]) {
      const refused = await call(who, "PUT", "/v1/app/agents/rovara-code/draft", { expectedRevision: 1, overlay: SAFE });
      expect(refused.status).toBe(403);
      expect(errorOf(refused)).toEqual({ code: "FORBIDDEN", message: `Built-in agents can't be edited. Build on ${BUILTIN_AGENTS["rovara-code"].name} to change it.` });
    }
    expect((await call(DANA, "POST", "/v1/app/agents/rovara-code/publish", { expectedRevision: 1 })).status).toBe(403);
    const detail = await call(MAYA, "GET", "/v1/app/agents/rovara-code");
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ agent: { builtin: true, pinnedVersion: 1, access: "use" }, current: { version: 1 }, suggestedMaxPerRunUsd: 20 });
    expect((await call(MAYA, "GET", "/v1/app/agents/rovara-code/versions")).body.versions).toEqual([expect.objectContaining({ version: 1, current: true })]);
    expect((await call(MAYA, "GET", "/v1/app/agents/rovara-code/versions/1")).body).toMatchObject({ recipe: { chain: [{ agentId: "rovara-code" }] } });
  });
});

describe("less-safe publishes wait for the page (human decision 2026-10-20)", () => {
  const READ_LINEAR = [{ connector: { type: "linear" as const }, access: "read" as const }];
  const withBase = (extra: Partial<RecipeOverlay>): RecipeOverlay => ({ ...SAFE, ...extra });
  const cases: Array<[string, RecipeOverlay, RecipeOverlay, string]> = [
    ["widens a linear grant to read_write", withBase({ tools: READ_LINEAR }), withBase({ tools: [{ connector: { type: "linear" }, access: "read_write" }] }), "Lets the agent change things in every linear connector (read and write)"],
    ["removes an alwaysAsk pattern", withBase({ approvals: { alwaysAsk: ["create_*", "delete_*"] } }), withBase({ approvals: { alwaysAsk: ["delete_*"] } }), 'Removes or changes the always-ask rule "create_*"'],
    ["raises autonomy", withBase({ autonomy: "prepare" }), withBase({ autonomy: "run" }), "Raises the agent's autonomy from prepare to run"],
    ["sets allowMentions", withBase({}), withBase({ allowMentions: true }), "Lets the agent @-mention people in its comments"],
    ["removes an approval step", { ...SAFE, sequence: [agentStep("work"), gateStep] }, { ...SAFE, sequence: [agentStep("work")] }, 'Removes the approval step "Gate"'],
    ["turns workspace none into read (R9-2)", withBase({}), { ...SAFE, sequence: [agentStep("work", "Work", "read")] }, 'Gives the step "Work" read access to the project\'s files'],
    ["lowers maxRounds from 3 to 1 (R9-2)", { sequence: codingSequence(3) }, { sequence: codingSequence(1) }, 'Lowers how many times the review step "Review" sends findings back, from 3 to 1'],
    ["changes a grant's selector from a name to a type (R9-2)", withBase({ tools: [{ connector: { name: "tracker" }, access: "read" }] }), withBase({ tools: READ_LINEAR }), "Gives the agent access to every linear connector (read)"],
    ["edits an alwaysAsk pattern from create_* to create_issue (R9-2)", withBase({ approvals: { alwaysAsk: ["create_*"] } }), withBase({ approvals: { alwaysAsk: ["create_issue"] } }), 'Removes or changes the always-ask rule "create_*"'],
  ];

  it.each(cases)("a publish that %s answers 202 with a link and the changes, and publishes nothing", async (_name, before, after, change) => {
    const { call, create, seed, saveDraft, publish, state, approvals, store } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, before);
    expect((await saveDraft(MAYA, agentId, after)).status).toBe(200);
    const asked = await publish(MAYA, agentId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: "NEEDS_CONFIRMATION", changes: [change] });
    const [record] = approvals();
    expect(asked.body.confirmUrl).toBe(`https://abc123.execute-api.us-east-1.amazonaws.com/v1/app/approve/${record!.approvalId}`);
    expect(record).toMatchObject({ kind: "change", status: "PENDING", requestedBy: MAYA.developerId, subject: { kind: "agent_publish", agentId, draftRevision: 3, expectedCurrentVersion: 1 }, approvers: { kind: "rule", rule: "agent_publish" } });
    expect((await state(agentId)).currentVersion).toBe(1);
    expect(await store.listVersions(TEST_ORG, agentId)).toHaveLength(1);
    expect((await call(MAYA, "GET", `/v1/app/agents/${agentId}/diff?from=1&to=draft`)).body).toMatchObject({ lessSafe: [change] });
  });

  it("lists the agent's owner and the org's admins as the people asked, and stores the digest and revision that were shown", async () => {
    const { create, seed, saveDraft, publish, approvals, deps } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, withBase({ autonomy: "prepare" }));
    await saveDraft(MAYA, agentId, withBase({ autonomy: "run" }));
    await publish(MAYA, agentId);
    const [record] = approvals();
    expect(candidatesOf(record!).sort()).toEqual([DANA.developerId, MAYA.developerId].sort());
    const subject = record!.subject as { digest: string };
    expect(subject.digest).toBe(recipeDigest(await resolveAgent(deps.store, TEST_ORG, agentId, "draft")));
  });

  it("answers a repeat of the same request with the same link, and one record", async () => {
    const { call, create, seed, saveDraft, approvals } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, SAFE);
    await saveDraft(MAYA, agentId, withBase({ allowMentions: true }));
    const body = { requestId: randomUUID(), expectedRevision: 3 };
    const first = await call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, body);
    const again = await call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, body);
    expect(again.status).toBe(202);
    expect(again.body.confirmUrl).toBe(first.body.confirmUrl);
    expect(approvals()).toHaveLength(1);
  });

  it("publishes a change that only edits instructions or narrows a tool at once, with 200", async () => {
    const { create, seed, saveDraft, publish, state, approvals } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, withBase({ tools: [{ connector: { type: "linear" }, access: "read_write", tools: ["get_*", "save_*"] }] }));
    await saveDraft(MAYA, agentId, withBase({ instructions: "Different words.", tools: [{ connector: { type: "linear" }, access: "read", tools: ["get_*"] }] }));
    const published = await publish(MAYA, agentId);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect((await state(agentId)).currentVersion).toBe(2);
    expect(approvals()).toHaveLength(0);
  });

  it("compares a first publish with the base it builds on", async () => {
    const { call, create, seed, publish, approvals } = await setup();
    const base = await create(MAYA);
    await seed(base, withBase({ autonomy: "run" }));
    // On a base that already runs on its own, an agent that changes nothing is not less safe; one that adds a grant is.
    const same = await create(MAYA, {}, { extends: base });
    expect((await publish(MAYA, same)).status).toBe(200);
    const wider = await create(MAYA, { tools: READ_LINEAR }, { extends: base });
    const asked = await publish(MAYA, wider);
    expect(asked.status).toBe(202);
    expect(asked.body.changes).toEqual(["Gives the agent access to every linear connector (read)"]);
    expect(approvals()).toHaveLength(1);
    expect((await call(MAYA, "GET", `/v1/app/agents/${wider}`)).body).not.toHaveProperty("current");
  });

  it("waits for the owner or an org admin, not for an editor, and names a project's maintainers for its agents", async () => {
    const { call, create, seed, saveDraft, publish, approvals, deps } = await setup();
    const rule = getApproverRule("agent_publish")!;
    const agentId = await create(MAYA);
    await seed(agentId, SAFE);
    await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "edit" }] });
    await saveDraft(EVE, agentId, withBase({ autonomy: "run" }));
    const asked = await publish(EVE, agentId);
    expect(asked.status).toBe(202);
    const [record] = approvals();
    const as = (who: Developer, orgRole: OrgRole) => rule(deps, record!, { orgId: TEST_ORG, developerId: who.developerId, orgRole });
    expect(await as(MAYA, "member")).toBe(true);
    expect(await as(DANA, "admin")).toBe(true);
    expect(await as(EVE, "member")).toBe(false);
    expect(await as(MAX, "member")).toBe(false);
    expect(await rule(deps, record!, { orgId: ORG_B, developerId: DANA.developerId, orgRole: "admin" })).toBe(false);

    const web = await create(MAX, SAFE, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    await seed(web, SAFE);
    await saveDraft(MAX, web, withBase({ allowMentions: true }));
    expect((await publish(MAX, web)).status).toBe(202);
    const webRecord = approvals().find((entry) => (entry.subject as { agentId: string }).agentId === web)!;
    expect(candidatesOf(webRecord).sort()).toEqual([DANA.developerId, MAX.developerId].sort());
    const webAs = (who: Developer, orgRole: OrgRole) => rule(deps, webRecord, { orgId: TEST_ORG, developerId: who.developerId, orgRole });
    expect(await webAs(MAX, "member")).toBe(true);
    expect(await webAs(CARL, "member")).toBe(false);
    expect(await webAs(DANA, "admin")).toBe(true);
  });

  it("applies exactly the stored draft when the page confirms it (the handler Task 21a calls)", async () => {
    const { create, seed, saveDraft, publish, state, approvals, deps, store } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, SAFE);
    await saveDraft(MAYA, agentId, withBase({ allowMentions: true }));
    await publish(MAYA, agentId);
    const [record] = approvals();
    await getApprovalSubjectHandler("agent_publish")!(deps, { ...record!, decidedBy: DANA.developerId });
    expect((await state(agentId)).currentVersion).toBe(2);
    expect((await store.getVersion(TEST_ORG, agentId, 2))?.publishedBy).toBe(DANA.developerId);
    expect((await store.getVersion(TEST_ORG, agentId, 2))?.digest).toBe((record!.subject as { digest: string }).digest);
  });

  it("refuses to publish a draft that was edited after the request, with the exact words", async () => {
    const { create, seed, saveDraft, publish, state, approvals, deps, store } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, SAFE);
    await saveDraft(MAYA, agentId, withBase({ allowMentions: true }));
    await publish(MAYA, agentId);
    const [record] = approvals();
    await saveDraft(MAYA, agentId, withBase({ allowMentions: true, autonomy: "run" }));
    const error = await getApprovalSubjectHandler("agent_publish")!(deps, { ...record!, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown);
    expect(error?.message).toBe("AGENT_REVISION_CONFLICT: The draft changed after this was asked. Publish again.");
    expect((await state(agentId)).currentVersion).toBe(1);
    expect(await store.listVersions(TEST_ORG, agentId)).toHaveLength(1);
  });

  it("refuses to publish when another version landed since, and for an agent archived since", async () => {
    const { create, seed, saveDraft, publish, approvals, deps, call } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, SAFE);
    await saveDraft(MAYA, agentId, withBase({ allowMentions: true }));
    await publish(MAYA, agentId);
    const [record] = approvals();
    const handler = getApprovalSubjectHandler("agent_publish")!;
    expect(await call(MAYA, "POST", `/v1/app/agents/${agentId}/archive`, {})).toMatchObject({ status: 200 });
    expect((await handler(deps, { ...record!, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown))?.message).toMatch(/^AGENT_UNAVAILABLE: .* is archived/);
    await call(MAYA, "POST", `/v1/app/agents/${agentId}/unarchive`, {});
    await seed(agentId, SAFE);
    expect((await handler(deps, { ...record!, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown))?.message).toMatch(/^AGENT_REVISION_CONFLICT: /);
  });

  it("refuses to apply a change that has no decider, rather than crediting whoever asked", async () => {
    const { create, seed, saveDraft, publish, approvals, deps, state } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, SAFE);
    await saveDraft(MAYA, agentId, withBase({ allowMentions: true }));
    await publish(MAYA, agentId);
    const [record] = approvals();
    for (const kind of ["agent_publish", "agent_rollback", "builtin_adopt", "agent_share"] as const) {
      const error = await getApprovalSubjectHandler(kind)!(deps, record!).then(() => undefined, (thrown: Error) => thrown);
      expect(error?.message, kind).toMatch(/not been decided/);
    }
    expect((await state(agentId)).currentVersion).toBe(1);
  });

  it("refuses to ask about a less-safe change to an archived agent, and says to unarchive it", async () => {
    const { call, create, seed, saveDraft, publish, approvals } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, { ...SAFE, tools: [{ connector: { type: "linear" }, access: "read" }] });
    await seed(agentId, SAFE);
    await saveDraft(MAYA, agentId, withBase({ allowMentions: true }));
    await call(MAYA, "POST", `/v1/app/agents/${agentId}/archive`, {});
    const refused = await publish(MAYA, agentId);
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe("AGENT_UNAVAILABLE");
    expect(errorOf(refused).message).toMatch(/Unarchive it first/);
    const rolled = await call(MAYA, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 1 });
    expect(errorOf(rolled).code).toBe("AGENT_UNAVAILABLE");
    expect(approvals()).toHaveLength(0);
    // A safe change to an archived agent still applies.
    await saveDraft(MAYA, agentId, withBase({ instructions: "Only words." }));
    expect((await publish(MAYA, agentId)).status).toBe(200);
  });

  it("answers a retried publish after the page confirmed it with that version, not a duplicate", async () => {
    const { call, create, seed, saveDraft, approvals, deps, store } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, SAFE);
    await saveDraft(MAYA, agentId, withBase({ allowMentions: true }));
    const body = { requestId: randomUUID(), expectedRevision: 3 };
    expect((await call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, body)).status).toBe(202);
    await getApprovalSubjectHandler("agent_publish")!(deps, { ...approvals()[0]!, decidedBy: DANA.developerId });
    expect(await store.listVersions(TEST_ORG, agentId)).toHaveLength(2);
    const retried = await call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, body);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.version).toMatchObject({ version: 2, publishedBy: DANA.developerId });
    expect(await store.listVersions(TEST_ORG, agentId)).toHaveLength(2);
  });

  it("keeps each org's approvals apart", async () => {
    const { create, seed, saveDraft, publish, approvals, db } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, SAFE);
    await saveDraft(MAYA, agentId, withBase({ allowMentions: true }));
    await publish(MAYA, agentId);
    const [record] = approvals();
    expect(db.get(approvalKey(TEST_ORG, record!.approvalId))).toBeDefined();
    expect(db.get(approvalKey(ORG_B, record!.approvalId))).toBeUndefined();
  });
});

describe("rollback is compared like a publish", () => {
  it("waits when the older version widened a grant, and leaves the current version alone", async () => {
    const { call, create, seed, state, approvals } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, { ...SAFE, tools: [{ connector: { type: "linear" }, access: "read_write" }] });
    await seed(agentId, { ...SAFE, tools: [{ connector: { type: "linear" }, access: "read" }] });
    const asked = await call(MAYA, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 1 });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: "NEEDS_CONFIRMATION", changes: ["Lets the agent change things in every linear connector (read and write)"] });
    expect(approvals()[0]).toMatchObject({ subject: { kind: "agent_rollback", agentId, version: 1, expectedCurrentVersion: 2 }, approvers: { rule: "agent_publish" } });
    expect((await state(agentId)).currentVersion).toBe(2);
  });

  it("applies a rollback that only narrows at once", async () => {
    const { call, create, seed, state, approvals } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, { ...SAFE, tools: [{ connector: { type: "linear" }, access: "read" }] });
    await seed(agentId, { ...SAFE, tools: [{ connector: { type: "linear" }, access: "read_write" }] });
    const rolled = await call(MAYA, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 1 });
    expect(rolled.status).toBe(200);
    expect((await state(agentId)).currentVersion).toBe(1);
    expect(approvals()).toHaveLength(0);
  });

  it("R9-1: a rollback from a tightened version to a looser one waits, and one that only reverts instructions does not", async () => {
    const { call, create, seed, state } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, { ...SAFE, instructions: "Version one." });
    await seed(agentId, { ...SAFE, instructions: "Version two.", approvals: { alwaysAsk: ["create_*"] } });
    await seed(agentId, { ...SAFE, instructions: "Version three.", approvals: { alwaysAsk: ["create_*"] } });
    const asked = await call(MAYA, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 1 });
    expect(asked.status).toBe(202);
    expect(asked.body.changes).toEqual(['Removes or changes the always-ask rule "create_*"']);
    expect((await state(agentId)).currentVersion).toBe(3);
    const reverted = await call(MAYA, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 2 });
    expect(reverted.status).toBe(200);
    expect((await state(agentId)).currentVersion).toBe(2);
  });

  it("applies exactly the stored rollback when confirmed, and refuses one that is stale", async () => {
    const { call, create, seed, state, approvals, deps } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, { ...SAFE, autonomy: "run" });
    await seed(agentId, { ...SAFE, autonomy: "prepare" });
    await call(MAYA, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 1 });
    const [record] = approvals();
    const handler = getApprovalSubjectHandler("agent_rollback")!;
    await seed(agentId, SAFE);
    expect((await handler(deps, { ...record!, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown))?.message).toMatch(/^AGENT_REVISION_CONFLICT: The published version changed/);
    expect((await state(agentId)).currentVersion).toBe(3);
    await call(MAYA, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 2 });
    const fresh = await call(MAYA, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 1 });
    expect(fresh.status).toBe(202);
    const latest = approvals().find((entry) => (entry.subject as { expectedCurrentVersion: number }).expectedCurrentVersion === 2)!;
    await handler(deps, { ...latest, decidedBy: DANA.developerId });
    expect((await state(agentId)).currentVersion).toBe(1);
  });

  it("refuses a rollback with nothing published, to the current version, or to a version that does not exist", async () => {
    const { call, create, seed } = await setup();
    const agentId = await create(MAYA);
    expect((await call(MAYA, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 1 })).status).toBe(400);
    await seed(agentId, SAFE);
    await seed(agentId, SAFE);
    expect((await call(MAYA, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 2 })).status).toBe(400);
    expect((await call(MAYA, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 7 })).status).toBe(404);
  });
});

describe("adopting a built-in's version", () => {
  /** ticket-triage with a second release that adds a read_write grant, and a third that only changes its words. */
  function release() {
    const shipped = BUILTIN_AGENTS["ticket-triage"].versions[0]!.recipe;
    const widened: ResolvedRecipe = { ...structuredClone(shipped), tools: [...structuredClone(shipped.tools), { connector: { name: "docs" }, access: "read_write" }] };
    const reworded: ResolvedRecipe = { ...structuredClone(shipped), instructions: [{ agentName: "Ticket triage", text: "Sort by urgency." }] };
    const releases: Record<number, ResolvedRecipe> = { 1: shipped, 2: widened, 3: reworded };
    const state = { latest: 1 };
    const source = {
      currentVersion: (id: string) => (id === "ticket-triage" ? state.latest : 1),
      recipe: (id: string, version: number) => {
        const found = id === "ticket-triage" ? releases[version] : BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].versions[version - 1]?.recipe;
        if (found === undefined) throw agentXError("NOT_FOUND", `${id} has no version ${String(version)}`);
        return structuredClone(found);
      },
      name: (id: string) => BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].name,
    };
    return { source, state };
  }

  it("waits for an org admin when the release adds a read_write grant, and keeps the pin until then", async () => {
    const { source, state } = release();
    const { call, store, approvals } = await setup({ builtins: source });
    await store.ensureBuiltinSettings(TEST_ORG, "ticket-triage");
    state.latest = 3;
    const asked = await call(DANA, "POST", "/v1/app/agents/ticket-triage/adopt", { version: 2 });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: "NEEDS_CONFIRMATION", changes: ["Gives the agent access to the \"docs\" connector (read and write)"] });
    expect(asked.body.confirmUrl).toMatch(/\/v1\/app\/approve\/apr_/);
    expect((await store.getBuiltinSettings(TEST_ORG, "ticket-triage"))?.pinnedVersion).toBe(1);
    expect(approvals()[0]).toMatchObject({ subject: { kind: "builtin_adopt", agentId: "ticket-triage", version: 2, expectedPinnedVersion: 1 }, approvers: { kind: "rule", rule: "org_admin" } });
    expect(candidatesOf(approvals()[0]!)).toEqual([DANA.developerId]);
  });

  it("adopts a release that makes nothing less safe at once, and says what changed", async () => {
    const { source, state } = release();
    const { call, store, approvals } = await setup({ builtins: source });
    await store.ensureBuiltinSettings(TEST_ORG, "ticket-triage");
    state.latest = 3;
    const adopted = await call(DANA, "POST", "/v1/app/agents/ticket-triage/adopt", { version: 3 });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    expect(adopted.body).toMatchObject({ pinnedVersion: 3 });
    expect((adopted.body.changes as string[]).some((path) => path.startsWith("/instructions"))).toBe(true);
    expect((await store.getBuiltinSettings(TEST_ORG, "ticket-triage"))?.pinnedVersion).toBe(3);
    expect(approvals()).toHaveLength(0);
    const same = await call(DANA, "POST", "/v1/app/agents/ticket-triage/adopt", { version: 3 });
    expect(same.body).toEqual({ pinnedVersion: 3, changes: [] });
  });

  it("is for org owners and admins only, and refuses a version that does not exist", async () => {
    const { source, state } = release();
    const { call } = await setup({ builtins: source });
    state.latest = 3;
    const refused = await call(MAYA, "POST", "/v1/app/agents/ticket-triage/adopt", { version: 3 });
    expect(refused.status).toBe(403);
    expect((await call(MAX, "POST", "/v1/app/agents/ticket-triage/adopt", { version: 3 })).status).toBe(403);
    expect((await call(DANA, "POST", "/v1/app/agents/ticket-triage/adopt", { version: 9 })).status).toBe(404);
    const custom = await call(DANA, "POST", `/v1/app/agents/agt_00000000000000000000/adopt`, { version: 1 });
    expect(custom.status).toBe(400);
  });

  it("applies exactly the stored adoption when confirmed, and not once the pin has moved", async () => {
    const { source, state } = release();
    const { call, store, approvals, deps } = await setup({ builtins: source });
    await store.ensureBuiltinSettings(TEST_ORG, "ticket-triage");
    state.latest = 3;
    await call(DANA, "POST", "/v1/app/agents/ticket-triage/adopt", { version: 2 });
    const [record] = approvals();
    const handler = getApprovalSubjectHandler("builtin_adopt")!;
    await store.adoptBuiltinVersion({ orgId: TEST_ORG, agentId: "ticket-triage", version: 3, expectedPinnedVersion: 1, by: DANA.developerId });
    expect((await handler(deps, { ...record!, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown))?.message).toMatch(/^AGENT_REVISION_CONFLICT: The version your company uses changed/);
    expect((await store.getBuiltinSettings(TEST_ORG, "ticket-triage"))?.pinnedVersion).toBe(3);
    await call(DANA, "POST", "/v1/app/agents/ticket-triage/adopt", { version: 1 });
    const second = approvals().find((entry) => (entry.subject as { version: number }).version === 1);
    expect(second).toBeUndefined();
  });

  it("decides before it writes: a less-safe adoption leaves the org's settings alone and still applies when confirmed", async () => {
    const { source, state } = release();
    const { call, store, approvals, deps } = await setup({ builtins: source });
    state.latest = 3;
    // No settings yet, so the org runs the newest release; going back to the release that widened is less safe.
    const asked = await call(DANA, "POST", "/v1/app/agents/ticket-triage/adopt", { version: 2 });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(await store.getBuiltinSettings(TEST_ORG, "ticket-triage")).toBeUndefined();
    const [record] = approvals();
    expect(record!.subject).toMatchObject({ expectedPinnedVersion: 3, version: 2 });
    await getApprovalSubjectHandler("builtin_adopt")!(deps, { ...record!, decidedBy: DANA.developerId });
    expect((await store.getBuiltinSettings(TEST_ORG, "ticket-triage"))?.pinnedVersion).toBe(2);
  });

  it("registers org_admin for owners and admins only", async () => {
    await setup();
    const rule = getApproverRule("org_admin")!;
    const record = { orgId: TEST_ORG } as ApprovalRecord;
    const deps = {} as ApprovalDependencies;
    expect(await rule(deps, record, { orgId: TEST_ORG, developerId: DANA.developerId, orgRole: "admin" })).toBe(true);
    expect(await rule(deps, record, { orgId: TEST_ORG, developerId: DANA.developerId, orgRole: "owner" })).toBe(true);
    expect(await rule(deps, record, { orgId: TEST_ORG, developerId: MAYA.developerId, orgRole: "member" })).toBe(false);
    expect(await rule(deps, record, { orgId: ORG_B, developerId: DANA.developerId, orgRole: "admin" })).toBe(false);
  });
});

describe("update-base", () => {
  it("moves the draft to the base's new version and returns what the base changed", async () => {
    const { call, create, seed, state } = await setup();
    const base = await create(MAYA);
    await seed(base, { ...SAFE, instructions: "Base words one." });
    const child = await create(MAYA, { instructions: "Child words." }, { extends: base });
    await seed(base, { ...SAFE, instructions: "Base words two." });
    const listed = (await call(MAYA, "GET", "/v1/app/agents?scope=mine")).body.agents as Array<{ agentId: string; extends?: { version: number }; updateAvailable?: unknown }>;
    expect(listed.find((agent) => agent.agentId === child)).toMatchObject({ extends: { agentId: base, version: 1 }, updateAvailable: { from: 1, to: 2 } });
    const updated = await call(MAYA, "POST", `/v1/app/agents/${child}/update-base`, { expectedRevision: 1 });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.draft).toMatchObject({ extends: { agentId: base, version: 2 }, revision: 2 });
    expect((updated.body.changes as string[]).some((path) => path.startsWith("/instructions"))).toBe(true);
    expect((await state(child)).draftRevision).toBe(2);
    const stale = await call(MAYA, "POST", `/v1/app/agents/${child}/update-base`, { expectedRevision: 1 });
    expect(stale.status).toBe(409);
    const after = (await call(MAYA, "GET", "/v1/app/agents?scope=mine")).body.agents as Array<{ agentId: string; updateAvailable?: unknown }>;
    expect(after.find((agent) => agent.agentId === child)?.updateAvailable).toBeUndefined();
  });

  it("checks `use` on the base again before moving to its new version", async () => {
    const { call, create, seed } = await setup();
    const base = await create(MAYA);
    await seed(base, { ...SAFE, instructions: "Base one." });
    await call(MAYA, "PUT", `/v1/app/agents/${base}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "use" }] });
    const mine = (await call(EVE, "POST", "/v1/app/agents", { name: "Eve's child", extends: base })).body.agent as { agentId: AgentId };
    await seed(base, { ...SAFE, instructions: "Base two." });
    await call(MAYA, "PUT", `/v1/app/agents/${base}/shares`, { shares: [] });
    const refused = await call(EVE, "POST", `/v1/app/agents/${mine.agentId}/update-base`, { expectedRevision: 1 });
    expect(refused.status).toBe(404);
    // With only a view share she sees the base but can't build on it.
    await call(MAYA, "PUT", `/v1/app/agents/${base}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "view" }] });
    expect((await call(EVE, "POST", `/v1/app/agents/${mine.agentId}/update-base`, { expectedRevision: 1 })).status).toBe(403);
  });

  it("refuses an agent built from scratch, and one the caller can't edit", async () => {
    const { call, create } = await setup();
    const scratch = await create(MAYA);
    expect((await call(MAYA, "POST", `/v1/app/agents/${scratch}/update-base`, { expectedRevision: 1 })).status).toBe(400);
    expect((await call(EVE, "POST", `/v1/app/agents/${scratch}/update-base`, { expectedRevision: 1 })).status).toBe(404);
  });
});

describe("sharing, owners, accountable people and archiving", () => {
  const member = (who: Developer, level: "view" | "use" | "edit") => ({ principal: { kind: "member", developerId: who.developerId }, level });

  it("shares with people and projects at once, and lists the shares to a manager", async () => {
    const { call, create } = await setup();
    const agentId = await create(MAYA);
    const saved = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [member(EVE, "use"), { principal: { kind: "project", project: "web" }, level: "view" }] });
    expect(saved.status).toBe(200);
    expect(saved.body.shares).toHaveLength(2);
    expect((await call(MAYA, "GET", `/v1/app/agents/${agentId}/shares`)).body.shares).toHaveLength(2);
    expect((await call(CARL, "GET", `/v1/app/agents/${agentId}`)).body.agent).toMatchObject({ access: "view" });
    const unknown = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "project", project: "nope" }, level: "view" }] });
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown).message).toBe("shares.0: no project called nope in your company");
    expect((await call(MAYA, "PUT", "/v1/app/agents/rovara-code/shares", { shares: [] })).status).toBe(400);
  });

  it("R66: sharing with the whole company waits for the page and changes nothing until then", async () => {
    const { call, create, store, approvals, deps } = await setup();
    const agentId = await create(MAYA);
    await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [member(EVE, "view")] });
    const asked = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [member(EVE, "view"), { principal: { kind: "org" }, level: "use" }] });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: "NEEDS_CONFIRMATION", changes: [expect.stringContaining("everyone in your company")] });
    expect(await store.listShares(TEST_ORG, agentId)).toHaveLength(1);
    expect((await call(EVE, "GET", `/v1/app/agents/${agentId}`)).body.agent).toMatchObject({ access: "view" });
    const [record] = approvals();
    expect(record).toMatchObject({ subject: { kind: "agent_share", agentId }, approvers: { rule: "agent_manager" } });
    // Confirming writes exactly what was asked, and not once the shares have changed since.
    const handler = getApprovalSubjectHandler("agent_share")!;
    await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [member(EVE, "edit")] });
    expect((await handler(deps, { ...record!, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown))?.message).toMatch(/^AGENT_REVISION_CONFLICT: Who this agent is shared with changed/);
    const fresh = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [member(EVE, "edit"), { principal: { kind: "org" }, level: "view" }] });
    expect(fresh.status).toBe(202);
    await handler(deps, { ...approvals().at(-1)!, decidedBy: DANA.developerId });
    expect((await store.listShares(TEST_ORG, agentId)).map((share) => [share.principal.kind, share.level]).sort()).toEqual([["member", "edit"], ["org", "view"]]);
    expect((await call(CARL, "GET", `/v1/app/agents/${agentId}`)).body.agent).toMatchObject({ access: "view" });
  });

  it("refuses a company-wide share that could not be applied before asking anyone", async () => {
    const { call, create, approvals } = await setup();
    const agentId = await create(MAYA);
    const refused = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "org" }, level: "use" }, { principal: { kind: "org" }, level: "view" }] });
    expect(refused.status).toBe(400);
    expect(approvals()).toHaveLength(0);
  });

  it("lowers or removes the company share at once", async () => {
    const { call, create, seed, approvals, store } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, SAFE);
    // Seeded as a confirmed change would have written it.
    await store.replaceShares({ orgId: TEST_ORG, agentId, upsert: [{ principal: { kind: "org" }, level: "edit" }], remove: [], expectedSharesRevision: 0, by: DANA.developerId });
    expect((await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "org" }, level: "use" }] })).status).toBe(200);
    expect((await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [] })).status).toBe(200);
    expect(approvals()).toHaveLength(0);
  });

  it("moves an agent to another owner by the rules, and stores the survivor of a merged member", async () => {
    const { call, create, db, store } = await setup();
    const agentId = await create(MAYA);
    const handOver = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "member", developerId: EVE.developerId } });
    expect(handOver.status).toBe(403);
    expect(errorOf(handOver).message).toBe("Only an org owner or admin can hand an agent to another member.");
    db.set({ pk: `DEVELOPER#${OLD_EVE}`, sk: "META", developerId: OLD_EVE, mergedInto: EVE.developerId });
    const moved = await call(DANA, "PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "member", developerId: OLD_EVE } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await store.get(TEST_ORG, agentId))?.owner).toEqual({ kind: "member", developerId: EVE.developerId });
    expect((await call(MAYA, "GET", `/v1/app/agents/${agentId}`)).status).toBe(404);
    const toProject = await call(DANA, "PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    expect(toProject.status, JSON.stringify(toProject.body)).toBe(200);
    expect(await store.get(TEST_ORG, agentId)).toMatchObject({ owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    expect((await call(DANA, "PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "project", project: "web" } })).status).toBe(400);
    expect((await call(DANA, "PUT", "/v1/app/agents/rovara-code/owner", { owner: { kind: "member", developerId: EVE.developerId } })).status).toBe(400);
  });

  it("needs a maintainer to own a project's agent, and checks manage_agents on the accountable person (here)", async () => {
    const { call, store } = await setup();
    const owner = { kind: "project", project: "web" };
    const create = (who: Developer, accountable: Developer) => call(who, "POST", "/v1/app/agents", { name: `Web ${randomUUID().slice(0, 6)}`, owner, accountable: { developerId: accountable.developerId }, overlay: SAFE });
    expect((await create(CARL, MAX)).status).toBe(403);
    expect((await create(MAX, CARL)).status).toBe(400);
    expect(errorOf(await create(MAX, CARL)).message).toBe("accountable: that person needs to be a maintainer of web");
    expect(errorOf(await create(MAX, EVE)).message).toBe("accountable: that person needs to be a maintainer of web");
    const stranger = await call(MAX, "POST", "/v1/app/agents", { name: "Ghost owner", owner, accountable: { developerId: "9".repeat(64) }, overlay: SAFE });
    expect(errorOf(stranger).message).toBe("accountable: nobody in your company has that ID");
    const made = await create(MAX, MAX);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const agentId = (made.body.agent as { agentId: AgentId }).agentId;
    expect(made.body.agent).toMatchObject({ owner, accountable: { developerId: MAX.developerId }, access: "manage" });
    // An org admin is a maintainer of every project.
    expect((await call(MAX, "PUT", `/v1/app/agents/${agentId}/accountable`, { accountable: { developerId: DANA.developerId } })).status).toBe(200);
    expect((await store.get(TEST_ORG, agentId))?.accountable).toEqual({ developerId: DANA.developerId });
    const notAMaintainer = await call(MAX, "PUT", `/v1/app/agents/${agentId}/accountable`, { accountable: { developerId: CARL.developerId } });
    expect(notAMaintainer.status).toBe(400);
    expect((await call(CARL, "PUT", `/v1/app/agents/${agentId}/accountable`, { accountable: { developerId: MAX.developerId } })).status).toBe(403);
    // A member's own agent has no accountable maintainer.
    const mine = await call(MAYA, "POST", "/v1/app/agents", { name: "Mine alone", accountable: { developerId: MAYA.developerId } });
    expect(mine.status).toBe(400);
  });

  it("shows an agent whose base was archived, with the problem beside its published version", async () => {
    const { call, create, seed } = await setup();
    const base = await create(MAYA);
    await seed(base, SAFE);
    const child = await create(MAYA, { instructions: "Child." }, { extends: base });
    await seed(child, { instructions: "Child." });
    await call(MAYA, "POST", `/v1/app/agents/${base}/archive`, {});
    const shown = await call(MAYA, "GET", `/v1/app/agents/${child}`);
    expect(shown.status).toBe(200);
    expect(shown.body.current).toMatchObject({ version: 1 });
    expect((shown.body.current as { problem: string }).problem).toContain("which is archived");
    expect(shown.body.current).not.toHaveProperty("recipe");
  });

  it("names an org owner or admin as a built-in's accountable person, and nobody else", async () => {
    const { call, store } = await setup();
    expect((await call(DANA, "PUT", "/v1/app/agents/rovara-code/accountable", { accountable: { developerId: DANA.developerId } })).status).toBe(200);
    expect((await store.getBuiltinSettings(TEST_ORG, "rovara-code"))?.accountable).toEqual({ developerId: DANA.developerId });
    expect((await call(DANA, "PUT", "/v1/app/agents/rovara-code/accountable", { accountable: { developerId: EVE.developerId } })).status).toBe(400);
    expect((await call(MAYA, "PUT", "/v1/app/agents/rovara-code/accountable", { accountable: { developerId: DANA.developerId } })).status).toBe(403);
  });

  it("archives and unarchives, and an editor can't change an archived agent", async () => {
    const { call, create, seed } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, SAFE);
    await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [member(EVE, "edit")] });
    const archived = await call(MAYA, "POST", `/v1/app/agents/${agentId}/archive`, {});
    expect(archived.status).toBe(200);
    expect(archived.body.agent).toMatchObject({ status: "archived" });
    const refused = await call(EVE, "PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: 2, overlay: SAFE });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).message).toMatch(/to unarchive it/);
    expect((await call(EVE, "GET", `/v1/app/agents/${agentId}`)).body.agent).toMatchObject({ access: "view", status: "archived" });
    expect((await call(MAYA, "POST", `/v1/app/agents/${agentId}/unarchive`, {})).body.agent).toMatchObject({ status: "active" });
    expect((await call(MAYA, "POST", `/v1/app/agents/${agentId}/unarchive`, {})).status).toBe(200);
    expect((await call(EVE, "PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: 2, overlay: SAFE })).status).toBe(200);
    expect((await call(MAYA, "POST", "/v1/app/agents/rovara-code/archive", {})).status).toBe(403);
    expect((await call(DANA, "POST", "/v1/app/agents/rovara-code/archive", {})).status).toBe(400);
  });
});

describe("a repeated request answers what it answered before (R18)", () => {
  const events = (db: { find: (test: (item: Record<string, unknown>) => boolean) => Array<Record<string, unknown>> }, kind: string) => db.find((item) => item.entityType === "AGENT_EVENT" && item.kind === kind);

  it("publishes once when a safe publish is repeated, and answers the repeat with the same version", async () => {
    const { call, create, seed, saveDraft, store, db } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, SAFE);
    await saveDraft(MAYA, agentId, { ...SAFE, instructions: "Newer words." });
    const body = { requestId: randomUUID(), expectedRevision: 3 };
    const first = await call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, body);
    const again = await call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(again).toEqual(first);
    expect(await store.listVersions(TEST_ORG, agentId)).toHaveLength(2);
    // The seeded version and the one this request made.
    expect(events(db, "published")).toHaveLength(2);
    // The same request id for another body is a mistake, not a replay.
    const other = await call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, { requestId: body.requestId, expectedRevision: 3, note: "different" });
    expect(other.status).toBe(400);
    expect(errorOf(other)).toEqual({ code: "CONFIG_INVALID", message: "requestId: this request ID was already used for a different request" });
    expect(await store.listVersions(TEST_ORG, agentId)).toHaveLength(2);
  });

  it("answers a repeated create with the same agent, not a taken name", async () => {
    const { call, store } = await setup();
    const body = { requestId: randomUUID(), name: "Only once", overlay: SAFE };
    const first = await call(MAYA, "POST", "/v1/app/agents", body);
    const again = await call(MAYA, "POST", "/v1/app/agents", body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.agent).toEqual(first.body.agent);
    expect(await store.list(TEST_ORG)).toHaveLength(1);
    expect((await call(MAYA, "POST", "/v1/app/agents", { ...body, name: "Another name" })).status).toBe(400);
    // Another person's request with the same id is their own.
    expect((await call(DANA, "POST", "/v1/app/agents", { ...body, name: "Dana's" })).status).toBe(201);
  });

  it("answers a repeated create from the live agent, and not at all once the creator can no longer see it", async () => {
    const { call, store } = await setup();
    const body = { requestId: randomUUID(), name: "Moves away", overlay: SAFE };
    const first = await call(MAYA, "POST", "/v1/app/agents", body);
    const agentId = (first.body.agent as { agentId: AgentId }).agentId;
    await call(MAYA, "PATCH", `/v1/app/agents/${agentId}`, { description: "Changed since" });
    const again = await call(MAYA, "POST", "/v1/app/agents", body);
    expect(again.status).toBe(201);
    expect(again.body.agent).toMatchObject({ agentId, description: "Changed since", access: "manage" });
    await call(DANA, "PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "member", developerId: EVE.developerId } });
    expect((await store.get(TEST_ORG, agentId))?.owner).toMatchObject({ developerId: EVE.developerId });
    const gone = await call(MAYA, "POST", "/v1/app/agents", body);
    expect(gone.status).toBe(404);
    expect(errorOf(gone).message).toBe("no agent has that ID");
  });

  it("answers a repeated share save without a second change", async () => {
    const { call, create, db } = await setup();
    const agentId = await create(MAYA);
    const body = { requestId: randomUUID(), shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "view" }] };
    const first = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, body);
    const again = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, body);
    expect(first.status).toBe(200);
    expect(again).toEqual(first);
    expect(events(db, "shared")).toHaveLength(1);
    expect((await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { ...body, shares: [] })).status).toBe(400);
  });

  it("answers a repeated rollback, rename, draft save, owner change, archive and update-base as before", async () => {
    const { call, create, seed, state, store } = await setup();
    const agentId = await create(MAYA);
    await seed(agentId, SAFE);
    await seed(agentId, { ...SAFE, instructions: "Two." });
    const repeat = async (method: string, path: string, body: Record<string, unknown>) => {
      const sent = { requestId: randomUUID(), ...body };
      const first = await call(MAYA, method, path, sent);
      const again = await call(MAYA, method, path, sent);
      expect(first.status, `${path} ${JSON.stringify(first.body)}`).toBeLessThan(300);
      expect(again, path).toEqual(first);
    };
    await repeat("POST", `/v1/app/agents/${agentId}/rollback`, { version: 1 });
    expect((await state(agentId)).currentVersion).toBe(1);
    await repeat("PATCH", `/v1/app/agents/${agentId}`, { name: "Renamed once" });
    const draft = (await store.getDraft(TEST_ORG, agentId))!;
    await repeat("PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: draft.revision, overlay: { ...SAFE, instructions: "Three." } });
    expect((await store.getDraft(TEST_ORG, agentId))!.revision).toBe(draft.revision + 1);
    await repeat("PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "member", developerId: MAYA.developerId } });
    await repeat("POST", `/v1/app/agents/${agentId}/archive`, {});
    const base = await create(MAYA);
    await seed(base, SAFE);
    const child = await create(MAYA, { instructions: "Child." }, { extends: base });
    await seed(base, { ...SAFE, instructions: "Base two." });
    await repeat("POST", `/v1/app/agents/${child}/update-base`, { expectedRevision: 1 });
    expect((await store.getDraft(TEST_ORG, child))!.revision).toBe(2);
  });

  it("answers a repeated company-wide share request with the same link and one record", async () => {
    const { call, create, approvals } = await setup();
    const agentId = await create(MAYA);
    const body = { requestId: randomUUID(), shares: [{ principal: { kind: "org" }, level: "view" }] };
    const first = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, body);
    const again = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, body);
    expect(again).toEqual(first);
    expect(approvals()).toHaveLength(1);
  });

  it("leaves no mark behind when the write is refused, so the request can be sent again", async () => {
    const { call, create, db } = await setup();
    const agentId = await create(MAYA);
    const requestId = randomUUID();
    const stale = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/draft`, { requestId, expectedRevision: 9, overlay: SAFE });
    expect(stale.status).toBe(409);
    expect(db.find((item) => item.entityType === "AGENT_REQUEST" && item.sk === requestId)).toHaveLength(0);
    const fixed = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/draft`, { requestId, expectedRevision: 1, overlay: SAFE });
    expect(fixed.status).toBe(200);
  });

  it("checks access before answering a repeat, so a person who lost access learns nothing", async () => {
    const { call, create } = await setup();
    const agentId = await create(MAYA);
    const share = { principal: { kind: "member", developerId: EVE.developerId }, level: "edit" };
    await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [share] });
    const body = { requestId: randomUUID(), expectedRevision: 1, overlay: SAFE };
    expect((await call(EVE, "PUT", `/v1/app/agents/${agentId}/draft`, body)).status).toBe(200);
    await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [] });
    expect((await call(EVE, "PUT", `/v1/app/agents/${agentId}/draft`, body)).status).toBe(404);
  });
});

describe("Plan 3's paths and Plan 2's (PF24)", () => {
  it("recognizes every Plan 3 prefix, project sub-paths included, and nothing of Plan 2's", () => {
    for (const path of [
      "/v1/app/agents", "/v1/app/agents/rovara-code/adopt", "/v1/app/skills", "/v1/app/skills/skl_x", "/v1/app/approvals", "/v1/app/approvals/apr_x/decide",
      "/v1/app/spend-requests", "/v1/app/connections", "/v1/app/connections/con_x", "/v1/app/org/agent-guardrails", "/v1/app/org/model-sources", "/v1/app/org/model-sources/src_x",
      "/v1/app/org/spend", "/v1/app/org/spend/members", "/v1/app/budget", "/v1/app/tasks/abc/continue-as-task",
      "/v1/app/projects/web/agents", "/v1/app/projects/web/agents/agt_x", "/v1/app/projects/web/ai", "/v1/app/projects/web/spend", "/v1/app/projects/web/connectors",
      "/v1/app/projects/web/connectors/github/comment-triggers", "/v1/app/projects/web/connectors/linear",
    ]) expect(isAgentRoute(path), path).toBe(true);
    for (const path of [
      "/v1/app/me", "/v1/app/projects", "/v1/app/projects/web", "/v1/app/projects/web/settings", "/v1/app/org", "/v1/app/org/members", "/v1/app/org/members/abc/role",
      "/v1/app/org/leave", "/v1/app/github/connect", "/v1/app/agentsx", "/v1/app/tasks/abc", "/v1/app/projects/agents", "/v1/dev/projects", "/v1/app/org/spendy",
    ]) expect(isAgentRoute(path), path).toBe(false);
  });

  it("sends a project's agents, AI, spend and connectors paths to the agent router before Plan 2's project routes", async () => {
    const { call } = await setup();
    for (const path of [
      "/v1/app/projects/web/agents", "/v1/app/projects/web/ai", "/v1/app/projects/web/spend", "/v1/app/projects/web/connectors",
      "/v1/app/projects/web/connectors/github/comment-triggers", "/v1/app/budget", "/v1/app/org/spend",
    ]) {
      const reply = await call(MAYA, "GET", path);
      expect(reply.status, path).toBe(404);
      expect(errorOf(reply).message, path).toBe("that isn't available yet");
    }
    // Plan 2's own paths are still its own.
    expect(errorOf(await call(MAYA, "GET", "/v1/app/projects/nope/unknown")).message).toBe("route not found");
    expect((await call(MAYA, "GET", "/v1/app/me")).status).toBe(200);
  });

  it("answers 404 when the install has no project roles for agents", async () => {
    const harness = await createDeveloperTaskBroker({ orgResolver, register: false });
    const reply = await harness.dev(MAYA, "GET", "/v1/app/agents");
    expect(reply.status).toBe(404);
    expect(errorOf(reply).message).toBe("agents are not set up in this deployment");
    expect((await harness.dev(MAYA, "GET", "/v1/app/projects/web/agents")).status).toBe(404);
  });

  it("needs a signed-in developer", async () => {
    const { handler } = await setup();
    const response = await handler({ version: "2.0", rawPath: "/v1/app/agents", rawQueryString: "", headers: {}, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
    expect(response.statusCode).toBe(401);
  });
});
