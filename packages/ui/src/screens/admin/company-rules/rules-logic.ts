// Company rules (lane exp/company-rules): the pure parts of the page, kept apart from the screen so they can be tested to the exact boundary. Counting follows the server (it folds white space and removes hidden characters,
// then counts code points); the server still decides, this only says early what it will refuse. The wording of the block is `STANDING_INSTRUCTIONS_WORDING` from the web entry.
import { COMPANY_RULES_APP_LIMITS, STANDING_INSTRUCTIONS_WORDING, type CompanyRuleView, type CompanyRulesDiff } from "@agentx/contracts/web";

export type Priority = CompanyRuleView["priority"];
export interface DraftRule { id: string; text: string; priority: Priority }
export interface Limits { maxRules: number; maxRuleCharacters: number; maxTotalCharacters: number }
export const DEFAULT_LIMITS: Limits = COMPANY_RULES_APP_LIMITS;
export const SIZE_BUDGET = "Company rules exceed the size budget";

/** The same classes of hidden characters the server removes before it counts and stores a rule (controls other than newline and tab, format characters, private use, unassigned, default-ignorable, variation selectors). */
const HIDDEN = /[\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
/** One line of inert text: hidden characters out, every run of white space one space, the ends trimmed. */
export function foldRuleText(text: string): string {
 return text.replace(/\r\n?/gu, "\n").replace(HIDDEN, character => (character === "\n" || character === "\t" ? character : "")).trim().replace(/\s+/gu, " ").trim();
}
export const characterCount = (text: string): number => Array.from(foldRuleText(text)).length;

export interface RulesCheck {
 /** The refusals, in the server's words, in the order the server checks them. Empty when the list can be sent. */
 problems: string[];
 /** Per rule: the folded length, and a short problem when this rule alone is over the limit or empty. */
 rules: Array<{ length: number; problem?: string }>;
 total: number;
 count: number;
}
export function checkRules(rules: ReadonlyArray<Pick<DraftRule, "text">>, limits: Limits = DEFAULT_LIMITS): RulesCheck {
 const problems: string[] = [], lengths = rules.map(rule => characterCount(rule.text)), total = lengths.reduce((sum, length) => sum + length, 0);
 const per: RulesCheck["rules"] = lengths.map(length => ({ length }));
 if (rules.length > limits.maxRules) problems.push(`${SIZE_BUDGET}: ${String(rules.length)} rules, at most ${String(limits.maxRules)}. Delete some rules.`);
 lengths.forEach((length, index) => {
  if (length === 0) { per[index]!.problem = "This rule is empty.";problems.push(`Rule ${String(index + 1)} is empty. Write it or delete it.`); }
  else if (length > limits.maxRuleCharacters) { per[index]!.problem = `This rule has ${String(length)} characters, at most ${String(limits.maxRuleCharacters)}.`;problems.push(`${SIZE_BUDGET}: rule ${String(index + 1)} has ${String(length)} characters, at most ${String(limits.maxRuleCharacters)}. Shorten it.`); }
 });
 if (total > limits.maxTotalCharacters) problems.push(`${SIZE_BUDGET}: ${String(total)} characters in all, at most ${String(limits.maxTotalCharacters)}. Shorten the rules.`);
 return { problems, rules: per, total, count: rules.length };
}

/** Whether two lists say the same thing once folded (what the server calls "nothing changed"). */
export function sameRules(a: ReadonlyArray<Pick<CompanyRuleView, "text" | "priority">>, b: ReadonlyArray<Pick<CompanyRuleView, "text" | "priority">>): boolean {
 return a.length === b.length && a.every((rule, index) => rule.priority === b[index]!.priority && foldRuleText(rule.text) === foldRuleText(b[index]!.text));
}

/** Rules in order, Required first and then Preferred as the agents are shown them, each with its number across both lists (1 to N). */
export function numbered<T extends { priority: Priority }>(rules: readonly T[]): { required: Array<{ number: number; rule: T }>; preferred: Array<{ number: number; rule: T }> } {
 const required = rules.filter(rule => rule.priority === "required"), preferred = rules.filter(rule => rule.priority === "preferred");
 return { required: required.map((rule, index) => ({ number: index + 1, rule })), preferred: preferred.map((rule, index) => ({ number: required.length + index + 1, rule })) };
}

// ---- editing a draft: Required rules come first, then Preferred, as the agents read them -------------------------------------------------------------------------------------------------------------------
export function draftFrom(rules: readonly CompanyRuleView[], newId: () => string): DraftRule[] {
 const list = rules.map(rule => ({ id: newId(), text: rule.text, priority: rule.priority }));
 return [...list.filter(rule => rule.priority === "required"), ...list.filter(rule => rule.priority === "preferred")];
}
const normalized = (rules: DraftRule[]): DraftRule[] => [...rules.filter(rule => rule.priority === "required"), ...rules.filter(rule => rule.priority === "preferred")];
export const addRule = (rules: DraftRule[], priority: Priority, id: string): DraftRule[] => normalized([...rules, { id, text: "", priority }]);
export const editRule = (rules: DraftRule[], id: string, text: string): DraftRule[] => rules.map(rule => (rule.id === id ? { ...rule, text } : rule));
export const deleteRule = (rules: DraftRule[], id: string): DraftRule[] => rules.filter(rule => rule.id !== id);
/** Moves a rule one place up (-1) or down (1) among the rules of its own priority. A rule at the end of its list stays. */
export function moveRule(rules: DraftRule[], id: string, step: -1 | 1): DraftRule[] {
 const at = rules.findIndex(rule => rule.id === id);
 if (at < 0) return rules;
 const priority = rules[at]!.priority;
 let to = at + step;
 while (to >= 0 && to < rules.length && rules[to]!.priority !== priority) to += step;
 if (to < 0 || to >= rules.length || rules[to]!.priority !== priority) return rules;
 const next = [...rules];
 [next[at], next[to]] = [next[to]!, next[at]!];
 return next;
}
/** Switches a rule between Required and Preferred; it goes to the end of the other list. */
export function setPriority(rules: DraftRule[], id: string, priority: Priority): DraftRule[] {
 const rule = rules.find(entry => entry.id === id);
 if (rule === undefined || rule.priority === priority) return rules;
 return normalized([...rules.filter(entry => entry.id !== id), { ...rule, priority }]);
}
/** Whether a rule can move up or down within its own priority. */
export function canMove(rules: readonly DraftRule[], id: string, step: -1 | 1): boolean {
 const next = moveRule([...rules], id, step);
 return next.findIndex(rule => rule.id === id) !== rules.findIndex(rule => rule.id === id);
}

// ---- the difference between two lists ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type Entry = CompanyRulesDiff["entries"][number];
const key = (rule: CompanyRuleView) => rule.priority + "\u0000" + foldRuleText(rule.text);
/**
 * A line-by-line comparison in the order of the NEW list, removed rules at their old place (the same shape the server sends for a proposal). Rules that stay are matched first (longest common run); between two matches,
 * a removed rule and an added rule side by side are one "changed" rule. This is the page's own preview of "what you are changing"; once a proposal waits, the page shows the server's comparison.
 */
export function diffRules(before: readonly CompanyRuleView[], after: readonly CompanyRuleView[]): CompanyRulesDiff {
 const n = before.length, m = after.length, table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
 for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = key(before[i]!) === key(after[j]!) ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
 const entries: Entry[] = [];
 let i = 0, j = 0, removed: CompanyRuleView[] = [], added: CompanyRuleView[] = [];
 const flush = () => {
  // Inside one gap: a removed and an added rule with the same words are one rule whose priority changed; the others pair up side by side (changed), and what is left over is removed or added.
  const partner = new Map<number, number>(), taken = new Set<number>();
  removed.forEach((rule, r) => { const a = added.findIndex((candidate, index) => !taken.has(index) && foldRuleText(candidate.text) === foldRuleText(rule.text)); if (a >= 0) { partner.set(r, a);taken.add(a); } });
  const restRemoved = removed.map((_, r) => r).filter(r => !partner.has(r)), restAdded = added.map((_, a) => a).filter(a => !taken.has(a));
  const pairs = Math.min(restRemoved.length, restAdded.length);
  restRemoved.slice(0, pairs).forEach((r, k) => { partner.set(r, restAdded[k]!);taken.add(restAdded[k]!); });
  const by = new Map([...partner].map(([r, a]) => [a, r]));
  for (const r of removed.map((_, index) => index).filter(r => !partner.has(r))) entries.push({ kind: "removed", before: removed[r]! });
  added.forEach((rule, a) => { const r = by.get(a); entries.push(r === undefined ? { kind: "added", after: rule } : { kind: "changed", before: removed[r]!, after: rule }); });
  removed = [];added = [];
 };
 while (i < n || j < m) {
  if (i < n && j < m && key(before[i]!) === key(after[j]!)) { flush();entries.push({ kind: "same", after: after[j]! });i++;j++; }
  else if (j < m && (i >= n || table[i]![j + 1]! >= table[i + 1]![j]!)) { added.push(after[j]!);j++; }
  else { removed.push(before[i]!);i++; }
 }
 flush();
 const count = (kind: Entry["kind"]) => entries.filter(entry => entry.kind === kind).length;
 return { summary: { added: count("added"), removed: count("removed"), changed: count("changed"), unchanged: count("same") }, entries };
}

// ---- what the readers give: a newer server may add a priority or a kind this page does not know; show those as the plain lists they are, never as raw words -----------------------------------------------
export interface LooseRule { text: string; priority: string }
const isLooseRule = (value: unknown): value is LooseRule => typeof value === "object" && value !== null && "text" in value && typeof value.text === "string" && "priority" in value && typeof value.priority === "string";
/** A rule as the page knows it; a priority this page doesn't know is shown as Preferred (the lower of the two). */
export const toRule = (rule: LooseRule): CompanyRuleView => ({ text: rule.text, priority: rule.priority === "required" ? "required" : "preferred" });
export const toRules = (rules: readonly LooseRule[]): CompanyRuleView[] => rules.map(toRule);
const SIDES = ["rovara", "repo", "both"] as const;
const sideOf = (value: unknown): { side: (typeof SIDES)[number] } | Record<string, never> => (typeof value === "string" && (SIDES as readonly string[]).includes(value) ? { side: value as (typeof SIDES)[number] } : {});
export interface LooseDiff { summary: CompanyRulesDiff["summary"]; entries: ReadonlyArray<{ kind: string }> }
/** A comparison from the server with every entry it holds that this page knows; entries of an unknown kind are dropped. */
export function toDiff(diff: LooseDiff): CompanyRulesDiff {
 const entries: Entry[] = [];
 for (const entry of diff.entries) {
  const { before, after, side } = entry as { before?: unknown; after?: unknown; side?: unknown };
  if (entry.kind === "same" && isLooseRule(after)) entries.push({ kind: "same", after: toRule(after) });
  else if (entry.kind === "added" && isLooseRule(after)) entries.push({ kind: "added", after: toRule(after), ...sideOf(side) });
  else if (entry.kind === "removed" && isLooseRule(before)) entries.push({ kind: "removed", before: toRule(before), ...sideOf(side) });
  else if (entry.kind === "changed" && isLooseRule(before) && isLooseRule(after)) entries.push({ kind: "changed", before: toRule(before), after: toRule(after), ...sideOf(side) });
 }
 return { summary: diff.summary, entries };
}

export type ChangeKind = "added" | "removed" | "changed" | "priority" | "same";
/** The word for one entry of a comparison: a changed rule whose words are the same and whose priority differs is a "priority" change. */
export function changeKind(entry: Entry): ChangeKind {
 if (entry.kind !== "changed") return entry.kind;
 return foldRuleText(entry.before.text) === foldRuleText(entry.after.text) && entry.before.priority !== entry.after.priority ? "priority" : "changed";
}
export const PRIORITY_WORDS: Record<Priority, string> = { required: "Required", preferred: "Preferred" };
export function summaryWords(summary: CompanyRulesDiff["summary"], priorityChanged = 0): string {
 const parts = [`${String(summary.added)} added`, `${String(summary.removed)} removed`, `${String(summary.changed - priorityChanged)} changed`];
 if (priorityChanged > 0) parts.push(`${String(priorityChanged)} priority changed`);
 parts.push(`${String(summary.unchanged)} unchanged`);
 return parts.join(", ");
}
export const priorityChangedCount = (diff: CompanyRulesDiff): number => diff.entries.filter(entry => changeKind(entry) === "priority").length;

// ---- the block as agents see it --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const BLOCK_WORDING = STANDING_INSTRUCTIONS_WORDING;
/** The code in the closing line is a short hash of the finished block, made when a step is sent; the preview cannot know it. */
export const CLOSING_CODE_NOTE = "[a short code, made when each step is sent]";
const oneLine = (text: string): string => foldRuleText(text).replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
/** The company part of the block as the broker builds it (`buildStandingInstructions`): the header, the company section with Required then Preferred bullets, and the closing line. `undefined` when there are no rules: then agents get no block from the company. */
export function previewBlock(rules: ReadonlyArray<Pick<DraftRule, "text" | "priority">>): string | undefined {
 const usable = rules.filter(rule => foldRuleText(rule.text) !== "");
 if (usable.length === 0) return undefined;
 const group = (priority: Priority, title: string): string[] => { const list = usable.filter(rule => rule.priority === priority);return list.length === 0 ? [] : [title, ...list.map(rule => `- ${oneLine(rule.text)}`)]; };
 const section = [BLOCK_WORDING.company, ...group("required", BLOCK_WORDING.required), ...group("preferred", BLOCK_WORDING.preferred)].join("\n");
 return `${BLOCK_WORDING.header}\n\n1. ${section}\n\n${BLOCK_WORDING.closingStart} ${CLOSING_CODE_NOTE}. ${BLOCK_WORDING.closingEnd}`;
}
