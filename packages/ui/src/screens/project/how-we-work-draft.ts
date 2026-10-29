// "How we work": the rules in the process layer's draft. Project rules are the overlay's `instructions` (a layer every coding stage is given, which the server keeps out of the reviewing
// stages); a stage's own instructions are `steps[id].instructions`. Nothing else in the overlay is touched.
import type { Overlay } from "../builder/draft-state.js";
export interface RuleValues { rules: string; stages: Record<string, string> }
export interface RuleEdits { rules?: string; stages?: Record<string, string> }
export const EMPTY_RULES: RuleValues = { rules: "", stages: {} };
export function ruleValues(overlay: Overlay | undefined): RuleValues {
 const stages: Record<string, string> = {};
 for (const [id, settings] of Object.entries(overlay?.steps ?? {})) if (typeof settings.instructions === "string" && settings.instructions !== "") stages[id] = settings.instructions;
 return { rules: typeof overlay?.instructions === "string" ? overlay.instructions : "", stages };
}
/** The overlay with the edited rules written in (an empty text removes the layer). Fields not named stay as they are. */
export function applyRuleEdits(overlay: Overlay, edits: RuleEdits): Overlay {
 const next: Overlay = { ...overlay };
 if (edits.rules !== undefined) { if (edits.rules === "") delete next.instructions;else next.instructions = edits.rules; }
 if (edits.stages !== undefined) {
  const steps = { ...(overlay.steps ?? {}) };
  for (const [id, text] of Object.entries(edits.stages)) {
   const rest = { ...(steps[id] ?? {}) };
   delete rest.instructions;
   if (text !== "") steps[id] = { ...rest, instructions: text };
   else if (Object.keys(rest).length > 0) steps[id] = rest;
   else delete steps[id];
  }
  if (Object.keys(steps).length > 0) next.steps = steps;else delete next.steps;
 }
 return next;
}
/** The stage whose instructions an old draft can still hold although nothing uses them (the pull request stage). */
export const UNUSED_STAGE_ID = "pull_request";
