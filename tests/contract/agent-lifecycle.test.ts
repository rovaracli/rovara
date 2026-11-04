import { orgMetaKey } from "@agentx/contracts";
import { fixtureActor } from "../support/money-authority.js";
// Plan 3 Task 11: what happens to agents when a member is merged into another, a member is removed, or a project is archived. The sign-in
// function only leaves a marker in the `MEMBER_MERGE_QUEUE` partition; the broker's 5-minute sweep drains it and moves what the duplicate
// owned. A removal moves what the person owned at once, and leaves the same kind of marker until it has.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MEMBER_MERGE_QUEUE_PK, MEMBER_REMOVAL_QUEUE_PK, agentKey, developerOrgKey, memberMergeQueueKey, memberRemovalQueueKey, orgMemberKey, orgProjectCatalogKey, principalSharesKey, projectMetaKey, skillKey, type AgentId, type OrgId, type OrgRole, type RecipeOverlay,
} from "@agentx/contracts";
import { agentAccess, followMerges, type AgentAccessDeps, type AgentCaller } from "../../packages/broker/src/agents/access.js";
import {
  drainMemberMerges, drainMemberRemovals, memberRemovalHook, onMemberRemoved, onMembersMerged, onProjectArchived, onProjectMemberChanged, registerMemberMover, resolveMember, runMemberMergeDrain, sameMember, type LifecycleDeps, type MemberMover,
} from "../../packages/broker/src/agents/lifecycle.js";
import { checkRosterChange } from "../../packages/broker/src/agents/roster.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { readOwnerTotal } from "../../packages/broker/src/spend/settings.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { mergeDuplicateMember } from "../../packages/broker/src/org/merge-members.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps, type AuditCapture } from "../support/audit-capture.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";

const T0 = Date.parse("2026-10-22T09:00:00.000Z");
const GITHUB_ISSUER = "https://github.com";
const OIDC_ISSUER = "https://idp.example.test";
const D1 = ownerKeyForSubject(OIDC_ISSUER, "priya-cloud-1");
const D2 = ownerKeyForSubject(GITHUB_ISSUER, "4711");
const EMAIL = "priya@acme.dev";

const developerRecord = (developerId: string, provider: "cloud" | "github", issuer: string, subject: string) =>
  ({ pk: `DEVELOPER#${developerId}`, sk: "META", entityType: "DEVELOPER", developerId, provider, issuer, subject, displayName: "Priya", email: EMAIL, firstSignInAt: "2026-09-01T00:00:00.000Z", lastSignInAt: "2026-09-02T00:00:00.000Z", revoked: false });

/** The staging shape of Plan 2 Task 3: D1 created the org, D2 was added to it by a sign-in from before identity links. One table plays both tables. */
async function mergeWorld() {
  let clock = T0;
  const db = new FakeDynamoDb();
  const signInStore = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => clock });
  const orgs = new OrgStore({ documentClient: db, tableName: "state", now: () => clock });
  db.set(developerRecord(D1, "cloud", OIDC_ISSUER, "priya-cloud-1"));
  db.set(developerRecord(D2, "github", GITHUB_ISSUER, "4711"));
  const orgId = await orgs.createOrgWithOwner({ name: "Priya's team", developerId: D1, email: EMAIL });
  await orgs.addMember({ orgId, developerId: D2, role: "member" });
  const mergeDeps = { documentClient: db, tableName: "state", signInStore, now: () => clock };
  const merge = (survivorId = D1, duplicateId = D2) => mergeDuplicateMember(mergeDeps, { orgId, survivorId, duplicateId, duplicateIdentityKey: duplicateId });
  return { db, orgs, orgId, signInStore, merge, tick: (ms: number) => { clock += ms; } };
}

const markers = (db: FakeDynamoDb) => db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK);

describe("the merge marker", () => {
  it("puts one marker with a time sort key, in the merge's own transaction and nowhere else", async () => {
    const w = await mergeWorld();
    w.tick(1000);
    const commandsBefore = w.db.commandNames().length;

    await w.merge();

    expect(markers(w.db)).toEqual([{
      ...memberMergeQueueKey("2026-10-22T09:00:01.000Z", w.orgId, D2),
      entityType: "MEMBER_MERGE", orgId: w.orgId, survivorId: D1, duplicateId: D2,
    }]);
    expect(markers(w.db)[0]!.sk).toBe(`2026-10-22T09:00:01.000Z#${w.orgId}#${D2}`);
    // One transaction wrote it with the merge; the sign-in path made no separate write for it.
    const writes = w.db.commandNames().slice(commandsBefore).filter((name) => ["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand"].includes(name));
    expect(writes).toEqual(["TransactWriteCommand"]);
    // The member is merged in that same transaction: both or neither.
    expect(w.db.get(orgMemberKey(w.orgId, D2))).toBeUndefined();
  });

  it("is not written when the merge's transaction fails, and not again when the merge is repeated", async () => {
    const w = await mergeWorld();
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(w.merge()).rejects.toThrow();
    expect(markers(w.db)).toEqual([]);

    await w.merge();
    expect(markers(w.db)).toHaveLength(1);
    w.tick(60_000);
    await w.merge();
    expect(markers(w.db)).toHaveLength(1);
  });

  it("holds ids and the org only", async () => {
    const w = await mergeWorld();
    await w.merge();
    expect(Object.keys(markers(w.db)[0]!).sort()).toEqual(["duplicateId", "entityType", "orgId", "pk", "sk", "survivorId"]);
  });
});


// ---- the agents world: two orgs, a duplicate of Alice, and the things a member can own

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const hex = (digit: string) => digit.repeat(64);
const OWEN = hex("1"); // the first owner of org A
const OLIVE = hex("2"); // its second owner
const ALICE = hex("a");
const OLD_ALICE = hex("b"); // Alice's duplicate
const BOB = hex("c"); // a maintainer of web by grant
const CARA = hex("d"); // another maintainer of web by grant
const ERIN = hex("e");
const XAVI = hex("f"); // org B's owner
const OLD_XAVI = hex("9");
const SCRATCH: RecipeOverlay = { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] };
const WRITES = new Set(["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand"]);
const skillFile = (name: string) => `---\nname: ${name}\ndescription: Use when ${name}.\n---\n# Steps\n`;

function agentWorld(options: { audit?: AuditCapture } = {}) {
  const db = new FakeDynamoDb();
  for (const orgId of [ORG_A, ORG_B]) db.set({ ...orgMetaKey(orgId), entityType: "ORG", orgId });
  options.audit?.attach(db);
  const clock = { now: T0 };
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const signInStore = new DeveloperSignInStore({ documentClient: db, tableName: "T", now: () => clock.now });
  let counter = 0;
  const store = new AgentStore({
    documentClient: db, tableName: "T", now: () => clock.now, newId: () => `agt_${String(++counter).padStart(20, "0")}`,
    resolveOwner: (_orgId, developerId) => followMerges(signInStore, developerId),
    ...(options.audit === undefined ? {} : { audit: options.audit.audit }),
  });
  const projectMembers = new FakeProjectMembers();
  const deps: LifecycleDeps = {
    store, projectMembers, documentClient: db, tableName: options.audit === undefined ? "T" : AUDIT_CAPTURE_TABLE, signInStore, now: () => clock.now, log: (event, fields) => logs.push({ event, fields }),
  };
  const member = (orgId: OrgId, developerId: string, role: OrgRole, joinedAt: string) => {
    db.set({ ...orgMemberKey(orgId, developerId), entityType: "ORG_MEMBER", orgId, developerId, role, joinedAt });
    db.set({ ...developerOrgKey(developerId), entityType: "DEVELOPER_ORG", orgId, role, joinedAt });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId });
    projectMembers.setOrgRole(orgId, developerId, role);
  };
  member(ORG_A, OWEN, "owner", "2026-10-01T00:00:00.000Z");
  member(ORG_A, OLIVE, "owner", "2026-10-02T00:00:00.000Z");
  member(ORG_A, ALICE, "member", "2026-10-03T00:00:00.000Z");
  member(ORG_A, OLD_ALICE, "member", "2026-10-04T00:00:00.000Z");
  for (const who of [BOB, CARA, ERIN]) member(ORG_A, who, "member", "2026-10-05T00:00:00.000Z");
  member(ORG_B, XAVI, "owner", "2026-10-01T00:00:00.000Z");
  member(ORG_B, OLD_XAVI, "member", "2026-10-02T00:00:00.000Z");
  for (const project of ["web", "api"]) {
    db.set({ ...orgProjectCatalogKey(ORG_A, project), entityType: "PROJECT_CATALOG", name: project });
    projectMembers.addProject(ORG_A, project);
  }
  projectMembers.grant(ORG_A, "web", BOB, "maintainer");
  projectMembers.grant(ORG_A, "web", CARA, "maintainer");

  /** An agent of a member, with a monthly budget; made before any merge, so the owner's total counts it where it was made. */
  const memberAgent = async (owner: string, name: string, budgetUsd?: number, orgId: OrgId = ORG_A) => {
    const agent = await store.create({ orgId, name, owner: { kind: "member", developerId: owner }, overlay: SCRATCH, createdBy: owner });
    if (budgetUsd !== undefined) await store.setBudget(orgId, agent.agentId, { monthlyUsd: budgetUsd }, fixtureActor(store, orgId, owner).developerId, undefined, { ...({}), actor: fixtureActor(store, orgId, owner) });
    return agent;
  };
  const projectAgent = async (project: string, accountable: string, name: string, budgetUsd?: number) => {
    const agent = await store.create({ orgId: ORG_A, name, owner: { kind: "project", project }, accountable: { developerId: accountable }, overlay: SCRATCH, createdBy: accountable });
    if (budgetUsd !== undefined) await store.setBudget(ORG_A, agent.agentId, { monthlyUsd: budgetUsd }, fixtureActor(store, ORG_A, accountable).developerId, undefined, { ...({}), actor: fixtureActor(store, ORG_A, accountable) });
    return agent;
  };
  const shareWith = (agentId: AgentId, who: string, level: "view" | "use" | "edit", orgId: OrgId = ORG_A) =>
    store.replaceShares({ orgId, agentId, upsert: [{ principal: { kind: "member", developerId: who }, level }], remove: [], expectedSharesRevision: 0, by: "seed" });
  /** What the merge did: the duplicate's record points at the survivor and its membership is gone. */
  const merged = (duplicate: string, survivor: string, orgId: OrgId = ORG_A) => {
    db.delete(orgMemberKey(orgId, duplicate));
    db.set({ pk: `DEVELOPER#${duplicate}`, sk: "META", developerId: duplicate, mergedInto: survivor });
  };
  const queue = (at: string, orgId: OrgId, survivorId: string, duplicateId: string) =>
    db.set({ ...memberMergeQueueKey(at, orgId, duplicateId), entityType: "MEMBER_MERGE", orgId, survivorId, duplicateId });
  const caller = (developerId: string, orgRole: OrgRole = "member", orgId: OrgId = ORG_A): AgentCaller => ({ orgId, developerId, orgRole });
  const ownerEvents = async (agentId: AgentId, orgId: OrgId = ORG_A) => (await store.listEvents(orgId, agentId)).filter((event) => event.kind === "owner_changed");
  const writesSince = (before: number) => db.commandNames().slice(before).filter((name) => WRITES.has(name));
  return { db, clock, store, deps, projectMembers, logs, memberAgent, projectAgent, shareWith, merged, queue, caller, ownerEvents, writesSince, member, signInStore };
}

/** Registers a mover for the length of one test. */
async function withMover<T>(mover: MemberMover, run: () => Promise<T>): Promise<T> {
  const unregister = registerMemberMover(mover);
  try { return await run(); } finally { unregister(); }
}

describe("resolveMember and sameMember", () => {
  it("map a duplicate to the member it was merged into, follow a chain, and leave anyone else alone", async () => {
    const w = agentWorld();
    w.merged(OLD_ALICE, ALICE);
    w.db.set({ pk: `DEVELOPER#${ALICE}`, sk: "META", developerId: ALICE, mergedInto: OWEN });
    expect(await resolveMember(w.deps, ORG_A, OLD_ALICE)).toBe(OWEN);
    expect(await resolveMember(w.deps, ORG_A, ALICE)).toBe(OWEN);
    expect(await resolveMember(w.deps, ORG_A, BOB)).toBe(BOB);
    expect(await resolveMember(w.deps, ORG_A, hex("0"))).toBe(hex("0"));
  });

  it("compare two ids as the people they stand for", async () => {
    const w = agentWorld();
    w.merged(OLD_ALICE, ALICE);
    expect(await sameMember(w.deps, ORG_A, OLD_ALICE, ALICE)).toBe(true);
    expect(await sameMember(w.deps, ORG_A, ALICE, OLD_ALICE)).toBe(true);
    expect(await sameMember(w.deps, ORG_A, ALICE, ALICE)).toBe(true);
    expect(await sameMember(w.deps, ORG_A, OLD_ALICE, BOB)).toBe(false);
    expect(await sameMember(w.deps, ORG_A, BOB, CARA)).toBe(false);
  });

  it("let access treat the duplicate as the survivor before any sweep has run", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OLD_ALICE, "Triage");
    w.merged(OLD_ALICE, ALICE);
    const access = { ...w.deps } satisfies AgentAccessDeps;
    expect(await agentAccess(access, w.caller(ALICE), agent)).toBe("manage");
    expect(await agentAccess(access, w.caller(BOB), agent)).toBe("none");
  });

  it("use the injected resolver when the deployment has one", async () => {
    const w = agentWorld();
    const resolveDeveloper = vi.fn(async (_orgId: OrgId, developerId: string) => (developerId === OLD_ALICE ? ALICE : developerId));
    expect(await resolveMember({ ...w.deps, resolveDeveloper }, ORG_A, OLD_ALICE)).toBe(ALICE);
    expect(resolveDeveloper).toHaveBeenCalledWith(ORG_A, OLD_ALICE);
  });
});

describe("onMembersMerged", () => {
  const merge = { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE };

  it("moves the duplicate's agents to the survivor with one owner_changed event that names the merge, and leaves everyone else's alone", async () => {
    const w = agentWorld();
    const mine = await w.memberAgent(OLD_ALICE, "Old triage", 20);
    const bobs = await w.memberAgent(BOB, "Bob's agent", 5);
    const alices = await w.memberAgent(ALICE, "Alice's agent", 7);
    w.merged(OLD_ALICE, ALICE);

    await onMembersMerged(w.deps, merge);

    expect((await w.store.get(ORG_A, mine.agentId))!.owner).toEqual({ kind: "member", developerId: ALICE });
    expect((await w.store.get(ORG_A, bobs.agentId))!.owner).toEqual({ kind: "member", developerId: BOB });
    expect(await w.ownerEvents(bobs.agentId)).toEqual([]);
    expect(await w.ownerEvents(alices.agentId)).toEqual([]);
    const events = await w.ownerEvents(mine.agentId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      by: "system", from: { kind: "member", developerId: OLD_ALICE }, to: { kind: "member", developerId: ALICE }, cause: { kind: "member_merged", developerId: OLD_ALICE },
    });
  });

  it("counts the duplicate's agent budgets in the survivor's total and clears the duplicate's (Task 28)", async () => {
    const w = agentWorld();
    await w.memberAgent(OLD_ALICE, "Old triage", 20);
    await w.memberAgent(ALICE, "Alice's agent", 7);
    expect(await readOwnerTotal(w.deps, ORG_A, OLD_ALICE)).toBe(20);
    w.merged(OLD_ALICE, ALICE);

    await onMembersMerged(w.deps, merge);

    expect(await readOwnerTotal(w.deps, ORG_A, ALICE)).toBe(27);
    expect(await readOwnerTotal(w.deps, ORG_A, OLD_ALICE)).toBe(0);
  });

  it("moves the duplicate's skills to the survivor, and only the duplicate's", async () => {
    const w = agentWorld();
    const mine = await w.store.skills.create({ orgId: ORG_A, content: skillFile("triage"), owner: { kind: "member", developerId: OLD_ALICE }, by: OLD_ALICE });
    const bobs = await w.store.skills.create({ orgId: ORG_A, content: skillFile("deploys"), owner: { kind: "member", developerId: BOB }, by: BOB });
    const projects = await w.store.skills.create({ orgId: ORG_A, content: skillFile("reviews"), owner: { kind: "project", project: "web" }, by: BOB });
    w.merged(OLD_ALICE, ALICE);

    await onMembersMerged(w.deps, merge);

    expect((await w.store.skills.get(ORG_A, mine.skillId))!.owner).toEqual({ kind: "member", developerId: ALICE });
    expect((await w.store.skills.get(ORG_A, bobs.skillId))!.owner).toEqual({ kind: "member", developerId: BOB });
    expect((await w.store.skills.get(ORG_A, projects.skillId))!.owner).toEqual({ kind: "project", project: "web" });
  });

  it("moves the accountable maintainer of a project's agent and of a built-in to the survivor, and keeps the agent's budget in the survivor's total", async () => {
    const w = agentWorld();
    const web = await w.projectAgent("web", OLD_ALICE, "Web helper", 30);
    seedMembership(w.db, OLD_ALICE, { orgId: ORG_A, role: "admin" }); // a built-in's accountable person is an owner or admin, held to that in the write's own transaction
    await w.store.setAccountable(ORG_A, "rovara-code", { developerId: OLD_ALICE }, fixtureActor(w.store, ORG_A, "admin", true).developerId, undefined, { actor: fixtureActor(w.store, ORG_A, "admin", true) });
    const others = await w.projectAgent("web", BOB, "Bob's helper", 10);
    w.merged(OLD_ALICE, ALICE);

    await onMembersMerged(w.deps, merge);

    expect((await w.store.get(ORG_A, web.agentId))!.accountable).toEqual({ developerId: ALICE });
    expect((await w.store.getBuiltinSettings(ORG_A, "rovara-code"))!.accountable).toEqual({ developerId: ALICE });
    expect((await w.store.get(ORG_A, others.agentId))!.accountable).toEqual({ developerId: BOB });
    expect(await readOwnerTotal(w.deps, ORG_A, ALICE)).toBe(30);
    expect(await readOwnerTotal(w.deps, ORG_A, OLD_ALICE)).toBe(0);
    const events = (await w.store.listEvents(ORG_A, web.agentId)).filter((event) => event.kind === "owner_changed");
    expect(events[0]).toMatchObject({ by: "system", accountable: { developerId: ALICE }, cause: { kind: "member_merged", developerId: OLD_ALICE } });
  });

  it("moves the duplicate's shares to the survivor, keeping the higher level when the survivor had one, and bumps the share revision", async () => {
    const w = agentWorld();
    const first = await w.memberAgent(BOB, "Bob's first");
    const second = await w.memberAgent(BOB, "Bob's second");
    await w.shareWith(first.agentId, OLD_ALICE, "use");
    await w.store.replaceShares({
      orgId: ORG_A, agentId: second.agentId, expectedSharesRevision: 0, by: "seed", remove: [],
      upsert: [{ principal: { kind: "member", developerId: OLD_ALICE }, level: "edit" }, { principal: { kind: "member", developerId: ALICE }, level: "view" }],
    });
    w.merged(OLD_ALICE, ALICE);

    await onMembersMerged(w.deps, merge);

    const shares = async (agentId: AgentId) => (await w.store.listShares(ORG_A, agentId)).map((share) => [(share.principal as { developerId: string }).developerId, share.level]);
    expect(await shares(first.agentId)).toEqual([[ALICE, "use"]]);
    expect(await shares(second.agentId)).toEqual([[ALICE, "edit"]]);
    // The index items follow: nothing is listed under the duplicate, and the survivor's lists both agents.
    const indexed = (who: string) => w.db.find((item) => item.pk === principalSharesKey(ORG_A, { kind: "member", developerId: who }, "x").pk).map((item) => [item.sk, item.level]).sort();
    expect(indexed(OLD_ALICE)).toEqual([]);
    expect(indexed(ALICE)).toEqual([[first.agentId, "use"], [second.agentId, "edit"]]);
    expect((await w.store.get(ORG_A, first.agentId))!.sharesRevision).toBe(2);
    expect((await w.store.listEvents(ORG_A, first.agentId)).filter((event) => event.kind === "shared")).toHaveLength(2);
  });

  it("leaves the survivor with manage on the duplicate's agent and its shares, with no merge lookup at all", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OLD_ALICE, "Old triage");
    const bobs = await w.memberAgent(BOB, "Bob's agent");
    await w.shareWith(bobs.agentId, OLD_ALICE, "edit");
    w.merged(OLD_ALICE, ALICE);
    await onMembersMerged(w.deps, merge);

    // An access check that treats every id as itself: the data itself now names the survivor.
    const plain: AgentAccessDeps = { ...w.deps, resolveDeveloper: async (_orgId, developerId) => developerId };
    expect(await agentAccess(plain, w.caller(ALICE), (await w.store.get(ORG_A, agent.agentId))!)).toBe("manage");
    expect(await agentAccess(plain, w.caller(ALICE), (await w.store.get(ORG_A, bobs.agentId))!)).toBe("edit");
    expect(await agentAccess(plain, w.caller(OLD_ALICE), (await w.store.get(ORG_A, agent.agentId))!)).toBe("none");
  });

  it("is repeatable: a second run writes nothing", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OLD_ALICE, "Old triage", 20);
    await w.projectAgent("web", OLD_ALICE, "Web helper", 30);
    const shared = await w.memberAgent(BOB, "Bob's agent");
    await w.shareWith(shared.agentId, OLD_ALICE, "use");
    await w.store.skills.create({ orgId: ORG_A, content: skillFile("triage"), owner: { kind: "member", developerId: OLD_ALICE }, by: OLD_ALICE });
    w.merged(OLD_ALICE, ALICE);
    await onMembersMerged(w.deps, merge);
    const before = structuredClone([...w.db.items.entries()]);
    const commands = w.db.commandNames().length;

    await onMembersMerged(w.deps, merge);

    expect(w.writesSince(commands)).toEqual([]);
    expect(structuredClone([...w.db.items.entries()])).toEqual(before);
    expect(await w.ownerEvents(agent.agentId)).toHaveLength(1);
  });

  it("reads another org's agents of the same id as none of its business", async () => {
    const w = agentWorld();
    const theirs = await w.memberAgent(OLD_ALICE, "In org B", 9, ORG_B);
    await w.memberAgent(OLD_ALICE, "In org A", 4);
    w.merged(OLD_ALICE, ALICE);
    await onMembersMerged(w.deps, merge);
    expect((await w.store.get(ORG_B, theirs.agentId))!.owner).toEqual({ kind: "member", developerId: OLD_ALICE });
    expect(await w.ownerEvents(theirs.agentId, ORG_B)).toEqual([]);
  });

  it("says plainly when the move leaves the survivor over the per-person cap, and still moves (TASK 32 SEAM)", async () => {
    const w = agentWorld();
    await w.memberAgent(ALICE, "Alice's big one", 70);
    await w.memberAgent(OLD_ALICE, "Old big one", 60);
    w.merged(OLD_ALICE, ALICE);

    await onMembersMerged(w.deps, merge);

    expect(await readOwnerTotal(w.deps, ORG_A, ALICE)).toBe(130);
    expect(w.logs.filter((entry) => entry.event === "owner_cap.exceeded_by_move")).toEqual([{
      event: "owner_cap.exceeded_by_move", fields: { orgId: ORG_A, owner: ALICE, totalUsd: 130, capUsd: 100, reason: "member_merged" },
    }]);
  });

  it("says nothing about the cap when the survivor is under it", async () => {
    const w = agentWorld();
    await w.memberAgent(OLD_ALICE, "Old", 60);
    w.merged(OLD_ALICE, ALICE);
    await onMembersMerged(w.deps, merge);
    expect(w.logs.filter((entry) => entry.event === "owner_cap.exceeded_by_move")).toEqual([]);
  });
});

describe("what Rovara's own moves leave in the audit ledger (Audit Task 19)", () => {
  const targetIdOf = (event: { target: unknown }) => (event.target as { id?: string }).id;
  const merge = { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE };

  it("records each owner move as the system's own change, naming both people, in the move's own transaction", async () => {
    const capture = capturingAuditDeps();
    const w = agentWorld({ audit: capture });
    const agent = await w.memberAgent(OLD_ALICE, "Old triage");
    const web = await w.projectAgent("web", OLD_ALICE, "Web helper");
    w.merged(OLD_ALICE, ALICE);

    await onMembersMerged(w.deps, merge);

    const events = capture.recordedBy("agent.owner_changed");
    expect(events).toHaveLength(2);
    for (const event of events) expect(event).toMatchObject({ orgId: ORG_A, actor: { kind: "system", id: "rovara" } });
    expect(events.find((event) => targetIdOf(event) === agent.agentId)).toMatchObject({ facts: { field: "owner" }, related: expect.arrayContaining([OLD_ALICE, ALICE]) as unknown });
    expect(events.find((event) => targetIdOf(event) === web.agentId)).toMatchObject({ facts: { field: "accountable" }, related: expect.arrayContaining([OLD_ALICE, ALICE]) as unknown });
  });

  it("records nothing for a move that was refused: the audit item is in the same transaction as the change", async () => {
    const capture = capturingAuditDeps();
    const w = agentWorld({ audit: capture });
    const agent = await w.memberAgent(OLD_ALICE, "Old triage");
    w.merged(OLD_ALICE, ALICE);
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("owner_changed"), error: { name: "InternalServerError" } });

    await expect(onMembersMerged(w.deps, merge)).rejects.toMatchObject({ name: "InternalServerError" });

    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OLD_ALICE });
    expect(capture.recordedBy("agent.owner_changed")).toEqual([]);
  });

  it("records a removal's move as the system's too", async () => {
    const capture = capturingAuditDeps();
    const w = agentWorld({ audit: capture });
    const agent = await w.memberAgent(ERIN, "Erin's agent");
    w.db.delete(orgMemberKey(ORG_A, ERIN));
    await onMemberRemoved(w.deps, { orgId: ORG_A, developerId: ERIN, by: OLIVE });
    expect(capture.recordedBy("agent.owner_changed")).toMatchObject([{ actor: { kind: "system", id: "rovara" }, target: { id: agent.agentId }, related: expect.arrayContaining([ERIN, OWEN]) as unknown }]);
  });
});

describe("a move that races another write", () => {
  it("reads the agent again and moves it when something else changed it in between", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OLD_ALICE, "Old triage", 5);
    w.merged(OLD_ALICE, ALICE);
    // The first attempt finds the agent changed under it (its guard fails); the second reads the new state and goes through.
    w.db.injectFault({
      command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("owner_changed"),
      error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }] },
    });
    await onMembersMerged(w.deps, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: ALICE });
    expect(await w.ownerEvents(agent.agentId)).toHaveLength(1);
  });

  it("gives up after a few tries and leaves the move for the next sweep", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OLD_ALICE, "Old triage", 5);
    w.merged(OLD_ALICE, ALICE);
    w.db.injectFault({
      command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("owner_changed"), times: 10,
      error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }] },
    });
    await expect(onMembersMerged(w.deps, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE })).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OLD_ALICE });
  });

  it("does not take a skill someone else already handed to another owner", async () => {
    const w = agentWorld();
    const skill = await w.store.skills.create({ orgId: ORG_A, content: skillFile("triage"), owner: { kind: "member", developerId: OLD_ALICE }, by: OLD_ALICE });
    const handedOver = { kind: "member", developerId: BOB } as const;
    // Read as OLD_ALICE's, moved by someone else to BOB, then Rovara's move arrives with the old reading.
    w.db.set({ ...w.db.get(skillKey(ORG_A, skill.skillId, "META"))!, owner: handedOver });
    expect(await w.store.skills.moveOwner(ORG_A, skill.skillId, { kind: "member", developerId: OLD_ALICE }, { kind: "member", developerId: ALICE })).toBe(false);
    expect((await w.store.skills.get(ORG_A, skill.skillId))!.owner).toEqual(handedOver);
    expect(await w.store.skills.moveOwner(ORG_A, skill.skillId, handedOver, { kind: "member", developerId: ALICE })).toBe(true);
    expect((await w.store.skills.get(ORG_A, skill.skillId))!.owner).toEqual({ kind: "member", developerId: ALICE });
  });

  it("does not move a share the person no longer holds, and does not give the survivor a lower one than they have", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(BOB, "Bob's agent");
    await w.store.replaceShares({
      orgId: ORG_A, agentId: agent.agentId, expectedSharesRevision: 0, by: "seed", remove: [],
      upsert: [{ principal: { kind: "member", developerId: OLD_ALICE }, level: "view" }, { principal: { kind: "member", developerId: ALICE }, level: "edit" }],
    });
    await w.store.reassignShare({ orgId: ORG_A, agentId: agent.agentId, from: { kind: "member", developerId: OLD_ALICE }, to: { kind: "member", developerId: ALICE }, by: "system", cause: { kind: "member_merged", developerId: OLD_ALICE } });
    expect((await w.store.listShares(ORG_A, agent.agentId)).map((share) => [(share.principal as { developerId: string }).developerId, share.level])).toEqual([[ALICE, "edit"]]);
    const commands = w.db.commandNames().length;
    await w.store.reassignShare({ orgId: ORG_A, agentId: agent.agentId, from: { kind: "member", developerId: OLD_ALICE }, to: { kind: "member", developerId: ALICE }, by: "system", cause: { kind: "member_merged", developerId: OLD_ALICE } });
    expect(w.writesSince(commands)).toEqual([]);
  });

  it("conflicts, reads the shares again and goes through when a share save lands between its read and its write", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(BOB, "Bob's agent");
    await w.shareWith(agent.agentId, OLD_ALICE, "use");
    let raced = false;
    // The moment the move's transaction is about to run, someone else saves the agent's shares (revision 1 -> 5).
    const send = w.db.send.bind(w.db);
    w.db.send = async (command) => {
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes('"shared"')) {
        raced = true;
        w.db.set({ ...w.db.get(agentKey(ORG_A, agent.agentId, "META"))!, sharesRevision: 5 });
      }
      return send(command);
    };

    await w.store.reassignShare({ orgId: ORG_A, agentId: agent.agentId, from: { kind: "member", developerId: OLD_ALICE }, to: { kind: "member", developerId: ALICE }, by: "system", cause: { kind: "member_merged", developerId: OLD_ALICE } });

    expect(raced).toBe(true);
    expect((await w.store.listShares(ORG_A, agent.agentId)).map((share) => (share.principal as { developerId: string }).developerId)).toEqual([ALICE]);
    // The racing save's revision was kept, not overwritten: the move made it 6.
    expect((await w.store.get(ORG_A, agent.agentId))!.sharesRevision).toBe(6);
  });

  it("says nothing about the cap when the new owner lands exactly on it", async () => {
    const w = agentWorld();
    await w.memberAgent(ALICE, "Alice's", 40);
    await w.memberAgent(OLD_ALICE, "Old", 60);
    w.merged(OLD_ALICE, ALICE);
    await onMembersMerged(w.deps, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    expect(await readOwnerTotal(w.deps, ORG_A, ALICE)).toBe(100);
    expect(w.logs.filter((entry) => entry.event === "owner_cap.exceeded_by_move")).toEqual([]);
  });
});

describe("registerMemberMover", () => {
  it("runs a registered mover on a merge and on a removal, with what it needs, until it is unregistered", async () => {
    const w = agentWorld();
    const merged = vi.fn(async () => undefined);
    const removed = vi.fn(async () => undefined);
    const unregister = registerMemberMover({ name: "probe", merged, removed });
    await onMembersMerged(w.deps, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    expect(merged).toHaveBeenCalledWith(w.deps, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    w.db.delete(orgMemberKey(ORG_A, ERIN));
    await onMemberRemoved(w.deps, { orgId: ORG_A, developerId: ERIN, by: OWEN });
    expect(removed).toHaveBeenCalledWith(w.deps, { orgId: ORG_A, developerId: ERIN, by: OWEN, successorId: OWEN });
    unregister();
    await onMembersMerged(w.deps, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    expect(merged).toHaveBeenCalledTimes(1);
  });

  it("replaces a mover registered under the same name", async () => {
    const w = agentWorld();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const unregisterFirst = registerMemberMover({ name: "probe", merged: first });
    const unregisterSecond = registerMemberMover({ name: "probe", merged: second });
    try {
      await onMembersMerged(w.deps, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    } finally { unregisterFirst(); unregisterSecond(); }
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("lets every other mover run when one fails, then fails the merge so the marker stays", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OLD_ALICE, "Old triage");
    w.merged(OLD_ALICE, ALICE);
    const after = vi.fn(async () => undefined);
    await withMover({ name: "a-fails", merged: async () => { throw new Error("boom"); } }, () =>
      withMover({ name: "z-after", merged: after }, async () => {
        await expect(onMembersMerged(w.deps, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE })).rejects.toThrow("boom");
      }));
    expect(after).toHaveBeenCalledTimes(1);
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: ALICE });
  });
});

describe("drainMemberMerges", () => {
  const at = (minute: number) => `2026-10-22T09:${String(minute).padStart(2, "0")}:00.000Z`;

  it("finds the markers of two orgs with one query, moves oldest first, and deletes each", async () => {
    const w = agentWorld();
    const aliceOld = await w.memberAgent(OLD_ALICE, "Old triage");
    const xaviOld = await w.memberAgent(OLD_XAVI, "Old in B", undefined, ORG_B);
    w.merged(OLD_ALICE, ALICE);
    w.merged(OLD_XAVI, XAVI, ORG_B);
    // Org A's marker is younger than org B's, whatever order they were written in.
    w.queue(at(5), ORG_A, ALICE, OLD_ALICE);
    w.queue(at(2), ORG_B, XAVI, OLD_XAVI);
    const order: string[] = [];
    const commands = w.db.commandNames().length;

    const report = await withMover({ name: "probe", merged: async (_deps, move) => { order.push(`${move.orgId}:${move.duplicateId}`); } }, () => drainMemberMerges(w.deps, T0));

    expect(report).toEqual({ processed: 2, rejected: 0, failed: 0 });
    expect(order).toEqual([`${ORG_B}:${OLD_XAVI}`, `${ORG_A}:${OLD_ALICE}`]);
    expect((await w.store.get(ORG_A, aliceOld.agentId))!.owner).toEqual({ kind: "member", developerId: ALICE });
    expect((await w.store.get(ORG_B, xaviOld.agentId))!.owner).toEqual({ kind: "member", developerId: XAVI });
    expect(w.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK)).toEqual([]);
    // One query listed the whole partition.
    expect(w.db.commandNames().slice(commands).filter((name) => name === "QueryCommand").length).toBeGreaterThanOrEqual(1);
  });

  it("repeats harmlessly after a run that moved things and stopped before it deleted the marker", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OLD_ALICE, "Old triage", 20);
    const shared = await w.memberAgent(BOB, "Bob's agent");
    await w.shareWith(shared.agentId, OLD_ALICE, "use");
    w.merged(OLD_ALICE, ALICE);
    w.queue(at(1), ORG_A, ALICE, OLD_ALICE);
    // The first run's delete of the marker fails, as a crash right after the moves would.
    w.db.injectFault({ command: "DeleteCommand", match: (input) => (input.Key as { pk?: string }).pk === MEMBER_MERGE_QUEUE_PK, error: { name: "InternalServerError" } });
    expect(await drainMemberMerges(w.deps, T0)).toEqual({ processed: 0, rejected: 0, failed: 1 });
    expect(w.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK)).toHaveLength(1);
    const events = (await w.ownerEvents(agent.agentId)).length;
    w.clock.now += 10 * 60_000;

    expect(await drainMemberMerges(w.deps, T0)).toEqual({ processed: 1, rejected: 0, failed: 0 });

    expect(w.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK)).toEqual([]);
    expect((await w.ownerEvents(agent.agentId)).length).toBe(events);
    expect((await w.store.listShares(ORG_A, shared.agentId)).map((share) => (share.principal as { developerId: string }).developerId)).toEqual([ALICE]);
    expect(await readOwnerTotal(w.deps, ORG_A, ALICE)).toBe(20);
  });

  it("leaves the marker for the next sweep when a move fails, and finishes then", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OLD_ALICE, "Old triage");
    w.merged(OLD_ALICE, ALICE);
    w.queue(at(1), ORG_A, ALICE, OLD_ALICE);
    let broken = true;
    await withMover({ name: "probe", merged: async () => { if (broken) throw new Error("not yet"); } }, async () => {
      expect(await drainMemberMerges(w.deps, T0)).toEqual({ processed: 0, rejected: 0, failed: 1 });
      expect(w.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK)).toHaveLength(1);
      expect(w.logs.map((entry) => entry.event)).toContain("member_merge.failed");
      broken = false;
      // The failed marker waits out its back-off before it is tried again.
      w.clock.now += 10 * 60_000;
      expect(await drainMemberMerges(w.deps, T0)).toEqual({ processed: 1, rejected: 0, failed: 0 });
    });
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: ALICE });
    expect(w.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK)).toEqual([]);
  });

  describe("checks the merge before it moves anything (R2-5)", () => {
    const refusedCases: Array<[string, (w: ReturnType<typeof agentWorld>) => void, string]> = [
      ["the duplicate's record does not say it was merged", (w) => { w.merged(OLD_ALICE, ALICE); w.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE }); }, "duplicate_not_merged"],
      ["the duplicate was merged into someone else", (w) => { w.merged(OLD_ALICE, BOB); }, "duplicate_not_merged"],
      ["the duplicate has no record at all", (w) => { w.merged(OLD_ALICE, ALICE); w.db.delete(`DEVELOPER#${OLD_ALICE}`, "META"); }, "duplicate_not_merged"],
      ["the duplicate is still a member of the org", (w) => { w.merged(OLD_ALICE, ALICE); w.member(ORG_A, OLD_ALICE, "member", "2026-10-04T00:00:00.000Z"); w.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE, mergedInto: ALICE }); }, "duplicate_still_member"],
    ];
    it.each(refusedCases)("deletes the marker, logs member_merge.rejected and moves nothing when %s", async (_name, arrange, reason) => {
      const w = agentWorld();
      const agent = await w.memberAgent(OLD_ALICE, "Old triage", 20);
      arrange(w);
      w.queue(at(1), ORG_A, ALICE, OLD_ALICE);
      const mover = vi.fn(async () => undefined);

      const report = await withMover({ name: "probe", merged: mover }, () => drainMemberMerges(w.deps, T0));

      expect(report).toEqual({ processed: 0, rejected: 1, failed: 0 });
      expect(mover).not.toHaveBeenCalled();
      expect(w.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK)).toEqual([]);
      expect(w.logs.filter((entry) => entry.event === "member_merge.rejected")).toEqual([{
        event: "member_merge.rejected", fields: { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE, reason },
      }]);
      expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OLD_ALICE });
      expect(await w.ownerEvents(agent.agentId)).toEqual([]);
    });

    it("rejects a marker whose org is not the one in its key, or whose key is not a marker's at all, without trusting either", async () => {
      const w = agentWorld();
      const agent = await w.memberAgent(OLD_ALICE, "Old triage");
      w.merged(OLD_ALICE, ALICE);
      // A marker keyed in org B that says org A, for a merge that is fully real in org B: the key's org and the item's must agree, or nothing moves in either.
      const theirs = await w.memberAgent(OLD_XAVI, "Old in B", undefined, ORG_B);
      w.merged(OLD_XAVI, XAVI, ORG_B);
      w.db.set({ ...memberMergeQueueKey(at(1), ORG_B, OLD_XAVI), entityType: "MEMBER_MERGE", orgId: ORG_A, survivorId: XAVI, duplicateId: OLD_XAVI });
      w.db.set({ ...memberMergeQueueKey(at(2), ORG_B, OLD_ALICE), entityType: "MEMBER_MERGE", orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
      w.db.set({ pk: MEMBER_MERGE_QUEUE_PK, sk: "not-a-marker", entityType: "MEMBER_MERGE", orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
      w.db.set({ ...memberMergeQueueKey(at(3), ORG_A, OLD_ALICE), entityType: "MEMBER_MERGE", orgId: ORG_A, survivorId: "x", duplicateId: OLD_ALICE });

      expect(await drainMemberMerges(w.deps, T0)).toEqual({ processed: 0, rejected: 4, failed: 0 });

      expect(w.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK)).toEqual([]);
      expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OLD_ALICE });
      expect((await w.store.get(ORG_B, theirs.agentId))!.owner).toEqual({ kind: "member", developerId: OLD_XAVI });
    });

    it("moves to the end of a chain when the survivor was itself merged away since", async () => {
      const w = agentWorld();
      const agent = await w.memberAgent(OLD_ALICE, "Old triage");
      w.merged(OLD_ALICE, ALICE);
      w.merged(ALICE, OWEN);
      w.queue(at(1), ORG_A, ALICE, OLD_ALICE);
      expect(await drainMemberMerges(w.deps, T0)).toEqual({ processed: 1, rejected: 0, failed: 0 });
      expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OWEN });
    });
  });

  it("treats a merge whose survivor has left since as the removal of the duplicate: the first owner takes its things", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OLD_ALICE, "Old triage", 20);
    const web = await w.projectAgent("web", OLD_ALICE, "Web helper", 5);
    const shared = await w.memberAgent(BOB, "Bob's agent");
    await w.shareWith(shared.agentId, OLD_ALICE, "use");
    const skill = await w.store.skills.create({ orgId: ORG_A, content: skillFile("triage"), owner: { kind: "member", developerId: OLD_ALICE }, by: OLD_ALICE });
    w.merged(OLD_ALICE, ALICE);
    w.queue(at(1), ORG_A, ALICE, OLD_ALICE);
    // Before the sweep reaches the marker, an owner removes the survivor. That removal moves only what Alice's own id owns.
    const orgs = new OrgStore({ documentClient: w.db, tableName: "T", now: () => w.clock.now, memberRemoval: memberRemovalHook(w.deps) });
    await orgs.removeMember({ orgId: ORG_A, developerId: ALICE, emails: [], ban: false, by: { kind: "member", id: OLIVE } });
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OLD_ALICE });

    expect(await drainMemberMerges(w.deps, T0)).toEqual({ processed: 1, rejected: 0, failed: 0 });

    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OWEN });
    expect((await w.store.get(ORG_A, web.agentId))!.accountable).toEqual({ developerId: BOB });
    expect((await w.store.skills.get(ORG_A, skill.skillId))!.owner).toEqual({ kind: "member", developerId: OWEN });
    expect(await w.store.listShares(ORG_A, shared.agentId)).toEqual([]);
    expect(await readOwnerTotal(w.deps, ORG_A, OWEN)).toBe(20);
    expect((await w.ownerEvents(agent.agentId))[0]).toMatchObject({ by: "system", cause: { kind: "member_removed", developerId: OLD_ALICE } });
    expect(w.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK)).toEqual([]);
    expect(w.logs.map((entry) => entry.event)).toContain("member_merge.survivor_gone");
    expect(w.logs.map((entry) => entry.event)).not.toContain("member_merge.rejected");
  });

  it("does the same when the end of the survivor's chain has left", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OLD_ALICE, "Old triage");
    w.merged(OLD_ALICE, ALICE);
    w.merged(ALICE, ERIN);
    w.db.delete(orgMemberKey(ORG_A, ERIN));
    w.queue(at(1), ORG_A, ALICE, OLD_ALICE);
    expect(await drainMemberMerges(w.deps, T0)).toEqual({ processed: 1, rejected: 0, failed: 0 });
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OWEN });
  });

  describe("backs off a marker that keeps failing (I2)", () => {
    const GOOD_AGENT_OWNER = OLD_ALICE;

    it("reaches the markers behind 30 that always fail, within a run or two, and records why each failed", async () => {
      const w = agentWorld();
      const good = await w.memberAgent(GOOD_AGENT_OWNER, "Old triage");
      w.merged(OLD_ALICE, ALICE);
      const stuckIds: string[] = [];
      for (let index = 0; index < 30; index += 1) {
        const duplicate = String(index + 1).padStart(64, "0");
        stuckIds.push(duplicate);
        w.db.set({ pk: `DEVELOPER#${duplicate}`, sk: "META", developerId: duplicate, mergedInto: ALICE });
        w.queue(at(index), ORG_A, ALICE, duplicate);
      }
      w.queue(at(40), ORG_A, ALICE, OLD_ALICE);
      const attempted: string[] = [];
      // Each failing attempt costs a second of the run's time, as a large org's moves would.
      await withMover({ name: "probe", merged: async (_deps, move) => {
        if (move.duplicateId === OLD_ALICE) return;
        attempted.push(move.duplicateId);
        w.clock.now += 1000;
        throw new Error("secret detail of a stuck move");
      } }, async () => {
        const first = await runMemberMergeDrain(w.deps, { budgetMs: 20_000 });
        expect(first).toMatchObject({ processed: 0, failed: 20, complete: false });
        expect((await w.store.get(ORG_A, good.agentId))!.owner).toEqual({ kind: "member", developerId: OLD_ALICE });

        const second = await runMemberMergeDrain(w.deps, { budgetMs: 20_000 });
        // The 20 that just failed wait out their back-off; the other 10 fail; the good marker behind them all goes through.
        expect(second).toMatchObject({ processed: 1, failed: 10, skipped: 20, complete: true });
      });
      expect((await w.store.get(ORG_A, good.agentId))!.owner).toEqual({ kind: "member", developerId: ALICE });
      expect(attempted.filter((id) => id === stuckIds[0])).toHaveLength(1);
      const stuck = w.db.get(memberMergeQueueKey(at(0), ORG_A, stuckIds[0]!))!;
      expect(stuck).toMatchObject({ attempts: 1, lastError: "Error" });
      expect(typeof stuck.lastTriedAt).toBe("number");
      expect(JSON.stringify(stuck)).not.toContain("secret detail");
    });

    it("waits longer after each failure, at most an hour, and tries again when the wait is over", async () => {
      const w = agentWorld();
      const duplicate = hex("7");
      w.db.set({ pk: `DEVELOPER#${duplicate}`, sk: "META", developerId: duplicate, mergedInto: ALICE });
      const key = memberMergeQueueKey(at(1), ORG_A, duplicate);
      const calls = vi.fn(async () => { throw new Error("stuck"); });
      await withMover({ name: "probe", merged: calls }, async () => {
        w.db.set({ ...key, entityType: "MEMBER_MERGE", orgId: ORG_A, survivorId: ALICE, duplicateId: duplicate, attempts: 3, lastTriedAt: w.clock.now - 19 * 60_000 });
        // Three failures wait 20 minutes (5, 10, 20): 19 minutes is still inside it.
        expect(await drainMemberMerges(w.deps, w.clock.now)).toEqual({ processed: 0, rejected: 0, failed: 0, skipped: 1 });
        expect(calls).not.toHaveBeenCalled();
        w.clock.now += 2 * 60_000;
        expect(await drainMemberMerges(w.deps, w.clock.now)).toEqual({ processed: 0, rejected: 0, failed: 1 });
        expect(w.db.get(key)).toMatchObject({ attempts: 4 });
        // Many failures never wait more than an hour.
        w.db.set({ ...w.db.get(key)!, attempts: 30, lastTriedAt: w.clock.now - 59 * 60_000 });
        expect(await drainMemberMerges(w.deps, w.clock.now)).toMatchObject({ skipped: 1 });
        w.db.set({ ...w.db.get(key)!, attempts: 30, lastTriedAt: w.clock.now - 61 * 60_000 });
        expect(await drainMemberMerges(w.deps, w.clock.now)).toMatchObject({ failed: 1 });
      });
    });

    it("logs member_merge.parked at error level from the 12th failure on, and keeps the marker", async () => {
      const w = agentWorld();
      const duplicate = hex("7");
      w.db.set({ pk: `DEVELOPER#${duplicate}`, sk: "META", developerId: duplicate, mergedInto: ALICE });
      const key = memberMergeQueueKey(at(1), ORG_A, duplicate);
      w.db.set({ ...key, entityType: "MEMBER_MERGE", orgId: ORG_A, survivorId: ALICE, duplicateId: duplicate, attempts: 10, lastTriedAt: 0 });
      await withMover({ name: "probe", merged: async () => { throw new Error("stuck"); } }, async () => {
        await drainMemberMerges(w.deps, w.clock.now);
        expect(w.logs.map((entry) => entry.event)).not.toContain("member_merge.parked");
        w.db.set({ ...w.db.get(key)!, lastTriedAt: 0 });
        await drainMemberMerges(w.deps, w.clock.now);
      });
      expect(w.db.get(key)).toMatchObject({ attempts: 12 });
      expect(w.logs.filter((entry) => entry.event === "member_merge.parked")).toEqual([{
        event: "member_merge.parked", fields: { level: "error", orgId: ORG_A, duplicateId: duplicate, attempts: 12, error: "Error" },
      }]);
    });
  });

  it("looks at the per-person cap on the run that succeeds, even when an earlier run did the moving (M1)", async () => {
    const w = agentWorld();
    await w.memberAgent(ALICE, "Alice's big one", 70);
    await w.memberAgent(OLD_ALICE, "Old big one", 60);
    w.merged(OLD_ALICE, ALICE);
    w.queue(at(1), ORG_A, ALICE, OLD_ALICE);
    let broken = true;
    await withMover({ name: "zz-flaky", merged: async () => { if (broken) throw new Error("not yet"); } }, async () => {
      expect(await drainMemberMerges(w.deps, T0)).toEqual({ processed: 0, rejected: 0, failed: 1 });
      expect(w.logs.filter((entry) => entry.event === "owner_cap.exceeded_by_move")).toEqual([]);
      broken = false;
      w.clock.now += 10 * 60_000;
      // This run moves nothing (the agents moved in the first), and still looks.
      expect(await drainMemberMerges(w.deps, T0)).toEqual({ processed: 1, rejected: 0, failed: 0 });
    });
    expect(w.logs.filter((entry) => entry.event === "owner_cap.exceeded_by_move")).toMatchObject([{ fields: { owner: ALICE, totalUsd: 130, capUsd: 100, reason: "member_merged" } }]);
  });

  it("looks at the cap of a person an earlier run of a merge gave things to, and remembers them with the survivor (Task 11 follow-up 1)", async () => {
    const w = agentWorld();
    await w.memberAgent(BOB, "Bob's first", 70);
    await w.memberAgent(BOB, "Bob's second", 60);
    w.merged(OLD_ALICE, ALICE);
    const remembered: string[][] = [];
    await onMembersMerged(w.deps, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE }, { carried: [BOB], remember: async (recipients) => { remembered.push([...recipients]); } });
    // This run moved nothing; the person an earlier run moved things to is still looked at.
    expect(w.logs.filter((entry) => entry.event === "owner_cap.exceeded_by_move")).toMatchObject([{ fields: { owner: BOB, totalUsd: 130, reason: "member_merged" } }]);
    expect(remembered).toEqual([[BOB]]);
  });

  it("looks at the survivor's cap on a run that moves nothing at all (M1)", async () => {
    const w = agentWorld();
    await w.memberAgent(ALICE, "Alice's first", 70);
    await w.memberAgent(ALICE, "Alice's second", 60);
    w.merged(OLD_ALICE, ALICE);
    w.queue(at(1), ORG_A, ALICE, OLD_ALICE);
    expect(await drainMemberMerges(w.deps, T0)).toEqual({ processed: 1, rejected: 0, failed: 0 });
    expect(w.logs.filter((entry) => entry.event === "owner_cap.exceeded_by_move")).toMatchObject([{ fields: { owner: ALICE, totalUsd: 130, reason: "member_merged" } }]);
  });

  it("looks at the first owner's cap on a removal that moves nothing at all (M1)", async () => {
    const w = agentWorld();
    await w.memberAgent(OWEN, "Owen's first", 70);
    await w.memberAgent(OWEN, "Owen's second", 60);
    w.db.delete(orgMemberKey(ORG_A, ERIN));
    await onMemberRemoved(w.deps, { orgId: ORG_A, developerId: ERIN, by: OLIVE });
    expect(w.logs.filter((entry) => entry.event === "owner_cap.exceeded_by_move")).toMatchObject([{ fields: { owner: OWEN, totalUsd: 130, reason: "member_removed" } }]);
  });

  it("remembers who a removal's accountable moves went to, and looks at their cap when a later run succeeds (M1)", async () => {
    const w = agentWorld();
    await w.memberAgent(CARA, "Cara's own", 40);
    await w.projectAgent("web", BOB, "Web helper", 70);
    let broken = true;
    const orgs = new OrgStore({ documentClient: w.db, tableName: "T", now: () => w.clock.now, memberRemoval: memberRemovalHook(w.deps) });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await withMover({ name: "zz-flaky", removed: async () => { if (broken) throw new Error("not yet"); } }, async () => {
        await orgs.removeMember({ orgId: ORG_A, developerId: BOB, emails: [], ban: false, by: { kind: "member", id: OLIVE } });
        // The first run moved web's accountable to Cara (the other maintainer by grant) and then a mover failed.
        expect(w.logs.filter((entry) => entry.event === "owner_cap.exceeded_by_move")).toEqual([]);
        broken = false;
        expect(await drainMemberRemovals(w.deps, T0)).toEqual({ processed: 1, rejected: 0, failed: 0 });
      });
    } finally { vi.restoreAllMocks(); }
    expect(w.logs.filter((entry) => entry.event === "owner_cap.exceeded_by_move")).toMatchObject([{ fields: { owner: CARA, totalUsd: 110, capUsd: 100, reason: "member_removed" } }]);
  });

  it("never treats an item in the merge partition as a removal, whatever its key says (M2)", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(ERIN, "Erin's agent");
    w.db.delete(orgMemberKey(ORG_A, ERIN));
    // The sign-in function can write this partition and no other; a removal it forged here would send Erin's things to the first owner.
    w.db.set({ pk: MEMBER_MERGE_QUEUE_PK, sk: `${at(1)}#${ORG_A}#${ERIN}#removed`, entityType: "MEMBER_REMOVAL", orgId: ORG_A, developerId: ERIN, by: OLIVE });
    expect(await drainMemberMerges(w.deps, T0)).toEqual({ processed: 0, rejected: 1, failed: 0 });
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: ERIN });
    // And the removal queue holds only removals: a merge marker put there moves nothing either.
    w.db.set({ ...memberRemovalQueueKey(at(2), ORG_A, ERIN), entityType: "MEMBER_MERGE", orgId: ORG_A, survivorId: ALICE, duplicateId: ERIN });
    expect(await drainMemberRemovals(w.deps, T0)).toEqual({ processed: 0, rejected: 1, failed: 0 });
  });

  it("takes a page of 100 markers at a time and hands back the cursor to the next", async () => {
    const w = agentWorld();
    for (let index = 0; index < 150; index += 1) {
      // No record for these duplicates: every marker is rejected, which is the cheapest way to count a page.
      w.queue(`2026-10-22T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`, ORG_A, ALICE, hex(index.toString(16).padStart(1, "0").slice(-1)) + String(index).padStart(63, "0"));
    }
    const first = await drainMemberMerges(w.deps, T0);
    expect(first).toMatchObject({ processed: 0, rejected: 100, failed: 0 });
    expect(first.next).toBeDefined();
    expect(w.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK)).toHaveLength(50);
    const second = await drainMemberMerges(w.deps, T0, first.next);
    expect(second).toEqual({ processed: 0, rejected: 50, failed: 0 });
    expect(w.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK)).toEqual([]);
  });

  it("stops before the next marker once its deadline has passed", async () => {
    const w = agentWorld();
    w.queue(at(1), ORG_A, ALICE, OLD_ALICE);
    w.queue(at(2), ORG_A, ALICE, hex("7"));
    const report = await drainMemberMerges(w.deps, T0, undefined, { deadline: T0 - 1 });
    expect(report).toEqual({ processed: 0, rejected: 0, failed: 0, stopped: true });
    expect(w.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK)).toHaveLength(2);
  });

  it("runs page after page inside a time budget", async () => {
    const w = agentWorld();
    for (let index = 0; index < 120; index += 1) w.queue(`2026-10-22T11:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`, ORG_A, ALICE, String(index).padStart(64, "0"));
    const run = await runMemberMergeDrain(w.deps, { budgetMs: 20_000 });
    // Two pages of the merge queue and the empty removal queue ahead of them.
    expect(run).toEqual({ pages: 3, processed: 0, rejected: 120, failed: 0, complete: true });
    expect(w.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK)).toEqual([]);
    // With no time at all it does not even start a page.
    const none = await runMemberMergeDrain(w.deps, { budgetMs: 0 });
    expect(none).toMatchObject({ pages: 0, complete: false });
  });
});

describe("onMemberRemoved", () => {
  /** Erin is gone from the org: her member row is deleted, as the removal's transaction leaves it. */
  const gone = (w: ReturnType<typeof agentWorld>, who: string = ERIN) => { w.db.delete(orgMemberKey(ORG_A, who)); };
  const removal = (who: string = ERIN, by: string = OLIVE) => ({ orgId: ORG_A, developerId: who, by });

  it("moves the person's agents and skills to the first org owner, with one owner_changed event that names the removal", async () => {
    const w = agentWorld();
    const first = await w.memberAgent(ERIN, "Erin's first", 12);
    const second = await w.memberAgent(ERIN, "Erin's second", 8);
    const bobs = await w.memberAgent(BOB, "Bob's agent", 5);
    const skill = await w.store.skills.create({ orgId: ORG_A, content: skillFile("erins"), owner: { kind: "member", developerId: ERIN }, by: ERIN });
    gone(w);

    // Olive removed her, and is the second owner: the agents go to the FIRST owner, Owen.
    await onMemberRemoved(w.deps, removal());

    for (const agent of [first, second]) {
      expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OWEN });
      const events = await w.ownerEvents(agent.agentId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ by: "system", to: { kind: "member", developerId: OWEN }, cause: { kind: "member_removed", developerId: ERIN } });
    }
    expect((await w.store.get(ORG_A, bobs.agentId))!.owner).toEqual({ kind: "member", developerId: BOB });
    expect((await w.store.skills.get(ORG_A, skill.skillId))!.owner).toEqual({ kind: "member", developerId: OWEN });
    // Their budgets count against Owen's total (Task 28), and no longer against Erin's.
    expect(await readOwnerTotal(w.deps, ORG_A, OWEN)).toBe(20);
    expect(await readOwnerTotal(w.deps, ORG_A, ERIN)).toBe(0);
  });

  it("gives the agents to the other owner when the first owner is the one being removed", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OWEN, "Owen's agent");
    gone(w, OWEN);
    await onMemberRemoved(w.deps, removal(OWEN, OLIVE));
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OLIVE });
  });

  it("never hands anything to the person being removed, even if their member row is still there", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OWEN, "Owen's agent");
    // Owen is the first owner and the one being removed; his row has not been deleted yet.
    await onMemberRemoved(w.deps, removal(OWEN, OLIVE));
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OLIVE });
  });

  it("skips an owner whose record says they were merged into someone else, even if their member row is still there", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(ERIN, "Erin's agent");
    w.db.set({ pk: `DEVELOPER#${OWEN}`, sk: "META", developerId: OWEN, mergedInto: OLIVE });
    gone(w);
    await onMemberRemoved(w.deps, removal());
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OLIVE });
  });

  it("deletes the person's share items on every agent, and leaves other people's shares", async () => {
    const w = agentWorld();
    const first = await w.memberAgent(BOB, "Bob's first");
    const second = await w.memberAgent(CARA, "Cara's second");
    await w.shareWith(first.agentId, ERIN, "use");
    await w.store.replaceShares({
      orgId: ORG_A, agentId: second.agentId, expectedSharesRevision: 0, by: "seed", remove: [],
      upsert: [{ principal: { kind: "member", developerId: ERIN }, level: "edit" }, { principal: { kind: "member", developerId: ALICE }, level: "view" }],
    });
    gone(w);

    await onMemberRemoved(w.deps, removal());

    expect(await w.store.listShares(ORG_A, first.agentId)).toEqual([]);
    expect((await w.store.listShares(ORG_A, second.agentId)).map((share) => (share.principal as { developerId: string }).developerId)).toEqual([ALICE]);
    expect(w.db.find((item) => item.pk === principalSharesKey(ORG_A, { kind: "member", developerId: ERIN }, "x").pk)).toEqual([]);
    expect((await w.store.get(ORG_A, first.agentId))!.sharesRevision).toBe(2);
    const unshared = (await w.store.listEvents(ORG_A, first.agentId)).filter((event) => event.kind === "shared").at(-1);
    expect(unshared).toMatchObject({ by: "system", unshared: ["MEMBER#" + ERIN], cause: { kind: "member_removed", developerId: ERIN } });
  });

  it("moves accountable to another maintainer of that project by grant, else to the first owner", async () => {
    const w = agentWorld();
    // BOB is a maintainer of web by grant (and so is CARA); `api` has no grant maintainer at all.
    const web = await w.projectAgent("web", BOB, "Web helper", 30);
    w.projectMembers.grant(ORG_A, "api", BOB, "maintainer");
    const api = await w.projectAgent("api", BOB, "Api helper", 10);
    w.projectMembers.grant(ORG_A, "api", BOB, "viewer"); // her only grant on api is no longer a maintainer's
    // BOB is an admin only so that he can be the built-in's accountable person (held to that in the write's own transaction); his maintainer grants on web and api are the test's subject.
    seedMembership(w.db, BOB, { orgId: ORG_A, role: "admin" });
    await w.store.setAccountable(ORG_A, "rovara-code", { developerId: BOB }, fixtureActor(w.store, ORG_A, "admin", true).developerId, undefined, { actor: fixtureActor(w.store, ORG_A, "admin", true) });
    gone(w, BOB);

    await onMemberRemoved(w.deps, removal(BOB));

    expect((await w.store.get(ORG_A, web.agentId))!.accountable).toEqual({ developerId: CARA });
    expect((await w.store.get(ORG_A, api.agentId))!.accountable).toEqual({ developerId: OWEN });
    expect((await w.store.getBuiltinSettings(ORG_A, "rovara-code"))!.accountable).toEqual({ developerId: OWEN });
    // The project still owns its agents.
    expect((await w.store.get(ORG_A, web.agentId))!.owner).toEqual({ kind: "project", project: "web" });
    expect(await readOwnerTotal(w.deps, ORG_A, CARA)).toBe(30);
    expect(await readOwnerTotal(w.deps, ORG_A, OWEN)).toBe(10);
    expect(await readOwnerTotal(w.deps, ORG_A, BOB)).toBe(0);
    const events = (await w.store.listEvents(ORG_A, web.agentId)).filter((event) => event.kind === "owner_changed");
    expect(events[0]).toMatchObject({ by: "system", accountable: { developerId: CARA }, cause: { kind: "member_removed", developerId: BOB } });
  });

  it("is repeatable: a second run writes nothing", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(ERIN, "Erin's first", 12);
    const shared = await w.memberAgent(BOB, "Bob's agent");
    await w.shareWith(shared.agentId, ERIN, "use");
    await w.projectAgent("web", ERIN, "Web helper", 5);
    await w.store.skills.create({ orgId: ORG_A, content: skillFile("erins"), owner: { kind: "member", developerId: ERIN }, by: ERIN });
    gone(w);
    await onMemberRemoved(w.deps, removal());
    const before = structuredClone([...w.db.items.entries()]);
    const commands = w.db.commandNames().length;

    await onMemberRemoved(w.deps, removal());

    expect(w.writesSince(commands)).toEqual([]);
    expect(structuredClone([...w.db.items.entries()])).toEqual(before);
    expect(await w.ownerEvents(agent.agentId)).toHaveLength(1);
  });

  it("moves nothing and says so when the org has no other owner (a closed org)", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(OWEN, "Owen's agent");
    gone(w, OWEN);
    gone(w, OLIVE);
    await onMemberRemoved(w.deps, removal(OWEN));
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OWEN });
    expect(w.logs.map((entry) => entry.event)).toContain("member_removed.no_successor");
  });

  it("does not hand an agent to an owner who was merged away", async () => {
    const w = agentWorld();
    const agent = await w.memberAgent(ERIN, "Erin's agent");
    w.merged(OWEN, OLIVE);
    gone(w);
    await onMemberRemoved(w.deps, removal());
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OLIVE });
  });

  it("says plainly when the move leaves the new owner over the per-person cap, and still moves (TASK 32 SEAM)", async () => {
    const w = agentWorld();
    await w.memberAgent(OWEN, "Owen's big one", 70);
    await w.memberAgent(ERIN, "Erin's big one", 60);
    gone(w);
    await onMemberRemoved(w.deps, removal());
    expect(await readOwnerTotal(w.deps, ORG_A, OWEN)).toBe(130);
    expect(w.logs.filter((entry) => entry.event === "owner_cap.exceeded_by_move")).toEqual([{
      event: "owner_cap.exceeded_by_move", fields: { orgId: ORG_A, owner: OWEN, totalUsd: 130, capUsd: 100, reason: "member_removed" },
    }]);
  });

  it("touches nothing of another org", async () => {
    const w = agentWorld();
    const theirs = await w.memberAgent(ERIN, "Erin in org B", 9, ORG_B);
    gone(w);
    await onMemberRemoved(w.deps, removal());
    expect((await w.store.get(ORG_B, theirs.agentId))!.owner).toEqual({ kind: "member", developerId: ERIN });
    expect(await w.ownerEvents(theirs.agentId, ORG_B)).toEqual([]);
  });
});

describe("OrgStore.removeMember with the lifecycle hook", () => {
  async function removalWorld(options: { hook?: (event: { orgId: OrgId; developerId: string; by: string }) => Promise<void> } = {}) {
    const w = agentWorld();
    const calls: Array<{ orgId: OrgId; developerId: string; by: string }> = [];
    const hook = options.hook ?? (async (event) => { calls.push(event); await onMemberRemoved(w.deps, event); });
    const orgs = new OrgStore({ documentClient: w.db, tableName: "T", now: () => w.clock.now, memberRemoval: { onRemoved: hook } });
    const plain = new OrgStore({ documentClient: w.db, tableName: "T", now: () => w.clock.now });
    return { ...w, orgs, plain, calls };
  }
  const markersOf = (db: FakeDynamoDb) => db.find((item) => item.pk === MEMBER_REMOVAL_QUEUE_PK);

  it("moves what the person owned as part of the removal, and leaves no marker behind", async () => {
    const w = await removalWorld();
    const agent = await w.memberAgent(ERIN, "Erin's agent", 12);

    await w.orgs.removeMember({ orgId: ORG_A, developerId: ERIN, emails: [], ban: false, by: { kind: "member", id: OLIVE } });

    expect(w.db.get(orgMemberKey(ORG_A, ERIN))).toBeUndefined();
    expect(w.calls).toEqual([expect.objectContaining({ orgId: ORG_A, developerId: ERIN, by: OLIVE, marker: expect.objectContaining({ pk: MEMBER_REMOVAL_QUEUE_PK }) as unknown, successorId: OLIVE })]);
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OLIVE });
    expect(markersOf(w.db)).toEqual([]);
  });

  it("writes the removal marker in the removal's own transaction: a removal that fails leaves none", async () => {
    const w = await removalWorld();
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(w.orgs.removeMember({ orgId: ORG_A, developerId: ERIN, emails: [], ban: false })).rejects.toThrow();
    expect(markersOf(w.db)).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it("keeps the marker, and the removal, when the hook fails; the sweep finishes the moves", async () => {
    let broken = true;
    const w = await removalWorld({ hook: async () => { if (broken) throw new Error("not yet"); } });
    const agent = await w.memberAgent(ERIN, "Erin's agent");

    await w.orgs.removeMember({ orgId: ORG_A, developerId: ERIN, emails: [], ban: false, by: { kind: "member", id: OLIVE } });

    expect(w.db.get(orgMemberKey(ORG_A, ERIN))).toBeUndefined();
    expect(markersOf(w.db)).toHaveLength(1);
    expect(markersOf(w.db)[0]).toMatchObject({ ...memberRemovalQueueKey(new Date(w.clock.now).toISOString(), ORG_A, ERIN), entityType: "MEMBER_REMOVAL", orgId: ORG_A, developerId: ERIN, by: OLIVE });
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: ERIN });

    broken = false;
    expect(await drainMemberRemovals(w.deps, T0)).toEqual({ processed: 1, rejected: 0, failed: 0 });
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OLIVE });
    expect(markersOf(w.db)).toEqual([]);
  });

  it("stops the moves it makes inside the request at their time bound, and leaves the rest to the marker (M6)", async () => {
    const w = await removalWorld();
    const agents: Array<{ agentId: AgentId }> = [];
    for (let index = 0; index < 6; index += 1) agents.push(await w.memberAgent(ERIN, `Erin's ${index}`));
    // Every look at the clock costs half a second, so a two second bound allows only a few moves.
    let ticks = 0;
    const slow = { ...w.deps, now: () => T0 + (ticks += 500) };
    const orgs = new OrgStore({ documentClient: w.db, tableName: "T", now: () => w.clock.now, memberRemoval: memberRemovalHook(slow, { budgetMs: 2000 }) });
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await orgs.removeMember({ orgId: ORG_A, developerId: ERIN, emails: [], ban: false, by: { kind: "member", id: OLIVE } });

    const owners = async () => Promise.all(agents.map(async (agent) => ((await w.store.get(ORG_A, agent.agentId))!.owner as { developerId: string }).developerId));
    const moved = (await owners()).filter((owner) => owner === OLIVE).length;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(6);
    expect(markersOf(w.db)).toHaveLength(1);
    expect(logs.mock.calls.map(([line]) => String(line)).join("\n")).toContain("member_removal.hook_failed");
    // Running out of the request's time is expected (the marker leaves the rest to the sweep): a warning, not an error (Task 11 follow-up 3).
    const hookLines = logs.mock.calls.flatMap(([line]) => { try { return [JSON.parse(String(line)) as { event?: string; level?: string; error?: string }]; } catch { return []; } }).filter((entry) => entry.event === "member_removal.hook_failed");
    expect(hookLines).toMatchObject([{ level: "warn", error: "LifecycleDeadline" }]);
    logs.mockRestore();

    // The sweep has no such bound and finishes the rest.
    expect(await runMemberMergeDrain(w.deps, { budgetMs: 20_000 })).toMatchObject({ processed: 1, failed: 0 });
    expect((await owners()).every((owner) => owner === OLIVE)).toBe(true);
    expect(markersOf(w.db)).toEqual([]);
  });

  it("writes no marker and calls nothing on an install with no hook", async () => {
    const w = await removalWorld();
    await w.plain.removeMember({ orgId: ORG_A, developerId: ERIN, emails: [], ban: false });
    expect(markersOf(w.db)).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it("a removal marker for a person who has joined again moves nothing (the hand-offs are cancelled) but is still finished", async () => {
    const w = await removalWorld({ hook: async () => { throw new Error("not yet"); } });
    const agent = await w.memberAgent(ERIN, "Erin's agent");
    await w.orgs.removeMember({ orgId: ORG_A, developerId: ERIN, emails: [], ban: false });
    w.member(ORG_A, ERIN, "member", "2026-10-22T10:00:00.000Z");

    expect(await drainMemberRemovals(w.deps, T0)).toEqual({ processed: 1, rejected: 0, failed: 0 });

    expect(markersOf(w.db)).toEqual([]);
    expect((await w.store.get(ORG_A, agent.agentId))!.owner).toEqual({ kind: "member", developerId: ERIN });
    expect(w.logs.filter((entry) => entry.event === "member_removal.handoffs_cancelled")).toEqual([{ event: "member_removal.handoffs_cancelled", fields: { orgId: ORG_A, developerId: ERIN } }]);
  });
});

// Final fix wave, access m-2: a maintainer who is demoted or removed from a project stops being accountable for that project's agents.
describe("a project maintainer who loses the role", () => {
  const accountableEvents = async (w: ReturnType<typeof agentWorld>, agentId: AgentId) => (await w.store.listEvents(ORG_A, agentId)).filter((event) => event.kind === "owner_changed");

  it("re-routes accountable to another maintainer by grant when the person is demoted, and moves the budget in the owners' totals", async () => {
    const w = agentWorld();
    const web = await w.projectAgent("web", BOB, "Web helper", 30);
    w.projectMembers.grant(ORG_A, "web", BOB, "contributor");

    await onProjectMemberChanged(w.deps, { orgId: ORG_A, project: "web", developerId: BOB });

    expect((await w.store.get(ORG_A, web.agentId))!.accountable).toEqual({ developerId: CARA });
    expect(await readOwnerTotal(w.deps, ORG_A, CARA)).toBe(30);
    expect(await readOwnerTotal(w.deps, ORG_A, BOB)).toBe(0);
    expect((await accountableEvents(w, web.agentId))[0]).toMatchObject({ by: "system", accountable: { developerId: CARA }, cause: { kind: "project_role_changed", developerId: BOB } });
    // The project still owns the agent.
    expect((await w.store.get(ORG_A, web.agentId))!.owner).toEqual({ kind: "project", project: "web" });
  });

  it("re-routes to the first org owner when no other maintainer holds a grant, and when the grant is removed", async () => {
    const w = agentWorld();
    w.projectMembers.grant(ORG_A, "api", BOB, "maintainer");
    const api = await w.projectAgent("api", BOB, "Api helper", 10);
    w.projectMembers.revoke(ORG_A, "api", BOB);

    await onProjectMemberChanged(w.deps, { orgId: ORG_A, project: "api", developerId: BOB });

    expect((await w.store.get(ORG_A, api.agentId))!.accountable).toEqual({ developerId: OWEN });
    expect(await readOwnerTotal(w.deps, ORG_A, OWEN)).toBe(10);
  });

  it("leaves an agent alone while the person still holds manage_agents on the project, another project's agent, and a second run", async () => {
    const w = agentWorld();
    const web = await w.projectAgent("web", BOB, "Web helper", 30);
    w.projectMembers.grant(ORG_A, "api", BOB, "maintainer");
    const api = await w.projectAgent("api", BOB, "Api helper", 10);
    // Still a maintainer of web: nothing moves. Demoted on api only: web's agent stays with Bob.
    await onProjectMemberChanged(w.deps, { orgId: ORG_A, project: "web", developerId: BOB });
    expect((await w.store.get(ORG_A, web.agentId))!.accountable).toEqual({ developerId: BOB });
    w.projectMembers.grant(ORG_A, "api", BOB, "viewer");
    await onProjectMemberChanged(w.deps, { orgId: ORG_A, project: "api", developerId: BOB });
    expect((await w.store.get(ORG_A, api.agentId))!.accountable).toEqual({ developerId: OWEN });
    expect((await w.store.get(ORG_A, web.agentId))!.accountable).toEqual({ developerId: BOB });
    const before = w.db.commandNames().length;
    await onProjectMemberChanged(w.deps, { orgId: ORG_A, project: "api", developerId: BOB });
    expect(w.writesSince(before)).toEqual([]);
  });

  it("keeps an org owner accountable: their org role still maintains every project", async () => {
    const w = agentWorld();
    const web = await w.projectAgent("web", OLIVE, "Web helper", 5);
    await onProjectMemberChanged(w.deps, { orgId: ORG_A, project: "web", developerId: OLIVE });
    expect((await w.store.get(ORG_A, web.agentId))!.accountable).toEqual({ developerId: OLIVE });
  });
});

describe("a project archive", () => {
  it("refuses a change of its roster with PROJECT_ARCHIVED and keeps its agents visible", async () => {
    const w = agentWorld();
    const agent = await w.projectAgent("web", BOB, "Web helper");
    w.db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "archived", createdAt: "x", createdBy: "y", archivedAt: "z", archivedBy: "y" });
    const roster = { ...w.deps, confirmOrigin: "https://cell.example.com" };

    await expect(checkRosterChange(roster, w.caller(BOB), "web", { add: agent.agentId })).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    await expect(checkRosterChange(roster, w.caller(BOB), "web", { remove: agent.agentId })).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    expect(await onProjectArchived(w.deps, { orgId: ORG_A, project: "web" })).toEqual({ rosterAgents: 0, projectAgents: 1 });
  });
});


// ---- through the broker: the routes that remove people and archive projects, and the scheduled run

describe("the broker's wiring", () => {
  async function installWithAgents(options: { agents?: boolean } = {}) {
    const h = await createDeveloperTaskBroker({ brokerExtra: options.agents === false ? {} : { agents: {} }, developerExtra: { endDeveloperSessions: vi.fn(async () => ({ ok: true as const })) } });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
    const markers = () => h.db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK || item.pk === MEMBER_REMOVAL_QUEUE_PK);
    const mayasAgent = () => store.create({ orgId: TEST_ORG, name: "Maya's agent", owner: { kind: "member", developerId: MAYA.developerId }, overlay: SCRATCH, createdBy: MAYA.developerId });
    return { ...h, store, markers, mayasAgent };
  }

  it("moves a removed member's agents to the first owner when an owner removes them, and leaves no marker", async () => {
    const h = await installWithAgents();
    const agent = await h.mayasAgent();

    const removed = await h.dev(OMAR, "DELETE", `/v1/app/org/members/${MAYA.developerId}`);

    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(h.db.get(orgMemberKey(TEST_ORG, MAYA.developerId))).toBeUndefined();
    expect((await h.store.get(TEST_ORG, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OMAR.developerId });
    expect(h.markers()).toEqual([]);
  });

  it("answers the removal and leaves a marker when the moves fail, and the scheduled run finishes them", async () => {
    const h = await installWithAgents();
    const agent = await h.mayasAgent();
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("owner_changed"), error: { name: "InternalServerError" }, times: 1 });
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const removed = await h.dev(OMAR, "DELETE", `/v1/app/org/members/${MAYA.developerId}`);

    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(h.markers()).toHaveLength(1);
    expect((await h.store.get(TEST_ORG, agent.agentId))!.owner).toEqual({ kind: "member", developerId: MAYA.developerId });
    expect(logs.mock.calls.map(([line]) => String(line))).toEqual(expect.arrayContaining([expect.stringContaining("member_removal.hook_failed")]));
    // A failure that is not the time bound stays an error.
    expect(logs.mock.calls.flatMap(([line]) => { try { return [JSON.parse(String(line)) as { event?: string; level?: string }]; } catch { return []; } }).filter((entry) => entry.event === "member_removal.hook_failed")).toMatchObject([{ level: "error" }]);

    const sweep = await h.handler({ source: "agentx.spend-settlement" });
    logs.mockRestore();
    expect(JSON.parse(sweep.body)).toMatchObject({ jobs: [{ name: "drain-member-merges", ok: true, result: { processed: 1, rejected: 0, failed: 0, complete: true } }, { name: "expire-approvals", ok: true }, { name: "escalate-owner-requests", ok: true }, { name: "resume-learning-walks", ok: true }] });
    expect((await h.store.get(TEST_ORG, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OMAR.developerId });
    expect(h.markers()).toEqual([]);
  });

  it("writes no marker where agents are not set up", async () => {
    const h = await installWithAgents({ agents: false });
    const removed = await h.dev(OMAR, "DELETE", `/v1/app/org/members/${MAYA.developerId}`);
    expect(removed.status).toBe(200);
    expect(h.markers()).toEqual([]);
  });

  it("drains a merge on the scheduled run, alongside whatever else the run does", async () => {
    const h = await installWithAgents();
    const agent = await h.mayasAgent();
    // The sign-in function merged Maya's duplicate (someone else's id) into her; the broker has not yet moved what the duplicate owned.
    const duplicate = "9".repeat(64);
    const owned = await h.store.create({ orgId: TEST_ORG, name: "The duplicate's agent", owner: { kind: "member", developerId: duplicate }, overlay: SCRATCH, createdBy: duplicate });
    h.db.set({ pk: `DEVELOPER#${duplicate}`, sk: "META", developerId: duplicate, mergedInto: MAYA.developerId });
    // (This harness puts anyone with a sign-in record in the org; the merge took the duplicate out.)
    h.db.delete(orgMemberKey(TEST_ORG, duplicate));
    h.db.delete(developerOrgKey(duplicate));
    h.db.set({ ...memberMergeQueueKey("2026-10-22T09:00:00.000Z", TEST_ORG, duplicate), entityType: "MEMBER_MERGE", orgId: TEST_ORG, survivorId: MAYA.developerId, duplicateId: duplicate });

    const sweep = await h.handler({ source: "agentx.spend-settlement" });

    expect(sweep.statusCode).toBe(200);
    expect(JSON.parse(sweep.body)).toMatchObject({ jobs: [{ name: "drain-member-merges", ok: true, result: { processed: 1, rejected: 0, failed: 0 } }, { name: "expire-approvals", ok: true }, { name: "escalate-owner-requests", ok: true }, { name: "resume-learning-walks", ok: true }] });
    expect((await h.store.get(TEST_ORG, owned.agentId))!.owner).toEqual({ kind: "member", developerId: MAYA.developerId });
    expect((await h.store.get(TEST_ORG, agent.agentId))!.owner).toEqual({ kind: "member", developerId: MAYA.developerId });
    expect(h.markers()).toEqual([]);
  });

  it("re-routes a project agent's accountable maintainer when the project's member routes demote or remove them", async () => {
    const h = await installWithAgents();
    const put = (role: string) => h.dev(OMAR, "PUT", `/v1/app/projects/payments/members/${MAYA.developerId}`, { requestId: randomUUID(), role });
    expect((await put("maintainer")).status).toBe(200);
    const agent = await h.store.create({ orgId: TEST_ORG, name: "Payments helper", owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId }, overlay: SCRATCH, createdBy: MAYA.developerId });
    expect((await put("maintainer")).status).toBe(200);
    expect((await h.store.get(TEST_ORG, agent.agentId))!.accountable).toEqual({ developerId: MAYA.developerId });

    expect((await put("contributor")).status).toBe(200);
    expect((await h.store.get(TEST_ORG, agent.agentId))!.accountable).toEqual({ developerId: OMAR.developerId });

    // Removing the grant of a maintainer does the same.
    await put("maintainer");
    await h.store.setAccountable(TEST_ORG, agent.agentId, { developerId: MAYA.developerId }, OMAR.developerId, undefined, { actor: fixtureActor(h.db, TEST_ORG, OMAR.developerId) });
    const removed = await h.dev(OMAR, "DELETE", `/v1/app/projects/payments/members/${MAYA.developerId}`, { requestId: randomUUID() });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await h.store.get(TEST_ORG, agent.agentId))!.accountable).toEqual({ developerId: OMAR.developerId });
  });

  it("tells the agents platform when a project is archived, once, and archives it whatever that does", async () => {
    const h = await installWithAgents();
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const archivedLines = () => logs.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("agents.project_archived"));
    const requestId = "11111111-1111-4111-8111-111111111111";

    const first = await h.dev(OMAR, "POST", "/v1/app/projects/payments/archive", { requestId });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(archivedLines().map((line) => JSON.parse(line) as unknown)).toEqual([{ component: "broker", event: "agents.project_archived", orgId: TEST_ORG, project: "payments", rosterAgents: 0, projectAgents: 0 }]);

    // A replay applies nothing and tells nothing; restoring tells nothing.
    expect((await h.dev(OMAR, "POST", "/v1/app/projects/payments/archive", { requestId })).status).toBe(200);
    expect((await h.dev(OMAR, "POST", "/v1/app/projects/payments/restore", { requestId: "22222222-2222-4222-8222-222222222222" })).status).toBe(200);
    expect(archivedLines()).toHaveLength(1);

    // A hook that fails never fails the archive.
    h.db.injectFault({ command: "QueryCommand", match: (input) => String((input.ExpressionAttributeValues as { ":pk"?: string } | undefined)?.[":pk"]).includes("PROJECT_AGENTS#payments"), error: { name: "InternalServerError" } });
    const again = await h.dev(OMAR, "POST", "/v1/app/projects/payments/archive", { requestId: "33333333-3333-4333-8333-333333333333" });
    logs.mockRestore();
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.project).toMatchObject({ name: "payments", status: "archived" });
  });
});
