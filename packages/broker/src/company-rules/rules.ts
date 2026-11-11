// Company rules (G-04, decisions 57 and 85): the pure part. A rule list is checked and put in ONE canonical form (text inert and folded to one line, Required rules first and then Preferred, each group in the order given), so the same
// rules always have the same digest, a file written from a version reads back as exactly that version, and the prompt's own grouping (`standing-block.ts`) changes nothing. This file also holds the diff of two lists, the Markdown
// file's writer and reader (the format Rovara Code reads: `## Required` and `## Preferred` headings with `- ` bullets), and nothing that touches a store, a host or the clock.
import { createHash } from "node:crypto";
import { type CompanyRulesDiff } from "@agentx/cloud-contracts";
import { agentXError, assertCompanyRulesWithinBudget, canonicalJson, redactText, type CompanyRule } from "@rovara-code/contracts";
import { foldedRuleText } from "../instructions/standing-block.js";

/** A larger file is refused unread: the rules are at most 12,000 characters, so this leaves room for headings and layout (the size Rovara Code reads). */
export const COMPANY_RULES_FILE_MAX_BYTES = 64 * 1_024;

export type Rule = CompanyRule;

/**
 * The rules, checked and in canonical form. Throws `CONFIG_INVALID` with a sentence that is safe to show: a rule that is empty once hidden characters are gone, a rule that looks like it holds a secret (the same redaction the prompt
 * applies; the person is told to take it out, never given a redacted copy), and every size limit (30 rules, 600 characters each, 12,000 in all, counted on the folded text). Nothing is cut.
 */
export function normalizeRules(input: readonly { text: string; priority: "required" | "preferred" }[]): Rule[] {
  const folded: Rule[] = input.map((rule) => ({ text: foldedRuleText(rule.text), priority: rule.priority }));
  folded.forEach((rule, index) => {
    if (rule.text === "") throw agentXError("CONFIG_INVALID", `Rule ${String(index + 1)} is empty. Write the rule or remove it.`);
    if (redactText(rule.text) !== rule.text) throw agentXError("CONFIG_INVALID", `Rule ${String(index + 1)} looks like it holds a secret, a password or a key. Company rules go into every task's prompt, so take it out.`);
  });
  assertCompanyRulesWithinBudget(folded);
  return [...folded.filter((rule) => rule.priority === "required"), ...folded.filter((rule) => rule.priority === "preferred")];
}

/** The digest of a list in canonical form: what a proposal's approver pins and what a version records. */
export function rulesDigest(rules: readonly Rule[]): string {
  return createHash("sha256").update(canonicalJson(rules.map((rule) => [rule.priority, rule.text]))).digest("hex");
}

/** The same two lists, rule for rule. */
export const sameRules = (left: readonly Rule[], right: readonly Rule[]): boolean => rulesDigest(left) === rulesDigest(right);

// ---- the diff

const keyOf = (rule: Rule): string => `${rule.priority}\u0000${rule.text}`;

/**
 * A line-by-line comparison: rules both lists hold (in the same order) are `same`; between two of those, an old rule and a new one with the same words are `changed` (its priority moved), the rest of the old and new rules left out are paired by position as `changed`, and what is left is `removed` or
 * `added`. Entries follow the NEW list, a removed rule at the place it had. Each list is at most 30 rules, so the table is small.
 */
export function diffRules(before: readonly Rule[], after: readonly Rule[]): CompanyRulesDiff {
  const rows = before.length + 1, columns = after.length + 1;
  const length: number[][] = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      length[i]![j] = keyOf(before[i]!) === keyOf(after[j]!) ? length[i + 1]![j + 1]! + 1 : Math.max(length[i + 1]![j]!, length[i]![j + 1]!);
    }
  }
  const entries: CompanyRulesDiff["entries"] = [];
  const summary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  let i = 0, j = 0;
  const flush = (removed: Rule[], added: Rule[]): void => {
    // A rule whose words stayed and whose priority moved is the same rule changed; the others are paired by position.
    const partner = new Map<number, number>();
    const taken = new Set<number>();
    added.forEach((rule, index) => {
      const found = removed.findIndex((old, at) => !taken.has(at) && old.text === rule.text);
      if (found >= 0) { partner.set(index, found); taken.add(found); }
    });
    const free = removed.map((_, at) => at).filter((at) => !taken.has(at));
    added.forEach((_, index) => { if (!partner.has(index) && free.length > 0) partner.set(index, free.shift()!); });
    const paired = new Set(partner.values());
    removed.forEach((rule, at) => { if (!paired.has(at)) { entries.push({ kind: "removed", before: rule }); summary.removed += 1; } });
    added.forEach((rule, index) => {
      const old = partner.get(index);
      if (old === undefined) { entries.push({ kind: "added", after: rule }); summary.added += 1; } else { entries.push({ kind: "changed", before: removed[old]!, after: rule }); summary.changed += 1; }
    });
  };
  let removed: Rule[] = [], added: Rule[] = [];
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && keyOf(before[i]!) === keyOf(after[j]!)) {
      flush(removed, added); removed = []; added = [];
      entries.push({ kind: "same", after: after[j]! }); summary.unchanged += 1;
      i += 1; j += 1;
    } else if (j < after.length && (i === before.length || length[i]![j + 1]! >= length[i + 1]![j]!)) {
      added.push(after[j]!); j += 1;
    } else {
      removed.push(before[i]!); i += 1;
    }
  }
  flush(removed, added);
  return { summary, entries };
}

type Side = "rovara" | "repo" | "both";

/**
 * The diff of Rovara's version in force (before) against the file (after), with each difference marked by the side that made it, against `ancestor`: the rules the two last agreed on. A rule the ancestor held and the file lost
 * was removed in the repository; one the ancestor held and Rovara lost was removed in Rovara; and so on. With no ancestor (the two never agreed) every difference is `both`.
 */
export function diffWithSides(before: readonly Rule[], after: readonly Rule[], ancestor: readonly Rule[] | undefined): { diff: CompanyRulesDiff; changedSide: Side | null } {
  const diff = diffRules(before, after);
  const known = ancestor === undefined ? undefined : new Set(ancestor.map(keyOf));
  const sideOf = (entry: CompanyRulesDiff["entries"][number]): Side | undefined => {
    if (entry.kind === "same") return undefined;
    if (known === undefined) return "both";
    if (entry.kind === "added") return known.has(keyOf(entry.after)) ? "rovara" : "repo";
    if (entry.kind === "removed") return known.has(keyOf(entry.before)) ? "repo" : "rovara";
    const heldBefore = known.has(keyOf(entry.before)), heldAfter = known.has(keyOf(entry.after));
    return heldBefore && !heldAfter ? "repo" : heldAfter && !heldBefore ? "rovara" : "both";
  };
  const entries = diff.entries.map((entry) => { const side = sideOf(entry); return side === undefined ? entry : { ...entry, side } as CompanyRulesDiff["entries"][number]; });
  const sides = new Set(entries.flatMap((entry) => ("side" in entry && entry.side !== undefined ? [entry.side] : [])));
  const changedSide: Side | null = sides.size === 0 ? null : sides.size === 1 && !sides.has("both") ? [...sides][0]! : "both";
  return { diff: { summary: diff.summary, entries }, changedSide };
}

/** What a version (or the file) changed against the one before it: the counts only. */
export const diffSummary = (before: readonly Rule[], after: readonly Rule[]): CompanyRulesDiff["summary"] => diffRules(before, after).summary;

// ---- the file

/**
 * The Markdown file for a version. Only headings, bullets and blank lines, so Rovara Code's reader (and ours) takes it as it is. The second heading is a title the reader ignores: it says where the rules are managed.
 * Rules are one line each (they were folded when they were saved).
 */
export function renderRulesFile(rules: readonly Rule[], version: number): string {
  const group = (priority: Rule["priority"], title: string): string[] => {
    const own = rules.filter((rule) => rule.priority === priority);
    return own.length === 0 ? [] : [`## ${title}`, "", ...own.map((rule) => `- ${rule.text}`), ""];
  };
  return [
    "# Company rules",
    `# Managed in Rovara (Settings, Company rules), version ${String(version)}. A change made in this file becomes a proposal that a company admin approves in Rovara.`,
    "",
    ...group("required", "Required"),
    ...group("preferred", "Preferred"),
  ].join("\n").replace(/\n+$/u, "\n");
}

export type FileProblem = "file_unreadable" | "file_too_large" | "over_limits";

/**
 * The rules a file holds, in canonical form, or the reason it cannot be read. The grammar is Rovara Code's (`company-instructions-file.ts`): bullets under optional `Required` and `Preferred` headings, a bullet before any heading is Required,
 * an indented line continues the bullet above, any other heading is a title, and a line that is none of these refuses the whole file (never dropped). Over the size limits refuses it too. An empty file holds no rules.
 */
export function readRulesFile(text: string): { ok: true; rules: Rule[] } | { ok: false; problem: FileProblem } {
  if (Buffer.byteLength(text, "utf8") > COMPANY_RULES_FILE_MAX_BYTES) return { ok: false, problem: "file_too_large" };
  const collected: Array<{ text: string; priority: Rule["priority"] }> = [];
  let priority: Rule["priority"] = "required";
  let current: { priority: Rule["priority"]; parts: string[] } | undefined;
  const finish = (): void => { if (current !== undefined) collected.push({ text: current.parts.join(" "), priority: current.priority }); current = undefined; };
  for (const line of text.replace(/^\uFEFF/u, "").split(/\r\n|\r|\n|\u2028|\u2029/u)) {
    if (line.trim() === "") { finish(); continue; }
    const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading !== null) {
      finish();
      const name = (heading[1] ?? "").trim().toLowerCase().replace(/[:\s]+$/u, "");
      if (name === "required") priority = "required"; else if (name === "preferred") priority = "preferred";
      continue;
    }
    const bullet = /^ {0,3}[-*+]\s+(.*)$/u.exec(line);
    if (bullet !== null) { finish(); current = { priority, parts: [bullet[1] ?? ""] }; continue; }
    if (current !== undefined && /^\s+\S/u.test(line)) { current.parts.push(line.trim()); continue; }
    return { ok: false, problem: "file_unreadable" };
  }
  finish();
  try { return { ok: true, rules: normalizeRules(collected) }; } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { ok: false, problem: message.includes("size budget") ? "over_limits" : "file_unreadable" };
  }
}

/** What the draft file the owner approved looks like: headings that start with Required or Preferred and numbered rules (`1. text`). The operator's seed script reads it; it is not a format anything else reads. */
export function readNumberedDraft(text: string): Rule[] {
  const collected: Array<{ text: string; priority: Rule["priority"] }> = [];
  let priority: Rule["priority"] | undefined;
  for (const line of text.split(/\r\n|\r|\n/u)) {
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    if (heading !== null) {
      const name = (heading[1] ?? "").trim().toLowerCase();
      if (name.startsWith("required")) priority = "required"; else if (name.startsWith("preferred")) priority = "preferred"; else priority = undefined;
      continue;
    }
    const numbered = /^\s*\d{1,3}\.\s+(.+)$/u.exec(line);
    if (numbered !== null && priority !== undefined) collected.push({ text: numbered[1] ?? "", priority });
  }
  return normalizeRules(collected);
}

