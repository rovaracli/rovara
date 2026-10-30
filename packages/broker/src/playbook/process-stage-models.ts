// "How we work" (V3): the process layer's model choices are checked by lane C's resolver before a publish, a confirm of a pending publish or a rollback makes them effective.
// The layer is a project's own (the project comes from the layer record the server loaded, never from a request); the recipe checked is the one that would become effective, resolved by
// the server from the draft or the stored version. A refusal stores nothing and asks nobody: it carries the resolver's fixed codes (and the page to fix each on) in the existing error
// shape. A draft save never asks (an unresolved draft may hold a choice that is valid but not yet verified); a layer with no model choice, and any other agent, is not read at all.
import { STAGE_IDS, AgentXError, type AgentId, type OrgId, agentXError, canonicalJson, stageRefusalMessage, type RecipeOverlay, type ResolvedRecipe, type StageId, type StageModelChoice, type StageModelRefusalCode, type StageRefusal } from "@agentx/contracts";
import type { ApprovalDependencies } from "../agents/approvals-store.js";
import { resolveAgent, type AgentRecord } from "../agents/store.js";
import { validateStageChoices } from "../model-selection/read.js";
import { loadStageModelSnapshot } from "../model-selection/snapshot.js";
import { frozenRecipeModelInputs } from "../model-selection/stage-inputs.js";

type Choices = Partial<Record<StageId, StageModelChoice>>;
/** What the guard reads with: the table, the agent store and the sources the model rows read. */
export type StageGuardDependencies = Pick<ApprovalDependencies, "documentClient" | "tableName" | "now" | "store" | "modelRouting" | "chatgpt">;

/** The page that helps fix each refusal: the company's AI models for access problems, the company's How we work for locks. Only same-origin app paths, and none when there is no such page. */
const MODELS_PAGE = "/app/admin/models/sources";
const COMPANY_PAGE = "/app/admin/how-we-work";
const PROJECT_NAME = /^[a-zA-Z0-9_-]{1,100}$/u;
function fixHrefFor(code: StageModelRefusalCode, project: string): string | undefined {
  if (code === "MODEL_NOT_VERIFIED" || code === "MODEL_STALE" || code === "DIFFERENT_FROM_UNSATISFIABLE" || code === "NO_VERIFIED_CANDIDATE") return MODELS_PAGE;
  if (code === "STAGE_LOCKED" || code === "LOCK_UNSATISFIABLE") return COMPANY_PAGE;
  if (code === "MODEL_NOT_ALLOWED_IN_PROJECT") return PROJECT_NAME.test(project) ? `/app/projects/${project}` : undefined;
  return undefined;
}

/** What the change would make effective, and who asks. */
export interface StageChoicePublication {
  /** The process layer the change is about (loaded by the server). */
  layer: AgentRecord;
  /** The recipe and overlay that would become effective (the draft, or the stored version), and the version when it is one. */
  recipe: ResolvedRecipe;
  overlay: RecipeOverlay;
  version?: number | undefined;
  /** The person whose access the choices are checked for: who asks, never a field of a request. */
  developerId: string;
  /** The choices of the version that runs now, read only when a locked stage disagrees with a choice (a choice kept as it was published is not a new conflict). */
  running?: (() => Promise<Choices>) | undefined;
}

const REFERENCE_OF: ReadonlyArray<readonly [StageId, StageId]> = [["plan_check", "plan"], ["code_review", "build"], ["security_review", "build"]];
const LOCKABLE = ["model", "thinkingLevel", "fallbackModel", "differentFrom"] as const;
const differs = (left: unknown, right: unknown): boolean => canonicalJson(left ?? null) !== canonicalJson(right ?? null);

/** The refusal the resolver would not give: a choice that disagrees with a company lock is silently outranked at run time, so the publish refuses it (a choice kept as published is not a new one). */
async function lockConflicts(locks: ReadonlyMap<StageId, StageModelChoice>, choices: Choices, running: (() => Promise<Choices>) | undefined): Promise<Set<StageId>> {
  const conflicting = new Set<StageId>();
  let kept: Choices | undefined;
  for (const [stage, lock] of locks) {
    const choice = choices[stage];
    if (choice === undefined) continue;
    for (const field of LOCKABLE) {
      if (choice[field] === undefined || !differs(choice[field], lock[field])) continue;
      kept ??= running === undefined ? {} : await running();
      if (differs(choice[field], kept[stage]?.[field])) conflicting.add(stage);
    }
  }
  return conflicting;
}

const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The model settings could not be read. Reload and try again.");

/** Refuses (CONFIG_INVALID, with the resolver's codes) when a model choice of the process layer can't be resolved or disagrees with a company lock. Nothing for any other agent or a layer without choices. */
export async function requireResolvableStageChoices(deps: StageGuardDependencies, input: StageChoicePublication): Promise<void> {
  const { layer } = input;
  if (layer.purpose !== "process" || layer.owner.kind !== "project") return;
  const projectChoices = frozenRecipeModelInputs(input.recipe, input.overlay).projectChoices;
  if (Object.keys(projectChoices).length === 0) return;
  // `canEdit: true` only satisfies the read's draft gate: the edit right was checked by the route that asked (and, on a confirm, by the approval's own rules).
  const project = layer.owner.project, caller = { orgId: layer.orgId, developerId: input.developerId };
  let refusals: StageRefusal[];
  try {
    const snapshot = await loadStageModelSnapshot({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, store: deps.store, routing: deps.modelRouting ?? {}, chatgpt: deps.chatgpt }, caller, project, undefined, { record: layer, recipe: input.recipe, overlay: input.overlay, ...(input.version === undefined ? {} : { version: input.version }) });
    const result = await validateStageChoices({ now: deps.now, projectFor: async () => ({ name: project, canEdit: true }), snapshot: async () => snapshot }, caller, project, projectChoices);
    const locks = new Map<StageId, StageModelChoice>(snapshot.stages.flatMap((row) => (row.companyLock === undefined ? [] : [[row.stage, row.companyLock] as const])));
    const locked = await lockConflicts(locks, projectChoices, input.running);
    const codes = new Map<StageId, StageModelRefusalCode>();
    for (const stage of result.stages) if (stage.kind === "refusal") codes.set(stage.stage, stage.code);
    for (const stage of locked) if (!codes.has(stage)) codes.set(stage, "STAGE_LOCKED");
    // A checking stage whose Build (or Plan) is refused has nothing to differ from: that is the same cause, listed once, on the stage that has it.
    for (const [checking, reference] of REFERENCE_OF) if (codes.has(reference) && codes.get(checking) === "MODEL_NOT_VERIFIED") codes.delete(checking);
    refusals = STAGE_IDS.flatMap((stage) => {
      const code = codes.get(stage);
      if (code === undefined) return [];
      const fixHref = fixHrefFor(code, project);
      return [{ code, stage, ...(fixHref === undefined ? {} : { fixHref }) }];
    });
  } catch (error) {
    // A fixed class only: nothing the resolver or the sources said travels on.
    throw error instanceof AgentXError ? error : unavailable();
  }
  if (refusals.length > 0) throw agentXError("CONFIG_INVALID", stageRefusalMessage(refusals));
}

/** The choices of the version of `layer` that runs now (none before a first publish). */
export const runningChoices = (deps: StageGuardDependencies, layer: AgentRecord): (() => Promise<Choices>) => async () => {
  if (layer.currentVersion === undefined) return {};
  const [recipe, version] = [await resolveAgent(deps.store, layer.orgId, layer.agentId, layer.currentVersion), await deps.store.getVersion(layer.orgId, layer.agentId, layer.currentVersion)];
  return frozenRecipeModelInputs(recipe, version?.overlay).projectChoices;
};

/**
 * The layer's stored version `version` is about to be made what the project runs (the playbook is pointed at it): its model choices must resolve, as for a publish. Nothing is
 * checked for the person who is not asking, and a version that holds no choice is not read further.
 */
export async function requireVersionStageChoices(deps: StageGuardDependencies, orgId: OrgId, agentId: AgentId, version: number, developerId: string): Promise<void> {
  const layer = await deps.store.get(orgId, agentId);
  const stored = await deps.store.getVersion(orgId, agentId, version);
  if (layer === undefined || stored === undefined) throw unavailable();
  const recipe = await resolveAgent(deps.store, orgId, agentId, version);
  await requireResolvableStageChoices(deps, { layer, recipe, overlay: stored.overlay, version, developerId });
}
