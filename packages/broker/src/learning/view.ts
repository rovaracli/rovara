// v1.2 learning loop: `GET /v1/app/projects/{p}/learning` (design 6.2). Everything the project's learning screen shows, in one read-only answer.
//
// Who reads: anyone who can see the project (`projectFor`: another company's project and one the caller cannot see answer the same `PROJECT_NOT_FOUND`). What they get depends on who they
// are, read live (standing.ts), never from the sign-in:
//   - `canDecide` is true only for a project member with the maintainer role (an org owner or admin counts). It is what the screen uses to show Accept, Dismiss and Remove; the deciding
//     routes check it again.
//   - Correction text (each source's `label` and the suggestion's `proposedText`) goes only to a project MEMBER (the same test capture uses). A viewer, or a person who reaches the project
//     only through its Slack channel, sees that suggestions exist, their stage and how many sources, but no one's words.
//
// What is never in the answer: any person's id or name (a source says what kind it is, its task and its time), the text of a suggestion that has ended (the list holds only suggestions that
// are not terminal; the dismissed list is built from stage, kind and time alone), a dismiss note (never stored), the text of an erased author's correction, or anything expired or written for
// an earlier project of the same name (the store's reads treat those as absent).
//
// Bounded: each list is read with a cap (one or two small queries), the answer is cut at its own limits and says which list was cut (`truncated`), and the whole read gives up after
// `LEARNING_VIEW_MILLIS` with one plain error. Nothing is written: rules still waiting on an approval are settled by the deciding routes and Home, not by a read.
import {
  LEARNING_OPEN_SUGGESTIONS_MAX, LearningDismissKindSchema, LearningRuleSchema, LearningSettingsSchema, LearningStageSchema, LearningSuggestionSchema, agentXError, isTerminalSuggestionStatus, projectAllows,
  type LearningCorrection, type LearningSuggestion, type LearningViewAnswer,
} from "@agentx/contracts";
import { readGuardrails } from "../agents/guardrails.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { readMembers } from "./settle.js";
import { learningScopeChecked, readStanding, type StandingDeps } from "./standing.js";
import { getLearningItem, readLearningPartition, type LearningDeps, type LearningScope } from "./store.js";

/** The whole read gives up after this long. */
export const LEARNING_VIEW_MILLIS = 4_000;
/** Items looked at per list. A partition with more than this in one list is cut and says so. */
export const LEARNING_VIEW_SUGGESTIONS_SCANNED_MAX = 1_000;
export const LEARNING_VIEW_DISMISSED_SCANNED_MAX = 500;
export const LEARNING_VIEW_DISMISSED_SHOWN_MAX = 200;
export const LEARNING_VIEW_RULES_MAX = 500;
const PAGE_SIZE = 500;

export interface LearningViewDeps extends StandingDeps {
  now: () => number;
  /** The caller's role in the project: its name, or the one `PROJECT_NOT_FOUND` for no access, no such project and another company's. */
  projectFor(caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: Parameters<typeof projectAllows>[0] }>;
}

type Item = Record<string, unknown>;
const NO_TEXT_LABEL = "A correction from a project member";
const REMOVED_TEXT_LABEL = "(the words of this correction were removed)";
const SET_KEY = /^[a-f0-9]{32}$/;

const byNewest = <T extends { at: string; id: string }>(a: T, b: T): number => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? 1 : -1);

/** One list of the partition, in at most two queries; `more` says the list has items past the cap. */
async function readList(learning: LearningDeps, scope: LearningScope, prefix: string, maxItems: number): Promise<{ items: Item[]; more: boolean }> {
  const page = await readLearningPartition(learning, scope, { prefix, maxItems, maxPages: Math.ceil(maxItems / PAGE_SIZE), pageSize: PAGE_SIZE });
  return { items: page.items, more: page.cursor !== undefined };
}

function sourceViews(suggestion: LearningSuggestion, members: Map<string, LearningCorrection>, showText: boolean) {
  const found = suggestion.correctionIds.flatMap((id) => { const member = members.get(id); return member === undefined ? [] : [member]; });
  return found.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1)).map((member) => ({
    kind: member.source, taskId: member.taskId, at: member.createdAt, standing: member.standing, href: `/review/${encodeURIComponent(member.taskId)}/task`,
    label: showText ? (member.text === undefined || member.text === "" ? REMOVED_TEXT_LABEL : member.text) : NO_TEXT_LABEL,
  }));
}

async function settingsView(deps: LearningViewDeps, learning: LearningDeps, scope: LearningScope): Promise<LearningViewAnswer["settings"]> {
  const [stored, guardrails] = await Promise.all([getLearningItem(learning, scope, "SETTINGS"), readGuardrails(deps, scope.orgId)]);
  const parsed = LearningSettingsSchema.safeParse(stored);
  const locked = guardrails.prCommentLearning === "locked_off";
  const own = parsed.success && parsed.data.prComments === "on" ? "on" as const : "off" as const;
  return {
    prComments: locked ? "off" : own, locked,
    ...(locked ? { lockedBy: "company" as const } : {}),
    ...(parsed.success && parsed.data.pendingProposalId !== undefined ? { pendingProposal: { id: parsed.data.pendingProposalId } } : {}),
    ...(parsed.success ? { revision: parsed.data.revision } : {}),
  };
}

async function build(deps: LearningViewDeps, caller: DeveloperCaller, rawProject: string): Promise<LearningViewAnswer> {
  const found = await deps.projectFor(caller, rawProject);
  const project = found.name;
  const checked = await learningScopeChecked(deps, caller.orgId, project);
  if (checked === undefined) throw agentXError("NOT_FOUND", "Rovara isn't learning from this project right now.");
  const { scope } = checked;
  const learning: LearningDeps = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
  // Read now, not from the sign-in: a person demoted since they signed in is not a member.
  const standing = await readStanding(deps, caller.orgId, caller.developerId, project);
  const member = standing === "member";
  const canDecide = member && projectAllows(found.role, "edit_settings");

  const [settings, suggestionItems, dismissedItems, ruleItems] = await Promise.all([
    settingsView(deps, learning, scope),
    readList(learning, scope, "SUGGESTION#", LEARNING_VIEW_SUGGESTIONS_SCANNED_MAX),
    readList(learning, scope, "DISMISSED#", LEARNING_VIEW_DISMISSED_SCANNED_MAX),
    readList(learning, scope, "RULE#", LEARNING_VIEW_RULES_MAX),
  ]);
  const truncated: Array<"suggestions" | "dismissed" | "rules"> = [];

  // Suggestions that are not terminal. A terminal one is never listed (its text is gone), and one that does not read as a suggestion is left out.
  const open = suggestionItems.items.flatMap((item) => {
    const parsed = LearningSuggestionSchema.safeParse(item);
    return parsed.success && !isTerminalSuggestionStatus(parsed.data.status) ? [parsed.data] : [];
  }).sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1));
  const shown = open.slice(0, LEARNING_OPEN_SUGGESTIONS_MAX);
  if (open.length > shown.length || suggestionItems.more) truncated.push("suggestions");
  const wanted = shown.flatMap((suggestion) => suggestion.correctionIds);
  const members = new Map((wanted.length === 0 ? [] : await readMembers(learning, scope, wanted)).map((entry) => [entry.c.id, entry.c] as const));
  const suggestions = shown.map((suggestion) => ({
    id: suggestion.id, stage: suggestion.stage, status: suggestion.status,
    ...(member && suggestion.proposedText !== undefined ? { proposedText: suggestion.proposedText } : {}),
    allFromOnePerson: suggestion.allFromOnePerson, lessSafe: suggestion.lessSafe, lessSafeWords: suggestion.kinds, overlaps: suggestion.overlaps,
    sources: sourceViews(suggestion, members, member), revision: suggestion.revision,
  }));

  // The dismissed patterns: the id of the pattern (what Reopen takes), the stage and kind of the suggestion it came from, and when. No text from either.
  const ended = new Map<string, Item>();
  for (const item of suggestionItems.items) if (item["status"] === "dismissed" && typeof item["id"] === "string") ended.set(item["id"], item);
  const dismissedAll = dismissedItems.items.flatMap((item) => {
    const sk = typeof item["sk"] === "string" ? item["sk"] : "";
    const id = sk.slice("DISMISSED#".length);
    const origin = typeof item["suggestionId"] === "string" ? ended.get(item["suggestionId"]) : undefined;
    const stage = LearningStageSchema.safeParse(origin?.["stage"]);
    const at = item["dismissedAt"];
    if (!SET_KEY.test(id) || !stage.success || typeof at !== "string" || !Number.isFinite(Date.parse(at))) return [];
    const kind = LearningDismissKindSchema.safeParse(origin?.["dismissKind"]);
    return [{ id, stage: stage.data, at, ...(kind.success ? { dismissKind: kind.data } : {}) }];
  }).sort(byNewest);
  if (dismissedAll.length > LEARNING_VIEW_DISMISSED_SHOWN_MAX || dismissedItems.more) truncated.push("dismissed");
  const dismissed = dismissedAll.slice(0, LEARNING_VIEW_DISMISSED_SHOWN_MAX).map(({ id, stage, at, dismissKind }) => ({ id, stage, dismissedAt: at, ...(dismissKind === undefined ? {} : { dismissKind }) }));

  // The rules: those that are in How we work or on their way there. A removed rule and one that was never applied are not listed.
  const rulesAll = ruleItems.items.flatMap((item) => {
    const parsed = LearningRuleSchema.safeParse(item);
    return parsed.success && (parsed.data.status === "active" || parsed.data.status === "pending" || parsed.data.status === "awaiting_approval") ? [parsed.data] : [];
  }).sort((a, b) => byNewest({ at: a.createdAt ?? "", id: a.id }, { at: b.createdAt ?? "", id: b.id }));
  if (ruleItems.more) truncated.push("rules");
  const rules = rulesAll.slice(0, LEARNING_VIEW_RULES_MAX).map((rule) => ({
    id: rule.id, stage: rule.stage, text: rule.text, status: rule.status, ...(rule.processVersion === undefined ? {} : { processVersion: rule.processVersion }),
  }));

  // PR-comment capture counts what it skipped (B8); until it exists there is nothing to report.
  return { settings, suggestions, dismissed, rules, skippedUnlinked: 0, canDecide, ...(truncated.length === 0 ? {} : { truncated }) };
}

/** `GET /v1/app/projects/{p}/learning`. Gives up with one plain error after `options.millis` (default `LEARNING_VIEW_MILLIS`). */
export async function viewLearning(deps: LearningViewDeps, caller: DeveloperCaller, rawProject: string, options: { millis?: number } = {}): Promise<LearningViewAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(agentXError("RUNTIME_UNAVAILABLE", "Learning took too long to load. Try again.")), options.millis ?? LEARNING_VIEW_MILLIS);
  });
  try {
    return await Promise.race([build(deps, caller, rawProject), limit]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
