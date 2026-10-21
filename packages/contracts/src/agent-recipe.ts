// The agent recipe: the steps an agent runs, the settings of each, the tools it may use, and the overlay an
// agent version stores on top of the agent it builds on. Every schema here is strict, so a recipe cannot carry a
// field that reaches the safety layer (prompts, extensions, environment variables, sandbox or allowed domains).
// This file holds schemas and types; Task 4 adds the functions that apply, check and compare recipes.
import { z } from "zod";
import { ToolPatternSchema } from "./action-policy.js";
import { AGENT_NAME_MAX, AgentIdSchema, AutonomySchema, SkillIdSchema } from "./agent.js";
import { ConnectorNameSchema } from "./connectors.js";
import { ModelSelectionSchema } from "./models.js";

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

export const CODING_STEP_KINDS = ["plan", "build", "check", "review", "pull_request"] as const;
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
  review: READ_ONLY_TOOLS,
  agent: READ_ONLY_TOOLS,
} as const satisfies Record<"build" | "plan" | "review" | "agent", readonly PiToolName[]>;

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

/** Connector types an agent can be granted tools on. Plan 4 adds its types here and to the connection types. */
export const AgentConnectorTypeSchema = z.enum(["github", "linear", "jira", "asana", "mcp"]);
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
  tools: z.array(ToolPatternSchema).max(64).optional(),
}).strict();
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

const AlwaysAskSchema = z.array(ToolPatternSchema).max(MAX_ALWAYS_ASK_RULES);
export const ApprovalRulesSchema = z.object({ alwaysAsk: AlwaysAskSchema }).strict();
export type ApprovalRules = z.infer<typeof ApprovalRulesSchema>;

/** The ways a run can start that agents allow at launch. Plan 4 adds `event` and `schedule` here and to the schema below. */
export const TRIGGER_KINDS_AT_LAUNCH = ["person"] as const;
export const TriggerSpecSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("person") }).strict()]);
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
    description: z.string().max(1024),
    digest: Sha256HexSchema,
  }).strict()).max(MAX_RESOLVED_SKILLS),
  autonomy: AutonomySchema,
  allowMentions: z.boolean(),
}).strict();
export type ResolvedRecipe = z.infer<typeof ResolvedRecipeSchema>;
