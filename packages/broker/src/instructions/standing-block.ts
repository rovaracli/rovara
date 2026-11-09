// Standing instructions (lane I1): builds the ONE text a step carries in its system prompt. Pure: the dispatch reads the company rules, the recipe's layers and the switch, and passes them in.
// Order, top to bottom: the precedence wording, company rules (Required, then Preferred), the project's "How we work" (the whole process's layers, then the step's), per-task extras (lane I4; empty for now).
// Rovara's own prompt and preamble come before this block in the prompt and always win; the repository's files, skills and lessons come after it and rank below it.
import { createHash } from "node:crypto";
import { STANDING_INSTRUCTIONS_WORDING, redactText, type CompanyInstructionsSnapshot, type CompanyRule, type StandingInstructionsPayload } from "@agentx/contracts";
import { inertRuleText } from "../playbook/inert-rule-text.js";

const { header, company: companyTitle, required: requiredTitle, preferred: preferredTitle, howWeWork: howWeWorkTitle, extras: extrasTitle } = STANDING_INSTRUCTIONS_WORDING;

/** One piece of project-written or task-written text, under the name of the agent or person who wrote it (an empty name prints the text alone). */
export interface StandingLayer { agentName: string; text: string }

export interface StandingInstructionsInput {
  /** The company's rules, already checked against the size limits (`readCompanyInstructions`). */
  company?: CompanyInstructionsSnapshot | undefined;
  /** The project's "How we work": the whole process's layers, then the step's, already filtered for the step (`wholeAgentLayers`, `stepInstructionLayers`). */
  howWeWork?: readonly StandingLayer[] | undefined;
  /** Per-task extras (lane I4 fills this; nothing passes it yet). */
  extras?: readonly StandingLayer[] | undefined;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * A company rule as one bullet: hidden characters out, secrets redacted (the text is checked again at render, not only at save), line breaks folded into spaces so a rule cannot start a
 * section of its own.
 */
const bulletOf = (rule: CompanyRule): string => `- ${redactText(inertRuleText(rule.text)).replace(/\s*\n\s*/g, " ").trim()}`;

function companySection(company: CompanyInstructionsSnapshot): string {
  const group = (priority: CompanyRule["priority"], title: string): string[] => {
    const rules = company.rules.filter((rule) => rule.priority === priority);
    return rules.length === 0 ? [] : [title, ...rules.map(bulletOf)];
  };
  return [companyTitle, ...group("required", requiredTitle), ...group("preferred", preferredTitle)].join("\n");
}

function layersSection(title: string, layers: readonly StandingLayer[]): string | undefined {
  const present = layers.filter((layer) => layer.text.length > 0);
  if (present.length === 0) return undefined;
  return [title, ...present.map((layer) => (layer.agentName === "" ? layer.text : `From ${layer.agentName}:\n${layer.text}`))].join("\n\n");
}

const numbered = (sections: ReadonlyArray<string | undefined>): string =>
  sections.filter((section): section is string => section !== undefined).map((section, index) => `${String(index + 1)}. ${section}`).join("\n\n");

/**
 * The block for one step, or `undefined` when there is nothing to say (no company rules, no layers, no extras): then the step's prompt is exactly what it was before. The sections that are present are
 * numbered in order of authority. `company` is the company part alone, which a stage that may not see the project's layers (the second reviewer shown only the change) still gets.
 */
export function buildStandingInstructions(input: StandingInstructionsInput): StandingInstructionsPayload | undefined {
  const company = input.company === undefined || input.company.rules.length === 0 ? undefined : input.company;
  const companyText = company === undefined ? undefined : companySection(company);
  const howWeWork = layersSection(howWeWorkTitle, input.howWeWork ?? []);
  const extras = layersSection(extrasTitle, input.extras ?? []);
  if (companyText === undefined && howWeWork === undefined && extras === undefined) return undefined;
  const text = `${header}\n\n${numbered([companyText, howWeWork, extras])}`;
  return {
    text,
    digest: sha256(text),
    ...(company === undefined ? {} : { company: { version: company.version, text: `${header}\n\n${numbered([companyText])}` } }),
  };
}
