// "How we work" follow-up F4: instructions written on the pull request stage are used nowhere (the pull request description never read them, and the feedback review drops them), so a project's
// process layer can't add or change them yet. Removing what is there stays allowed. Refused wherever the overlay is written or published: create, draft save, publish (immediate, confirmed and
// in the store). Other stages' instructions and ordinary agents are unchanged.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID, agentKey, agentVersionSk, agentXError, recipeDigest, type AgentId, type RecipeOverlay } from "../../packages/contracts/src/index.js";
import { getApprovalSubjectHandler, type ApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { publishDraft, resolveRecipe, rollbackAgent } from "../../packages/broker/src/agents/changes.js";
import { routeAgentRequest } from "../../packages/broker/src/agents/routes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import type { ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { CELL, MAX, OLA, ORG_A } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const MESSAGE = "Rules for this stage aren't used yet.";
const refused = { code: "CONFIG_INVALID", message: MESSAGE };
const pr = (text: string): RecipeOverlay => ({ steps: { pull_request: { instructions: text } } });

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
const layer = async (w: MergeWorld): Promise<AgentId> => (await postProjectProcess(playbookDeps(w), w.caller(MAX), "web")).agentId;
/** Writes an overlay into the stored draft as earlier code could have: no check runs. */
const storeDraft = (w: MergeWorld, agentId: AgentId, overlay: RecipeOverlay): void => { w.db.set({ ...w.db.get(agentKey(ORG_A, agentId, "DRAFT"))!, overlay }); };
const ordinary = (w: MergeWorld, name = "helper", overlay: RecipeOverlay = {}) =>
  w.store.create({ orgId: ORG_A, name, owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, overlay, createdBy: MAX });
const save = (w: MergeWorld, id: AgentId, overlay: RecipeOverlay, expectedRevision: number) => w.store.saveDraft({ orgId: ORG_A, agentId: id, overlay, expectedRevision, by: MAX });

describe("saving a process layer's draft", () => {
  it("refuses adding pull request stage instructions in the fixed words, and leaves the draft as it was", async () => {
    const w = world();
    const id = await layer(w);
    const before = (await w.store.getDraft(ORG_A, id))!;
    expect(await failure(save(w, id, pr("Mention the ticket."), before.revision))).toEqual(refused);
    expect(await w.store.getDraft(ORG_A, id)).toEqual(before);
  });

  it("refuses changing them, allows leaving them as they are, and allows removing them", async () => {
    const w = world();
    const id = await layer(w);
    storeDraft(w, id, pr("Old text."));
    const stored = (await w.store.getDraft(ORG_A, id))!;
    expect(await failure(save(w, id, pr("New text."), stored.revision))).toEqual(refused);
    const same = await save(w, id, { ...pr("Old text."), instructions: "Keep it small." }, stored.revision);
    expect(same.overlay.steps?.pull_request?.instructions).toBe("Old text.");
    const removed = await save(w, id, { instructions: "Keep it small." }, same.revision);
    expect(removed.overlay.steps).toBeUndefined();
    expect((await w.store.getDraft(ORG_A, id))!.revision).toBe(removed.revision);
  });

  it("an empty text is a removal and is saved", async () => {
    const w = world();
    const id = await layer(w);
    expect((await save(w, id, pr(""), 1)).revision).toBe(2);
  });

  it("other stages' instructions still save, next to a pull request stage that is left alone", async () => {
    const w = world();
    const id = await layer(w);
    const saved = await save(w, id, { steps: { build: { instructions: "Run the linter." }, review: { instructions: "Check the tests." }, plan: { instructions: "Be brief." }, plan_critic: { instructions: "Be strict." } } }, 1);
    expect(Object.keys(saved.overlay.steps ?? {}).sort()).toEqual(["build", "plan", "plan_critic", "review"]);
  });

  it("an ordinary agent may still write pull request stage instructions", async () => {
    const w = world();
    const mine = await ordinary(w);
    const saved = await save(w, mine.agentId, pr("Mention the ticket."), mine.draftRevision);
    expect(saved.overlay.steps?.pull_request?.instructions).toBe("Mention the ticket.");
  });
});

describe("creating a process layer", () => {
  it("refuses one created with pull request stage instructions, and creates an ordinary agent with them", async () => {
    const w = world();
    expect(await failure(w.store.create({ orgId: ORG_A, name: "x process", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, overlay: pr("Mention the ticket."), purpose: "process", createdBy: MAX }))).toEqual(refused);
    expect((await w.store.list(ORG_A)).filter((agent) => agent.purpose === "process")).toHaveLength(0);
    const made = await ordinary(w, "with pr rules", pr("Mention the ticket."));
    expect((await w.store.getDraft(ORG_A, made.agentId))?.overlay.steps?.pull_request?.instructions).toBe("Mention the ticket.");
  });
});

describe("publishing a process layer whose stored draft has new pull request stage instructions", () => {
  it("refuses the publish through the change, the confirmation and the store, and an ordinary agent's same draft is judged by the ordinary rules", async () => {
    const w = world();
    const id = await layer(w);
    storeDraft(w, id, pr("Mention the ticket."));
    const agent = (await w.store.get(ORG_A, id))!;
    expect(await failure(publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision }))).toEqual(refused);
    const digest = recipeDigest(await resolveRecipe(w.deps, ORG_A, id, "draft"));
    const record = { orgId: ORG_A, approvalId: "apr_x", decidedBy: OLA, subject: { kind: "agent_publish", agentId: id, draftRevision: agent.draftRevision, digest } } as unknown as ApprovalRecord;
    expect(await failure(getApprovalSubjectHandler("agent_publish")!(w.deps, record))).toEqual(refused);
    expect(await failure(w.store.publish({ orgId: ORG_A, agentId: id, expectedDraftRevision: agent.draftRevision, digest, by: MAX }))).toEqual(refused);
    expect((await w.store.get(ORG_A, id))?.currentVersion).toBeUndefined();

    const other = await ordinary(w, "other", pr("Mention the ticket."));
    expect(await publishDraft(w.deps, callerOf(w, MAX), other, { requestId: randomUUID(), expectedRevision: other.draftRevision })).toHaveProperty("applied");
  });

  it("refuses before a person is asked, for a publish that would otherwise wait for one, and again when it is confirmed", async () => {
    const w = world();
    const id = await layer(w);
    // Reviewer instructions are a less-safe change: without the refusal the publish would wait for a second person.
    storeDraft(w, id, { ...pr("Mention the ticket."), steps: { ...pr("Mention the ticket.").steps, review: { instructions: "Check the tests." } } });
    const agent = (await w.store.get(ORG_A, id))!;
    expect(await failure(publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision }))).toEqual(refused);
    // A confirmation that finds the layer moved on is refused for the rules first, not told the draft is stale.
    const digest = recipeDigest(await resolveRecipe(w.deps, ORG_A, id, "draft"));
    const record = { orgId: ORG_A, approvalId: "apr_z", decidedBy: OLA, subject: { kind: "agent_publish", agentId: id, draftRevision: agent.draftRevision, digest, expectedCurrentVersion: 7 } } as unknown as ApprovalRecord;
    expect(await failure(getApprovalSubjectHandler("agent_publish")!(w.deps, record))).toEqual(refused);
  });

  it("publishes a draft whose pull request stage instructions are what the running version already has, and one that removes them", async () => {
    const w = world();
    const id = await layer(w);
    const first = (await w.store.get(ORG_A, id))!;
    await publishDraft(w.deps, callerOf(w, MAX), first, { requestId: randomUUID(), expectedRevision: first.draftRevision });
    // Version 1 as earlier code could have stored it: with pull request stage instructions.
    w.db.set({ ...w.db.get(agentKey(ORG_A, id, agentVersionSk(1)))!, overlay: pr("Old text.") });
    for (const overlay of [{ ...pr("Old text."), instructions: "Keep it small." }, { instructions: "Keep it small." }]) {
      storeDraft(w, id, overlay);
      const agent = (await w.store.get(ORG_A, id))!;
      expect(await failure(publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision }))).toBeUndefined();
    }
  });
});

describe("the agent routes", () => {
  it("refuse a process layer's draft with pull request stage instructions (400, fixed words), and take the same body for an ordinary agent", async () => {
    const w = world();
    const id = await layer(w);
    const mine = await ordinary(w);
    const put = async (agentId: AgentId, revision: number) => {
      const path = `/v1/app/agents/${agentId}/draft`;
      const body = JSON.stringify({ requestId: randomUUID(), expectedRevision: revision, overlay: pr("Mention the ticket.") });
      return failure(routeAgentRequest(w.deps as never, callerOf(w, MAX), { method: "PUT", path, requestId: "r", headers: {}, body }, new URL(`${CELL}${path}`)));
    };
    expect(await put(id, 1)).toEqual(refused);
    expect((await w.store.getDraft(ORG_A, id))!.overlay.steps).toBeUndefined();
    expect(await put(mine.agentId, 1)).toBeUndefined();
  });
});

describe("rolling a process layer back", () => {
  /** Version 1 and version 2 published; `older` is then stored into version 1 as earlier code could have written it, and `newer` into version 2. Version 2 is current. */
  async function twoVersions(w: MergeWorld, older: RecipeOverlay, newer: RecipeOverlay): Promise<AgentId> {
    const id = await layer(w);
    const first = (await w.store.get(ORG_A, id))!;
    await publishDraft(w.deps, callerOf(w, MAX), first, { requestId: randomUUID(), expectedRevision: first.draftRevision });
    const edited = await save(w, id, { instructions: "Keep it small." }, first.draftRevision);
    const second = (await w.store.get(ORG_A, id))!;
    await publishDraft(w.deps, callerOf(w, MAX), second, { requestId: randomUUID(), expectedRevision: edited.revision });
    w.db.set({ ...w.db.get(agentKey(ORG_A, id, agentVersionSk(1)))!, overlay: older });
    w.db.set({ ...w.db.get(agentKey(ORG_A, id, agentVersionSk(2)))!, overlay: newer });
    return id;
  }
  const roll = async (w: MergeWorld, id: AgentId) => rollbackAgent(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, id))!, { requestId: randomUUID(), version: 1 });

  it("refuses going back to a version that has pull request stage instructions the running one does not, in the fixed words", async () => {
    const w = world();
    const id = await twoVersions(w, pr("Old text."), { instructions: "Keep it small." });
    expect((await w.store.get(ORG_A, id))?.currentVersion).toBe(2);
    expect(await failure(roll(w, id))).toEqual(refused);
    expect((await w.store.get(ORG_A, id))?.currentVersion).toBe(2);
  });

  it("refuses it in the store too, so a confirmed rollback can't bring the text back", async () => {
    const w = world();
    const id = await twoVersions(w, pr("Old text."), { instructions: "Keep it small." });
    expect(await failure(w.store.rollback({ orgId: ORG_A, agentId: id, version: 1, expectedCurrentVersion: 2, by: MAX }))).toEqual(refused);
    expect((await w.store.get(ORG_A, id))?.currentVersion).toBe(2);
  });

  it("refuses before a person is asked, for a rollback that would otherwise wait for one", async () => {
    const w = world();
    // Reviewer instructions are a less-safe change: without the refusal the rollback would wait for a second person.
    const id = await twoVersions(w, { steps: { pull_request: { instructions: "Old text." }, review: { instructions: "Check the tests." } } }, { instructions: "Keep it small." });
    expect(await failure(roll(w, id))).toEqual(refused);
    // Early means no one was asked: no approval was created.
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(0);
    // Positive control: the same less-safe rollback without the pull request text does wait for a second person, so the lookup above sees approvals.
    const control = world();
    const controlId = await twoVersions(control, { steps: { review: { instructions: "Check the tests." } } }, { instructions: "Keep it small." });
    expect(await roll(control, controlId)).toMatchObject({ applied: false });
    expect(control.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(1);
  });

  it("refuses a different text, and allows going back to the same text, and to a version without any", async () => {
    const w = world();
    const id = await twoVersions(w, pr("Old text."), pr("Newer text."));
    expect(await failure(roll(w, id))).toEqual(refused);
    const same = world();
    const sameId = await twoVersions(same, pr("Old text."), pr("Old text."));
    expect(await failure(roll(same, sameId))).toBeUndefined();
    expect((await same.store.get(ORG_A, sameId))?.currentVersion).toBe(1);
    const none = world();
    const noneId = await twoVersions(none, { instructions: "Keep it small." }, pr("Old text."));
    expect(await failure(roll(none, noneId))).toBeUndefined();
    expect((await none.store.get(ORG_A, noneId))?.currentVersion).toBe(1);
  });

  it("an ordinary agent rolls back to a version with pull request stage instructions", async () => {
    const w = world();
    const mine = await ordinary(w, "helper", pr("Old text."));
    await publishDraft(w.deps, callerOf(w, MAX), mine, { requestId: randomUUID(), expectedRevision: mine.draftRevision });
    const edited = await save(w, mine.agentId, { instructions: "Keep it small." }, mine.draftRevision);
    const second = (await w.store.get(ORG_A, mine.agentId))!;
    await publishDraft(w.deps, callerOf(w, MAX), second, { requestId: randomUUID(), expectedRevision: edited.revision });
    const result = await rollbackAgent(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, mine.agentId))!, { requestId: randomUUID(), version: 1 });
    expect(result.applied).toBe(true);
    expect((await w.store.get(ORG_A, mine.agentId))?.currentVersion).toBe(1);
  });
});
