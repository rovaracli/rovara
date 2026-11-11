// Plan 6 Task 2: Rovara Code version 2 is a built-in recipe with a plan critic step. The step is an ordinary one: the company chooses its model through an
// overlay like any step's, and nothing here asks for a different AI company (owner, question 10). Version 1 stays exactly as it was.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ResolvedRecipeSchema, STEP_TOOLS } from "@rovara-code/contracts";
import { applyOverlay, codingProgram, formatRecipeProblem, recipeDigest, recipeProblems, recipeRunner, type RecipeOverlay, type ResolvedRecipe, type ResolvedStep } from "@rovara-code/contracts";
import { BUILTIN_AGENTS, builtinDefaultPin, builtinRecipe, currentBuiltinVersion } from "@rovara-code/contracts";
import { WorkflowProgramSchema } from "@rovara-code/contracts";
import { WorkflowSnapshotSchema, createWorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { advanceStage, nextProgramStep, type WorkflowProgram } from "@rovara-code/contracts";
import { crossCompanyTargets, stepForOperation } from "../../packages/broker/src/agents/dispatch.js";
import { lessSafeChanges } from "../../packages/broker/src/agents/less-safe.js";

const DIGESTS = JSON.parse(readFileSync(new URL("../fixtures/builtin-agent-digests.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
const V1_DIGEST = "1f3d988f8f6c4ae406aca2a61c7afbc378a08f14d3ce47e8037228d9195c989b";
const LAYER = { agentId: "agt_00000000000000000001", name: "Ours", version: 1, builtin: false } as const;
const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const now = "2026-10-25T12:00:00.000Z";

const v1 = (): ResolvedRecipe => builtinRecipe("rovara-code", 1);
const v2 = (): ResolvedRecipe => builtinRecipe("rovara-code", 2);
const problems = (recipe: ResolvedRecipe): string[] => recipeProblems(recipe).map(formatRecipeProblem);
const step = (kind: ResolvedStep["kind"], id = kind as string): ResolvedStep => ({ id, name: id, kind, settings: { instructions: [] } }) as ResolvedStep;
const withSteps = (steps: ResolvedStep[]): ResolvedRecipe => ({ ...v2(), steps });
const reviewStep = (): ResolvedStep => ({ id: "review", name: "Review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 }, settings: { instructions: [] } });

describe("Rovara Code versions", () => {
  it("has two versions: version 1 is byte-for-byte what shipped, and version 2 is the newest release", () => {
    expect(BUILTIN_AGENTS["rovara-code"].versions.map((entry) => entry.version)).toEqual([1, 2]);
    expect(currentBuiltinVersion("rovara-code")).toBe(2);
    expect(BUILTIN_AGENTS["rovara-code"].versions[0]!.digest).toBe(V1_DIGEST);
    expect(recipeDigest(v1())).toBe(V1_DIGEST);
    expect(v1().steps.map((entry) => entry.kind)).toEqual(["plan", "build", "check", "review", "pull_request"]);
    expect(DIGESTS["rovara-code"]).toEqual({ "1": V1_DIGEST, "2": recipeDigest(v2()) });
  });

  it("version 2 is plan, plan_critic, build, check, review, pull_request with the review sending findings back to build for 3 rounds", () => {
    const recipe = v2();
    expect(recipe.steps.map((entry) => [entry.id, entry.kind])).toEqual([
      ["plan", "plan"], ["plan_critic", "plan_critic"], ["build", "build"], ["check", "check"], ["review", "review"], ["pull_request", "pull_request"],
    ]);
    // No settings of its own: the company may choose the critic's model through an overlay, like any step's.
    expect(recipe.steps[1]).toEqual({ id: "plan_critic", name: "Plan check", kind: "plan_critic", settings: { instructions: [] } });
    expect(recipe.steps[4]).toMatchObject({ reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } });
    expect(recipe.chain).toEqual([{ agentId: "rovara-code", name: "Rovara Code", version: 2, builtin: true }]);
    expect(recipe.triggers).toEqual([{ kind: "person" }]);
    expect(BUILTIN_AGENTS["rovara-code"].versions[1]!.notes).toBe("Asks clear questions when a task is vague, has each plan checked by a second model, and sends review findings back to build on its own for up to 3 rounds.");
    expect(BUILTIN_AGENTS["rovara-code"].versions[1]!.digest).toBe(recipeDigest(recipe));
    expect(BUILTIN_AGENTS["rovara-code"].versions[1]!.digest).not.toBe(V1_DIGEST);
  });

  it("version 2 parses strictly, has no recipe problems and runs as a coding recipe", () => {
    expect(problems(v2())).toEqual([]);
    expect(ResolvedRecipeSchema.safeParse(structuredClone(v2())).success).toBe(true);
    expect(ResolvedRecipeSchema.safeParse({ ...structuredClone(v2()), extra: 1 }).success).toBe(false);
    expect(recipeRunner(v2())).toBe("coding");
    expect(problems(v1())).toEqual([]);
  });

  it("the default pin is 1 for Rovara Code and the newest release for every other built-in", () => {
    expect(builtinDefaultPin("rovara-code")).toBe(1);
    for (const id of ["ticket-triage", "root-cause-analyst", "code-reviewer", "deploy-reviewer", "service-reviewer"] as const) expect(builtinDefaultPin(id)).toBe(currentBuiltinVersion(id));
  });
});

describe("a plan check step in a recipe", () => {
  it("is allowed only directly after the plan step, and only once", () => {
    const base = [step("plan"), step("build"), step("check"), reviewStep(), step("pull_request")];
    expect(problems(withSteps([base[0]!, step("plan_critic"), ...base.slice(1)]))).toEqual([]);
    expect(problems(withSteps([base[0]!, base[1]!, step("plan_critic"), ...base.slice(2)]))).toContain("steps: a plan check must come right after the plan step");
    expect(problems(withSteps([step("plan_critic"), ...base.slice(1)]))).toContain("steps: a plan check needs a plan step");
    expect(problems(withSteps([step("plan_critic"), ...base]))).toContain("steps: a plan check must come right after the plan step");
    expect(problems(withSteps([base[0]!, step("plan_critic"), step("plan_critic", "second_check"), ...base.slice(1)]))).toContain("steps: a recipe can have only one plan check step");
  });

  it("takes the company's model like any step, and refuses differentCompanyFrom (only a review or agent step takes it)", () => {
    const overlay: RecipeOverlay = { steps: { plan_critic: { model: { provider: "openai", modelId: "gpt-5.5" }, fallbackModel: { provider: "anthropic", modelId: "claude-opus-4-6" } } } };
    const layer = LAYER;
    const applied = applyOverlay(v2(), overlay, layer);
    expect(applied.steps[1]!.settings).toMatchObject({ model: { provider: "openai", modelId: "gpt-5.5" }, fallbackModel: { provider: "anthropic", modelId: "claude-opus-4-6" } });
    expect(problems(applied)).toEqual([]);

    const picky = applyOverlay(v2(), { steps: { plan_critic: { differentCompanyFrom: "plan" } } }, layer);
    expect(problems(picky)).toEqual(["steps.1.settings.differentCompanyFrom: only a review or agent step can name a step to differ from"]);
  });

  it("can read the code but not change it: it takes the read-only tools", () => {
    expect(STEP_TOOLS.plan_critic).toEqual(["read", "grep", "find", "ls"]);
    const edit = applyOverlay(v2(), { steps: { plan_critic: { tools: ["read", "edit"] } } }, LAYER);
    expect(problems(edit)).toEqual(['steps.1.settings.tools: the "plan_critic" step (plan_critic) can\'t use edit; it can use read, grep, find, ls']);
  });

  it("adding it to a recipe that had none is not a less-safe change (it reads and critiques, nothing more)", () => {
    expect(lessSafeChanges(v1(), v2())).toEqual([]);
  });
});

describe("the workflow program of version 2", () => {
  it("is six steps, and version 1 still has no program", () => {
    expect(codingProgram(v1())).toBeUndefined();
    const program = codingProgram(v2());
    expect(program?.steps.map((entry) => entry.kind)).toEqual(["plan", "plan_critic", "build", "check", "review", "pull_request"]);
    expect(WorkflowProgramSchema.safeParse(program).success).toBe(true);
    expect(program?.steps[4]).toEqual({ id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } });
  });

  it("accepts the plan check only at index 1, once, and ignores it for the rule about the first step after the plan", () => {
    const ok = (steps: unknown[]) => WorkflowProgramSchema.safeParse({ steps }).success;
    const tail = [{ id: "build", kind: "build" }, { id: "check", kind: "check" }, { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }];
    expect(ok([{ id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, ...tail])).toBe(true);
    expect(ok([{ id: "plan", kind: "plan" }, ...tail, { id: "plan_critic", kind: "plan_critic" }])).toBe(false);
    expect(ok([{ id: "plan_critic", kind: "plan_critic" }, { id: "plan", kind: "plan" }, ...tail])).toBe(false);
    expect(ok([{ id: "plan_critic", kind: "plan_critic" }, ...tail])).toBe(false);
    expect(ok([{ id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "second", kind: "plan_critic" }, ...tail])).toBe(false);
    // The first step after the plan and its critic must be a build.
    expect(ok([{ id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "check", kind: "check" }, { id: "build", kind: "build" }])).toBe(false);
  });

  it("goes from the approved plan to the build, never back into the plan check", () => {
    const program = codingProgram(v2()) as WorkflowProgram;
    expect(advanceStage({ program, programStepId: "plan" }, "IMPLEMENT")).toEqual({ stage: "IMPLEMENT", programStepId: "build" });
    expect(advanceStage({ program }, "IMPLEMENT")).toEqual({ stage: "IMPLEMENT", programStepId: "build" });
    expect(advanceStage({ program, programStepId: "plan_critic" }, "IMPLEMENT")).toEqual({ stage: "IMPLEMENT", programStepId: "build" });
    expect(nextProgramStep(program, "plan", "done")).toEqual({ kind: "step", step: { id: "build", kind: "build" } });
    // Findings still go back to build, never to a step before it.
    expect(nextProgramStep(program, "review", "findings", 1)).toEqual({ kind: "step", step: { id: "build", kind: "build" } });
  });

  it("only a 1.1.0 snapshot may hold a program with a plan check", () => {
    const program = codingProgram(v2()) as WorkflowProgram;
    const created = createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now, definitionVersion: "1.1.0", program });
    expect(created).toMatchObject({ definitionVersion: "1.1.0", stage: "PLAN", programStepId: "plan", program });
    expect(WorkflowSnapshotSchema.safeParse(created).success).toBe(true);
    expect(WorkflowSnapshotSchema.safeParse({ ...created, definitionVersion: "1.0.0" }).success).toBe(false);
    // A version 1 task is still created as 1.0.0 with no new field.
    expect(createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now })).toMatchObject({ definitionVersion: "1.0.0" });
  });
});

describe("the plan check in the dispatcher", () => {
  it("PLAN_CRITIQUE runs the plan_critic step, and PLAN still runs the plan step", () => {
    const recipe = v2();
    expect(stepForOperation(recipe, "PLAN_CRITIQUE")?.id).toBe("plan_critic");
    expect(stepForOperation(recipe, "PLAN")?.id).toBe("plan");
    expect(stepForOperation(recipe, "PLAN_CRITIQUE", "plan_critic")?.id).toBe("plan_critic");
    // A recipe with no plan check has no step for it: the engine does not invent one.
    expect(stepForOperation(v1(), "PLAN_CRITIQUE")).toBeUndefined();
  });

  it("requireCrossCompanyReview applies to the review step only, never to the plan check, and version 1's answers are unchanged", () => {
    const guarded = { requireCrossCompanyReview: true };
    const recipe = v2();
    expect(crossCompanyTargets(recipe, recipe.steps[1], guarded)).toEqual([]);
    expect(crossCompanyTargets(recipe, recipe.steps[1], { requireCrossCompanyReview: false })).toEqual([]);
    expect(crossCompanyTargets(recipe, recipe.steps[4], guarded)).toEqual(["build"]);
    expect(crossCompanyTargets(recipe, recipe.steps[0], guarded)).toEqual([]);
    const old = v1();
    expect(crossCompanyTargets(old, old.steps[3], guarded)).toEqual(["build"]);
    expect(crossCompanyTargets(old, old.steps[0], guarded)).toEqual([]);
  });
});
