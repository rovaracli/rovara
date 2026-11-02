// Plan 3 Task 16: what an agent's recipe changes about one coding operation, at the moment the broker builds it. The recipe is the task's frozen
// snapshot (RECIPE, Task 15), never the live agent. `stepForOperation` finds the recipe step an operation is; `applyAgentStep` turns that
// step's settings into the model the operation runs on, the instruction section of its prompt and the `agentStep` the worker is sent. Nothing
// here reads or writes a table: the broker (`taskOperationParts`) reads the snapshot, the guardrails and the earlier operations and passes
// them in, so every rule below is a plain function of its input.
import {
  AGENT_STEP_INSTRUCTIONS_MAX_BYTES,
  STEP_TOOLS,
  agentXError,
  forbiddenModelMatcher,
  modelCompany,
  modelKey,
  type AgentGuardrails,
  type AgentStepPayload,
  type CodingStepKind,
  type InvocationModelRoute,
  type ModelIdentifier,
  type ModelSelection,
  type OrgId,
  type PiToolName,
  type ResolvedRecipe,
  type ResolvedStep,
  type ResultContract,
  type RunCheckout,
  type StepSettings,
} from "@agentx/contracts";
import type { ProxyGeography } from "@agentx/model-runtime/catalog";
import { DEFAULT_BEDROCK_MODELS } from "@agentx/model-runtime/config";
import { routeModel, routeOnWire, servingRoutes, type ModelRoute, type RoutingDependencies } from "../model-sources/routing.js";
import type { TaskAgentRef } from "./roster.js";
import { skillsForStep, stepInstructionLayers, wholeAgentLayers } from "../playbook/process-reviewers.js";

/** The workflow modes a coding operation runs in; a task started without the workflow has no mode and runs its first turn like an IMPLEMENT. */
export type DispatchMode = "UNDERSTAND" | "PLAN" | "PLAN_CRITIQUE" | "IMPLEMENT" | "REVIEW" | "CHECKS" | "FEEDBACK_REVIEW" | "SETUP_DRAFT" | "SETUP_AGENT" | "SPEC_WRITE";

// Understand is not a recipe step: it runs with the plan step's model and settings (so a recipe cannot remove the question-asking, and no model is chosen that the plan step could not run).
// That is everything of the plan step's: its model and fallback, thinking level, time limit, step budget, instruction layers, connector tools and skills. A change to the plan step in a recipe changes Understand too, knowingly.
// SETUP_DRAFT (Rovara Code, Task 10) is a read-only look at the repositories, so it runs on the plan step's model too: the same allowed-model checks as planning.
const KIND_OF_MODE: Record<DispatchMode, CodingStepKind> = { UNDERSTAND: "plan", PLAN: "plan", SETUP_DRAFT: "plan", SETUP_AGENT: "plan", SPEC_WRITE: "plan", PLAN_CRITIQUE: "plan_critic", IMPLEMENT: "build", REVIEW: "review", CHECKS: "check", FEEDBACK_REVIEW: "pull_request" };
/** What a step is called in a refusal when the recipe has no step of that kind (a program that leaves out its plan still gets the engine's planning pass). */
const KIND_LABEL: Record<CodingStepKind, string> = { plan: "Plan", plan_critic: "Plan check", build: "Build", check: "Check", review: "Review", pull_request: "Pull request" };

/**
 * The recipe step an operation is. With a program, the step the operation names (`programStepId`); without one, or when it names a step of
 * another kind, the first step of the kind the mode runs: PLAN is the plan step, IMPLEMENT the first build, REVIEW the review, CHECKS the
 * check and FEEDBACK_REVIEW the pull request step (it reaches Pi as a REVIEW). Undefined when the recipe has no such step.
 */
export function stepForOperation(recipe: ResolvedRecipe, mode: DispatchMode | undefined, programStepId?: string): ResolvedStep | undefined {
  const kind = KIND_OF_MODE[mode ?? "IMPLEMENT"];
  const named = programStepId === undefined ? undefined : recipe.steps.find((step) => step.id === programStepId && step.kind === kind);
  return named ?? recipe.steps.find((step) => step.kind === kind);
}

type StepModelSettings = Pick<StepSettings, "differentCompanyFrom" | "timeoutMinutes" | "thinkingLevel" | "tools"> & {
  model?: ModelSelection | null; fallbackModel?: ModelSelection | null; instructions?: ReadonlyArray<{ agentName: string; text: string }>;
};
const settingsOf = (step: ResolvedStep | undefined): StepModelSettings => (step?.settings ?? {});

/** What an agent-step run's operation is (Task 22): the step itself (no coding mode names it), and what its worker is given. */
export interface AgentRunStepInput {
  step: Extract<ResolvedStep, { kind: "agent" }>;
  inputs: string;
  resultContract?: ResultContract | undefined;
  checkout?: readonly RunCheckout[] | undefined;
}

export interface ApplyAgentStepInput {
  /** The task's frozen recipe; absent for work that has no agent (a Slack thread operation, a task from before agents): nothing changes. */
  recipe?: ResolvedRecipe | undefined;
  ref?: Pick<TaskAgentRef, "agentId" | "name" | "version" | "builtin"> | undefined;
  mode?: DispatchMode | undefined;
  programStepId?: string | undefined;
  /** The model the project would run this on (its selection or default); absent when the project lists no models. */
  projectModel?: ModelSelection | undefined;
  /** The project's approved models; absent when the project lists none, and then any model that is not forbidden is allowed. */
  projectApproved?: ReadonlyArray<ModelIdentifier> | undefined;
  guardrails: AgentGuardrails;
  project: string;
  /** The model the task's owner would run on from a ChatGPT plan, when the task is a ChatGPT-plan task. */
  chatgptModel?: ModelSelection | undefined;
  /** The models the earlier operations of this task ran on, by recipe step (only operations that recorded one). */
  priorOperations: ReadonlyArray<{ stepId: string; model?: ModelSelection | undefined }>;
  /** An agent-step run's step: then the mode and program step are not used, and the payload is the agent kind's. */
  agentRun?: AgentRunStepInput | undefined;
}

export interface AppliedAgentStep {
  /** The model the operation is sent. Absent when the recipe and the project name none. */
  model?: ModelSelection;
  /** The labelled block of the recipe's instructions, for the prompt; only when the recipe has instruction layers for this step. */
  promptSection?: string;
  /** What the worker is sent; absent for Rovara Code's built-in recipe and for an operation that is no step of the recipe. */
  agentStep?: AgentStepPayload;
  /** The recipe grants connector tools (Task 19): an agent step of it is given the `agent-tools` capability. */
  toolGrants?: true;
  /** The step chose a model of its own that the person's ChatGPT plan does not serve: the operation runs on the model proxy instead. */
  dropChatgpt: boolean;
  /** The model the operation will actually run on (the plan's when it stays on ChatGPT); what the operation record keeps for later comparisons. */
  ranModel?: ModelSelection;
}

/** Whether an operation is an agent step of a recipe that grants connector tools: it is given the `agent-tools` capability, and nothing else is (Task 19). */
export function givesAgentTools(applied: Pick<AppliedAgentStep, "agentStep" | "toolGrants"> | undefined): boolean {
  return applied?.agentStep?.kind === "agent" && applied.toolGrants === true;
}

const sameModel = (left: ModelIdentifier, right: ModelIdentifier): boolean => modelKey(left) === modelKey(right);

/** Whether `left` is from a known AI company other than `right`'s. A model of an unrecognised company can never be shown to differ. */
export function differentCompany(left: ModelIdentifier | undefined, right: ModelIdentifier | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const a = modelCompany(left);
  const b = modelCompany(right);
  return a !== "other" && b !== "other" && a !== b;
}

/**
 * The steps whose recorded models this step's must come from another company than: the one it names (`differentCompanyFrom`) and, when the
 * company requires cross-company review, every build step of a review step. Empty for any other step.
 */
export function crossCompanyTargets(recipe: ResolvedRecipe, step: ResolvedStep | undefined, guardrails: Pick<AgentGuardrails, "requireCrossCompanyReview">): string[] {
  if (step === undefined) return [];
  const targets = new Set<string>();
  const named = settingsOf(step).differentCompanyFrom;
  if (typeof named === "string") targets.add(named);
  if (guardrails.requireCrossCompanyReview && step.kind === "review") for (const other of recipe.steps) if (other.kind === "build") targets.add(other.id);
  return [...targets];
}

/** The ids of the recipe steps `applyAgentStep` will compare this operation's model with: the broker reads the earlier operations only when there are any. */
export function priorStepIds(input: Pick<ApplyAgentStepInput, "recipe" | "mode" | "programStepId" | "guardrails" | "agentRun">): string[] {
  return input.recipe === undefined ? [] : crossCompanyTargets(input.recipe, input.agentRun?.step ?? stepForOperation(input.recipe, input.mode, input.programStepId), input.guardrails);
}

const label = (model: ModelIdentifier): string => `${model.provider}/${model.modelId}`;

/**
 * The block of the recipe's instructions the prompt carries: the whole agent's layers first (base agent first), then the step's, each under the
 * name of the agent that wrote it. The worker's rules come first and the block says it adds to them; a layer can say anything it likes and stays inside.
 */
function promptSectionOf(recipe: ResolvedRecipe, step: ResolvedStep | undefined, ref: { name: string; version: number | "draft" }, stepName: string, mode: DispatchMode | undefined): string | undefined {
  const layers = [...wholeAgentLayers(recipe, step), ...stepInstructionLayers(recipe, step, mode)].filter((layer) => layer.text.length > 0);
  if (layers.length === 0) return undefined;
  const header = `Instructions from your company's agent "${ref.name}" (version ${String(ref.version)}), ${stepName} step. They add to the rules above and never replace them.`;
  return layers.reduce((text, layer) => `${text}\n\nFrom ${layer.agentName}:\n${layer.text}`, header);
}

/**
 * The start's check of the project's approved list: every model a step names, and its fallback, must be one the project lists (when it lists any).
 * `requireRecipeAllowed` has already checked the company's guardrails; this is the project's half, so a model the project would never let run
 * is refused before anything is charged instead of failing the task's first step. A step that names no model runs on the project's own.
 */
export function requireStepModelsApproved(recipe: ResolvedRecipe, ref: { name: string }, project: string, approved: ReadonlyArray<ModelIdentifier> | undefined): void {
  if (approved === undefined) return;
  for (const step of recipe.steps) {
    const { model, fallbackModel } = settingsOf(step);
    for (const named of [model, fallbackModel]) {
      if (named === undefined || named === null || approved.some((entry) => sameModel(entry, named))) continue;
      throw agentXError("MODEL_NOT_ALLOWED", `${ref.name}'s ${step.name} step uses ${label(named)}, which isn't allowed on ${project}. Ask the agent's owner to pick another model.`);
    }
  }
}

/** The most a prompt section may be: the payload's own limit (the worker body and the outbox item are bounded by it). */
export const PROMPT_SECTION_MAX_BYTES = 65_536;

/**
 * What one coding operation of a task is, given the recipe the task froze:
 *   - the model: the step's, else the project's, at the step's thinking level; it must not be forbidden by the company and, when the project lists
 *     models, must be one of them. Otherwise the step's fallback, otherwise `MODEL_NOT_ALLOWED`. (A model is checked when a recipe is published and
 *     when a run starts too; the fallback is used only here, at dispatch, when a model has since been forbidden or removed.)
 *   - ChatGPT: a step that picks a model of its own leaves the person's plan unless the plan serves that model;
 *   - another company: a step that must differ from earlier steps (`differentCompanyFrom`, or a review under the company's cross-company rule)
 *     is compared with the model the earlier operations of those steps ran on; on a match the fallback is used if it differs, else `MODEL_NOT_ALLOWED`;
 *   - the instruction block and the `agentStep` the worker is sent (none for Rovara Code's built-in recipe).
 * With no recipe nothing changes: the project's model, no section, no step.
 */
export function applyAgentStep(input: ApplyAgentStepInput): AppliedAgentStep {
  const { recipe } = input;
  if (recipe === undefined) {
    return { ...(input.projectModel === undefined ? {} : { model: input.projectModel }), dropChatgpt: false };
  }
  const lastLayer = recipe.chain.at(-1);
  const ref = input.ref ?? (lastLayer === undefined ? undefined : { agentId: lastLayer.agentId, name: lastLayer.name, version: lastLayer.version, builtin: lastLayer.builtin });
  if (ref === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the agent snapshot of this task has no agent in it");
  const step = input.agentRun?.step ?? stepForOperation(recipe, input.mode, input.programStepId);
  const settings = settingsOf(step);
  const stepName = step?.name ?? KIND_LABEL[KIND_OF_MODE[input.mode ?? "IMPLEMENT"]];

  // The company's forbidden models and cross-company rule apply to every agent with a snapshot, Rovara Code's own model included (ruled intended).
  // Work with no agent (a Slack thread operation, an install without `agents`) has no snapshot and is not checked here. A Slack turn's models are not left unchecked: the key for the turn
  // is minted by `mintChatTurnKey`, which holds the assistant model, the model the Slack service is configured with and the classifier to the same forbidden list (RP-4: "make Slack obey it", 2026-11-02).
  const forbidden = forbiddenModelMatcher(input.guardrails.forbiddenModels);
  const usable = (model: ModelIdentifier): boolean => !forbidden(model)
    && (input.projectApproved === undefined || input.projectApproved.some((approved) => sameModel(approved, model)));
  const notAllowed = (model: ModelIdentifier) => agentXError("MODEL_NOT_ALLOWED", `${ref.name}'s ${stepName} step uses ${label(model)}, which isn't allowed on ${input.project}. Ask the agent's owner to pick another model.`);
  // The person's plan model is a model like any other: one the company forbids is not used, and the operation runs on the proxy instead.
  const planModel = input.chatgptModel !== undefined && !forbidden(input.chatgptModel) ? input.chatgptModel : undefined;
  const servedByPlan = (model: ModelIdentifier): boolean => planModel !== undefined && model.provider.toLowerCase() !== "amazon-bedrock" && modelCompany(model) === "openai" && model.modelId === planModel.modelId;
  /** The model the operation would really run on if `chosen` were picked: the person's plan unless the step picked a model of its own that the plan does not serve. */
  const ranOn = (chosen: ModelSelection | undefined, own: boolean): ModelSelection | undefined =>
    planModel !== undefined && !(own && chosen !== undefined && !servedByPlan(chosen)) ? planModel : chosen;

  const ownModel = settings.model ?? undefined;
  const fallback = settings.fallbackModel ?? undefined;
  let chosen: ModelSelection | undefined = ownModel ?? input.projectModel;
  let own = ownModel !== undefined;
  let usedFallback = false;
  if (chosen !== undefined && !usable(chosen)) {
    if (fallback === undefined || !usable(fallback)) throw notAllowed(chosen);
    chosen = fallback;
    own = true;
    usedFallback = true;
  }

  const targets = crossCompanyTargets(recipe, step, input.guardrails);
  const earlier = input.priorOperations.filter((prior) => targets.includes(prior.stepId));
  if (earlier.length > 0) {
    const clashing = (model: ModelSelection | undefined, isOwn: boolean) => earlier.find((prior) => !differentCompany(ranOn(model, isOwn), prior.model));
    const clash = clashing(chosen, own);
    if (clash !== undefined) {
      if (!usedFallback && fallback !== undefined && usable(fallback) && clashing(fallback, true) === undefined) {
        chosen = fallback;
        own = true;
      } else {
        const other = recipe.steps.find((candidate) => candidate.id === clash.stepId)?.name ?? clash.stepId;
        throw agentXError("MODEL_NOT_ALLOWED", `${ref.name} needs its ${stepName} step from a different AI company than its ${other} step, and none is allowed on ${input.project}. Ask an admin to add one.`);
      }
    }
  }

  const level = settings.thinkingLevel ?? undefined;
  const model: ModelSelection | undefined = chosen === undefined ? undefined : {
    provider: chosen.provider, modelId: chosen.modelId,
    ...(level !== undefined ? { thinkingLevel: level } : chosen.thinkingLevel === undefined ? {} : { thinkingLevel: chosen.thinkingLevel }),
  };
  const dropChatgpt = input.chatgptModel !== undefined && (planModel === undefined || (own && chosen !== undefined && !servedByPlan(chosen)));
  const ranModel = dropChatgpt ? model : planModel ?? model;

  // An agent step's instructions travel in its payload (the worker puts them after its own preamble), not in a prompt section.
  const promptSection = input.agentRun === undefined ? promptSectionOf(recipe, step, ref, stepName, input.mode) : undefined;
  if (promptSection !== undefined && Buffer.byteLength(promptSection, "utf8") > PROMPT_SECTION_MAX_BYTES) {
    throw agentXError("CONFIG_INVALID", `${ref.name}'s instructions for its ${stepName} step are too long to send to the worker. Ask the agent's owner to shorten them.`);
  }
  const agentStep = input.agentRun !== undefined ? agentRunStepOf(recipe, ref, stepName, input.agentRun)
    : step === undefined || (ref.builtin && ref.agentId === "rovara-code") ? undefined : agentStepOf(recipe, step, ref, promptSection);
  return {
    ...(model === undefined ? {} : { model }),
    ...(promptSection === undefined ? {} : { promptSection }),
    ...(agentStep === undefined ? {} : { agentStep }),
    // An agent step of a run always gets the `agent-tools` scope, with or without grants: the worker asks for its catalogs before it starts a step and treats a
    // refusal as a failed step, so a step with no grants is answered an empty list (Task 23's review, Task 22).
    ...(recipe.tools.length > 0 || input.agentRun !== undefined ? { toolGrants: true as const } : {}),
    dropChatgpt,
    ...(ranModel === undefined ? {} : { ranModel }),
  };
}

/** What the worker is told about the step: the tools it may use (never beyond what its kind allows), its skills, its time limit and the instruction block. */
function agentStepOf(recipe: ResolvedRecipe, step: ResolvedStep, ref: { agentId: TaskAgentRef["agentId"]; version: number | "draft" }, promptSection: string | undefined): AgentStepPayload {
  const settings = settingsOf(step);
  // A step takes at most the tools its kind allows, whatever the snapshot says: a review never has the shell. Check and pull request steps take none.
  const allowed: readonly string[] = step.kind in STEP_TOOLS ? STEP_TOOLS[step.kind as keyof typeof STEP_TOOLS] : [];
  const tools = (settings.tools ?? []).filter((tool): tool is PiToolName => allowed.includes(tool));
  const skills = step.kind === "check" ? [] : skillsForStep(recipe, step).map((skill) => ({ skillId: skill.skillId, digest: skill.digest }));
  const timeoutMinutes = settings.timeoutMinutes ?? undefined;
  return {
    kind: "coding",
    agentId: ref.agentId,
    version: ref.version,
    stepId: step.id,
    ...(tools.length === 0 ? {} : { tools }),
    ...(skills.length === 0 ? {} : { skills }),
    ...(timeoutMinutes === undefined ? {} : { timeoutMs: timeoutMinutes * 60_000 }),
    ...(promptSection === undefined ? {} : { promptSection }),
  };
}

/** The recipe's instructions for a step as one block: the whole agent's layers first (base agent first), then the step's, each under the name of the agent that wrote it. */
export function instructionBlock(recipe: ResolvedRecipe, step: ResolvedStep): string {
  const layers = [...wholeAgentLayers(recipe, step), ...(settingsOf(step).instructions ?? [])].filter((layer) => layer.text.length > 0);
  return layers.map((layer) => (layer.agentName === "" ? layer.text : `From ${layer.agentName}:\n${layer.text}`)).join("\n\n");
}

/** What the worker is sent for an agent step of a run: the step's instructions, workspace, time limit and skills, what it is handed to read, and the branches it may choose. */
function agentRunStepOf(recipe: ResolvedRecipe, ref: { agentId: TaskAgentRef["agentId"]; version: number | "draft" }, stepName: string, run: AgentRunStepInput): AgentStepPayload {
  const { step } = run;
  const instructions = instructionBlock(recipe, step);
  if (Buffer.byteLength(instructions, "utf8") > AGENT_STEP_INSTRUCTIONS_MAX_BYTES) {
    throw agentXError("CONFIG_INVALID", `The instructions for the ${stepName} step are too long to send to the worker. Ask the agent's owner to shorten them.`);
  }
  const timeoutMinutes = settingsOf(step).timeoutMinutes ?? undefined;
  const skills = recipe.skills.map((skill) => ({ skillId: skill.skillId, digest: skill.digest }));
  return {
    kind: "agent",
    agentId: ref.agentId,
    version: ref.version,
    stepId: step.id,
    instructions,
    workspace: step.workspace,
    inputs: run.inputs,
    ...(timeoutMinutes === undefined ? {} : { timeoutMs: timeoutMinutes * 60_000 }),
    ...(skills.length === 0 ? {} : { skills }),
    ...(run.resultContract === undefined ? {} : { resultContract: run.resultContract }),
    ...(run.checkout === undefined || run.checkout.length === 0 ? {} : { checkout: [...run.checkout] }),
  };
}

// ---- the model's route (Task 26)

/** What a step is called in a refusal and in the route's words: the recipe step's name, else the kind the mode runs. */
export function stepName(recipe: ResolvedRecipe | undefined, mode: DispatchMode | undefined, programStepId?: string): string {
  return (recipe === undefined ? undefined : stepForOperation(recipe, mode, programStepId)?.name) ?? KIND_LABEL[KIND_OF_MODE[mode ?? "IMPLEMENT"]];
}

/** A default Bedrock model id (`us.anthropic.claude-...`) in the geography the install's proxy serves: an eu install's catalog holds the eu profiles. */
export function inGeography(modelId: string, geography: ProxyGeography = "us"): string {
  return modelId.replace(/^us\./, `${geography}.`);
}

/** The model a worker runs when nothing names one: the install's default for the worker, which Rovara's catalog serves. */
export function defaultWorkerModel(geography?: ProxyGeography): ModelIdentifier {
  return { provider: "amazon-bedrock", modelId: inGeography(DEFAULT_BEDROCK_MODELS.worker, geography) };
}

export interface RoutedStep {
  /** Whether the operation still runs on the person's ChatGPT plan: the plan is used only when no source listed before it serves the plan's model. */
  keepChatgpt: boolean;
  /** The route the operation's key is scoped to: the model it runs on, or on the proxy if the plan fails. Null when no source can serve that (a plan's backup that nothing serves). */
  route: ModelRoute | null;
  /** The model the route was chosen for. */
  requested: ModelIdentifier;
  /** What the invocation carries as `modelRoute`: only a route the worker cannot reach by the model's own name. */
  wire?: InvocationModelRoute;
}

/**
 * Task 26: where one coding operation's model comes from. `model` is the model the operation would run on (the step's, else the project's, else the
 * install's default). A task on a ChatGPT plan keeps the plan only if the plan is the first source in the order that serves the plan's model; its
 * backup (`model`, used if the plan fails) is routed too, and may be unserved without refusing the task. Any other operation must be served by a source
 * or it is refused with MODEL_NOT_ALLOWED in the words of the step.
 */
export async function routeStep(deps: RoutingDependencies, input: {
  orgId: OrgId; project: string; agent: string; step: string; model: ModelSelection | undefined;
  /** The plan's model and whose plan, when the task is on one. */
  plan?: { developerId: string; model: ModelSelection } | undefined;
  /** Server resolver source for governed dispatches; fresh routing must agree. */
  expectedSourceId?: string | undefined;
}): Promise<RoutedStep> {
  // Governed source evidence requires stored-key presence. Keep the router's fresh
  // source ordering and disagreement guard, but never route through a removed key.
  const sourceStore=deps.sources;
  const routing=input.expectedSourceId===undefined||sourceStore===undefined?deps:{...deps,sources:{read:async(orgId:OrgId)=>{
    const stored=await sourceStore.read(orgId);
    return {...stored,sources:stored.sources.filter(source=>source.kind==="bedrock"||source.kind==="endpoint"||stored.credentials.includes(source.sourceId))};
  }}};
  const requested: ModelIdentifier = input.model === undefined ? defaultWorkerModel(deps.rovaraGeography) : { provider: input.model.provider, modelId: input.model.modelId };
  const base = { orgId: input.orgId, project: input.project };
  let keepChatgpt = false;
  if (input.plan !== undefined) {
    const [first] = await servingRoutes(routing, { ...base, payerDeveloperId: input.plan.developerId, model: input.plan.model });
    keepChatgpt = first?.sourceId === "personal-chatgpt";
  }
  // The plan is not in play for the model the proxy serves: it is never asked to serve it, so a route here always has an alias.
  const route = keepChatgpt
    ? (await servingRoutes(routing, { ...base, model: requested }))[0] ?? null
    : await routeModel(routing, { ...base, model: requested, subject: { agent: input.agent, step: input.step } });
  const actualSourceId = keepChatgpt ? "personal-chatgpt" : route?.sourceId ?? "rovara";
  if (input.expectedSourceId !== undefined && actualSourceId !== input.expectedSourceId) throw agentXError("MODEL_NOT_ALLOWED", "The task's verified model source changed. Reload and try again.");
  const wire = route === null ? undefined : routeOnWire(route, requested);
  return { keepChatgpt, route, requested, ...(wire === undefined ? {} : { wire }) };
}
