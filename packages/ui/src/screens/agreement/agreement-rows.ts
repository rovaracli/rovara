// The Working agreement panel's rows, worked out from reads the app already makes. Pure: no React, no network.
// A row is one rule in plain words, its value, and its ORIGIN. An origin is never guessed: it comes from a marker the broker sent (a source and a lock), a lock flag, or a plain comparison with the default the
// contract names. A source the page cannot read produces no rows at all (the panel lists it as "Not available yet").
import { DESIGN_REVIEW_DEFAULT_SETTING, designReviewSettingOf, type KnownFailingPolicyState, type ProjectPlaybookResponse, type StageModelsResponse } from "@agentx/contracts/web";
import type { LearningView } from "../../api/learning.js";
import type { LessonsView } from "../../api/lessons.js";
import type { CompanyRulesSummary } from "../../api/agreement.js";
import { modelKey, stageResult } from "../../api/stage-models.js";
import { TIER_LABELS, approverWords, lockedSet, markOf, settingLines, type SettingField } from "../project/design-review-setting.js";
import { STAGE_LABELS } from "../project/stage-model-text.js";
import type { Mark, StageRead, ViewRead } from "../project/how-we-work-rows.js";
import type { Origin, SourceId } from "./agreement-text.js";

export interface AgreementRow {
 id: string;
 title: string;
 /** The value in plain words (shown as plain text). */
 value: string;
 origin: Origin;
 /** The version of the layer the value is in, when the broker says which. */
 version?: number;
 /** A change to this rule waits for a second admin. */
 pending?: boolean;
 /** Where "Why?" sends an admin who may change it. */
 manage?: "how-we-work" | "company-rules";
 source: SourceId | "task";
}
export interface StepRows { id: string; name: string; rows: AgreementRow[] }
/** A locked row says why it can't be changed: a company lock, or a fact Rovara keeps for safety. */
export const isLocked = (row: Pick<AgreementRow, "origin">): boolean => row.origin === "company-lock" || row.origin === "rovara-fixed";

/** The origin of a value the broker marked (the How we work view's `source` and lock). A lock wins over the source. */
export function originOfMark(mark: Mark): Origin {
 if (mark.locked) return mark.lockedBy === "rovara" ? "rovara-fixed" : mark.lockedBy === "company" ? "company-lock" : originOfSource(mark.source);
 return originOfSource(mark.source);
}
const originOfSource = (source: string): Origin => source === "company" ? "company-default" : source === "project" ? "project-choice" : "rovara-default";

const TEXT_MAX = 160;
/** One line of at most 160 characters, white space folded (a rule's own text can be long). */
export function brief(text: string): string {
 const flat = text.replace(/\s+/gu, " ").trim(), characters = [...flat];
 return characters.length <= TEXT_MAX ? flat : characters.slice(0, TEXT_MAX - 1).join("") + "…";
}
const withVersion = (origin: Origin, version: number | undefined): { version?: number } => origin === "project-choice" && version !== undefined ? { version } : {};

// ---- the project and company How we work layers ----
/** A word a newer server sent that this version does not know has no row: nothing is claimed about a value this page cannot read. */
const SECOND_OPINION_WORDS: Readonly<Record<string, string>> = { off: "Off", shadow: "Trial: shown on the task page, never blocks", on: "On: its blocking findings count" };
const projectVersion = (view: ViewRead): number | undefined => view.process.kind === "project_process" ? view.process.version : undefined;

function stageRowsOf(stage: StageRead, names: ReadonlyMap<string, string>, version: number | undefined): AgreementRow[] {
 const rows: AgreementRow[] = [], add = (key: string, title: string, value: string, origin: Origin) => { rows.push({ id: stage.id + ":" + key, title, value, origin, source: "layers", ...withVersion(origin, version) }); };
 // Instruction layers. Rovara's own built-in layers are one line (their text is a prompt, not a rule anyone wrote); every other layer is a rule.
 let builtIn = false;
 stage.knows.instructions.forEach((layer, index) => {
  const origin = originOfMark(layer);
  if (origin === "rovara-default") { builtIn = true;return; }
  add("instructions-" + String(index), "Instructions", brief(layer.value), origin);
 });
 if (builtIn) add("instructions-builtin", "Instructions", "Rovara's own instructions for this step", "rovara-default");
 if (stage.who.differentCompanyFrom.value.length > 0) add("different", "Checked by a different AI company from", stage.who.differentCompanyFrom.value.map(id => names.get(id) ?? "another step").join(", "), originOfMark(stage.who.differentCompanyFrom));
 const second = stage.who.secondOpinion;
 const secondWords = second === undefined ? undefined : SECOND_OPINION_WORDS[second.value];
 if (second !== undefined && secondWords !== undefined) add("second", "Second opinion from another AI company", secondWords, originOfMark(second));
 add("tools", "Tools it may use", stage.may.tools.value === null ? "Any tool this step is given" : stage.may.tools.value.join(", "), originOfMark(stage.may.tools));
 if (stage.may.readOnly) add("read-only", "What it may change", "Nothing: it can read files but not change them", "rovara-fixed");
 for (const [key, title, items] of [["checked", "How it's checked", stage.checked.items], ["evidence", "Evidence kept", stage.evidence.items], ["approves", "Who approves", stage.approves.items]] as const) {
  items.forEach((item, index) => { add(key + "-" + String(index), title, brief(item.value), originOfMark(item)); });
 }
 return rows;
}

/** The project-wide part (the process in use and the rules for every step) and one block of rows per step. */
export function layerRows(view: ViewRead): { project: AgreementRow[]; steps: StepRows[] } {
 const version = projectVersion(view), own = view.process.kind === "project_process";
 const project: AgreementRow[] = [{ id: "process", title: "How this project works", value: own ? "The project's own process" : "Rovara Code's built-in process", origin: own ? "project-choice" : "rovara-default", source: "layers", ...(own && version !== undefined ? { version } : {}) }];
 view.rules.forEach((rule, index) => { const origin = originOfMark(rule);project.push({ id: "rule-" + String(index), title: "Rule for every step", value: brief(rule.value), origin, source: "layers", ...withVersion(origin, version) }); });
 const names = new Map(view.stages.map(stage => [stage.id, stage.name]));
 return { project, steps: view.stages.map(stage => ({ id: stage.id, name: stage.name, rows: stageRowsOf(stage, names, version) })) };
}

// ---- design review ----
/** Design review's rows, or undefined when the broker says the stage does not exist for this install (nothing to show, so the panel lists it as not available). */
export function designReviewRows(read: ProjectPlaybookResponse, nameOf?: (id: string) => string | undefined): AgreementRow[] | undefined {
 // The company has not allowed design review: a company decision no project can change.
 if (read.designReviewAllowed === false) return [{ id: "design-review", title: "Design review", value: "Not turned on by your company", origin: "company-lock", source: "design-review" }];
 if (read.playbook.designReview === undefined) return undefined;
 const setting = designReviewSettingOf(read.playbook), locked = lockedSet(read.designReviewLocked), lines = settingLines(setting, locked, read.designReviewUnreadable === true ? { canEdit: false } : undefined);
 const line = (field: SettingField) => lines.find(entry => entry.field === field)!;
 const row = (field: SettingField, title: string, value: string): AgreementRow => ({ id: "design-review:" + field, title, value, origin: originOfMark(markOf(field, setting, locked)), source: "design-review" });
 return [
  row("mode", "Design review: when it runs", line("mode").text),
  row("tier", "Design review: how thorough", TIER_LABELS[setting.tier]),
  row("allowSkip", "Design review: skipping", line("allowSkip").text),
  row("capUsdPerTask", "Design review: cost limit per task", line("capUsdPerTask").text),
  row("highRiskApprover", "Design review: who approves a high-risk design", approverWords(setting.highRiskApprover, nameOf)),
 ];
}

// ---- the model of each step ----
const reasonOrigin = (reason: string, decidedBy: string, locked: boolean): Origin => {
 if (reason === "COMPANY_LOCK" || (locked && decidedBy === "company")) return "company-lock";
 if (reason === "COMPANY_DEFAULT") return "company-default";
 if (reason === "PROJECT_CHOICE" || reason === "PROJECT_SELECTION" || reason === "PROJECT_DEFAULT") return "project-choice";
 return "rovara-default";
};
/** One row per step the resolver gave a model to. A step it refused or does not use has no row (its own page says why). */
export function modelRows(models: StageModelsResponse): AgreementRow[] {
 const rows: AgreementRow[] = [];
 for (const entry of models.stages) {
  const result = stageResult(entry);
  if (result.kind !== "effective") continue;
  const key = modelKey(result.model), label = entry.candidates.find(candidate => modelKey(candidate.model) === key)?.label;
  rows.push({ id: "model:" + entry.stage, title: "Model for " + STAGE_LABELS[entry.stage].toLowerCase(), value: label ?? "Model name not available", origin: reasonOrigin(result.reason, result.decidedBy, result.locked), source: "models", ...(result.decidedBy === "project" && models.process.version !== undefined ? { version: models.process.version } : {}) });
 }
 return rows;
}

// ---- lessons and learning ----
const LEARNING_WORDS: Readonly<Record<string, string>> = {
 Off: "Off: nothing is captured and no lesson is used",
 Collect: "Collect only: Rovara keeps a record and makes no lessons",
 Suggest: "Suggest: lessons are made and a person approves each one",
 On: "On: a low-risk lesson from a member's own correction goes live on trial",
};
const PRESET_WORDS: Readonly<Record<string, string>> = {
 standard: "Standard: a low-risk lesson from a member's own correction goes live on trial",
 regulated: "Regulated: every lesson needs a person first",
};
/** The learning mode every project starts with (the contract's `LEARNING_MODE_DEFAULT`, spelled as the lessons read spells it). */
const LEARNING_DEFAULT = "Suggest";
export function lessonsRows(view: LessonsView): AgreementRow[] {
 const rows: AgreementRow[] = [], modeWords = LEARNING_WORDS[view.mode], presetWords = PRESET_WORDS[view.preset];
 if (modeWords !== undefined) rows.push({ id: "lessons:mode", title: "Learning from work", value: modeWords, origin: view.lockedByCompany ? "company-lock" : view.mode === LEARNING_DEFAULT ? "rovara-default" : "project-choice", source: "lessons", manage: "how-we-work" });
 if (presetWords !== undefined) rows.push({ id: "lessons:preset", title: "Who approves lessons", value: presetWords, origin: view.presetLockedByCompany ? "company-lock" : view.preset === "standard" ? "rovara-default" : "project-choice", source: "lessons", manage: "how-we-work", ...(view.presetProposal === undefined ? {} : { pending: true }) });
 return rows;
}
export function learningRows(view: LearningView): AgreementRow[] {
 const settings = view.settings, origin: Origin = settings.locked ? "company-lock" : settings.prComments === "on" ? "project-choice" : "rovara-default";
 return [{ id: "learning:pr-comments", title: "Learn from pull request review comments", value: settings.prComments === "on" ? "On" : "Off", origin, source: "learning", manage: "how-we-work", ...(settings.pendingProposal === undefined ? {} : { pending: true }) }];
}

// ---- known failing tests and company rules ----
export function knownFailingRows(policy: KnownFailingPolicyState): AgreementRow[] {
 return [{ id: "known-failing", title: "Marking a failing test as known", value: policy.alwaysTwoPeople ? "Two people must agree" : "One person with the right can mark it", origin: policy.alwaysTwoPeople ? "company-lock" : "rovara-default", source: "known-failing", manage: "how-we-work", ...(policy.pendingLoosening ? { pending: true } : {}) }];
}
export const companyRulesCount = (summary: Pick<CompanyRulesSummary, "required" | "preferred">): number => summary.required + summary.preferred;
export function companyRulesRows(summary: CompanyRulesSummary): AgreementRow[] {
 const total = companyRulesCount(summary);
 const value = total === 0 ? "No company rules yet" : (total === 1 ? "1 company rule applies" : String(total) + " company rules apply") + " (" + String(summary.required) + " required, " + String(summary.preferred) + " preferred)";
 return [{ id: "company-rules", title: "Company rules", value, origin: summary.required > 0 ? "company-lock" : "company-default", source: "company-rules", manage: "company-rules", ...(summary.version === undefined ? {} : { version: summary.version }), ...(summary.pending ? { pending: true } : {}) }];
}

// ---- what the task itself says ----
/** The parts of the task view the panel reads. Both are optional: an older server or a task without them gives no row. */
export interface TaskFacts { designReview?: { decidedBy: string } | undefined; agent?: { version: number | string; builtin: boolean } | undefined }
export function taskRows(task: TaskFacts): AgreementRow[] {
 const rows: AgreementRow[] = [];
 if (task.agent !== undefined) rows.push({ id: "task:process", title: "Process this task runs", value: task.agent.builtin ? "Rovara Code's built-in process" : "The project's own process", origin: task.agent.builtin ? "rovara-default" : "project-choice", source: "task", ...(typeof task.agent.version === "number" ? { version: task.agent.version } : {}) });
 const decided = task.designReview?.decidedBy;
 if (decided === "person") rows.push({ id: "task:design-review", title: "Design review for this task", value: "A person asked for design first", origin: "task-choice", source: "task" });
 else if (decided === "person_skip") rows.push({ id: "task:design-review", title: "Design review for this task", value: "A person skipped it", origin: "task-choice", source: "task" });
 else if (decided === "auto" || decided === "always") rows.push({ id: "task:design-review", title: "Design review for this task", value: decided === "auto" ? "Rovara judged it was needed, as the project setting says" : "Ran because the project setting is Always", origin: decided === DESIGN_REVIEW_DEFAULT_SETTING.mode ? "rovara-default" : "project-choice", source: "task" });
 return rows;
}
