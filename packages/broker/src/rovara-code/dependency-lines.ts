// Test services TS5 (design test-services.md, 2.4 and 9.3): the pull request's lines that say what each dependency of the tests was backed by, in the fixed words of the honesty labels. Pure: nothing is wired.
// Replaces: nothing. Without `environment.dependencies` (every pack built before test services, and every run while they are off) these functions return nothing, so a pull request reads as it did.
//
// What stays at every shrink level: one entry for every dependency in the "ran against" line, with its label, and every "not checked against the real thing" line and every "not run" line (a reader must not
// miss what was not proved). The levels only shorten words: names are cut, and a revision, a date or a longer sentence gives way to a short one. Nothing is counted instead of listed (a pack holds at most 24
// dependencies, so the lines are bounded without it).
//
// Every word a repository or a person wrote (a dependency's name) goes through `inertLine`; the digest and the date are checked against their shape and otherwise shown as unknown; every other word is fixed
// here or in the contract. The label is the pack's (the broker computed it from the pinned plan), never the worker's.
import { EVIDENCE_FALLBACK_REASON_WORDS, evidenceDependencyLabelWords, type EvidenceDependency, type EvidencePack } from "@agentx/contracts";
import { inertLine } from "./inert-text.js";

/** The last shrink level (the Proof section's own last level is the same number). A level outside 0..last is read as the nearest one. */
export const DEPENDENCY_LEVEL_LAST = 4;

const number = (count: number) => count.toLocaleString("en-US");
const NAME_MAX = [40, 40, 40, 24, 16] as const;

/** `A`, `A and B`, `A, B and C`. */
function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

/** The 12 first characters of a digest, or "unrecorded" when it is not a digest (the pack's schema says it is one; this guards a caller that skipped the schema). */
const shortDigest = (digest: string | undefined) => (digest !== undefined && /^[a-f0-9]{64}$/u.test(digest) ? digest.slice(0, 12) : "unrecorded");
const recordedDate = (iso: string | undefined) => (iso !== undefined && /^\d{4}-\d{2}-\d{2}T/u.test(iso) ? iso.slice(0, 10) : "an unknown date");
const fallbackWords = (dependency: EvidenceDependency) => (dependency.fellBack === undefined ? undefined : `fallback: ${EVIDENCE_FALLBACK_REASON_WORDS[dependency.fellBack.reason]}`);

/** A label in a run of words: its parentheses become commas, so the entry has one pair of its own ("real (your image)" is "real, your image"). */
const inline = (words: string) => words.replace(" (", ", ").replace(/\)$/u, "");

function clampLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(DEPENDENCY_LEVEL_LAST, Math.max(0, Math.trunc(level))) : 0;
}

/** What follows a dependency's name in the "ran against" line: its label, then the facts that make it exact. */
function descriptor(dependency: EvidenceDependency, name: string, level: number): string {
  const made = dependency.madeUpAnswers ?? 0;
  const parts = [inline(evidenceDependencyLabelWords(dependency.label, name))];
  if (level < 3 && dependency.fixtureRevision !== undefined) parts.push(`rev ${number(dependency.fixtureRevision)}`);
  if (made > 0) parts.push(`+${number(made)} made-up answers`);
  const fallback = fallbackWords(dependency);
  if (fallback !== undefined) parts.push(fallback);
  return parts.join(", ");
}

/** The "not checked against the real thing" lines of one dependency (design 2.4, third column). Test accounts, real software, the customer's image and tests that fake it themselves add none. */
function notCheckedLines(dependency: EvidenceDependency, name: string, level: number): string[] {
  const compact = level >= 3;
  const lines: string[] = [];
  switch (dependency.label) {
    case "company_approved":
      lines.push(compact ? `${name}: company's own image (digest ${shortDigest(dependency.imageDigest)})` : `${name}: ran the company's own build of the image (digest ${shortDigest(dependency.imageDigest)}), not Rovara's catalog image`);
      break;
    case "rovara_local_aws":
      lines.push(compact ? `${name}: emulated, not real AWS` : `${name} behaviour against real AWS (emulated)`);
      break;
    case "recorded_fake":
      lines.push(compact ? `${name}: recorded ${recordedDate(dependency.recordedAt)}` : `${name}: answers were recorded on ${recordedDate(dependency.recordedAt)}; real behaviour may have changed`);
      break;
    case "hand_written_fake":
      lines.push(compact ? `${name}: written by hand` : `${name}: answers were written by hand, not recorded`);
      break;
    case "not_available": {
      const fallback = fallbackWords(dependency);
      const suffix = fallback === undefined ? "" : ` (${fallback})`;
      const tests = dependency.testsNotRun;
      if (tests === undefined) lines.push(`${name}: not available${suffix}`);
      else if (compact) lines.push(`${number(tests)} ${tests === 1 ? "test" : "tests"} not run: need ${name}${suffix}`);
      else lines.push(`${number(tests)} ${tests === 1 ? "test not run: it needs" : "tests not run: they need"} ${name}${suffix}`);
      break;
    }
    case "real":
    case "real_project_image":
    case "test_account":
    case "faked_by_tests":
      break;
  }
  const made = dependency.madeUpAnswers ?? 0;
  if (made > 0 && (dependency.label === "recorded_fake" || dependency.label === "hand_written_fake")) {
    lines.push(compact ? `${name}: ${number(made)} made-up answers` : `${name}: ${number(made)} ${made === 1 ? "request" : "requests"} had no recording and got a made-up answer`);
  }
  return lines;
}

/**
 * The lines of the dependencies for a Proof section, at a shrink level (0..4): `lines` (without the list marker) are the "ran against" line and the note about test accounts used; `notTested` (with the "- " marker,
 * as `evidenceNotTestedLines` writes them) are the things not checked against the real thing and the tests not run. Nothing for a run with no dependencies.
 */
export function dependencyLines(dependencies: readonly EvidenceDependency[] | undefined, level: number): { lines: string[]; notTested: string[] } {
  if (dependencies === undefined || dependencies.length === 0) return { lines: [], notTested: [] };
  const at = clampLevel(level);
  const nameMax = NAME_MAX[at]!;
  const named = dependencies.map((dependency) => ({ dependency, name: inertLine(dependency.name, nameMax) || "a dependency" }));

  // The ones that ran, grouped by what they ran as, in the order of their first appearance.
  const groups = new Map<string, string[]>();
  for (const { dependency, name } of named) {
    if (dependency.label === "not_available") continue;
    const key = descriptor(dependency, name, at);
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  const lines: string[] = [];
  if (groups.size > 0) {
    lines.push(`${at >= 3 ? "Ran against:" : "Integration tests ran against:"} ${[...groups].map(([key, names]) => `${joinNames(names)} (${key})`).join(", ")}.`);
  }
  const accounts = named.filter(({ dependency }) => dependency.label === "test_account").map(({ name }) => name);
  if (accounts.length > 0) lines.push(`Note: used your ${joinNames(accounts)} test account${accounts.length === 1 ? "" : "s"}.`);

  const notTested = named.flatMap(({ dependency, name }) => notCheckedLines(dependency, name, at).map((text) => `- ${text}`));
  return { lines, notTested };
}

/** The same, from a pack. */
export function packDependencyLines(pack: Pick<EvidencePack, "environment"> | undefined, level: number): { lines: string[]; notTested: string[] } {
  return dependencyLines(pack?.environment.dependencies, level);
}
