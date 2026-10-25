// The agent recipe: the steps an agent runs, the settings of each, the tools it may use, and the overlay an
// agent version stores on top of the agent it builds on. Every schema here is strict, so a recipe cannot carry a
// field that reaches the safety layer (prompts, extensions, environment variables, sandbox or allowed domains).
// Below the schemas are the functions that apply an overlay, check a recipe's structure, turn a coding recipe into
// a workflow program (WorkflowProgramSchema, in task-workflow.ts), and digest and compare recipes.
import { createHash } from "node:crypto";
import { z } from "zod";
import { ToolPatternSchema } from "./action-policy.js";
import { AGENT_NAME_MAX, AgentIdSchema, AutonomySchema, SkillIdSchema } from "./agent.js";
import { canonicalJson } from "./canonical-json.js";
import { ConnectorNameSchema } from "./connectors.js";
import { ModelSelectionSchema } from "./models.js";
import { EventTriggerSpecSchema, ScheduleTriggerSpecSchema } from "./trigger-specs.js";
import type { WorkflowProgram } from "./task-workflow.js";

export const INSTRUCTIONS_MAX_BYTES = 8192;
export const STEP_NAME_MAX = 40;
export const APPROVAL_PROMPT_MAX = 300;
export const MAX_RECIPE_STEPS = 12;
export const MAX_RECIPE_TOOL_GRANTS = 16;
export const MAX_ALWAYS_ASK_RULES = 32;
export const MAX_RECIPE_TRIGGERS = 8;
export const MAX_RESOLVED_SKILLS = 20;

const utf8 = new TextEncoder();

/** Free text for a model, at most 8,192 UTF-8 bytes (`.max` would count UTF-16 units instead). */
const InstructionTextSchema = z.string().refine((text) => utf8.encode(text).length <= INSTRUCTIONS_MAX_BYTES, `must be at most ${INSTRUCTIONS_MAX_BYTES} bytes`);
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const StepIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);
export type StepId = z.infer<typeof StepIdSchema>;

/**
 * `plan_critic` (Rovara Code version 2) is an ordinary step that checks the plan with a second model; it comes only directly after `plan`, at most once.
 * Nothing about it asks for a different AI company: the company chooses its model through an overlay like any step's (question 10).
 */
export const CODING_STEP_KINDS = ["plan", "plan_critic", "build", "check", "review", "pull_request"] as const;
export const AGENT_STEP_KINDS = ["agent", "approval"] as const;
export type CodingStepKind = (typeof CODING_STEP_KINDS)[number];
export type AgentStepKind = (typeof AGENT_STEP_KINDS)[number];

export const PI_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const PiToolNameSchema = z.enum(PI_TOOL_NAMES);
export type PiToolName = z.infer<typeof PiToolNameSchema>;

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const satisfies readonly PiToolName[];

/**
 * The most tools a step of that kind can be given. An `agent` step gets them only with `workspace: "read"`; with
 * `workspace: "none"` it has none. `check` and `pull_request` run fixed commands and take no tools.
 */
export const STEP_TOOLS = {
  build: PI_TOOL_NAMES,
  plan: READ_ONLY_TOOLS,
  plan_critic: READ_ONLY_TOOLS,
  review: READ_ONLY_TOOLS,
  agent: READ_ONLY_TOOLS,
} as const satisfies Record<"build" | "plan" | "plan_critic" | "review" | "agent", readonly PiToolName[]>;

export const StepThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high"]);

/** `null` clears a setting an agent inherits; absent leaves it as it is. */
export const StepSettingsSchema = z.object({
  model: ModelSelectionSchema.nullable().optional(),
  fallbackModel: ModelSelectionSchema.nullable().optional(),
  thinkingLevel: StepThinkingLevelSchema.nullable().optional(),
  instructions: InstructionTextSchema.optional(),
  /** Pi tool names for a coding step, tool patterns over the upstream tool names for an agent step. */
  tools: z.array(ToolPatternSchema).min(1).max(40).refine((tools) => new Set(tools).size === tools.length, "tools must be unique").optional(),
  stepBudgetUsd: z.number().min(0.1).max(100).nullable().optional(),
  timeoutMinutes: z.number().int().min(5).max(240).nullable().optional(),
  /** This step's model must come from a different company than the named earlier step's. */
  differentCompanyFrom: StepIdSchema.nullable().optional(),
}).strict();
export type StepSettings = z.infer<typeof StepSettingsSchema>;

const CheckStepSettingsSchema = StepSettingsSchema.pick({ timeoutMinutes: true }).strict();

/** One layer of instructions, written by the agent named. Layers resolve in chain order, base first. */
export const InstructionLayerSchema = z.object({
  agentName: z.string().min(1).max(AGENT_NAME_MAX),
  text: InstructionTextSchema,
}).strict();
export type InstructionLayer = z.infer<typeof InstructionLayerSchema>;

/** A resolved step carries its instructions as layers, not as one string. */
const ResolvedStepSettingsSchema = StepSettingsSchema.omit({ instructions: true }).extend({ instructions: z.array(InstructionLayerSchema) }).strict();
const ResolvedCheckStepSettingsSchema = CheckStepSettingsSchema.extend({ instructions: z.array(InstructionLayerSchema) }).strict();

const StepNameSchema = z.string().trim().min(1).max(STEP_NAME_MAX);
export const ReviewerSchema = z.enum(["code", "security"]);
export const OnFindingsSchema = z.object({ backTo: StepIdSchema, maxRounds: z.number().int().min(1).max(5) }).strict();

/** The step variants, parameterised by the shape of `settings` so the stored and the resolved forms share them. */
function stepVariants<Settings extends z.ZodType, CheckSettings extends z.ZodType>(settings: Settings, checkSettings: CheckSettings) {
  const common = { id: StepIdSchema, name: StepNameSchema };
  return z.discriminatedUnion("kind", [
    z.object({ ...common, kind: z.literal("plan"), settings }).strict(),
    z.object({ ...common, kind: z.literal("plan_critic"), settings }).strict(),
    z.object({ ...common, kind: z.literal("build"), settings }).strict(),
    z.object({ ...common, kind: z.literal("check"), settings: checkSettings }).strict(),
    z.object({
      ...common,
      kind: z.literal("review"),
      reviewers: z.array(ReviewerSchema).min(1).max(2).refine((reviewers) => new Set(reviewers).size === reviewers.length, "reviewers must be unique"),
      onFindings: OnFindingsSchema.optional(),
      settings,
    }).strict(),
    z.object({ ...common, kind: z.literal("pull_request"), settings }).strict(),
    z.object({
      ...common,
      kind: z.literal("agent"),
      workspace: z.enum(["none", "read"]),
      report: z.object({ slack: z.boolean().optional() }).strict().optional(),
      settings,
    }).strict(),
    z.object({ ...common, kind: z.literal("approval"), prompt: z.string().min(1).max(APPROVAL_PROMPT_MAX), settings }).strict(),
  ]);
}

export const StepSpecSchema = stepVariants(StepSettingsSchema.optional(), CheckStepSettingsSchema.optional());
export type StepSpec = z.infer<typeof StepSpecSchema>;

export const ResolvedStepSchema = stepVariants(ResolvedStepSettingsSchema, ResolvedCheckStepSettingsSchema);
export type ResolvedStep = z.infer<typeof ResolvedStepSchema>;

/** Connector types an agent can be granted tools on: the five of Plan 3 and the seven read-only ones of Plan 4 (Task 12). */
export const AgentConnectorTypeSchema = z.enum(["github", "linear", "jira", "asana", "mcp", "sentry", "datadog", "cloudwatch", "github-actions", "grafana", "vercel", "pagerduty"]);
export type AgentConnectorType = z.infer<typeof AgentConnectorTypeSchema>;

/** A connector by its type (every connection of that type on the project) or by the project's name for it. */
export const ConnectorSelectorSchema = z.union([
  z.object({ type: AgentConnectorTypeSchema }).strict(),
  z.object({ name: ConnectorNameSchema }).strict(),
]);
export type ConnectorSelector = z.infer<typeof ConnectorSelectorSchema>;

export const ToolGrantSchema = z.object({
  connector: ConnectorSelectorSchema,
  access: z.enum(["read", "read_write"]),
  tools: z.array(ToolPatternSchema).min(1).max(64).optional(),
}).strict();
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

const AlwaysAskSchema = z.array(ToolPatternSchema).max(MAX_ALWAYS_ASK_RULES);
export const ApprovalRulesSchema = z.object({ alwaysAsk: AlwaysAskSchema }).strict();
export type ApprovalRules = z.infer<typeof ApprovalRulesSchema>;

/**
 * The ways a run can start. In a custom agent's recipe they say how the agent may be started (G10); on a trigger record (triggers.ts) an `event` or `schedule` spec is the
 * live one. A built-in recipe lists `person` alone: its suggested triggers are Plan 4 data (builtin-triggers.ts), never recipe content.
 */
export const TRIGGER_KINDS_AT_LAUNCH = ["person", "event", "schedule"] as const;
export const TriggerSpecSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("person") }).strict(), EventTriggerSpecSchema, ScheduleTriggerSpecSchema]);
export type TriggerSpec = z.infer<typeof TriggerSpecSchema>;

export const SkillRefSchema = z.object({ skillId: SkillIdSchema, digest: Sha256HexSchema.optional() }).strict();
export type SkillRef = z.infer<typeof SkillRefSchema>;

/** What an agent version stores: its changes to the agent it builds on (or to the empty recipe). */
export const RecipeOverlaySchema = z.object({
  instructions: InstructionTextSchema.nullable().optional(),
  sequence: z.array(StepSpecSchema).min(1).max(MAX_RECIPE_STEPS).optional(),
  steps: z.record(StepIdSchema, StepSettingsSchema).optional(),
  tools: z.array(ToolGrantSchema).max(MAX_RECIPE_TOOL_GRANTS).optional(),
  approvals: z.object({ alwaysAsk: AlwaysAskSchema.optional() }).strict().optional(),
  triggers: z.array(TriggerSpecSchema).min(1).max(MAX_RECIPE_TRIGGERS).optional(),
  skills: z.object({
    add: z.array(SkillRefSchema).max(MAX_RESOLVED_SKILLS).optional(),
    remove: z.array(SkillIdSchema).max(MAX_RESOLVED_SKILLS).optional(),
  }).strict().optional(),
  autonomy: AutonomySchema.optional(),
  /** Opts in to @-mentions in the agent's comments; it can only make comments wait for a person. */
  allowMentions: z.boolean().optional(),
}).strict();
export type RecipeOverlay = z.infer<typeof RecipeOverlaySchema>;

export const RESOLVED_RECIPE_SCHEMA_VERSION = 1;

/** The whole recipe a run follows, after every layer of the chain is applied. It is frozen on the task. */
export const ResolvedRecipeSchema = z.object({
  schemaVersion: z.literal(RESOLVED_RECIPE_SCHEMA_VERSION),
  chain: z.array(z.object({
    agentId: AgentIdSchema,
    name: z.string().min(1).max(AGENT_NAME_MAX),
    version: z.union([z.number().int().min(1), z.literal("draft")]),
    builtin: z.boolean(),
  }).strict()).max(8),
  instructions: z.array(InstructionLayerSchema),
  steps: z.array(ResolvedStepSchema).max(MAX_RECIPE_STEPS),
  tools: z.array(ToolGrantSchema).max(MAX_RECIPE_TOOL_GRANTS),
  approvals: ApprovalRulesSchema,
  triggers: z.array(TriggerSpecSchema).min(1).max(MAX_RECIPE_TRIGGERS),
  skills: z.array(z.object({
    skillId: SkillIdSchema,
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    // At most 1024 characters (code points), as the registry counts them; `.max` would count UTF-16 units.
    description: z.string().refine((value) => [...value].length <= 1024, "must be at most 1024 characters"),
    digest: Sha256HexSchema,
  }).strict()).max(MAX_RESOLVED_SKILLS),
  autonomy: AutonomySchema,
  allowMentions: z.boolean(),
}).strict();
export type ResolvedRecipe = z.infer<typeof ResolvedRecipeSchema>;

/** A recipe with nothing in it: what an agent built from scratch starts from. */
export const EMPTY_RECIPE: ResolvedRecipe = {
  schemaVersion: RESOLVED_RECIPE_SCHEMA_VERSION,
  chain: [],
  instructions: [],
  steps: [],
  tools: [],
  approvals: { alwaysAsk: [] },
  triggers: [{ kind: "person" }],
  skills: [],
  autonomy: "prepare",
  allowMentions: false,
};

export type RecipeLayer = ResolvedRecipe["chain"][number];
export type ResolvedSkill = ResolvedRecipe["skills"][number];
/** A problem with where it is (`path`, dotted) and what is wrong (`message`, which does not repeat the path). */
export interface RecipeProblem { path: string; message: string }

/** The problem as one line: `<path>: <message>`. */
export function formatRecipeProblem(problem: RecipeProblem): string {
  return `${problem.path}: ${problem.message}`;
}

function isCodingKind(kind: string): kind is CodingStepKind {
  return (CODING_STEP_KINDS as readonly string[]).includes(kind);
}

/** The runner a recipe needs: Rovara Code's workflow engine for coding steps, the agent-step runner otherwise. */
export function recipeRunner(recipe: ResolvedRecipe): "coding" | "agent_steps" {
  return recipe.steps.some((step) => isCodingKind(step.kind)) ? "coding" : "agent_steps";
}

type LooseSettings = Record<string, unknown> & { instructions: InstructionLayer[] };

/**
 * Applies one layer's settings patch to a step's inherited settings: a value replaces, `null` clears, instructions
 * add a layer, and a coding step's tools can only narrow what the base step already allowed.
 */
function patchSettings(inherited: LooseSettings, patch: StepSettings | undefined, kind: string, agentName: string): LooseSettings {
  const next: LooseSettings = { ...inherited, instructions: [...inherited.instructions] };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    if (key === "instructions") {
      if (typeof value === "string" && value.length > 0) next.instructions.push({ agentName, text: value });
    } else if (key === "tools") {
      const tools = value as string[];
      const inheritedTools = inherited["tools"] as string[] | undefined;
      next["tools"] = isCodingKind(kind) && inheritedTools ? inheritedTools.filter((tool) => tools.includes(tool)) : tools;
    } else if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

/**
 * The recipe after one more layer. The base is not changed. A `steps` patch for an id no step has is left out here;
 * `overlayProblems` reports it. Added skills need `resolveSkill` (the registry knows their names and digests).
 */
export function applyOverlay(base: ResolvedRecipe, overlay: RecipeOverlay, layer: RecipeLayer, resolveSkill?: (ref: SkillRef) => ResolvedSkill): ResolvedRecipe {
  const recipe = structuredClone(base);
  if (overlay.instructions) recipe.instructions.push({ agentName: layer.name, text: overlay.instructions });
  if (overlay.sequence) {
    const baseSteps = new Map(recipe.steps.map((step) => [step.id, step]));
    recipe.steps = overlay.sequence.map((spec) => {
      const baseStep = baseSteps.get(spec.id);
      const inherited = baseStep?.kind === spec.kind ? baseStep.settings : { instructions: [] };
      return { ...spec, settings: patchSettings(inherited, spec.settings, spec.kind, layer.name) };
    });
  }
  for (const [id, patch] of Object.entries(overlay.steps ?? {})) {
    const index = recipe.steps.findIndex((step) => step.id === id);
    const step = recipe.steps[index];
    if (step) recipe.steps[index] = { ...step, settings: patchSettings(step.settings, patch, step.kind, layer.name) };
  }
  if (overlay.tools) recipe.tools = overlay.tools;
  if (overlay.triggers) recipe.triggers = overlay.triggers;
  if (overlay.approvals?.alwaysAsk) recipe.approvals = { alwaysAsk: [...new Set([...recipe.approvals.alwaysAsk, ...overlay.approvals.alwaysAsk])] };
  if (overlay.skills) {
    const removed = new Set(overlay.skills.remove ?? []);
    const added = overlay.skills.add ?? [];
    if (added.length > 0 && !resolveSkill) throw new TypeError("applyOverlay needs resolveSkill to add a skill");
    const addedIds = new Set(added.map((ref) => ref.skillId));
    const kept = recipe.skills.filter((skill) => !removed.has(skill.skillId) && !addedIds.has(skill.skillId));
    const adds = new Map(added.map((ref) => [ref.skillId, resolveSkill!(ref)]));
    recipe.skills = [...kept, ...adds.values()];
  }
  if (overlay.autonomy !== undefined) recipe.autonomy = overlay.autonomy;
  if (overlay.allowMentions !== undefined) recipe.allowMentions = overlay.allowMentions;
  recipe.chain.push({ ...layer });
  return recipe;
}

/** Patches in an overlay's `steps` that name no step of the recipe it applies to (after its own `sequence`). */
export function overlayProblems(base: ResolvedRecipe, overlay: RecipeOverlay): RecipeProblem[] {
  const ids = new Set((overlay.sequence ?? base.steps).map((step) => step.id));
  return Object.keys(overlay.steps ?? {}).filter((id) => !ids.has(id)).map((id) => ({ path: `steps.${id}`, message: `no step has that id` }));
}

/** The structure a coding recipe must have for the workflow engine to run it. */
function codingStructureProblems(steps: readonly ResolvedStep[], add: (path: string, message: string) => void): void {
  const indexesOf = (kind: CodingStepKind) => steps.flatMap((step, index) => (step.kind === kind ? [index] : []));
  const plans = indexesOf("plan");
  plans.forEach((index, order) => {
    if (order > 0) add(`steps.${index}`, `a recipe can have only one plan step`);
    else if (index !== 0) add(`steps.${index}`, `the plan step must come first`);
  });
  // Rovara Code version 2: the plan check comes directly after the plan, and there is only one.
  indexesOf("plan_critic").forEach((index, order) => {
    if (order > 0) add("steps", "a recipe can have only one plan check step");
    else if (plans.length === 0) add("steps", "a plan check needs a plan step");
    else if (index !== (plans[0] ?? -1) + 1) add("steps", "a plan check must come right after the plan step");
  });
  const builds = indexesOf("build");
  if (builds.length === 0) add("steps", "a coding recipe needs at least one build step");
  const pullRequests = indexesOf("pull_request");
  pullRequests.forEach((index, order) => {
    if (order > 0) add(`steps.${index}`, `a recipe can have only one pull request step`);
    else if (index !== steps.length - 1) add(`steps.${index}`, `the pull request step must come last`);
  });
  if (pullRequests.length > 0) {
    const afterBuild = steps.slice((builds.at(-1) ?? -1) + 1);
    const checked = afterBuild.some((step) => step.kind === "check");
    const reviewed = afterBuild.some((step) => step.kind === "review" && step.reviewers.includes("code") && step.reviewers.includes("security"));
    if (!checked || !reviewed) add("steps", "a pull request step needs a check step and a review step with both reviewers after the last build step");
  }
  steps.forEach((step, index) => {
    if (step.kind !== "review" || !step.onFindings) return;
    const target = steps.findIndex((other) => other.id === step.onFindings?.backTo);
    if (target < 0 || target >= index || steps[target]?.kind !== "build") {
      add(`steps.${index}.onFindings.backTo`, `"${step.onFindings.backTo}" must name an earlier build step`);
    }
  });
}

function toolProblem(step: ResolvedStep, tools: readonly string[]): string | undefined {
  const label = `the "${step.id}" step (${step.kind})`;
  if (!(step.kind in STEP_TOOLS)) return `${label} takes no tools`;
  if (tools.length === 0) return `${label} has no tools left; the layers it builds on narrowed them to nothing`;
  const allowed: readonly string[] = STEP_TOOLS[step.kind as keyof typeof STEP_TOOLS];
  const piNames: readonly string[] = PI_TOOL_NAMES;
  const refused = step.kind === "agent"
    // Other names are connector tool patterns; only a Pi tool name has to be one the step can have.
    ? tools.filter((tool) => piNames.includes(tool) && (!allowed.includes(tool) || step.workspace === "none"))
    : tools.filter((tool) => !allowed.includes(tool));
  if (refused.length === 0) return undefined;
  const can = step.kind === "agent" && step.workspace === "none" ? "no workspace tools (it has no workspace)" : allowed.join(", ");
  return `${label} can't use ${refused.join(", ")}; it can use ${can}`;
}

/**
 * Integrations Rovara knows by name that are not connectors an agent can be given. A recipe that grants a connector called one of these is asking for
 * something no project can give it, so it is refused when it is published rather than matching nothing in silence. (A project's connector may well be
 * called `slack`; then the recipe names it by its type.) At run time a `{ name }` selector matches only a connector whose type is one of
 * `AgentConnectorTypeSchema`, whatever its name.
 */
const NOT_AGENT_CONNECTORS: readonly string[] = ["slack"];

/** Problems with a recipe's tool grants that can be seen without a project: a name selector that no connector an agent can use is called. */
export function toolGrantProblems(tools: readonly ToolGrant[]): RecipeProblem[] {
  const problems: RecipeProblem[] = [];
  tools.forEach((grant, index) => {
    if ("name" in grant.connector && NOT_AGENT_CONNECTORS.includes(grant.connector.name)) {
      problems.push({ path: `tools.${String(index)}.connector`, message: `${grant.connector.name} isn't a connector agents can use; name a connector of the project, or pick a type: ${AgentConnectorTypeSchema.options.slice(0, -1).join(", ")} or ${AgentConnectorTypeSchema.options.at(-1) ?? ""}` });
    }
  });
  return problems;
}

/** Why a recipe can't be published or run, in terms of its structure. Empty when it can. */
export function recipeProblems(recipe: ResolvedRecipe): RecipeProblem[] {
  const problems: RecipeProblem[] = [];
  const add = (path: string, message: string) => { problems.push({ path, message }); };
  problems.push(...toolGrantProblems(recipe.tools));
  const steps = recipe.steps;
  if (steps.length === 0) add("steps", "a recipe needs at least one step");

  const indexById = new Map<string, number>();
  steps.forEach((step, index) => {
    if (indexById.has(step.id)) add(`steps.${index}.id`, `the id "${step.id}" is used by more than one step`);
    else indexById.set(step.id, index);
  });

  const hasCoding = steps.some((step) => isCodingKind(step.kind));
  if (hasCoding && steps.some((step) => !isCodingKind(step.kind))) add("steps", "a recipe can't mix coding steps and agent steps; link the two agents in a chain instead");
  else if (hasCoding) codingStructureProblems(steps, add);

  steps.forEach((step, index) => {
    const settings = step.settings as Record<string, unknown> & { tools?: string[] };
    const at = (key: string) => `steps.${index}.settings.${key}`;
    if (settings.tools) {
      const message = toolProblem(step, settings.tools);
      if (message) add(at("tools"), `${message}`);
    }
    if (step.kind === "check") {
      for (const key of Object.keys(settings)) {
        if (key !== "timeoutMinutes" && key !== "instructions" && key !== "tools") add(at(key), `a check step only takes a timeout`);
      }
    }
    const other = settings["differentCompanyFrom"];
    if (typeof other === "string") {
      if (step.kind !== "review" && step.kind !== "agent") add(at("differentCompanyFrom"), `only a review or agent step can name a step to differ from`);
      else if ((indexById.get(other) ?? index) >= index) add(at("differentCompanyFrom"), `"${other}" must name an earlier step`);
    }
  });

  return problems;
}

/** Rovara Code's built-in version 1: plan, build, check, then a two-reviewer review that sends findings back to build for 3 rounds, then the pull request. */
function isRovaraCodeVersion1(steps: readonly ResolvedStep[]): boolean {
  if (steps.map((step) => step.kind).join() !== "plan,build,check,review,pull_request") return false;
  const review = steps[3];
  if (review?.kind !== "review" || [...review.reviewers].sort().join() !== "code,security") return false;
  return review.onFindings?.maxRounds === 3 && steps.findIndex((step) => step.id === review.onFindings?.backTo) === 1;
}

/**
 * The workflow program a coding recipe's engine follows, or undefined when the engine's own path (Rovara Code's
 * version 1: same step kinds, order and review settings) already is that recipe, or when the recipe isn't a coding one.
 */
export function codingProgram(recipe: ResolvedRecipe): WorkflowProgram | undefined {
  if (recipeRunner(recipe) !== "coding" || isRovaraCodeVersion1(recipe.steps)) return undefined;
  const steps: WorkflowProgram["steps"] = [];
  for (const step of recipe.steps) {
    if (step.kind === "review") steps.push({ id: step.id, kind: step.kind, reviewers: [...step.reviewers], ...(step.onFindings ? { onFindings: { ...step.onFindings } } : {}) });
    else if (isCodingKind(step.kind)) steps.push({ id: step.id, kind: step.kind });
  }
  return { steps };
}

/** SHA-256 of the recipe's canonical JSON (hex): equal recipes have equal digests whatever their key order. */
export function recipeDigest(recipe: ResolvedRecipe): string {
  return createHash("sha256").update(canonicalJson(recipe), "utf8").digest("hex");
}

/** Settings whose value is one unit: a changed model is one change, not one per field of it. */
const WHOLE_VALUE_KEYS = new Set(["model", "fallbackModel"]);

function pointer(parent: string, key: string | number): string {
  return `${parent}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diffValues(path: string, before: unknown, after: unknown, found: string[]): void {
  if (before === undefined && after === undefined) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) diffValues(pointer(path, index), before[index], after[index], found);
  } else if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (WHOLE_VALUE_KEYS.has(key)) {
        if (canonicalJson(before[key]) !== canonicalJson(after[key])) found.push(pointer(path, key));
      } else {
        diffValues(pointer(path, key), before[key], after[key], found);
      }
    }
  } else if (canonicalJson(before) !== canonicalJson(after)) {
    found.push(path);
  }
}

/** The versions of the agents a recipe builds on: the chain without the agent's own layer (a built-in is always a base). */
function baseVersions(recipe: ResolvedRecipe): Array<RecipeLayer["version"]> {
  return recipe.chain.filter((layer, index) => layer.builtin || index < recipe.chain.length - 1).map((layer) => layer.version);
}

/**
 * JSON-pointer paths (`/steps/1/settings/model`) of what differs between two recipes. The chain is left out but for
 * the versions of what the recipe builds on, reported as `/base/version`; `/allowMentions` shows like any other field.
 */
export function diffRecipes(before: ResolvedRecipe, after: ResolvedRecipe): string[] {
  const found: string[] = [];
  const withoutChain = (recipe: ResolvedRecipe) => Object.fromEntries(Object.entries(recipe).filter(([key]) => key !== "chain"));
  diffValues("", withoutChain(before), withoutChain(after), found);
  if (canonicalJson(baseVersions(before)) !== canonicalJson(baseVersions(after))) found.push("/base/version");
  return found;
}

/** JSON-pointer paths of what an overlay sets, down to each setting of a step (`/steps/build/model`). */
export function overlayPaths(overlay: RecipeOverlay): string[] {
  const paths: string[] = [];
  const setKeys = (value: object) => Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key]) => key);
  const nested = (parent: string, value: object) => {
    const keys = setKeys(value);
    if (keys.length === 0) paths.push(parent);
    for (const key of keys) paths.push(pointer(parent, key));
  };
  for (const key of setKeys(overlay)) {
    const value = overlay[key as keyof RecipeOverlay];
    if (key === "steps") for (const [id, settings] of Object.entries(overlay.steps ?? {})) nested(pointer("/steps", id), settings);
    else if (key === "approvals" || key === "skills") nested(pointer("", key), value as object);
    else paths.push(pointer("", key));
  }
  return paths;
}
