// Plan 3 Task 6b: who can do what with an agent (access levels, shares, visible lists, the owner rules).
import { fixtureActor, seedMaintainerGrant } from "../support/money-authority.js";
import { describe, expect, it } from "vitest";
import {
  agentAccess,
  listVisibleAgents,
  requireAgentAccess,
  requireOwnerAllowed,
  setShares,
  type AgentAccessDeps,
  type AgentCaller,
  type AgentShare,
} from "../../packages/broker/src/agents/access.js";
import { AgentStore, type AgentRecord } from "../../packages/broker/src/agents/store.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import type { AgentId, AgentOwner } from "@rovara-code/contracts";
import { BUILTIN_AGENT_IDS } from "@rovara-code/contracts";
import type { RecipeOverlay } from "@rovara-code/contracts";
import type { OrgId } from "@rovara-code/contracts";
import type { OrgRole } from "../../packages/cloud-contracts/src/org-node.js";
import { orgMemberKey } from "../../packages/cloud-contracts/src/org-node.js";
import { agentKey, orgProjectCatalogKey, principalSharesKey } from "@rovara-code/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";

const START = Date.parse("2026-10-20T09:00:00.000Z");
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);
const DAN = "d".repeat(64);
const OWEN = "e".repeat(64);
const ERIN = "f".repeat(64);
const STRANGER = "1".repeat(64);
const OLD_ALICE = "2".repeat(64);
const OLD_BOB = "3".repeat(64);
const SCRATCH: RecipeOverlay = { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] };

const ROLES: Record<string, OrgRole> = { [ALICE]: "member", [BOB]: "member", [CAROL]: "member", [DAN]: "admin", [OWEN]: "owner", [ERIN]: "member" };
const caller = (developerId: string, orgId: OrgId = ORG_A): AgentCaller => ({ orgId, developerId, orgRole: ROLES[developerId] ?? "member" });

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

function setup() {
  const db = new FakeDynamoDb();
  const clock = { now: START };
  let counter = 0;
  const store = new AgentStore({ documentClient: db, tableName: "T", now: () => clock.now, newId: () => `agt_${String(++counter).padStart(20, "0")}` });
  const projectMembers = new FakeProjectMembers();
  const deps: AgentAccessDeps = {
    store,
    projectMembers,
    documentClient: db,
    tableName: "T",
    signInStore: new DeveloperSignInStore({ documentClient: db, tableName: "T", now: () => clock.now }),
  };
  for (const [developerId, role] of Object.entries(ROLES)) {
    db.set({ ...orgMemberKey(ORG_A, developerId), entityType: "ORG_MEMBER", orgId: ORG_A, developerId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId });
  }
  // A member of org B only.
  db.set({ ...orgMemberKey(ORG_B, STRANGER), entityType: "ORG_MEMBER", orgId: ORG_B, developerId: STRANGER, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
  for (const project of ["web", "api"]) {
    db.set({ ...orgProjectCatalogKey(ORG_A, project), entityType: "PROJECT_CATALOG", name: project });
    projectMembers.addProject(ORG_A, project);
  }
  projectMembers.grant(ORG_A, "web", BOB, "maintainer");
  projectMembers.grant(ORG_A, "web", CAROL, "contributor");
  projectMembers.grant(ORG_A, "web", ERIN, "viewer");

  const memberAgent = (name: string, owner: string = ALICE, orgId: OrgId = ORG_A) =>
    store.create({ orgId, name, owner: { kind: "member", developerId: owner }, overlay: SCRATCH, createdBy: owner });
  const projectAgent = (name: string, project = "web") =>
    store.create({ orgId: ORG_A, name, owner: { kind: "project", project }, accountable: { developerId: BOB }, overlay: SCRATCH, createdBy: BOB });
  const access = (who: string, agent: AgentRecord | { agentId: AgentId }, orgId: OrgId = ORG_A) => agentAccess(deps, caller(who, orgId), agent as AgentRecord);
  const share = async (agent: AgentRecord, shares: AgentShare[], by = ALICE) => setShares(deps, caller(by), agent.agentId, shares);
  const markMerged = (duplicate: string, survivor: string) => db.set({ pk: `DEVELOPER#${duplicate}`, sk: "META", developerId: duplicate, mergedInto: survivor });
  return { db, clock, store, deps, projectMembers, memberAgent, projectAgent, access, share, markMerged };
}

describe("agentAccess", () => {
  it("gives built-in agents use to members and manage to org owners and admins, never edit", async () => {
    const { access } = setup();
    for (const agentId of BUILTIN_AGENT_IDS) {
      expect(await access(ALICE, { agentId })).toBe("use");
      expect(await access(DAN, { agentId })).toBe("manage");
      expect(await access(OWEN, { agentId })).toBe("manage");
    }
  });

  it("gives an org owner or admin manage on every custom agent", async () => {
    const { access, memberAgent, projectAgent } = setup();
    const mine = await memberAgent("Mine");
    const theirs = await projectAgent("Theirs");
    for (const who of [DAN, OWEN]) {
      expect(await access(who, mine)).toBe("manage");
      expect(await access(who, theirs)).toBe("manage");
    }
  });

  it("gives the member owner manage and an unrelated member none", async () => {
    const { access, memberAgent } = setup();
    const agent = await memberAgent("Mine");
    expect(await access(ALICE, agent)).toBe("manage");
    expect(await access(BOB, agent)).toBe("none");
    expect(await access(CAROL, agent)).toBe("none");
  });

  it("gives a project-owned agent manage to manage_agents holders and use to contributors, nothing to viewers or outsiders", async () => {
    const { access, projectAgent } = setup();
    const agent = await projectAgent("Web helper");
    expect(await access(BOB, agent)).toBe("manage");
    expect(await access(CAROL, agent)).toBe("use");
    expect(await access(ERIN, agent)).toBe("none");
    expect(await access(ALICE, agent)).toBe("none");
  });

  it("applies a member share's level to that member only", async () => {
    const { access, memberAgent, share } = setup();
    const agent = await memberAgent("Shared");
    await share(agent, [{ principal: { kind: "member", developerId: BOB }, level: "view" }, { principal: { kind: "member", developerId: CAROL }, level: "edit" }]);
    expect(await access(BOB, agent)).toBe("view");
    expect(await access(CAROL, agent)).toBe("edit");
    expect(await access(ERIN, agent)).toBe("none");
  });

  it("gives every member of the org the level of an org share", async () => {
    const { access, memberAgent, share } = setup();
    const agent = await memberAgent("Company wide");
    await share(agent, [{ principal: { kind: "org" }, level: "use" }]);
    for (const who of [BOB, CAROL, ERIN]) expect(await access(who, agent)).toBe("use");
  });

  it("gives a project share's level to holders of a role on that project, capping a viewer at view", async () => {
    const { access, memberAgent, share } = setup();
    const agent = await memberAgent("Project shared");
    await share(agent, [{ principal: { kind: "project", project: "web" }, level: "edit" }]);
    expect(await access(BOB, agent)).toBe("edit");
    expect(await access(CAROL, agent)).toBe("edit");
    expect(await access(ERIN, agent)).toBe("view");
    expect(await access(ALICE, agent)).toBe("manage");
    const useShare = await memberAgent("Project use share", ALICE);
    await share(useShare, [{ principal: { kind: "project", project: "web" }, level: "use" }]);
    expect(await access(ERIN, useShare)).toBe("view");
    expect(await access(CAROL, useShare)).toBe("use");
  });

  it("ignores a project share for someone with no role on the project", async () => {
    const { access, memberAgent, share } = setup();
    const agent = await memberAgent("Api only");
    await share(agent, [{ principal: { kind: "project", project: "api" }, level: "edit" }]);
    expect(await access(CAROL, agent)).toBe("none");
  });

  it("takes the highest of the matching rules", async () => {
    const { access, projectAgent, memberAgent, share } = setup();
    const agent = await projectAgent("Web helper");
    // A contributor is `use` through the project; an edit share to them wins.
    await share(agent, [{ principal: { kind: "member", developerId: CAROL }, level: "edit" }], BOB);
    expect(await access(CAROL, agent)).toBe("edit");
    // An org share at view does not lower a project contributor's use.
    await share(agent, [{ principal: { kind: "org" }, level: "view" }, { principal: { kind: "member", developerId: CAROL }, level: "view" }], BOB);
    expect(await access(CAROL, agent)).toBe("use");
    // Member owner stays manage whatever the shares say.
    const mine = await memberAgent("Mine");
    await share(mine, [{ principal: { kind: "member", developerId: ALICE }, level: "view" }]);
    expect(await access(ALICE, mine)).toBe("manage");
  });

  it("caps an archived agent at view for everyone but those with manage", async () => {
    const { access, memberAgent, projectAgent, share, store } = setup();
    const agent = await memberAgent("Old one");
    await share(agent, [{ principal: { kind: "member", developerId: BOB }, level: "edit" }, { principal: { kind: "member", developerId: CAROL }, level: "use" }]);
    const project = await projectAgent("Old project one");
    await store.archive(ORG_A, agent.agentId, ALICE, undefined, { actor: fixtureActor(store, ORG_A, ALICE) });
    seedMaintainerGrant(store, ORG_A, fixtureActor(store, ORG_A, BOB).developerId, "web"); // Bob archives a project's agent as its maintainer: the write pins his grant (S1-M2)
    await store.archive(ORG_A, project.agentId, BOB, undefined, { actor: fixtureActor(store, ORG_A, BOB) });
    const archived = (await store.get(ORG_A, agent.agentId))!;
    const archivedProject = (await store.get(ORG_A, project.agentId))!;
    expect(await access(ALICE, archived)).toBe("manage");
    expect(await access(DAN, archived)).toBe("manage");
    expect(await access(BOB, archived)).toBe("view");
    expect(await access(CAROL, archived)).toBe("view");
    expect(await access(ERIN, archived)).toBe("none");
    expect(await access(BOB, archivedProject)).toBe("manage");
    expect(await access(CAROL, archivedProject)).toBe("view");
  });

  it("reads an owner whose developer was merged as the survivor", async () => {
    const { access, memberAgent, markMerged } = setup();
    const agent = await memberAgent("Merged owner", OLD_ALICE);
    expect(await access(ALICE, agent)).toBe("none");
    markMerged(OLD_ALICE, ALICE);
    expect(await access(ALICE, agent)).toBe("manage");
    expect(await access(BOB, agent)).toBe("none");
  });

  it("reads a share to a merged developer as the survivor, following a chain of merges", async () => {
    const { access, memberAgent, share, db, markMerged } = setup();
    const agent = await memberAgent("Shared with merged");
    await share(agent, [{ principal: { kind: "member", developerId: BOB }, level: "edit" }]);
    // Task 11 has not moved the share yet; the share item still names a developer who has since been merged.
    db.set({ pk: `DEVELOPER#${OLD_BOB}`, sk: "META", developerId: OLD_BOB });
    for (const item of db.find((candidate) => candidate.pk === agentKey(ORG_A, agent.agentId, "META").pk && String(candidate.sk).startsWith("SHARE#"))) {
      db.delete({ pk: String(item.pk), sk: String(item.sk) });
      db.set({ ...item, sk: `SHARE#MEMBER#${OLD_BOB}`, principal: { kind: "member", developerId: OLD_BOB } });
    }
    markMerged(OLD_BOB, CAROL);
    markMerged(CAROL, ERIN);
    expect(await access(ERIN, agent)).toBe("edit");
    expect(await access(CAROL, agent)).toBe("none");
  });

  it("gives nothing for an id that is not a built-in and has no record, whoever asks", async () => {
    const { access } = setup();
    const unknown = { agentId: "agt_99999999999999999999" } as unknown as AgentRecord;
    expect(await access(ALICE, unknown)).toBe("none");
    expect(await access(DAN, unknown)).toBe("none");
    expect(await access(OWEN, unknown)).toBe("none");
  });

  it("skips a stored share whose principal is malformed, logs it, and never asks for a project role it has no name for", async () => {
    const { db, deps, projectMembers, memberAgent, access, share } = setup();
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
    deps.log = (event, fields) => logged.push({ event, fields });
    const agent = await memberAgent("Odd shares");
    await share(agent, [{ principal: { kind: "member", developerId: CAROL }, level: "use" }]);
    const base = { entityType: "AGENT_SHARE", orgId: ORG_A, agentId: agent.agentId, level: "edit", grantedBy: ALICE, grantedAt: "x" };
    const pk = agentKey(ORG_A, agent.agentId, "META").pk;
    db.set({ pk, sk: "SHARE#PROJECT#", ...base, principal: { kind: "project" } });
    db.set({ pk, sk: "SHARE#TEAM#x", ...base, principal: { kind: "team", id: "x" } });
    db.set({ pk, sk: "SHARE#NOPE", ...base });
    projectMembers.calls.length = 0;
    expect(await access(CAROL, agent)).toBe("use");
    expect(await access(BOB, agent)).toBe("none");
    expect(projectMembers.calls.filter((call) => call.includes("undefined"))).toEqual([]);
    expect(logged.length).toBeGreaterThanOrEqual(3);
    expect(logged[0]).toMatchObject({ event: "agent_share_skipped", fields: { agentId: agent.agentId } });
  });

  it("saves shares over corrupted stored rows: they are skipped and logged, never mistaken for a real share, and never make the save throw", async () => {
    const { db, store, deps, memberAgent, share } = setup();
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
    deps.log = (event, fields) => logged.push({ event, fields });
    const agent = await memberAgent("Odd rows");
    const base = { entityType: "AGENT_SHARE", orgId: ORG_A, agentId: agent.agentId, level: "view", grantedBy: ALICE, grantedAt: "x" };
    const pk = agentKey(ORG_A, agent.agentId, "META").pk;
    // An unknown kind reads as "ORG" under principalKey, with the very level the manager is about to set; a row with no principal
    // used to make principalKey throw.
    db.set({ pk, sk: "SHARE#TEAM#x", ...base, principal: { kind: "team", id: "x" } });
    db.set({ pk, sk: "SHARE#NOPE", ...base });
    db.set({ pk, sk: "SHARE#PROJECT#", ...base, principal: { kind: "project" } });

    const saved = await share(agent, [{ principal: { kind: "org" }, level: "view" }, { principal: { kind: "member", developerId: BOB }, level: "use" }]);
    expect(saved).toHaveLength(2);
    // The real company-wide share was written, not skipped as "already there".
    expect(db.get(agentKey(ORG_A, agent.agentId, "SHARE#ORG"))).toMatchObject({ principal: { kind: "org" }, level: "view" });
    expect(db.get(principalSharesKey(ORG_A, { kind: "org" }, agent.agentId))).toMatchObject({ level: "view" });
    expect(logged.filter((entry) => entry.event === "agent_share_skipped")).toHaveLength(3);
    // The corrupted rows are left alone, and a second identical save is a no-op.
    expect(db.get({ pk, sk: "SHARE#TEAM#x" })).toBeDefined();
    const before = db.commandNames().filter((name) => name === "TransactWriteCommand").length;
    await share(agent, [{ principal: { kind: "org" }, level: "view" }, { principal: { kind: "member", developerId: BOB }, level: "use" }]);
    expect(db.commandNames().filter((name) => name === "TransactWriteCommand").length).toBe(before);
    expect((await store.listShares(ORG_A, agent.agentId)).length).toBe(5);
  });

  it("gives nothing across orgs", async () => {
    const { access, memberAgent, share } = setup();
    const agent = await memberAgent("Org A only");
    await share(agent, [{ principal: { kind: "org" }, level: "edit" }]);
    expect(await access(STRANGER, agent, ORG_B)).toBe("none");
    expect(await access(OWEN, agent, ORG_B)).toBe("none");
  });
});

describe("requireAgentAccess", () => {
  it("returns the agent and the level when the caller has enough", async () => {
    const { deps, memberAgent } = setup();
    const agent = await memberAgent("Mine");
    const found = await requireAgentAccess(deps, caller(ALICE), agent.agentId, "edit");
    expect(found.access).toBe("manage");
    expect(found.agent).toMatchObject({ agentId: agent.agentId, name: "Mine" });
  });

  it("answers NOT_FOUND, the same as a missing agent, when the caller can't even view it", async () => {
    const { deps, memberAgent } = setup();
    const agent = await memberAgent("Private");
    const hidden = await code(requireAgentAccess(deps, caller(BOB), agent.agentId, "view"));
    const missing = await code(requireAgentAccess(deps, caller(BOB), "agt_99999999999999999999", "view"));
    expect(hidden).toEqual({ code: "NOT_FOUND", message: "no agent has that ID" });
    expect(missing).toEqual(hidden);
    expect(await code(requireAgentAccess(deps, caller(STRANGER, ORG_B), agent.agentId, "view"))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers FORBIDDEN with what the caller can do and who the wanted level needs", async () => {
    const { deps, memberAgent, projectAgent, share } = setup();
    const agent = await memberAgent("Payments Expert");
    await share(agent, [{ principal: { kind: "member", developerId: BOB }, level: "view" }, { principal: { kind: "member", developerId: CAROL }, level: "use" }]);
    expect(await code(requireAgentAccess(deps, caller(BOB), agent.agentId, "use"))).toEqual({ code: "FORBIDDEN", message: "You can view Payments Expert; use needs its owner or an org admin to share it with you." });
    expect(await code(requireAgentAccess(deps, caller(CAROL), agent.agentId, "edit"))).toEqual({ code: "FORBIDDEN", message: "You can use Payments Expert; edit needs its owner or an org admin to give you edit access." });
    expect(await code(requireAgentAccess(deps, caller(CAROL), agent.agentId, "manage"))).toEqual({ code: "FORBIDDEN", message: "You can use Payments Expert; manage needs its owner or an org admin." });
    const project = await projectAgent("Web helper");
    expect(await code(requireAgentAccess(deps, caller(CAROL), project.agentId, "manage"))).toEqual({ code: "FORBIDDEN", message: "You can use Web helper; manage needs a maintainer of web or an org admin." });
  });

  it("says an archived agent needs its owner to restore it", async () => {
    const { deps, memberAgent, share, store } = setup();
    const agent = await memberAgent("Retired");
    await share(agent, [{ principal: { kind: "member", developerId: BOB }, level: "use" }]);
    await store.archive(ORG_A, agent.agentId, ALICE, undefined, { actor: fixtureActor(store, ORG_A, ALICE) });
    expect(await code(requireAgentAccess(deps, caller(BOB), agent.agentId, "use"))).toEqual({ code: "FORBIDDEN", message: "You can view Retired; use needs its owner or an org admin to unarchive it." });
    expect((await requireAgentAccess(deps, caller(BOB), agent.agentId, "view")).access).toBe("view");
  });

  it("names a project's maintainers too when an archived project agent needs unarchiving", async () => {
    const { deps, projectAgent, store } = setup();
    const agent = await projectAgent("Retired web helper");
    seedMaintainerGrant(store, ORG_A, fixtureActor(store, ORG_A, BOB).developerId, "web"); // Bob archives a project's agent as its maintainer: the write pins his grant (S1-M2)
    await store.archive(ORG_A, agent.agentId, BOB, undefined, { actor: fixtureActor(store, ORG_A, BOB) });
    expect(await code(requireAgentAccess(deps, caller(CAROL), agent.agentId, "use"))).toEqual({
      code: "FORBIDDEN",
      message: "You can view Retired web helper; use needs a maintainer of web or an org admin to unarchive it.",
    });
  });

  it("answers for built-in agents: use for members, manage for admins, and no edit for anyone", async () => {
    const { deps } = setup();
    expect((await requireAgentAccess(deps, caller(ALICE), "ticket-triage", "use")).access).toBe("use");
    expect(await code(requireAgentAccess(deps, caller(ALICE), "ticket-triage", "manage"))).toEqual({ code: "FORBIDDEN", message: "You can use Ticket triage; manage needs an org owner or admin." });
    expect((await requireAgentAccess(deps, caller(DAN), "ticket-triage", "manage")).access).toBe("manage");
    expect(await code(requireAgentAccess(deps, caller(DAN), "ticket-triage", "edit"))).toEqual({ code: "FORBIDDEN", message: "Built-in agents can't be edited. Build on Ticket triage to change it." });
  });
});

describe("setShares", () => {
  const BOB_VIEW: AgentShare = { principal: { kind: "member", developerId: BOB }, level: "view" };
  const WEB_USE: AgentShare = { principal: { kind: "project", project: "web" }, level: "use" };

  it("writes the share items, the share-index items and one shared event in one transaction", async () => {
    const { db, store, memberAgent, share } = setup();
    const agent = await memberAgent("Shared");
    const before = db.commandNames().filter((name) => name === "TransactWriteCommand").length;
    const saved = await share(agent, [BOB_VIEW, WEB_USE, { principal: { kind: "org" }, level: "view" }]);
    expect(db.commandNames().filter((name) => name === "TransactWriteCommand").length - before).toBe(1);
    expect(saved).toHaveLength(3);
    expect(await store.listShares(ORG_A, agent.agentId)).toEqual(expect.arrayContaining([expect.objectContaining(BOB_VIEW), expect.objectContaining(WEB_USE)]));
    expect(db.get(principalSharesKey(ORG_A, BOB_VIEW.principal, agent.agentId))).toMatchObject({ agentId: agent.agentId, level: "view" });
    expect(db.get(principalSharesKey(ORG_A, { kind: "org" }, agent.agentId))).toMatchObject({ level: "view" });
    expect(db.get(principalSharesKey(ORG_A, WEB_USE.principal, agent.agentId))).toMatchObject({ level: "use" });
    const events = db.find((item) => item.pk === agentKey(ORG_A, agent.agentId, "META").pk && String(item.sk).startsWith("EVENT#") && item.kind === "shared");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ by: ALICE });
  });

  it("replaces the whole set: a dropped share and its index item go, a changed level changes, an unchanged one stays", async () => {
    const { db, store, memberAgent, share } = setup();
    const agent = await memberAgent("Shared");
    await share(agent, [BOB_VIEW, WEB_USE]);
    await share(agent, [{ ...BOB_VIEW, level: "edit" }, { principal: { kind: "org" }, level: "view" }]);
    const shares = await store.listShares(ORG_A, agent.agentId);
    expect(shares.map((entry) => [entry.principal.kind, entry.level]).sort()).toEqual([["member", "edit"], ["org", "view"]]);
    expect(db.get(principalSharesKey(ORG_A, WEB_USE.principal, agent.agentId))).toBeUndefined();
    expect(db.get(principalSharesKey(ORG_A, BOB_VIEW.principal, agent.agentId))).toMatchObject({ level: "edit" });
    await share(agent, []);
    expect(await store.listShares(ORG_A, agent.agentId)).toEqual([]);
    expect(db.find((item) => String(item.pk).includes("AGENT_SHARES#"))).toEqual([]);
  });

  it("writes nothing, not even an event, when the set is unchanged", async () => {
    const { db, memberAgent, share } = setup();
    const agent = await memberAgent("Shared");
    await share(agent, [BOB_VIEW]);
    const items = db.items.size;
    await share(agent, [BOB_VIEW]);
    expect(db.items.size).toBe(items);
  });

  it("refuses an unknown member, a member of another org and an unknown project with CONFIG_INVALID, writing nothing", async () => {
    const { db, memberAgent, share } = setup();
    const agent = await memberAgent("Shared");
    const items = db.items.size;
    expect(await code(share(agent, [BOB_VIEW, { principal: { kind: "member", developerId: "9".repeat(64) }, level: "view" }]))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("shares.1") as string });
    expect(await code(share(agent, [{ principal: { kind: "member", developerId: STRANGER }, level: "use" }]))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(share(agent, [{ principal: { kind: "project", project: "nope" }, level: "use" }]))).toEqual({ code: "CONFIG_INVALID", message: "shares.0: no project called nope in your company" });
    expect(db.items.size).toBe(items);
  });

  it("stores a merged member's survivor, in the share and in its index item, and replaces a share stored under the old id", async () => {
    const { db, store, memberAgent, share, markMerged } = setup();
    markMerged(OLD_BOB, BOB);
    const agent = await memberAgent("Shared with merged");
    const saved = await share(agent, [{ principal: { kind: "member", developerId: OLD_BOB }, level: "view" }]);
    expect(saved).toEqual([BOB_VIEW]);
    expect((await store.listShares(ORG_A, agent.agentId)).map((entry) => entry.principal)).toEqual([BOB_VIEW.principal]);
    expect(db.get(principalSharesKey(ORG_A, BOB_VIEW.principal, agent.agentId))).toMatchObject({ level: "view" });
    expect(db.get(principalSharesKey(ORG_A, { kind: "member", developerId: OLD_BOB }, agent.agentId))).toBeUndefined();
    // A share written before the merge, under the old id, is dropped and re-made under the survivor.
    const legacy = await memberAgent("Legacy share");
    db.set({ ...agentKey(ORG_A, legacy.agentId, `SHARE#MEMBER#${OLD_BOB}`), entityType: "AGENT_SHARE", orgId: ORG_A, agentId: legacy.agentId, principal: { kind: "member", developerId: OLD_BOB }, level: "view", grantedBy: ALICE, grantedAt: "x" });
    db.set({ ...principalSharesKey(ORG_A, { kind: "member", developerId: OLD_BOB }, legacy.agentId), entityType: "AGENT_SHARE_INDEX", agentId: legacy.agentId, level: "view" });
    await share(legacy, [BOB_VIEW]);
    expect((await store.listShares(ORG_A, legacy.agentId)).map((entry) => entry.principal)).toEqual([BOB_VIEW.principal]);
    expect(db.get(principalSharesKey(ORG_A, { kind: "member", developerId: OLD_BOB }, legacy.agentId))).toBeUndefined();
  });

  it("refuses a member named twice once merged ids are resolved, so there is one share per person", async () => {
    const { memberAgent, share, markMerged, store } = setup();
    markMerged(OLD_BOB, BOB);
    const agent = await memberAgent("Twice");
    expect(await code(share(agent, [{ principal: { kind: "member", developerId: OLD_BOB }, level: "view" }, BOB_VIEW]))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("shares.1") as string });
    expect(await store.listShares(ORG_A, agent.agentId)).toEqual([]);
  });

  it("refuses a project that is only in another org's catalog", async () => {
    const { db, memberAgent, share } = setup();
    db.set({ ...orgProjectCatalogKey(ORG_B, "ghost"), entityType: "PROJECT_CATALOG", name: "ghost" });
    const agent = await memberAgent("Ghost share");
    expect(await code(share(agent, [{ principal: { kind: "project", project: "ghost" }, level: "use" }]))).toEqual({ code: "CONFIG_INVALID", message: "shares.0: no project called ghost in your company" });
    expect(db.find((item) => String(item.sk).startsWith("SHARE#"))).toEqual([]);
  });

  it("refuses more than 50 shares, a repeated principal and a level that is not view, use or edit", async () => {
    const { memberAgent, share, db } = setup();
    const agent = await memberAgent("Shared");
    const many: AgentShare[] = Array.from({ length: 51 }, (_, index) => ({ principal: { kind: "member", developerId: String(index).padStart(64, "0") }, level: "view" }));
    expect(await code(share(agent, many))).toEqual({ code: "CONFIG_INVALID", message: "shares: an agent can be shared with at most 50 people or groups" });
    expect(await code(share(agent, [BOB_VIEW, { ...BOB_VIEW, level: "use" }]))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("shares.1") as string });
    expect(await code(share(agent, [{ principal: BOB_VIEW.principal, level: "manage" as "edit" }]))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(db.find((item) => String(item.sk).startsWith("SHARE#"))).toEqual([]);
  });

  it("takes 50 shares, and refuses a save that changes more than fits in one transaction", async () => {
    const { db, memberAgent, share, deps } = setup();
    const agent = await memberAgent("Wide");
    const people = Array.from({ length: 50 }, (_, index) => String(index + 1).padStart(64, "0"));
    for (const developerId of people) db.set({ ...orgMemberKey(ORG_A, developerId), entityType: "ORG_MEMBER", orgId: ORG_A, developerId, role: "member", joinedAt: "x" });
    const everyone = (level: "view" | "use"): AgentShare[] => people.map((developerId) => ({ principal: { kind: "member", developerId }, level }));
    // 50 new shares: 100 items plus the agent and the event would be too many for one transaction, so it is refused in words.
    expect(await code(share(agent, everyone("view")))).toEqual({ code: "CONFIG_INVALID", message: "shares: change at most 48 people or groups in one save" });
    expect(await share(agent, everyone("view").slice(0, 48))).toHaveLength(48);
    expect(await setShares(deps, caller(ALICE), agent.agentId, everyone("view"))).toHaveLength(50);
    expect(await code(share(agent, everyone("use")))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("lets one of two concurrent saves win and tells the other to reload", async () => {
    const { memberAgent, share, store } = setup();
    const agent = await memberAgent("Race");
    const results = await Promise.all([
      code(share(agent, [BOB_VIEW])),
      code(share(agent, [{ principal: { kind: "member", developerId: CAROL }, level: "view" }])),
    ]);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    expect(results.find((result) => result !== undefined)).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect(await store.listShares(ORG_A, agent.agentId)).toHaveLength(1);
  });

  it("needs manage: an editor is FORBIDDEN, a stranger gets NOT_FOUND, a project maintainer and an org admin may", async () => {
    const { memberAgent, projectAgent, share } = setup();
    const agent = await memberAgent("Mine");
    await share(agent, [{ principal: { kind: "member", developerId: CAROL }, level: "edit" }]);
    expect(await code(share(agent, [], CAROL))).toMatchObject({ code: "FORBIDDEN" });
    expect(await code(share(agent, [], BOB))).toMatchObject({ code: "NOT_FOUND" });
    expect(await share(agent, [BOB_VIEW], DAN)).toHaveLength(1);
    const project = await projectAgent("Web helper");
    expect(await share(project, [BOB_VIEW], BOB)).toHaveLength(1);
    expect(await code(share(project, [], CAROL))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses to share a built-in agent, which belongs to the whole company", async () => {
    const { deps } = setup();
    expect(await code(setShares(deps, caller(DAN), "ticket-triage", [BOB_VIEW]))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("never reads or writes another org's agent", async () => {
    const { deps, memberAgent } = setup();
    const agent = await memberAgent("Org A");
    expect(await code(setShares(deps, caller(STRANGER, ORG_B), agent.agentId, []))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listVisibleAgents", () => {
  async function world() {
    const w = setup();
    const mine = await w.memberAgent("Alice's own");
    const bobs = await w.memberAgent("Bob's own", BOB);
    const sharedToCarol = await w.memberAgent("Shared to Carol", BOB);
    await w.share(sharedToCarol, [{ principal: { kind: "member", developerId: CAROL }, level: "use" }], BOB);
    const companyWide = await w.memberAgent("Company wide", BOB);
    await w.share(companyWide, [{ principal: { kind: "org" }, level: "view" }], BOB);
    w.projectMembers.grant(ORG_A, "api", BOB, "maintainer");
    const web = await w.projectAgent("Web helper", "web");
    const api = await w.projectAgent("Api helper", "api");
    const sharedToWeb = await w.memberAgent("Shared to web", BOB);
    await w.share(sharedToWeb, [{ principal: { kind: "project", project: "web" }, level: "view" }], BOB);
    const otherOrg = await w.memberAgent("Other org", STRANGER, ORG_B);
    const names = async (who: string, scope: Parameters<typeof listVisibleAgents>[2]) => (await listVisibleAgents(w.deps, caller(who), scope)).map((entry) => entry.name).sort();
    return { ...w, mine, bobs, sharedToCarol, companyWide, web, api, sharedToWeb, otherOrg, names };
  }

  it("lists, for scope all, the built-ins and every custom agent the caller can view, with the access they hold", async () => {
    const w = await world();
    const alice = await listVisibleAgents(w.deps, caller(ALICE), "all");
    expect(alice.filter((entry) => entry.builtin)).toHaveLength(BUILTIN_AGENT_IDS.length);
    expect(alice.filter((entry) => !entry.builtin).map((entry) => entry.name).sort()).toEqual(["Alice's own", "Company wide"]);
    expect(alice.find((entry) => entry.name === "Alice's own")).toMatchObject({ access: "manage", builtin: false });
    expect(alice.find((entry) => entry.name === "Company wide")).toMatchObject({ access: "view" });
    const carol = (await listVisibleAgents(w.deps, caller(CAROL), "all")).filter((entry) => !entry.builtin);
    expect(carol.map((entry) => `${entry.name}:${entry.access}`).sort()).toEqual(["Company wide:view", "Shared to Carol:use", "Shared to web:view", "Web helper:use"]);
    const dan = (await listVisibleAgents(w.deps, caller(DAN), "all")).filter((entry) => !entry.builtin);
    expect(dan).toHaveLength(7);
    expect(dan.every((entry) => entry.access === "manage")).toBe(true);
  });

  it("never lists another org's agents", async () => {
    const w = await world();
    expect(await w.names(OWEN, "all")).not.toContain("Other org");
    const theirs = await listVisibleAgents(w.deps, caller(STRANGER, ORG_B), "all");
    expect(theirs.filter((entry) => !entry.builtin).map((entry) => entry.name)).toEqual(["Other org"]);
  });

  it("lists, for scope mine, the agents the caller owns or is accountable for", async () => {
    const w = await world();
    expect(await w.names(ALICE, "mine")).toEqual(["Alice's own"]);
    // BOB owns three member agents and is accountable for both project agents.
    expect(await w.names(BOB, "mine")).toEqual(["Api helper", "Bob's own", "Company wide", "Shared to Carol", "Shared to web", "Web helper"]);
    expect(await w.names(DAN, "mine")).toEqual([]);
  });

  it("reads a merged accountable id as the survivor for scope mine", async () => {
    const w = await world();
    w.markMerged(OLD_BOB, BOB);
    await w.store.create({ orgId: ORG_A, name: "Old accountable", owner: { kind: "project", project: "web" }, accountable: { developerId: OLD_BOB }, overlay: SCRATCH, createdBy: DAN });
    expect(await w.names(BOB, "mine")).toContain("Old accountable");
    expect(await w.names(CAROL, "mine")).not.toContain("Old accountable");
  });

  it("lists, for scope shared, the agents others shared with the caller", async () => {
    const w = await world();
    expect(await w.names(CAROL, "shared")).toEqual(["Company wide", "Shared to Carol", "Shared to web"]);
    expect(await w.names(ALICE, "shared")).toEqual(["Company wide"]);
    expect(await w.names(BOB, "shared")).toEqual([]);
  });

  it("lists, for scope builtin, the six built-ins with the caller's access", async () => {
    const w = await world();
    const member = await listVisibleAgents(w.deps, caller(ALICE), "builtin");
    expect(member.map((entry) => entry.agentId).sort()).toEqual([...BUILTIN_AGENT_IDS].sort());
    expect(member.every((entry) => entry.builtin && entry.access === "use")).toBe(true);
    expect((await listVisibleAgents(w.deps, caller(DAN), "builtin")).every((entry) => entry.access === "manage")).toBe(true);
  });

  it("lists, for a project scope, agents the project owns or that are shared with it, that the caller can view", async () => {
    const w = await world();
    expect(await w.names(CAROL, { project: "web" })).toEqual(["Shared to web", "Web helper"]);
    expect(await w.names(CAROL, { project: "api" })).toEqual([]);
    expect(await w.names(DAN, { project: "api" })).toEqual(["Api helper"]);
    expect(await w.names(ALICE, { project: "web" })).toEqual([]);
  });

  it("keeps an archived agent in the list, with access capped at view", async () => {
    const w = await world();
    await w.store.archive(ORG_A, w.sharedToCarol.agentId, BOB, undefined, { actor: fixtureActor(w.store, ORG_A, BOB) });
    const carol = await listVisibleAgents(w.deps, caller(CAROL), "all");
    expect(carol.find((entry) => entry.name === "Shared to Carol")).toMatchObject({ access: "view", record: { status: "archived" } });
  });
});

describe("requireOwnerAllowed", () => {
  const member = (developerId: string): AgentOwner => ({ kind: "member", developerId });
  const project = (name: string): AgentOwner => ({ kind: "project", project: name });

  it("lets a member own an agent themselves, and an org owner or admin name any member", async () => {
    const { deps } = setup();
    await requireOwnerAllowed(deps, caller(ALICE), member(ALICE));
    await requireOwnerAllowed(deps, caller(DAN), member(ALICE));
    await requireOwnerAllowed(deps, caller(OWEN), member(BOB));
  });

  it("refuses a member who names someone else as the owner", async () => {
    const { deps } = setup();
    expect(await code(requireOwnerAllowed(deps, caller(ALICE), member(BOB)))).toEqual({
      code: "FORBIDDEN",
      message: "Only an org owner or admin can make someone else an agent's owner.",
    });
  });

  it("needs manage_agents on a project the agent belongs to", async () => {
    const { deps } = setup();
    await requireOwnerAllowed(deps, caller(BOB), project("web"));
    await requireOwnerAllowed(deps, caller(DAN), project("api"));
    expect(await code(requireOwnerAllowed(deps, caller(CAROL), project("web")))).toEqual({
      code: "FORBIDDEN",
      message: "Only a maintainer of web can make it an agent's owner.",
    });
    expect(await code(requireOwnerAllowed(deps, caller(ERIN), project("web")))).toMatchObject({ code: "FORBIDDEN" });
    expect(await code(requireOwnerAllowed(deps, caller(ALICE), project("web")))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("needs an org owner or admin to hand an agent to another member", async () => {
    const { deps } = setup();
    expect(await code(requireOwnerAllowed(deps, caller(ALICE), member(BOB), member(ALICE)))).toEqual({
      code: "FORBIDDEN",
      message: "Only an org owner or admin can hand an agent to another member.",
    });
    await requireOwnerAllowed(deps, caller(DAN), member(BOB), member(ALICE));
  });

  it("treats moving a project's agent to any member, the caller included, as a hand-over that needs an org owner or admin", async () => {
    const { deps } = setup();
    const refusal = { code: "FORBIDDEN", message: "Only an org owner or admin can hand an agent to another member." };
    expect(await code(requireOwnerAllowed(deps, caller(BOB), member(BOB), project("web")))).toEqual(refusal);
    expect(await code(requireOwnerAllowed(deps, caller(BOB), member(CAROL), project("web")))).toEqual(refusal);
    await requireOwnerAllowed(deps, caller(DAN), member(BOB), project("web"));
    // A member keeping their own agent is no transfer.
    await requireOwnerAllowed(deps, caller(ALICE), member(ALICE), member(ALICE));
  });

  it("refuses an owner who is not in the org or a project that does not exist, with CONFIG_INVALID", async () => {
    const { deps } = setup();
    expect(await code(requireOwnerAllowed(deps, caller(DAN), member("9".repeat(64))))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("owner") as string });
    expect(await code(requireOwnerAllowed(deps, caller(DAN), member(STRANGER)))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(requireOwnerAllowed(deps, caller(DAN), project("nope")))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("reads a merged owner as the survivor, so the survivor passes the same-person check, and returns the survivor to store", async () => {
    const { deps, markMerged } = setup();
    markMerged(OLD_ALICE, ALICE);
    expect(await requireOwnerAllowed(deps, caller(ALICE), member(OLD_ALICE))).toEqual(member(ALICE));
    markMerged(OLD_BOB, BOB);
    expect(await requireOwnerAllowed(deps, caller(DAN), member(OLD_BOB))).toEqual(member(BOB));
    expect(await requireOwnerAllowed(deps, caller(BOB), project("web"))).toEqual(project("web"));
  });
});
