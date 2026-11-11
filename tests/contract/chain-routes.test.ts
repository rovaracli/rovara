import "../support/automations-on.js";
import { fixtureActor } from "../support/money-authority.js";
// Plan 4 Task 4: the app's chain routes (`/v1/app/chains*`), through the broker's handler with two orgs. A publish or rollback that makes anything less
// safe than what runs answers 202 with a confirmation link and changes nothing; deciding it is Plan 3's page (R66).
import { projectMemberKey } from "@rovara-code/contracts";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { approvalDecideKind } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { decideApproval, getApprovalSubjectHandler, getApproverRule, type ApprovalDependencies, type ApprovalRecord, type ApproverSpec } from "../../packages/broker/src/agents/approvals.js";
import { AgentStore, type BuiltinSource } from "../../packages/broker/src/agents/store.js";
import { isChainRoute, STARTER_CHAIN_DEFINITION, type ChainRouteDependencies, type ChainTriggerHooks } from "../../packages/broker/src/chains/routes.js";
import { ChainStore, chainDigest } from "../../packages/broker/src/chains/store.js";
import { validateChainForPublish } from "../../packages/broker/src/chains/validate.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import type { AgentId } from "@rovara-code/contracts";
import { BUILTIN_AGENTS, builtinDefaultPin, builtinRecipe, currentBuiltinVersion } from "@rovara-code/contracts";
import { agentXError } from "@rovara-code/contracts";
import type { RecipeOverlay } from "@rovara-code/contracts";
import { DEFAULT_AGENT_GUARDRAILS } from "@rovara-code/contracts";
import { ChainDefinitionSchema, type ChainDefinitionInput } from "@rovara-code/contracts";
import type { OrgId } from "@rovara-code/contracts";
import type { OrgRole } from "../../packages/cloud-contracts/src/org.js";
import { agentGuardrailsKey, approvalKey, orgProjectCatalogKey } from "@rovara-code/contracts";
import { ownerBudgetKey } from "../../packages/cloud-contracts/src/org-scoped-keys.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";
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
const ARJUN = person("6", "Arjun"); // a member
const OWEN = person("7", "Owen"); // org owner
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);
const SAFE_OVERLAY: RecipeOverlay = { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] };

beforeAll(async () => { await loadSlackBroker(); });

type Reply = { status: number; body: Record<string, unknown> };
type Step = ChainDefinitionInput["steps"][number];

const clone = <T,>(value: T): T => structuredClone(value);
/** The example with changes to some steps by id (merged over the step) and extra steps appended. */
function variant(changes: Record<string, Partial<Step>> = {}, extra: Step[] = [], tweak: Partial<ChainDefinitionInput> = {}): ChainDefinitionInput {
  const steps = INVESTIGATE_THEN_FIX.steps.map((step) => (changes[step.id] === undefined ? step : ({ ...step, ...changes[step.id] } as Step)));
  return { ...clone(INVESTIGATE_THEN_FIX), ...tweak, steps: [...clone(steps), ...extra] };
}
/** The example with a review that can go back to fix, at most `bound` times. */
const looped = (bound: number): ChainDefinitionInput => variant({
  review: { next: { kind: "branch", choices: [{ id: "again", description: "The change needs work", to: "fix", maxTraversals: bound }, { id: "done", description: "Good to go", to: "$end" }] } } as Partial<Step>,
});

/** The shipped built-ins, with release 2 of Root-cause analyst: `widen` adds read_write grants, otherwise only its instructions differ. */
function builtinsWithRelease(release: { rootCause: number; widen: boolean; breakV1?: Error }): BuiltinSource {
  return {
    currentVersion: (id) => (id === "root-cause-analyst" ? release.rootCause : currentBuiltinVersion(id as "rovara-code")),
    defaultPin: (id) => (id === "root-cause-analyst" ? release.rootCause : builtinDefaultPin(id as "rovara-code")),
    recipe: (id, version) => {
      if (id === "root-cause-analyst" && version === 1 && release.breakV1 !== undefined) throw release.breakV1;
      // Root-cause analyst here ships version 1 only, so that a test can add release 2 by hand (the real version 2 is not offered).
      if (id !== "root-cause-analyst" || version === 1) return builtinRecipe(id as "rovara-code", version);
      if (version > release.rootCause) throw agentXError("NOT_FOUND", `root-cause-analyst has no version ${String(version)}`);
      const v1 = builtinRecipe("root-cause-analyst", 1);
      return release.widen
        ? { ...v1, chain: [{ ...v1.chain[0]!, version }], tools: v1.tools.map((grant) => ({ ...grant, access: "read_write" as const })) }
        : { ...v1, chain: [{ ...v1.chain[0]!, version }], instructions: [{ agentName: "Root-cause analyst", text: `release ${String(version)}` }] };
    },
    name: (id) => BUILTIN_AGENTS[id as "rovara-code"].name,
  };
}

async function setup(options: { widen?: boolean; audit?: boolean } = {}) {
  const release: { rootCause: number; widen: boolean; breakV1?: Error } = { rootCause: 1, widen: options.widen === true };
  const audit = options.audit === true ? capturingAuditDeps() : undefined;
  const builtins = builtinsWithRelease(release);
  const triggers = {
    enabled: new Set<string>(),
    rechecked: [] as Array<{ orgId: string; chainId: string }>,
    disabledByCheck: [] as Array<{ triggerId: string; problems: Array<{ path: string; message: string }> }>,
    /** Makes the next checks fail, as a trigger store that cannot be reached would. */
    recheckFails: false,
    archived: [] as string[],
    /** Runs once, inside the next check of whether the chain has a trigger: where a test lets something land between a route's read and its write. */
    betweenReadAndWrite: undefined as (() => Promise<void>) | undefined,
  };
  const chainTriggers: ChainTriggerHooks = {
    hasEnabledTriggers: async (_orgId, chainId) => {
      const hook = triggers.betweenReadAndWrite;
      triggers.betweenReadAndWrite = undefined;
      await hook?.();
      return triggers.enabled.has(chainId);
    },
    recheckTriggersForTarget: async (orgId, target) => {
      triggers.rechecked.push({ orgId, chainId: target.chainId });
      if (triggers.recheckFails) throw Object.assign(new Error("secret detail the log must not carry"), { name: "ThrottlingException" });
      return triggers.disabledByCheck;
    },
    disableTriggersForTarget: async (_orgId, target) => { triggers.archived.push(target.chainId); },
  };
  const members = new FakeProjectMembers();
  const h = await createDeveloperTaskBroker({ orgResolver, register: false, brokerExtra: { agents: { projectMembers: members, builtins, chainTriggers } }, ...(audit === undefined ? {} : { audit }) });
  const enroll = async (who: Developer, role: OrgRole) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
    members.setOrgRole(TEST_ORG, who.developerId, role);
  };
  await enroll(DANA, "admin");
  for (const who of [MAX, CARL, EVE, VIV, ARJUN]) await enroll(who, "member");
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web" });
  h.db.set({
    ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 1, updatedBy: DANA.developerId, updatedAt: "2026-10-21T00:00:00.000Z",
    guardrails: { ...(await import("@rovara-code/contracts")).DEFAULT_AGENT_GUARDRAILS, maxAutonomy: "run" },
  });
  members.grant(TEST_ORG, "web", MAX.developerId, "maintainer");
  // The write holds a new accountable maintainer to a real grant row in its own transaction, as the project roles read it.
  h.db.set({ pk: projectMemberKey(TEST_ORG, MAX.developerId, "web").pk, sk: projectMemberKey(TEST_ORG, MAX.developerId, "web").sk, entityType: "MEMBERSHIP", role: "developer", projectRole: "maintainer" });
  members.grant(TEST_ORG, "web", CARL.developerId, "contributor");
  members.grant(TEST_ORG, "web", VIV.developerId, "viewer");
  // Beside the broker's own stores: the same table, so a test can seed a published version without going through the routes.
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now, builtins, ...(audit === undefined ? {} : { audit: audit.audit }) });
  const chains = new ChainStore({ documentClient: h.db, tableName: "state", now: Date.now, agents: store, ...(audit === undefined ? {} : { audit: audit.audit }) });
  const deps: ApprovalDependencies & { chains: ChainStore; chainTriggers: ChainTriggerHooks } = {
    store, chains, chainTriggers, projectMembers: members, documentClient: h.db, tableName: "state", now: Date.now, confirmOrigin: "https://cell.example.com",
    signInStore: new DeveloperSignInStore({ documentClient: h.db, tableName: "signin", now: Date.now }),
  };
  const unwrapped = async (reply: Promise<Reply>): Promise<Reply> => {
    const { requestId: _requestId, ...body } = (await reply).body; // eslint-disable-line @typescript-eslint/no-unused-vars
    return { status: (await reply).status, body };
  };
  const call = (who: Developer, method: string, path: string, body?: Record<string, unknown>): Promise<Reply> =>
    unwrapped(h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body }));
  const create = async (who: Developer, definition: ChainDefinitionInput | null = INVESTIGATE_THEN_FIX, extra: Record<string, unknown> = {}) => {
    const created = await call(who, "POST", "/v1/app/chains", { name: `Chain ${randomUUID().slice(0, 8)}`, ...(definition === null ? {} : { definition }), ...extra });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body.chain as { chainId: string }).chainId;
  };
  const revisionOf = async (who: Developer, chainId: string) => {
    const draft = await call(who, "GET", `/v1/app/chains/${chainId}/draft`);
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    return (draft.body.draft as { revision: number }).revision;
  };
  const putDraft = async (who: Developer, chainId: string, definition: ChainDefinitionInput): Promise<Reply> =>
    call(who, "PUT", `/v1/app/chains/${chainId}/draft`, { expectedRevision: await revisionOf(who, chainId), definition });
  const publish = async (who: Developer, chainId: string): Promise<Reply> =>
    call(who, "POST", `/v1/app/chains/${chainId}/publish`, { expectedDraftRevision: await revisionOf(who, chainId) });
  const asCaller = (who: Developer) => ({ orgId: TEST_ORG, developerId: who.developerId, orgRole: (who === DANA ? "admin" : "member") as OrgRole });
  /** Publishes `definition` as the chain's next version directly in the store, as an earlier confirmed or safe publish would have. */
  const seed = async (chainId: string, definition: ChainDefinitionInput) => {
    const draft = (await chains.getDraft(TEST_ORG, chainId))!;
    await chains.saveDraft({ orgId: TEST_ORG, chainId, definition, expectedRevision: draft.revision, by: MAYA.developerId });
    const chain = (await chains.get(TEST_ORG, chainId))!;
    const checked = await validateChainForPublish(deps, asCaller(MAYA), TEST_ORG, ChainDefinitionSchema.parse(definition));
    expect(checked.problems).toEqual([]);
    await chains.publish({ orgId: TEST_ORG, chainId, expectedDraftRevision: chain.draftRevision, pinned: checked.pinned, digest: chainDigest(checked.pinned), guardrailsRevision: checked.guardrailsRevision, by: MAYA.developerId });
  };
  const state = async (chainId: string) => (await chains.get(TEST_ORG, chainId))!;
  const approvals = () => h.db.find((item) => item.entityType === "APPROVAL") as unknown as ApprovalRecord[];
  /** A custom agent of Maya's with one published version. */
  const customAgent = async (name: string): Promise<AgentId> => {
    const agent = await store.create({ orgId: TEST_ORG, name, owner: { kind: "member", developerId: MAYA.developerId }, overlay: SAFE_OVERLAY, createdBy: MAYA.developerId });
    await store.publish({ orgId: TEST_ORG, agentId: agent.agentId, expectedDraftRevision: agent.draftRevision, digest: "d".repeat(64), by: MAYA.developerId });
    return agent.agentId;
  };
  return { ...h, members, store, chains, deps, call, create, revisionOf, putDraft, publish, seed, state, approvals, release, triggers, customAgent, asCaller, audit };
}

const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };
const candidatesOf = (record: ApprovalRecord): string[] => [...(record.approvers as Extract<ApproverSpec, { kind: "rule" }>).candidates];
const chainOf = (reply: Reply) => reply.body.chain as Record<string, unknown>;
const thrownMessage = (attempt: Promise<unknown>) => attempt.then(() => undefined, (error: Error) => error.message);

describe("create, draft, publish, show and rollback", () => {
  it("builds a chain, saves its draft, publishes it, shows it and rolls back", async () => {
    const { call, putDraft, publish, state } = await setup();
    const created = await call(MAYA, "POST", "/v1/app/chains", { name: "Investigate then fix", description: "Finds causes", definition: INVESTIGATE_THEN_FIX });
    expect(created.status).toBe(201);
    const chain = chainOf(created) as { chainId: string; access: string; draftRevision: number; latestVersion: number; owner: unknown };
    expect(chain).toMatchObject({ name: "Investigate then fix", access: "manage", draftRevision: 1, latestVersion: 0, status: "active", owner: { kind: "member", developerId: MAYA.developerId } });
    for (const hidden of ["orgId", "sharesRevision"]) expect(Object.keys(chain)).not.toContain(hidden);

    const draft = await call(MAYA, "GET", `/v1/app/chains/${chain.chainId}/draft`);
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({ draft: { revision: 1, definition: { start: "investigate" } }, problems: [] });

    const edited = await putDraft(MAYA, chain.chainId, variant({ investigate: { name: "Find out why" } }));
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((edited.body.draft as { revision: number }).revision).toBe(2);

    const first = await publish(MAYA, chain.chainId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ version: { version: 1, publishedBy: MAYA.developerId }, disabledTriggers: [], chain: { currentVersion: 1, latestVersion: 1 } });
    const pinned = (first.body.version as { definition: { steps: Array<{ kind: string; agent?: { version: unknown } }> } }).definition;
    expect(pinned.steps.flatMap((step) => (step.kind === "agent" ? [typeof step.agent!.version] : []))).toEqual(["number", "number", "number"]);

    await putDraft(MAYA, chain.chainId, variant({ investigate: { name: "Find out why, quickly" } }));
    expect((await publish(MAYA, chain.chainId)).status).toBe(200);
    expect((await state(chain.chainId)).currentVersion).toBe(2);

    const shown = await call(MAYA, "GET", `/v1/app/chains/${chain.chainId}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ chain: { currentVersion: 2, access: "manage" }, current: { version: 2, definition: { start: "investigate" } } });

    const versions = await call(MAYA, "GET", `/v1/app/chains/${chain.chainId}/versions`);
    expect((versions.body.versions as Array<{ version: number; current: boolean }>).map((entry) => [entry.version, entry.current])).toEqual([[1, false], [2, true]]);
    const one = await call(MAYA, "GET", `/v1/app/chains/${chain.chainId}/versions/1`);
    expect(one.body).toMatchObject({ version: { version: 1, current: false, digest: expect.stringMatching(/^[a-f0-9]{64}$/) as string }, definition: { start: "investigate" } });
    expect((await call(MAYA, "GET", `/v1/app/chains/${chain.chainId}/versions/9`)).status).toBe(404);

    const rolled = await call(MAYA, "POST", `/v1/app/chains/${chain.chainId}/rollback`, { version: 1 });
    expect(rolled.status, JSON.stringify(rolled.body)).toBe(200);
    expect(rolled.body).toMatchObject({ chain: { currentVersion: 1, latestVersion: 2 }, disabledTriggers: [] });
    expect((await state(chain.chainId)).currentVersion).toBe(1);
  });

  it("makes a starter design when the body has none, and takes an owner and accountable like an agent's", async () => {
    const { call, create, chains } = await setup();
    const chainId = await create(MAYA, null);
    expect((await chains.getDraft(TEST_ORG, chainId))!.definition).toEqual(ChainDefinitionSchema.parse(STARTER_CHAIN_DEFINITION));
    expect((await call(MAYA, "GET", `/v1/app/chains/${chainId}/draft`)).body).toMatchObject({ problems: [] });
    // A project's chain: the caller must maintain the project, and its accountable maintainer must too.
    const noAccountable = await call(MAX, "POST", "/v1/app/chains", { name: "Web chain", owner: { kind: "project", project: "web" } });
    expect(errorOf(noAccountable).message).toMatch(/accountable/);
    const web = await call(MAX, "POST", "/v1/app/chains", { name: "Web chain", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    expect(web.status, JSON.stringify(web.body)).toBe(201);
    expect(chainOf(web)).toMatchObject({ owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId }, access: "manage" });
    const notMaintainer = await call(MAX, "POST", "/v1/app/chains", { name: "Another", owner: { kind: "project", project: "web" }, accountable: { developerId: CARL.developerId } });
    expect(errorOf(notMaintainer)).toMatchObject({ code: "CONFIG_INVALID", message: "accountable: that person needs to be a maintainer of web" });
    expect(errorOf(await call(CARL, "POST", "/v1/app/chains", { name: "Carls", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } })).code).toBe("FORBIDDEN");
    expect(errorOf(await call(EVE, "POST", "/v1/app/chains", { name: "For Maya", owner: { kind: "member", developerId: MAYA.developerId } })).message).toBe("Only an org owner or admin can make someone else a chain's owner.");
  });

  it("refuses bodies with unknown fields, a missing or malformed request id, and a definition that does not parse", async () => {
    const s = await setup();
    const { call } = s;
    const refuse = async (body: Record<string, unknown>) => errorOf(await call(MAYA, "POST", "/v1/app/chains", body));
    expect((await refuse({ name: "X", sneaky: true })).code).toBe("CONFIG_INVALID");
    expect(await refuse({ name: "X", definition: { start: "a", steps: [] } })).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^definition\.steps/) as string });
    expect(await refuse({ name: "X", definition: { ...INVESTIGATE_THEN_FIX, systemPrompt: "x" } })).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^definition/) as string });
    expect(await refuse({ name: "" })).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await refuse({ name: "bad​name" })).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^name: /) as string });
    expect((await s.dev(MAYA, "POST", "/v1/app/chains", { name: "X" })).status).toBe(400);
    expect((await s.dev(MAYA, "POST", "/v1/app/chains", { requestId: "nope", name: "X" })).status).toBe(400);
  });

  it("answers a repeat of the same request with the same chain, once", async () => {
    const s = await setup();
    const body = { requestId: randomUUID(), name: "Once", definition: INVESTIGATE_THEN_FIX };
    const first = await s.dev(MAYA, "POST", "/v1/app/chains", body);
    const again = await s.dev(MAYA, "POST", "/v1/app/chains", body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect((again.body.chain as { chainId: string }).chainId).toBe((first.body.chain as { chainId: string }).chainId);
    expect(await s.chains.list(TEST_ORG)).toHaveLength(1);
    const other = await s.dev(MAYA, "POST", "/v1/app/chains", { ...body, name: "Different" });
    expect(other.status).toBe(400);
    expect((other.body.error as { message: string }).message).toBe("requestId: this request ID was already used for a different request");
  });

  it("answers a repeated publish and rollback with what the first one did", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    const publishBody = { requestId: randomUUID(), expectedDraftRevision: 1 };
    const first = await s.dev(MAYA, "POST", `/v1/app/chains/${chainId}/publish`, publishBody);
    const again = await s.dev(MAYA, "POST", `/v1/app/chains/${chainId}/publish`, publishBody);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect((again.body.version as { version: number }).version).toBe(1);
    expect(await s.chains.listVersions(TEST_ORG, chainId)).toHaveLength(1);
    await s.putDraft(MAYA, chainId, variant({ investigate: { name: "second" } }));
    await s.publish(MAYA, chainId);
    const rollbackBody = { requestId: randomUUID(), version: 1 };
    const rolled = await s.dev(MAYA, "POST", `/v1/app/chains/${chainId}/rollback`, rollbackBody);
    const rolledAgain = await s.dev(MAYA, "POST", `/v1/app/chains/${chainId}/rollback`, rollbackBody);
    expect(rolled.status).toBe(200);
    expect(rolledAgain.status).toBe(200);
    expect((rolledAgain.body.chain as { currentVersion: number }).currentVersion).toBe(1);
  });
});

describe("who can see and change a chain", () => {
  it("answers 404 for a member without access, for another org and for an id that is not one, and 403 for a sharee who can only view", async () => {
    const { call, create, chains } = await setup();
    const chainId = await create(MAYA);
    const name = (await chains.get(TEST_ORG, chainId))!.name;
    expect(errorOf(await call(EVE, "GET", `/v1/app/chains/${chainId}`))).toMatchObject({ code: "NOT_FOUND", message: "no chain has that ID" });
    expect((await call(OMAR, "GET", `/v1/app/chains/${chainId}`)).status).toBe(404);
    expect((await call(OMAR, "GET", `/v1/app/chains/${chainId}/draft`)).status).toBe(404);
    expect((await call(MAYA, "GET", "/v1/app/chains/not-a-chain")).status).toBe(404);
    expect((await call(MAYA, "GET", "/v1/app/chains/chn_zzzzzzzzzzzzzzzzzzzz")).status).toBe(404);
    // The run list (Task 10) needs a chain or a project to list.
    expect(errorOf(await call(MAYA, "GET", "/v1/app/chain-runs"))).toMatchObject({ code: "CONFIG_INVALID" });
    expect((await call(MAYA, "GET", "/v1/app/chain-runs/not-a-run")).status).toBe(404);

    const shared = await call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "view" }] });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect((await call(EVE, "GET", `/v1/app/chains/${chainId}`)).body).toMatchObject({ chain: { access: "view" } });
    const put = await call(EVE, "PUT", `/v1/app/chains/${chainId}/draft`, { expectedRevision: 1, definition: INVESTIGATE_THEN_FIX });
    expect(put.status).toBe(403);
    expect(errorOf(put).message).toBe(`You can view ${name}; edit needs its owner or an org admin to give you edit access.`);
    expect((await call(EVE, "GET", `/v1/app/chains/${chainId}/draft`)).status).toBe(403);
    expect((await call(EVE, "POST", `/v1/app/chains/${chainId}/publish`, { expectedDraftRevision: 1 })).status).toBe(403);
    expect((await call(EVE, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 1 })).status).toBe(403);
    // A viewer can read versions.
    expect((await call(EVE, "GET", `/v1/app/chains/${chainId}/versions`)).status).toBe(200);
  });

  it("lists the chains a caller can see by scope", async () => {
    const { call, create } = await setup();
    const mine = await create(MAYA);
    const theirs = await create(EVE);
    await call(EVE, "PUT", `/v1/app/chains/${theirs}/shares`, { shares: [{ principal: { kind: "member", developerId: MAYA.developerId }, level: "use" }] });
    const web = await call(MAX, "POST", "/v1/app/chains", { name: "Web chain", definition: INVESTIGATE_THEN_FIX, owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    const ids = async (who: Developer, query: string) => ((await call(who, "GET", `/v1/app/chains${query}`)).body.chains as Array<{ chainId: string }>).map((entry) => entry.chainId).sort();
    expect(await ids(MAYA, "")).toEqual([mine, theirs].sort());
    expect(await ids(MAYA, "?scope=mine")).toEqual([mine]);
    expect(await ids(MAYA, "?scope=shared")).toEqual([theirs]);
    expect(await ids(CARL, "?project=web")).toEqual([(chainOf(web).chainId as string)]);
    expect(await ids(OMAR, "")).toEqual([]);
    expect(errorOf(await call(MAYA, "GET", "/v1/app/chains?scope=nope")).code).toBe("CONFIG_INVALID");
    const summary = ((await call(MAYA, "GET", "/v1/app/chains?scope=mine")).body.chains as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(summary).sort()).toEqual(["access", "chainId", "description", "name", "owner", "status"]);
  });

  it("draft edits need edit access, and a stale revision is the chain conflict", async () => {
    const { call, create, putDraft } = await setup();
    const chainId = await create(MAYA);
    await call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "edit" }] });
    expect((await putDraft(EVE, chainId, variant({ investigate: { name: "By Eve" } }))).status).toBe(200);
    const stale = await call(MAYA, "PUT", `/v1/app/chains/${chainId}/draft`, { expectedRevision: 1, definition: INVESTIGATE_THEN_FIX });
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toEqual({ code: "CHAIN_REVISION_CONFLICT", message: "Someone else changed this chain's draft. Reload it and make your change again." });
  });

  it("shows the problems of a draft whose design has an unbounded loop, and refuses to publish it with the loop text", async () => {
    const { call, create, publish, putDraft, state } = await setup();
    const chainId = await create(MAYA);
    const loop = variant({ review: { next: { kind: "branch", choices: [{ id: "again", description: "The change needs work", to: "fix" }, { id: "done", description: "Good", to: "$end" }] } } as Partial<Step> });
    expect((await putDraft(MAYA, chainId, loop)).status).toBe(200);
    const draft = await call(MAYA, "GET", `/v1/app/chains/${chainId}/draft`);
    expect(draft.body.problems).toEqual([{ path: expect.stringMatching(/^steps\.\d$/) as string, message: expect.stringMatching(/ is in a loop with no limit; set maxTraversals on the edge that goes back$/) as string }]);
    const refused = await publish(MAYA, chainId);
    expect(refused.status).toBe(400);
    expect(errorOf(refused)).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^steps\.\d: \w+ is in a loop with no limit; set maxTraversals on the edge that goes back$/) as string });
    expect((await state(chainId)).latestVersion).toBe(0);
  });

  it("refuses to publish a design whose agent the caller cannot use, as an unknown agent", async () => {
    const { call, create, customAgent, state } = await setup();
    const helper = await customAgent("Helper");
    const chainId = await create(EVE, { start: "a", steps: [{ kind: "agent", id: "a", name: "Do", agent: { agentId: helper, version: "current" }, next: { kind: "end" } }] });
    const refused = await call(EVE, "POST", `/v1/app/chains/${chainId}/publish`, { expectedDraftRevision: 1 });
    expect(refused.status).toBe(400);
    expect(errorOf(refused).message).toBe("steps.0.agent: unknown agent");
    expect((await state(chainId)).latestVersion).toBe(0);
  });

  it("publishes and rolls back a chain with an enabled trigger only for someone who manages it", async () => {
    const { call, create, putDraft, publish, triggers, state } = await setup();
    const chainId = await create(MAYA);
    expect((await publish(MAYA, chainId)).status).toBe(200);
    await call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "edit" }] });
    await putDraft(MAYA, chainId, variant({ investigate: { name: "second" } }));
    triggers.enabled.add(chainId);
    const refused = await publish(EVE, chainId);
    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/triggers/) as string });
    expect((await call(EVE, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 1 })).status).toBe(403);
    expect((await state(chainId)).latestVersion).toBe(1);
    // The owner still can.
    expect((await publish(MAYA, chainId)).status).toBe(200);
    triggers.enabled.delete(chainId);
    await putDraft(MAYA, chainId, variant({ investigate: { name: "third" } }));
    expect((await publish(EVE, chainId)).status).toBe(200);
    triggers.enabled.add(chainId);
    expect((await call(EVE, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 1 })).status).toBe(403);
    triggers.enabled.delete(chainId);
    expect((await call(EVE, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 1 })).status).toBe(200);
  });

  it("answers a publish and a rollback with the triggers the check turned off", async () => {
    const { call, create, putDraft, publish, triggers } = await setup();
    const chainId = await create(MAYA);
    triggers.disabledByCheck = [{ triggerId: "ctr_cccccccccccccccccccc", problems: [{ path: "limits.maxRunUsd", message: "set a run limit and a monthly budget before adding an event or schedule trigger" }] }];
    const published = await publish(MAYA, chainId);
    expect(published.body.disabledTriggers).toEqual(triggers.disabledByCheck);
    await putDraft(MAYA, chainId, variant({ investigate: { name: "second" } }));
    await publish(MAYA, chainId);
    const rolled = await call(MAYA, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 1 });
    expect(rolled.body.disabledTriggers).toEqual(triggers.disabledByCheck);
    expect(triggers.rechecked).toEqual([chainId, chainId, chainId].map((id) => ({ orgId: TEST_ORG, chainId: id })));
  });
});

describe("a trigger check that fails after the change was made", () => {
  it("answers the change that was made (not a 500), lists no triggers, and logs a fixed event without the error's text (L5)", async () => {
    const { call, create, putDraft, publish, triggers, state } = await setup();
    const chainId = await create(MAYA);
    triggers.recheckFails = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await putDraft(MAYA, chainId, variant({ investigate: { name: "second" } }));
      const published = await publish(MAYA, chainId);
      expect(published.status, JSON.stringify(published.body)).toBe(200);
      expect(published.body.disabledTriggers).toEqual([]);
      expect(triggers.rechecked).toEqual([{ orgId: TEST_ORG, chainId }]);
      const budget = await call(MAYA, "PUT", `/v1/app/chains/${chainId}/budget`, { monthlyUsd: 5 });
      expect(budget.status, JSON.stringify(budget.body)).toBe(200);
      expect(budget.body.disabledTriggers).toEqual([]);
      expect((await state(chainId)).monthlyBudgetUsd).toBe(5);
      const lines = log.mock.calls.map(call => String(call[0])).filter(line => line.includes("trigger_recheck.failed"));
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toMatchObject({ component: "broker", event: "trigger_recheck.failed", targetKind: "chain", targetId: chainId, error: "ThrottlingException" });
      expect(lines.join("")).not.toContain("secret detail");
    } finally {
      log.mockRestore();
    }
  });
});

describe("archive, owner and shares", () => {
  it("archives and unarchives for a manager only, and archiving turns the triggers off", async () => {
    const { call, create, triggers, state } = await setup();
    const chainId = await create(MAYA);
    await call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "edit" }] });
    expect((await call(EVE, "POST", `/v1/app/chains/${chainId}/archive`, {})).status).toBe(403);
    expect((await call(CARL, "POST", `/v1/app/chains/${chainId}/archive`, {})).status).toBe(404);
    const archived = await call(MAYA, "POST", `/v1/app/chains/${chainId}/archive`, {});
    expect(archived.status).toBe(200);
    expect(chainOf(archived)).toMatchObject({ status: "archived" });
    expect(triggers.archived).toEqual([chainId]);
    expect((await state(chainId)).status).toBe("archived");
    // An archived chain is read-only for an editor.
    expect((await call(EVE, "PUT", `/v1/app/chains/${chainId}/draft`, { expectedRevision: 1, definition: INVESTIGATE_THEN_FIX })).status).toBe(403);
    expect((await call(MAYA, "POST", `/v1/app/chains/${chainId}/unarchive`, {})).status).toBe(200);
    expect((await state(chainId)).status).toBe("active");
    expect(triggers.archived).toEqual([chainId]);
  });

  it("refuses a share save from anyone who does not manage the chain, and saves one from a manager", async () => {
    const { call, create, chains } = await setup();
    const chainId = await create(MAYA);
    const share = (developerId: string, level = "view") => ({ shares: [{ principal: { kind: "member", developerId }, level }] });
    // A person who cannot see it at all, and an editor and a viewer who can: only the first is told it is not found.
    expect((await call(EVE, "PUT", `/v1/app/chains/${chainId}/shares`, share(EVE.developerId))).status).toBe(404);
    expect((await call(EVE, "GET", `/v1/app/chains/${chainId}/shares`)).status).toBe(404);
    await call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, share(CARL.developerId, "edit"));
    const refused = await call(CARL, "PUT", `/v1/app/chains/${chainId}/shares`, share(CARL.developerId, "edit"));
    expect(refused.status).toBe(403);
    expect(errorOf(refused).message).toBe(`You can edit ${(await chains.get(TEST_ORG, chainId))!.name}; manage needs its owner or an org admin.`);
    expect((await call(CARL, "GET", `/v1/app/chains/${chainId}/shares`)).status).toBe(403);
    expect(await chains.listShares(TEST_ORG, chainId)).toHaveLength(1);
    const listed = await call(MAYA, "GET", `/v1/app/chains/${chainId}/shares`);
    expect(listed.body.shares).toMatchObject([{ principal: { kind: "member", developerId: CARL.developerId }, level: "edit", grantedBy: MAYA.developerId }]);
    // An org admin manages every chain.
    expect((await call(DANA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [] })).body.shares).toEqual([]);
    expect(await chains.listShares(TEST_ORG, chainId)).toEqual([]);
  });

  it("refuses shares for an unknown person or project, and too many, as the share rules do", async () => {
    const { call, create } = await setup();
    const chainId = await create(MAYA);
    expect(errorOf(await call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "project", project: "nope" }, level: "view" }] })).message).toBe("shares.0: no project called nope in your company");
    expect(errorOf(await call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: "all" })).code).toBe("CONFIG_INVALID");
  });

  it("moves a chain to another owner for a manager the owner rules allow", async () => {
    const { call, create, state } = await setup();
    const chainId = await create(MAYA);
    const refused = await call(MAYA, "PUT", `/v1/app/chains/${chainId}/owner`, { owner: { kind: "member", developerId: EVE.developerId } });
    expect(errorOf(refused).message).toBe("Only an org owner or admin can hand a chain to another member.");
    expect((await call(CARL, "PUT", `/v1/app/chains/${chainId}/owner`, { owner: { kind: "member", developerId: CARL.developerId } })).status).toBe(404);
    const moved = await call(DANA, "PUT", `/v1/app/chains/${chainId}/owner`, { owner: { kind: "member", developerId: EVE.developerId } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(chainOf(moved)).toMatchObject({ owner: { kind: "member", developerId: EVE.developerId } });
    expect((await state(chainId)).owner).toEqual({ kind: "member", developerId: EVE.developerId });
    const toProject = await call(DANA, "PUT", `/v1/app/chains/${chainId}/owner`, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    expect(chainOf(toProject)).toMatchObject({ owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    expect(errorOf(await call(DANA, "PUT", `/v1/app/chains/${chainId}/owner`, { owner: { kind: "project", project: "web" }, accountable: { developerId: CARL.developerId } })).message).toBe("accountable: that person needs to be a maintainer of web");
  });
});

describe("a publish or rollback that makes something less safe", () => {
  const publishedBaseline = async (definition: ChainDefinitionInput = INVESTIGATE_THEN_FIX, options: { widen?: boolean } = {}) => {
    const s = await setup(options);
    const chainId = await s.create(MAYA);
    await s.seed(chainId, definition);
    return { ...s, chainId };
  };

  const approval = (s: Awaited<ReturnType<typeof publishedBaseline>>) => {
    const [record] = s.approvals();
    expect(s.approvals()).toHaveLength(1);
    return record!;
  };

  const lessSafe: Array<[string, ChainDefinitionInput, ChainDefinitionInput, string]> = [
    ["removes a gate", INVESTIGATE_THEN_FIX, {
      ...clone(INVESTIGATE_THEN_FIX),
      steps: INVESTIGATE_THEN_FIX.steps.filter((step) => step.id !== "approve_fix").map((step) => (step.id === "investigate"
        ? { ...step, next: { kind: "branch", default: "no_fix", choices: [{ id: "fix", description: "The cause is in our code and a code change fixes it", to: "fix" }, { id: "no_fix", description: "Not a code problem, or not enough evidence", to: "$end" }] } } as Step
        : step)),
    }, 'removes the gate "approve_fix"'],
    ["adds Arjun to a gate's approvers", INVESTIGATE_THEN_FIX, variant({ approve_fix: { approvers: [{ kind: "starter" }, { kind: "project_maintainers" }, { kind: "members", developerIds: [ARJUN.developerId] }] } as Partial<Step> }), "approve_fix can now be decided by named people"],
    ["raises maxRunUsd from 30 to 60", INVESTIGATE_THEN_FIX, variant({}, [], { limits: { maxRunUsd: 60 } }), "raises the most one run may cost, from $30 to $60"],
    ["raises a maxTraversals from 2 to 4", looped(2), looped(4), "review may now go back to fix up to 4 times, up from 2"],
    ["adds a branch choice from investigate straight to fix", INVESTIGATE_THEN_FIX, variant({
      investigate: { next: { kind: "branch", default: "no_fix", choices: [{ id: "fix", description: "The cause is in our code and a code change fixes it", to: "approve_fix" }, { id: "no_fix", description: "Not a code problem, or not enough evidence", to: "$end" }, { id: "quick", description: "An obvious fix", to: "fix" }] } } as Partial<Step>,
    }), 'fix can now be reached without passing "approve_fix"'],
    ["appends a deploy step after review", INVESTIGATE_THEN_FIX, variant({ review: { next: { kind: "go", to: "deploy" } } as Partial<Step> }, [{ kind: "agent", id: "deploy", name: "Deploy", agent: { agentId: "code-reviewer", version: "current" }, next: { kind: "end" } }]), `adds step deploy (Code reviewer version ${String(currentBuiltinVersion("code-reviewer"))})`],
    ["raises retries from 0 to 2", INVESTIGATE_THEN_FIX, variant({ fix: { retries: 2 } as Partial<Step> }), "fix may now retry 2 times"],
    ["raises timeoutMinutes from 120 to 600", INVESTIGATE_THEN_FIX, variant({ fix: { timeoutMinutes: 600 } as Partial<Step> }), "fix may now run 600 minutes"],
    ["widens fix's handoff to all", INVESTIGATE_THEN_FIX, variant({ fix: { handoff: "all" } as Partial<Step> }), "fix now receives every earlier report"],
  ];

  it.each(lessSafe)("a publish that %s answers 202 with a link and the change in words, and publishes nothing", async (_name, before, after, change) => {
    const s = await publishedBaseline(before);
    expect((await s.putDraft(MAYA, s.chainId, after)).status).toBe(200);
    const asked = await s.publish(MAYA, s.chainId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: "NEEDS_CONFIRMATION" });
    expect(asked.body.changes).toContain(change);
    const record = approval(s);
    expect(asked.body.confirmUrl).toBe(`https://abc123.execute-api.us-east-1.amazonaws.com/v1/app/approve/${record.approvalId}`);
    expect(record).toMatchObject({ kind: "change", status: "PENDING", requestedBy: MAYA.developerId, subject: { kind: "chain_publish", chainId: s.chainId, draftRevision: 3, expectedCurrentVersion: 1 }, approvers: { kind: "rule", rule: "chain_publish" } });
    expect((await s.state(s.chainId)).currentVersion).toBe(1);
    expect(await s.chains.listVersions(TEST_ORG, s.chainId)).toHaveLength(1);
  });

  it("swapping an agent for a custom one answers 202 naming both, and publishes nothing", async () => {
    const s = await publishedBaseline();
    const helper = await s.customAgent("Helper");
    await s.putDraft(MAYA, s.chainId, variant({ review: { agent: { agentId: helper, version: "current" } } as Partial<Step> }));
    const asked = await s.publish(MAYA, s.chainId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body.changes).toContain(`review now uses Helper version 1 instead of Code reviewer version ${String(currentBuiltinVersion("code-reviewer"))}`);
    expect((await s.state(s.chainId)).currentVersion).toBe(1);
  });

  it("re-pinning to a release that adds a read_write grant answers 202, and one that only edits instructions publishes at once", async () => {
    for (const widen of [true, false]) {
      const s = await publishedBaseline(INVESTIGATE_THEN_FIX, { widen });
      // Release 2 comes out and the org adopts it: the draft's "current" pins it now.
      await s.store.ensureBuiltinSettings(TEST_ORG, "root-cause-analyst");
      s.release.rootCause = 2;
      await s.store.adoptBuiltinVersion({ orgId: TEST_ORG, agentId: "root-cause-analyst", version: 2, expectedPinnedVersion: 1, by: DANA.developerId });
      await s.putDraft(MAYA, s.chainId, variant({ investigate: { name: "Find the cause, again" } }));
      const reply = await s.publish(MAYA, s.chainId);
      if (widen) {
        expect(reply.status, JSON.stringify(reply.body)).toBe(202);
        const changes = reply.body.changes as string[];
        expect(changes[0]).toBe("investigate now uses Root-cause analyst version 2 instead of Root-cause analyst version 1");
        expect(changes.some((change) => change.startsWith("investigate: "))).toBe(true);
        expect((await s.state(s.chainId)).currentVersion).toBe(1);
      } else {
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
        expect((await s.state(s.chainId)).currentVersion).toBe(2);
        expect((reply.body.version as { definition: { steps: Array<{ id: string; agent?: { version: number } }> } }).definition.steps[0]!.agent!.version).toBe(2);
      }
    }
  });

  it("publishes at once an edit of instructions, a lower run limit and narrower approvers, and a first publish", async () => {
    const s = await publishedBaseline();
    for (const [definition, version] of [
      [variant({ fix: { instructions: "Fix it, and say what you changed." } as Partial<Step> }), 2],
      [variant({ fix: { instructions: "Fix it, and say what you changed." } as Partial<Step> }, [], { limits: { maxRunUsd: 10 } }), 3],
      [variant({ fix: { instructions: "Fix it, and say what you changed." }, approve_fix: { approvers: [{ kind: "project_maintainers" }] } as Partial<Step> }, [], { limits: { maxRunUsd: 10 } }), 4],
    ] as Array<[ChainDefinitionInput, number]>) {
      expect((await s.putDraft(MAYA, s.chainId, definition)).status).toBe(200);
      const reply = await s.publish(MAYA, s.chainId);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect((reply.body.version as { version: number }).version).toBe(version);
    }
    expect(s.approvals()).toEqual([]);
    const first = await s.create(MAYA);
    expect((await s.publish(MAYA, first)).status).toBe(200);
  });

  it("answers a retried publish after the page confirmed it with that version, not a new request", async () => {
    const s = await publishedBaseline();
    await s.putDraft(MAYA, s.chainId, variant({}, [], { limits: { maxRunUsd: 60 } }));
    const body = { requestId: randomUUID(), expectedDraftRevision: 3 };
    const asked = await s.dev(MAYA, "POST", `/v1/app/chains/${s.chainId}/publish`, body);
    const again = await s.dev(MAYA, "POST", `/v1/app/chains/${s.chainId}/publish`, body);
    expect(again.status).toBe(202);
    expect(again.body.confirmUrl).toBe(asked.body.confirmUrl);
    expect(s.approvals()).toHaveLength(1);
  });

  it("lists the owner and the org's admins as the people asked, and stores the digest and revision that were shown", async () => {
    const s = await publishedBaseline();
    await s.putDraft(MAYA, s.chainId, variant({}, [], { limits: { maxRunUsd: 60 } }));
    await s.publish(MAYA, s.chainId);
    const record = approval(s);
    expect(candidatesOf(record).sort()).toEqual([DANA.developerId, MAYA.developerId].sort());
    const draft = (await s.chains.getDraft(TEST_ORG, s.chainId))!;
    const checked = await validateChainForPublish(s.deps, s.asCaller(MAYA), TEST_ORG, draft.definition);
    expect((record.subject as { digest: string }).digest).toBe(chainDigest(checked.pinned));
  });

  it("a chain manager confirming on the page with a fresh session publishes exactly that digest; a token or an unfresh proof decides nothing", async () => {
    const s = await publishedBaseline();
    await s.putDraft(MAYA, s.chainId, variant({}, [], { limits: { maxRunUsd: 60 } }));
    const asked = await s.publish(MAYA, s.chainId);
    expect(asked.status).toBe(202);
    const record = approval(s);
    const target = { orgId: TEST_ORG, approvalId: record.approvalId };
    const kind = approvalDecideKind(s.deps);
    // A CLI or MCP token (any proof but a fresh sign-in) is refused, and nothing is published.
    const none = await kind.decide({ ...target, developerId: DANA.developerId }, "approve", { kind: "none" }).then(() => undefined, (thrown: Error) => thrown);
    expect(none?.message).toMatch(/^FORBIDDEN: Decisions are made on the confirmation page/);
    const viaRoute = await s.call(DANA, "POST", `/v1/app/approvals/${record.approvalId}/decide`, { decision: "APPROVE" });
    expect([401, 403, 404]).toContain(viaRoute.status);
    expect((await s.state(s.chainId)).currentVersion).toBe(1);
    // A person who does not manage the chain cannot decide it, even with a fresh session; the page says who can.
    const proof = { kind: "fresh_sign_in" as const, method: "email_code" as const, authTime: new Date().toISOString(), sessionRef: "a".repeat(64) };
    expect(await kind.inspect({ ...target, developerId: EVE.developerId })).toMatchObject({ status: "forbidden", who: "someone who manages the chain: its owner, a maintainer who manages its project's agents, or an organization owner or admin" });
    const shown = await kind.inspect({ ...target, developerId: DANA.developerId });
    expect(shown).toMatchObject({ status: "open", view: { title: "Publish a chain", paragraphs: ["raises the most one run may cost, from $30 to $60"] } });
    // The page says which chain: the changes name steps, and a company has many chains made from one design.
    expect((shown as { view: { facts: Array<{ label: string; value: string }> } }).view.facts).toContainEqual({ label: "Chain", value: (await s.state(s.chainId)).name });
    const outcome = await kind.decide({ ...target, developerId: DANA.developerId }, "approve", proof);
    expect(outcome.message).toMatch(/Approved/);
    expect((await s.state(s.chainId)).currentVersion).toBe(2);
    const version = (await s.chains.getVersion(TEST_ORG, s.chainId, 2))!;
    expect(version.publishedBy).toBe(DANA.developerId);
    expect(version.digest).toBe((record.subject as { digest: string }).digest);
    expect(version.definition.limits).toEqual({ maxRunUsd: 60 });
    expect(s.triggers.rechecked.at(-1)).toEqual({ orgId: TEST_ORG, chainId: s.chainId });
    expect(s.db.get(approvalKey(TEST_ORG, record.approvalId))?.["status"]).toBe("APPROVED_DONE");
  });

  it("the rule lets the chain's owner, a maintainer of its project and an org admin decide, and nobody else", async () => {
    const s = await publishedBaseline();
    await s.putDraft(MAYA, s.chainId, variant({}, [], { limits: { maxRunUsd: 60 } }));
    await s.publish(MAYA, s.chainId);
    const record = approval(s);
    const rule = getApproverRule("chain_publish")!;
    expect(await rule(s.deps, record, s.asCaller(MAYA))).toBe(true);
    expect(await rule(s.deps, record, s.asCaller(DANA))).toBe(true);
    expect(await rule(s.deps, record, s.asCaller(EVE))).toBe(false);
    expect(await rule(s.deps, record, s.asCaller(CARL))).toBe(false);
    expect(await rule(s.deps, record, { orgId: ORG_B, developerId: DANA.developerId, orgRole: "admin" })).toBe(false);
    // Read live: an owner who was handed the chain over to someone else no longer decides.
    await s.chains.setOwner(TEST_ORG, s.chainId, { kind: "member", developerId: EVE.developerId }, DANA.developerId, undefined, undefined, { actor: fixtureActor(s.db, TEST_ORG, DANA.developerId) });
    expect(await rule(s.deps, record, s.asCaller(MAYA))).toBe(false);
    expect(await rule(s.deps, record, s.asCaller(EVE))).toBe(true);
  });

  it("refuses to publish a draft that was edited after the request, with the exact words, and one whose baseline moved", async () => {
    const s = await publishedBaseline();
    await s.putDraft(MAYA, s.chainId, variant({}, [], { limits: { maxRunUsd: 60 } }));
    await s.publish(MAYA, s.chainId);
    const record = approval(s);
    const handler = getApprovalSubjectHandler("chain_publish")!;
    const failure = (thrown: Error | undefined) => thrown?.message;
    await s.putDraft(MAYA, s.chainId, variant({}, [], { limits: { maxRunUsd: 90 } }));
    expect(failure(await handler(s.deps, { ...record, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown))).toBe("CHAIN_REVISION_CONFLICT: The draft changed after this was asked. Publish again.");
    // Back to the draft that was asked about, with a published version that landed since.
    await s.putDraft(MAYA, s.chainId, variant({}, [], { limits: { maxRunUsd: 60 } }));
    expect(await s.chains.listVersions(TEST_ORG, s.chainId)).toHaveLength(1);
    const again = await s.publish(MAYA, s.chainId);
    expect(again.status).toBe(202);
    await s.seed(s.chainId, variant({ investigate: { name: "landed meanwhile" } }));
    const second = s.approvals().sort((left, right) => (right.subject as { draftRevision: number }).draftRevision - (left.subject as { draftRevision: number }).draftRevision)[0]!;
    expect(failure(await handler(s.deps, { ...second, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown))).toBe("CHAIN_REVISION_CONFLICT: The published version changed after this was asked. Publish again.");
    expect((await s.state(s.chainId)).currentVersion).toBe(2);
  });

  it("refuses to apply a change nobody has decided, and one on a chain archived since", async () => {
    const s = await publishedBaseline();
    await s.putDraft(MAYA, s.chainId, variant({}, [], { limits: { maxRunUsd: 60 } }));
    await s.publish(MAYA, s.chainId);
    const record = approval(s);
    for (const kind of ["chain_publish", "chain_rollback"] as const) {
      const error = await getApprovalSubjectHandler(kind)!(s.deps, record).then(() => undefined, (thrown: Error) => thrown);
      expect(error?.message, kind).toMatch(/not been decided/);
    }
    await s.call(MAYA, "POST", `/v1/app/chains/${s.chainId}/archive`, {});
    const archived = await getApprovalSubjectHandler("chain_publish")!(s.deps, { ...record, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown);
    expect(archived?.message).toMatch(/^CHAIN_UNAVAILABLE: .* is archived/);
    // And a change that needs a person is not asked for on an archived chain.
    const refused = await s.publish(MAYA, s.chainId);
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({ code: "CHAIN_UNAVAILABLE", message: expect.stringMatching(/Unarchive it first/) as string });
    expect(s.approvals()).toHaveLength(1);
  });

  it("a less-safe rollback answers 202, changes nothing until a person confirms, and then makes the old version current", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    const withoutGate = {
      ...clone(INVESTIGATE_THEN_FIX),
      steps: INVESTIGATE_THEN_FIX.steps.filter((step) => step.id !== "approve_fix").map((step) => (step.id === "investigate"
        ? { ...step, next: { kind: "branch", default: "no_fix", choices: [{ id: "fix", description: "The cause is in our code and a code change fixes it", to: "fix" }, { id: "no_fix", description: "Not a code problem", to: "$end" }] } } as Step
        : step)),
    };
    await s.seed(chainId, withoutGate);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    const asked = await s.call(MAYA, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 1 });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: "NEEDS_CONFIRMATION", changes: ['removes the gate "approve_fix"'] });
    expect((await s.state(chainId)).currentVersion).toBe(2);
    const record = s.approvals()[0]!;
    expect(record).toMatchObject({ subject: { kind: "chain_rollback", chainId, version: 1, expectedCurrentVersion: 2 }, approvers: { kind: "rule", rule: "chain_publish" } });
    await getApprovalSubjectHandler("chain_rollback")!(s.deps, { ...record, decidedBy: DANA.developerId });
    expect((await s.state(chainId)).currentVersion).toBe(1);
    expect(s.triggers.rechecked.at(-1)).toEqual({ orgId: TEST_ORG, chainId });
    // Rolling forward again adds a gate, which is safe.
    expect((await s.call(MAYA, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 2 })).status).toBe(200);
  });

  it("refuses a confirmed rollback when the published version moved since, and rolling back to the current version", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.seed(chainId, variant({ approve_fix: { approvers: [{ kind: "project_maintainers" }] } as Partial<Step> }));
    await s.seed(chainId, variant({}, [], { limits: { maxRunUsd: 60 } }));
    expect(errorOf(await s.call(MAYA, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 2 })).message).toBe("version: 2 is already the current version");
    expect(errorOf(await s.call(MAYA, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 7 })).message).toMatch(/has no version 7$/);
    const empty = await s.create(MAYA);
    expect(errorOf(await s.call(MAYA, "POST", `/v1/app/chains/${empty}/rollback`, { version: 1 })).code).toBe("CONFIG_INVALID");
  });

  it("rollback checks the target's agents again: one archived since is refused", async () => {
    const s = await setup();
    const helper = await s.customAgent("Helper");
    const chainId = await s.create(MAYA, { start: "a", steps: [{ kind: "agent", id: "a", name: "Do", agent: { agentId: helper, version: "current" }, next: { kind: "end" } }] });
    const onHelper = (instructions?: string): ChainDefinitionInput => ({ start: "a", steps: [{ kind: "agent", id: "a", name: "Do", agent: { agentId: helper, version: "current" }, ...(instructions === undefined ? {} : { instructions }), next: { kind: "end" } }] });
    await s.seed(chainId, onHelper());
    await s.seed(chainId, onHelper("Say what you did."));
    await s.store.archive(TEST_ORG, helper, MAYA.developerId, undefined, { actor: fixtureActor(s.store, TEST_ORG, MAYA.developerId) });
    const refused = await s.call(MAYA, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 1 });
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({ code: "CHAIN_REVISION_CONFLICT", message: "An agent this chain uses changed while it was being rolled back. Roll back again." });
    expect((await s.state(chainId)).currentVersion).toBe(2);
  });
});

describe("what the routes and the confirmation handlers hold to", () => {
  const publishedBaseline = async (options: { widen?: boolean; audit?: boolean } = {}) => {
    const s = await setup(options);
    const chainId = await s.create(MAYA);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    return { ...s, chainId };
  };
  type Baseline = Awaited<ReturnType<typeof publishedBaseline>>;
  const raised = (usd: number) => variant({}, [], { limits: { maxRunUsd: usd } });
  const proof = () => ({ kind: "fresh_sign_in" as const, method: "email_code" as const, authTime: new Date().toISOString(), sessionRef: "a".repeat(64) });
  /** Asks for the less-safe publish of a $60 limit and returns the pending record. */
  const askToRaise = async (s: Baseline) => {
    await s.putDraft(MAYA, s.chainId, raised(60));
    expect((await s.publish(MAYA, s.chainId)).status).toBe(202);
    return s.approvals()[0]!;
  };
  const decided = (record: ApprovalRecord): ApprovalRecord => ({ ...record, decidedBy: DANA.developerId });
  /** The company's guardrails as an admin set them since: no agent above `suggest`. */
  const tighten = (s: Pick<Baseline, "db">) => s.db.set({
    ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 2, updatedBy: DANA.developerId, updatedAt: "2026-10-22T00:00:00.000Z",
    guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxAutonomy: "suggest" },
  });

  it("answers a publish of a draft revision that is not the current one as a conflict, even for a design that would need a person, and asks nobody", async () => {
    const s = await publishedBaseline();
    await s.putDraft(MAYA, s.chainId, raised(60));
    const stale = await s.call(MAYA, "POST", `/v1/app/chains/${s.chainId}/publish`, { expectedDraftRevision: 2 });
    expect(stale.status).toBe(409);
    expect(errorOf(stale).code).toBe("CHAIN_REVISION_CONFLICT");
    expect(s.approvals()).toEqual([]);
    expect((await s.state(s.chainId)).currentVersion).toBe(1);
  });

  it("refuses a publish when the draft was saved again after the chain was read, and asks nobody about the newer design", async () => {
    const s = await publishedBaseline();
    await s.call(MAYA, "PUT", `/v1/app/chains/${s.chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "edit" }] });
    const revision = await s.revisionOf(EVE, s.chainId);
    s.triggers.betweenReadAndWrite = async () => {
      await s.chains.saveDraft({ orgId: TEST_ORG, chainId: s.chainId, definition: raised(60), expectedRevision: revision, by: MAYA.developerId });
    };
    const refused = await s.call(EVE, "POST", `/v1/app/chains/${s.chainId}/publish`, { expectedDraftRevision: revision });
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe("CHAIN_REVISION_CONFLICT");
    expect(s.approvals()).toEqual([]);
  });

  it("asks a person when an edit sends a gate's rejection to the step the gate guards, which the gate used to lead to only by approval", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    const rejectTo = (to: string) => variant({ approve_fix: { onReject: { to, maxTraversals: 2 } } as Partial<Step> });
    await s.seed(chainId, rejectTo("investigate"));
    await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "edit" }] });
    expect((await s.putDraft(EVE, chainId, rejectTo("fix"))).status).toBe(200);
    const asked = await s.publish(EVE, chainId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body.changes).toContain('fix can now be reached without passing "approve_fix"');
    expect((await s.state(chainId)).currentVersion).toBe(1);
  });

  it("answers a retry of a publish the page already confirmed with that version, and publishes nothing more", async () => {
    const s = await publishedBaseline();
    await s.putDraft(MAYA, s.chainId, raised(60));
    const body = { requestId: randomUUID(), expectedDraftRevision: 3 };
    expect((await s.dev(MAYA, "POST", `/v1/app/chains/${s.chainId}/publish`, body)).status).toBe(202);
    await getApprovalSubjectHandler("chain_publish")!(s.deps, decided(s.approvals()[0]!));
    expect((await s.state(s.chainId)).currentVersion).toBe(2);
    const retried = await s.dev(MAYA, "POST", `/v1/app/chains/${s.chainId}/publish`, body);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({ version: { version: 2 }, disabledTriggers: [] });
    expect(await s.chains.listVersions(TEST_ORG, s.chainId)).toHaveLength(2);
  });

  it("refuses a publish when another version became current after the chain was read", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    await s.seed(chainId, variant({ investigate: { name: "second" } }));
    await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "edit" }] });
    await s.putDraft(MAYA, chainId, variant({ investigate: { name: "third" } }));
    const revision = await s.revisionOf(EVE, chainId);
    // The route has read the chain (version 2 runs) when a rollback to version 1 lands; the edit is safe against version 2, but version 2 no longer runs.
    s.triggers.betweenReadAndWrite = async () => { await s.chains.rollback({ orgId: TEST_ORG, chainId, version: 1, expectedCurrentVersion: 2, guardrailsRevision: 1, by: DANA.developerId }); };
    const refused = await s.call(EVE, "POST", `/v1/app/chains/${chainId}/publish`, { expectedDraftRevision: revision });
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe("CHAIN_REVISION_CONFLICT");
    expect(s.triggers.betweenReadAndWrite).toBeUndefined();
    expect(await s.state(chainId)).toMatchObject({ currentVersion: 1, latestVersion: 2 });
  });

  it("answers a repeat of a create from someone who has lost the chain with 404, not the chain", async () => {
    const s = await setup();
    const body = { requestId: randomUUID(), name: "Handed over", definition: INVESTIGATE_THEN_FIX };
    const first = await s.dev(MAYA, "POST", "/v1/app/chains", body);
    expect(first.status).toBe(201);
    const chainId = (first.body.chain as { chainId: string }).chainId;
    await s.chains.setOwner(TEST_ORG, chainId, { kind: "member", developerId: EVE.developerId }, DANA.developerId, undefined, undefined, { actor: fixtureActor(s.db, TEST_ORG, DANA.developerId) });
    const again = await s.dev(MAYA, "POST", "/v1/app/chains", body);
    expect(again.status).toBe(404);
    expect((again.body.error as { code: string }).code).toBe("NOT_FOUND");
  });

  it("holds an owner change to manage: an editor is refused", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "edit" }] });
    const refused = await s.call(EVE, "PUT", `/v1/app/chains/${chainId}/owner`, { owner: { kind: "member", developerId: EVE.developerId } });
    expect(refused.status).toBe(403);
    expect((await s.state(chainId)).owner).toEqual({ kind: "member", developerId: MAYA.developerId });
  });

  it("lets only someone who manages the chain decide, not an editor the chain is shared with at edit", async () => {
    const s = await publishedBaseline();
    const record = await askToRaise(s);
    await s.call(MAYA, "PUT", `/v1/app/chains/${s.chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "edit" }] });
    expect((await s.call(EVE, "GET", `/v1/app/chains/${s.chainId}`)).body).toMatchObject({ chain: { access: "edit" } });
    expect(await getApproverRule("chain_publish")!(s.deps, record, s.asCaller(EVE))).toBe(false);
  });

  it("refuses to publish a draft that was saved again after the request, even when its design is the same", async () => {
    const s = await publishedBaseline();
    const record = await askToRaise(s);
    expect((await s.putDraft(MAYA, s.chainId, raised(60))).status).toBe(200);
    expect(await thrownMessage(getApprovalSubjectHandler("chain_publish")!(s.deps, decided(record)))).toBe("CHAIN_REVISION_CONFLICT: The draft changed after this was asked. Publish again.");
    expect((await s.state(s.chainId)).currentVersion).toBe(1);
  });

  it("refuses to publish when an agent moved since the request, though the draft did not", async () => {
    const s = await publishedBaseline();
    const record = await askToRaise(s);
    // Release 2 of Root-cause analyst (instructions only) is adopted: the draft's "current" now pins version 2, so the design the person was shown is not what would publish.
    await s.store.ensureBuiltinSettings(TEST_ORG, "root-cause-analyst");
    s.release.rootCause = 2;
    await s.store.adoptBuiltinVersion({ orgId: TEST_ORG, agentId: "root-cause-analyst", version: 2, expectedPinnedVersion: 1, by: DANA.developerId });
    expect(await thrownMessage(getApprovalSubjectHandler("chain_publish")!(s.deps, decided(record)))).toBe("CHAIN_REVISION_CONFLICT: The draft changed after this was asked. Publish again.");
    expect((await s.state(s.chainId)).currentVersion).toBe(1);
  });

  it("records a confirmed publish as less safe and one that went through on its own as safe", async () => {
    const s = await publishedBaseline({ audit: true });
    const record = await askToRaise(s);
    await getApprovalSubjectHandler("chain_publish")!(s.deps, decided(record));
    await s.putDraft(MAYA, s.chainId, variant({ investigate: { name: "renamed" } }, [], { limits: { maxRunUsd: 60 } }));
    expect((await s.publish(MAYA, s.chainId)).status).toBe(200);
    const published = s.audit!.recordedBy("chain.published");
    expect(published.map((event) => event.facts)).toMatchObject([{ version: 1, safety: "safe" }, { version: 2, safety: "less_safe" }, { version: 3, safety: "safe" }]);
  });

  describe("a rollback that waits for a person", () => {
    const askToRollBack = async () => {
      const s = await setup();
      const chainId = await s.create(MAYA);
      const withoutGate: ChainDefinitionInput = {
        ...clone(INVESTIGATE_THEN_FIX),
        steps: INVESTIGATE_THEN_FIX.steps.filter((step) => step.id !== "approve_fix").map((step) => (step.id === "investigate"
          ? { ...step, next: { kind: "branch", default: "no_fix", choices: [{ id: "fix", description: "The cause is in our code and a code change fixes it", to: "fix" }, { id: "no_fix", description: "Not a code problem", to: "$end" }] } } as Step
          : step)),
      };
      await s.seed(chainId, withoutGate);
      await s.seed(chainId, INVESTIGATE_THEN_FIX);
      expect((await s.call(MAYA, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 1 })).status).toBe(202);
      return { ...s, chainId, record: s.approvals()[0]! };
    };

    it("shows on the page which chain and which version it is about", async () => {
      const s = await askToRollBack();
      const shown = await approvalDecideKind(s.deps).inspect({ orgId: TEST_ORG, approvalId: s.record.approvalId, developerId: DANA.developerId });
      const facts = (shown as { view: { facts: Array<{ label: string; value: string }> } }).view.facts;
      expect(facts).toContainEqual({ label: "Chain", value: (await s.state(s.chainId)).name });
      expect(facts).toContainEqual({ label: "Version", value: "1" });
    });

    it("refuses to apply it when the version it rolls back to is not the one that was shown", async () => {
      const s = await askToRollBack();
      const tampered = { ...decided(s.record), subject: { ...s.record.subject, digest: "0".repeat(64) } } as ApprovalRecord;
      expect(await thrownMessage(getApprovalSubjectHandler("chain_rollback")!(s.deps, tampered))).toBe("CHAIN_REVISION_CONFLICT: That version changed after this was asked. Roll back again.");
      expect((await s.state(s.chainId)).currentVersion).toBe(2);
    });

    it("refuses to apply it when the version no longer meets the company's guardrails", async () => {
      const s = await askToRollBack();
      tighten(s);
      expect(await thrownMessage(getApprovalSubjectHandler("chain_rollback")!(s.deps, decided(s.record)))).toMatch(/^CONFIG_INVALID: steps\.\d+\.agent\.autonomy: \w+ is more than your company allows \(suggest\)$/);
      expect((await s.state(s.chainId)).currentVersion).toBe(2);
    });

    it("refuses to apply it when the published version moved since it was asked", async () => {
      const s = await askToRollBack();
      await s.seed(s.chainId, variant({}, [], { limits: { maxRunUsd: 60 } }));
      expect(await thrownMessage(getApprovalSubjectHandler("chain_rollback")!(s.deps, decided(s.record)))).toBe("CHAIN_REVISION_CONFLICT: The published version changed after this was asked. Roll back again.");
      expect((await s.state(s.chainId)).currentVersion).toBe(3);
    });
  });

  describe("a rollback is held to the rules of today", () => {
    it("refuses to roll back to a version that breaks the company's guardrails as they are now", async () => {
      const s = await publishedBaseline();
      await s.seed(s.chainId, variant({ investigate: { name: "second" } }));
      tighten(s);
      const refused = await s.call(MAYA, "POST", `/v1/app/chains/${s.chainId}/rollback`, { version: 1 });
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(errorOf(refused)).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^steps\.\d+\.agent\.autonomy: \w+ is more than your company allows \(suggest\)$/) as string });
      expect((await s.state(s.chainId)).currentVersion).toBe(2);
    });

    it("commits the rollback at the guardrails it checked: a store call with another revision is a conflict", async () => {
      const s = await publishedBaseline();
      await s.seed(s.chainId, variant({ investigate: { name: "second" } }));
      await expect(s.chains.rollback({ orgId: TEST_ORG, chainId: s.chainId, version: 1, expectedCurrentVersion: 2, guardrailsRevision: 0, by: MAYA.developerId })).rejects.toMatchObject({ code: "CHAIN_REVISION_CONFLICT" });
      expect((await s.state(s.chainId)).currentVersion).toBe(2);
    });

    const onHelper = (helper: AgentId, instructions?: string): ChainDefinitionInput => ({
      start: "a", steps: [{ kind: "agent", id: "a", name: "Do", agent: { agentId: helper, version: "current" }, ...(instructions === undefined ? {} : { instructions }), next: { kind: "end" } }],
    });

    it("refuses to roll back to a version whose agent the caller can no longer use", async () => {
      const s = await setup();
      const helper = await s.customAgent("Helper");
      const chainId = await s.create(MAYA, onHelper(helper));
      await s.seed(chainId, onHelper(helper));
      await s.seed(chainId, onHelper(helper, "Say what you did."));
      await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "edit" }] });
      const refused = await s.call(EVE, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 1 });
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(errorOf(refused)).toEqual({ code: "CONFIG_INVALID", message: "steps.0.agent: unknown agent" });
      expect((await s.state(chainId)).currentVersion).toBe(2);
      expect((await s.call(MAYA, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 1 })).status).toBe(200);
    });

    it("refuses to apply a confirmed rollback for someone who can no longer use the agents of the version", async () => {
      const s = await setup();
      const helper = await s.customAgent("Helper");
      const rich = (usd: number) => ({ ...onHelper(helper), limits: { maxRunUsd: usd } });
      const chainId = await s.create(MAYA, rich(60));
      await s.seed(chainId, rich(60));
      await s.seed(chainId, rich(30));
      await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "edit" }] });
      await s.store.replaceShares({ orgId: TEST_ORG, agentId: helper, upsert: [{ principal: { kind: "member", developerId: EVE.developerId }, level: "use" }], remove: [], expectedSharesRevision: 0, by: MAYA.developerId });
      const asked = await s.call(EVE, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 1 });
      expect(asked.status, JSON.stringify(asked.body)).toBe(202);
      await s.store.replaceShares({ orgId: TEST_ORG, agentId: helper, upsert: [], remove: [{ kind: "member", developerId: EVE.developerId }], expectedSharesRevision: 1, by: MAYA.developerId });
      expect(await thrownMessage(getApprovalSubjectHandler("chain_rollback")!(s.deps, decided(s.approvals()[0]!)))).toBe("CONFIG_INVALID: steps.0.agent: unknown agent");
      expect((await s.state(chainId)).currentVersion).toBe(2);
    });
  });

  describe("when the version that runs can't be read", () => {
    const withoutRunning = async () => {
      const s = await publishedBaseline();
      await s.seed(s.chainId, variant({ investigate: { name: "second" } }));
      const [item] = s.db.find((found) => found["entityType"] === "CHAIN_VERSION" && found["version"] === 2 && String(found["pk"]).includes(s.chainId));
      s.db.delete({ pk: item!["pk"] as string, sk: item!["sk"] as string });
      return s;
    };

    it("refuses a rollback instead of treating it as a first publish", async () => {
      const s = await withoutRunning();
      const refused = await s.call(MAYA, "POST", `/v1/app/chains/${s.chainId}/rollback`, { version: 1 });
      expect(errorOf(refused).code).toBe("RUNTIME_UNAVAILABLE");
      expect((await s.state(s.chainId)).currentVersion).toBe(2);
    });

    it("refuses a publish, which would otherwise compare with nothing", async () => {
      const s = await withoutRunning();
      await s.putDraft(MAYA, s.chainId, raised(600));
      const refused = await s.publish(MAYA, s.chainId);
      expect(errorOf(refused).code).toBe("RUNTIME_UNAVAILABLE");
      expect((await s.state(s.chainId)).currentVersion).toBe(2);
    });
  });

  it("answers a repeat of a request that was declined meanwhile as closed, not as waiting", async () => {
    const s = await publishedBaseline();
    await s.putDraft(MAYA, s.chainId, raised(60));
    const body = { requestId: randomUUID(), expectedDraftRevision: 3 };
    const asked = await s.dev(MAYA, "POST", `/v1/app/chains/${s.chainId}/publish`, body);
    expect(asked.status).toBe(202);
    const record = s.approvals()[0]!;
    await approvalDecideKind(s.deps).decide({ orgId: TEST_ORG, approvalId: record.approvalId, developerId: DANA.developerId }, "decline", proof());
    const again = await s.dev(MAYA, "POST", `/v1/app/chains/${s.chainId}/publish`, body);
    expect(again.status).toBe(409);
    expect((again.body.error as { code: string; message: string })).toEqual({ code: "APPROVAL_CLOSED", message: "this request was already decided" });
  });

  describe("a re-pin whose earlier version can no longer be read", () => {
    it.each([
      ["without a reason", new Error("gone"), "investigate: its recipe can't be compared with the one before"],
      ["with a reason", Object.assign(new Error("gone"), { problems: [{ path: "instructions", message: "can't be read" }] }), "investigate: instructions: can't be read"],
    ])("waits for a person %s", async (_name, error, finding) => {
      const s = await publishedBaseline();
      await s.store.ensureBuiltinSettings(TEST_ORG, "root-cause-analyst");
      s.release.rootCause = 2;
      await s.store.adoptBuiltinVersion({ orgId: TEST_ORG, agentId: "root-cause-analyst", version: 2, expectedPinnedVersion: 1, by: DANA.developerId });
      s.release.breakV1 = error;
      await s.putDraft(MAYA, s.chainId, variant({ investigate: { name: "Find the cause, again" } }));
      const reply = await s.publish(MAYA, s.chainId);
      expect(reply.status, JSON.stringify(reply.body)).toBe(202);
      expect(reply.body.changes).toEqual(["investigate now uses Root-cause analyst version 2 instead of Root-cause analyst version 1", finding]);
      expect((await s.state(s.chainId)).currentVersion).toBe(1);
    });
  });
});

describe("sharing a chain with the whole company waits for the page", () => {
  const member = (who: Developer, level = "view") => ({ principal: { kind: "member", developerId: who.developerId }, level });
  const company = (level: string) => ({ principal: { kind: "org" }, level });
  const sharesPath = (chainId: string) => `/v1/app/chains/${chainId}/shares`;

  it("answers 202 and stores nothing for a company-wide share, and for raising what the company can do", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [member(EVE)] });
    const asked = await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [member(EVE), company("use")] });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: "NEEDS_CONFIRMATION", changes: [`Shares ${(await s.state(chainId)).name} with everyone in your company, who can then run it`] });
    expect(await s.chains.listShares(TEST_ORG, chainId)).toHaveLength(1);
    expect((await s.call(CARL, "GET", `/v1/app/chains/${chainId}`)).status).toBe(404);
    expect(s.approvals()[0]).toMatchObject({ kind: "change", status: "PENDING", subject: { kind: "chain_share", chainId, expectedSharesRevision: 1 }, approvers: { kind: "rule", rule: "chain_company_share" } });
    // Owner decision 92: only the org's owners and admins are asked; the chain's own author is not.
    expect(candidatesOf(s.approvals()[0]!)).toEqual([DANA.developerId]);
    // Once the company can see it, asking for more is a widening again.
    await s.chains.replaceShares({ orgId: TEST_ORG, chainId, upsert: [{ principal: { kind: "org" }, level: "view" }], remove: [], expectedSharesRevision: (await s.state(chainId)).sharesRevision ?? 0, by: DANA.developerId });
    const raise = await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [member(EVE), company("edit")] });
    expect(raise.status).toBe(202);
    expect(raise.body.changes).toEqual([`Shares ${(await s.state(chainId)).name} with everyone in your company, who can then change it`]);
  });

  it("applies at once a share that does not widen the company's: lowering it, removing it, or the same level", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.chains.replaceShares({ orgId: TEST_ORG, chainId, upsert: [{ principal: { kind: "org" }, level: "edit" }], remove: [], expectedSharesRevision: 0, by: DANA.developerId });
    expect((await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [company("edit")] })).status).toBe(200);
    expect((await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [company("use")] })).status).toBe(200);
    expect((await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [] })).status).toBe(200);
    expect((await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [member(EVE, "edit")] })).status).toBe(200);
    expect(s.approvals()).toEqual([]);
  });

  it("refuses a company-wide share that could not be applied before asking anyone, and one for an archived chain", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    expect((await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [company("use"), company("view")] })).status).toBe(400);
    expect((await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [member(CARL), { principal: { kind: "project", project: "nope" }, level: "view" }, company("view")] })).status).toBe(400);
    expect(s.approvals()).toEqual([]);
    await s.call(MAYA, "POST", `/v1/app/chains/${chainId}/archive`, {});
    const archived = await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [company("view")] });
    expect(errorOf(archived).code).toBe("CHAIN_UNAVAILABLE");
    expect(s.approvals()).toEqual([]);
  });

  it("applies exactly what was asked once a manager confirms, and not once the shares changed in between", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    const handler = getApprovalSubjectHandler("chain_share")!;
    expect(handler).toBeDefined();
    expect((await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [member(EVE), company("view")] })).status).toBe(202);
    const stale = s.approvals()[0]!;
    await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [member(EVE, "edit")] });
    expect(await thrownMessage(handler(s.deps, { ...stale, decidedBy: DANA.developerId }))).toBe("CHAIN_REVISION_CONFLICT: Who this chain is shared with changed after this was asked. Share again.");
    expect((await s.chains.listShares(TEST_ORG, chainId)).map((share) => share.principal.kind)).toEqual(["member"]);
    expect((await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [member(EVE, "edit"), company("view")] })).status).toBe(202);
    const fresh = s.approvals().find((record) => record.approvalId !== stale.approvalId)!;
    expect(await thrownMessage(handler(s.deps, fresh))).toMatch(/not been decided/);
    await handler(s.deps, { ...fresh, decidedBy: DANA.developerId });
    expect((await s.chains.listShares(TEST_ORG, chainId)).map((share) => [share.principal.kind, share.level]).sort()).toEqual([["member", "edit"], ["org", "view"]]);
    expect((await s.call(CARL, "GET", `/v1/app/chains/${chainId}`)).body.chain).toMatchObject({ access: "view" });
  });

  it("is decided on the page, with a title, by someone who manages the chain and not by an editor", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [member(EVE, "edit")] });
    expect((await s.call(MAYA, "PUT", sharesPath(chainId), { shares: [member(EVE, "edit"), company("view")] })).status).toBe(202);
    const record = s.approvals()[0]!;
    const target = { orgId: TEST_ORG, approvalId: record.approvalId };
    const kind = approvalDecideKind(s.deps);
    expect(await kind.inspect({ ...target, developerId: EVE.developerId })).toMatchObject({ status: "forbidden" });
    expect(await kind.inspect({ ...target, developerId: DANA.developerId })).toMatchObject({
      status: "open", view: { title: "Share a chain with the whole company", facts: expect.arrayContaining([{ label: "Chain", value: (await s.state(chainId)).name }]) as unknown[] },
    });
    const proof = { kind: "fresh_sign_in" as const, method: "email_code" as const, authTime: new Date().toISOString(), sessionRef: "a".repeat(64) };
    await kind.decide({ ...target, developerId: DANA.developerId }, "approve", proof);
    expect((await s.chains.listShares(TEST_ORG, chainId)).map((share) => share.principal.kind).sort()).toEqual(["member", "org"]);
    expect(s.db.get(approvalKey(TEST_ORG, record.approvalId))?.["status"]).toBe("APPROVED_DONE");
  });
});

describe("how the broker wires chains", () => {
  it("recognises the chain paths", () => {
    for (const path of ["/v1/app/chains", "/v1/app/chains/chn_aaaaaaaaaaaaaaaaaaaa/draft", "/v1/app/chain-runs", "/v1/app/chain-runs/crn_aaaaaaaaaaaaaaaaaaaa"]) expect(isChainRoute(path), path).toBe(true);
    for (const path of ["/v1/app/chain", "/v1/app/agents", "/v1/app/chainsaw"]) expect(isChainRoute(path), path).toBe(false);
  });

  it("builds the chain store from the agent store, so a rebuilt owner total holds chain budgets", async () => {
    const h = await createDeveloperTaskBroker({ orgResolver, register: false, brokerExtra: { agents: { projectMembers: new FakeProjectMembers() } } });
    const broker = await loadSlackBroker() as unknown as { createAgentRouteDependencies(input: never): ChainRouteDependencies | undefined };
    const deps = broker.createAgentRouteDependencies(h.brokerInput as never)!;
    expect(deps.chains).toBeInstanceOf(ChainStore);
    const chain = await deps.chains.create({ orgId: TEST_ORG, name: "Budgeted", owner: { kind: "member", developerId: MAYA.developerId }, definition: STARTER_CHAIN_DEFINITION, createdBy: MAYA.developerId });
    await deps.chains.setBudget(TEST_ORG, chain.chainId, 12, fixtureActor(deps.chains, TEST_ORG, MAYA.developerId).developerId, undefined, { ...({}), actor: fixtureActor(deps.chains, TEST_ORG, MAYA.developerId) });
    expect(h.db.get(ownerBudgetKey(TEST_ORG, MAYA.developerId))?.["totalUsd"]).toBe(12);
    h.db.delete(ownerBudgetKey(TEST_ORG, MAYA.developerId));
    expect(await deps.store.rebuildOwnerTotal(TEST_ORG, MAYA.developerId)).toBe(12);
  });
});


// Owner decision 92: only an org owner or admin confirms a company-wide chain share (as for an agent's). The chain's author and a project's maintainers ask; they
// never decide, whatever the record's stored candidates say.
describe("who may confirm a company-wide chain share (decision 92)", () => {
  const COMPANY = { principal: { kind: "org" }, level: "use" };
  const decide = (deps: ApprovalDependencies, who: Developer, orgRole: OrgRole, approvalId: string) =>
    decideApproval(deps, { orgId: TEST_ORG, developerId: who.developerId, orgRole }, approvalId, { requestId: randomUUID(), decision: "APPROVE" });

  it("refuses the non-admin author, and a maintainer who owns the project's chain; nothing is shared", async () => {
    const s = await setup();
    const mine = await s.create(MAYA);
    expect((await s.call(MAYA, "PUT", `/v1/app/chains/${mine}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const web = (await s.call(MAX, "POST", "/v1/app/chains", { name: "Web chain", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } })).body.chain as { chainId: string };
    expect((await s.call(MAX, "PUT", `/v1/app/chains/${web.chainId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const [asked, webAsked] = s.approvals();
    // Positive control: both hold manage on their chain, which is what the old rule accepted.
    expect((await s.call(MAYA, "GET", `/v1/app/chains/${mine}`)).body.chain).toMatchObject({ access: "manage" });
    expect((await s.call(MAX, "GET", `/v1/app/chains/${web.chainId}`)).body.chain).toMatchObject({ access: "manage" });
    expect(await thrownMessage(decide(s.deps, MAYA, "member", asked!.approvalId))).toMatch(/^FORBIDDEN: /);
    expect(await thrownMessage(decide(s.deps, MAX, "member", webAsked!.approvalId))).toMatch(/^FORBIDDEN: /);
    expect(await thrownMessage(decide(s.deps, MAYA, "admin", asked!.approvalId))).toMatch(/^FORBIDDEN: /);
    expect(await s.chains.listShares(TEST_ORG, mine)).toEqual([]);
    expect(await s.chains.listShares(TEST_ORG, web.chainId)).toEqual([]);
    expect(s.approvals().map((record) => record.status)).toEqual(["PENDING", "PENDING"]);
  });

  it("lets an org admin, an org owner and an admin who is the author confirm it", async () => {
    const s = await setup();
    seedMembership(s.db, OWEN.developerId, { orgId: TEST_ORG, role: "owner" });
    const byAdmin = await s.create(MAYA);
    const byOwner = await s.create(MAYA);
    const own = await s.create(DANA);
    for (const [asker, chainId] of [[MAYA, byAdmin], [MAYA, byOwner], [DANA, own]] as const) expect((await s.call(asker, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const idOf = (chainId: string) => s.approvals().find((record) => (record.subject as { chainId?: string }).chainId === chainId)!.approvalId;
    expect((await decide(s.deps, DANA, "admin", idOf(byAdmin))).status).toBe("APPROVED_DONE");
    expect((await decide(s.deps, OWEN, "owner", idOf(byOwner))).status).toBe("APPROVED_DONE");
    expect((await decide(s.deps, DANA, "admin", idOf(own))).status).toBe("APPROVED_DONE");
    for (const chainId of [byAdmin, byOwner, own]) expect((await s.chains.listShares(TEST_ORG, chainId)).map((share) => share.principal.kind)).toEqual(["org"]);
  });

  it("holds a request asked before this (rule chain_publish, the author among its candidates) to the same check, judged now", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    expect((await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const [fresh] = s.approvals();
    // Rewritten as the previous code stored it: the chain_publish rule, with the author listed.
    const key = approvalKey(TEST_ORG, fresh!.approvalId);
    s.db.set({ ...s.db.get(key.pk, key.sk)!, approvers: { kind: "rule", rule: "chain_publish", candidates: [MAYA.developerId, DANA.developerId] } });
    expect(candidatesOf(s.approvals()[0]!)).toContain(MAYA.developerId);
    // The page names who may decide it, for this old record too.
    expect(await approvalDecideKind(s.deps).inspect({ orgId: TEST_ORG, developerId: MAYA.developerId, approvalId: fresh!.approvalId })).toMatchObject({ status: "forbidden", who: "an organization owner or admin" });
    expect(await thrownMessage(decide(s.deps, MAYA, "member", fresh!.approvalId))).toMatch(/^FORBIDDEN: /);
    expect(await s.chains.listShares(TEST_ORG, chainId)).toEqual([]);
    expect((await decide(s.deps, DANA, "admin", fresh!.approvalId)).status).toBe("APPROVED_DONE");
    expect(await s.chains.listShares(TEST_ORG, chainId)).toHaveLength(1);
  });

  it("leaves a chain publish to whoever manages the chain, as before", async () => {
    const s = await setup();
    const rule = getApproverRule("chain_publish")!;
    const chainId = await s.create(MAYA);
    const record = { orgId: TEST_ORG, kind: "change", subject: { kind: "chain_publish", chainId } } as unknown as ApprovalRecord;
    expect(await rule(s.deps, record, { orgId: TEST_ORG, developerId: MAYA.developerId, orgRole: "member" })).toBe(true);
    expect(await rule(s.deps, record, { orgId: TEST_ORG, developerId: EVE.developerId, orgRole: "member" })).toBe(false);
  });

  it("says on the page that an owner or admin decides", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    expect((await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const inspected = await approvalDecideKind(s.deps).inspect({ orgId: TEST_ORG, developerId: MAYA.developerId, approvalId: s.approvals()[0]!.approvalId });
    expect(inspected).toMatchObject({ status: "forbidden", who: "an organization owner or admin" });
  });
});

// Opus review of decision 92: M1 (a company-share request is bound to the chain version it was asked about), M2 (a company-shared chain's less-safe publish or
// rollback needs an owner or admin) and L1 (apply-time re-check).
describe("company-shared chains: version binding and who decides a less-safe change (decision 92 review)", () => {
  const COMPANY = { principal: { kind: "org" }, level: "use" } as const;
  const LOOSER = variant({}, [], { limits: { maxRunUsd: 60 } });
  const WITHOUT_GATE: ChainDefinitionInput = {
    ...clone(INVESTIGATE_THEN_FIX),
    steps: INVESTIGATE_THEN_FIX.steps.filter((step) => step.id !== "approve_fix").map((step) => (step.id === "investigate"
      ? { ...step, next: { kind: "branch", default: "no_fix", choices: [{ id: "fix", description: "The cause is in our code and a code change fixes it", to: "fix" }, { id: "no_fix", description: "Not a code problem", to: "$end" }] } } as Step
      : step)),
  };
  const decide = (deps: ApprovalDependencies, who: Developer, orgRole: OrgRole, approvalId: string) =>
    decideApproval(deps, { orgId: TEST_ORG, developerId: who.developerId, orgRole }, approvalId, { requestId: randomUUID(), decision: "APPROVE" });
  const factsOf = async (deps: ApprovalDependencies, who: Developer, approvalId: string) => {
    const inspected = await approvalDecideKind(deps).inspect({ orgId: TEST_ORG, developerId: who.developerId, approvalId });
    if (inspected.status !== "open") throw new Error(`expected an open page, got ${JSON.stringify(inspected)}`);
    return Object.fromEntries(inspected.view.facts.map((fact) => [fact.label, fact.value]));
  };
  const share = (chains: ChainStore, chainId: string) =>
    chains.replaceShares({ orgId: TEST_ORG, chainId, upsert: [COMPANY], remove: [], expectedSharesRevision: 0, by: DANA.developerId });

  it("records the chain version and its digest, and shows them on the page", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    expect((await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const [record] = s.approvals();
    expect(record!.subject).toMatchObject({ kind: "chain_share", expectedCurrentVersion: 1, versionDigest: expect.stringMatching(/^[0-9a-f]{64}$/) as string });
    expect((await factsOf(s.deps, DANA, record!.approvalId))["Version"]).toMatch(/^Version 1 \(running now, digest [0-9a-f]{12}\)$/);
  });

  it("the probe: a looser version the author self-confirmed while the share waited makes the share stale, and nothing is shared", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    expect((await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const shareId = s.approvals()[0]!.approvalId;
    expect((await s.putDraft(MAYA, chainId, LOOSER)).status).toBe(200);
    expect((await s.publish(MAYA, chainId)).status).toBe(202);
    const publishRecord = s.approvals().find((record) => record.subject.kind === "chain_publish")!;
    expect((await decide(s.deps, MAYA, "member", publishRecord.approvalId)).status).toBe("APPROVED_DONE");
    expect((await s.state(chainId)).currentVersion).toBe(2);
    expect((await factsOf(s.deps, DANA, shareId))["Out of date"]).toMatch(/changed since this was asked/);
    expect((await decide(s.deps, DANA, "admin", shareId)).status).toBe("APPROVED_FAILED");
    expect(s.approvals().find((record) => record.approvalId === shareId)!.failure).toMatch(/The chain changed since this was asked\. Share again\./);
    expect(await s.chains.listShares(TEST_ORG, chainId)).toEqual([]);
    expect((await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const again = s.approvals().find((record) => record.subject.kind === "chain_share" && record.approvalId !== shareId)!;
    expect(again.subject).toMatchObject({ expectedCurrentVersion: 2 });
    expect((await factsOf(s.deps, DANA, again.approvalId))["Version"]).toMatch(/^Version 2 /);
    expect((await decide(s.deps, DANA, "admin", again.approvalId)).status).toBe("APPROVED_DONE");
    expect(await s.chains.listShares(TEST_ORG, chainId)).toHaveLength(1);
  });

  it("unshare, approve a looser version, re-share: the re-share is bound to the looser version", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    await share(s.chains, chainId);
    expect((await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [] })).status).toBe(200);
    expect((await s.putDraft(MAYA, chainId, LOOSER)).status).toBe(200);
    expect((await s.publish(MAYA, chainId)).status).toBe(202);
    expect(s.approvals()[0]).toMatchObject({ approvers: { rule: "chain_publish" } });
    expect((await decide(s.deps, MAYA, "member", s.approvals()[0]!.approvalId)).status).toBe("APPROVED_DONE");
    expect((await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const record = s.approvals().find((entry) => entry.subject.kind === "chain_share")!;
    expect(record.subject).toMatchObject({ expectedCurrentVersion: 2 });
    expect((await factsOf(s.deps, DANA, record.approvalId))["Version"]).toMatch(/^Version 2 \(running now/);
    expect((await decide(s.deps, DANA, "admin", record.approvalId)).status).toBe("APPROVED_DONE");
  });

  it("a request stored before it was bound to a version is asked again, not applied", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    expect((await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const [record] = s.approvals();
    const { expectedCurrentVersion: _a, versionDigest: _b, ...legacy } = record!.subject as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars
    const key = approvalKey(TEST_ORG, record!.approvalId);
    s.db.set({ ...s.db.get(key.pk, key.sk)!, subject: legacy });
    expect((await decide(s.deps, DANA, "admin", record!.approvalId)).status).toBe("APPROVED_FAILED");
    expect(await s.chains.listShares(TEST_ORG, chainId)).toEqual([]);
  });

  it("a request whose recorded version digest is not the running version's is asked again, even at the same version number", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    expect((await s.call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const [record] = s.approvals();
    const key = approvalKey(TEST_ORG, record!.approvalId);
    s.db.set({ ...s.db.get(key.pk, key.sk)!, subject: { ...record!.subject, versionDigest: "f".repeat(64) } });
    expect((await decide(s.deps, DANA, "admin", record!.approvalId)).status).toBe("APPROVED_FAILED");
    expect(await s.chains.listShares(TEST_ORG, chainId)).toEqual([]);
  });

  it("M2: a shared chain's less-safe publish is asked of owners and admins only; the author is refused and an admin confirms", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    await share(s.chains, chainId);
    expect((await s.putDraft(MAYA, chainId, LOOSER)).status).toBe(200);
    expect((await s.publish(MAYA, chainId)).status).toBe(202);
    const [record] = s.approvals();
    expect(record).toMatchObject({ approvers: { rule: "chain_company_share" } });
    expect(candidatesOf(record!)).toEqual([DANA.developerId]);
    expect(await thrownMessage(decide(s.deps, MAYA, "member", record!.approvalId))).toMatch(/^FORBIDDEN: /);
    expect((await s.state(chainId)).currentVersion).toBe(1);
    expect((await decide(s.deps, DANA, "admin", record!.approvalId)).status).toBe("APPROVED_DONE");
    expect((await s.state(chainId)).currentVersion).toBe(2);
  });

  it("M2: the same for a rollback to a looser version", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.seed(chainId, WITHOUT_GATE);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    await share(s.chains, chainId);
    expect((await s.call(MAYA, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 1 })).status).toBe(202);
    const [record] = s.approvals();
    expect(record).toMatchObject({ subject: { kind: "chain_rollback" }, approvers: { rule: "chain_company_share" } });
    expect(await thrownMessage(decide(s.deps, MAYA, "member", record!.approvalId))).toMatch(/^FORBIDDEN: /);
    expect((await decide(s.deps, DANA, "admin", record!.approvalId)).status).toBe("APPROVED_DONE");
    expect((await s.state(chainId)).currentVersion).toBe(1);
  });

  it("M2: an unshared chain keeps today's rules, and a request asked before the share existed is held to the owner-or-admin check, judged now", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    expect((await s.putDraft(MAYA, chainId, LOOSER)).status).toBe(200);
    expect((await s.publish(MAYA, chainId)).status).toBe(202);
    const [record] = s.approvals();
    expect(record).toMatchObject({ approvers: { rule: "chain_publish" } });
    expect(candidatesOf(record!)).toContain(MAYA.developerId);
    await share(s.chains, chainId);
    // The page says who may decide it now, and the author can't.
    expect(await approvalDecideKind(s.deps).inspect({ orgId: TEST_ORG, developerId: MAYA.developerId, approvalId: record!.approvalId })).toMatchObject({ status: "forbidden", who: "an organization owner or admin" });
    expect(await thrownMessage(decide(s.deps, MAYA, "member", record!.approvalId))).toMatch(/^FORBIDDEN: /);
    expect((await decide(s.deps, DANA, "admin", record!.approvalId)).status).toBe("APPROVED_DONE");
    // Control: with no share the author decides her own, as before.
    const other = await s.create(MAYA);
    await s.seed(other, INVESTIGATE_THEN_FIX);
    expect((await s.putDraft(MAYA, other, LOOSER)).status).toBe(200);
    expect((await s.publish(MAYA, other)).status).toBe(202);
    const mine = s.approvals().find((entry) => (entry.subject as { chainId?: string }).chainId === other)!;
    expect((await decide(s.deps, MAYA, "member", mine.approvalId)).status).toBe("APPROVED_DONE");
  });

  it("L1: a publish or rollback an author decided is refused at apply time once the chain is shared, and applies when an admin decided it", async () => {
    const s = await setup();
    const chainId = await s.create(MAYA);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    expect((await s.putDraft(MAYA, chainId, LOOSER)).status).toBe(200);
    expect((await s.publish(MAYA, chainId)).status).toBe(202);
    const record = s.approvals()[0]!;
    await share(s.chains, chainId);
    const handler = getApprovalSubjectHandler("chain_publish")!;
    expect(await thrownMessage(handler(s.deps, { ...record, decidedBy: MAYA.developerId }))).toMatch(/shared with your company after this was decided/);
    expect((await s.state(chainId)).currentVersion).toBe(1);
    await handler(s.deps, { ...record, decidedBy: DANA.developerId });
    expect((await s.state(chainId)).currentVersion).toBe(2);
    await s.seed(chainId, INVESTIGATE_THEN_FIX);
    expect((await s.call(MAYA, "POST", `/v1/app/chains/${chainId}/rollback`, { version: 2 })).status).toBe(202);
    const rollback = s.approvals().find((entry) => entry.subject.kind === "chain_rollback")!;
    const rollbackHandler = getApprovalSubjectHandler("chain_rollback")!;
    expect(await thrownMessage(rollbackHandler(s.deps, { ...rollback, decidedBy: MAYA.developerId }))).toMatch(/shared with your company after this was decided/);
    expect((await s.state(chainId)).currentVersion).toBe(3);
    await rollbackHandler(s.deps, { ...rollback, decidedBy: DANA.developerId });
    expect((await s.state(chainId)).currentVersion).toBe(2);
  });
});
