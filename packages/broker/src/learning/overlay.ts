// v1.2 learning loop, B6: the rule text of a process layer's overlay. A rule is appended as its own paragraph of a stage's instructions (or of the project-wide `instructions` for stage `*`)
// and removed again only as a whole paragraph that equals it exactly.
import { agentXError, type RecipeOverlay } from "@agentx/contracts";
import { RULE_TEXT_MAX } from "../playbook/inert-rule-text.js";

const RULES_FULL = "This stage's rules are full. Make room in How we work first.";

type StepSettings = { instructions?: string } & Record<string, unknown>;
const stageText = (overlay: RecipeOverlay, stage: string): string => stage === "*" ? overlay.instructions ?? "" : (overlay.steps?.[stage] as StepSettings | undefined)?.instructions ?? "";

function withStageText(overlay: RecipeOverlay, stage: string, text: string): RecipeOverlay {
  const next = structuredClone(overlay) as Record<string, unknown>;
  if (stage === "*") {
    if (text === "") delete next["instructions"]; else next["instructions"] = text;
    return next as RecipeOverlay;
  }
  const steps: Record<string, StepSettings> = { ...((next["steps"] as Record<string, StepSettings> | undefined) ?? {}) };
  const settings: StepSettings = { ...(steps[stage] ?? {}) };
  if (text === "") delete settings.instructions; else settings.instructions = text;
  if (Object.keys(settings).length === 0) delete steps[stage]; else steps[stage] = settings;
  if (Object.keys(steps).length === 0) delete next["steps"]; else next["steps"] = steps;
  return next as RecipeOverlay;
}

/** The overlay with `rule` appended as its own paragraph. The resulting stage text is checked against 4,000 characters BEFORE anything is written. */
export function appendRuleToOverlay(overlay: RecipeOverlay, stage: string, rule: string): RecipeOverlay {
  const existing = stageText(overlay, stage);
  const combined = existing === "" ? rule : `${existing}\n\n${rule}`;
  if (Array.from(combined).length > RULE_TEXT_MAX) throw agentXError("LEARNING_RULES_FULL", RULES_FULL);
  return withStageText(overlay, stage, combined);
}

/** How many paragraphs of the stage's text equal `rule` exactly, and the overlay without the first of them. */
export function removeRuleFromOverlay(overlay: RecipeOverlay, stage: string, rule: string): { matches: number; overlay: RecipeOverlay } {
  const paragraphs = stageText(overlay, stage).split("\n\n");
  const matches = paragraphs.filter((paragraph) => paragraph === rule).length;
  if (matches !== 1) return { matches, overlay };
  return { matches, overlay: withStageText(overlay, stage, paragraphs.filter((paragraph) => paragraph !== rule).join("\n\n")) };
}

