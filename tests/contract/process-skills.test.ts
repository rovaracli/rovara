// "How we work" follow-up F2: a project's process layer can't add or remove skills yet. A skill reaches every step but the check, the plan check and the reviewers included, and no
// less-safe rule covers it, so it is refused wherever a layer's overlay can be written or used: create, saving the draft, publishing (immediate and confirmed), updating the base,
// rolling back (immediate and confirmed), the agent routes and reading the layer as the project's process. A stored layer that has skills anyway still sends none to the reviewing
// stages. Ordinary agents are unchanged.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../../packages/contracts/src/agent-templates.js";
import { DEFAULT_AGENT_GUARDRAILS } from "../../packages/contracts/src/agent-guardrails.js";
import { applyOverlay, type RecipeLayer, type ResolvedRecipe } from "../../packages/contracts/src/agent-recipe-node.js";
import { ROVARA_CODE_AGENT_ID, agentKey, agentVersionSk, agentXError, recipeDigest, type AgentId, type RecipeOverlay } from "../../packages/contracts/src/index.js";
import { getApproval, getApprovalSubjectHandler, type ApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { publishDraft, resolveRecipe, rollbackAgent } from "../../packages/broker/src/agents/changes.js";
import { applyAgentStep, type DispatchMode } from "../../packages/broker/src/agents/dispatch.js";
import { routeAgentRequest } from "../../packages/broker/src/agents/routes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import { PROCESS_SKILLS_MESSAGE } from "../../packages/broker/src/playbook/process-skills.js";
import { projectProcessOf } from "../../packages/broker/src/playbook/project-process.js";
import type { ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { CELL, MAX, OLA, ORG_A } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const MESSAGE = "How we work can't add skills yet.";
const refused = { code: "CONFIG_INVALID", message: MESSAGE };
const skillFile = (name: string) => `---\nname: ${name}\ndescription: Use when ${name}.\n---\n# Steps\n`;

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

const newSkill = (w: MergeWorld, name = "triage") => w.store.skills.create({ orgId: ORG_A, content: skillFile(name), owner: { kind: "project", project: "web" }, by: MAX });
async function layer(w: MergeWorld, publish = false): Promise<AgentId> {
  const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
  if (publish) {
    const agent = (await w.store.get(ORG_A, agentId))!;
    await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
  }
  return agentId;
}
/** Writes an overlay into a stored item as earlier code could have: no check runs. */
function storeOverlay(w: MergeWorld, agentId: AgentId, sk: string, overlay: RecipeOverlay): void {
  w.db.set({ ...w.db.get(agentKey(ORG_A, agentId, sk as "DRAFT"))!, overlay });
}
const ordinary = (w: MergeWorld, name = "helper", overlay: RecipeOverlay = {}) =>
  w.store.create({ orgId: ORG_A, name, owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, overlay, createdBy: MAX });

describe("the words", () => {
  it("are fixed", () => { expect(PROCESS_SKILLS_MESSAGE).toBe(MESSAGE); });
});

describe("saving a process layer's draft", () => {
  it("refuses adding a skill and removing one, in the fixed words, and leaves the draft as it was", async () => {
    const w = world();
    const skill = await newSkill(w);
    const id = await layer(w);
    const before = (await w.store.getDraft(ORG_A, id))!;
    expect(await failure(w.store.saveDraft({ orgId: ORG_A, agentId: id, overlay: { skills: { add: [{ skillId: skill.skillId }] } }, expectedRevision: before.revision, by: MAX }))).toEqual(refused);
    expect(await failure(w.store.saveDraft({ orgId: ORG_A, agentId: id, overlay: { skills: { remove: [skill.skillId] } }, expectedRevision: before.revision, by: MAX }))).toEqual(refused);
    expect(await w.store.getDraft(ORG_A, id)).toEqual(before);
  });

  it("an empty skills object adds nothing and is saved", async () => {
    const w = world();
    const id = await layer(w);
    const saved = await w.store.saveDraft({ orgId: ORG_A, agentId: id, overlay: { skills: { add: [], remove: [] }, instructions: "Keep it small." }, expectedRevision: 1, by: MAX });
    expect(saved.revision).toBe(2);
  });

  it("an ordinary agent may still add and remove skills", async () => {
    const w = world();
    const skill = await newSkill(w);
    const mine = await ordinary(w);
    const saved = await w.store.saveDraft({ orgId: ORG_A, agentId: mine.agentId, overlay: { skills: { add: [{ skillId: skill.skillId }] } }, expectedRevision: mine.draftRevision, by: MAX });
    expect(saved.overlay.skills?.add).toHaveLength(1);
    const removed = await w.store.saveDraft({ orgId: ORG_A, agentId: mine.agentId, overlay: { skills: { remove: [skill.skillId] } }, expectedRevision: saved.revision, by: MAX });
    expect(removed.overlay.skills?.remove).toEqual([skill.skillId]);
  });
});

describe("creating a process layer", () => {
  it("refuses one created with a skill, and an ordinary agent is created with one", async () => {
    const w = world();
    const skill = await newSkill(w);
    const overlay = { skills: { add: [{ skillId: skill.skillId }] } };
    expect(await failure(w.store.create({ orgId: ORG_A, name: "x process", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, overlay, purpose: "process", createdBy: MAX }))).toEqual(refused);
    expect((await w.store.list(ORG_A)).filter((agent) => agent.purpose === "process")).toHaveLength(0);
    const made = await ordinary(w, "with skill", overlay);
    expect((await w.store.getDraft(ORG_A, made.agentId))?.overlay.skills?.add).toHaveLength(1);
  });
});

describe("publishing a process layer whose stored draft has skills", () => {
  it("refuses the publish through the change, the confirmation and the store, and an ordinary agent's same draft is judged by the ordinary rules", async () => {
    const w = world();
    const skill = await newSkill(w);
    const overlay = { skills: { add: [{ skillId: skill.skillId }] } };
    const id = await layer(w);
    storeOverlay(w, id, "DRAFT", overlay);
    const agent = (await w.store.get(ORG_A, id))!;
    expect(await failure(publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision }))).toEqual(refused);
    const digest = recipeDigest(await resolveRecipe(w.deps, ORG_A, id, "draft"));
    const subject = { kind: "agent_publish", agentId: id, draftRevision: agent.draftRevision, digest };
    const record = { orgId: ORG_A, approvalId: "apr_x", decidedBy: OLA, subject } as unknown as ApprovalRecord;
    expect(await failure(getApprovalSubjectHandler("agent_publish")!(w.deps, record))).toEqual(refused);
    expect(await failure(w.store.publish({ orgId: ORG_A, agentId: id, expectedDraftRevision: agent.draftRevision, digest, by: MAX }))).toEqual(refused);
    expect((await w.store.get(ORG_A, id))?.currentVersion).toBeUndefined();

    const other = await ordinary(w, "other", overlay);
    expect(await publishDraft(w.deps, callerOf(w, MAX), other, { requestId: randomUUID(), expectedRevision: other.draftRevision })).toHaveProperty("applied");
  });
});

describe("updating a process layer's base", () => {
  it("refuses when the stored draft has skills, and leaves the draft as it was", async () => {
    const w = world();
    const skill = await newSkill(w);
    const id = await layer(w);
    storeOverlay(w, id, "DRAFT", { skills: { add: [{ skillId: skill.skillId }] } });
    const before = (await w.store.getDraft(ORG_A, id))!;
    expect(await failure(w.store.updateBase({ orgId: ORG_A, agentId: id, expectedRevision: before.revision, by: MAX }))).toEqual(refused);
    expect(await w.store.getDraft(ORG_A, id)).toEqual(before);
  });
});

describe("rolling a process layer back to a version that has skills", () => {
  /** Version 2 adds review instructions, so going back to version 1 changes them: a rollback that would wait for a person, unless it is refused first. */
  async function twoVersions(w: MergeWorld): Promise<AgentId> {
    const id = await layer(w, true);
    let agent = (await w.store.get(ORG_A, id))!;
    await w.store.saveDraft({ orgId: ORG_A, agentId: id, overlay: { steps: { review: { instructions: "Check the migrations." } } }, expectedRevision: agent.draftRevision, by: MAX });
    agent = (await w.store.get(ORG_A, id))!;
    const confirmed = await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    if (!confirmed.applied) {
      const pending = await getApproval(w.deps, ORG_A, w.approvalIdOf(confirmed.confirmUrl));
      expect(pending).toBeDefined();
      await getApprovalSubjectHandler("agent_publish")!(w.deps, { ...pending!, decidedBy: OLA });
    }
    return id;
  }

  it("refuses the rollback, through the change, the store and the confirmation", async () => {
    const w = world();
    const skill = await newSkill(w);
    const id = await twoVersions(w);
    const pendingRollback = await rollbackAgent(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, id))!, { requestId: randomUUID(), version: 1 });
    expect(pendingRollback.applied).toBe(false);
    if (pendingRollback.applied) throw new Error("expected a rollback confirmation");
    const approved = (await getApproval(w.deps, ORG_A, w.approvalIdOf(pendingRollback.confirmUrl)))!;
    storeOverlay(w, id, agentVersionSk(1), { skills: { add: [{ skillId: skill.skillId }] } });
    const agent = (await w.store.get(ORG_A, id))!;
    expect(agent.currentVersion).toBe(2);
    expect(await failure(rollbackAgent(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), version: 1 }))).toEqual(refused);
    expect(await failure(w.store.rollback({ orgId: ORG_A, agentId: id, version: 1, expectedCurrentVersion: 2, by: MAX }))).toEqual(refused);
    const digest = recipeDigest(await resolveRecipe(w.deps, ORG_A, id, 1));
    const record = { ...approved, decidedBy: OLA, subject: { ...approved.subject, digest } } as ApprovalRecord;
    expect(await failure(getApprovalSubjectHandler("agent_rollback")!(w.deps, record))).toEqual(refused);
    expect((await w.store.get(ORG_A, id))?.currentVersion).toBe(2);
  });
});

describe("the agent routes", () => {
  it("refuse a process layer's draft with a skill (400, fixed words), and take the same body for an ordinary agent", async () => {
    const w = world();
    const skill = await newSkill(w);
    const id = await layer(w);
    const mine = await ordinary(w);
    const put = async (agentId: AgentId, revision: number) => {
      const path = `/v1/app/agents/${agentId}/draft`;
      const body = JSON.stringify({ requestId: randomUUID(), expectedRevision: revision, overlay: { skills: { add: [{ skillId: skill.skillId }] } } });
      return failure(routeAgentRequest(w.deps as never, callerOf(w, MAX), { method: "PUT", path, requestId: "r", headers: {}, body }, new URL(`${CELL}${path}`)));
    };
    expect(await put(id, 1)).toEqual(refused);
    expect((await w.store.getDraft(ORG_A, id))!.overlay.skills).toBeUndefined();
    expect(await put(mine.agentId, 1)).toBeUndefined();
    expect((await w.store.getDraft(ORG_A, mine.agentId))!.overlay.skills?.add).toHaveLength(1);
  });
});

describe("using a process layer whose current version has skills", () => {
  it("is PROCESS_UNAVAILABLE for work", async () => {
    const w = world();
    const skill = await newSkill(w);
    const id = await layer(w, true);
    const reader = { documentClient: w.db, tableName: "state", store: w.store };
    expect(await projectProcessOf(reader, ORG_A, "web")).toMatchObject({ kind: "project_process", agentId: id, version: 1 });
    storeOverlay(w, id, agentVersionSk(1), { skills: { add: [{ skillId: skill.skillId }] } });
    expect(await failure(projectProcessOf(reader, ORG_A, "web"))).toMatchObject({ code: "PROCESS_UNAVAILABLE" });
  });
});

describe("the reviewing stages of a stored process layer that has skills anyway", () => {
  const V2: ResolvedRecipe = BUILTIN_AGENTS["rovara-code"].versions[1]!.recipe;
  const builtin: RecipeLayer = { agentId: ROVARA_CODE_AGENT_ID, name: "Rovara Code", version: 2, builtin: true };
  const AGENT = "agt_cccccccccccccccccccc" as AgentId;
  const SKILL = { skillId: "skl_aaaaaaaaaaaaaaaaaaaa", name: "triage", description: "Use when triaging.", digest: "a".repeat(64) };
  /** Rovara Code 2 with a custom layer that holds a skill, which is a process layer or not. */
  const recipeOf = (process: boolean): { recipe: ResolvedRecipe; layer: RecipeLayer } => {
    const layer: RecipeLayer = { agentId: AGENT, name: "layer", version: 1, builtin: false, ...(process ? { process: true as const } : {}) };
    return { layer, recipe: applyOverlay(applyOverlay(V2, {}, builtin), { skills: { add: [{ skillId: SKILL.skillId }] } }, layer, () => SKILL) };
  };
  const sent = (process: boolean, mode: DispatchMode, programStepId: string) => {
    const { recipe, layer } = recipeOf(process);
    const applied = applyAgentStep({
      recipe, ref: { agentId: layer.agentId, name: layer.name, version: layer.version, builtin: layer.builtin }, mode, programStepId,
      guardrails: { ...structuredClone(DEFAULT_AGENT_GUARDRAILS) }, project: "web", priorOperations: [],
    });
    return applied.agentStep as { skills?: Array<{ skillId: string }> } | undefined;
  };

  it("send no skills to the plan check, the code and security review or the pull request feedback review, and an ordinary agent's reviewers keep theirs", () => {
    expect(recipeOf(true).recipe.skills).toHaveLength(1);
    for (const [mode, step] of [["REVIEW", "review"], ["PLAN_CRITIQUE", "plan_critic"], ["FEEDBACK_REVIEW", "pull_request"]] as const) {
      const process = sent(true, mode, step);
      expect(process, `${mode} sends a step payload`).toBeDefined();
      expect(process?.skills, `${mode} of the process layer`).toBeUndefined();
      expect(sent(false, mode, step)?.skills, `${mode} of an ordinary agent`).toEqual([{ skillId: SKILL.skillId, digest: SKILL.digest }]);
    }
  });

  it("an ordinary agent's other stages keep skills, and so does the process layer's build stage (nothing else is changed here)", () => {
    expect(sent(false, "IMPLEMENT", "build")?.skills).toHaveLength(1);
    expect(sent(true, "IMPLEMENT", "build")?.skills).toHaveLength(1);
  });
});
