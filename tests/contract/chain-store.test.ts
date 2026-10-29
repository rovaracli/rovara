import { fixtureActor } from "../support/money-authority.js";
// Plan 4 Task 3: the chain store (records, drafts, immutable versions, names, events, owner totals), who can do what with a chain, and its shares.
import { seedMembership } from "../support/developer-task-broker.js";
import { describe, expect, it } from "vitest";
import { agentAccess, type AgentAccessDeps, type AgentCaller } from "../../packages/broker/src/agents/access.js";
import { ownerEffectiveTotal } from "../../packages/broker/src/spend/requests.js";
import { AgentStore, isOwnerCapRefusal, type BuiltinSource } from "../../packages/broker/src/agents/store.js";
import {
  chainAccess,
  listVisibleChains,
  requireChainAccess,
  requireChainAccountable,
  requireChainOwnerAllowed,
  setChainShares,
  type ChainAccessDeps,
} from "../../packages/broker/src/chains/access.js";
import { ChainStore, chainDigest, type ChainRecord } from "../../packages/broker/src/chains/store.js";
import { validateChainForPublish } from "../../packages/broker/src/chains/validate.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import type { AgentOwner } from "../../packages/contracts/src/agent-node.js";
import type { RecipeOverlay } from "../../packages/contracts/src/agent-recipe-node.js";
import { BUILTIN_AGENTS, builtinDefaultPin, builtinRecipe, currentBuiltinVersion } from "../../packages/contracts/src/agent-templates.js";
import { DEFAULT_AGENT_GUARDRAILS } from "../../packages/contracts/src/agent-guardrails.js";
import { CHAIN_MAX_STEPS, type ChainDefinitionInput, type PinnedChainDefinition } from "../../packages/contracts/src/chains.js";
import type { OrgId, OrgRole } from "../../packages/contracts/src/org.js";
import { orgMemberKey } from "../../packages/contracts/src/org-node.js";
import { builtinSettingsKey, chainDirectoryKey, chainKey, chainNameKey, ownerBudgetKey, orgProjectCatalogKey, principalChainSharesKey, principalSharesKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";

const START = Date.parse("2026-10-22T09:00:00.000Z");
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);
const DAN = "d".repeat(64);
const OWEN = "e".repeat(64);
const ERIN = "f".repeat(64);
const FRANK = "9".repeat(64);
const STRANGER = "1".repeat(64);
const OLD_ALICE = "2".repeat(64);
const ROLES: Record<string, OrgRole> = { [ALICE]: "member", [BOB]: "member", [CAROL]: "member", [DAN]: "admin", [OWEN]: "owner", [ERIN]: "member", [FRANK]: "member" };
const caller = (developerId: string, orgId: OrgId = ORG_A): AgentCaller => ({ orgId, developerId, orgRole: ROLES[developerId] ?? "member" });
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

const ALICE_OWNS: AgentOwner = { kind: "member", developerId: ALICE };
const WEB_OWNS: AgentOwner = { kind: "project", project: "web" };
const SCRATCH: RecipeOverlay = { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] };
const DIGEST = "d".repeat(64);
const CONFLICT = "Someone else changed this chain's draft. Reload it and make your change again.";

/** Two built-in steps: root-cause-analyst, then code-reviewer. */
const TWO_STEPS: ChainDefinitionInput = {
  start: "a",
  steps: [
    { kind: "agent", id: "a", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "go", to: "b" } },
    { kind: "agent", id: "b", name: "Review", agent: { agentId: "code-reviewer", version: "current" }, next: { kind: "end" } },
  ],
};

/** The shipped built-ins, except that Code reviewer has released up to `release.codeReviewer`. */
function builtinsWithRelease(release: { codeReviewer: number }): BuiltinSource {
  return {
    currentVersion: (id) => (id === "code-reviewer" ? release.codeReviewer : currentBuiltinVersion(id as "rovara-code")),
    defaultPin: (id) => (id === "code-reviewer" ? release.codeReviewer : builtinDefaultPin(id as "rovara-code")),
    recipe: (id, version) => (id === "code-reviewer" && version > currentBuiltinVersion("code-reviewer") && version <= release.codeReviewer ? builtinRecipe("code-reviewer", 1) : builtinRecipe(id as "rovara-code", version)),
    name: (id) => BUILTIN_AGENTS[id as "rovara-code"].name,
  };
}

function setup(options: { audit?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const clock = { now: START };
  const release = { codeReviewer: currentBuiltinVersion("code-reviewer") };
  // A hook that runs once, just before the next transaction is sent: a write that lands between a store's reads and its write.
  const hooks: Array<() => void | Promise<void>> = [];
  const client = {
    send: async (command: object) => {
      if (command.constructor.name === "TransactWriteCommand" && hooks.length > 0) await hooks.shift()!();
      return db.send(command as never);
    },
  };
  const audit = options.audit === true ? capturingAuditDeps({ db, now: () => clock.now }) : undefined;
  let agentCounter = 0;
  let chainCounter = 0;
  const agents = new AgentStore({
    documentClient: client,
    tableName: "T",
    now: () => clock.now,
    newId: () => `agt_${String(++agentCounter).padStart(20, "0")}`,
    builtins: builtinsWithRelease(release),
    ...(audit === undefined ? {} : { audit: audit.audit }),
  });
  const chains = new ChainStore({
    documentClient: client,
    tableName: "T",
    now: () => clock.now,
    newId: () => `chn_${String(++chainCounter).padStart(20, "0")}`,
    agents,
    ...(audit === undefined ? {} : { audit: audit.audit }),
  });
  const projectMembers = new FakeProjectMembers();
  const base = { projectMembers, documentClient: client, tableName: "T", signInStore: new DeveloperSignInStore({ documentClient: client, tableName: "T", now: () => clock.now }) };
  const agentDeps: AgentAccessDeps = { ...base, store: agents };
  const deps: ChainAccessDeps = { ...base, store: chains };
  for (const [developerId, role] of Object.entries(ROLES)) {
    db.set({ ...orgMemberKey(ORG_A, developerId), entityType: "ORG_MEMBER", orgId: ORG_A, developerId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId });
  }
  db.set({ ...orgMemberKey(ORG_B, STRANGER), entityType: "ORG_MEMBER", orgId: ORG_B, developerId: STRANGER, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
  for (const project of ["web", "api"]) {
    db.set({ ...orgProjectCatalogKey(ORG_A, project), entityType: "PROJECT_CATALOG", name: project });
    projectMembers.addProject(ORG_A, project);
  }
  projectMembers.grant(ORG_A, "web", BOB, "maintainer");
  projectMembers.grant(ORG_A, "web", CAROL, "contributor");
  projectMembers.grant(ORG_A, "web", ERIN, "viewer");
  projectMembers.grant(ORG_A, "api", FRANK, "contributor");

  const create = (name: string, extra: { owner?: AgentOwner; accountable?: { developerId: string }; orgId?: OrgId; definition?: ChainDefinitionInput; description?: string; by?: string } = {}) =>
    chains.create({
      orgId: extra.orgId ?? ORG_A,
      name,
      owner: extra.owner ?? ALICE_OWNS,
      ...(extra.accountable === undefined ? {} : { accountable: extra.accountable }),
      definition: extra.definition ?? TWO_STEPS,
      ...(extra.description === undefined ? {} : { description: extra.description }),
      createdBy: extra.by ?? ALICE,
    });
  /** The draft as validation would pin it. */
  const pinnedOf = async (chainId: string, orgId: OrgId = ORG_A): Promise<{ pinned: PinnedChainDefinition; guardrailsRevision: number }> => {
    const draft = (await chains.getDraft(orgId, chainId))!;
    const result = await validateChainForPublish(agentDeps, caller(ALICE, orgId), orgId, draft.definition);
    expect(result.problems).toEqual([]);
    return { pinned: result.pinned, guardrailsRevision: result.guardrailsRevision };
  };
  const publishInput = async (chainId: string, orgId: OrgId = ORG_A) => {
    const chain = (await chains.get(orgId, chainId))!;
    const { pinned, guardrailsRevision } = await pinnedOf(chainId, orgId);
    return { orgId, chainId, expectedDraftRevision: chain.draftRevision, pinned, digest: chainDigest(pinned), guardrailsRevision, by: ALICE };
  };
  const publish = async (chainId: string, orgId: OrgId = ORG_A) => chains.publish(await publishInput(chainId, orgId));
  const edit = async (chainId: string, definition: ChainDefinitionInput = TWO_STEPS, name = "x") => {
    const draft = (await chains.getDraft(ORG_A, chainId))!;
    const changed = { ...definition, steps: definition.steps.map((step, index) => (index === 0 && step.kind === "agent" ? { ...step, name } : step)) };
    return chains.saveDraft({ orgId: ORG_A, chainId, definition: changed, expectedRevision: draft.revision, by: ALICE });
  };
  const events = (orgId: OrgId, chainId: string) => db.find((item) => item.pk === chainKey(orgId, chainId, "META").pk && String(item.sk).startsWith("EVENT#")).sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
  const customAgent = async (name: string, owner = ALICE) => {
    const agent = await agents.create({ orgId: ORG_A, name, owner: { kind: "member", developerId: owner }, overlay: SCRATCH, createdBy: owner });
    const published = async () => {
      const record = (await agents.get(ORG_A, agent.agentId))!;
      return agents.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: record.draftRevision, digest: DIGEST, by: owner });
    };
    await published();
    return { agent, publishAgain: async () => { const draft = (await agents.getDraft(ORG_A, agent.agentId))!; await agents.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: { ...SCRATCH, instructions: `v${String(Date.now())}${String(Math.random())}` }, expectedRevision: draft.revision, by: owner }); await published(); } };
  };
  const total = (developerId: string, orgId: OrgId = ORG_A) => db.get(ownerBudgetKey(orgId, developerId))?.["totalUsd"];
  return { db, client, clock, release, hooks, agents, chains, deps, agentDeps, projectMembers, create, pinnedOf, publishInput, publish, edit, events, customAgent, total, audit };
}

const definitionWith = (agentId: string, version: number | "current"): ChainDefinitionInput => ({
  start: "a",
  steps: [{ kind: "agent", id: "a", name: "Do", agent: { agentId: agentId, version }, next: { kind: "end" } }],
});

describe("create and read", () => {
  it("creates a chain at version 0 with its first draft, directory and name items", async () => {
    const { create, chains, db } = setup();
    const chain = await create("Investigate", { description: "Finds causes" });
    expect(chain).toMatchObject({
      orgId: ORG_A, chainId: "chn_00000000000000000001", name: "Investigate", description: "Finds causes", owner: ALICE_OWNS,
      latestVersion: 0, draftRevision: 1, status: "active", openRuns: 0, createdBy: ALICE,
    });
    expect(chain.currentVersion).toBeUndefined();
    expect(await chains.get(ORG_A, chain.chainId)).toEqual(chain);
    const draft = await chains.getDraft(ORG_A, chain.chainId);
    expect(draft).toMatchObject({ revision: 1, updatedBy: ALICE, definition: { start: "a" } });
    expect(draft!.definition.steps[0]).toMatchObject({ id: "a", agent: { version: "current" } });
    expect(await chains.list(ORG_A)).toEqual([chain]);
    expect(db.get(chainDirectoryKey(ORG_A, chain.chainId))).toBeDefined();
    expect(db.get(chainNameKey(ORG_A, "investigate"))).toMatchObject({ chainId: chain.chainId });
    expect(await chains.getVersion(ORG_A, chain.chainId, 1)).toBeUndefined();
    expect(await chains.listVersions(ORG_A, chain.chainId)).toEqual([]);
  });

  it("keeps every chain item under its own org", async () => {
    const { create, chains, db } = setup();
    const chain = await create("Investigate");
    expect(await chains.get(ORG_B, chain.chainId)).toBeUndefined();
    expect(await chains.getDraft(ORG_B, chain.chainId)).toBeUndefined();
    expect(await chains.list(ORG_B)).toEqual([]);
    const owned = db.find((item) => String(item.pk).includes("CHAIN"));
    expect(owned.length).toBeGreaterThan(3);
    expect(owned.every((item) => String(item.pk).startsWith(`ORG#${ORG_A}#`))).toBe(true);
  });

  it("refuses a name taken in other casing, and lets another org use the same name", async () => {
    const { create, chains } = setup();
    await create("Investigate");
    for (const name of ["investigate", "INVESTIGATE", "  Investigate  "]) {
      expect(await code(create(name))).toEqual({ code: "CONFIG_INVALID", message: `name: another chain in your company is called ${name.trim()}` });
    }
    expect(await chains.list(ORG_A)).toHaveLength(1);
    await expect(create("Investigate", { orgId: ORG_B, owner: { kind: "member", developerId: STRANGER }, by: STRANGER })).resolves.toMatchObject({ orgId: ORG_B, name: "Investigate" });
  });

  it("treats a composed and a decomposed spelling of one name as one name", async () => {
    const { create } = setup();
    await create("Café");
    expect(await code(create("Café"))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses names that are empty, too long or hold control, invisible or look-alike space characters", async () => {
    const { create } = setup();
    for (const bad of ["", "   ", "a".repeat(61), "bad\u0007name", "bad\nname", "bad​name", "bad name", "bad name", "bad﻿name", "lone\ud800name"]) {
      expect(await code(create(bad)), JSON.stringify(bad)).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^name: /) as string });
    }
    await expect(create("a".repeat(60))).resolves.toBeDefined();
    // 60 emoji are 60 characters, though 120 UTF-16 units.
    await expect(create("\u{1F600}".repeat(60))).resolves.toBeDefined();
    expect(await code(create("\u{1F600}".repeat(61)))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses a description over 500 characters or with control characters, and allows line breaks", async () => {
    const { create } = setup();
    expect(await code(create("One", { description: "d".repeat(501) }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^description: /) as string });
    expect(await code(create("Two", { description: "bad\u0007" }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^description: /) as string });
    await expect(create("Three", { description: "d".repeat(500) })).resolves.toBeDefined();
    await expect(create("Four", { description: "line one\nline two" })).resolves.toBeDefined();
    // 300 emoji are 300 characters, though 600 UTF-16 units.
    await expect(create("Five", { description: "\u{1F600}".repeat(300) })).resolves.toBeDefined();
    expect(await code(create("Six", { description: "\u{1F600}".repeat(501) }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("needs an accountable maintainer for a project's chain and none for a member's", async () => {
    const { create } = setup();
    expect(await code(create("Web chain", { owner: WEB_OWNS }))).toEqual({ code: "CONFIG_INVALID", message: "accountable: a project's chain needs an accountable maintainer" });
    expect(await code(create("Mine", { accountable: { developerId: BOB } }))).toEqual({ code: "CONFIG_INVALID", message: "accountable: only a project's chain has an accountable maintainer" });
    await expect(create("Web chain", { owner: WEB_OWNS, accountable: { developerId: BOB } })).resolves.toMatchObject({ owner: WEB_OWNS, accountable: { developerId: BOB } });
  });

  it("refuses a definition that does not parse, at its path under definition", async () => {
    const { create, chains } = setup();
    const bad = { ...TWO_STEPS, steps: [{ ...TWO_STEPS.steps[0]!, tools: ["bash"] }] } as unknown as ChainDefinitionInput;
    expect(await code(create("Bad", { definition: bad }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^definition\.steps\.0: /) as string });
    expect(await chains.list(ORG_A)).toEqual([]);
    const tooMany = { start: "s0", steps: Array.from({ length: CHAIN_MAX_STEPS + 1 }, (_unused, index) => ({ kind: "agent", id: `s${String(index)}`, name: "x", agent: { agentId: "ticket-triage", version: "current" }, next: { kind: "end" } })) } as ChainDefinitionInput;
    expect(await code(create("Big", { definition: tooMany }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("writes the created event, one per write, and refuses a name taken without leaving an event behind", async () => {
    const { create, events, db } = setup();
    const chain = await create("Writes");
    expect(events(ORG_A, chain.chainId).map((item) => item["kind"])).toEqual(["created"]);
    expect(events(ORG_A, chain.chainId)[0]).toMatchObject({ entityType: "CHAIN_EVENT", orgId: ORG_A, chainId: chain.chainId, by: ALICE, name: "Writes" });
    const before = db.find(() => true).length;
    await code(create("writes"));
    expect(db.find(() => true).length).toBe(before);
  });
});

describe("drafts", () => {
  it("saves a draft at the revision read and bumps it on the chain", async () => {
    const { create, chains, edit } = setup();
    const chain = await create("Investigate");
    const saved = await edit(chain.chainId, TWO_STEPS, "Renamed step");
    expect(saved.revision).toBe(2);
    expect(saved.definition.steps[0]).toMatchObject({ name: "Renamed step" });
    expect((await chains.get(ORG_A, chain.chainId))!.draftRevision).toBe(2);
    expect((await chains.getDraft(ORG_A, chain.chainId))!.revision).toBe(2);
  });

  it("answers CHAIN_REVISION_CONFLICT with the exact text for a stale revision, and for two saves from one revision", async () => {
    const { create, chains } = setup();
    const chain = await create("Investigate");
    const save = (name: string) => chains.saveDraft({ orgId: ORG_A, chainId: chain.chainId, definition: { ...TWO_STEPS, steps: [{ ...TWO_STEPS.steps[0]!, name } as never, TWO_STEPS.steps[1]!] }, expectedRevision: 1, by: ALICE });
    const results = await Promise.all([code(save("one")), code(save("two"))]);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    expect(results.filter((result) => result !== undefined)).toEqual([{ code: "CHAIN_REVISION_CONFLICT", message: CONFLICT }]);
    expect(await code(save("three"))).toEqual({ code: "CHAIN_REVISION_CONFLICT", message: CONFLICT });
    expect((await chains.getDraft(ORG_A, chain.chainId))!.revision).toBe(2);
  });

  it("refuses a definition that does not parse and a chain that is not there or is another org's", async () => {
    const { create, chains } = setup();
    const chain = await create("Investigate");
    expect(await code(chains.saveDraft({ orgId: ORG_A, chainId: chain.chainId, definition: { start: "a", steps: [] }, expectedRevision: 1, by: ALICE }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^definition\.steps/) as string });
    expect(await code(chains.saveDraft({ orgId: ORG_B, chainId: chain.chainId, definition: TWO_STEPS, expectedRevision: 1, by: ALICE }))).toEqual({ code: "NOT_FOUND", message: "no chain has that ID" });
    expect((await chains.getDraft(ORG_A, chain.chainId))!.revision).toBe(1);
  });
});

describe("profile", () => {
  it("renames: the new name is taken and the old one freed in one write, and a taken name is refused", async () => {
    const { create, chains, db } = setup();
    const one = await create("One");
    await create("Two");
    expect(await code(chains.updateProfile({ orgId: ORG_A, chainId: one.chainId, name: "TWO", by: ALICE }))).toMatchObject({ code: "CONFIG_INVALID", message: "name: another chain in your company is called TWO" });
    expect((await chains.get(ORG_A, one.chainId))!.name).toBe("One");
    const renamed = await chains.updateProfile({ orgId: ORG_A, chainId: one.chainId, name: "  Uno ", description: "d", by: ALICE });
    expect(renamed).toMatchObject({ name: "Uno", description: "d" });
    expect(db.get(chainNameKey(ORG_A, "one"))).toBeUndefined();
    expect(db.get(chainNameKey(ORG_A, "uno"))).toMatchObject({ chainId: one.chainId });
    // The freed name can be used again; a case-only rename changes the name but keeps its item.
    await expect(create("One")).resolves.toBeDefined();
    const cased = await chains.updateProfile({ orgId: ORG_A, chainId: one.chainId, name: "UNO", by: ALICE });
    expect(cased.name).toBe("UNO");
    expect(db.get(chainNameKey(ORG_A, "uno"))).toMatchObject({ chainId: one.chainId });
  });

  it("validates the new name and description like create", async () => {
    const { create, chains } = setup();
    const one = await create("One");
    expect(await code(chains.updateProfile({ orgId: ORG_A, chainId: one.chainId, name: "a".repeat(61), by: ALICE }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(chains.updateProfile({ orgId: ORG_A, chainId: one.chainId, description: "x".repeat(501), by: ALICE }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(chains.updateProfile({ orgId: ORG_A, chainId: one.chainId, name: "bad​", by: ALICE }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("conflicts when the profile changed since it was read", async () => {
    const { create, chains, hooks } = setup();
    const one = await create("One");
    hooks.push(async () => { await chains.updateProfile({ orgId: ORG_A, chainId: one.chainId, description: "someone else", by: BOB }); });
    expect(await code(chains.updateProfile({ orgId: ORG_A, chainId: one.chainId, description: "mine", by: ALICE }))).toMatchObject({ code: "CHAIN_REVISION_CONFLICT" });
    expect((await chains.get(ORG_A, one.chainId))!.description).toBe("someone else");
  });
});

describe("publish, versions and rollback", () => {
  it("publishes the draft as version 1, pinned and immutable, with its digest", async () => {
    const { create, chains, publishInput, db } = setup();
    const chain = await create("Investigate");
    const input = await publishInput(chain.chainId);
    const version = await chains.publish({ ...input, note: "first" });
    expect(version).toMatchObject({ version: 1, digest: chainDigest(input.pinned), publishedBy: ALICE, note: "first" });
    expect(version.definition).toEqual(input.pinned);
    expect(version.definition.steps[0]).toMatchObject({ agent: { agentId: "root-cause-analyst", version: currentBuiltinVersion("root-cause-analyst") } });
    expect(await chains.get(ORG_A, chain.chainId)).toMatchObject({ currentVersion: 1, latestVersion: 1 });
    expect(await chains.getVersion(ORG_A, chain.chainId, 1)).toEqual(version);
    expect(await chains.getVersion(ORG_A, chain.chainId, 0)).toBeUndefined();
    expect(await chains.getVersion(ORG_A, chain.chainId, 1.5)).toBeUndefined();
    expect(await chains.getVersion(ORG_B, chain.chainId, 1)).toBeUndefined();
    expect(await chains.listVersions(ORG_A, chain.chainId)).toEqual([version]);
    expect(db.get(chainKey(ORG_A, chain.chainId, "VERSION#000001"))).toMatchObject({ version: 1 });
  });

  it("gives two concurrent publishes from revision 1 one version 1 and one CHAIN_REVISION_CONFLICT", async () => {
    const { create, chains, publishInput } = setup();
    const chain = await create("Investigate");
    const input = await publishInput(chain.chainId);
    const results = await Promise.all([code(chains.publish(input)), code(chains.publish(input))]);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    expect(results.filter((result) => result !== undefined)).toEqual([{ code: "CHAIN_REVISION_CONFLICT", message: CONFLICT }]);
    expect((await chains.listVersions(ORG_A, chain.chainId)).map((version) => version.version)).toEqual([1]);
    expect(await chains.get(ORG_A, chain.chainId)).toMatchObject({ currentVersion: 1, latestVersion: 1 });
  });

  it("refuses a publish from an older draft revision", async () => {
    const { create, chains, publishInput, edit } = setup();
    const chain = await create("Investigate");
    const input = await publishInput(chain.chainId);
    await edit(chain.chainId);
    expect(await code(chains.publish(input))).toEqual({ code: "CHAIN_REVISION_CONFLICT", message: CONFLICT });
    expect(await chains.listVersions(ORG_A, chain.chainId)).toEqual([]);
  });

  it("publishes v1, an edit and v2, rolls back to 1, and the next publish still numbers after 2", async () => {
    const { create, chains, publish, edit } = setup();
    const chain = await create("Investigate");
    const v1 = await publish(chain.chainId);
    await edit(chain.chainId, TWO_STEPS, "second look");
    const v2 = await publish(chain.chainId);
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v2.definition.steps[0]).toMatchObject({ name: "second look" });
    expect(await chains.get(ORG_A, chain.chainId)).toMatchObject({ currentVersion: 2, latestVersion: 2 });
    const rolled = await chains.rollback({ orgId: ORG_A, chainId: chain.chainId, version: 1, expectedCurrentVersion: 2, guardrailsRevision: 0, by: ALICE });
    expect(rolled).toMatchObject({ currentVersion: 1, latestVersion: 2 });
    expect(await chains.get(ORG_A, chain.chainId)).toMatchObject({ currentVersion: 1, latestVersion: 2 });
    // The versions did not change.
    expect(await chains.getVersion(ORG_A, chain.chainId, 1)).toEqual(v1);
    expect(await chains.getVersion(ORG_A, chain.chainId, 2)).toEqual(v2);
    await edit(chain.chainId, TWO_STEPS, "third look");
    expect((await publish(chain.chainId)).version).toBe(3);
  });

  it("refuses a rollback from a current version that moved, to a version that does not exist, and for another org", async () => {
    const { create, chains, publish, edit } = setup();
    const chain = await create("Investigate");
    await publish(chain.chainId);
    await edit(chain.chainId);
    await publish(chain.chainId);
    expect(await code(chains.rollback({ orgId: ORG_A, chainId: chain.chainId, version: 1, expectedCurrentVersion: 1, guardrailsRevision: 0, by: ALICE }))).toEqual({ code: "CHAIN_REVISION_CONFLICT", message: CONFLICT });
    expect(await code(chains.rollback({ orgId: ORG_A, chainId: chain.chainId, version: 9, expectedCurrentVersion: 2, guardrailsRevision: 0, by: ALICE }))).toEqual({ code: "NOT_FOUND", message: "Investigate has no version 9" });
    expect(await code(chains.rollback({ orgId: ORG_B, chainId: chain.chainId, version: 1, expectedCurrentVersion: 2, guardrailsRevision: 0, by: ALICE }))).toMatchObject({ code: "NOT_FOUND" });
    expect((await chains.get(ORG_A, chain.chainId))!.currentVersion).toBe(2);
  });

  it("cannot overwrite a version item, even when the chain's counters say the number is free", async () => {
    const { create, chains, publishInput, db } = setup();
    const chain = await create("Investigate");
    const input = await publishInput(chain.chainId);
    await chains.publish(input);
    const meta = db.get(chainKey(ORG_A, chain.chainId, "META"))!;
    // Put the chain back to what it was before version 1, as if a stale write had undone it.
    db.set({ ...meta, latestVersion: 0 });
    delete (db.get(chainKey(ORG_A, chain.chainId, "META")) as Record<string, unknown>)["currentVersion"];
    expect(await code(chains.publish(input))).toMatchObject({ code: "CHAIN_REVISION_CONFLICT" });
    expect(await chains.getVersion(ORG_A, chain.chainId, 1)).toMatchObject({ digest: chainDigest(input.pinned) });
  });

  it("refuses a pinned definition that is not the draft's, a wrong digest and a malformed digest", async () => {
    const { create, chains, publishInput } = setup();
    const chain = await create("Investigate");
    const input = await publishInput(chain.chainId);
    const other = structuredClone(input.pinned);
    (other.steps[0] as { name: string }).name = "something else";
    expect(await code(chains.publish({ ...input, pinned: other, digest: chainDigest(other) }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^pinned: .*draft/) as string });
    const moved = structuredClone(input.pinned);
    (moved.steps[1] as { agent: { version: number } }).agent.version = 5;
    // A different pin than the draft's "current" resolves to is the validator's business; the store only needs it to be the same design.
    expect(await code(chains.publish({ ...input, digest: "0".repeat(64) }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^digest: / ) as string });
    expect(await code(chains.publish({ ...input, digest: "nope" }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^digest: /) as string });
    expect(await code(chains.publish({ ...input, pinned: { ...input.pinned, start: "zzz" }, digest: "0".repeat(64) }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await chains.listVersions(ORG_A, chain.chainId)).toEqual([]);
  });

  it("refuses a malformed digest and a wrong digest with their own words", async () => {
    const { create, chains, publishInput } = setup();
    const chain = await create("Investigate");
    const input = await publishInput(chain.chainId);
    expect(await code(chains.publish({ ...input, digest: "nope" }))).toEqual({ code: "CONFIG_INVALID", message: "digest: must be a SHA-256 digest of 64 hex characters" });
    expect(await code(chains.publish({ ...input, digest: "0".repeat(64) }))).toEqual({ code: "CONFIG_INVALID", message: "digest: must be the SHA-256 of the pinned definition" });
  });

  it("applies only while the current version is the one the caller compared against", async () => {
    const { create, chains, publishInput, publish, edit } = setup();
    const chain = await create("Investigate");
    await expect(chains.publish({ ...(await publishInput(chain.chainId)), expectedCurrentVersion: null })).resolves.toMatchObject({ version: 1 });
    await edit(chain.chainId);
    expect(await code(chains.publish({ ...(await publishInput(chain.chainId)), expectedCurrentVersion: null }))).toMatchObject({ code: "CHAIN_REVISION_CONFLICT" });
    expect(await code(chains.publish({ ...(await publishInput(chain.chainId)), expectedCurrentVersion: 4 }))).toMatchObject({ code: "CHAIN_REVISION_CONFLICT" });
    await expect(chains.publish({ ...(await publishInput(chain.chainId)), expectedCurrentVersion: 1 })).resolves.toMatchObject({ version: 2 });
    await edit(chain.chainId, TWO_STEPS, "again");
    await expect(publish(chain.chainId)).resolves.toMatchObject({ version: 3 });
  });

  it("refuses a publish when the draft was edited between the read and the write", async () => {
    const { create, chains, publishInput, edit, hooks } = setup();
    const chain = await create("Investigate");
    const input = await publishInput(chain.chainId);
    hooks.push(async () => { await edit(chain.chainId, TWO_STEPS, "edited meanwhile"); });
    expect(await code(chains.publish(input))).toEqual({ code: "CHAIN_REVISION_CONFLICT", message: CONFLICT });
    expect(await chains.listVersions(ORG_A, chain.chainId)).toEqual([]);
  });

  it("refuses a pinned version the draft did not name", async () => {
    const ctx = setup();
    const { agent, publishAgain } = await ctx.customAgent("Helper");
    await publishAgain();
    const chain = await ctx.create("Named", { definition: definitionWith(agent.agentId, 1) });
    const input = await ctx.publishInput(chain.chainId);
    const other = structuredClone(input.pinned);
    (other.steps[0] as { agent: { version: number } }).agent.version = 2;
    expect(await code(ctx.chains.publish({ ...input, pinned: other, digest: chainDigest(other) }))).toEqual({ code: "CONFIG_INVALID", message: "pinned.steps.0.agent.version: the draft names version 1" });
  });

  it("refuses a design whose graph has problems, whoever pinned it, before anything is written", async () => {
    const ctx = setup();
    const loop: ChainDefinitionInput = {
      start: "a",
      steps: [
        { kind: "agent", id: "a", name: "A", agent: { agentId: "ticket-triage", version: "current" }, next: { kind: "go", to: "b" } },
        { kind: "agent", id: "b", name: "B", agent: { agentId: "ticket-triage", version: "current" }, next: { kind: "go", to: "a" } },
      ],
    };
    const chain = await ctx.create("Loopy", { definition: loop });
    const draft = (await ctx.chains.getDraft(ORG_A, chain.chainId))!;
    // Hand-built, as a caller that skipped (or ignored) the validation would: every agent pinned to a number.
    const checked = await validateChainForPublish(ctx.agentDeps, caller(ALICE), ORG_A, draft.definition);
    expect(checked.problems.length).toBeGreaterThan(0);
    const input = { orgId: ORG_A, chainId: chain.chainId, expectedDraftRevision: 1, pinned: checked.pinned, digest: chainDigest(checked.pinned), guardrailsRevision: checked.guardrailsRevision, by: ALICE };
    expect(await code(ctx.chains.publish(input))).toEqual({ code: "CONFIG_INVALID", message: `${checked.problems[0]!.path}: ${checked.problems[0]!.message}` });
    expect(await ctx.chains.listVersions(ORG_A, chain.chainId)).toEqual([]);
    expect(ctx.events(ORG_A, chain.chainId)).toHaveLength(1);
    // Other graph problems are refused the same way: an edge to nowhere, a step nothing reaches.
    const dangling = await ctx.create("Dangling", { definition: { start: "a", steps: [{ kind: "agent", id: "a", name: "A", agent: { agentId: "ticket-triage", version: "current" }, next: { kind: "go", to: "nowhere" } }] } });
    const danglingChecked = await validateChainForPublish(ctx.agentDeps, caller(ALICE), ORG_A, (await ctx.chains.getDraft(ORG_A, dangling.chainId))!.definition);
    expect(await code(ctx.chains.publish({ orgId: ORG_A, chainId: dangling.chainId, expectedDraftRevision: 1, pinned: danglingChecked.pinned, digest: chainDigest(danglingChecked.pinned), guardrailsRevision: danglingChecked.guardrailsRevision, by: ALICE }))).toEqual({
      code: "CONFIG_INVALID", message: "steps.0.next.to: no step is called nowhere",
    });
  });

  it("refuses a pinned definition that still holds \"current\"", async () => {
    const { create, chains, publishInput } = setup();
    const chain = await create("Investigate");
    const input = await publishInput(chain.chainId);
    const draft = (await chains.getDraft(ORG_A, chain.chainId))!;
    expect(await code(chains.publish({ ...input, pinned: draft.definition as never, digest: chainDigest(draft.definition as never) }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^pinned\.steps\.0\.agent\.version: /) as string });
  });

  it("refuses to publish another org's chain or one that is not there", async () => {
    const { create, chains, publishInput } = setup();
    const chain = await create("Investigate");
    const input = await publishInput(chain.chainId);
    expect(await code(chains.publish({ ...input, orgId: ORG_B }))).toEqual({ code: "NOT_FOUND", message: "no chain has that ID" });
    expect(await code(chains.publish({ ...input, chainId: "chn_zzzzzzzzzzzzzzzzzzzz" }))).toEqual({ code: "NOT_FOUND", message: "no chain has that ID" });
  });
});

describe("publish checks the agents again, inside the transaction", () => {
  it("pins \"current\" of a custom agent to the version validation saw, and refuses when the agent moved on in between", async () => {
    const ctx = setup();
    const { agent, publishAgain } = await ctx.customAgent("Helper");
    const chain = await ctx.create("On helper", { definition: definitionWith(agent.agentId, "current") });
    const input = await ctx.publishInput(chain.chainId);
    expect(input.pinned.steps[0]).toMatchObject({ agent: { version: 1 } });
    ctx.hooks.push(publishAgain);
    expect(await code(ctx.chains.publish(input))).toEqual({ code: "CHAIN_REVISION_CONFLICT", message: "An agent this chain uses changed while it was being published. Publish again." });
    expect(await ctx.chains.listVersions(ORG_A, chain.chainId)).toEqual([]);
    // Publishing again pins the new current version.
    const again = await ctx.publishInput(chain.chainId);
    expect(again.pinned.steps[0]).toMatchObject({ agent: { version: 2 } });
    await expect(ctx.chains.publish(again)).resolves.toMatchObject({ version: 1 });
  });

  it("keeps a version a person named, even when the agent publishes a newer one in between", async () => {
    const ctx = setup();
    const { agent, publishAgain } = await ctx.customAgent("Helper");
    const chain = await ctx.create("On helper", { definition: definitionWith(agent.agentId, 1) });
    const input = await ctx.publishInput(chain.chainId);
    ctx.hooks.push(publishAgain);
    await expect(ctx.chains.publish(input)).resolves.toMatchObject({ version: 1 });
  });

  it("refuses when a custom agent was archived in between, or its pinned version is gone", async () => {
    const ctx = setup();
    const { agent } = await ctx.customAgent("Helper");
    for (const version of ["current", 1] as const) {
      const chain = await ctx.create(`On helper ${String(version)}`, { definition: definitionWith(agent.agentId, version) });
      const input = await ctx.publishInput(chain.chainId);
      ctx.hooks.push(async () => { await ctx.agents.archive(ORG_A, agent.agentId, ALICE); });
      expect(await code(ctx.chains.publish(input)), String(version)).toMatchObject({ code: "CHAIN_REVISION_CONFLICT", message: expect.stringContaining("changed while it was being published") as string });
      await ctx.agents.unarchive(ORG_A, agent.agentId, ALICE);
    }
  });

  it("refuses when a built-in's org pin moved in between, and keeps a pin at or below the org's", async () => {
    const ctx = setup();
    ctx.release.codeReviewer = 2;
    ctx.db.set({ ...builtinSettingsKey(ORG_A, "code-reviewer"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 1, updatedBy: "x", updatedAt: "2026-10-20T00:00:00.000Z" });
    const chain = await ctx.create("Reviewing");
    const input = await ctx.publishInput(chain.chainId);
    expect(input.pinned.steps[1]).toMatchObject({ agent: { agentId: "code-reviewer", version: 1 } });
    ctx.hooks.push(() => { ctx.db.set({ ...builtinSettingsKey(ORG_A, "code-reviewer"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "x", updatedAt: "2026-10-21T00:00:00.000Z" }); });
    expect(await code(ctx.chains.publish(input))).toMatchObject({ code: "CHAIN_REVISION_CONFLICT", message: expect.stringContaining("changed while it was being published") as string });
    // A name given outright stays valid when the pin only rises.
    const named = await ctx.create("Named", { definition: { start: "a", steps: [{ kind: "agent", id: "a", name: "Do", agent: { agentId: "code-reviewer", version: 1 }, next: { kind: "end" } }] } });
    const namedInput = await ctx.publishInput(named.chainId);
    ctx.hooks.push(() => { ctx.db.set({ ...builtinSettingsKey(ORG_A, "code-reviewer"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "x", updatedAt: "2026-10-22T00:00:00.000Z" }); });
    await expect(ctx.chains.publish(namedInput)).resolves.toMatchObject({ version: 1 });
  });

  it("refuses a pinned built-in the org has turned off, naming it, and publishes again once it is on", async () => {
    const ctx = setup();
    const chain = await ctx.create("Reviewing");
    const input = await ctx.publishInput(chain.chainId);
    const off = await ctx.agents.putGuardrails({ ...({ orgId: ORG_A, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, disabledBuiltins: ["code-reviewer"] }, expectedRevision: 0, by: DAN }), by: fixtureActor(ctx.db, ORG_A, DAN, true).developerId, actor: fixtureActor(ctx.db, ORG_A, DAN, true) });
    expect(await code(ctx.chains.publish(input))).toEqual({ code: "AGENT_UNAVAILABLE", message: "Code reviewer is turned off in your company. Ask an admin to turn it on." });
    expect(await ctx.chains.listVersions(ORG_A, chain.chainId)).toEqual([]);
    await ctx.agents.putGuardrails({ ...({ orgId: ORG_A, guardrails: DEFAULT_AGENT_GUARDRAILS, expectedRevision: off.revision, by: DAN }), by: fixtureActor(ctx.db, ORG_A, DAN, true).developerId, actor: fixtureActor(ctx.db, ORG_A, DAN, true) });
    await expect(ctx.chains.publish(await ctx.publishInput(chain.chainId))).resolves.toMatchObject({ version: 1 });
  });

  it("refuses when a built-in is turned off between the validation and the write, and validation then says so", async () => {
    const ctx = setup();
    const chain = await ctx.create("Reviewing");
    const input = await ctx.publishInput(chain.chainId);
    ctx.hooks.push(async () => { await ctx.agents.putGuardrails({ ...({ orgId: ORG_A, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, disabledBuiltins: ["root-cause-analyst"] }, expectedRevision: 0, by: DAN }), by: fixtureActor(ctx.db, ORG_A, DAN, true).developerId, actor: fixtureActor(ctx.db, ORG_A, DAN, true) }); });
    expect(await code(ctx.chains.publish(input))).toMatchObject({ code: "CHAIN_REVISION_CONFLICT" });
    expect(await ctx.chains.listVersions(ORG_A, chain.chainId)).toEqual([]);
    // Validated again, the step says it (the store's own refusal is the backstop for a caller that did not look).
    const checked = await validateChainForPublish(ctx.agentDeps, caller(ALICE), ORG_A, (await ctx.chains.getDraft(ORG_A, chain.chainId))!.definition);
    expect(checked.problems).toEqual([{ path: "steps.0.agent", message: "Root-cause analyst is turned off in your company. Ask an admin to turn it on." }]);
    expect(await code(ctx.chains.publish({ ...input, guardrailsRevision: checked.guardrailsRevision }))).toEqual({ code: "AGENT_UNAVAILABLE", message: "Root-cause analyst is turned off in your company. Ask an admin to turn it on." });
  });

  it("refuses a hand-built pin that names an agent version that does not exist", async () => {
    const ctx = setup();
    const { agent } = await ctx.customAgent("Helper");
    const chain = await ctx.create("Ghost", { definition: definitionWith(agent.agentId, 9) });
    const draft = (await ctx.chains.getDraft(ORG_A, chain.chainId))!;
    const pinned = draft.definition as unknown as PinnedChainDefinition;
    expect(await code(ctx.chains.publish({ orgId: ORG_A, chainId: chain.chainId, expectedDraftRevision: 1, pinned, digest: chainDigest(pinned), guardrailsRevision: 0, by: ALICE }))).toEqual({
      code: "CHAIN_REVISION_CONFLICT", message: "An agent this chain uses changed while it was being published. Publish again.",
    });
  });

  it("refuses a hand-built pin of a built-in that is not what the org runs", async () => {
    const ctx = setup();
    ctx.release.codeReviewer = 2;
    const handBuilt = async (definition: ChainDefinitionInput, version: number) => {
      const chain = await ctx.create(`Hand ${String(version)} ${String(Math.random())}`, { definition });
      const draft = (await ctx.chains.getDraft(ORG_A, chain.chainId))!;
      const pinned = { ...draft.definition, steps: draft.definition.steps.map((step) => (step.kind === "agent" ? { ...step, agent: { ...step.agent, version } } : step)) };
      return code(ctx.chains.publish({ orgId: ORG_A, chainId: chain.chainId, expectedDraftRevision: 1, pinned, digest: chainDigest(pinned), guardrailsRevision: 0, by: ALICE }));
    };
    const current = definitionWith("code-reviewer", "current");
    const named = definitionWith("code-reviewer", 2);
    // A release that does not exist.
    expect(await handBuilt(definitionWith("code-reviewer", 7), 7)).toEqual({ code: "NOT_FOUND", message: "Code reviewer has no version 7" });
    // No settings yet, so the org runs the newest release (2): "current" pinned to 1 is stale.
    expect(await handBuilt(current, 1)).toMatchObject({ code: "CHAIN_REVISION_CONFLICT" });
    // The org pinned release 1: release 2 is not adopted yet, so naming it outright is refused.
    ctx.db.set({ ...builtinSettingsKey(ORG_A, "code-reviewer"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 1, updatedBy: "x", updatedAt: "2026-10-20T00:00:00.000Z" });
    expect(await handBuilt(named, 2)).toMatchObject({ code: "CHAIN_REVISION_CONFLICT" });
    expect(await handBuilt(current, 1)).toBeUndefined();
  });

  it("refuses a hand-built pin that gives one agent's \"current\" two versions", async () => {
    const ctx = setup();
    const { agent, publishAgain } = await ctx.customAgent("Helper");
    await publishAgain();
    const step = (id: string, to: string | undefined) => ({ kind: "agent" as const, id, name: id, agent: { agentId: agent.agentId, version: "current" as const }, next: to === undefined ? ({ kind: "end" } as const) : ({ kind: "go", to } as const) });
    const chain = await ctx.create("Twice", { definition: { start: "a", steps: [step("a", "b"), step("b", undefined)] } });
    const draft = (await ctx.chains.getDraft(ORG_A, chain.chainId))!;
    const pinned = { ...draft.definition, steps: draft.definition.steps.map((entry, index) => (entry.kind === "agent" ? { ...entry, agent: { ...entry.agent, version: index + 1 } } : entry)) };
    expect(await code(ctx.chains.publish({ orgId: ORG_A, chainId: chain.chainId, expectedDraftRevision: 1, pinned, digest: chainDigest(pinned), guardrailsRevision: 0, by: ALICE }))).toEqual({
      code: "CONFIG_INVALID", message: "pinned: one agent's \"current\" cannot be two versions",
    });
  });

  it("conditions every publish on the guardrails the validation read, custom agents only included", async () => {
    const ctx = setup();
    const { agent } = await ctx.customAgent("Helper");
    const chain = await ctx.create("On helper", { definition: definitionWith(agent.agentId, "current") });
    const input = await ctx.publishInput(chain.chainId);
    expect(input.guardrailsRevision).toBe(0);
    // An admin changes the guardrails between the validation and the write: the chain was checked against the old ones.
    ctx.hooks.push(async () => { await ctx.agents.putGuardrails({ ...({ orgId: ORG_A, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: [{ provider: "openai", modelId: "gpt-x" }] }, expectedRevision: 0, by: DAN }), by: fixtureActor(ctx.db, ORG_A, DAN, true).developerId, actor: fixtureActor(ctx.db, ORG_A, DAN, true) }); });
    expect(await code(ctx.chains.publish(input))).toEqual({ code: "CHAIN_REVISION_CONFLICT", message: "An agent this chain uses changed while it was being published. Publish again." });
    expect(await ctx.chains.listVersions(ORG_A, chain.chainId)).toEqual([]);
    // Validated again, it publishes, at the revision it read now.
    const again = await ctx.publishInput(chain.chainId);
    expect(again.guardrailsRevision).toBe(1);
    await expect(ctx.chains.publish(again)).resolves.toMatchObject({ version: 1 });
  });

  it("refuses a publish whose guardrails revision is not the one in force, before the transaction", async () => {
    const ctx = setup();
    const chain = await ctx.create("Reviewing");
    const input = await ctx.publishInput(chain.chainId);
    expect(await code(ctx.chains.publish({ ...input, guardrailsRevision: 5 }))).toEqual({ code: "CHAIN_REVISION_CONFLICT", message: "An agent this chain uses changed while it was being published. Publish again." });
    expect(await ctx.chains.listVersions(ORG_A, chain.chainId)).toEqual([]);
  });

  it("publishes a chain that uses one agent in many steps (one check per agent, not per step)", async () => {
    const ctx = setup();
    const { agent } = await ctx.customAgent("Helper");
    const steps: ChainDefinitionInput["steps"] = Array.from({ length: 3 }, (_unused, index) => ({ kind: "agent" as const, id: `s${String(index)}`, name: "Do", agent: { agentId: agent.agentId, version: index === 0 ? ("current" as const) : 1 }, next: index === 2 ? ({ kind: "end" } as const) : ({ kind: "go", to: `s${String(index + 1)}` } as const) }));
    const chain = await ctx.create("Many", { definition: { start: "s0", steps } });
    await expect(ctx.publish(chain.chainId)).resolves.toMatchObject({ version: 1 });
  });
});

describe("every write leaves one event", () => {
  it("counts exactly one EVENT# item per write, with its kind", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    const kinds = () => ctx.events(ORG_A, chain.chainId).map((item) => item["kind"]);
    expect(kinds()).toEqual(["created"]);
    const steps: Array<[string, number, () => Promise<unknown>]> = [
      ["draft_saved", 1, () => ctx.edit(chain.chainId)],
      ["profile_changed", 1, () => ctx.chains.updateProfile({ orgId: ORG_A, chainId: chain.chainId, description: "d", by: ALICE })],
      ["published", 1, () => ctx.publish(chain.chainId)],
      ["rolled_back", 1, async () => { await ctx.edit(chain.chainId, TWO_STEPS, "again"); await ctx.publish(chain.chainId); }],
      ["budget_changed", 1, () => ctx.chains.setBudget(ORG_A, chain.chainId, 10, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) })],
      ["owner_changed", 1, () => ctx.chains.setOwner(ORG_A, chain.chainId, { kind: "member", developerId: BOB }, ALICE, undefined, undefined, { actor: fixtureActor(ctx.db, ORG_A, ALICE) })],
      ["archived", 1, () => ctx.chains.archive(ORG_A, chain.chainId, ALICE)],
      ["unarchived", 1, () => ctx.chains.unarchive(ORG_A, chain.chainId, ALICE)],
      ["shared", 1, () => setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "member", developerId: CAROL }, level: "use" }], by: ALICE })],
    ];
    // "rolled_back" runs after the step that makes version 2 (a draft and a publish, two events), so it is checked on its own below.
    steps[3] = ["published", 2, steps[3]![2]];
    const seen: unknown[] = ["created"];
    for (const [kind, count, run] of steps) {
      const before = ctx.events(ORG_A, chain.chainId).length;
      await run();
      const added = kinds().slice(before);
      expect(added.length, kind).toBe(count);
      expect(added.at(-1), kind).toBe(kind);
      seen.push(...added);
      if (kind === "published" && count === 2) {
        const rolled = ctx.events(ORG_A, chain.chainId).length;
        await ctx.chains.rollback({ orgId: ORG_A, chainId: chain.chainId, version: 1, expectedCurrentVersion: 2, guardrailsRevision: 0, by: ALICE });
        expect(kinds().slice(rolled)).toEqual(["rolled_back"]);
        seen.push("rolled_back");
      }
    }
    expect(kinds()).toEqual(seen);
  });

  it("does not leave an event when a write is refused", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    const before = ctx.events(ORG_A, chain.chainId).length;
    await code(ctx.chains.saveDraft({ orgId: ORG_A, chainId: chain.chainId, definition: TWO_STEPS, expectedRevision: 7, by: ALICE }));
    await code(ctx.chains.rollback({ orgId: ORG_A, chainId: chain.chainId, version: 3, expectedCurrentVersion: 1, guardrailsRevision: 0, by: ALICE }));
    await code(ctx.chains.publish({ ...(await ctx.publishInput(chain.chainId)), expectedDraftRevision: 9 }));
    expect(ctx.events(ORG_A, chain.chainId)).toHaveLength(before);
  });

  it("archive and unarchive that change nothing write nothing", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    await ctx.chains.unarchive(ORG_A, chain.chainId, ALICE);
    expect(ctx.events(ORG_A, chain.chainId)).toHaveLength(1);
    await ctx.chains.archive(ORG_A, chain.chainId, ALICE);
    await ctx.chains.archive(ORG_A, chain.chainId, ALICE);
    expect(ctx.events(ORG_A, chain.chainId).map((item) => item["kind"])).toEqual(["created", "archived"]);
    expect((await ctx.chains.get(ORG_A, chain.chainId))!.status).toBe("archived");
  });
});

describe("the owner's monthly total", () => {
  it("setBudget changes the total in the same transaction as the chain, and a refused transaction changes neither", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    await ctx.chains.setBudget(ORG_A, chain.chainId, 10, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(await ctx.chains.get(ORG_A, chain.chainId)).toMatchObject({ monthlyBudgetUsd: 10 });
    expect(ctx.total(ALICE)).toBe(10);
    // A write that lands between the read and the write makes the whole transaction refuse: the counter does not move either.
    ctx.hooks.push(async () => { await ctx.chains.updateProfile({ orgId: ORG_A, chainId: chain.chainId, description: "d", by: ALICE }); await ctx.chains.setBudget(ORG_A, chain.chainId, 3, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) }); });
    expect(await code(ctx.chains.setBudget(ORG_A, chain.chainId, 50, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) }))).toMatchObject({ code: "CHAIN_REVISION_CONFLICT" });
    expect(await ctx.chains.get(ORG_A, chain.chainId)).toMatchObject({ monthlyBudgetUsd: 3 });
    expect(ctx.total(ALICE)).toBe(3);
    ctx.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" }, times: 1 });
    await code(ctx.chains.setBudget(ORG_A, chain.chainId, 7, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) }));
    expect(await ctx.chains.get(ORG_A, chain.chainId)).toMatchObject({ monthlyBudgetUsd: 3 });
    expect(ctx.total(ALICE)).toBe(3);
  });

  it("clears the budget with undefined and lowers the total", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    await ctx.chains.setBudget(ORG_A, chain.chainId, 10, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    const cleared = await ctx.chains.setBudget(ORG_A, chain.chainId, undefined, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(cleared.monthlyBudgetUsd).toBeUndefined();
    expect((await ctx.chains.get(ORG_A, chain.chainId))!.monthlyBudgetUsd).toBeUndefined();
    expect(ctx.total(ALICE)).toBe(0);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await code(ctx.chains.setBudget(ORG_A, chain.chainId, bad, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) }))).toMatchObject({ code: "CONFIG_INVALID", message: "monthlyUsd: must be a number of dollars, zero or more" });
    }
  });

  it("builds a missing total from the owner's agent budgets and chain budgets together", async () => {
    const ctx = setup();
    const agent = await ctx.agents.create({ orgId: ORG_A, name: "Budgeted", owner: ALICE_OWNS, overlay: SCRATCH, createdBy: ALICE });
    await ctx.agents.setBudget(ORG_A, agent.agentId, { monthlyUsd: 5 }, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(ctx.total(ALICE)).toBe(5);
    const chain = await ctx.create("Investigate");
    await ctx.chains.setBudget(ORG_A, chain.chainId, 3, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(ctx.total(ALICE)).toBe(8);
    // Delete the counter: the next budget write rebuilds it from both kinds before it adds its own change.
    ctx.db.delete(ownerBudgetKey(ORG_A, ALICE));
    const second = await ctx.create("Second");
    await ctx.chains.setBudget(ORG_A, second.chainId, 2, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(ctx.total(ALICE)).toBe(10);
    expect(await ctx.agents.rebuildOwnerTotal(ORG_A, ALICE)).toBe(10);
    // And the chain side of a rebuild matches what the agents' side would have built.
    ctx.db.delete(ownerBudgetKey(ORG_A, ALICE));
    await ctx.agents.ensureOwnerTotal(ORG_A, ALICE);
    expect(ctx.total(ALICE)).toBe(10);
  });

  it("archive takes the budget out of the total and unarchive puts it back", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    await ctx.chains.setBudget(ORG_A, chain.chainId, 10, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    await ctx.chains.archive(ORG_A, chain.chainId, ALICE);
    expect(ctx.total(ALICE)).toBe(0);
    await ctx.chains.unarchive(ORG_A, chain.chainId, ALICE);
    expect(ctx.total(ALICE)).toBe(10);
  });

  it("setOwner moves the budget to the new owner's total in the same transaction, and a project chain counts for its accountable", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    await ctx.chains.setBudget(ORG_A, chain.chainId, 10, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    await ctx.chains.setOwner(ORG_A, chain.chainId, { kind: "member", developerId: BOB }, ALICE, undefined, undefined, { actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(ctx.total(ALICE)).toBe(0);
    expect(ctx.total(BOB)).toBe(10);
    expect(await ctx.chains.get(ORG_A, chain.chainId)).toMatchObject({ owner: { kind: "member", developerId: BOB } });
    const moved = await ctx.chains.setOwner(ORG_A, chain.chainId, WEB_OWNS, DAN, { developerId: CAROL }, undefined, { actor: fixtureActor(ctx.db, ORG_A, DAN) });
    expect(moved).toMatchObject({ owner: WEB_OWNS, accountable: { developerId: CAROL } });
    expect(ctx.total(BOB)).toBe(0);
    expect(ctx.total(CAROL)).toBe(10);
    await ctx.chains.setAccountable(ORG_A, chain.chainId, { developerId: BOB }, DAN);
    expect(ctx.total(CAROL)).toBe(0);
    expect(ctx.total(BOB)).toBe(10);
    // A member owner has no accountable; a project owner needs one.
    expect(await code(ctx.chains.setOwner(ORG_A, chain.chainId, WEB_OWNS, DAN, undefined, undefined, { actor: fixtureActor(ctx.db, ORG_A, DAN) }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(ctx.chains.setOwner(ORG_A, chain.chainId, ALICE_OWNS, DAN, { developerId: BOB }, undefined, { actor: fixtureActor(ctx.db, ORG_A, DAN) }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(ctx.chains.setAccountable(ORG_A, (await ctx.create("Mine")).chainId, { developerId: BOB }, DAN))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("does not count an archived chain, or one with no budget, when it builds a total", async () => {
    const ctx = setup();
    const archived = await ctx.create("Archived");
    await ctx.chains.setBudget(ORG_A, archived.chainId, 10, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    await ctx.chains.archive(ORG_A, archived.chainId, ALICE);
    const live = await ctx.create("Live");
    await ctx.chains.setBudget(ORG_A, live.chainId, 2, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    await ctx.create("Unbudgeted");
    ctx.db.delete(ownerBudgetKey(ORG_A, ALICE));
    expect(await ctx.agents.rebuildOwnerTotal(ORG_A, ALICE)).toBe(2);
    expect(ctx.total(ALICE)).toBe(2);
    // Another person's chain is not in this person's total.
    const bobs = await ctx.create("Bobs", { owner: { kind: "member", developerId: BOB }, by: BOB });
    await ctx.chains.setBudget(ORG_A, bobs.chainId, 7, fixtureActor(ctx.db, ORG_A, BOB).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, BOB) });
    expect(ctx.total(ALICE)).toBe(2);
    expect(ctx.total(BOB)).toBe(7);
  });

  it("answers CHAIN_REVISION_CONFLICT when the spend policy moved since the cap was read, and when the total moved under a lowering", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    await ctx.chains.setBudget(ORG_A, chain.chainId, 8, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    // The cap was read at policy revision 3, but the policy is not there (revision 0): the policy moved.
    expect(await code(ctx.chains.setBudget(ORG_A, chain.chainId, 9, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({ ownerCap: { usd: 100, policyRevision: 3 } }), actor: fixtureActor(ctx.db, ORG_A, ALICE) }))).toEqual({
      code: "CHAIN_REVISION_CONFLICT", message: "Your company's spend policy changed just now. Reload and make your change again.",
    });
    expect(ctx.total(ALICE)).toBe(8);
    // The owner's total is lowered by someone else between the read and the write: a decrease needs the room it takes out.
    ctx.hooks.push(() => { ctx.db.set({ ...ctx.db.get(ownerBudgetKey(ORG_A, ALICE))!, totalUsd: 1 }); });
    expect(await code(ctx.chains.setBudget(ORG_A, chain.chainId, 2, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) }))).toEqual({
      code: "CHAIN_REVISION_CONFLICT", message: "Someone else changed this person's agent and chain budgets just now. Reload and make your change again.",
    });
    expect((await ctx.chains.get(ORG_A, chain.chainId))!.monthlyBudgetUsd).toBe(8);
  });

  it("holds a raise to the cap it is given, and refuses with the owner named", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    await ctx.chains.setBudget(ORG_A, chain.chainId, 8, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({ ownerCap: { usd: 10, policyRevision: 0 } }), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    const error = await ctx.chains.setBudget(ORG_A, chain.chainId, 12, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({ ownerCap: { usd: 10, policyRevision: 0 } }), actor: fixtureActor(ctx.db, ORG_A, ALICE) }).catch((caught: unknown) => caught);
    expect(isOwnerCapRefusal(error)).toBe(ALICE);
    // The total holds agent and chain budgets, and the words say so.
    expect((error as Error).message).toBe("CONFIG_INVALID: That would take this person's agent and chain budgets past the limit for one person. An org admin can raise the limit in the spend policy.");
    expect(ctx.total(ALICE)).toBe(8);
    expect((await ctx.chains.get(ORG_A, chain.chainId))!.monthlyBudgetUsd).toBe(8);
  });

  it("archives only a chain whose owner, status and budget are as they were read, even when no total is involved", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    ctx.hooks.push(async () => { await ctx.chains.setOwner(ORG_A, chain.chainId, { kind: "member", developerId: BOB }, DAN, undefined, undefined, { actor: fixtureActor(ctx.db, ORG_A, DAN) }); });
    expect(await code(ctx.chains.archive(ORG_A, chain.chainId, ALICE))).toMatchObject({ code: "CHAIN_REVISION_CONFLICT" });
    expect(await ctx.chains.get(ORG_A, chain.chainId)).toMatchObject({ status: "active", owner: { kind: "member", developerId: BOB } });
  });

  it("moves an owner only while nothing else about the chain changed since it was read", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    ctx.hooks.push(async () => { ctx.clock.now += 1000; await ctx.chains.updateProfile({ orgId: ORG_A, chainId: chain.chainId, description: "changed meanwhile", by: ALICE }); });
    expect(await code(ctx.chains.setOwner(ORG_A, chain.chainId, { kind: "member", developerId: BOB }, DAN, undefined, undefined, { actor: fixtureActor(ctx.db, ORG_A, DAN) }))).toMatchObject({ code: "CHAIN_REVISION_CONFLICT" });
    expect((await ctx.chains.get(ORG_A, chain.chainId))!.owner).toEqual(ALICE_OWNS);
  });

  it("skips a directory entry whose chain is gone when it lists", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    ctx.db.set({ ...chainDirectoryKey(ORG_A, "chn_zzzzzzzzzzzzzzzzzzzz"), entityType: "CHAIN_DIRECTORY", chainId: "chn_zzzzzzzzzzzzzzzzzzzz" });
    expect((await ctx.chains.list(ORG_A)).map((entry) => entry.chainId)).toEqual([chain.chainId]);
  });

  it("changes nothing when the chain changed since it was read (stale owner, status or budget)", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    await ctx.chains.setBudget(ORG_A, chain.chainId, 10, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    ctx.hooks.push(async () => { await ctx.chains.setBudget(ORG_A, chain.chainId, 4, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) }); });
    expect(await code(ctx.chains.archive(ORG_A, chain.chainId, ALICE))).toMatchObject({ code: "CHAIN_REVISION_CONFLICT" });
    expect(ctx.total(ALICE)).toBe(4);
    expect((await ctx.chains.get(ORG_A, chain.chainId))!.status).toBe("active");
  });
});

describe("one monthly total for agent and chain budgets", () => {
  it("counts a chain's budget once however many chain stores share an agent store (a replaced source, not an added one)", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    await ctx.chains.setBudget(ORG_A, chain.chainId, 3, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(ctx.total(ALICE)).toBe(3);
    const second = new ChainStore({ documentClient: ctx.client, tableName: "T", now: () => ctx.clock.now, agents: ctx.agents });
    const third = new ChainStore({ documentClient: ctx.client, tableName: "T", now: () => ctx.clock.now, agents: ctx.agents });
    expect(await ctx.agents.rebuildOwnerTotal(ORG_A, ALICE)).toBe(3);
    expect(ctx.total(ALICE)).toBe(3);
    // A budget written through the newest store builds its total from the same single source.
    ctx.db.delete(ownerBudgetKey(ORG_A, ALICE));
    await third.setBudget(ORG_A, chain.chainId, 5, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(ctx.total(ALICE)).toBe(5);
    expect(await second.list(ORG_A)).toHaveLength(1);
    // And an agent store rebuilt on the same ledger does not double the agents' side either.
    const agent = await ctx.agents.create({ orgId: ORG_A, name: "Budgeted", owner: ALICE_OWNS, overlay: SCRATCH, createdBy: ALICE });
    await ctx.agents.setBudget(ORG_A, agent.agentId, { monthlyUsd: 4 }, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(ctx.total(ALICE)).toBe(9);
    new AgentStore({ documentClient: ctx.client, tableName: "T", now: () => ctx.clock.now, ownerBudgets: ctx.agents.ownerBudgets });
    expect(await ctx.agents.rebuildOwnerTotal(ORG_A, ALICE)).toBe(9);
  });

  it("refuses a store on another table registering on a ledger", () => {
    const ctx = setup();
    const other = new FakeDynamoDb();
    expect(() => new ChainStore({ documentClient: other, tableName: "T", now: () => ctx.clock.now, agents: ctx.agents })).toThrow(/another table/);
    expect(() => new AgentStore({ documentClient: other, tableName: "T", now: () => ctx.clock.now, ownerBudgets: ctx.agents.ownerBudgets })).toThrow(/another table/);
    // The same client on a differently named table is another table too.
    expect(() => new ChainStore({ documentClient: ctx.client, tableName: "U", now: () => ctx.clock.now, agents: ctx.agents })).toThrow(/another table/);
  });
});

describe("merged with Plan 3: one owner total with a version, an effective cap and an approved override", () => {
  const version = (ctx: ReturnType<typeof setup>, owner = ALICE) => ctx.db.get(ownerBudgetKey(ORG_A, owner))?.["version"];

  it("builds a counter at version 0, bumps it on every chain budget change and shares the version with the agent store", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    await ctx.chains.setBudget(ORG_A, chain.chainId, 10, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(version(ctx)).toBe(1);
    await ctx.chains.setBudget(ORG_A, chain.chainId, 4, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(version(ctx)).toBe(2);
    await ctx.chains.archive(ORG_A, chain.chainId, ALICE);
    expect(version(ctx)).toBe(3);
    await ctx.chains.unarchive(ORG_A, chain.chainId, ALICE);
    expect(version(ctx)).toBe(4);
    await ctx.chains.setOwner(ORG_A, chain.chainId, { kind: "member", developerId: BOB }, ALICE, undefined, undefined, { actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(version(ctx, ALICE)).toBe(5);
    expect(version(ctx, BOB)).toBe(1);
    // An agent's budget change of the same owner moves the same counter.
    const agent = await ctx.agents.create({ orgId: ORG_A, name: "Budgeted", owner: { kind: "member", developerId: BOB }, overlay: SCRATCH, createdBy: BOB });
    await ctx.agents.setBudget(ORG_A, agent.agentId, { monthlyUsd: 2 }, fixtureActor(ctx.db, ORG_A, BOB).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, BOB) });
    expect(version(ctx, BOB)).toBe(2);
    // A rebuild moves it too (it changes the figure an approval summed at).
    ctx.db.set({ ...ctx.db.get(ownerBudgetKey(ORG_A, BOB))!, totalUsd: 99 });
    expect(await ctx.agents.rebuildOwnerTotal(ORG_A, BOB)).toBe(6);
    expect(version(ctx, BOB)).toBe(3);
  });

  it("a counter built fresh starts at version 0", async () => {
    const ctx = setup();
    await ctx.agents.ensureOwnerTotal(ORG_A, ALICE);
    expect(version(ctx)).toBe(0);
  });

  it("holds a chain raise to the counter version it was read at: a budget change of the same owner since then refuses it", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    const agent = await ctx.agents.create({ orgId: ORG_A, name: "Budgeted", owner: ALICE_OWNS, overlay: SCRATCH, createdBy: ALICE });
    await ctx.chains.setBudget(ORG_A, chain.chainId, 5, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    const seen = { owner: ALICE, version: version(ctx) as number, extraUsd: 0 };
    ctx.hooks.push(async () => { await ctx.agents.setBudget(ORG_A, agent.agentId, { monthlyUsd: 1 }, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) }); });
    // The version and the cap are conditions of the one counter item, so the refusal reads as the cap's: the route re-reads once and decides again (Plan 3 Task 28).
    const error = await ctx.chains.setBudget(ORG_A, chain.chainId, 6, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({ ownerCap: { usd: 100, policyRevision: 0, seen } }), actor: fixtureActor(ctx.db, ORG_A, ALICE) }).catch((caught: unknown) => caught);
    expect(isOwnerCapRefusal(error)).toBe(ALICE);
    expect((await ctx.chains.get(ORG_A, chain.chainId))!.monthlyBudgetUsd).toBe(5);
    expect(ctx.total(ALICE)).toBe(6);
  });

  it("holds a chain raise to the cap less what the effective total holds beyond the counter (this month's top-ups)", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    await ctx.chains.setBudget(ORG_A, chain.chainId, 10, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    const seen = { owner: ALICE, version: version(ctx) as number, extraUsd: 85 };
    const error = await ctx.chains.setBudget(ORG_A, chain.chainId, 16, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({ ownerCap: { usd: 100, policyRevision: 0, seen } }), actor: fixtureActor(ctx.db, ORG_A, ALICE) }).catch((caught: unknown) => caught);
    expect(isOwnerCapRefusal(error)).toBe(ALICE);
    expect((await ctx.chains.get(ORG_A, chain.chainId))!.monthlyBudgetUsd).toBe(10);
    // Landing exactly on the cap passes.
    await ctx.chains.setBudget(ORG_A, chain.chainId, 15, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({ ownerCap: { usd: 100, policyRevision: 0, seen } }), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    expect(ctx.total(ALICE)).toBe(15);
  });

  it("an approved owner_cap request applies the stored change with its own items in the same transaction, and names the request in the event", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    const marker = { pk: "TEST#marker", sk: "1" };
    seedMembership(ctx.db, ALICE, { orgId: ORG_A, role: "member" });
    const overrideCap = { actor: { developerId: ALICE, role: "member" as const }, spendRequestId: "spr_0123456789abcdefghij", items: [{ Put: { TableName: "T", Item: { ...marker, entityType: "MARKER" } } }], closed: () => new Error("the request was decided") };
    await expect(ctx.chains.archive(ORG_A, chain.chainId, BOB, undefined, { overrideCap })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await ctx.chains.get(ORG_A, chain.chainId))?.status).toBe("active");
    await ctx.chains.setBudget(ORG_A, chain.chainId, 500, ALICE, undefined, { overrideCap });
    expect(ctx.total(ALICE)).toBe(500);
    expect(ctx.db.get(marker)).toBeDefined();
    expect(ctx.events(ORG_A, chain.chainId).at(-1)).toMatchObject({ kind: "budget_changed", overrideCap: "spr_0123456789abcdefghij" });
    // The request's own item refusing (decided meanwhile) names the request's refusal and changes nothing.
    const gone = { ...overrideCap, items: [{ ConditionCheck: { TableName: "T", Key: { pk: "TEST#absent", sk: "1" }, ConditionExpression: "attribute_exists(pk)" } }] };
    await expect(ctx.chains.setBudget(ORG_A, chain.chainId, 600, ALICE, undefined, { overrideCap: gone })).rejects.toThrow("the request was decided");
    expect(ctx.total(ALICE)).toBe(500);
    // The same for the owner moves and archive.
    await expect(ctx.chains.archive(ORG_A, chain.chainId, ALICE, undefined, { overrideCap: gone })).rejects.toThrow("the request was decided");
    await expect(ctx.chains.setOwner(ORG_A, chain.chainId, { kind: "member", developerId: BOB }, ALICE, undefined, undefined, { overrideCap: gone })).rejects.toThrow("the request was decided");
    expect((await ctx.chains.get(ORG_A, chain.chainId))!).toMatchObject({ status: "active", owner: ALICE_OWNS });
  });

  it("the effective total sums agent and chain budgets, so it equals the counter when there are no top-ups and an archived chain is not in it", async () => {
    const ctx = setup();
    const agent = await ctx.agents.create({ orgId: ORG_A, name: "Budgeted", owner: ALICE_OWNS, overlay: SCRATCH, createdBy: ALICE });
    await ctx.agents.setBudget(ORG_A, agent.agentId, { monthlyUsd: 5 }, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    const live = await ctx.create("Live");
    await ctx.chains.setBudget(ORG_A, live.chainId, 3, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    const gone = await ctx.create("Gone");
    await ctx.chains.setBudget(ORG_A, gone.chainId, 7, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    await ctx.chains.archive(ORG_A, gone.chainId, ALICE);
    const deps = { store: ctx.agents, chains: ctx.chains, documentClient: ctx.client, tableName: "T", now: () => ctx.clock.now } as never;
    const effective = await ownerEffectiveTotal(deps, { orgId: ORG_A, owner: ALICE, month: "2026-10" });
    expect(effective).toEqual({ totalUsd: 8, counterUsd: 8, version: version(ctx) });
    // No chain store: only the agents' side (a deployment without chains).
    expect(await ownerEffectiveTotal({ ...(deps as object), chains: undefined } as never, { orgId: ORG_A, owner: ALICE, month: "2026-10" })).toMatchObject({ totalUsd: 5, counterUsd: 8 });
  });

  it("says \"agent and chain budgets\" when a chain's write can't settle the owner's total, and \"agent budgets\" for an agent's", async () => {
    const ctx = setup();
    // OLD_ALICE was merged into ALICE: a record naming the duplicate has the survivor's total rebuilt first.
    const resolveOwner = async (_orgId: OrgId, id: string) => (id === OLD_ALICE ? ALICE : id);
    const agents = new AgentStore({ documentClient: ctx.client, tableName: "T", now: () => ctx.clock.now, resolveOwner });
    const chains = new ChainStore({ documentClient: ctx.client, tableName: "T", now: () => ctx.clock.now, agents });
    const chain = await chains.create({ orgId: ORG_A, name: "Old", owner: { kind: "member", developerId: OLD_ALICE }, definition: TWO_STEPS, createdBy: ALICE });
    const agent = await agents.create({ orgId: ORG_A, name: "Old agent", owner: { kind: "member", developerId: OLD_ALICE }, overlay: SCRATCH, createdBy: ALICE });
    const jam = () => ctx.db.injectFault({ command: "UpdateCommand", match: (input) => JSON.stringify(input).includes("#built"), error: { name: "ConditionalCheckFailedException" }, times: 5 });
    jam();
    expect(await code(chains.setBudget(ORG_A, chain.chainId, 5, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) }))).toEqual({
      code: "CHAIN_REVISION_CONFLICT", message: "Someone else changed this person's agent and chain budgets just now. Reload and make your change again.",
    });
    jam();
    expect(await code(agents.setBudget(ORG_A, agent.agentId, { monthlyUsd: 5 }, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) }))).toMatchObject({ code: "AGENT_REVISION_CONFLICT", message: "Someone else changed this person's agent budgets just now. Reload and make your change again." });
  });

  it("lists the active chains that count for an owner", async () => {
    const ctx = setup();
    const mine = await ctx.create("Mine");
    await ctx.chains.setBudget(ORG_A, mine.chainId, 3, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    const archived = await ctx.create("Archived");
    await ctx.chains.setBudget(ORG_A, archived.chainId, 9, fixtureActor(ctx.db, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, ALICE) });
    await ctx.chains.archive(ORG_A, archived.chainId, ALICE);
    await ctx.create("None");
    const bobs = await ctx.create("Bobs", { owner: { kind: "member", developerId: BOB }, by: BOB });
    await ctx.chains.setBudget(ORG_A, bobs.chainId, 4, fixtureActor(ctx.db, ORG_A, BOB).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, BOB) });
    const project = await ctx.create("Project", { owner: WEB_OWNS, accountable: { developerId: ALICE }, by: DAN });
    await ctx.chains.setBudget(ORG_A, project.chainId, 2, fixtureActor(ctx.db, ORG_A, DAN).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, DAN) });
    expect(await ctx.chains.ownerChains(ORG_A, ALICE)).toEqual([{ chainId: mine.chainId, monthlyBudgetUsd: 3 }, { chainId: project.chainId, monthlyBudgetUsd: 2 }]);
    expect(await ctx.chains.ownerChains(ORG_A, BOB)).toEqual([{ chainId: bobs.chainId, monthlyBudgetUsd: 4 }]);
  });
});

describe("which failed item a publish blames", () => {
  const faultAt = (ctx: ReturnType<typeof setup>, failing: number, length: number) => {
    ctx.db.injectFault({
      command: "TransactWriteCommand",
      error: { name: "TransactionCanceledException", cancellationReasons: Array.from({ length }, (_unused, index) => ({ Code: index === failing ? "ConditionalCheckFailed" : "None" })) },
    });
  };

  it("blames an agent only for a check item; the chain's own items and the audit item are a conflict of the draft", async () => {
    const ctx = setup({ audit: true });
    const chain = await ctx.create("Reviewing");
    const input = await ctx.publishInput(chain.chainId);
    // Written: version, chain, event (0 to 2); checks: two built-ins' settings and the guardrails (3 to 5); the audit item (6).
    faultAt(ctx, 6, 7);
    expect(await code(ctx.chains.publish(input))).toEqual({ code: "CHAIN_REVISION_CONFLICT", message: CONFLICT });
    faultAt(ctx, 1, 7);
    expect(await code(ctx.chains.publish(input))).toEqual({ code: "CHAIN_REVISION_CONFLICT", message: CONFLICT });
    faultAt(ctx, 4, 7);
    expect(await code(ctx.chains.publish(input))).toEqual({ code: "CHAIN_REVISION_CONFLICT", message: "An agent this chain uses changed while it was being published. Publish again." });
    faultAt(ctx, 5, 7);
    expect(await code(ctx.chains.publish(input))).toEqual({ code: "CHAIN_REVISION_CONFLICT", message: "An agent this chain uses changed while it was being published. Publish again." });
    await expect(ctx.chains.publish(input)).resolves.toMatchObject({ version: 1 });
  });
});

describe("event kinds are checked by the compiler", () => {
  it("rejects a kind the store does not write", () => {
    // These never run: `tsc` is the test (an unused @ts-expect-error is itself an error).
    class TypoChains extends ChainStore {
      typo(): void {
        // @ts-expect-error "rolledback" is not an event kind of a chain
        void this.event(ORG_A, "chn_x", "rolledback", "x");
        void this.event(ORG_A, "chn_x", "rolled_back", "x");
      }
    }
    class TypoAgents extends AgentStore {
      typo(): void {
        // @ts-expect-error "publishd" is not an event kind of an agent
        void this.event(ORG_A, "agt_x", "publishd", "x");
        void this.event(ORG_A, "agt_x", "published", "x");
      }
    }
    expect([TypoChains, TypoAgents]).toHaveLength(2);
  });
});

describe("audit events", () => {
  it("records chain.published, chain.rolled_back, chain.owner_changed and a chain budget change", async () => {
    const ctx = setup({ audit: true });
    const chain = await ctx.create("Investigate");
    await ctx.publish(chain.chainId);
    await ctx.edit(chain.chainId);
    await ctx.publish(chain.chainId);
    await ctx.chains.rollback({ orgId: ORG_A, chainId: chain.chainId, version: 1, expectedCurrentVersion: 2, guardrailsRevision: 0, by: BOB });
    await ctx.chains.setOwner(ORG_A, chain.chainId, { kind: "member", developerId: BOB }, DAN, undefined, undefined, { actor: fixtureActor(ctx.db, ORG_A, DAN) });
    await ctx.chains.setBudget(ORG_A, chain.chainId, 12, fixtureActor(ctx.db, ORG_A, BOB).developerId, undefined, { ...({}), actor: fixtureActor(ctx.db, ORG_A, BOB) });
    const audit = ctx.audit!;
    expect(audit.recordedBy("chain.published")).toMatchObject([{ target: { kind: "chain", id: chain.chainId }, facts: { version: 1 } }, { facts: { version: 2 } }]);
    expect(audit.recordedBy("chain.rolled_back")).toMatchObject([{ actor: { kind: "member", id: BOB }, facts: { fromVersion: 2, toVersion: 1 } }]);
    expect(audit.recordedBy("chain.owner_changed")).toMatchObject([{ target: { kind: "chain", id: chain.chainId }, facts: { field: "owner" } }]);
    expect(audit.recordedBy("budget.changed")).toMatchObject([{ facts: { scopeKind: "chain", field: "chain_monthly_limit", toCents: 1200 } }]);
    expect(audit.logs).toEqual([]);
  });
});

describe("shares", () => {
  const share = (principal: Parameters<typeof setChainShares>[1]["shares"][number]["principal"], level: "view" | "use" | "edit" = "view") => ({ principal, level });

  it("writes the share and its index item under the chain's own keys, never the agents'", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    const shared = await setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [share({ kind: "member", developerId: BOB }, "edit")], by: ALICE });
    expect(shared).toEqual([share({ kind: "member", developerId: BOB }, "edit")]);
    expect(await ctx.chains.listShares(ORG_A, chain.chainId)).toMatchObject([{ principal: { kind: "member", developerId: BOB }, level: "edit", grantedBy: ALICE }]);
    expect(ctx.db.get(chainKey(ORG_A, chain.chainId, `SHARE#MEMBER#${BOB}`))).toMatchObject({ entityType: "CHAIN_SHARE", chainId: chain.chainId });
    expect(ctx.db.get(principalChainSharesKey(ORG_A, { kind: "member", developerId: BOB }, chain.chainId))).toMatchObject({ entityType: "CHAIN_SHARE_INDEX", level: "edit" });
    expect(ctx.db.get(principalSharesKey(ORG_A, { kind: "member", developerId: BOB }, chain.chainId))).toBeUndefined();
    expect(await ctx.chains.listSharedWith(ORG_A, { kind: "member", developerId: BOB })).toEqual([chain.chainId]);
    expect(await ctx.agents.listSharedWith(ORG_A, { kind: "member", developerId: BOB })).toEqual([]);
    expect((await ctx.chains.get(ORG_A, chain.chainId))!).toMatchObject({ sharesRevision: 1 });
  });

  it("replaces the whole set: changes a level, drops a share, and writes nothing for a set that is already there", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    const bob = { kind: "member", developerId: BOB } as const;
    const carol = { kind: "member", developerId: CAROL } as const;
    await setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [share(bob), share(carol)], by: ALICE });
    await setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [share(bob, "use")], by: ALICE });
    expect((await ctx.chains.listShares(ORG_A, chain.chainId)).map((entry) => [entry.principal, entry.level])).toEqual([[bob, "use"]]);
    expect(ctx.db.get(principalChainSharesKey(ORG_A, carol, chain.chainId))).toBeUndefined();
    const events = ctx.events(ORG_A, chain.chainId).length;
    await setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [share(bob, "use")], by: ALICE });
    expect(ctx.events(ORG_A, chain.chainId)).toHaveLength(events);
  });

  it("refuses more than 50 shares, an unknown member or project, a repeated principal, and a bad level, naming the path", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    const run = (shares: unknown) => code(setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: shares as never, by: ALICE }));
    expect(await run(Array.from({ length: 51 }, (_unused, index) => share({ kind: "member", developerId: index.toString(16).padStart(64, "0") })))).toEqual({ code: "CONFIG_INVALID", message: "shares: a chain can be shared with at most 50 people or groups" });
    expect(await run([share({ kind: "member", developerId: STRANGER })])).toEqual({ code: "CONFIG_INVALID", message: "shares.0: nobody in your company has that ID" });
    expect(await run([share({ kind: "project", project: "nope" })])).toEqual({ code: "CONFIG_INVALID", message: "shares.0: no project called nope in your company" });
    expect(await run([share({ kind: "member", developerId: BOB }), share({ kind: "member", developerId: BOB }, "use")])).toEqual({ code: "CONFIG_INVALID", message: "shares.1: that person or group is already in the list" });
    expect(await run([{ principal: { kind: "org" }, level: "manage" }])).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^shares\.0\.level/) as string });
    expect(await run("nope")).toEqual({ code: "CONFIG_INVALID", message: "shares: must be a list" });
    expect(await ctx.chains.listShares(ORG_A, chain.chainId)).toEqual([]);
  });

  it("stores a merged duplicate's share under the survivor", async () => {
    const ctx = setup();
    ctx.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE, mergedInto: ALICE });
    const chain = await ctx.create("Investigate", { owner: { kind: "member", developerId: BOB }, by: BOB });
    await setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [share({ kind: "member", developerId: OLD_ALICE }, "use")], by: BOB });
    expect((await ctx.chains.listShares(ORG_A, chain.chainId)).map((entry) => entry.principal)).toEqual([{ kind: "member", developerId: ALICE }]);
  });

  it("answers CHAIN_REVISION_CONFLICT with the shares text when two saves race from one revision", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    const save = (developerId: string) => code(setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [share({ kind: "member", developerId })], by: ALICE }));
    const results = await Promise.all([save(BOB), save(CAROL)]);
    expect(results.filter((result) => result !== undefined)).toEqual([{ code: "CHAIN_REVISION_CONFLICT", message: "Someone else changed who this chain is shared with. Reload it and make your change again." }]);
    expect(await ctx.chains.listShares(ORG_A, chain.chainId)).toHaveLength(1);
  });

  it("changes at most 48 shares in one save", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    const principals = Array.from({ length: 49 }, (_unused, index) => ({ kind: "member" as const, developerId: index.toString(16).padStart(64, "0") }));
    expect(await code(ctx.chains.replaceShares({ orgId: ORG_A, chainId: chain.chainId, upsert: principals.map((principal) => ({ principal, level: "view" as const })), remove: [], expectedSharesRevision: 0, by: ALICE }))).toEqual({
      code: "CONFIG_INVALID", message: "shares: change at most 48 people or groups in one save",
    });
    expect(await ctx.chains.listShares(ORG_A, chain.chainId)).toEqual([]);
  });

  it("reports a stored share that is not valid when it saves the set, and writes the new set", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    ctx.db.set({ ...chainKey(ORG_A, chain.chainId, "SHARE#ORG"), entityType: "CHAIN_SHARE", principal: { kind: "everyone" }, level: "edit" });
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const deps = { ...ctx.deps, log: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }) };
    await setChainShares(deps, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "member", developerId: BOB }, level: "view" }], by: ALICE });
    expect(logged).toMatchObject([{ event: "chain_share_skipped", fields: { chainId: chain.chainId } }]);
  });

  it("leaves a share alone when it is asked to move it to the same person", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    const bob = { kind: "member", developerId: BOB } as const;
    await setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: bob, level: "use" }], by: ALICE });
    await ctx.chains.reassignShare({ orgId: ORG_A, chainId: chain.chainId, from: bob, to: bob, by: "system", cause: { kind: "member_merged", developerId: BOB } });
    expect((await ctx.chains.listShares(ORG_A, chain.chainId)).map((entry) => [entry.principal, entry.level])).toEqual([[bob, "use"]]);
    expect(ctx.db.get(principalChainSharesKey(ORG_A, bob, chain.chainId))).toMatchObject({ level: "use" });
  });

  it("refuses another org's chain as not found", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    expect(await code(setChainShares(ctx.deps, { orgId: ORG_B, chainId: chain.chainId, shares: [], by: STRANGER }))).toEqual({ code: "NOT_FOUND", message: "no chain has that ID" });
  });

  it("moves a share to the survivor after a merge, keeping the higher level (Rovara's own move)", async () => {
    const ctx = setup();
    const chain = await ctx.create("Investigate");
    const bob = { kind: "member", developerId: BOB } as const;
    const carol = { kind: "member", developerId: CAROL } as const;
    await setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [share(bob, "edit"), share(carol, "view")], by: ALICE });
    await ctx.chains.reassignShare({ orgId: ORG_A, chainId: chain.chainId, from: bob, to: carol, by: "system", cause: { kind: "member_merged", developerId: BOB } });
    expect((await ctx.chains.listShares(ORG_A, chain.chainId)).map((entry) => [entry.principal, entry.level])).toEqual([[carol, "edit"]]);
    expect(ctx.db.get(principalChainSharesKey(ORG_A, bob, chain.chainId))).toBeUndefined();
    expect(ctx.db.get(principalChainSharesKey(ORG_A, carol, chain.chainId))).toMatchObject({ level: "edit" });
    await ctx.chains.reassignShare({ orgId: ORG_A, chainId: chain.chainId, from: bob, by: "system", cause: { kind: "member_merged", developerId: BOB } });
  });
});

describe("chainAccess", () => {
  const level = async (ctx: ReturnType<typeof setup>, who: string, chain: ChainRecord, orgId: OrgId = ORG_A) => chainAccess(ctx.deps, caller(who, orgId), chain);
  const mine = (ctx: ReturnType<typeof setup>) => ctx.create("Mine");
  const webs = (ctx: ReturnType<typeof setup>) => ctx.create("Webs", { owner: WEB_OWNS, accountable: { developerId: BOB }, by: BOB });

  it("gives org owners and admins manage, the member owner manage, and nobody else anything", async () => {
    const ctx = setup();
    const chain = await mine(ctx);
    for (const who of [DAN, OWEN, ALICE]) expect(await level(ctx, who, chain)).toBe("manage");
    for (const who of [BOB, CAROL, ERIN, FRANK]) expect(await level(ctx, who, chain)).toBe("none");
  });

  it("matches the agent rules for a project's chain: maintainers manage, contributors use, viewers and outsiders nothing", async () => {
    const ctx = setup();
    const chain = await webs(ctx);
    expect(await level(ctx, BOB, chain)).toBe("manage");
    expect(await level(ctx, CAROL, chain)).toBe("use");
    expect(await level(ctx, ERIN, chain)).toBe("none");
    expect(await level(ctx, ALICE, chain)).toBe("none");
    expect(await level(ctx, FRANK, chain)).toBe("none");
    // The same caller holds the same level on an agent owned in the same way.
    const agent = await ctx.agents.create({ orgId: ORG_A, name: "Web agent", owner: WEB_OWNS, accountable: { developerId: BOB }, overlay: SCRATCH, createdBy: BOB });
    for (const who of [BOB, CAROL, ERIN, ALICE, FRANK, DAN]) expect(await level(ctx, who, chain), who).toBe(await agentAccess(ctx.agentDeps, caller(who), agent));
  });

  it("applies a share's level to the member it names, and an org-wide share to everyone", async () => {
    const ctx = setup();
    const chain = await mine(ctx);
    await setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "member", developerId: BOB }, level: "edit" }, { principal: { kind: "org" }, level: "view" }], by: ALICE });
    expect(await level(ctx, BOB, chain)).toBe("edit");
    expect(await level(ctx, CAROL, chain)).toBe("view");
    expect(await level(ctx, STRANGER, { ...chain }, ORG_B)).toBe("none");
  });

  it("gives a project share at use to that project's contributors, view to its viewers, and NOT_FOUND to everyone else", async () => {
    const ctx = setup();
    const chain = await mine(ctx);
    await setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "project", project: "web" }, level: "use" }], by: ALICE });
    expect(await level(ctx, CAROL, chain)).toBe("use");
    expect(await level(ctx, BOB, chain)).toBe("use");
    expect(await level(ctx, ERIN, chain)).toBe("view");
    expect(await level(ctx, FRANK, chain)).toBe("none");
    expect(await level(ctx, DAN, chain)).toBe("manage");
    await expect(requireChainAccess(ctx.deps, caller(CAROL), chain.chainId, "use")).resolves.toMatchObject({ access: "use" });
    for (const who of [FRANK, STRANGER]) {
      expect(await code(requireChainAccess(ctx.deps, caller(who, who === STRANGER ? ORG_B : ORG_A), chain.chainId, "view"))).toEqual({ code: "NOT_FOUND", message: "no chain has that ID" });
    }
  });

  it("caps an archived chain at view, even when shared at edit, except for those who manage it", async () => {
    const ctx = setup();
    const chain = await mine(ctx);
    await setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "member", developerId: BOB }, level: "edit" }], by: ALICE });
    expect(await level(ctx, BOB, chain)).toBe("edit");
    const archived = await ctx.chains.archive(ORG_A, chain.chainId, ALICE);
    expect(await level(ctx, BOB, archived)).toBe("view");
    expect(await level(ctx, ALICE, archived)).toBe("manage");
    expect(await level(ctx, DAN, archived)).toBe("manage");
    expect(await code(requireChainAccess(ctx.deps, caller(BOB), chain.chainId, "edit"))).toEqual({ code: "FORBIDDEN", message: "You can view Mine; edit needs its owner or an org admin to unarchive it." });
  });

  it("gives a chain of another org nothing, to an org admin too", async () => {
    const ctx = setup();
    const chain = await mine(ctx);
    expect(await chainAccess(ctx.deps, { orgId: ORG_B, developerId: DAN, orgRole: "admin" }, chain)).toBe("none");
  });

  it("requireChainAccess says what the caller can do and who could give more, in Plan 3's words", async () => {
    const ctx = setup();
    const chain = await mine(ctx);
    await setChainShares(ctx.deps, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "member", developerId: BOB }, level: "view" }], by: ALICE });
    expect(await code(requireChainAccess(ctx.deps, caller(BOB), chain.chainId, "edit"))).toEqual({ code: "FORBIDDEN", message: "You can view Mine; edit needs its owner or an org admin to give you edit access." });
    expect(await code(requireChainAccess(ctx.deps, caller(BOB), chain.chainId, "use"))).toEqual({ code: "FORBIDDEN", message: "You can view Mine; use needs its owner or an org admin to share it with you." });
    expect(await code(requireChainAccess(ctx.deps, caller(BOB), chain.chainId, "manage"))).toEqual({ code: "FORBIDDEN", message: "You can view Mine; manage needs its owner or an org admin." });
    const web = await webs(ctx);
    expect(await code(requireChainAccess(ctx.deps, caller(CAROL), web.chainId, "manage"))).toEqual({ code: "FORBIDDEN", message: "You can use Webs; manage needs a maintainer of web or an org admin." });
    await expect(requireChainAccess(ctx.deps, caller(ALICE), chain.chainId, "manage")).resolves.toMatchObject({ access: "manage", chain: { chainId: chain.chainId } });
    expect(await code(requireChainAccess(ctx.deps, caller(ALICE), "chn_zzzzzzzzzzzzzzzzzzzz", "view"))).toEqual({ code: "NOT_FOUND", message: "no chain has that ID" });
  });

  it("skips a stored share that is not a valid principal and level, and reports it", async () => {
    const ctx = setup();
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const chain = await mine(ctx);
    ctx.db.set({ ...chainKey(ORG_A, chain.chainId, "SHARE#ORG"), entityType: "CHAIN_SHARE", principal: { kind: "everyone" }, level: "edit" });
    const deps = { ...ctx.deps, log: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }) };
    expect(await chainAccess(deps, caller(BOB), chain)).toBe("none");
    expect(logged).toMatchObject([{ event: "chain_share_skipped", fields: { chainId: chain.chainId } }]);
  });
});

describe("listing and owner rules", () => {
  it("lists the chains a caller can see with the access they hold, by scope", async () => {
    const ctx = setup();
    const own = await ctx.create("Own");
    const shared = await ctx.create("Shared", { owner: { kind: "member", developerId: BOB }, by: BOB });
    await ctx.create("Web", { owner: WEB_OWNS, accountable: { developerId: BOB }, by: BOB });
    const hidden = await ctx.create("Hidden", { owner: { kind: "member", developerId: BOB }, by: BOB });
    await setChainShares(ctx.deps, { orgId: ORG_A, chainId: shared.chainId, shares: [{ principal: { kind: "member", developerId: ALICE }, level: "use" }], by: BOB });
    const names = async (who: string, scope: Parameters<typeof listVisibleChains>[2]) => (await listVisibleChains(ctx.deps, caller(who), scope)).map((entry) => `${entry.name}:${entry.access}`).sort();
    expect(await names(ALICE, "all")).toEqual(["Own:manage", "Shared:use"]);
    expect(await names(ALICE, "mine")).toEqual(["Own:manage"]);
    expect(await names(ALICE, "shared")).toEqual(["Shared:use"]);
    expect(await names(CAROL, "all")).toEqual(["Web:use"]);
    expect(await names(CAROL, { project: "web" })).toEqual(["Web:use"]);
    expect(await names(CAROL, { project: "api" })).toEqual([]);
    expect(await names(BOB, "mine")).toEqual(["Hidden:manage", "Shared:manage", "Web:manage"]);
    expect(await names(DAN, "all")).toEqual(["Hidden:manage", "Own:manage", "Shared:manage", "Web:manage"]);
    expect(await names(STRANGER, "all")).toEqual([]);
    expect([own.chainId, hidden.chainId]).toHaveLength(2);
  });

  it("keeps an owner's own chain out of \"shared\", and a project's list to chains of or shared with that project", async () => {
    const ctx = setup();
    const own = await ctx.create("Own");
    await ctx.create("Web", { owner: WEB_OWNS, accountable: { developerId: BOB }, by: BOB });
    await setChainShares(ctx.deps, { orgId: ORG_A, chainId: own.chainId, shares: [{ principal: { kind: "member", developerId: ALICE }, level: "edit" }, { principal: { kind: "project", project: "api" }, level: "view" }], by: ALICE });
    const names = async (who: string, scope: Parameters<typeof listVisibleChains>[2]) => (await listVisibleChains(ctx.deps, caller(who), scope)).map((entry) => entry.name).sort();
    // Alice owns "Own" and has a share of it: it is hers, not shared with her.
    expect(await names(ALICE, "shared")).toEqual([]);
    expect(await names(ALICE, "mine")).toEqual(["Own"]);
    // An admin sees everything, but a project's list is the chains that project owns or has been given.
    expect(await names(DAN, { project: "api" })).toEqual(["Own"]);
    expect(await names(DAN, { project: "web" })).toEqual(["Web"]);
    // Alice has no role on api, so there is nothing to show her there, though her chain is shared with it.
    expect(await names(ALICE, { project: "api" })).toEqual([]);
    expect(await names(FRANK, { project: "api" })).toEqual(["Own"]);
  });

  it("applies the agent owner rules to a chain's owner, in a chain's words", async () => {
    const ctx = setup();
    expect(await requireChainOwnerAllowed(ctx.deps, caller(ALICE), ALICE_OWNS)).toEqual(ALICE_OWNS);
    expect(await code(requireChainOwnerAllowed(ctx.deps, caller(ALICE), { kind: "member", developerId: BOB }))).toEqual({ code: "FORBIDDEN", message: "Only an org owner or admin can make someone else a chain's owner." });
    expect(await code(requireChainOwnerAllowed(ctx.deps, caller(ALICE), { kind: "member", developerId: BOB }, ALICE_OWNS))).toEqual({ code: "FORBIDDEN", message: "Only an org owner or admin can hand a chain to another member." });
    expect(await code(requireChainOwnerAllowed(ctx.deps, caller(CAROL), WEB_OWNS))).toEqual({ code: "FORBIDDEN", message: "Only a maintainer of web can make it a chain's owner." });
    expect(await requireChainOwnerAllowed(ctx.deps, caller(BOB), WEB_OWNS)).toEqual(WEB_OWNS);
    expect(await requireChainOwnerAllowed(ctx.deps, caller(DAN), { kind: "member", developerId: BOB })).toEqual({ kind: "member", developerId: BOB });
    expect(await code(requireChainOwnerAllowed(ctx.deps, caller(DAN), { kind: "member", developerId: STRANGER }))).toEqual({ code: "CONFIG_INVALID", message: "owner: nobody in your company has that ID" });
  });

  it("accepts as accountable only someone in the org who holds manage_agents on the project, named as their survivor", async () => {
    const ctx = setup();
    ctx.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE, mergedInto: BOB });
    expect(await requireChainAccountable(ctx.deps, ORG_A, "web", BOB)).toEqual({ developerId: BOB });
    expect(await requireChainAccountable(ctx.deps, ORG_A, "web", OLD_ALICE)).toEqual({ developerId: BOB });
    expect(await code(requireChainAccountable(ctx.deps, ORG_A, "web", CAROL))).toEqual({ code: "CONFIG_INVALID", message: "accountable: that person needs to be a maintainer of web" });
    expect(await code(requireChainAccountable(ctx.deps, ORG_A, "web", STRANGER))).toEqual({ code: "CONFIG_INVALID", message: "accountable: nobody in your company has that ID" });
  });
});
