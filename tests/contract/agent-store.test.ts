import { fixtureActor } from "../support/money-authority.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
// Plan 3 Task 6a: the agent store (records, name uniqueness, drafts, versions, pinned bases, events).
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { AgentStore, resolveAgent, updateAvailable, type BuiltinSource } from "../../packages/broker/src/agents/store.js";
import { agentXError } from "../../packages/contracts/src/errors.js";
import type { AgentId } from "../../packages/contracts/src/agent.js";
import type { AgentOwner } from "../../packages/contracts/src/agent-node.js";
import { BUILTIN_AGENTS, builtinDefaultPin, builtinRecipe, currentBuiltinVersion } from "../../packages/contracts/src/agent-templates.js";
import { recipeDigest, type RecipeOverlay } from "../../packages/contracts/src/agent-recipe-node.js";
import type { OrgId } from "../../packages/contracts/src/org-node.js";
import { agentKey, agentNameKey, builtinSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const START = Date.parse("2026-10-20T09:00:00.000Z");
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const MEMBER: AgentOwner = { kind: "member", developerId: ALICE };
const DIGEST = "d".repeat(64);

const STEP = { id: "work", name: "Work", kind: "agent", workspace: "none" } as const;
/** An overlay that makes a valid from-scratch recipe on its own: one agent step, with `text` as its instructions. */
const scratch = (text: string): RecipeOverlay => ({ instructions: text, sequence: [STEP] });
const layer = (text: string): RecipeOverlay => ({ instructions: text });

/** The shipped built-ins, plus one extra release of Ticket triage that tests switch on with `release.ticketTriage = 2`. */
function builtinsWithRelease(release: { ticketTriage: number }): BuiltinSource {
  return {
    currentVersion: (id) => (id === "ticket-triage" ? release.ticketTriage : currentBuiltinVersion(id as "rovara-code")),
    defaultPin: (id) => (id === "ticket-triage" ? release.ticketTriage : builtinDefaultPin(id as "rovara-code")),
    // Ticket triage here ships version 1 only (the store's rules are the same for any built-in), so that a test can add releases 2 and 3 by hand; the real version 2 is not offered.
    recipe: (id, version) => {
      if (id !== "ticket-triage" || version === 1) return builtinRecipe(id as "rovara-code", version);
      if (version > release.ticketTriage) throw agentXError("NOT_FOUND", `${id} has no version ${String(version)}`);
      const v1 = builtinRecipe("ticket-triage", 1);
      return { ...v1, chain: [{ ...v1.chain[0]!, version }], instructions: [{ agentName: "Ticket triage", text: `release ${String(version)}` }] };
    },
    name: (id) => BUILTIN_AGENTS[id as "rovara-code"].name,
  };
}

function setup() {
  const db = new FakeDynamoDb();
  const clock = { now: START };
  const release = { ticketTriage: 1 };
  let counter = 0;
  const store = new AgentStore({
    documentClient: db,
    tableName: "T",
    now: () => clock.now,
    newId: () => `agt_${String(++counter).padStart(20, "0")}`,
    builtins: builtinsWithRelease(release),
  });
  const events = (orgId: OrgId, agentId: AgentId) => db.find((item) => item.pk === agentKey(orgId, agentId, "META").pk && String(item.sk).startsWith("EVENT#")).sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
  const make = (name: string, overlay: RecipeOverlay, extra: { extends?: AgentId; orgId?: OrgId } = {}) =>
    store.create({ orgId: extra.orgId ?? ORG_A, name, owner: MEMBER, overlay, createdBy: ALICE, ...(extra.extends === undefined ? {} : { extends: extra.extends }) });
  /** Publishes the draft as it stands. */
  const publish = async (agentId: AgentId, orgId: OrgId = ORG_A) => {
    const agent = (await store.get(orgId, agentId))!;
    return store.publish({ orgId, agentId, expectedDraftRevision: agent.draftRevision, digest: DIGEST, by: ALICE });
  };
  return { db, clock, release, store, events, make, publish };
}

/** The refusal a promise ends in: its code and its message without the `CODE: ` prefix the error class adds. */
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const instructionsOf = (recipe: Awaited<ReturnType<typeof resolveAgent>>) => recipe.instructions.map((entry) => entry.text);

describe("AgentStore create and names", () => {
  it("creates an agent at draft revision 1 with no version, a directory item, a name item and one created event", async () => {
    const { db, store, events } = setup();
    const agent = await store.create({ orgId: ORG_A, name: "  Release notes ", description: "Writes them", owner: MEMBER, createdBy: ALICE });
    expect(await store.get(ORG_A, agent.agentId)).toEqual({
      orgId: ORG_A, agentId: agent.agentId, name: "Release notes", description: "Writes them", owner: MEMBER,
      latestVersion: 0, draftRevision: 1, status: "active", createdBy: ALICE, createdAt: "2026-10-20T09:00:00.000Z", updatedAt: "2026-10-20T09:00:00.000Z",
    });
    expect(await store.getDraft(ORG_A, agent.agentId)).toEqual({ overlay: {}, revision: 1, updatedBy: ALICE, updatedAt: "2026-10-20T09:00:00.000Z" });
    expect(db.get(agentNameKey(ORG_A, "release notes"))).toMatchObject({ agentId: agent.agentId });
    expect((await store.list(ORG_A)).map((entry) => entry.agentId)).toEqual([agent.agentId]);
    expect(events(ORG_A, agent.agentId).map((event) => event.kind)).toEqual(["created"]);
  });

  it("refuses the same name in other casing, accepts it in another org, and reserves the built-in names", async () => {
    const { db, store, make } = setup();
    await make("Release notes", scratch("a"));
    const before = db.items.size;
    const taken = await code(make("RELEASE NOTES", scratch("b")));
    expect(taken).toEqual({ code: "CONFIG_INVALID", message: "name: another agent in your company is called RELEASE NOTES" });
    expect(db.items.size).toBe(before);
    await expect(make("Release notes", scratch("a"), { orgId: ORG_B })).resolves.toMatchObject({ orgId: ORG_B });
    expect(await code(make("Ticket triage", scratch("c")))).toEqual({ code: "CONFIG_INVALID", message: "name: another agent in your company is called Ticket triage" });
    expect(await code(make("rovara CODE", scratch("c")))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await store.list(ORG_B)).toHaveLength(1);
  });

  it("lets only one of two concurrent creates have a name", async () => {
    const { store, make } = setup();
    const results = await Promise.all([code(make("Same", scratch("a"))), code(make("same", scratch("b")))]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
    expect(await store.list(ORG_A)).toHaveLength(1);
  });

  it("refuses a project-owned agent without an accountable maintainer, and an accountable on a member's agent", async () => {
    const { store } = setup();
    const project: AgentOwner = { kind: "project", project: "web" };
    expect(await code(store.create({ orgId: ORG_A, name: "P", owner: project, createdBy: ALICE }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("accountable") as string });
    expect(await code(store.create({ orgId: ORG_A, name: "M", owner: MEMBER, accountable: { developerId: BOB }, createdBy: ALICE }))).toMatchObject({ code: "CONFIG_INVALID" });
    const ok = await store.create({ orgId: ORG_A, name: "P", owner: project, accountable: { developerId: BOB }, createdBy: ALICE });
    expect(ok.accountable).toEqual({ developerId: BOB });
  });

  it("refuses an overlay the recipe schema refuses", async () => {
    const { store } = setup();
    const refused = await code(store.create({ orgId: ORG_A, name: "Bad", owner: MEMBER, overlay: { env: { A: "1" } } as unknown as RecipeOverlay, createdBy: ALICE }));
    expect(refused).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("does not return an agent from another org", async () => {
    const { store, make } = setup();
    const agent = await make("Mine", scratch("a"));
    expect(await store.get(ORG_B, agent.agentId)).toBeUndefined();
    expect(await store.list(ORG_B)).toEqual([]);
    expect(await code(store.saveDraft({ orgId: ORG_B, agentId: agent.agentId, overlay: {}, expectedRevision: 1, by: ALICE }))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("AgentStore drafts and profile", () => {
  it("saves a draft at the expected revision and refuses a stale one", async () => {
    const { store, make } = setup();
    const agent = await make("Drafty", scratch("one"));
    const saved = await store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch("two"), expectedRevision: 1, by: BOB });
    expect(saved).toMatchObject({ revision: 2, updatedBy: BOB, overlay: scratch("two") });
    expect((await store.get(ORG_A, agent.agentId))?.draftRevision).toBe(2);
    expect(await code(store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch("three"), expectedRevision: 1, by: ALICE }))).toEqual({
      code: "AGENT_REVISION_CONFLICT",
      message: "Someone else changed this agent's draft. Reload it and make your change again.",
    });
    expect((await store.getDraft(ORG_A, agent.agentId))?.overlay).toEqual(scratch("two"));
  });

  it("lets only one of two concurrent saves at the same revision win", async () => {
    const { store, make } = setup();
    const agent = await make("Race", scratch("one"));
    const save = (text: string) => code(store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch(text), expectedRevision: 1, by: ALICE }));
    const results = await Promise.all([save("a"), save("b")]);
    expect(results.filter((result) => result?.code === "AGENT_REVISION_CONFLICT")).toHaveLength(1);
    expect((await store.getDraft(ORG_A, agent.agentId))?.revision).toBe(2);
  });

  it("swaps the name item on a rename, frees the old name and refuses a taken one", async () => {
    const { db, store, make } = setup();
    const first = await make("First", scratch("a"));
    await make("Second", scratch("b"));
    const renamed = await store.updateProfile({ orgId: ORG_A, agentId: first.agentId, name: "Third", description: "new text", by: ALICE });
    expect(renamed).toMatchObject({ name: "Third", description: "new text" });
    expect(db.get(agentNameKey(ORG_A, "first"))).toBeUndefined();
    expect(db.get(agentNameKey(ORG_A, "third"))).toMatchObject({ agentId: first.agentId });
    await expect(make("First", scratch("c"))).resolves.toBeDefined();
    expect(await code(store.updateProfile({ orgId: ORG_A, agentId: first.agentId, name: "second", by: ALICE }))).toEqual({
      code: "CONFIG_INVALID", message: "name: another agent in your company is called second",
    });
    expect((await store.get(ORG_A, first.agentId))?.name).toBe("Third");
    expect(await code(store.updateProfile({ orgId: ORG_A, agentId: first.agentId, name: "Ticket TRIAGE", by: ALICE }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("allows a change of casing, which keeps the same name item", async () => {
    const { db, store, make } = setup();
    const agent = await make("quiet one", scratch("a"));
    await store.updateProfile({ orgId: ORG_A, agentId: agent.agentId, name: "Quiet One", by: ALICE });
    expect((await store.get(ORG_A, agent.agentId))?.name).toBe("Quiet One");
    expect(db.get(agentNameKey(ORG_A, "quiet one"))).toMatchObject({ agentId: agent.agentId });
  });
});

describe("AgentStore versions", () => {
  it("publishes numbered versions, keeps them immutable and rolls back", async () => {
    const { db, store, make, publish, events } = setup();
    const agent = await make("Versioned", scratch("v1 text"));
    const v1 = await publish(agent.agentId);
    expect(v1).toMatchObject({ version: 1, name: "Versioned", digest: DIGEST, publishedBy: ALICE });
    expect(await store.get(ORG_A, agent.agentId)).toMatchObject({ currentVersion: 1, latestVersion: 1 });
    await store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch("v2 text"), expectedRevision: 1, by: ALICE });
    await publish(agent.agentId);
    expect(await store.get(ORG_A, agent.agentId)).toMatchObject({ currentVersion: 2, latestVersion: 2 });
    expect((await store.listVersions(ORG_A, agent.agentId)).map((version) => version.version)).toEqual([1, 2]);

    await expect(db.send(new PutCommand({
      TableName: "T",
      Item: { ...agentKey(ORG_A, agent.agentId, "VERSION#000001"), overlay: {} },
      ConditionExpression: "attribute_not_exists(pk)",
    }))).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });

    await store.rollback({ orgId: ORG_A, agentId: agent.agentId, version: 1, expectedCurrentVersion: 2, by: BOB });
    expect(instructionsOf(await resolveAgent(store, ORG_A, agent.agentId, "current"))).toEqual(["v1 text"]);
    expect(instructionsOf(await resolveAgent(store, ORG_A, agent.agentId, 2))).toEqual(["v2 text"]);
    expect(instructionsOf(await resolveAgent(store, ORG_A, agent.agentId, "draft"))).toEqual(["v2 text"]);
    await store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch("v3 text"), expectedRevision: 2, by: ALICE });
    const v3 = await publish(agent.agentId);
    expect(v3.version).toBe(3);
    expect(await store.get(ORG_A, agent.agentId)).toMatchObject({ currentVersion: 3, latestVersion: 3 });
    expect(await code(store.rollback({ orgId: ORG_A, agentId: agent.agentId, version: 9, expectedCurrentVersion: 3, by: ALICE }))).toMatchObject({ code: "NOT_FOUND" });
    // An undo approved when version 2 was current does not apply once version 3 is.
    expect(await code(store.rollback({ orgId: ORG_A, agentId: agent.agentId, version: 1, expectedCurrentVersion: 2, by: ALICE }))).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect((await store.get(ORG_A, agent.agentId))?.currentVersion).toBe(3);
    expect(events(ORG_A, agent.agentId).map((event) => event.kind)).toEqual(["created", "published", "published", "rolled_back", "published"]);
  });

  it("refuses a publish at a stale draft revision, and an agent that does not exist", async () => {
    const { store, make } = setup();
    const agent = await make("Stale", scratch("a"));
    await store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch("b"), expectedRevision: 1, by: ALICE });
    expect(await code(store.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: 1, digest: DIGEST, by: ALICE }))).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect(await store.listVersions(ORG_A, agent.agentId)).toEqual([]);
    expect(await code(store.publish({ orgId: ORG_A, agentId: "agt_zzzzzzzzzzzzzzzzzzzz", expectedDraftRevision: 1, digest: DIGEST, by: ALICE }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(store.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: 2, digest: "nope", by: ALICE }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("gives two concurrent publishes one version 1 and one conflict", async () => {
    const { db, store, make } = setup();
    const agent = await make("Twice", scratch("a"));
    const publish = () => code(store.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: 1, digest: DIGEST, by: ALICE }));
    const results = await Promise.all([publish(), publish()]);
    expect(results.filter((result) => result?.code === "AGENT_REVISION_CONFLICT")).toHaveLength(1);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    expect(db.find((item) => item.pk === agentKey(ORG_A, agent.agentId, "META").pk && String(item.sk).startsWith("VERSION#"))).toHaveLength(1);
    expect(await store.get(ORG_A, agent.agentId)).toMatchObject({ currentVersion: 1, latestVersion: 1 });
  });

  it("keeps the name a version was published under when the agent is renamed later", async () => {
    const { store, make, publish } = setup();
    const agent = await make("Old name", scratch("text"));
    await publish(agent.agentId);
    await store.updateProfile({ orgId: ORG_A, agentId: agent.agentId, name: "New name", by: ALICE });
    expect((await resolveAgent(store, ORG_A, agent.agentId, "current")).chain.map((entry) => entry.name)).toEqual(["Old name"]);
    expect((await resolveAgent(store, ORG_A, agent.agentId, "draft")).chain.map((entry) => entry.name)).toEqual(["New name"]);
  });
});

describe("pinned bases", () => {
  it("keeps C on the version of B it pinned until updateBase and a publish move it", async () => {
    const { store, make, publish } = setup();
    const b = await make("B", scratch("B one"));
    await publish(b.agentId);
    const c = await make("C", layer("C text"), { extends: b.agentId });
    expect((await store.getDraft(ORG_A, c.agentId))?.extends).toEqual({ agentId: b.agentId, version: 1 });
    await publish(c.agentId);

    await store.saveDraft({ orgId: ORG_A, agentId: b.agentId, overlay: scratch("B two"), expectedRevision: 1, by: ALICE });
    await publish(b.agentId);
    expect(instructionsOf(await resolveAgent(store, ORG_A, b.agentId, "current"))).toEqual(["B two"]);
    expect(instructionsOf(await resolveAgent(store, ORG_A, c.agentId, "current"))).toEqual(["B one", "C text"]);
    expect(await updateAvailable(store, ORG_A, c.agentId)).toEqual({ from: 1, to: 2 });

    expect(await code(store.updateBase({ orgId: ORG_A, agentId: c.agentId, expectedRevision: 5, by: ALICE }))).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    const moved = await store.updateBase({ orgId: ORG_A, agentId: c.agentId, expectedRevision: 1, by: ALICE });
    expect(moved).toMatchObject({ revision: 2, extends: { agentId: b.agentId, version: 2 } });
    expect(await updateAvailable(store, ORG_A, c.agentId)).toBeUndefined();
    expect(instructionsOf(await resolveAgent(store, ORG_A, c.agentId, "current"))).toEqual(["B one", "C text"]);
    await publish(c.agentId);
    expect(instructionsOf(await resolveAgent(store, ORG_A, c.agentId, "current"))).toEqual(["B two", "C text"]);
    expect((await resolveAgent(store, ORG_A, c.agentId, "current")).chain).toMatchObject([
      { agentId: b.agentId, name: "B", version: 2, builtin: false },
      { agentId: c.agentId, name: "C", version: 2, builtin: false },
    ]);
  });

  it("refuses to build on an agent with no published version, an archived one or a missing one", async () => {
    const { store, make, publish } = setup();
    const draftOnly = await make("Draft only", scratch("a"));
    expect(await code(make("X", layer("x"), { extends: draftOnly.agentId }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("no published version") as string });
    await publish(draftOnly.agentId);
    await store.archive(ORG_A, draftOnly.agentId, ALICE);
    expect(await code(make("Y", layer("y"), { extends: draftOnly.agentId }))).toEqual({ code: "AGENT_UNAVAILABLE", message: "Draft only is archived, so it can't start new work." });
    expect(await code(make("Z", layer("z"), { extends: "agt_zzzzzzzzzzzzzzzzzzzz" }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("pins a built-in base to the org's version: a release changes nothing until the org adopts it", async () => {
    const { db, store, release, make, publish } = setup();
    const onTriage = await make("My triage", layer("mine"), { extends: "ticket-triage" });
    expect((await store.getDraft(ORG_A, onTriage.agentId))?.extends).toEqual({ agentId: "ticket-triage", version: 1 });
    expect(db.get(builtinSettingsKey(ORG_A, "ticket-triage"))).toMatchObject({ pinnedVersion: 1 });
    await publish(onTriage.agentId);

    release.ticketTriage = 2;
    expect(instructionsOf(await resolveAgent(store, ORG_A, onTriage.agentId, "current")).at(-1)).toBe("mine");
    expect((await resolveAgent(store, ORG_A, onTriage.agentId, "current")).chain[0]).toMatchObject({ agentId: "ticket-triage", version: 1, builtin: true });
    expect((await resolveAgent(store, ORG_A, "ticket-triage", "current")).chain[0]).toMatchObject({ version: 1 });
    // The release is not offered until the org adopts it: updateAvailable and updateBase agree.
    expect(await updateAvailable(store, ORG_A, onTriage.agentId)).toBeUndefined();
    expect(await store.updateBase({ orgId: ORG_A, agentId: onTriage.agentId, expectedRevision: 1, by: ALICE })).toMatchObject({ revision: 1, extends: { version: 1 } });

    expect(await code(store.adoptBuiltinVersion({ orgId: ORG_A, agentId: "ticket-triage", version: 3, expectedPinnedVersion: 1, by: ALICE }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(store.adoptBuiltinVersion({ orgId: ORG_A, agentId: onTriage.agentId, version: 1, expectedPinnedVersion: 1, by: ALICE }))).toMatchObject({ code: "CONFIG_INVALID" });
    await store.adoptBuiltinVersion({ orgId: ORG_A, agentId: "ticket-triage", version: 2, expectedPinnedVersion: 1, by: BOB });
    expect(await updateAvailable(store, ORG_A, onTriage.agentId)).toEqual({ from: 1, to: 2 });
    expect(instructionsOf(await resolveAgent(store, ORG_A, "ticket-triage", "current"))).toEqual(["release 2"]);
    expect(instructionsOf(await resolveAgent(store, ORG_A, onTriage.agentId, "current")).at(-1)).toBe("mine");
    expect((await resolveAgent(store, ORG_A, onTriage.agentId, "current")).chain[0]).toMatchObject({ version: 1 });

    await store.updateBase({ orgId: ORG_A, agentId: onTriage.agentId, expectedRevision: 1, by: ALICE });
    await publish(onTriage.agentId);
    expect((await resolveAgent(store, ORG_A, onTriage.agentId, "current")).chain[0]).toMatchObject({ version: 2 });
    // Another org that first uses the built-in after the release is pinned to it then.
    expect(await store.getBuiltinSettings(ORG_B, "ticket-triage")).toBeUndefined();
    expect((await resolveAgent(store, ORG_B, "ticket-triage", "current")).chain[0]).toMatchObject({ version: 2 });
    expect(await store.getBuiltinSettings(ORG_B, "ticket-triage")).toMatchObject({ pinnedVersion: 2 });
  });

  it("pins an org to the release of its first use, so a later release needs an adopt", async () => {
    const { db, store, release } = setup();
    expect(db.get(builtinSettingsKey(ORG_A, "ticket-triage"))).toBeUndefined();
    expect((await resolveAgent(store, ORG_A, "ticket-triage", "current")).chain[0]).toMatchObject({ version: 1 });
    expect(db.get(builtinSettingsKey(ORG_A, "ticket-triage"))).toMatchObject({ pinnedVersion: 1 });
    release.ticketTriage = 2;
    expect((await resolveAgent(store, ORG_A, "ticket-triage", "current")).chain[0]).toMatchObject({ version: 1 });
    expect((await resolveAgent(store, ORG_A, "ticket-triage", "draft")).chain[0]).toMatchObject({ version: 1 });
    await store.adoptBuiltinVersion({ orgId: ORG_A, agentId: "ticket-triage", version: 2, expectedPinnedVersion: 1, by: ALICE });
    expect((await resolveAgent(store, ORG_A, "ticket-triage", "current")).chain[0]).toMatchObject({ version: 2 });
    // Two first reads at once agree on one pin.
    const both = await Promise.all([resolveAgent(store, ORG_B, "ticket-triage", "current"), resolveAgent(store, ORG_B, "ticket-triage", "current")]);
    expect(both.map((recipe) => recipe.chain[0]?.version)).toEqual([2, 2]);
  });

  it("applies an adopt only while the pin is the one it was approved against", async () => {
    const { store, release } = setup();
    await store.ensureBuiltinSettings(ORG_A, "ticket-triage");
    release.ticketTriage = 3;
    await store.adoptBuiltinVersion({ orgId: ORG_A, agentId: "ticket-triage", version: 2, expectedPinnedVersion: 1, by: ALICE });
    const stale = await code(store.adoptBuiltinVersion({ orgId: ORG_A, agentId: "ticket-triage", version: 3, expectedPinnedVersion: 1, by: BOB }));
    expect(stale).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect((await store.getBuiltinSettings(ORG_A, "ticket-triage"))?.pinnedVersion).toBe(2);
    await store.adoptBuiltinVersion({ orgId: ORG_A, agentId: "ticket-triage", version: 3, expectedPinnedVersion: 2, by: BOB });
    expect((await store.getBuiltinSettings(ORG_A, "ticket-triage"))?.pinnedVersion).toBe(3);
  });

  it("builds on Rovara Code with the shipped built-ins", async () => {
    const real = new AgentStore({ documentClient: new FakeDynamoDb(), tableName: "T", now: () => START });
    const agent = await real.create({ orgId: ORG_A, name: "Careful coder", owner: MEMBER, extends: "rovara-code", overlay: layer("be careful"), createdBy: ALICE });
    expect((await real.getDraft(ORG_A, agent.agentId))?.extends).toEqual({ agentId: "rovara-code", version: builtinDefaultPin("rovara-code") });
    const recipe = await resolveAgent(real, ORG_A, agent.agentId, "draft");
    expect(recipe.chain.map((entry) => entry.builtin)).toEqual([true, false]);
    expect(recipe.steps.map((step) => step.kind)).toEqual(["plan", "build", "check", "review", "pull_request"]);
    expect(recipeDigest(recipe)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("layers, cycles, archived bases and problems", () => {
  async function chainOf(length: number) {
    const ctx = setup();
    const agents: AgentId[] = [];
    let previous: AgentId | undefined;
    for (let index = 0; index < length; index += 1) {
      const agent = await ctx.make(`L${String(index)}`, index === 0 ? scratch("L0") : layer(`L${String(index)}`), previous === undefined ? {} : { extends: previous });
      await ctx.publish(agent.agentId);
      agents.push(agent.agentId);
      previous = agent.agentId;
    }
    return { ...ctx, agents };
  }

  it("resolves 3 custom layers (4 with a built-in under them) and refuses a 4th custom layer", async () => {
    const three = await chainOf(3);
    expect(instructionsOf(await resolveAgent(three.store, ORG_A, three.agents[2]!, "current"))).toEqual(["L0", "L1", "L2"]);
    const fourth = await three.make("L3", layer("L3"), { extends: three.agents[2]! });
    await three.publish(fourth.agentId);
    const refused = { code: "CONFIG_INVALID", message: "agents can build on at most 3 layers" };
    expect(await code(resolveAgent(three.store, ORG_A, fourth.agentId, "current"))).toEqual(refused);
    expect(await code(resolveAgent(three.store, ORG_A, fourth.agentId, "draft"))).toEqual(refused);

    const { make, publish, store } = setup();
    let base: AgentId = "rovara-code";
    const ids: AgentId[] = [];
    for (let index = 0; index < 3; index += 1) {
      const agent = await make(`B${String(index)}`, layer(`B${String(index)}`), { extends: base });
      await publish(agent.agentId);
      ids.push(agent.agentId);
      base = agent.agentId;
    }
    expect((await resolveAgent(store, ORG_A, ids[2]!, "current")).chain).toHaveLength(4);
    const fifth = await make("B3", layer("B3"), { extends: base });
    await publish(fifth.agentId);
    expect(await code(resolveAgent(store, ORG_A, fifth.agentId, "current"))).toEqual(refused);
  });

  it("refuses a loop of bases", async () => {
    const { store, make, publish } = setup();
    const a = await make("A", scratch("A one"));
    await publish(a.agentId);
    const b = await make("B", layer("B one"), { extends: a.agentId });
    await publish(b.agentId);
    await store.saveDraft({ orgId: ORG_A, agentId: a.agentId, overlay: scratch("A two"), extends: b.agentId, expectedRevision: 1, by: ALICE });
    await publish(a.agentId);
    expect(await code(resolveAgent(store, ORG_A, a.agentId, "current"))).toEqual({ code: "CONFIG_INVALID", message: "agents can't build on each other in a loop" });
    expect(instructionsOf(await resolveAgent(store, ORG_A, a.agentId, 1))).toEqual(["A one"]);
    expect(await code(store.saveDraft({ orgId: ORG_A, agentId: a.agentId, overlay: {}, extends: a.agentId, expectedRevision: 2, by: ALICE }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("changes or clears a draft's base through saveDraft and keeps the pin when the base is unchanged", async () => {
    const { store, make, publish } = setup();
    const b = await make("B", scratch("B one"));
    await publish(b.agentId);
    const c = await make("C", layer("C"), { extends: b.agentId });
    await store.saveDraft({ orgId: ORG_A, agentId: b.agentId, overlay: scratch("B two"), expectedRevision: 1, by: ALICE });
    await publish(b.agentId);
    const same = await store.saveDraft({ orgId: ORG_A, agentId: c.agentId, overlay: layer("C again"), extends: b.agentId, expectedRevision: 1, by: ALICE });
    expect(same.extends).toEqual({ agentId: b.agentId, version: 1 });
    const none = await store.saveDraft({ orgId: ORG_A, agentId: c.agentId, overlay: scratch("C alone"), extends: null, expectedRevision: 2, by: ALICE });
    expect(none.extends).toBeUndefined();
    expect((await store.getDraft(ORG_A, c.agentId))?.extends).toBeUndefined();
    const repinned = await store.saveDraft({ orgId: ORG_A, agentId: c.agentId, overlay: layer("C again"), extends: b.agentId, expectedRevision: 3, by: ALICE });
    expect(repinned.extends).toEqual({ agentId: b.agentId, version: 2 });
  });

  it("says which base is archived and offers the way out, and resolves again once it is back", async () => {
    const { store, make, publish } = setup();
    const b = await make("B", scratch("B"));
    await publish(b.agentId);
    const c = await make("C", layer("C"), { extends: b.agentId });
    await publish(c.agentId);
    await store.archive(ORG_A, b.agentId, ALICE);
    const expected = { code: "AGENT_UNAVAILABLE", message: "C builds on B, which is archived. Ask C's owner to pick another base." };
    expect(await code(resolveAgent(store, ORG_A, c.agentId, "current"))).toEqual(expected);
    expect(await code(resolveAgent(store, ORG_A, c.agentId, "draft"))).toEqual(expected);
    expect(await code(store.updateBase({ orgId: ORG_A, agentId: c.agentId, expectedRevision: 1, by: ALICE }))).toEqual(expected);
    // The archived agent itself still resolves; the check is on bases.
    expect(instructionsOf(await resolveAgent(store, ORG_A, b.agentId, "current"))).toEqual(["B"]);
    await store.unarchive(ORG_A, b.agentId, ALICE);
    expect(instructionsOf(await resolveAgent(store, ORG_A, c.agentId, "current"))).toEqual(["B", "C"]);
  });

  it("answers NOT_FOUND for a missing agent, version or base", async () => {
    const { db, store, make, publish } = setup();
    expect(await code(resolveAgent(store, ORG_A, "agt_zzzzzzzzzzzzzzzzzzzz", "current"))).toMatchObject({ code: "NOT_FOUND" });
    const b = await make("B", scratch("B"));
    expect(await code(resolveAgent(store, ORG_A, b.agentId, "current"))).toMatchObject({ code: "NOT_FOUND", message: "B has no published version" });
    await publish(b.agentId);
    expect(await code(resolveAgent(store, ORG_A, b.agentId, 7))).toMatchObject({ code: "NOT_FOUND", message: "B has no version 7" });
    expect(await code(resolveAgent(store, ORG_B, b.agentId, "current"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(resolveAgent(store, ORG_A, "ticket-triage", 9))).toMatchObject({ code: "NOT_FOUND" });
    const c = await make("C", layer("C"), { extends: b.agentId });
    await publish(c.agentId);
    db.delete(agentKey(ORG_A, b.agentId, "META"));
    expect(await code(resolveAgent(store, ORG_A, c.agentId, "current"))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a layer that patches a step no step has, and a resolved recipe with problems", async () => {
    const { store, make, publish } = setup();
    const base = await make("Base", scratch("base"));
    await publish(base.agentId);
    const patch = await make("Patch", { steps: { nope: { instructions: "x" } } }, { extends: base.agentId });
    expect(await code(resolveAgent(store, ORG_A, patch.agentId, "draft"))).toEqual({ code: "CONFIG_INVALID", message: "steps.nope: no step has that id" });
    const empty = await make("Empty", layer("no steps at all"));
    expect(await code(resolveAgent(store, ORG_A, empty.agentId, "draft"))).toEqual({ code: "CONFIG_INVALID", message: "steps: a recipe needs at least one step" });
    const bash = await make("Bash agent", { sequence: [{ ...STEP, settings: { tools: ["bash"] } }] });
    expect(await code(resolveAgent(store, ORG_A, bash.agentId, "draft"))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses a draft that names a skill the org does not have, resolves one it has, and lets a skill resolver replace the registry (Task 9)", async () => {
    const { store, make } = setup();
    expect(await code(make("Skilled", { ...scratch("a"), skills: { add: [{ skillId: "skl_aaaaaaaaaaaaaaaaaaaa" }] } }))).toEqual({ code: "CONFIG_INVALID", message: "skills: unknown skill" });
    const skill = await store.skills.create({ orgId: ORG_A, content: "---\nname: triage-notes\ndescription: Notes\n---\nBody\n", owner: MEMBER, by: ALICE });
    const agent = await make("Skilled", { ...scratch("a"), skills: { add: [{ skillId: skill.skillId }] } });
    expect((await resolveAgent(store, ORG_A, agent.agentId, "draft")).skills.map((entry) => entry.name)).toEqual(["triage-notes"]);
    const replaced = await resolveAgent(store, ORG_A, agent.agentId, "draft", {
      resolveSkill: async (ref) => ({ skillId: ref.skillId, name: "other-name", description: "Notes", digest: "e".repeat(64) }),
    });
    expect(replaced.skills.map((entry) => entry.name)).toEqual(["other-name"]);
  });
});

describe("archive, budget, owner, accountable and events", () => {
  it("leaves exactly one event per write, in order", async () => {
    const { store, make, publish, release, events, db } = setup();
    const b = await make("B", scratch("B"));
    await publish(b.agentId);
    const project: AgentOwner = { kind: "project", project: "web" };
    const c = await store.create({ orgId: ORG_A, name: "C", owner: project, accountable: { developerId: ALICE }, extends: b.agentId, overlay: layer("C"), createdBy: ALICE });
    await store.archive(ORG_A, c.agentId, ALICE);
    await store.archive(ORG_A, c.agentId, ALICE); // already archived: no write, no event
    await store.unarchive(ORG_A, c.agentId, BOB);
    await store.setBudget(ORG_A, c.agentId, { monthlyUsd: 30, maxPerRunUsd: 5 }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) });
    await store.setAccountable(ORG_A, c.agentId, { developerId: BOB }, ALICE, undefined, { actor: fixtureActor(store, ORG_A, ALICE) });
    await store.setOwner(ORG_A, c.agentId, MEMBER, ALICE, undefined, undefined, { actor: fixtureActor(store, ORG_A, ALICE) });
    await store.saveDraft({ orgId: ORG_A, agentId: b.agentId, overlay: scratch("B2"), expectedRevision: 1, by: ALICE });
    await publish(b.agentId);
    await store.updateBase({ orgId: ORG_A, agentId: c.agentId, expectedRevision: 1, by: ALICE });
    await store.ensureBuiltinSettings(ORG_A, "ticket-triage");
    release.ticketTriage = 2;
    await store.adoptBuiltinVersion({ orgId: ORG_A, agentId: "ticket-triage", version: 2, expectedPinnedVersion: 1, by: ALICE });
    await store.setBudget(ORG_A, "ticket-triage", { monthlyUsd: 10 }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) });

    expect(events(ORG_A, c.agentId).map((event) => event.kind)).toEqual(["created", "archived", "unarchived", "budget_changed", "owner_changed", "owner_changed", "base_updated"]);
    expect(events(ORG_A, b.agentId).map((event) => event.kind)).toEqual(["created", "published", "published"]);
    expect(events(ORG_A, "ticket-triage").map((event) => event.kind)).toEqual(["base_updated", "budget_changed"]);
    const [created] = events(ORG_A, c.agentId);
    expect(created).toMatchObject({ kind: "created", by: ALICE, at: "2026-10-20T09:00:00.000Z" });
    expect(db.find((item) => typeof item.sk === "string" && item.sk.startsWith("EVENT#") && item.pk === agentKey(ORG_B, c.agentId, "META").pk)).toEqual([]);
  });

  it("writes nothing when a write is refused", async () => {
    const { db, store, make, publish } = setup();
    const agent = await make("Stable", scratch("a"));
    const before = [...db.items.keys()].sort();
    await code(store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch("b"), expectedRevision: 9, by: ALICE }));
    await code(store.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: 9, digest: DIGEST, by: ALICE }));
    await code(store.rollback({ orgId: ORG_A, agentId: agent.agentId, version: 1, expectedCurrentVersion: 1, by: ALICE }));
    expect([...db.items.keys()].sort()).toEqual(before);
    await publish(agent.agentId);
  });

  it("sets and clears budgets, on an agent's META or a built-in's org settings", async () => {
    const { db, store, make } = setup();
    const agent = await make("Budgeted", scratch("a"));
    await store.setBudget(ORG_A, agent.agentId, { monthlyUsd: 25, maxPerRunUsd: 4 }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) });
    expect(await store.get(ORG_A, agent.agentId)).toMatchObject({ monthlyBudgetUsd: 25, maxPerRunUsd: 4 });
    await store.setBudget(ORG_A, agent.agentId, { maxPerRunUsd: null }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) });
    const after = (await store.get(ORG_A, agent.agentId))!;
    expect(after.monthlyBudgetUsd).toBe(25);
    expect(after).not.toHaveProperty("maxPerRunUsd");
    expect(await code(store.setBudget(ORG_A, agent.agentId, { monthlyUsd: -1 }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) }))).toMatchObject({ code: "CONFIG_INVALID" });

    await store.setBudget(ORG_A, "code-reviewer", { monthlyUsd: 12 }, fixtureActor(store, ORG_A, BOB).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, BOB) });
    expect(db.get(builtinSettingsKey(ORG_A, "code-reviewer"))).toMatchObject({ pinnedVersion: currentBuiltinVersion("code-reviewer"), monthlyBudgetUsd: 12, updatedBy: BOB });
    await store.setAccountable(ORG_A, "code-reviewer", { developerId: BOB }, fixtureActor(store, ORG_A, ALICE, true).developerId, undefined, { actor: fixtureActor(store, ORG_A, ALICE, true) });
    expect((await store.getBuiltinSettings(ORG_A, "code-reviewer"))?.accountable).toEqual({ developerId: BOB });
  });

  it("changes the owner and the accountable maintainer under their rules", async () => {
    const { store, make } = setup();
    const member = await make("Mine", scratch("a"));
    expect(await code(store.setAccountable(ORG_A, member.agentId, { developerId: BOB }, ALICE, undefined, { actor: fixtureActor(store, ORG_A, ALICE) }))).toMatchObject({ code: "CONFIG_INVALID" });
    const project: AgentOwner = { kind: "project", project: "web" };
    expect(await code(store.setOwner(ORG_A, member.agentId, project, ALICE, undefined, undefined, { actor: fixtureActor(store, ORG_A, ALICE) }))).toMatchObject({ code: "CONFIG_INVALID" });
    const moved = await store.setOwner(ORG_A, member.agentId, project, ALICE, { developerId: BOB }, undefined, { actor: fixtureActor(store, ORG_A, ALICE) });
    expect(moved).toMatchObject({ owner: project, accountable: { developerId: BOB } });
    await store.setAccountable(ORG_A, member.agentId, { developerId: ALICE }, BOB, undefined, { actor: fixtureActor(store, ORG_A, BOB) });
    expect((await store.get(ORG_A, member.agentId))?.accountable).toEqual({ developerId: ALICE });
    const back = await store.setOwner(ORG_A, member.agentId, { kind: "member", developerId: BOB }, ALICE, undefined, undefined, { actor: fixtureActor(store, ORG_A, ALICE) });
    expect(back).not.toHaveProperty("accountable");
    expect(await store.get(ORG_A, member.agentId)).not.toHaveProperty("accountable");
    expect(await code(store.setOwner(ORG_A, "rovara-code", MEMBER, ALICE, undefined, undefined, { actor: fixtureActor(store, ORG_A, ALICE) }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(store.archive(ORG_A, "rovara-code", ALICE))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("lists an org's agents and not another's", async () => {
    const { store, make } = setup();
    const a = await make("One", scratch("a"));
    const b = await make("Two", scratch("b"));
    await make("Other org", scratch("c"), { orgId: ORG_B });
    expect((await store.list(ORG_A)).map((agent) => agent.agentId).sort()).toEqual([a.agentId, b.agentId].sort());
    expect(await store.list(ORG_B)).toHaveLength(1);
  });
});

describe("AgentStore request marks and the publish baseline (review fix round 1)", () => {
  const mark = (requestId: string, fingerprint = "f".repeat(64)) => ({ orgId: ORG_A, developerId: ALICE, requestId, fingerprint });

  it("writes the request item in the same transaction as the write, and not when the write is refused", async () => {
    const { store, make } = setup();
    const agent = await make("Marked", scratch("x"));
    const first = await store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch("y"), expectedRevision: 1, by: ALICE, request: mark("r1") });
    expect(await store.getRequest(ORG_A, ALICE, "r1")).toMatchObject({ fingerprint: "f".repeat(64), result: { revision: 2 } });
    expect(first.revision).toBe(2);
    await expect(store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch("z"), expectedRevision: 1, by: ALICE, request: mark("r2") })).rejects.toThrow(/AGENT_REVISION_CONFLICT/);
    expect(await store.getRequest(ORG_A, ALICE, "r2")).toBeUndefined();
    // Another person's, or another org's, same request id is its own.
    expect(await store.getRequest(ORG_A, BOB, "r1")).toBeUndefined();
    expect(await store.getRequest(ORG_B, ALICE, "r1")).toBeUndefined();
  });

  it("refuses a second write under the same request id as already in progress", async () => {
    const { store, make } = setup();
    const agent = await make("Marked", scratch("x"));
    await store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch("y"), expectedRevision: 1, by: ALICE, request: mark("r1") });
    await expect(store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch("z"), expectedRevision: 2, by: ALICE, request: mark("r1") })).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it("publishes only while the current version is still the one compared against", async () => {
    const { store, make, publish } = setup();
    const agent = await make("Baseline", scratch("x"));
    await publish(agent.agentId);
    const draft = (await store.getDraft(ORG_A, agent.agentId))!;
    await publish(agent.agentId);
    await expect(store.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: draft.revision, digest: DIGEST, by: ALICE, expectedCurrentVersion: 1 })).rejects.toThrow(/AGENT_REVISION_CONFLICT/);
    await expect(store.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: draft.revision, digest: DIGEST, by: ALICE, expectedCurrentVersion: null })).rejects.toThrow(/AGENT_REVISION_CONFLICT/);
    expect((await store.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: draft.revision, digest: DIGEST, by: ALICE, expectedCurrentVersion: 2 })).version).toBe(3);
    const fresh = await make("First", scratch("x"));
    const first = (await store.get(ORG_A, fresh.agentId))!;
    expect((await store.publish({ orgId: ORG_A, agentId: fresh.agentId, expectedDraftRevision: first.draftRevision, digest: DIGEST, by: ALICE, expectedCurrentVersion: null })).version).toBe(1);
  });

  it("gives the request item an expiry on the State table's TTL attribute, and treats an expired one as no request", async () => {
    const { store, make, clock, db } = setup();
    const agent = await make("Expiring", scratch("x"));
    await store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch("y"), expectedRevision: 1, by: ALICE, request: mark("r1") });
    const item = db.find((entry) => entry.entityType === "AGENT_REQUEST")[0]!;
    expect(item["indexExpiresAt"]).toBe(Math.floor(START / 1000) + 7 * 86_400);
    clock.now = START + 6 * 86_400_000;
    expect(await store.getRequest(ORG_A, ALICE, "r1")).toBeDefined();
    clock.now = START + 8 * 86_400_000;
    // A replay after expiry is a new request: it is not answered from the old item, and it can write its own.
    expect(await store.getRequest(ORG_A, ALICE, "r1")).toBeUndefined();
    await store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: scratch("z"), expectedRevision: 2, by: ALICE, request: mark("r1", "e".repeat(64)) });
    expect(await store.getRequest(ORG_A, ALICE, "r1")).toMatchObject({ fingerprint: "e".repeat(64), result: { revision: 3 } });
  });
});


describe("G1 legacy agent per-run precision compatibility", () => {
  for (const maxPerRunUsd of [0.0000001, 0.1 + 0.2, 1.0000001, 1_000_000.000001, NaN, Infinity, -1, "1"] as const) {
    it("refuses invalid incoming per-run precision before builtin initialization or events", async () => {
      const { db, store } = setup();
      const before = db.transactions().length;
      const result = await code(store.setBudget(ORG_A, "code-reviewer", { maxPerRunUsd: maxPerRunUsd as number }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) }));
      expect(result).toMatchObject({ code: "CONFIG_INVALID" });
      expect(db.get(builtinSettingsKey(ORG_A, "code-reviewer"))).toBeUndefined();
      expect(db.transactions().length).toBe(before);
    });
  }
  it("retains exact representable numbers, explicit zero, null and omitted legacy semantics", async () => {
    const { db, store, make } = setup(); const agent = await make("Exact money", scratch("a"));
    for (const value of [0, .000001, 17.000001, 1_000_000]) {
      await store.setBudget(ORG_A, agent.agentId, { maxPerRunUsd: value }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) });
      expect(db.get(agentKey(ORG_A, agent.agentId, "META"))?.maxPerRunUsd).toBe(value);
    }
    await store.setBudget(ORG_A, agent.agentId, { monthlyUsd: 12 }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) });
    expect(db.get(agentKey(ORG_A, agent.agentId, "META"))?.maxPerRunUsd).toBe(1_000_000);
    await store.setBudget(ORG_A, agent.agentId, { maxPerRunUsd: null }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) });
    expect(Object.hasOwn(db.get(agentKey(ORG_A, agent.agentId, "META"))!, "maxPerRunUsd")).toBe(false);
  });
  it("leaves historical sub-micro intent unchanged on an omitted patch and allows explicit correction", async () => {
    const { db, store, make } = setup(); const agent = await make("Historical money", scratch("a")); const key = agentKey(ORG_A, agent.agentId, "META");
    db.set({ ...db.get(key), maxPerRunUsd: .0000001 });
    expect((await store.get(ORG_A, agent.agentId))?.maxPerRunUsd).toBe(.0000001);
    await store.setBudget(ORG_A, agent.agentId, { monthlyUsd: 12 }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) });
    expect(db.get(key)?.maxPerRunUsd).toBe(.0000001);
    await store.setBudget(ORG_A, agent.agentId, { maxPerRunUsd: .000001 }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) });
    expect(db.get(key)?.maxPerRunUsd).toBe(.000001);
  });
});


for (const builtin of [false, true]) for (const initial of [undefined, 0, 1]) it(`fences a real concurrent per-run write and its audit on ${builtin ? "builtin" : "custom"} settings from ${String(initial)}`, async () => {
  const f = setup(); const agentId = builtin ? "code-reviewer" : (await f.make("Racing money", scratch("a"))).agentId;
  const capture = capturingAuditDeps({ db: f.db });
  const store = new AgentStore({ documentClient: f.db, tableName: "state", now: () => START, audit: capture.audit });
  await store.setBudget(ORG_A, agentId, { maxPerRunUsd: initial ?? null }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) });
  const before = capture.recorded().length, key = builtin ? builtinSettingsKey(ORG_A, "code-reviewer") : agentKey(ORG_A, agentId, "META");
  const send = f.db.send.bind(f.db); let raced = false;
  f.db.send = async command => {
    const input = command.input as { TransactItems?: Array<{ Update?: { Key?: { pk?: string; sk?: string } } }> };
    if (!raced && input.TransactItems?.some(item => item.Update?.Key?.pk === key.pk && item.Update.Key.sk === key.sk)) {
      raced = true; await store.setBudget(ORG_A, agentId, { maxPerRunUsd: 3 }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) });
    }
    return send(command);
  };
  expect(await code(store.setBudget(ORG_A, agentId, { maxPerRunUsd: 2 }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) }))).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
  expect(raced).toBe(true); expect(f.db.get(key)?.maxPerRunUsd).toBe(3);
  expect(capture.recorded().length).toBe(before + 1); expect(capture.pending()).toHaveLength(0);
});

it("conditionally creates a first builtin budget without overwriting a competing first writer", async () => {
  const f = setup(), key = builtinSettingsKey(ORG_A, "code-reviewer"), capture = capturingAuditDeps({ db: f.db });
  const store = new AgentStore({ documentClient: f.db, tableName: "state", now: () => START, audit: capture.audit });
  const send = f.db.send.bind(f.db); let raced = false;
  f.db.send = async command => {
    const input = command.input as { TransactItems?: Array<{ Put?: { Item?: { pk?: string; sk?: string } } }> };
    if (!raced && input.TransactItems?.some(item => item.Put?.Item?.pk === key.pk && item.Put.Item.sk === key.sk)) {
      raced = true; await store.setBudget(ORG_A, "code-reviewer", { maxPerRunUsd: 3 }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) });
    }
    return send(command);
  };
  expect(await code(store.setBudget(ORG_A, "code-reviewer", { maxPerRunUsd: 2 }, fixtureActor(store, ORG_A, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, ALICE) }))).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
  expect(raced).toBe(true); expect(f.db.get(key)?.maxPerRunUsd).toBe(3);
  expect(capture.recorded()).toHaveLength(1); expect(capture.pending()).toHaveLength(0);
});
