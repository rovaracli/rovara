// Convergence S0-Q2 (area 24): the model each step runs on, Cloud's settings mapped onto the core's per-step model port.
//
// The core asks one question of its install before a workflow step is handed to a worker: `stepModels.choose({ stage, reference, denied, lastAttempt })`
// answers the model, the thinking level, the reason and the proxy route (vendor core/task-flow/step-model.ts). Code's own answer comes from a service that is
// not exported from the vendor package, and it carries one company's setting. Cloud's answer is its own G3 choice function (`resolveStageModel`, the same
// function the core's service was copied from), over Cloud's records. So the root answers the core's question with Cloud's function over Cloud's facts:
//
//   - the company's per-step setting is the `MODEL_SELECTION_POLICY` row, unchanged (the core reads the same row; a locked step stays locked);
//   - the models a step may use are the ones Cloud's routing can serve now (`servable`), each with the source that serves it;
//   - a checking step nobody set follows the hosted rule (a different company's model than the step it checks), as on Cloud's path (`reviewDefaultDifferentCompany`);
//   - the model Cloud runs a step on when nothing is set is its install model (`defaultWorkerModel`);
//   - a model an earlier try found the account cannot call is left out (`unusable`, `denied`).
//
// What the core's port cannot carry is listed in settings-mapping.ts UNMAPPED_SETTINGS (per-project model choice and approved models, a person's own plan).
import { STAGE_REFERENCE, canonicalModelName, type InvocationModelRoute, type ModelIdentifier, type StageId, type StageModelChoice, type StageModelRefusalCode } from "@rovara-code/contracts";
import type { RegistryTaskFlowOptions } from "@rovara-code/broker/core/task-flow";
import { resolveStageModel, type StageModelInput, type VerifiedStageCandidate } from "../../model-selection/resolver.js";

/** Cloud's facts for one company, read fresh at each choice. A real install builds them over Cloud's routing and records; a test builds them from literals. */
export interface CloudModelFacts {
  companyId: string;
  /** The model sources' revision the candidates were read under (the resolver checks every candidate's evidence against it). */
  sourcesRevision(): Promise<number>;
  /** The models Cloud's routing can serve now, each with its source (`servableModels`). */
  servable(): Promise<readonly { model: ModelIdentifier; sourceId: string; sourceKind?: string | undefined }[]>;
  /** The model Cloud runs a step on when nothing is set (`defaultWorkerModel`). */
  installModel(): Promise<ModelIdentifier | undefined>;
  /** How a call to the model reaches it (Cloud's `routeModel`, as the invocation's route). Undefined: no source serves it. */
  route(model: ModelIdentifier): Promise<InvocationModelRoute | undefined>;
  /** The company's per-step setting (the `MODEL_SELECTION_POLICY` row's `stepOverrides`). */
  stepOverrides(): Promise<Readonly<Partial<Record<StageId, StageModelChoice & { locked?: boolean }>>>>;
  /** The canonical names (`canonicalModelName`) of models known not to be callable now (Cloud's usable-models record). */
  unusable(): Promise<ReadonlySet<string>>;
  /** Models the company forbids (its guardrails). */
  forbidden(): Promise<readonly ModelIdentifier[]>;
}

type StepModels = NonNullable<RegistryTaskFlowOptions["stepModels"]>;
type ChooseInput = Parameters<StepModels["choose"]>[0];
type StepChoice = Awaited<ReturnType<StepModels["choose"]>>;

/** The words a refused choice is told in (Cloud's own: it names the fix, never the model's key or source). */
export const STEP_MODEL_WORDS: Readonly<Record<StageModelRefusalCode | "NO_MODEL", string>> = {
  MODEL_NOT_VERIFIED: "The model set for this step can't be called now: its source isn't available.",
  MODEL_STALE: "The model set for this step could not be checked just now.",
  MODEL_FORBIDDEN: "The model set for this step is not allowed.",
  MODEL_NOT_ALLOWED_IN_PROJECT: "The model set for this step is not allowed in this project.",
  STAGE_LOCKED: "This step's model is locked.",
  DIFFERENT_FROM_UNSATISFIABLE: "This step is set to use a different model or company than the step it checks, and no other model that can be called fits.",
  LOCK_UNSATISFIABLE: "This step's locked model can't be called.",
  NO_VERIFIED_CANDIDATE: "No model can be called for this step. Ask an admin to check the company's model sources.",
  POLICY_STALE: "The model setting changed; reload and try again.",
  DRAFT_STALE: "The model setting changed; reload and try again.",
  NEEDS_CONFIRMATION: "This change needs a confirmation first.",
  NO_MODEL: "No model can be called for this company. Ask an admin to check the company's model sources.",
};

const CHECKING: ReadonlySet<StageId> = new Set<StageId>(["plan_check", "code_review", "security_review"]);
const same = (a: ModelIdentifier, b: ModelIdentifier): boolean => canonicalModelName(a) === canonicalModelName(b);

/** The core's `stepModels` port, answered by Cloud's choice function over Cloud's facts. */
export function createCloudStepModels(facts: CloudModelFacts): StepModels {
  async function choose(input: ChooseInput, depth = 0): Promise<StepChoice> {
    const [sourcesRevision, servable, install, overrides, unusable, forbidden] = await Promise.all([facts.sourcesRevision(), facts.servable(), facts.installModel(), facts.stepOverrides(), facts.unusable(), facts.forbidden()]);
    const setting = overrides[input.stage];
    // Nothing set for this step and Cloud has no model at all: there is no model to choose (the core hands the step over with no route, as before).
    if (install === undefined && setting?.model === undefined) return { ok: false, code: "NO_MODEL", words: STEP_MODEL_WORDS.NO_MODEL };
    // A checking step is told the model of the step it checks: its own reference, else what that step would run on now.
    let reference = input.reference;
    if (CHECKING.has(input.stage) && reference === undefined && depth === 0) {
      const checked = await choose({ stage: STAGE_REFERENCE[input.stage as keyof typeof STAGE_REFERENCE] }, 1);
      reference = checked.ok ? checked.step.model : install;
    }
    const candidates: VerifiedStageCandidate[] = servable.map((entry) => ({
      model: entry.model, sourceId: entry.sourceId, enabled: true, inEffectiveOrder: true, ...(entry.sourceKind === undefined ? {} : { sourceKind: entry.sourceKind }),
      evidence: { orgId: facts.companyId, sourcesRevision, kind: "rovara_catalog" as const },
      ...(unusable.has(canonicalModelName(entry.model)) ? { accountCannotUse: true as const } : {}),
    }));
    const resolverInput: StageModelInput = {
      orgId: facts.companyId, stage: input.stage, sourcesRevision, candidates, forbidden,
      ...(setting?.locked === true ? { companyLock: setting } : setting === undefined ? {} : { companyDefault: setting }),
      ...(install === undefined ? {} : { builtinDefault: install }),
      ...(reference === undefined ? {} : { referenceModel: reference }),
      // The hosted rule: a checking step nobody set uses another company's model than the step it checks (a step that checks on the same company's model says so).
      reviewDefaultDifferentCompany: true, allowLegacyDefaultFallback: true,
      ...((input.denied ?? []).length === 0 ? {} : { deniedModels: input.denied ?? [] }),
      ...(input.lastAttempt === true ? { defaultLastAttempt: true } : {}),
    };
    const result = resolveStageModel(resolverInput);
    if (result.kind === "refusal") return { ok: false, code: result.code, words: STEP_MODEL_WORDS[result.code] };
    const route = await facts.route(result.model);
    if (route === undefined) return { ok: false, code: "MODEL_NOT_VERIFIED", words: STEP_MODEL_WORDS.MODEL_NOT_VERIFIED };
    const checking = CHECKING.has(input.stage);
    return {
      ok: true,
      step: {
        model: result.model, thinkingLevel: result.thinkingLevel, reason: result.reason, route,
        ...(result.fallback === undefined ? {} : { fallback: result.fallback }),
        sameModelAsChecked: checking && reference !== undefined && same(result.model, reference),
      },
    };
  }
  return { choose: (input) => choose(input) };
}
