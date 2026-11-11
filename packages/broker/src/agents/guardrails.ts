import { classifyStageChoiceChange } from "../model-selection/classify.js";
import { budgetActorRefused, type BudgetActor } from "./budget-authority.js";
// Plan 3 Task 8: the company's agent guardrails as the broker uses them. This file reads and writes the document, says which changes to it
// are less safe (those wait for an org admin on the confirmation page, changes.ts), checks a recipe against it when the recipe is
// published (`validateRecipeForOrg`) and decides whether a built-in agent is turned off. It does not import access.ts or changes.ts,
// so both can use it.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentGuardrailsSchema, AgentGuardrailsWriteSchema, AutonomySchema, BUILTIN_AGENTS, DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, agentXError, canonicalModelName, forbiddenModelMatcher, isBuiltinAgentId, modelCompany, recipeProblems, type AgentGuardrails, type AgentId, type ModelCompany, type ModelIdentifier, type OrgId, type RecipeProblem, type ResolvedRecipe, type ResolvedStep } from "@rovara-code/contracts";
import { bedrockClaudeModelIds } from "@agentx/model-runtime/catalog";
import { skillProblems } from "./skills.js";
import type { AgentRecord, AgentStore, AgentVersion, RequestMark } from "./store.js";

/** What reading the guardrails needs. */
export interface GuardrailDependencies {
  /** The State table. */
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

/** The models some source the company can use serves (Task 26's `servableModels`); the same model on another route counts as the same model. */
export type ServableModels = (orgId: OrgId) => Promise<ModelIdentifier[]>;

/** The guardrails as stored, with the revision a change must name (0 while the org has never changed them). */
export interface StoredGuardrails {
  guardrails: AgentGuardrails;
  revision: number;
}

const defaultGuardrails = (): AgentGuardrails => structuredClone(DEFAULT_AGENT_GUARDRAILS);

/**
 * The org's guardrails and their revision. A document that can't be read is an error, never the defaults: the defaults forbid
 * nothing, so falling back to them would quietly undo what an admin set.
 */
export async function readGuardrailsWithRevision(deps: GuardrailDependencies, orgId: OrgId): Promise<StoredGuardrails> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: agentGuardrailsKey(orgId), ConsistentRead: true })) as { Item?: { revision?: unknown; guardrails?: unknown } };
  const item = response.Item;
  if (item === undefined) return { guardrails: defaultGuardrails(), revision: 0 };
  const parsed = AgentGuardrailsSchema.safeParse(item.guardrails);
  if (!parsed.success || typeof item.revision !== "number" || !Number.isInteger(item.revision) || item.revision < 1) {
    console.error(JSON.stringify({ component: "broker", level: "error", event: "agent_guardrails_invalid", orgId, problem: parsed.success ? "revision" : parsed.error.issues[0]?.path.join(".") ?? "guardrails" }));
    throw agentXError("CONFIG_INVALID", "your company's agent guardrails can't be read; ask a Rovara admin to look at them");
  }
  return { guardrails: parsed.data, revision: item.revision };
}

/** The org's guardrails: the defaults until an owner or admin changes them. */
export async function readGuardrails(deps: GuardrailDependencies, orgId: OrgId): Promise<AgentGuardrails> {
  return (await readGuardrailsWithRevision(deps, orgId)).guardrails;
}

/**
 * Makes `value` the org's guardrails, in one transaction with the request's own item when `options.request` is given (R18). It applies
 * only while the document is at `options.expectedRevision` (by default the revision read now). Who may, and which changes wait for a
 * person, are the caller's checks.
 */
export async function writeGuardrails(
  deps: GuardrailDependencies & { store: Pick<AgentStore, "putGuardrails"> },
  orgId: OrgId,
  value: AgentGuardrails,
  by: string,
  options: { actor: BudgetActor; expectedRevision?: number; request?: RequestMark; /** A person confirmed a change that makes something less safe; the audit event says so. */ widened?: boolean },
): Promise<StoredGuardrails> {
  if (options?.actor === undefined) throw budgetActorRefused();
  const parsed = AgentGuardrailsWriteSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "guardrails"}: ${parsed.error.issues[0]?.message ?? "is not valid"}`);
  const expectedRevision = options.expectedRevision ?? (await readGuardrailsWithRevision(deps, orgId)).revision;
  return deps.store.putGuardrails({ actor: options.actor, orgId, guardrails: parsed.data, expectedRevision, by, ...(options.request === undefined ? {} : { request: options.request }), ...(options.widened === true ? { widened: true } : {}) });
}

// ---- which changes are less safe

const AUTONOMY_ORDER = AutonomySchema.options;
/** Agents build on at most three custom layers over a built-in; a little more covers a stored chain that is longer than that. */
const MAX_BASE_CHAIN = 8;
const modelLabel = (model: ModelIdentifier): string => `${model.provider}/${model.modelId}`;

/**
 * What a change to the guardrails makes less safe, in words (R9-3, R69): a forbidden model allowed again, cross-company review off, a
 * spending limit raised or removed, more autonomy allowed, a built-in turned back on, a trigger label or command word dropped, or a
 * report link host added. Tightening lists nothing, so it applies at once; any entry here makes the whole change wait for the page.
 */
export function lessSafeGuardrailChanges(current: AgentGuardrails, next: AgentGuardrails): string[] {
  const changes: string[] = [];
  changes.push(...classifyStageChoiceChange({ kind: "guardrails", before: current, after: next }));
  if (current.prCommentLearning === "locked_off" && next.prCommentLearning !== "locked_off") changes.push("Allows learning from PR review comments again");
  if (next.maxAgentMonthlyUsd > current.maxAgentMonthlyUsd) changes.push(`Raises the most one agent can spend in a month, from $${String(current.maxAgentMonthlyUsd)} to $${String(next.maxAgentMonthlyUsd)}`);
  if (next.maxPerRunCeilingUsd > current.maxPerRunCeilingUsd) changes.push(`Raises the most one run can be limited to, from $${String(current.maxPerRunCeilingUsd)} to $${String(next.maxPerRunCeilingUsd)}`);
  if (current.maxStepBudgetUsd !== undefined) {
    if (next.maxStepBudgetUsd === undefined) changes.push(`Removes the limit on what one step can spend (it was $${String(current.maxStepBudgetUsd)})`);
    else if (next.maxStepBudgetUsd > current.maxStepBudgetUsd) changes.push(`Raises the most one step can spend, from $${String(current.maxStepBudgetUsd)} to $${String(next.maxStepBudgetUsd)}`);
  }
  if (AUTONOMY_ORDER.indexOf(next.maxAutonomy) > AUTONOMY_ORDER.indexOf(current.maxAutonomy)) changes.push(`Raises how far agents may act on their own, from ${current.maxAutonomy} to ${next.maxAutonomy}`);
  for (const id of current.disabledBuiltins) {
    if (!next.disabledBuiltins.includes(id)) changes.push(`Turns ${BUILTIN_AGENTS[id].name} back on`);
  }
  for (const label of current.extraTriggerLabels) {
    if (!next.extraTriggerLabels.includes(label)) changes.push(`Stops treating the label "${label}" as a trigger`);
  }
  for (const word of current.extraCommandWords) {
    if (!next.extraCommandWords.includes(word)) changes.push(`Stops treating "${word}" as a command word`);
  }
  for (const host of next.reportLinkDomains) {
    if (!current.reportLinkDomains.includes(host)) changes.push(`Lets agent reports link to ${host}`);
  }
  return changes;
}

// ---- checking a recipe

/**
 * The models Rovara's own AI serves: the Claude models of Amazon Bedrock's inference profiles, which the model proxy offers. Until
 * Task 26's `servableModels` reads the company's sources, this is what every company can use.
 */
function rovaraCatalogModels(): ModelIdentifier[] {
  return bedrockClaudeModelIds("us").map((modelId) => ({ provider: "amazon-bedrock", modelId }));
}

interface RecipeCheckDependencies extends GuardrailDependencies {
  servableModels?: ServableModels;
}

type StepModels = { model?: ModelIdentifier | null; fallbackModel?: ModelIdentifier | null; stepBudgetUsd?: number | null; differentCompanyFrom?: string | null };

/** The models a step could run on: its own and its fallback. Empty when it names none (it then runs on the project's default). */
function modelsOf(step: ResolvedStep): ModelIdentifier[] {
  const { model, fallbackModel } = step.settings as StepModels;
  return [model, fallbackModel].filter((entry): entry is ModelIdentifier => entry !== undefined && entry !== null);
}

/**
 * Whether `step`'s models are all from companies other than every model of `other`. A step with no model of its own runs on the
 * project's default, whose company is not known here, so it can't be told apart and does not pass. Two models of an unrecognised
 * company can't be told apart either.
 */
function differsFrom(step: ResolvedStep, other: ResolvedStep): boolean {
  const mine = modelsOf(step).map(modelCompany);
  const theirs = new Set<ModelCompany>(modelsOf(other).map(modelCompany));
  // Claude reached through a route modelCompany does not know reads as "other" but is still Anthropic's, so "other" never passes, on either side.
  return mine.length > 0 && theirs.size > 0 && !theirs.has("other") && mine.every((company) => company !== "other" && !theirs.has(company));
}

/**
 * Why a recipe can't be published in this company: the recipe's own problems (`recipeProblems`), then anything the company's
 * guardrails forbid: a forbidden model (matched by canonical name, so another route to the same model counts), a model no
 * source serves, a step budget or autonomy above the limits, and, when cross-company review is required, a review step whose
 * models share a company with a build step's. A skill the company does not have (or a digest it never had) is a problem too (Task 9).
 * Empty when it can be.
 */
export async function validateRecipeForOrg(deps: RecipeCheckDependencies, orgId: OrgId, recipe: ResolvedRecipe): Promise<RecipeProblem[]> {
  const problems = recipeProblems(recipe);
  problems.push(...await skillProblems({ documentClient: deps.documentClient, tableName: deps.tableName, now: Date.now }, orgId, recipe));
  const add = (path: string, message: string) => {
    if (!problems.some((existing) => existing.path === path && existing.message === message)) problems.push({ path, message });
  };
  const guardrails = await readGuardrails(deps, orgId);
  const servable = await (deps.servableModels?.(orgId) ?? Promise.resolve(rovaraCatalogModels()));
  const servableNames = new Set(servable.map(canonicalModelName));
  const isForbidden = forbiddenModelMatcher(guardrails.forbiddenModels);

  recipe.steps.forEach((step, index) => {
    const found = step.settings as StepModels;
    for (const key of ["model", "fallbackModel"] as const) {
      const model = found[key];
      if (model === undefined || model === null) continue;
      const name = canonicalModelName(model);
      if (isForbidden(model)) add(`steps.${String(index)}.settings.${key}`, `${modelLabel(model)} is forbidden in your company; pick another model`);
      else if (!servableNames.has(name)) add(`steps.${String(index)}.settings.${key}`, `${modelLabel(model)} isn't served by any AI source your company can use; pick a model one of them serves`);
    }
    if (typeof found.stepBudgetUsd === "number" && guardrails.maxStepBudgetUsd !== undefined && found.stepBudgetUsd > guardrails.maxStepBudgetUsd) {
      add(`steps.${String(index)}.settings.stepBudgetUsd`, `$${String(found.stepBudgetUsd)} is more than your company allows for one step ($${String(guardrails.maxStepBudgetUsd)})`);
    }
  });
  if (AUTONOMY_ORDER.indexOf(recipe.autonomy) > AUTONOMY_ORDER.indexOf(guardrails.maxAutonomy)) add("autonomy", `${recipe.autonomy} is more than your company allows (${guardrails.maxAutonomy})`);

  if (guardrails.requireCrossCompanyReview) {
    // Only a recognised company the company can actually choose counts: a forbidden model, or one of an unrecognised company, can't be the second.
    const usable = new Set<ModelCompany>(servable.filter((model) => !isForbidden(model)).map(modelCompany));
    usable.delete("other");
    const secondCompany = usable.size >= 2;
    const requireDifferent = (path: string, step: ResolvedStep, other: ResolvedStep) => {
      if (differsFrom(step, other)) return;
      if (modelsOf(other).length === 0) add(path, `set the ${other.id} step to a model, so a different AI company can be checked for the ${step.id} step`);
      else if (!secondCompany) add(path, "your company has no AI source from a second AI company, so cross-company review can't be met; add one under AI sources");
      else add(path, `set the ${step.id} step to a model from a different AI company than the ${other.id} step`);
    };
    recipe.steps.forEach((step, index) => {
      if (step.kind === "review") {
        for (const other of recipe.steps) if (other.kind === "build") requireDifferent(`steps.${String(index)}`, step, other);
      }
      const named = (step.settings as StepModels).differentCompanyFrom;
      const other = typeof named === "string" ? recipe.steps.find((candidate) => candidate.id === named) : undefined;
      if (other !== undefined) requireDifferent(`steps.${String(index)}.settings.differentCompanyFrom`, step, other);
    });
  }
  return problems;
}

// ---- turned-off built-ins

/**
 * Refuses a base that is, or builds on, a built-in agent that is turned off: the base itself, or any agent in the chain of the version
 * a new layer would pin (a custom agent's current version, then the base that version builds on, and so on).
 */
export async function requireBaseEnabled(deps: GuardrailDependencies & { store: Pick<AgentStore, "get" | "getVersion"> }, orgId: OrgId, baseId: AgentId): Promise<void> {
  const seen = new Set<string>();
  let id: AgentId | undefined = baseId;
  while (id !== undefined && !seen.has(id) && seen.size < MAX_BASE_CHAIN) {
    if (isBuiltinAgentId(id)) return requireAgentEnabled(deps, orgId, id);
    seen.add(id);
    const agent: AgentRecord | undefined = await deps.store.get(orgId, id);
    const version: AgentVersion | undefined = agent?.currentVersion === undefined ? undefined : await deps.store.getVersion(orgId, id, agent.currentVersion);
    id = version?.extends?.agentId;
  }
}

/**
 * Refuses a built-in agent the company's admins turned off: for starting a run of it and for building a new agent on it. Agents already
 * built on it keep the version they pinned and are not asked about it here. A custom agent is never refused here.
 */
export async function requireAgentEnabled(deps: GuardrailDependencies, orgId: OrgId, agentId: AgentId): Promise<void> {
  if (!isBuiltinAgentId(agentId)) return;
  if ((await readGuardrails(deps, orgId)).disabledBuiltins.includes(agentId)) {
    throw agentXError("AGENT_UNAVAILABLE", `${BUILTIN_AGENTS[agentId].name} is turned off in your company. Ask an admin to turn it on.`);
  }
}
