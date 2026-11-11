// "How we work" (H4): what makes a change to a project's process layer wait for a person on the confirmation page, on top of what `lessSafeChanges` already asks about for any agent.
// A process layer tunes Rovara Code for a whole project, so the things that keep its checking honest are guarded: the plan check and the review must stay independent of the step they
// check, must not move to a weaker model, and their instructions must not change quietly; and no step may start sending a project's code to an AI company the published version never used.
// Like `lessSafeChanges` it is deliberately blunt: a wrong "safe" is worse than one more click. A step whose model is not set runs on the project's default, whose company and strength are
// not known here, so an unset model is unknown: it is never the reason for a flag in (a) to (c) (the company check (c) does flag a first model when nothing the current version used is known).
import { EMPTY_RECIPE, type ResolvedRecipe, type ResolvedStep } from "@rovara-code/contracts";
import { lessSafeChanges } from "../agents/less-safe.js";
import { classifyStageChoiceChange } from "../model-selection/classify.js";

/**
 * The time a step may run when its recipe sets none: the same default an agent step is watched against (agents/run-engine.ts). The built-in Rovara Code sets no step time and a coding step with no time has no per-step limit
 * at all, so this is only the yardstick for a time set where there was none; it is deliberately the lower of the defaults in use (a wrong "safe" is worse than one more click).
 */
export const PROCESS_DEFAULT_STEP_TIMEOUT_MINUTES = 60;

/** What the comparison needs to word its reasons: whether `current` is a published version, or (a first publish) the process the layer builds on. */
export interface ProcessLessSafeContext {
  firstPublish: boolean;
}

type StepModels = { instructions?: ReadonlyArray<{ text: string }> };
const settingsOf = (step: ResolvedStep): StepModels => step.settings;
const checks = (step: ResolvedStep): boolean => step.kind === "plan_critic" || step.kind === "review";
const sameStep = (left: ResolvedStep, right: ResolvedStep): boolean => left.id === right.id && left.kind === right.kind;
const labelOf = (step: ResolvedStep): string => (step.kind === "plan_critic" ? "plan check" : "review step");

/** The instructions of a step as written, layer by layer: only the text counts (renaming the agent that wrote a layer changes no instruction). */
const instructionTexts = (step: ResolvedStep): string[] => (settingsOf(step).instructions ?? []).map((layer) => layer.text).filter((text) => text.length > 0);

const timeoutOf = (step: ResolvedStep | undefined): number | undefined => (step?.settings as { timeoutMinutes?: number | null } | undefined)?.timeoutMinutes ?? undefined;
const budgetOf = (step: ResolvedStep | undefined): number | undefined => (step?.settings as { stepBudgetUsd?: number | null } | undefined)?.stepBudgetUsd ?? undefined;

/** (f) For any step of `next`: a time above the one that runs now (a time set where there was none is judged against the default), a time taken away, a spending limit above the current one, or a spending limit taken away. */
function limitRaises(before: ResolvedRecipe, next: ResolvedRecipe, found: string[]): void {
  for (const step of next.steps) {
    const was = before.steps.find((candidate) => sameStep(candidate, step));
    const timeBefore = timeoutOf(was);
    const timeAfter = timeoutOf(step);
    // An unset step time means no per-step limit (dispatch sends none), so taking a time away is a raise whatever it was; a time set where there was none is judged against the default.
    if (timeAfter === undefined) {
      if (timeBefore !== undefined) found.push(`Removes the time limit of the step "${step.name}"`);
    } else if (timeAfter > (timeBefore ?? PROCESS_DEFAULT_STEP_TIMEOUT_MINUTES)) {
      found.push(`Raises the time the step "${step.name}" may run, from ${String(timeBefore ?? PROCESS_DEFAULT_STEP_TIMEOUT_MINUTES)} to ${String(timeAfter)} minutes`);
    }
    const budgetBefore = budgetOf(was);
    const budgetAfter = budgetOf(step);
    if (budgetBefore === undefined) continue;
    if (budgetAfter === undefined) found.push(`Removes the spending limit of the step "${step.name}"`);
    else if (budgetAfter > budgetBefore) found.push(`Raises the spending limit of the step "${step.name}", from $${String(budgetBefore)} to $${String(budgetAfter)}`);
  }
}

/**
 * What `next` does to a process layer that `current` (the recipe that runs now: the published version, or for a first publish the process it builds on) does not make as safe. For the
 * plan check and review steps present in both recipes (the same id and kind):
 *   (a) one that was independent of the step it checks (a different model from the build step's, or the plan step's for the plan check, or told to differ in company) and now uses the
 *       same model, or no longer has `differentCompanyFrom`;
 *   (b) one whose weakest model moves to a weaker tier (`criticCapabilityTier`; its fallback counts);
 *   (d) one whose instructions change in any way.
 *   (e) one that `next` takes out, or a review step that loses a reviewer.
 * And for any step of `next`:
 *   (c) a model, or a fallback model, from a company that no step of `current` used.
 *   (f) a step time above the current one or taken away, or a spending limit raised or taken away (follow-up M1; lowering either is an ordinary publish).
 * Empty when none of these apply.
 */
export function processLessSafeChanges(current: ResolvedRecipe | undefined, next: ResolvedRecipe, context: ProcessLessSafeContext): string[] {
  const found: string[] = [];
  const before = current ?? EMPTY_RECIPE;
  found.push(...classifyStageChoiceChange({ kind: "process", before: current, after: next, firstPublish: context.firstPublish }));
  for (const step of next.steps) {
    const was = before.steps.find((candidate) => sameStep(candidate, step));
    if (was === undefined || !checks(step)) continue;
    if (JSON.stringify(instructionTexts(was)) !== JSON.stringify(instructionTexts(step))) found.push(`Changes the instructions of the ${labelOf(step)} "${step.name}"`);
  }
  // (e) A plan check or review step of `current` that `next` takes out, or a review step that loses a reviewer (final review C1: belt and braces; the ordinary rules flag a removed
  // review step but not a removed plan check). The words match the ordinary rules', so a reason both find is listed once.
  for (const was of before.steps) {
    if (!checks(was)) continue;
    const now = next.steps.find((candidate) => sameStep(candidate, was));
    if (now === undefined) found.push(`Removes the ${labelOf(was)} "${was.name}"`);
    else if (was.kind === "review" && now.kind === "review" && was.reviewers.some((reviewer) => !now.reviewers.includes(reviewer))) found.push(`Gives the review step "${was.name}" fewer reviewers`);
  }
  limitRaises(before, next, found);
  return [...new Set(found)];
}

/**
 * Why a publish, rollback or version change of `agent` waits for a person: the ordinary reasons (`lessSafeChanges`), and for a project's process layer (`purpose: "process"`) the reasons
 * above as well. Any other agent is judged by the ordinary reasons alone.
 */
export function lessSafeChangesFor(agent: { purpose?: string | undefined }, current: ResolvedRecipe | undefined, next: ResolvedRecipe, context: ProcessLessSafeContext): string[] {
  const ordinary = lessSafeChanges(current, next);
  return agent.purpose === "process" ? [...new Set([...ordinary, ...processLessSafeChanges(current, next, context)])] : ordinary;
}
