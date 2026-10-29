// "How we work" (H4 fix round 1): the project-wide rules of a process layer reach the Build step but never the reviewing stages (plan check, code and security review), which see only
// Rovara's built-in layers and instructions written on the stage itself. Ordinary agents are unchanged. And a process layer's draft cannot change the order of stages yet.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../../packages/contracts/src/agent-templates.js";
import { DEFAULT_AGENT_GUARDRAILS } from "../../packages/contracts/src/agent-guardrails.js";
import { applyOverlay, type RecipeLayer, type RecipeOverlay, type ResolvedRecipe } from "../../packages/contracts/src/agent-recipe-node.js";
import { ROVARA_CODE_AGENT_ID, agentKey, type AgentId } from "../../packages/contracts/src/index.js";
import { applyAgentStep, type DispatchMode } from "../../packages/broker/src/agents/dispatch.js";
import { publishDraft, resolveRecipe } from "../../packages/broker/src/agents/changes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { stepInstructionLayers } from "../../packages/broker/src/playbook/process-reviewers.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import type { ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { MAX, ORG_A } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";
import { agentXError } from "../../packages/contracts/src/index.js";

const PROJECT_RULE = "PROJECT-WIDE-RULE: always mention the ticket id.";
const REVIEW_RULE = "REVIEW-STAGE-RULE: check the migration.";
const CRITIC_RULE = "CHECK-STAGE-RULE: question the rollout.";
const BUILTIN_RULE = "BUILT-IN-RULE: never print secrets.";
const SEQUENCE_MESSAGE = "How we work can't change the order of stages yet.";

const V2: ResolvedRecipe = BUILTIN_AGENTS["rovara-code"].versions[1]!.recipe;
const builtinLayer: RecipeLayer = { agentId: ROVARA_CODE_AGENT_ID, name: "Rovara Code", version: 2, builtin: true };
const AGENT = "agt_cccccccccccccccccccc" as AgentId;
const customLayer = (name: string, process: boolean): RecipeLayer => ({ agentId: AGENT, name, version: 1, builtin: false, ...(process ? { process: true as const } : {}) });

/** Rovara Code 2 with a built-in recipe-level rule, then a custom layer with a project-wide rule and a rule on the review and plan check stages. */
function recipeWith(layer: RecipeLayer, overlay: RecipeOverlay): ResolvedRecipe {
  const withBuiltin = applyOverlay(V2, { instructions: BUILTIN_RULE }, builtinLayer);
  return applyOverlay(withBuiltin, overlay, layer);
}
const FEEDBACK_RULE = "FEEDBACK-STAGE-RULE: summarise each comment before judging it.";
const OVERLAY: RecipeOverlay = { instructions: PROJECT_RULE, steps: { review: { instructions: REVIEW_RULE }, plan_critic: { instructions: CRITIC_RULE }, pull_request: { instructions: FEEDBACK_RULE } } };

/** What the worker is sent for a stage: the prompt section and the copy inside the step payload. */
function sentFor(recipe: ResolvedRecipe, layer: RecipeLayer, mode: DispatchMode, programStepId?: string) {
  const applied = applyAgentStep({
    recipe, ref: { agentId: layer.agentId, name: layer.name, version: layer.version, builtin: layer.builtin }, mode, ...(programStepId === undefined ? {} : { programStepId }),
    guardrails: { ...structuredClone(DEFAULT_AGENT_GUARDRAILS) }, project: "web", priorOperations: [],
  });
  const payload = applied.agentStep as { promptSection?: string } | undefined;
  return { section: applied.promptSection ?? "", payload: payload?.promptSection ?? "" };
}
const expectBoth = (sent: { section: string; payload: string }, check: (text: string) => void) => { check(sent.section); check(sent.payload); };

describe("a process layer's project-wide rules", () => {
  const layer = customLayer("web process", true);
  const recipe = recipeWith(layer, OVERLAY);

  it("reach the Build step", () => {
    expectBoth(sentFor(recipe, layer, "IMPLEMENT"), (text) => expect(text).toContain(PROJECT_RULE));
  });

  it("never reach the code reviewer or the security reviewer (the review stage), nor the plan check", () => {
    for (const [mode, step] of [["REVIEW", "review"], ["PLAN_CRITIQUE", "plan_critic"]] as const) {
      const sent = sentFor(recipe, layer, mode, step);
      expect(sent.section.length, `${mode} sends a prompt section`).toBeGreaterThan(0);
      expect(sent.payload.length, `${mode} sends the step payload copy`).toBeGreaterThan(0);
      expectBoth(sent, (text) => expect(text).not.toContain(PROJECT_RULE));
    }
  });

  it("reach the Plan step as before", () => {
    expectBoth(sentFor(recipe, layer, "PLAN", "plan"), (text) => expect(text).toContain(PROJECT_RULE));
  });

  it("never reach the pull request feedback review (follow-up M3), which still gets Rovara's built-in layers; the rule written on its own stage no longer does either (PB18)", () => {
    const sent = sentFor(recipe, layer, "FEEDBACK_REVIEW", "pull_request");
    expect(sent.section.length, "FEEDBACK_REVIEW sends a prompt section").toBeGreaterThan(0);
    expect(sent.payload.length, "FEEDBACK_REVIEW sends the step payload copy").toBeGreaterThan(0);
    expectBoth(sent, (text) => {
      expect(text).not.toContain(PROJECT_RULE);
      expect(text).toContain(BUILTIN_RULE);
      expect(text).not.toContain(FEEDBACK_RULE);
    });
  });

  it("PB18: a rule written on the pull request stage is kept when that step writes the pull request description (any operation but the feedback review), and left out of the feedback review", () => {
    const step = recipe.steps.find((candidate) => candidate.kind === "pull_request")!;
    const texts = (mode: Parameters<typeof stepInstructionLayers>[2]) => stepInstructionLayers(recipe, step, mode).map((entry) => entry.text);
    expect(texts(undefined)).toContain(FEEDBACK_RULE);
    expect(texts("IMPLEMENT")).toContain(FEEDBACK_RULE);
    expect(texts("FEEDBACK_REVIEW")).not.toContain(FEEDBACK_RULE);
    // Only the stage's layers written by the process layer are dropped: a built-in stage layer stays.
    const withBuiltinStage = applyOverlay(applyOverlay(V2, { steps: { pull_request: { instructions: "BUILT-IN-STAGE-RULE" } } }, builtinLayer), OVERLAY, layer);
    expect(stepInstructionLayers(withBuiltinStage, withBuiltinStage.steps.find((candidate) => candidate.kind === "pull_request"), "FEEDBACK_REVIEW").map((entry) => entry.text)).toEqual(["BUILT-IN-STAGE-RULE"]);
  });

  it("a rule written on the review stage reaches the reviewers, and a rule on the plan check reaches the plan check, and neither reaches Build", () => {
    expectBoth(sentFor(recipe, layer, "REVIEW", "review"), (text) => expect(text).toContain(REVIEW_RULE));
    expectBoth(sentFor(recipe, layer, "PLAN_CRITIQUE", "plan_critic"), (text) => expect(text).toContain(CRITIC_RULE));
    expectBoth(sentFor(recipe, layer, "IMPLEMENT"), (text) => { expect(text).not.toContain(REVIEW_RULE); expect(text).not.toContain(CRITIC_RULE); });
  });

  it("Rovara's built-in layers still reach the reviewers and the plan check", () => {
    for (const [mode, step] of [["REVIEW", "review"], ["PLAN_CRITIQUE", "plan_critic"], ["FEEDBACK_REVIEW", "pull_request"]] as const) {
      expectBoth(sentFor(recipe, layer, mode, step), (text) => expect(text).toContain(BUILTIN_RULE));
    }
  });
});

describe("an ordinary custom agent's recipe-level instructions", () => {
  it("still reach its reviewers and plan check", () => {
    const layer = customLayer("reviewer bot", false);
    const recipe = recipeWith(layer, OVERLAY);
    for (const [mode, step] of [["REVIEW", "review"], ["PLAN_CRITIQUE", "plan_critic"], ["IMPLEMENT", "build"], ["FEEDBACK_REVIEW", "pull_request"]] as const) {
      expectBoth(sentFor(recipe, layer, mode, step), (text) => { expect(text).toContain(PROJECT_RULE); expect(text).toContain(BUILTIN_RULE); });
    }
    // PB18: its pull request stage rule still reaches its feedback review.
    expectBoth(sentFor(recipe, layer, "FEEDBACK_REVIEW", "pull_request"), (text) => expect(text).toContain(FEEDBACK_RULE));
  });
});

// ---- through the real stores

const ROLES = {} as Record<string, never>;
function audited(w: MergeWorld): MergeWorld {
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  return w;
}
function playbookDeps(w: MergeWorld): ProjectPlaybookDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
  };
}
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; statusCode?: number; message: string }) => ({ code: error.code, status: error.statusCode, message: error.message }));
const SEQUENCE: RecipeOverlay["sequence"] = [
  { id: "plan", name: "Plan", kind: "plan" }, { id: "build", name: "Build", kind: "build" }, { id: "check", name: "Check", kind: "check" },
  { id: "review", name: "Review", kind: "review", reviewers: ["code", "security"] }, { id: "pull_request", name: "Pull request", kind: "pull_request" },
];

describe("the real resolved recipe of a process layer", () => {
  it("marks the process layer in the chain, so Build gets the project-wide rule and the reviewers do not", async () => {
    const w = audited(baseWorld());
    const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
    const agent = (await w.store.get(ORG_A, agentId))!;
    await w.store.saveDraft({ orgId: ORG_A, agentId, overlay: { instructions: PROJECT_RULE, steps: { review: { instructions: REVIEW_RULE } } }, expectedRevision: agent.draftRevision, by: MAX });
    const recipe = await resolveRecipe(w.deps, ORG_A, agentId, "draft");
    expect(recipe.chain.at(-1)).toMatchObject({ agentId, process: true });
    expect(recipe.chain.some((entry) => entry.builtin && entry.process === true)).toBe(false);
    const layer = recipe.chain.at(-1)!;
    expectBoth(sentFor(recipe, layer, "IMPLEMENT"), (text) => expect(text).toContain(PROJECT_RULE));
    expectBoth(sentFor(recipe, layer, "REVIEW", "review"), (text) => { expect(text).not.toContain(PROJECT_RULE); expect(text).toContain(REVIEW_RULE); });
  });

  it("does not mark an ordinary agent's layer", async () => {
    const w = audited(baseWorld());
    const created = await w.store.create({ orgId: ORG_A, name: "reviewer", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    expect((await resolveRecipe(w.deps, ORG_A, created.agentId, "draft")).chain.at(-1)!.process).toBeUndefined();
  });
});

describe("a process layer cannot change the order of stages yet", () => {
  it("refuses a draft with a sequence (400, fixed words), and an ordinary agent may still set one", async () => {
    const w = audited(baseWorld());
    const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
    const agent = (await w.store.get(ORG_A, agentId))!;
    const refused = await failure(w.store.saveDraft({ orgId: ORG_A, agentId, overlay: { sequence: SEQUENCE }, expectedRevision: agent.draftRevision, by: MAX }));
    expect(refused).toEqual({ code: "CONFIG_INVALID", status: 400, message: `CONFIG_INVALID: ${SEQUENCE_MESSAGE}` });
    expect((await w.store.getDraft(ORG_A, agentId))!.revision).toBe(agent.draftRevision);

    const ordinary = await w.store.create({ orgId: ORG_A, name: "reviewer", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    const saved = await w.store.saveDraft({ orgId: ORG_A, agentId: ordinary.agentId, overlay: { sequence: SEQUENCE }, expectedRevision: ordinary.draftRevision, by: MAX });
    expect(saved.overlay.sequence).toHaveLength(5);
  });

  it("refuses a process layer created with a sequence", async () => {
    const w = audited(baseWorld());
    const refused = await failure(w.store.create({ orgId: ORG_A, name: "x process", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, overlay: { sequence: SEQUENCE }, purpose: "process", createdBy: MAX }));
    expect(refused).toMatchObject({ code: "CONFIG_INVALID", message: `CONFIG_INVALID: ${SEQUENCE_MESSAGE}` });
  });

  it("refuses to publish a stored draft that has a sequence, with the same words, and takes the same draft of an ordinary agent", async () => {
    const w = audited(baseWorld());
    const make = async (name: string) => {
      const created = await w.store.create({ orgId: ORG_A, name, owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
      await w.store.saveDraft({ orgId: ORG_A, agentId: created.agentId, overlay: { sequence: SEQUENCE }, expectedRevision: created.draftRevision, by: MAX });
      return created.agentId;
    };
    const layer = await make("stored process");
    const ordinary = await make("stored ordinary");
    // A draft stored before the rule existed (or written around the routes): the agent becomes a process layer afterwards.
    w.db.set({ ...w.db.get(agentKey(ORG_A, layer, "META"))!, purpose: "process" });
    const caller = { ...w.caller(MAX), orgRole: "member" as const };
    const publish = async (id: AgentId) => publishDraft(w.deps, caller, (await w.store.get(ORG_A, id))!, { requestId: randomUUID(), expectedRevision: (await w.store.get(ORG_A, id))!.draftRevision });
    expect(await failure(publish(layer))).toEqual({ code: "CONFIG_INVALID", status: 400, message: `CONFIG_INVALID: ${SEQUENCE_MESSAGE}` });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBeUndefined();
    // The ordinary agent is judged by the ordinary rules (dropping the findings loop waits for a person): it is not refused for its sequence.
    expect(await publish(ordinary)).toMatchObject({ applied: false, changes: [expect.stringContaining("sending findings back")] });
  });
});
