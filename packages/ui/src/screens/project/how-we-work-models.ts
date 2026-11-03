// "How we work": the project's model choices for a stage, as edits to the process layer's draft step settings (model, thinkingLevel, differentCompanyFrom). Nothing here decides which model is allowed or better:
// the answers come from the stage-models read and the server checks what is saved.
import type { Overlay } from "../builder/draft-state.js";
import { modelKey, type StageModelsStage, type ThinkingLevel } from "../../api/stage-models.js";
import { candidateBlock } from "./stage-model-text.js";
/** The picker's "Rovara's default": the project makes no choice and the model field is removed. */
export const DEFAULT_MODEL = "__default";
/** `inherit` removes the setting, `null` is "Model default" (no explicit level), else a level. */
export type EffortValue = "inherit" | "null" | ThinkingLevel;
export interface StageEdit { model?: string; effort?: EffortValue; vendor?: boolean }
export type ModelEdits = Record<string, StageEdit>;
export const baselineModel = (stage: StageModelsStage): string => stage.projectChoice?.model === undefined ? DEFAULT_MODEL : modelKey(stage.projectChoice.model);
export const baselineEffort = (stage: StageModelsStage): EffortValue => { const effort = stage.projectChoice?.thinkingLevel;return effort === undefined ? "inherit" : effort === null ? "null" : effort; };
/** The vendor rule somebody set (the project's, else the company's). */
export const explicitVendor = (stage: StageModelsStage): boolean => (stage.projectChoice?.differentFrom ?? stage.companyDefault?.differentFrom)?.level === "vendor";
/** The switch's state: a rule somebody set, or the default rule of a checking step nobody set (a different company than the step it checks, in force even when no such model is available). */
export const baselineVendor = (stage: StageModelsStage): boolean => explicitVendor(stage) || ("effective" in stage && (stage.effective.reason === "DEFAULT_DIFFERENT_COMPANY" || stage.effective.noOtherCompany === true || stage.effective.otherCompanyFailed === true));
/** The edits of one step after `patch`, leaving out anything equal to what the draft already holds. */
export function mergeEdit(edits: ModelEdits, stepId: string, patch: StageEdit, base: StageModelsStage): ModelEdits {
 const next: StageEdit = { ...edits[stepId], ...patch };
 if (next.model === baselineModel(base)) delete next.model;
 if (next.effort === baselineEffort(base)) delete next.effort;
 if (next.vendor === baselineVendor(base)) delete next.vendor;
 const rest = { ...edits };
 if (Object.keys(next).length === 0) delete rest[stepId];else rest[stepId] = next;
 return rest;
}
/** `provider/modelId` as the overlay stores it. */
export function modelSelection(model: string): { provider: string; modelId: string } {
 const at = model.indexOf("/");
 return { provider: model.slice(0, at), modelId: model.slice(at + 1) };
}
/** Whether turning "different vendor" on for this card has to write the vendor rule: the stage is locked, a model is chosen for it by the project or the company, or the company has a rule of its own for it. Otherwise on is the default, and writes nothing. */
export const needsExplicitVendor = (stages: readonly StageModelsStage[]): boolean => applicableStages(stages).some(stage => stage.locked || stage.projectChoice?.model !== undefined || stage.companyDefault?.model !== undefined || stage.companyDefault?.differentFrom !== undefined);
/** The overlay with the edits written into the steps' settings. `references` gives, per step, the earlier step its "different vendor" toggle names. Fields not edited stay as they are. */
export function applyModelEdits(overlay: Overlay, edits: ModelEdits, references: Readonly<Record<string, string | undefined>>, explicit: Readonly<Record<string, boolean>> = {}): Overlay {
 const steps: Record<string, Record<string, unknown>> = { ...(overlay.steps ?? {}) };
 for (const [id, edit] of Object.entries(edits)) {
  const settings: Record<string, unknown> = { ...steps[id] };
  if (edit.model !== undefined) { if (edit.model === DEFAULT_MODEL) delete settings.model;else settings.model = modelSelection(edit.model); }
  if (edit.effort !== undefined) { if (edit.effort === "inherit") delete settings.thinkingLevel;else settings.thinkingLevel = edit.effort === "null" ? null : edit.effort; }
  if (edit.vendor !== undefined) {
   const reference = references[id];
   // Off writes the explicit different-model rule. On returns to the default (no rule) unless a rule must be written for it to hold: the step has a model or lock, or the company's own rule would otherwise apply (`explicit`).
   if (!edit.vendor) settings.differentCompanyFrom = null;
   else if (reference !== undefined) { if (explicit[id] === true || settings.model !== undefined) settings.differentCompanyFrom = reference;else delete settings.differentCompanyFrom; }
  }
  if (Object.keys(settings).length === 0) delete steps[id];else steps[id] = settings;
 }
 const next: Overlay = { ...overlay };
 if (Object.keys(steps).length > 0) next.steps = steps;else delete next.steps;
 return next;
}
/** The stages of a card that run a model of their own: a member that runs none (not applicable, e.g. Understand using the Plan model) is not counted. */
export const applicableStages = (stages: readonly StageModelsStage[]): StageModelsStage[] => stages.filter(stage => !("notApplicable" in stage));
/** Whether a person can change this card's model settings: at least one member runs a model, and every member that does is editable and not locked. */
export const stagesEditable = (stages: readonly StageModelsStage[]): boolean => {
 const applicable = applicableStages(stages);
 return applicable.length > 0 && applicable.every(stage => stage.editable && stage.notice === undefined && !stage.locked && !("effective" in stage && stage.effective.locked));
};
/** Drops the pending edits the latest read no longer allows: a stage that is locked, not editable or gone, or a chosen model that is not (or no longer) verified and unblocked in every stage of the card. Returns the same object when nothing was dropped. */
export function pruneEdits(edits: ModelEdits, stagesOf: (stepId: string) => readonly StageModelsStage[] | undefined): ModelEdits {
 const kept: ModelEdits = {};
 for (const [id, edit] of Object.entries(edits)) {
  const all = stagesOf(id);
  if (all === undefined || !stagesEditable(all)) continue;
  const stages = applicableStages(all);
  const model = edit.model;
  if (model !== undefined && model !== DEFAULT_MODEL && !stages.every(stage => stage.candidatesState === "complete" && stage.candidates.some(candidate => modelKey(candidate.model) === model && candidateBlock(candidate) === undefined))) {
   const { model: _dropped, ...rest } = edit;void _dropped;
   if (Object.keys(rest).length > 0) kept[id] = rest;
   continue;
  }
  kept[id] = edit;
 }
 const same = Object.keys(kept).length === Object.keys(edits).length && Object.entries(kept).every(([id, edit]) => edit === edits[id]);
 return same ? edits : kept;
}
