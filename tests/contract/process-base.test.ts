// "How we work" final review C1: a project's process layer always builds on Rovara Code. Any other base (another custom agent, a built-in that is not Rovara Code, or none) is refused
// wherever a layer's base can be set or used: create, saving the draft, publishing (immediate and confirmed), updating the base, rolling back (immediate and confirmed) and reading the
// layer as the project's process. An ordinary custom agent may still build on what it likes.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID, agentKey, agentVersionSk, agentXError, recipeDigest, type AgentId } from "../../packages/contracts/src/index.js";
import { getApprovalSubjectHandler, type ApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { publishDraft, resolveRecipe, rollbackAgent } from "../../packages/broker/src/agents/changes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import { PROCESS_BASE_MESSAGE } from "../../packages/broker/src/playbook/process-base.js";
import { projectProcessOf } from "../../packages/broker/src/playbook/project-process.js";
import { putProjectPlaybook, type ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { MAX, OLA, ORG_A } from "../support/agent-session-world.js";
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
const refused = { code: "CONFIG_INVALID", message: PROCESS_BASE_MESSAGE };

/** A published ordinary custom agent of the project's, which a layer could be re-based onto. */
async function ordinaryAgent(w: MergeWorld, name = "helper"): Promise<AgentId> {
  const agent = await w.store.create({ orgId: ORG_A, name, owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
  await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
  return agent.agentId;
}
async function layer(w: MergeWorld, publish = false): Promise<AgentId> {
  const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
  if (publish) {
    const agent = (await w.store.get(ORG_A, agentId))!;
    await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
  }
  return agentId;
}
/** Writes a base into a stored item as earlier code could have: no check runs. */
function storeBase(w: MergeWorld, agentId: AgentId, sk: string, base: { agentId: AgentId; version: number } | undefined): void {
  const item = { ...w.db.get(agentKey(ORG_A, agentId, sk as "DRAFT"))! } as Record<string, unknown>;
  if (base === undefined) delete item["extends"];
  else item["extends"] = base;
  w.db.set(item);
}

describe("creating a process layer", () => {
  it("refuses one that builds on another custom agent, a built-in that is not Rovara Code, or nothing", async () => {
    const w = world();
    const other = await ordinaryAgent(w);
    for (const base of [other, "ticket-triage" as AgentId, undefined]) {
      expect(await failure(w.store.create({ orgId: ORG_A, name: `web process ${String(base)}`.slice(0, 60), owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, purpose: "process", createdBy: MAX, ...(base === undefined ? {} : { extends: base }) })), String(base)).toEqual(refused);
    }
    expect((await w.store.list(ORG_A)).filter((agent) => agent.purpose === "process")).toHaveLength(0);
  });

  it("an ordinary agent still builds on another custom agent, or on nothing", async () => {
    const w = world();
    const other = await ordinaryAgent(w);
    const onOther = await w.store.create({ orgId: ORG_A, name: "child", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: other, createdBy: MAX });
    expect((await w.store.getDraft(ORG_A, onOther.agentId))?.extends?.agentId).toBe(other);
    const scratch = await w.store.create({ orgId: ORG_A, name: "scratch", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, createdBy: MAX });
    expect((await w.store.getDraft(ORG_A, scratch.agentId))?.extends).toBeUndefined();
  });
});

describe("saving a process layer's draft", () => {
  it("refuses re-basing onto another custom agent, a built-in that is not Rovara Code, or nothing, and leaves the draft as it was", async () => {
    const w = world();
    const other = await ordinaryAgent(w);
    const id = await layer(w);
    const before = (await w.store.getDraft(ORG_A, id))!;
    for (const base of [other, "ticket-triage" as AgentId, null]) {
      expect(await failure(w.store.saveDraft({ orgId: ORG_A, agentId: id, overlay: {}, extends: base, expectedRevision: before.revision, by: MAX })), String(base)).toEqual(refused);
    }
    expect(await w.store.getDraft(ORG_A, id)).toEqual(before);
  });

  it("still saves the rules on Rovara Code (left out, or named again)", async () => {
    const w = world();
    const id = await layer(w);
    const saved = await w.store.saveDraft({ orgId: ORG_A, agentId: id, overlay: { instructions: "Keep it small." }, expectedRevision: 1, by: MAX });
    const again = await w.store.saveDraft({ orgId: ORG_A, agentId: id, overlay: { instructions: "Keep it smaller." }, extends: ROVARA_CODE_AGENT_ID, expectedRevision: saved.revision, by: MAX });
    expect(again.extends?.agentId).toBe(ROVARA_CODE_AGENT_ID);
  });

  it("an ordinary agent may still be re-based onto another custom agent or onto nothing", async () => {
    const w = world();
    const other = await ordinaryAgent(w);
    const mine = await w.store.create({ orgId: ORG_A, name: "mine", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    const moved = await w.store.saveDraft({ orgId: ORG_A, agentId: mine.agentId, overlay: {}, extends: other, expectedRevision: 1, by: MAX });
    expect(moved.extends?.agentId).toBe(other);
    const none = await w.store.saveDraft({ orgId: ORG_A, agentId: mine.agentId, overlay: {}, extends: null, expectedRevision: moved.revision, by: MAX });
    expect(none.extends).toBeUndefined();
  });
});

describe("publishing a process layer whose stored draft does not build on Rovara Code", () => {
  for (const [label, base] of [["another custom agent", "other"], ["nothing", "none"]] as const) {
    it(`refuses the publish, immediate and confirmed (draft on ${label})`, async () => {
      const w = world();
      const other = await ordinaryAgent(w);
      const id = await layer(w);
      storeBase(w, id, "DRAFT", base === "none" ? undefined : { agentId: other, version: 1 });
      const agent = (await w.store.get(ORG_A, id))!;
      expect(await failure(publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision }))).toEqual(refused);
      // The digest the request was bound to (a draft on nothing has no recipe to digest; the refusal comes before the digest is compared).
      const digest = base === "none" ? "a".repeat(64) : recipeDigest(await resolveRecipe(w.deps, ORG_A, id, "draft"));
      const record = { orgId: ORG_A, approvalId: "apr_x", decidedBy: OLA, subject: { kind: "agent_publish", agentId: id, draftRevision: agent.draftRevision, digest } } as unknown as ApprovalRecord;
      expect(await failure(getApprovalSubjectHandler("agent_publish")!(w.deps, record))).toEqual(refused);
      expect((await w.store.get(ORG_A, id))?.currentVersion).toBeUndefined();
    });
  }

  it("an ordinary agent on another custom agent publishes as before", async () => {
    const w = world();
    const other = await ordinaryAgent(w);
    const child = await w.store.create({ orgId: ORG_A, name: "child", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: other, createdBy: MAX });
    expect(await publishDraft(w.deps, callerOf(w, MAX), child, { requestId: randomUUID(), expectedRevision: child.draftRevision })).toMatchObject({ applied: true, value: { version: 1 } });
  });
});

describe("updating a process layer's base", () => {
  it("refuses when the stored draft builds on something other than Rovara Code", async () => {
    const w = world();
    const other = await ordinaryAgent(w);
    const id = await layer(w);
    storeBase(w, id, "DRAFT", { agentId: other, version: 1 });
    expect(await failure(w.store.updateBase({ orgId: ORG_A, agentId: id, expectedRevision: 1, by: MAX }))).toEqual(refused);
  });
});

describe("rolling a process layer back to a version that does not build on Rovara Code", () => {
  /** Version 2 adds review instructions, so going back to version 1 changes them: a rollback that would wait for a person, unless it is refused first. */
  async function twoVersions(w: MergeWorld): Promise<AgentId> {
    const id = await layer(w, true);
    let agent = (await w.store.get(ORG_A, id))!;
    await w.store.saveDraft({ orgId: ORG_A, agentId: id, overlay: { steps: { review: { instructions: "Check the migrations." } } }, expectedRevision: agent.draftRevision, by: MAX });
    agent = (await w.store.get(ORG_A, id))!;
    const confirmed = await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    if (!confirmed.applied) {
      const digest = recipeDigest(await resolveRecipe(w.deps, ORG_A, id, "draft"));
      await getApprovalSubjectHandler("agent_publish")!(w.deps, { orgId: ORG_A, approvalId: "apr_v2", decidedBy: OLA, subject: { kind: "agent_publish", agentId: id, draftRevision: agent.draftRevision, digest, expectedCurrentVersion: 1 } } as unknown as ApprovalRecord);
    }
    return id;
  }

  it("refuses the rollback, through the change, the store and the confirmation", async () => {
    const w = world();
    const other = await ordinaryAgent(w);
    const id = await twoVersions(w);
    storeBase(w, id, agentVersionSk(1), { agentId: other, version: 1 });
    const agent = (await w.store.get(ORG_A, id))!;
    expect(agent.currentVersion).toBe(2);
    expect(await failure(rollbackAgent(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), version: 1 }))).toEqual(refused);
    expect(await failure(w.store.rollback({ orgId: ORG_A, agentId: id, version: 1, expectedCurrentVersion: 2, by: MAX }))).toEqual(refused);
    const digest = recipeDigest(await resolveRecipe(w.deps, ORG_A, id, 1));
    const record = { orgId: ORG_A, approvalId: "apr_y", decidedBy: OLA, subject: { kind: "agent_rollback", agentId: id, version: 1, digest, expectedCurrentVersion: 2 } } as unknown as ApprovalRecord;
    expect(await failure(getApprovalSubjectHandler("agent_rollback")!(w.deps, record))).toEqual(refused);
    expect((await w.store.get(ORG_A, id))?.currentVersion).toBe(2);
  });

  it("still rolls back to a version on Rovara Code (here one that waits for a person, as it changes the review's instructions)", async () => {
    const w = world();
    const id = await twoVersions(w);
    expect((await w.store.get(ORG_A, id))?.currentVersion).toBe(2);
    expect(await rollbackAgent(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, id))!, { requestId: randomUUID(), version: 1 })).toMatchObject({ applied: false });
    expect((await w.store.rollback({ orgId: ORG_A, agentId: id, version: 1, expectedCurrentVersion: 2, by: MAX })).currentVersion).toBe(1);
  });
});

describe("using a process layer whose current version does not build on Rovara Code", () => {
  it("is PROCESS_UNAVAILABLE for work and for the playbook PUT", async () => {
    const w = world();
    const other = await ordinaryAgent(w);
    const id = await layer(w, true);
    const reader = { documentClient: w.db, tableName: "state", store: w.store };
    expect(await projectProcessOf(reader, ORG_A, "web")).toMatchObject({ kind: "project_process", agentId: id, version: 1 });
    storeBase(w, id, agentVersionSk(1), { agentId: other, version: 1 });
    expect(await failure(projectProcessOf(reader, ORG_A, "web"))).toMatchObject({ code: "PROCESS_UNAVAILABLE" });
    storeBase(w, id, agentVersionSk(1), undefined);
    expect(await failure(projectProcessOf(reader, ORG_A, "web"))).toMatchObject({ code: "PROCESS_UNAVAILABLE" });
    const put = await failure(putProjectPlaybook(playbookDeps(w), w.caller(MAX), "web", { expectedRevision: 1, defaultProcess: { kind: "project_process", agentId: id } }));
    expect(put).toMatchObject({ code: "PROCESS_UNAVAILABLE" });
  });
});
