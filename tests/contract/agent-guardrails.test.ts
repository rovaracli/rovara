import { fixtureActor } from "../support/money-authority.js";
// Plan 3 Task 8: the company's agent guardrails. What they hold and how a request to change them is checked (the schema), which changes
// are less safe and wait for the confirmation page (R9-3, R69), how a recipe is checked against them when it is published, and how
// an admin turns a built-in agent off. Deciding a waiting change is Task 21a's page; its tests cover the decide side.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentStore, resolveAgent } from "../../packages/broker/src/agents/store.js";
import type { ApprovalDependencies, ApprovalRecord, ApproverSpec } from "../../packages/broker/src/agents/approvals.js";
import { decideApproval, getApproval, getApprovalSubjectHandler, getApproverRule } from "../../packages/broker/src/agents/approvals.js";
import {
  lessSafeGuardrailChanges,
  readGuardrails,
  readGuardrailsWithRevision,
  requireAgentEnabled,
  validateRecipeForOrg,
  writeGuardrails,
} from "../../packages/broker/src/agents/guardrails.js";
import { listVisibleAgents as listVisibleAgentsOf } from "../../packages/broker/src/agents/access.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { AgentGuardrailsSchema, DEFAULT_AGENT_GUARDRAILS, type AgentGuardrails } from "../../packages/contracts/src/agent-guardrails.js";
import type { AgentId } from "../../packages/contracts/src/agent.js";
import { BUILTIN_AGENTS, currentBuiltinVersion } from "../../packages/contracts/src/agent-templates.js";
import { recipeDigest, EMPTY_RECIPE, type RecipeOverlay, type ResolvedRecipe, type ResolvedStep } from "../../packages/contracts/src/agent-recipe-node.js";
import type { ModelIdentifier } from "../../packages/contracts/src/models-node.js";
import type { OrgId, OrgRole } from "../../packages/contracts/src/org.js";
import { agentGuardrailsKey, approvalKey, orgProjectCatalogKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { DEFAULT_MAX_AGENT_MONTHLY_USD, DEFAULT_MAX_AUTONOMY, DEFAULT_MAX_PER_RUN_CEILING_USD } from "../../packages/contracts/src/spend.js";
import { OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const OWEN = person("7", "Owen"); // org owner
const EVE = person("4", "Eve"); // a plain member
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);

const claude = (modelId: string, provider = "anthropic"): ModelIdentifier => ({ provider, modelId });
const OPUS: ModelIdentifier = claude("claude-opus-4-7");
const GPT: ModelIdentifier = { provider: "openai", modelId: "gpt-5.4" };
const WITH_SECOND_COMPANY: ModelIdentifier[] = [claude("claude-sonnet-4-6"), claude("claude-opus-4-7"), GPT];

const defaults = (): AgentGuardrails => structuredClone(DEFAULT_AGENT_GUARDRAILS);
const guardrails = (changes: Partial<AgentGuardrails> = {}): AgentGuardrails => ({ ...defaults(), ...changes });

beforeAll(async () => { await loadSlackBroker(); });

describe("the guardrails document", () => {
  it("has the defaults the plan names", () => {
    expect(DEFAULT_AGENT_GUARDRAILS).toEqual({
      forbiddenModels: [], requireCrossCompanyReview: false, maxAgentMonthlyUsd: DEFAULT_MAX_AGENT_MONTHLY_USD, maxPerRunCeilingUsd: DEFAULT_MAX_PER_RUN_CEILING_USD,
      maxAutonomy: DEFAULT_MAX_AUTONOMY, disabledBuiltins: [], extraTriggerLabels: [], extraCommandWords: [], reportLinkDomains: [],
    });
    expect(DEFAULT_AGENT_GUARDRAILS).not.toHaveProperty("maxStepBudgetUsd");
    expect(AgentGuardrailsSchema.parse(defaults())).toEqual(defaults());
  });

  it("keeps the key under the org's own partition", () => {
    expect(agentGuardrailsKey(TEST_ORG)).toEqual({ pk: `ORG#${TEST_ORG}#AGENT_GUARDRAILS`, sk: "META" });
    expect(agentGuardrailsKey(TEST_ORG).pk).not.toBe(agentGuardrailsKey(ORG_B).pk);
  });

  const refused = (changes: Record<string, unknown>) => AgentGuardrailsSchema.safeParse({ ...defaults(), ...changes });

  it.each<[string, Record<string, unknown>]>([
    ["more than 50 forbidden models", { forbiddenModels: Array.from({ length: 51 }, (_, index) => claude(`model-${String(index)}`)) }],
    ["a forbidden model listed twice by canonical name", { forbiddenModels: [claude("claude-opus-4-7"), { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-7-v1:0" }] }],
    ["more than 50 trigger labels", { extraTriggerLabels: Array.from({ length: 51 }, (_, index) => `label-${String(index)}`) }],
    ["a trigger label with a wildcard in the middle", { extraTriggerLabels: ["ship*it"] }],
    ["a trigger label that is only a wildcard", { extraTriggerLabels: ["*"] }],
    ["a trigger label listed twice", { extraTriggerLabels: ["ship", "SHIP"] }],
    ["more than 50 command words", { extraCommandWords: Array.from({ length: 51 }, (_, index) => `word${String(index)}`) }],
    ["a command word with a space", { extraCommandWords: ["go now"] }],
    ["an empty command word", { extraCommandWords: [" "] }],
    ["more than 20 report domains", { reportLinkDomains: Array.from({ length: 21 }, (_, index) => `host${String(index)}.example.com`) }],
    ["a report domain with a path", { reportLinkDomains: ["example.com/reports"] }],
    ["a report domain with a scheme", { reportLinkDomains: ["https://example.com"] }],
    ["a report domain with a wildcard", { reportLinkDomains: ["*.example.com"] }],
    ["a report domain that is not a dotted name", { reportLinkDomains: ["localhost"] }],
    ["an autonomy that does not exist", { maxAutonomy: "free" }],
    ["a built-in that does not exist", { disabledBuiltins: ["nobody"] }],
    ["a built-in listed twice", { disabledBuiltins: ["service-reviewer", "service-reviewer"] }],
    ["a negative amount", { maxAgentMonthlyUsd: -1 }],
    ["an amount that is not a number", { maxPerRunCeilingUsd: "100" }],
    ["a field it does not know", { surprise: 1 }],
  ])("refuses %s", (_name, changes) => {
    expect(refused(changes).success).toBe(false);
  });

  it("refuses a document with a field missing", () => {
    const { maxAutonomy: _maxAutonomy, ...partial } = defaults(); // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(AgentGuardrailsSchema.safeParse(partial).success).toBe(false);
  });

  it("writes labels, words and hosts in lower case and accepts a prefix pattern", () => {
    const parsed = AgentGuardrailsSchema.parse(guardrails({
      extraTriggerLabels: ["Ship-It", "Deploy-*", "type: release"], extraCommandWords: ["Deploy"], reportLinkDomains: ["Reports.Example.com"],
    }));
    expect(parsed).toMatchObject({ extraTriggerLabels: ["ship-it", "deploy-*", "type: release"], extraCommandWords: ["deploy"], reportLinkDomains: ["reports.example.com"] });
  });

  it("takes a step budget limit when one is given", () => {
    expect(AgentGuardrailsSchema.parse(guardrails({ maxStepBudgetUsd: 5 })).maxStepBudgetUsd).toBe(5);
  });
});

describe("lessSafeGuardrailChanges", () => {
  const base = guardrails({
    forbiddenModels: [OPUS], requireCrossCompanyReview: true, maxStepBudgetUsd: 5, maxAutonomy: "prepare", disabledBuiltins: ["service-reviewer", "ticket-triage"],
    extraTriggerLabels: ["ship-it", "deploy-*"], extraCommandWords: ["deploy", "promote"], reportLinkDomains: ["reports.example.com"],
  });

  it("lists nothing when nothing changes", () => {
    expect(lessSafeGuardrailChanges(base, structuredClone(base))).toEqual([]);
  });

  it("lists nothing for changes that only tighten", () => {
    const tighter = guardrails({
      forbiddenModels: [OPUS, GPT], requireCrossCompanyReview: true, maxAgentMonthlyUsd: 10, maxPerRunCeilingUsd: 20, maxStepBudgetUsd: 2, maxAutonomy: "suggest",
      disabledBuiltins: ["service-reviewer", "ticket-triage", "code-reviewer"], extraTriggerLabels: ["ship-it", "deploy-*", "hold"], extraCommandWords: ["deploy", "promote", "release"],
      reportLinkDomains: [],
    });
    expect(lessSafeGuardrailChanges(base, tighter)).toEqual([]);
    // Setting a step limit where there was none tightens too.
    expect(lessSafeGuardrailChanges(defaults(), guardrails({ maxStepBudgetUsd: 3 }))).toEqual([]);
    expect(lessSafeGuardrailChanges(defaults(), guardrails({ requireCrossCompanyReview: true }))).toEqual([]);
  });

  const cases: Array<[string, AgentGuardrails, string]> = [
    ["a model removed from forbiddenModels", guardrails({ ...base, forbiddenModels: [] }), "Allows the model anthropic/claude-opus-4-7 again"],
    ["cross-company review turned off", guardrails({ ...base, requireCrossCompanyReview: false }), "Turns off the rule that a review step uses a model from a different AI company"],
    ["the monthly agent limit raised", guardrails({ ...base, maxAgentMonthlyUsd: 80 }), "Raises the most one agent can spend in a month, from $50 to $80"],
    ["the per-run ceiling raised", guardrails({ ...base, maxPerRunCeilingUsd: 250 }), "Raises the most one run can be limited to, from $100 to $250"],
    ["the step budget limit raised", guardrails({ ...base, maxStepBudgetUsd: 9 }), "Raises the most one step can spend, from $5 to $9"],
    ["the step budget limit removed", guardrails({ ...base, maxStepBudgetUsd: undefined }), "Removes the limit on what one step can spend (it was $5)"],
    ["maxAutonomy raised", guardrails({ ...base, maxAutonomy: "run" }), "Raises how far agents may act on their own, from prepare to run"],
    ["a built-in turned back on", guardrails({ ...base, disabledBuiltins: ["service-reviewer"] }), "Turns Ticket triage back on"],
    ["a trigger label removed", guardrails({ ...base, extraTriggerLabels: ["ship-it"] }), 'Stops treating the label "deploy-*" as a trigger'],
    ["a trigger label changed", guardrails({ ...base, extraTriggerLabels: ["ship-it", "deploy-prod"] }), 'Stops treating the label "deploy-*" as a trigger'],
    ["a command word removed", guardrails({ ...base, extraCommandWords: ["promote"] }), 'Stops treating "deploy" as a command word'],
    ["a report domain added", guardrails({ ...base, reportLinkDomains: ["reports.example.com", "docs.example.com"] }), "Lets agent reports link to docs.example.com"],
  ];
  it.each(cases)("lists %s", (_name, next, change) => {
    expect(lessSafeGuardrailChanges(base, next)).toEqual([change]);
  });

  it("matches a forbidden model by its canonical name, so the same model on another route is the same entry", () => {
    const bedrock = guardrails({ forbiddenModels: [{ provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-7-v1:0" }] });
    expect(lessSafeGuardrailChanges(guardrails({ forbiddenModels: [OPUS] }), bedrock)).toEqual([]);
    expect(lessSafeGuardrailChanges(bedrock, guardrails({ forbiddenModels: [GPT] }))).toEqual(["Allows the model amazon-bedrock/us.anthropic.claude-opus-4-7-v1:0 again"]);
  });

  it("lists every change, in a fixed order, when several relax at once", () => {
    const next = guardrails({ ...base, requireCrossCompanyReview: false, maxAutonomy: "run", reportLinkDomains: ["reports.example.com", "x.example.org"] });
    expect(lessSafeGuardrailChanges(base, next)).toHaveLength(3);
  });
});

describe("reading and writing", () => {
  async function stores() {
    const h = await createDeveloperTaskBroker({ orgResolver, register: false, brokerExtra: { agents: { projectMembers: new FakeProjectMembers() } } });
    const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
    const deps = { store, documentClient: h.db, tableName: "state" };
    return { h, store, deps };
  }

  it("reads the defaults for an org that never changed them, at revision 0", async () => {
    const { deps } = await stores();
    expect(await readGuardrails(deps, TEST_ORG)).toEqual(defaults());
    expect(await readGuardrailsWithRevision(deps, TEST_ORG)).toEqual({ guardrails: defaults(), revision: 0 });
  });

  it("writes the document and counts the revision, each org apart", async () => {
    const { deps, h } = await stores();
    const first = await writeGuardrails(deps, TEST_ORG, guardrails({ maxAutonomy: "suggest", forbiddenModels: [OPUS] }), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    expect(first).toMatchObject({ revision: 1, guardrails: { maxAutonomy: "suggest" } });
    expect(await readGuardrails(deps, TEST_ORG)).toMatchObject({ maxAutonomy: "suggest", forbiddenModels: [OPUS] });
    expect(h.db.get(agentGuardrailsKey(TEST_ORG))).toMatchObject({ entityType: "AGENT_GUARDRAILS", revision: 1, updatedBy: DANA.developerId });
    expect(await readGuardrails(deps, ORG_B)).toEqual(defaults());
    const second = await writeGuardrails(deps, TEST_ORG, guardrails({ maxAutonomy: "suggest" }), fixtureActor(deps, TEST_ORG, OWEN.developerId, true).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(deps, TEST_ORG, OWEN.developerId, true) });
    expect(second.revision).toBe(2);
  });

  it("refuses a write against a revision that moved, and writes nothing", async () => {
    const { deps } = await stores();
    await writeGuardrails(deps, TEST_ORG, guardrails({ maxAutonomy: "suggest" }), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    for (const expectedRevision of [0, 5]) {
      const error = await writeGuardrails(deps, TEST_ORG, guardrails(), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) }).then(() => undefined, (thrown: Error) => thrown);
      expect(error?.message).toMatch(/^AGENT_REVISION_CONFLICT: Someone else changed the company's agent guardrails/);
    }
    expect(await readGuardrails(deps, TEST_ORG)).toMatchObject({ maxAutonomy: "suggest" });
  });

  it("stores no step limit when none is set", async () => {
    const { deps, h } = await stores();
    await writeGuardrails(deps, TEST_ORG, guardrails({ maxStepBudgetUsd: 4 }), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    expect((await readGuardrails(deps, TEST_ORG)).maxStepBudgetUsd).toBe(4);
    await writeGuardrails(deps, TEST_ORG, guardrails(), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    expect(await readGuardrails(deps, TEST_ORG)).not.toHaveProperty("maxStepBudgetUsd");
    expect(JSON.stringify(h.db.get(agentGuardrailsKey(TEST_ORG)))).not.toContain("maxStepBudgetUsd");
  });

  it("refuses to read a stored document that is not valid, rather than falling back to the defaults", async () => {
    const { deps, h } = await stores();
    h.db.set({ ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 3, guardrails: { maxAutonomy: "free" }, updatedBy: "x", updatedAt: "x" });
    const error = await readGuardrails(deps, TEST_ORG).then(() => undefined, (thrown: Error) => thrown);
    expect(error?.message).toMatch(/^CONFIG_INVALID: your company's agent guardrails can't be read/);
  });

  it("is not marked as an approval record, a request item or another org's", async () => {
    const { deps, h } = await stores();
    await writeGuardrails(deps, TEST_ORG, guardrails({ maxAutonomy: "suggest" }), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    expect(h.db.get(approvalKey(TEST_ORG, "apr_aaaaaaaaaaaaaaaaaaaa"))).toBeUndefined();
    expect(h.db.get(orgProjectCatalogKey(TEST_ORG, "x"))).toBeUndefined();
  });
});

// ---- through the broker

type Reply = { status: number; body: Record<string, unknown> };

async function setup(options: { servable?: ModelIdentifier[]; builtins?: ConstructorParameters<typeof AgentStore>[0]["builtins"] } = {}) {
  const members = new FakeProjectMembers();
  const servableModels = options.servable === undefined ? undefined : async () => options.servable!;
  const h = await createDeveloperTaskBroker({
    orgResolver, register: false,
    brokerExtra: { agents: { projectMembers: members, ...(servableModels === undefined ? {} : { servableModels }), ...(options.builtins === undefined ? {} : { builtins: options.builtins }) } },
  });
  const enroll = async (who: Developer, role: OrgRole) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
  };
  await enroll(DANA, "admin");
  await enroll(OWEN, "owner");
  await enroll(EVE, "member");
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web" });
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now, ...(options.builtins === undefined ? {} : { builtins: options.builtins }) });
  const deps: ApprovalDependencies = {
    store, projectMembers: members, documentClient: h.db, tableName: "state", now: Date.now, confirmOrigin: "https://cell.example.com",
    signInStore: new DeveloperSignInStore({ documentClient: h.db, tableName: "signin", now: Date.now }),
    ...(servableModels === undefined ? {} : { servableModels }),
  };
  const unwrapped = async (reply: Promise<Reply>): Promise<Reply> => {
    const { requestId: _requestId, ...body } = (await reply).body; // eslint-disable-line @typescript-eslint/no-unused-vars
    return { status: (await reply).status, body };
  };
  const call = (who: Developer, method: string, path: string, body?: Record<string, unknown>): Promise<Reply> =>
    unwrapped(h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body }));
  const GUARDRAILS = "/v1/app/org/agent-guardrails";
  const current = async (): Promise<{ guardrails: AgentGuardrails; revision: number }> => {
    const { guardrails, revision } = (await call(EVE, "GET", GUARDRAILS)).body as unknown as { guardrails: AgentGuardrails; revision: number };
    return { guardrails, revision };
  };
  /** Puts `next` against the revision now, as `who`. */
  const put = async (who: Developer, next: AgentGuardrails, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call(who, "PUT", GUARDRAILS, { expectedRevision: (await current()).revision, guardrails: next, ...extra });
  const approvals = () => h.db.find((item) => item.entityType === "APPROVAL") as unknown as ApprovalRecord[];
  return { ...h, members, store, deps, call, current, put, approvals, GUARDRAILS };
}

const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };

describe("GET and PUT /v1/app/org/agent-guardrails", () => {
  it("shows the defaults at revision 0 to any member", async () => {
    const { call, GUARDRAILS } = await setup();
    for (const who of [EVE, DANA, OWEN]) {
      const shown = await call(who, "GET", GUARDRAILS);
      expect(shown.status).toBe(200);
      // The comment-trigger opt-outs (Task 14b) are listed with the document; there are none.
      expect(shown.body).toEqual({ guardrails: defaults(), revision: 0, commentTriggerOptOuts: [] });
    }
  });

  it("answers another org's caller with that org's own document", async () => {
    const { call, put, GUARDRAILS } = await setup();
    expect((await put(DANA, guardrails({ maxAutonomy: "suggest" }))).status).toBe(200);
    expect((await call(OMAR, "GET", GUARDRAILS)).body).toEqual({ guardrails: defaults(), revision: 0, commentTriggerOptOuts: [] });
  });

  it("refuses a member's PUT with 403 and changes nothing", async () => {
    const { put, current } = await setup();
    const refused = await put(EVE, guardrails({ maxAutonomy: "suggest" }));
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("FORBIDDEN");
    expect(await current()).toEqual({ guardrails: defaults(), revision: 0 });
  });

  it("applies a change that only tightens at once, for an admin and for an owner", async () => {
    const { put, current } = await setup();
    const first = await put(DANA, guardrails({ forbiddenModels: [OPUS], maxAutonomy: "suggest" }));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ revision: 1, guardrails: { forbiddenModels: [OPUS], maxAutonomy: "suggest" } });
    const second = await put(OWEN, guardrails({ forbiddenModels: [OPUS, GPT], maxAutonomy: "suggest", extraCommandWords: ["deploy"] }));
    expect(second.status).toBe(200);
    expect((await current()).revision).toBe(2);
    expect((await current()).guardrails.extraCommandWords).toEqual(["deploy"]);
  });

  it("answers a PUT that changes nothing without writing", async () => {
    const { put, current, approvals } = await setup();
    const same = await put(DANA, defaults());
    expect(same.status).toBe(200);
    expect(same.body).toEqual({ guardrails: defaults(), revision: 0 });
    expect(await current()).toEqual({ guardrails: defaults(), revision: 0 });
    expect(approvals()).toEqual([]);
  });

  it("answers a repeat of an applied request from the first answer, and refuses the same id for another request", async () => {
    const { call, current, GUARDRAILS } = await setup();
    const body = { requestId: randomUUID(), expectedRevision: 0, guardrails: guardrails({ maxAutonomy: "suggest" }) };
    const first = await call(DANA, "PUT", GUARDRAILS, body);
    const again = await call(DANA, "PUT", GUARDRAILS, body);
    expect(first.status).toBe(200);
    expect(again).toEqual(first);
    expect((await current()).revision).toBe(1);
    const other = await call(DANA, "PUT", GUARDRAILS, { ...body, guardrails: guardrails({ maxAutonomy: "suggest", forbiddenModels: [OPUS] }) });
    expect(other.status).toBe(400);
    expect(errorOf(other)).toEqual({ code: "CONFIG_INVALID", message: "requestId: this request ID was already used for a different request" });
  });

  it("refuses a PUT against a revision that has moved", async () => {
    const { call, put, GUARDRAILS } = await setup();
    await put(DANA, guardrails({ maxAutonomy: "suggest" }));
    const stale = await call(DANA, "PUT", GUARDRAILS, { expectedRevision: 0, guardrails: guardrails({ maxAutonomy: "suggest", forbiddenModels: [OPUS] }) });
    expect(stale.status).toBe(409);
    expect(errorOf(stale).code).toBe("AGENT_REVISION_CONFLICT");
  });

  it.each<[string, Record<string, unknown>]>([
    ["no request id", { requestId: undefined }],
    ["no expected revision", { expectedRevision: undefined }],
    ["a field it does not know", { surprise: true }],
    ["guardrails with a field it does not know", { guardrails: { ...defaults(), surprise: 1 } }],
    ["guardrails with a bad autonomy", { guardrails: { ...defaults(), maxAutonomy: "free" } }],
    ["too many forbidden models", { guardrails: { ...defaults(), forbiddenModels: Array.from({ length: 51 }, (_, index) => claude(`m-${String(index)}`)) } }],
  ])("refuses a body with %s", async (_name, change) => {
    const { dev, current } = await setup();
    const body = { requestId: randomUUID(), expectedRevision: 0, guardrails: defaults(), ...change };
    const reply = await dev(DANA, "PUT", "/v1/app/org/agent-guardrails", Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)));
    expect(reply.status, JSON.stringify(reply.body)).toBe(400);
    expect(await current()).toEqual({ guardrails: defaults(), revision: 0 });
  });

  it("reports a bad field by its path", async () => {
    const { call, GUARDRAILS } = await setup();
    const reply = await call(DANA, "PUT", GUARDRAILS, { expectedRevision: 0, guardrails: { ...defaults(), reportLinkDomains: ["https://example.com"] } });
    expect(errorOf(reply).message).toMatch(/^guardrails\.reportLinkDomains\.0: must be an exact host name/);
  });
});


describe("relaxations wait for the confirmation page (R9-3, R69)", () => {
  const strict = guardrails({
    forbiddenModels: [OPUS], requireCrossCompanyReview: true, maxAgentMonthlyUsd: 20, maxPerRunCeilingUsd: 40, maxStepBudgetUsd: 5, maxAutonomy: "suggest",
    disabledBuiltins: ["service-reviewer"], extraTriggerLabels: ["ship-it"], extraCommandWords: ["deploy", "promote"], reportLinkDomains: ["reports.example.com"],
  });
  const stricter = async () => {
    const made = await setup();
    // Seeded directly: asking for these on the defaults would itself wait (it adds a report host).
    await writeGuardrails(made.deps, TEST_ORG, strict, fixtureActor(made.deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(made.deps, TEST_ORG, DANA.developerId, true) });
    return made;
  };

  const cases: Array<[string, Partial<AgentGuardrails>, string]> = [
    ["raising maxAutonomy", { maxAutonomy: "prepare" }, "Raises how far agents may act on their own, from suggest to prepare"],
    ["removing deploy from extraCommandWords", { extraCommandWords: ["promote"] }, 'Stops treating "deploy" as a command word'],
    ["adding a reportLinkDomains host", { reportLinkDomains: ["reports.example.com", "docs.example.com"] }, "Lets agent reports link to docs.example.com"],
    ["shortening disabledBuiltins", { disabledBuiltins: [] }, "Turns Service reviewer back on"],
    ["removing a forbidden model", { forbiddenModels: [] }, "Allows the model anthropic/claude-opus-4-7 again"],
    ["turning cross-company review off", { requireCrossCompanyReview: false }, "Turns off the rule that a review step uses a model from a different AI company"],
    ["raising the monthly agent limit", { maxAgentMonthlyUsd: 30 }, "Raises the most one agent can spend in a month, from $20 to $30"],
    ["raising the per-run ceiling", { maxPerRunCeilingUsd: 60 }, "Raises the most one run can be limited to, from $40 to $60"],
    ["raising the step limit", { maxStepBudgetUsd: 8 }, "Raises the most one step can spend, from $5 to $8"],
    ["removing a trigger label", { extraTriggerLabels: [] }, 'Stops treating the label "ship-it" as a trigger'],
  ];

  it.each(cases)("%s answers 202 with a link and the change, and changes nothing", async (_name, change, text) => {
    const { put, current, approvals } = await stricter();
    const before = await current();
    const asked = await put(DANA, { ...strict, ...change });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: "NEEDS_CONFIRMATION", changes: [text] });
    const [record] = approvals();
    expect(asked.body.confirmUrl).toBe(`https://abc123.execute-api.us-east-1.amazonaws.com/v1/app/approve/${record!.approvalId}`);
    expect(record).toMatchObject({
      kind: "change", status: "PENDING", requestedBy: DANA.developerId, changes: [text],
      subject: { kind: "guardrails", next: { ...strict, ...change }, expectedRevision: before.revision },
      approvers: { kind: "rule", rule: "org_admin" },
    });
    expect(await current()).toEqual(before);
  });

  it("removing the step limit waits too", async () => {
    const { put, current } = await stricter();
    const { maxStepBudgetUsd: _limit, ...open } = strict; // eslint-disable-line @typescript-eslint/no-unused-vars
    const asked = await put(DANA, open);
    expect(asked.status).toBe(202);
    expect(asked.body.changes).toEqual(["Removes the limit on what one step can spend (it was $5)"]);
    expect((await current()).guardrails.maxStepBudgetUsd).toBe(5);
  });

  it("lists the org's owners and admins as the people asked, and no member", async () => {
    const { put, approvals } = await stricter();
    await put(DANA, { ...strict, maxAutonomy: "run" });
    const spec = approvals()[0]!.approvers as Extract<ApproverSpec, { kind: "rule" }>;
    expect([...spec.candidates].sort()).toEqual([DANA.developerId, OWEN.developerId].sort());
  });

  it("makes a change that tightens one thing and relaxes another wait as a whole", async () => {
    const { put, current } = await stricter();
    const asked = await put(DANA, { ...strict, forbiddenModels: [OPUS, GPT], maxAutonomy: "run" });
    expect(asked.status).toBe(202);
    expect(asked.body.changes).toEqual(["Raises how far agents may act on their own, from suggest to run"]);
    // The model that was added is not forbidden yet either.
    expect((await current()).guardrails.forbiddenModels).toEqual([OPUS]);
  });

  it("answers a repeat of a waiting request with the same link and one record", async () => {
    const { call, approvals, current, GUARDRAILS } = await stricter();
    const body = { requestId: randomUUID(), expectedRevision: (await current()).revision, guardrails: { ...strict, maxAutonomy: "run" } };
    const first = await call(DANA, "PUT", GUARDRAILS, body);
    const again = await call(DANA, "PUT", GUARDRAILS, body);
    expect(again).toEqual(first);
    expect(approvals()).toHaveLength(1);
    const other = await call(DANA, "PUT", GUARDRAILS, { ...body, guardrails: { ...strict, maxAutonomy: "prepare" } });
    expect(other.status).toBe(400);
    expect(errorOf(other)).toEqual({ code: "CONFIG_INVALID", message: "requestId: this request ID was already used for a different request" });
  });

  it("applies exactly the stored change when it is confirmed, crediting the person who confirmed it", async () => {
    const { put, current, approvals, deps, db } = await stricter();
    const asked = await put(DANA, { ...strict, maxAutonomy: "prepare", forbiddenModels: [OPUS, GPT] });
    expect(asked.status).toBe(202);
    const [record] = approvals();
    await getApprovalSubjectHandler("guardrails")!(deps, { ...record!, decidedBy: OWEN.developerId });
    expect(await current()).toEqual({ guardrails: { ...strict, maxAutonomy: "prepare", forbiddenModels: [OPUS, GPT] }, revision: 2 });
    expect(db.get(agentGuardrailsKey(TEST_ORG))?.updatedBy).toBe(OWEN.developerId);
  });

  it("is applied once when its handler is driven again after it applied (the sweep redrives it), and still refuses guardrails that differ", async () => {
    const { put, current, approvals, deps, db } = await stricter();
    await put(DANA, { ...strict, maxAutonomy: "prepare" });
    const [record] = approvals();
    const handler = getApprovalSubjectHandler("guardrails")!;
    await handler(deps, { ...record!, decidedBy: OWEN.developerId });
    expect((await current()).revision).toBe(2);
    // The broker died before the record ended: the sweep runs the handler again and finds the guardrails as approved.
    await handler(deps, { ...record!, decidedBy: OWEN.developerId });
    expect(await current()).toEqual({ guardrails: { ...strict, maxAutonomy: "prepare" }, revision: 2 });
    expect(db.get(agentGuardrailsKey(TEST_ORG))?.updatedBy).toBe(OWEN.developerId);
    // Someone else's change to other guardrails since is still a stale record.
    expect((await put(OWEN, { ...strict, maxAutonomy: "prepare", forbiddenModels: [OPUS, GPT] })).status).toBe(200);
    const stale = await handler(deps, { ...record!, decidedBy: OWEN.developerId }).then(() => undefined, (thrown: Error) => thrown);
    expect(stale?.message).toMatch(/^AGENT_REVISION_CONFLICT: /);
  });

  it("is not applied if the guardrails changed after it was asked, and not without a person who decided it", async () => {
    const { put, current, approvals, deps } = await stricter();
    await put(DANA, { ...strict, maxAutonomy: "run" });
    const [record] = approvals();
    const handler = getApprovalSubjectHandler("guardrails")!;
    const undecided = await handler(deps, record!).then(() => undefined, (thrown: Error) => thrown);
    expect(undecided?.message).toMatch(/^CONFIG_INVALID: this change has not been decided by anyone/);
    // A tightening lands in between.
    expect((await put(OWEN, { ...strict, forbiddenModels: [OPUS, GPT] })).status).toBe(200);
    const stale = await handler(deps, { ...record!, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown);
    expect(stale?.message).toBe("AGENT_REVISION_CONFLICT: The company's agent guardrails changed after this was asked. Ask again.");
    expect((await current()).guardrails.maxAutonomy).toBe("suggest");
  });

  it("reads back as a guardrails change and refuses a stored change whose document is not valid", async () => {
    const { put, approvals, deps, db } = await stricter();
    await put(DANA, { ...strict, maxAutonomy: "run" });
    const [record] = approvals();
    expect(await getApproval(deps, TEST_ORG, record!.approvalId)).toMatchObject({ subject: { kind: "guardrails", next: { maxAutonomy: "run" } } });
    db.set({ ...approvalKey(TEST_ORG, record!.approvalId), entityType: "APPROVAL", ...record, subject: { kind: "guardrails", next: { maxAutonomy: "free" }, expectedRevision: 1 } });
    expect(await getApproval(deps, TEST_ORG, record!.approvalId)).toBeUndefined();
  });

  it("registers org_admin so it re-reads the role now, whatever the session says", async () => {
    const { deps, db } = await setup();
    const rule = getApproverRule("org_admin")!;
    const record = { orgId: TEST_ORG } as ApprovalRecord;
    expect(await rule(deps, record, { orgId: TEST_ORG, developerId: DANA.developerId, orgRole: "member" })).toBe(true);
    expect(await rule(deps, record, { orgId: TEST_ORG, developerId: OWEN.developerId, orgRole: "member" })).toBe(true);
    // Claims to be an admin, is a member now.
    expect(await rule(deps, record, { orgId: TEST_ORG, developerId: EVE.developerId, orgRole: "admin" })).toBe(false);
    expect(await rule(deps, record, { orgId: TEST_ORG, developerId: "9".repeat(64), orgRole: "owner" })).toBe(false);
    expect(await rule(deps, record, { orgId: ORG_B, developerId: DANA.developerId, orgRole: "admin" })).toBe(false);
    // Demoted since signing in.
    seedMembership(db, DANA.developerId, { orgId: TEST_ORG, role: "member" });
    expect(await rule(deps, record, { orgId: TEST_ORG, developerId: DANA.developerId, orgRole: "admin" })).toBe(false);
  });
});

// ---- checking a recipe against the guardrails

const settings = (extra: Record<string, unknown> = {}) => ({ instructions: [], ...extra });
const agentStepOf = (id: string, extra: Record<string, unknown> = {}): ResolvedStep => ({ id, name: id, kind: "agent", workspace: "none", settings: settings(extra) });
const recipeOf = (steps: ResolvedStep[], extra: Partial<ResolvedRecipe> = {}): ResolvedRecipe => ({ ...structuredClone(EMPTY_RECIPE), steps, ...extra });
const BEDROCK_OPUS: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-7" };
const SONNET = claude("claude-sonnet-4-6");

describe("validateRecipeForOrg", () => {
  async function check(recipe: ResolvedRecipe, options: { guardrails?: AgentGuardrails; servable?: ModelIdentifier[] } = {}) {
    const made = await setup(options.servable === undefined ? {} : { servable: options.servable });
    if (options.guardrails !== undefined) await writeGuardrails(made.deps, TEST_ORG, options.guardrails, fixtureActor(made.deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(made.deps, TEST_ORG, DANA.developerId, true) });
    return validateRecipeForOrg(made.deps, TEST_ORG, recipe);
  }

  it("lists the recipe's own structural problems first", async () => {
    expect(await check(recipeOf([]))).toEqual([{ path: "steps", message: "a recipe needs at least one step" }]);
  });

  it("passes a recipe within the defaults, models Rovara's AI serves included", async () => {
    expect(await check(recipeOf([agentStepOf("work", { model: SONNET }), agentStepOf("second", { model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" }, fallbackModel: OPUS })]))).toEqual([]);
    expect(await check(recipeOf([agentStepOf("work")]))).toEqual([]);
  });

  it("refuses a step or fallback model that is forbidden, by canonical name, so another route to the same model is refused too", async () => {
    const forbidding = guardrails({ forbiddenModels: [OPUS] });
    expect(await check(recipeOf([agentStepOf("work", { model: BEDROCK_OPUS })]), { guardrails: forbidding })).toEqual([
      { path: "steps.0.settings.model", message: "amazon-bedrock/us.anthropic.claude-opus-4-7 is forbidden in your company; pick another model" },
    ]);
    expect(await check(recipeOf([agentStepOf("work", { model: SONNET, fallbackModel: OPUS })]), { guardrails: forbidding })).toEqual([
      { path: "steps.0.settings.fallbackModel", message: "anthropic/claude-opus-4-7 is forbidden in your company; pick another model" },
    ]);
    // Forbidding the Bedrock id refuses the Anthropic one.
    expect(await check(recipeOf([agentStepOf("work", { model: OPUS })]), { guardrails: guardrails({ forbiddenModels: [BEDROCK_OPUS] }) })).toHaveLength(1);
    expect(await check(recipeOf([agentStepOf("work", { model: SONNET })]), { guardrails: forbidding })).toEqual([]);
  });

  it("refuses a model no source serves, and accepts it once a source does", async () => {
    const recipe = recipeOf([agentStepOf("work", { model: GPT })]);
    expect(await check(recipe)).toEqual([
      { path: "steps.0.settings.model", message: "openai/gpt-5.4 isn't served by any AI source your company can use; pick a model one of them serves" },
    ]);
    expect(await check(recipe, { servable: WITH_SECOND_COMPANY })).toEqual([]);
    expect(await check(recipeOf([agentStepOf("work", { model: SONNET })]), { servable: [GPT] })).toHaveLength(1);
  });

  it("reports a forbidden model once, not also as unserved", async () => {
    expect(await check(recipeOf([agentStepOf("work", { model: GPT })]), { guardrails: guardrails({ forbiddenModels: [GPT] }), servable: [SONNET] })).toEqual([
      { path: "steps.0.settings.model", message: "openai/gpt-5.4 is forbidden in your company; pick another model" },
    ]);
  });

  it("refuses a step budget above the limit, and nothing when there is no limit", async () => {
    const recipe = recipeOf([agentStepOf("work", { stepBudgetUsd: 8 })]);
    expect(await check(recipe, { guardrails: guardrails({ maxStepBudgetUsd: 5 }) })).toEqual([
      { path: "steps.0.settings.stepBudgetUsd", message: "$8 is more than your company allows for one step ($5)" },
    ]);
    expect(await check(recipe, { guardrails: guardrails({ maxStepBudgetUsd: 8 }) })).toEqual([]);
    expect(await check(recipe)).toEqual([]);
  });

  it("refuses an autonomy above the most allowed, which is prepare until an admin raises it", async () => {
    expect(await check(recipeOf([agentStepOf("work")], { autonomy: "run" }))).toEqual([{ path: "autonomy", message: "run is more than your company allows (prepare)" }]);
    expect(await check(recipeOf([agentStepOf("work")], { autonomy: "prepare" }))).toEqual([]);
    expect(await check(recipeOf([agentStepOf("work")], { autonomy: "run" }), { guardrails: guardrails({ maxAutonomy: "run" }) })).toEqual([]);
    expect(await check(recipeOf([agentStepOf("work")], { autonomy: "prepare" }), { guardrails: guardrails({ maxAutonomy: "suggest" }) })).toHaveLength(1);
  });

  describe("cross-company review", () => {
    const on = guardrails({ requireCrossCompanyReview: true });
    const build = (extra: Record<string, unknown> = {}): ResolvedStep => ({ id: "build", name: "Build", kind: "build", settings: settings(extra) });
    const review = (extra: Record<string, unknown> = {}): ResolvedStep => ({ id: "review", name: "Review", kind: "review", reviewers: ["code"], settings: settings(extra) });
    const different = "set the review step to a model from a different AI company than the build step";
    const noSecond = "your company has no AI source from a second AI company, so cross-company review can't be met; add one under AI sources";

    it("says which step to change when a second company is available", async () => {
      const sameCompany = recipeOf([build({ model: SONNET }), review({ model: OPUS })]);
      expect(await check(sameCompany, { guardrails: on, servable: WITH_SECOND_COMPANY })).toEqual([{ path: "steps.1", message: different }]);
      expect(await check(recipeOf([build({ model: SONNET }), review({ model: GPT })]), { guardrails: on, servable: WITH_SECOND_COMPANY })).toEqual([]);
      // The same model on another route is the same company.
      expect(await check(recipeOf([build({ model: SONNET }), review({ model: BEDROCK_OPUS })]), { guardrails: on, servable: WITH_SECOND_COMPANY })).toEqual([{ path: "steps.1", message: different }]);
    });

    it("says so plainly when no source offers a second company", async () => {
      expect(await check(recipeOf([build({ model: SONNET }), review({ model: OPUS })]), { guardrails: on })).toEqual([{ path: "steps.1", message: noSecond }]);
      expect(await check(recipeOf([build({ model: SONNET }), review({ model: OPUS })]), { guardrails: on, servable: [SONNET, OPUS] })).toEqual([{ path: "steps.1", message: noSecond }]);
    });

    it("needs the review step's company to differ from every build step's, fallbacks included", async () => {
      const recipe = recipeOf([build({ model: SONNET }), { ...build({ model: GPT }), id: "build2", name: "Build 2" }, review({ model: GPT })]);
      expect(await check(recipe, { guardrails: on, servable: WITH_SECOND_COMPANY })).toEqual([{ path: "steps.2", message: "set the review step to a model from a different AI company than the build2 step" }]);
      const viaFallback = recipeOf([build({ model: SONNET }), review({ model: GPT, fallbackModel: OPUS })]);
      expect(await check(viaFallback, { guardrails: on, servable: WITH_SECOND_COMPANY })).toEqual([{ path: "steps.1", message: different }]);
    });

    it("can't tell the companies when a step names no model, so it asks for one", async () => {
      expect(await check(recipeOf([build({ model: SONNET }), review()]), { guardrails: on, servable: WITH_SECOND_COMPANY })).toEqual([{ path: "steps.1", message: different }]);
      expect(await check(recipeOf([build(), review({ model: GPT })]), { guardrails: on, servable: WITH_SECOND_COMPANY })).toEqual([
        { path: "steps.1", message: "set the build step to a model, so a different AI company can be checked for the review step" },
      ]);
    });

    it("also holds a step that names a step to differ from", async () => {
      const recipe = recipeOf([agentStepOf("draft", { model: SONNET }), agentStepOf("check", { model: OPUS, differentCompanyFrom: "draft" })]);
      expect(await check(recipe, { guardrails: on, servable: WITH_SECOND_COMPANY })).toEqual([
        { path: "steps.1.settings.differentCompanyFrom", message: "set the check step to a model from a different AI company than the draft step" },
      ]);
      expect(await check(recipeOf([agentStepOf("draft", { model: SONNET }), agentStepOf("check", { model: GPT, differentCompanyFrom: "draft" })]), { guardrails: on, servable: WITH_SECOND_COMPANY })).toEqual([]);
    });

    it("does not count a company it does not recognise as different, whichever side it is on", async () => {
      // Claude reached through a route modelCompany does not know is still Anthropic's, but reads as an unrecognised company.
      const vertex: ModelIdentifier = { provider: "google-vertex", modelId: "claude-opus-4-7" };
      const served = [SONNET, GPT, vertex];
      expect(await check(recipeOf([build({ model: vertex }), review({ model: SONNET })]), { guardrails: on, servable: served })).toEqual([{ path: "steps.1", message: different }]);
      expect(await check(recipeOf([build({ model: SONNET }), review({ model: vertex })]), { guardrails: on, servable: served })).toEqual([{ path: "steps.1", message: different }]);
      // An unrecognised company on the build side can't be told apart from the review's, whatever the review uses.
      expect(await check(recipeOf([build({ model: vertex }), review({ model: GPT })]), { guardrails: on, servable: served })).toEqual([{ path: "steps.1", message: different }]);
    });

    it("says there is no second company when the only other models are unrecognised or forbidden", async () => {
      const mistral: ModelIdentifier = { provider: "mistral", modelId: "large" };
      const sameCompany = recipeOf([build({ model: SONNET }), review({ model: OPUS })]);
      expect(await check(sameCompany, { guardrails: on, servable: [SONNET, OPUS, mistral] })).toEqual([{ path: "steps.1", message: noSecond }]);
      expect(await check(sameCompany, { guardrails: guardrails({ requireCrossCompanyReview: true, forbiddenModels: [GPT] }), servable: WITH_SECOND_COMPANY })).toEqual([{ path: "steps.1", message: noSecond }]);
      // A second company that is usable still gets the instruction to switch.
      expect(await check(sameCompany, { guardrails: guardrails({ requireCrossCompanyReview: true, forbiddenModels: [mistral] }), servable: [SONNET, OPUS, GPT, mistral] })).toEqual([{ path: "steps.1", message: different }]);
    });

    it("accepts a Nova review of a Claude build once Bedrock families are known (SH33), and still refuses an unrecognised Bedrock model", async () => {
      const nova: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" };
      const novaEu: ModelIdentifier = { provider: "amazon-bedrock", modelId: "eu.amazon.nova-lite-v1:0" };
      const unrecognised: ModelIdentifier = { provider: "amazon-bedrock", modelId: "ai21.jamba-1-5-large-v1:0" };
      const claudeOnly = [SONNET, OPUS];
      expect(await check(recipeOf([build({ model: SONNET }), review({ model: nova })]), { guardrails: on, servable: [...claudeOnly, nova] })).toEqual([]);
      // Nova is itself a second company the company can use, so the plain "no second company" message no longer applies when Nova is served.
      expect(await check(recipeOf([build({ model: SONNET }), review({ model: OPUS })]), { guardrails: on, servable: [...claudeOnly, nova] })).toEqual([{ path: "steps.1", message: different }]);
      // Two Nova regions are one company; a fallback of the build's company still fails.
      expect(await check(recipeOf([build({ model: nova }), review({ model: novaEu })]), { guardrails: on, servable: [...claudeOnly, nova, novaEu] })).toEqual([{ path: "steps.1", message: different }]);
      expect(await check(recipeOf([build({ model: SONNET }), review({ model: nova, fallbackModel: OPUS })]), { guardrails: on, servable: [...claudeOnly, nova] })).toEqual([{ path: "steps.1", message: different }]);
      // An unrecognised Bedrock model neither passes nor counts as a second company.
      expect(await check(recipeOf([build({ model: SONNET }), review({ model: unrecognised })]), { guardrails: on, servable: [...claudeOnly, unrecognised] })).toEqual([{ path: "steps.1", message: noSecond }]);
    });

    it("asks nothing of review steps while the rule is off", async () => {
      expect(await check(recipeOf([build({ model: SONNET }), review({ model: OPUS })]), { servable: WITH_SECOND_COMPANY })).toEqual([]);
    });
  });
});

// ---- publishing through the guardrails

const agentStepSpec = (id: string, settingsOf: Record<string, unknown> = {}) => ({ id, name: id, kind: "agent" as const, workspace: "none" as const, ...(Object.keys(settingsOf).length === 0 ? {} : { settings: settingsOf }) });
const overlayWith = (settingsOf: Record<string, unknown> = {}, extra: Partial<RecipeOverlay> = {}): RecipeOverlay => ({ instructions: "Summarise the open tickets.", sequence: [agentStepSpec("work", settingsOf)], ...extra });

async function agents(options: { servable?: ModelIdentifier[] } = {}) {
  const made = await setup(options);
  const create = async (who: Developer, overlay: RecipeOverlay): Promise<AgentId> => {
    const created = await made.call(who, "POST", "/v1/app/agents", { name: `Agent ${randomUUID().slice(0, 8)}`, overlay });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body.agent as { agentId: AgentId }).agentId;
  };
  const saveDraft = async (who: Developer, agentId: AgentId, overlay: RecipeOverlay): Promise<Reply> => {
    const draft = await made.call(who, "GET", `/v1/app/agents/${agentId}/draft`);
    return made.call(who, "PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: (draft.body.draft as { revision: number }).revision, overlay });
  };
  const publish = async (who: Developer, agentId: AgentId): Promise<Reply> => {
    const draft = await made.call(who, "GET", `/v1/app/agents/${agentId}/draft`);
    return made.call(who, "POST", `/v1/app/agents/${agentId}/publish`, { expectedRevision: (draft.body.draft as { revision: number }).revision });
  };
  /** Publishes `overlay` as the next version directly in the store, skipping the guardrails, as a version from before they tightened. */
  const seed = async (agentId: AgentId, overlay: RecipeOverlay) => {
    const draft = (await made.store.getDraft(TEST_ORG, agentId))!;
    await made.store.saveDraft({ orgId: TEST_ORG, agentId, overlay, expectedRevision: draft.revision, by: DANA.developerId });
    const agent = (await made.store.get(TEST_ORG, agentId))!;
    await made.store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(made.store, TEST_ORG, agentId, "draft")), by: DANA.developerId });
  };
  const forbid = (next: Partial<AgentGuardrails>) => writeGuardrails(made.deps, TEST_ORG, guardrails(next), fixtureActor(made.deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(made.deps, TEST_ORG, DANA.developerId, true) });
  return { ...made, create, saveDraft, publish, seed, forbid };
}

describe("publishing is refused when the guardrails forbid the recipe", () => {
  it("refuses a forbidden model, with its path, and publishes nothing", async () => {
    const { create, publish, forbid, call, store } = await agents();
    await forbid({ forbiddenModels: [OPUS] });
    const agentId = await create(EVE, overlayWith({ model: BEDROCK_OPUS }));
    const refused = await publish(EVE, agentId);
    expect(refused.status).toBe(400);
    expect(errorOf(refused)).toEqual({
      code: "CONFIG_INVALID", message: "steps.0.settings.model: amazon-bedrock/us.anthropic.claude-opus-4-7 is forbidden in your company; pick another model",
    });
    expect((await call(EVE, "GET", `/v1/app/agents/${agentId}/versions`)).body.versions).toEqual([]);
    expect((await store.get(TEST_ORG, agentId))?.currentVersion).toBeUndefined();
  });

  it("lets the draft be saved with the model, and publishes once the model is changed", async () => {
    const { create, saveDraft, publish, forbid } = await agents();
    await forbid({ forbiddenModels: [OPUS] });
    const agentId = await create(EVE, overlayWith({ model: OPUS }));
    expect((await publish(EVE, agentId)).status).toBe(400);
    expect((await saveDraft(EVE, agentId, overlayWith({ model: SONNET }))).status).toBe(200);
    expect((await publish(EVE, agentId)).status).toBe(200);
  });

  it("refuses a model no source serves unless a source does", async () => {
    const plain = await agents();
    const agentId = await plain.create(EVE, overlayWith({ model: GPT }));
    expect(errorOf(await plain.publish(EVE, agentId)).message).toBe("steps.0.settings.model: openai/gpt-5.4 isn't served by any AI source your company can use; pick a model one of them serves");
    const served = await agents({ servable: WITH_SECOND_COMPANY });
    expect((await served.publish(EVE, await served.create(EVE, overlayWith({ model: GPT })))).status).toBe(200);
  });

  it("refuses a step budget above the limit and autonomy above the most allowed", async () => {
    const { create, publish, forbid } = await agents();
    await forbid({ maxStepBudgetUsd: 3 });
    expect(errorOf(await publish(EVE, await create(EVE, overlayWith({ stepBudgetUsd: 4 })))).message).toBe("steps.0.settings.stepBudgetUsd: $4 is more than your company allows for one step ($3)");
    expect(errorOf(await publish(EVE, await create(EVE, overlayWith({}, { autonomy: "run" })))).message).toBe("autonomy: run is more than your company allows (prepare)");
  });

  it("refuses a review step from the build step's company, with the plan's text", async () => {
    const { create, publish, forbid } = await agents({ servable: WITH_SECOND_COMPANY });
    await forbid({ requireCrossCompanyReview: true });
    const sequence = [
      { id: "plan", name: "Plan", kind: "plan" as const }, { id: "build", name: "Build", kind: "build" as const, settings: { model: SONNET } }, { id: "check", name: "Check", kind: "check" as const },
      { id: "review", name: "Review", kind: "review" as const, reviewers: ["code" as const, "security" as const], onFindings: { backTo: "build", maxRounds: 3 }, settings: { model: OPUS } },
      { id: "pr", name: "Pull request", kind: "pull_request" as const },
    ];
    const agentId = await create(EVE, { sequence });
    expect(errorOf(await publish(EVE, agentId)).message).toBe("steps.3: set the review step to a model from a different AI company than the build step");
  });

  it("says there is no second company when no source offers one", async () => {
    const { create, publish, forbid } = await agents();
    await forbid({ requireCrossCompanyReview: true });
    const sequence = [
      { id: "build", name: "Build", kind: "build" as const, settings: { model: SONNET } },
      { id: "review", name: "Review", kind: "review" as const, reviewers: ["code" as const], settings: { model: OPUS } },
    ];
    expect(errorOf(await publish(EVE, await create(EVE, { sequence }))).message)
      .toBe("steps.1: your company has no AI source from a second AI company, so cross-company review can't be met; add one under AI sources");
  });

  it("checks a confirmed publish against the guardrails as they are then, so a tightening in between refuses it", async () => {
    const { create, seed, saveDraft, publish, approvals, deps, store } = await agents();
    await writeGuardrails(deps, TEST_ORG, guardrails({ maxAutonomy: "run" }), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    const agentId = await create(EVE, overlayWith());
    await seed(agentId, overlayWith());
    expect((await saveDraft(EVE, agentId, overlayWith({}, { autonomy: "run" }))).status).toBe(200);
    const asked = await publish(EVE, agentId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const [record] = approvals();
    // An admin lowers the most autonomy allowed before anyone confirms.
    await writeGuardrails(deps, TEST_ORG, guardrails({ maxAutonomy: "prepare" }), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    const error = await getApprovalSubjectHandler("agent_publish")!(deps, { ...record!, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown);
    expect(error?.message).toBe("CONFIG_INVALID: autonomy: run is more than your company allows (prepare)");
    expect((await store.get(TEST_ORG, agentId))?.currentVersion).toBe(1);
  });

  it("refuses a rollback to a version the guardrails now forbid", async () => {
    const { create, seed, forbid, call, store } = await agents();
    const agentId = await create(EVE, overlayWith({ model: OPUS }));
    await seed(agentId, overlayWith({ model: OPUS }));
    await seed(agentId, overlayWith({ model: SONNET }));
    await forbid({ forbiddenModels: [OPUS] });
    const refused = await call(EVE, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 1 });
    expect(refused.status).toBe(400);
    expect(errorOf(refused).message).toBe("steps.0.settings.model: anthropic/claude-opus-4-7 is forbidden in your company; pick another model");
    expect((await store.get(TEST_ORG, agentId))?.currentVersion).toBe(2);
  });

  it("checks a confirmed rollback against the guardrails as they are then", async () => {
    const { create, seed, call, approvals, deps, store } = await agents();
    await writeGuardrails(deps, TEST_ORG, guardrails({ maxAutonomy: "run" }), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    const agentId = await create(EVE, overlayWith());
    await seed(agentId, overlayWith({}, { autonomy: "run" }));
    await seed(agentId, overlayWith());
    const asked = await call(EVE, "POST", `/v1/app/agents/${agentId}/rollback`, { version: 1 });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await writeGuardrails(deps, TEST_ORG, guardrails({ maxAutonomy: "prepare" }), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    const error = await getApprovalSubjectHandler("agent_rollback")!(deps, { ...approvals()[0]!, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown);
    expect(error?.message).toBe("CONFIG_INVALID: autonomy: run is more than your company allows (prepare)");
    expect((await store.get(TEST_ORG, agentId))?.currentVersion).toBe(2);
  });

  it("does not block publishing a recipe that is within the guardrails", async () => {
    const { create, publish, forbid } = await agents();
    await forbid({ forbiddenModels: [OPUS], maxStepBudgetUsd: 5 });
    const published = await publish(EVE, await create(EVE, overlayWith({ model: SONNET, stepBudgetUsd: 5 })));
    expect(published.status, JSON.stringify(published.body)).toBe(200);
  });
});

// ---- turning built-ins off

describe("a built-in agent turned off", () => {
  const OFF = guardrails({ disabledBuiltins: ["service-reviewer"] });
  const TEXT = "Service reviewer is turned off in your company. Ask an admin to turn it on.";
  const builtinIds = (reply: Reply) => (reply.body.agents as Array<{ agentId: string; disabled?: boolean }>).map((agent) => agent.agentId);

  it("is hidden from a member's list and shown to an admin as disabled", async () => {
    const { call, deps } = await setup();
    await writeGuardrails(deps, TEST_ORG, OFF, fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    for (const scope of ["builtin", "all"]) {
      const member = await call(EVE, "GET", `/v1/app/agents?scope=${scope}`);
      expect(builtinIds(member)).not.toContain("service-reviewer");
      expect(builtinIds(member)).toContain("ticket-triage");
      const admin = await call(DANA, "GET", `/v1/app/agents?scope=${scope}`);
      const listed = admin.body.agents as Array<{ agentId: string; disabled?: boolean }>;
      expect(listed.find((agent) => agent.agentId === "service-reviewer")).toMatchObject({ disabled: true });
      expect(listed.filter((agent) => agent.disabled === true).map((agent) => agent.agentId)).toEqual(["service-reviewer"]);
    }
  });

  it("is hidden from the people who list agents through the access check, and shows everything while no built-in is off", async () => {
    const { deps } = await setup();
    const caller = (developerId: string, orgRole: OrgRole) => ({ orgId: TEST_ORG, developerId, orgRole });
    const ids = async (who: ReturnType<typeof caller>) => (await listVisibleAgentsOf(deps, who, "all")).map((agent) => agent.agentId);
    expect(await ids(caller(EVE.developerId, "member"))).toContain("service-reviewer");
    await writeGuardrails(deps, TEST_ORG, OFF, fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    expect(await ids(caller(EVE.developerId, "member"))).not.toContain("service-reviewer");
    expect(await ids(caller(OWEN.developerId, "owner"))).toContain("service-reviewer");
    expect((await listVisibleAgentsOf(deps, caller(OWEN.developerId, "owner"), "all")).find((agent) => agent.agentId === "service-reviewer")?.disabled).toBe(true);
    expect((await listVisibleAgentsOf(deps, caller(OWEN.developerId, "owner"), "all")).find((agent) => agent.agentId === "ticket-triage")).not.toHaveProperty("disabled");
  });

  it("can't start a run, with the turned-off text, while other built-ins and custom agents can", async () => {
    const { deps } = await setup();
    await requireAgentEnabled(deps, TEST_ORG, "service-reviewer");
    await writeGuardrails(deps, TEST_ORG, OFF, fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    const error = await requireAgentEnabled(deps, TEST_ORG, "service-reviewer").then(() => undefined, (thrown: Error) => thrown);
    expect(error?.message).toBe(`AGENT_UNAVAILABLE: ${TEXT}`);
    await requireAgentEnabled(deps, TEST_ORG, "ticket-triage");
    await requireAgentEnabled(deps, TEST_ORG, "agt_aaaaaaaaaaaaaaaaaaaa");
    // Another org's built-ins are its own.
    await requireAgentEnabled(deps, ORG_B, "service-reviewer");
  });

  it("can't be built on: a new agent or a draft that switches to it is refused with the same text", async () => {
    const { call, deps } = await setup();
    const other = await call(EVE, "POST", "/v1/app/agents", { name: "Other", overlay: overlayWith() });
    const otherId = (other.body.agent as { agentId: AgentId }).agentId;
    await writeGuardrails(deps, TEST_ORG, OFF, fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    const created = await call(EVE, "POST", "/v1/app/agents", { name: "Child", extends: "service-reviewer" });
    expect(created.status).toBe(409);
    expect(errorOf(created)).toEqual({ code: "AGENT_UNAVAILABLE", message: TEXT });
    const switched = await call(EVE, "PUT", `/v1/app/agents/${otherId}/draft`, { expectedRevision: 1, overlay: overlayWith(), extends: "service-reviewer" });
    expect(switched.status).toBe(409);
    expect(errorOf(switched).message).toBe(TEXT);
    // A built-in that is on can still be built on.
    expect((await call(EVE, "POST", "/v1/app/agents", { name: "Fine", extends: "ticket-triage" })).status).toBe(201);
  });

  it("leaves an agent already built on it as it was: pinned, readable, editable and publishable", async () => {
    const { call, deps, store } = await setup();
    const child = await call(EVE, "POST", "/v1/app/agents", { name: "Child", extends: "service-reviewer", overlay: { instructions: "Be brief." } });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    const childId = (child.body.agent as { agentId: AgentId }).agentId;
    const pinned = (await store.getDraft(TEST_ORG, childId))!.extends;
    expect(pinned).toMatchObject({ agentId: "service-reviewer", version: currentBuiltinVersion("service-reviewer") });
    await writeGuardrails(deps, TEST_ORG, OFF, fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    expect((await resolveAgent(store, TEST_ORG, childId, "draft")).chain.map((layer) => layer.agentId)).toEqual(["service-reviewer", childId]);
    const shown = await call(EVE, "GET", `/v1/app/agents/${childId}`);
    expect(shown.status).toBe(200);
    const edited = await call(EVE, "PUT", `/v1/app/agents/${childId}/draft`, { expectedRevision: 1, overlay: { instructions: "Be briefer." } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((edited.body.draft as { extends: unknown }).extends).toEqual(pinned);
    const published = await call(EVE, "POST", `/v1/app/agents/${childId}/publish`, { expectedRevision: 2 });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect((await store.getVersion(TEST_ORG, childId, 1))?.extends).toEqual(pinned);
  });

  it("is not found by a member who opens it directly, the same as in the list, while an admin sees it as disabled", async () => {
    const { call, deps } = await setup();
    expect((await call(DANA, "GET", "/v1/app/agents/service-reviewer")).body.agent).not.toHaveProperty("disabled");
    expect((await call(EVE, "GET", "/v1/app/agents/service-reviewer")).status).toBe(200);
    await writeGuardrails(deps, TEST_ORG, OFF, fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    for (const path of ["", "/versions", "/versions/1", "/diff?from=1&to=1"]) {
      const hidden = await call(EVE, "GET", `/v1/app/agents/service-reviewer${path}`);
      expect([path, hidden.status, errorOf(hidden).code]).toEqual([path, 404, "NOT_FOUND"]);
      expect((await call(DANA, "GET", `/v1/app/agents/service-reviewer${path}`)).status, path).toBe(200);
    }
    expect((await call(OWEN, "GET", "/v1/app/agents/service-reviewer")).body.agent).toMatchObject({ disabled: true });
    // The others are still open to a member.
    expect((await call(EVE, "GET", "/v1/app/agents/ticket-triage")).status).toBe(200);
  });

  it("can't be built on through a custom agent that builds on it", async () => {
    const { call, deps, store } = await setup();
    const base = await call(EVE, "POST", "/v1/app/agents", { name: "Base", extends: "service-reviewer", overlay: overlayWith() });
    const baseId = (base.body.agent as { agentId: AgentId }).agentId;
    await store.publish({ orgId: TEST_ORG, agentId: baseId, expectedDraftRevision: 1, digest: recipeDigest(await resolveAgent(store, TEST_ORG, baseId, "draft")), by: EVE.developerId });
    const middle = await call(EVE, "POST", "/v1/app/agents", { name: "Middle", extends: baseId, overlay: overlayWith() });
    expect(middle.status).toBe(201);
    await writeGuardrails(deps, TEST_ORG, OFF, fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    const child = await call(EVE, "POST", "/v1/app/agents", { name: "Child", extends: baseId });
    expect([child.status, errorOf(child)]).toEqual([409, { code: "AGENT_UNAVAILABLE", message: TEXT }]);
    const other = await call(EVE, "POST", "/v1/app/agents", { name: "Other", overlay: overlayWith() });
    const otherId = (other.body.agent as { agentId: AgentId }).agentId;
    const switched = await call(EVE, "PUT", `/v1/app/agents/${otherId}/draft`, { expectedRevision: 1, overlay: overlayWith(), extends: baseId });
    expect([switched.status, errorOf(switched).message]).toEqual([409, TEXT]);
    // A custom agent that does not build on it is fine, and so is one with no published version to build on that chain.
    const plain = await call(EVE, "POST", "/v1/app/agents", { name: "Plain", overlay: overlayWith() });
    const plainId = (plain.body.agent as { agentId: AgentId }).agentId;
    await store.publish({ orgId: TEST_ORG, agentId: plainId, expectedDraftRevision: 1, digest: recipeDigest(await resolveAgent(store, TEST_ORG, plainId, "draft")), by: EVE.developerId });
    expect((await call(EVE, "POST", "/v1/app/agents", { name: "Fine", extends: plainId })).status).toBe(201);
  });

  it("can't be moved to by update-base through a base that builds on it, and moves again once it is turned back on", async () => {
    const { call, deps, store } = await setup();
    const publishDirect = async (agentId: AgentId) => {
      const agent = (await store.get(TEST_ORG, agentId))!;
      await store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")), by: EVE.developerId });
    };
    const base = (await call(EVE, "POST", "/v1/app/agents", { name: "Base", extends: "service-reviewer", overlay: overlayWith() })).body.agent as { agentId: AgentId };
    await publishDirect(base.agentId);
    const child = (await call(EVE, "POST", "/v1/app/agents", { name: "Child", extends: base.agentId, overlay: overlayWith() })).body.agent as { agentId: AgentId };
    // The base moves on to a second version; the child still pins the first.
    const baseDraft = (await store.getDraft(TEST_ORG, base.agentId))!;
    await store.saveDraft({ orgId: TEST_ORG, agentId: base.agentId, overlay: overlayWith({}, { instructions: "Newer." }), expectedRevision: baseDraft.revision, by: EVE.developerId });
    await publishDirect(base.agentId);
    await writeGuardrails(deps, TEST_ORG, OFF, fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    const refused = await call(EVE, "POST", `/v1/app/agents/${child.agentId}/update-base`, { expectedRevision: 1 });
    expect([refused.status, errorOf(refused)]).toEqual([409, { code: "AGENT_UNAVAILABLE", message: TEXT }]);
    expect((await store.getDraft(TEST_ORG, child.agentId))?.extends?.version).toBe(1);
    // Turned back on, the same request moves it.
    await writeGuardrails(deps, TEST_ORG, defaults(), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    expect((await call(EVE, "POST", `/v1/app/agents/${child.agentId}/update-base`, { expectedRevision: 1 })).status).toBe(200);
  });

  it("can't have its pin moved by adopt, asked or confirmed, while it is off", async () => {
    const shipped = BUILTIN_AGENTS["ticket-triage"].versions[0]!.recipe;
    const state = { latest: 1 };
    const builtins = {
      currentVersion: (id: string) => (id === "ticket-triage" ? state.latest : 1),
      defaultPin: (id: string) => (id === "ticket-triage" ? state.latest : 1),
      recipe: (id: string, version: number) => structuredClone(id === "ticket-triage" ? shipped : BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].versions[version - 1]!.recipe),
      name: (id: string) => BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].name,
    };
    const { call, deps, store } = await setup({ builtins });
    await store.ensureBuiltinSettings(TEST_ORG, "ticket-triage");
    state.latest = 3;
    // The pin moves to 2 while the built-in is on, then it is turned off.
    expect((await call(DANA, "POST", "/v1/app/agents/ticket-triage/adopt", { version: 2 })).status).toBe(200);
    await writeGuardrails(deps, TEST_ORG, guardrails({ disabledBuiltins: ["ticket-triage"] }), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    const refused = await call(DANA, "POST", "/v1/app/agents/ticket-triage/adopt", { version: 3 });
    expect([refused.status, errorOf(refused)]).toEqual([409, { code: "AGENT_UNAVAILABLE", message: "Ticket triage is turned off in your company. Ask an admin to turn it on." }]);
    expect((await store.getBuiltinSettings(TEST_ORG, "ticket-triage"))?.pinnedVersion).toBe(2);
    const record = {
      orgId: TEST_ORG, approvalId: "apr_aaaaaaaaaaaaaaaaaaaa", kind: "change" as const, status: "PENDING" as const, requestedBy: DANA.developerId, decidedBy: DANA.developerId, changes: [],
      approvers: { kind: "rule" as const, rule: "org_admin", candidates: [] }, createdAt: "x", expiresAt: "y",
      subject: { kind: "builtin_adopt" as const, agentId: "ticket-triage" as const, version: 3, digest: recipeDigest(shipped), expectedPinnedVersion: 2 },
    };
    const error = await getApprovalSubjectHandler("builtin_adopt")!(deps, record).then(() => undefined, (thrown: Error) => thrown);
    expect(error?.message).toMatch(/^AGENT_UNAVAILABLE: Ticket triage is turned off/);
    expect((await store.getBuiltinSettings(TEST_ORG, "ticket-triage"))?.pinnedVersion).toBe(2);
  });
});


describe("canonical ceiling write precision compatibility", () => {
  it("accepts an exact micro ceiling through PUT without changing another org", async () => {
    const { call, GUARDRAILS } = await setup();
    const result = await call(DANA, "PUT", GUARDRAILS, { expectedRevision: 0, guardrails: guardrails({ maxPerRunCeilingUsd: 0.000001 }) });
    expect(result.status).toBe(200);
    const local = await call(DANA, "GET", GUARDRAILS);
    expect((local.body.guardrails as AgentGuardrails).maxPerRunCeilingUsd).toBe(0.000001);
    const foreign = await call(OMAR, "GET", GUARDRAILS);
    expect((foreign.body.guardrails as AgentGuardrails).maxPerRunCeilingUsd).toBe(DEFAULT_MAX_PER_RUN_CEILING_USD);
  });
  for (const [name, value] of [["sub-micro", 0.0000001], ["fractional micro", 0.0000015], ["float noise", 0.30000000000000004], ["widening sub-micro", 100.0000001]] as const) {
    it(`refuses ${name} at PUT before request or approval persistence`, async () => {
      const { db, call, GUARDRAILS } = await setup();
      const before = db.transactions().length;
      const result = await call(DANA, "PUT", GUARDRAILS, { expectedRevision: 0, guardrails: guardrails({ maxPerRunCeilingUsd: value }) });
      expect(result.status).toBe(400);
      expect(db.get(agentGuardrailsKey(TEST_ORG))).toBeUndefined();
      expect(db.transactions().length).toBe(before);
      expect(JSON.stringify(result.body).includes(String(value))).toBe(false);
    });
    it(`refuses ${name} at the sole store writer before audit or commit`, async () => {
      const { db, deps } = await setup();
      const before = db.transactions().length;
      const error = await deps.store.putGuardrails({ ...({ orgId: TEST_ORG, guardrails: guardrails({ maxPerRunCeilingUsd: value }), expectedRevision: 0, by: DANA.developerId }), by: fixtureActor(deps.store, TEST_ORG, DANA.developerId, true).developerId, actor: fixtureActor(deps.store, TEST_ORG, DANA.developerId, true) }).then(() => undefined, (e: Error) => e);
      expect(error?.message).toBe("CONFIG_INVALID: maxPerRunCeilingUsd: must be a number from 0 to 1000000 with at most 6 decimal places");
      expect(db.get(agentGuardrailsKey(TEST_ORG))).toBeUndefined();
      expect(db.transactions().length).toBe(before);
    });
  }
  for (const value of [0, -0, 0.000001, 0.29, 999999.999999, 1000000]) {
    it(`stores an exact ceiling of ${String(value)} USD unchanged`, async () => {
      const { deps } = await setup();
      const result = await deps.store.putGuardrails({ ...({ orgId: TEST_ORG, guardrails: guardrails({ maxPerRunCeilingUsd: value }), expectedRevision: 0, by: DANA.developerId }), by: fixtureActor(deps.store, TEST_ORG, DANA.developerId, true).developerId, actor: fixtureActor(deps.store, TEST_ORG, DANA.developerId, true) });
      expect(result.revision).toBe(1);
      expect((await readGuardrails(deps, TEST_ORG)).maxPerRunCeilingUsd).toBe(value);
    });
  }
  it("keeps legacy sub-micro rows readable without rounding and requires explicit corrected replacement", async () => {
    const { db, deps } = await setup();
    const old = guardrails({ maxPerRunCeilingUsd: 0.0000001 });
    db.set({ ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: old });
    expect((await readGuardrails(deps, TEST_ORG)).maxPerRunCeilingUsd).toBe(old.maxPerRunCeilingUsd);
    const error = await writeGuardrails(deps, TEST_ORG, old, fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) }).then(() => undefined, (e: Error) => e);
    expect(error?.message).toBe("CONFIG_INVALID: maxPerRunCeilingUsd: must be a number from 0 to 1000000 with at most 6 decimal places");
    expect((await readGuardrailsWithRevision(deps, TEST_ORG)).revision).toBe(1);
    await writeGuardrails(deps, TEST_ORG, guardrails({ maxPerRunCeilingUsd: 0.000001 }), fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    expect((await readGuardrailsWithRevision(deps, TEST_ORG)).revision).toBe(2);
  });
});


describe("required ceiling authority-boundary regressions", () => {
  for (const [name, value] of [
    ["missing", undefined], ["undefined", undefined], ["NaN", NaN], ["infinite", Infinity],
    ["negative", -1], ["over maximum", 1000000.000001], ["string", "1"], ["null", null],
  ] as const) {
    it(`refuses a direct store ceiling that is ${name} without inventing zero`, async () => {
      const { db, deps } = await setup();
      const next: Record<string, unknown> = { ...defaults(), maxPerRunCeilingUsd: value };
      if (name === "missing") delete next.maxPerRunCeilingUsd;
      const before = db.transactions().length;
      const error = await deps.store.putGuardrails({ ...({ orgId: TEST_ORG, guardrails: next as unknown as AgentGuardrails, expectedRevision: 0, by: DANA.developerId }), by: fixtureActor(deps.store, TEST_ORG, DANA.developerId, true).developerId, actor: fixtureActor(deps.store, TEST_ORG, DANA.developerId, true) }).then(() => undefined, (e: Error) => e);
      expect(error?.message).toBe("CONFIG_INVALID: maxPerRunCeilingUsd: must be a number from 0 to 1000000 with at most 6 decimal places");
      expect(db.get(agentGuardrailsKey(TEST_ORG))).toBeUndefined();
      expect(db.transactions().length).toBe(before);
    });
  }
  it("refuses a missing ceiling key at schema and PUT without a default or approval", async () => {
    const { db, call, GUARDRAILS } = await setup();
    const next: Record<string, unknown> = { ...defaults() };
    delete next.maxPerRunCeilingUsd;
    expect(AgentGuardrailsSchema.safeParse(next).success).toBe(false);
    const before = db.transactions().length;
    const result = await call(DANA, "PUT", GUARDRAILS, { expectedRevision: 0, guardrails: next });
    expect(result.status).toBe(400);
    expect(errorOf(result).code).toBe("CONFIG_INVALID");
    expect(errorOf(result).message.startsWith("guardrails.maxPerRunCeilingUsd:")).toBe(true);
    expect(db.get(agentGuardrailsKey(TEST_ORG))).toBeUndefined();
    expect(db.transactions().length).toBe(before);
  });
  it("ends a historical sub-micro guardrails approval failed without changing the document or auditing a change", async () => {
    const { db, deps, put, approvals, current } = await setup();
    const capture = capturingAuditDeps({ db });
    deps.store = new AgentStore({ documentClient: db, tableName: "state", now: Date.now, audit: capture.audit });
    const decide = (approvalId: string) => decideApproval(deps, { orgId: TEST_ORG, developerId: OWEN.developerId, orgRole: "owner" }, approvalId, { requestId: randomUUID(), decision: "APPROVE" });
    // Positive control proves this same handler/store really writes and emits audit.
    expect((await put(DANA, guardrails({ maxPerRunCeilingUsd: 200 }))).status).toBe(202);
    const first = approvals()[0]!;
    expect((await decide(first.approvalId)).status).toBe("APPROVED_DONE");
    expect(capture.recorded().filter(event => event.action === "guardrails.changed").length).toBe(1);
    const before = await current();
    expect((await put(DANA, guardrails({ maxPerRunCeilingUsd: 300 }))).status).toBe(202);
    const pending = approvals().find(record => record.status === "PENDING")!;
    db.set({ ...db.get(approvalKey(TEST_ORG, pending.approvalId)), subject: { kind: "guardrails", next: guardrails({ maxPerRunCeilingUsd: 300.0000001 }), expectedRevision: before.revision } });
    const count = capture.recorded().length;
    expect((await decide(pending.approvalId)).status).toBe("APPROVED_FAILED");
    const ended = await getApproval(deps, TEST_ORG, pending.approvalId);
    expect(ended?.status).toBe("APPROVED_FAILED");
    expect(ended?.failure).toBe("maxPerRunCeilingUsd: must be a number from 0 to 1000000 with at most 6 decimal places");
    expect(await current()).toEqual(before);
    expect(capture.recorded().length).toBe(count);
    expect(capture.pending().length).toBe(0);
  });
});

describe("B8 company PR learning lock through the existing writer",()=>{
 it("locks immediately at PUT and waits for an org admin before allowing again",async()=>{
  const {put,current,approvals}=await setup();const locked=guardrails({prCommentLearning:"locked_off"});expect((await put(DANA,locked)).status).toBe(200);expect((await current()).guardrails.prCommentLearning).toBe("locked_off");
  const requested=await put(DANA,guardrails({prCommentLearning:"allowed"}));expect(requested.status).toBe(202);expect((await current()).guardrails.prCommentLearning).toBe("locked_off");
  expect(approvals().at(-1)).toMatchObject({subject:{kind:"guardrails",next:{prCommentLearning:"allowed"}},approvers:{kind:"rule",rule:"org_admin"}});
 });
});
