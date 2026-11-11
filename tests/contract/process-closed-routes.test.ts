// "How we work" H8: the general agent routes refuse a project's process layer. No share write (add, change, remove), no owner or accountable move by a person, and no other agent
// built on it (create, draft save, base update). Rovara's own lifecycle moves still keep its accountable person current. An ordinary custom agent is unchanged throughout.
import { fixtureActor } from "../support/money-authority.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID, agentKey, agentXError, type AgentId } from "@rovara-code/contracts";
import { setShares, type AgentShare } from "../../packages/broker/src/agents/access.js";
import { publishDraft, shareAgent } from "../../packages/broker/src/agents/changes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import { PROCESS_BASE_USE_MESSAGE, PROCESS_OWNER_MESSAGE, PROCESS_SHARE_MESSAGE } from "../../packages/broker/src/playbook/process-closed-routes.js";
import type { ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { ARJUN, MAX, OLA, ORG_A } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

function world(): MergeWorld {
  const w = baseWorld();
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  return w;
}
function playbookDeps(w: MergeWorld): ProjectPlaybookDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: caller.developerId === OLA ? "admin" : "member" });
      if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
  };
}
const callerOf = (w: MergeWorld, who: string) => ({ ...w.caller(who), orgRole: who === OLA ? ("admin" as const) : ("member" as const) });
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const refusal = (message: string) => ({ code: "CONFIG_INVALID", message });
const member = (developerId: string, level: AgentShare["level"]): AgentShare => ({ principal: { kind: "member", developerId }, level });
const project = { kind: "project", project: "web" } as const;

async function layer(w: MergeWorld, publish = true): Promise<AgentId> {
  const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
  if (publish) {
    const agent = (await w.store.get(ORG_A, agentId))!;
    await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
  }
  return agentId;
}
async function ordinary(w: MergeWorld, name = "helper"): Promise<AgentId> {
  const agent = await w.store.create({ orgId: ORG_A, name, owner: project, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
  await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
  return agent.agentId;
}
/** An agent that was shared (as it could be before this rule) and then is a process layer: the stored share stays, so change and remove have something to act on. */
async function sharedLayer(w: MergeWorld): Promise<AgentId> {
  const id = await ordinary(w, "was shared");
  await w.store.replaceShares({ orgId: ORG_A, agentId: id, upsert: [{ principal: member(ARJUN, "view").principal, level: "view" }], remove: [], expectedSharesRevision: 0, by: MAX });
  w.db.set({ ...w.db.get(agentKey(ORG_A, id, "META"))!, purpose: "process" });
  return id;
}

describe("sharing a process layer", () => {
  it("refuses every share write: add, change a level, remove (store, access and change paths)", async () => {
    const w = world();
    const id = await sharedLayer(w);
    const sharesBefore = await w.store.listShares(ORG_A, id);
    const agent = (await w.store.get(ORG_A, id))!;
    const want = refusal(PROCESS_SHARE_MESSAGE);
    expect(await failure(w.store.replaceShares({ orgId: ORG_A, agentId: id, upsert: [{ principal: { kind: "org" }, level: "view" }], remove: [], expectedSharesRevision: 1, by: MAX }))).toEqual(want);
    expect(await failure(w.store.replaceShares({ orgId: ORG_A, agentId: id, upsert: [{ principal: member(ARJUN, "edit").principal, level: "edit" }], remove: [], expectedSharesRevision: 1, by: MAX }))).toEqual(want);
    expect(await failure(w.store.replaceShares({ orgId: ORG_A, agentId: id, upsert: [], remove: [member(ARJUN, "view").principal], expectedSharesRevision: 1, by: MAX }))).toEqual(want);
    expect(await failure(shareAgent(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), shares: [member(ARJUN, "edit")] }))).toEqual(want);
    expect(await failure(shareAgent(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), shares: [] }))).toEqual(want);
    // Sharing with the whole company would wait for a person; it is refused before anyone is asked.
    expect(await failure(shareAgent(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), shares: [{ principal: { kind: "org" }, level: "view" }] }))).toEqual(want);
    expect(await failure(setShares(w.deps, callerOf(w, MAX), id, [member(ARJUN, "edit")]))).toEqual(want);
    // Even a set that is already what is stored is refused: the answer does not depend on what happens to be there.
    expect(await failure(setShares(w.deps, callerOf(w, MAX), id, [member(ARJUN, "view")]))).toEqual(want);
    expect(await w.store.listShares(ORG_A, id)).toEqual(sharesBefore);
  });

  it("who it is shared with can still be read", async () => {
    const w = world();
    const id = await sharedLayer(w);
    expect((await w.store.listShares(ORG_A, id)).map((share) => share.principal)).toEqual([{ kind: "member", developerId: ARJUN }]);
  });

  it("Rovara's own cleanup of a departed member's share drops it and gives it to nobody", async () => {
    const w = world();
    const id = await sharedLayer(w);
    await w.store.reassignShare({ orgId: ORG_A, agentId: id, from: { kind: "member", developerId: ARJUN }, to: { kind: "member", developerId: MAX }, by: "SYSTEM", cause: { kind: "member_removed", developerId: ARJUN } });
    expect(await w.store.listShares(ORG_A, id)).toEqual([]);
  });

  it("an ordinary custom agent is shared, changed and unshared as before, and its share moves to the successor", async () => {
    const w = world();
    const id = await ordinary(w);
    const agent = (await w.store.get(ORG_A, id))!;
    expect(await shareAgent(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), shares: [member(ARJUN, "view")] })).toMatchObject({ applied: true });
    expect(await setShares(w.deps, callerOf(w, MAX), id, [member(ARJUN, "edit")])).toEqual([member(ARJUN, "edit")]);
    await w.store.reassignShare({ orgId: ORG_A, agentId: id, from: { kind: "member", developerId: ARJUN }, to: { kind: "member", developerId: OLA }, by: "SYSTEM", cause: { kind: "member_removed", developerId: ARJUN } });
    expect((await w.store.listShares(ORG_A, id)).map((share) => share.principal)).toEqual([{ kind: "member", developerId: OLA }]);
    expect(await setShares(w.deps, callerOf(w, MAX), id, [])).toEqual([]);
  });
});

describe("moving a process layer's owner or accountable person", () => {
  it("refuses an owner change (to a member, to another project) and an accountable change", async () => {
    const w = world();
    const id = await layer(w);
    const before = (await w.store.get(ORG_A, id))!;
    const want = refusal(PROCESS_OWNER_MESSAGE);
    expect(await failure(w.store.setOwner(ORG_A, id, { kind: "member", developerId: ARJUN }, fixtureActor(w.db, ORG_A, MAX).developerId, undefined, undefined, { actor: fixtureActor(w.db, ORG_A, MAX) }))).toEqual(want);
    expect(await failure(w.store.setOwner(ORG_A, id, { kind: "project", project: "other" }, fixtureActor(w.db, ORG_A, MAX).developerId, { developerId: ARJUN }, undefined, { actor: fixtureActor(w.db, ORG_A, MAX) }))).toEqual(want);
    expect(await failure(w.store.setAccountable(ORG_A, id, { developerId: ARJUN }, fixtureActor(w.db, ORG_A, MAX).developerId, undefined, { actor: fixtureActor(w.db, ORG_A, MAX) }))).toEqual(want);
    expect(await w.store.get(ORG_A, id)).toEqual(before);
  });

  it("an ordinary custom agent still moves owner and accountable person", async () => {
    const w = world();
    const id = await ordinary(w);
    await w.store.setAccountable(ORG_A, id, { developerId: OLA }, fixtureActor(w.db, ORG_A, MAX).developerId, undefined, { actor: fixtureActor(w.db, ORG_A, MAX) });
    expect((await w.store.get(ORG_A, id))?.accountable).toEqual({ developerId: OLA });
    await w.store.setOwner(ORG_A, id, { kind: "member", developerId: ARJUN }, fixtureActor(w.db, ORG_A, MAX).developerId, undefined, undefined, { actor: fixtureActor(w.db, ORG_A, MAX) });
    expect((await w.store.get(ORG_A, id))?.owner).toEqual({ kind: "member", developerId: ARJUN });
  });

  it("Rovara's own lifecycle move (a cause is given) still replaces a departed accountable person", async () => {
    const w = world();
    const id = await layer(w);
    await w.store.setAccountable(ORG_A, id, { developerId: OLA }, "system", undefined, { cause: { kind: "member_removed", developerId: MAX } });
    expect((await w.store.get(ORG_A, id))?.accountable).toEqual({ developerId: OLA });
  });
});

describe("building another agent on a process layer", () => {
  it("refuses create and draft save with the layer as the base, and leaves the draft as it was", async () => {
    const w = world();
    const id = await layer(w);
    const mine = await w.store.create({ orgId: ORG_A, name: "mine", owner: project, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    const before = (await w.store.getDraft(ORG_A, mine.agentId))!;
    const want = refusal(PROCESS_BASE_USE_MESSAGE);
    expect(await failure(w.store.create({ orgId: ORG_A, name: "child", owner: project, accountable: { developerId: MAX }, extends: id, createdBy: MAX }))).toEqual(want);
    expect(await failure(w.store.saveDraft({ orgId: ORG_A, agentId: mine.agentId, overlay: {}, extends: id, expectedRevision: before.revision, by: MAX }))).toEqual(want);
    expect(await w.store.getDraft(ORG_A, mine.agentId)).toEqual(before);
    expect((await w.store.list(ORG_A)).filter((agent) => agent.name === "child")).toHaveLength(0);
  });

  it("refuses updating the base of a draft that already builds on a process layer, and saving it again", async () => {
    const w = world();
    const id = await layer(w);
    const mine = await w.store.create({ orgId: ORG_A, name: "mine", owner: project, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    w.db.set({ ...w.db.get(agentKey(ORG_A, mine.agentId, "DRAFT"))!, extends: { agentId: id, version: 1 } });
    const want = refusal(PROCESS_BASE_USE_MESSAGE);
    expect(await failure(w.store.updateBase({ orgId: ORG_A, agentId: mine.agentId, expectedRevision: 1, by: MAX }))).toEqual(want);
    expect(await failure(w.store.saveDraft({ orgId: ORG_A, agentId: mine.agentId, overlay: { instructions: "x" }, expectedRevision: 1, by: MAX }))).toEqual(want);
  });

  it("an ordinary custom agent is still a base: create, draft save and base update", async () => {
    const w = world();
    const other = await ordinary(w);
    const child = await w.store.create({ orgId: ORG_A, name: "child", owner: project, accountable: { developerId: MAX }, extends: other, createdBy: MAX });
    expect((await w.store.getDraft(ORG_A, child.agentId))?.extends?.agentId).toBe(other);
    const saved = await w.store.saveDraft({ orgId: ORG_A, agentId: child.agentId, overlay: { instructions: "Keep it small." }, expectedRevision: 1, by: MAX });
    expect((await w.store.updateBase({ orgId: ORG_A, agentId: child.agentId, expectedRevision: saved.revision, by: MAX })).extends?.agentId).toBe(other);
    const mine = await w.store.create({ orgId: ORG_A, name: "mine", owner: project, accountable: { developerId: MAX }, createdBy: MAX });
    expect((await w.store.saveDraft({ orgId: ORG_A, agentId: mine.agentId, overlay: {}, extends: other, expectedRevision: 1, by: MAX })).extends?.agentId).toBe(other);
  });
});
