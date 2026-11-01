// Brazil detector (build system of the first pilot). Replaces: "proposes nothing and says so". A Brazil package (a `Config` file) is still detected, but Rovara never invents how it builds or tests. It proposes a
// command ONLY when the team wrote it down: a `brazil-...` command, verbatim, in a code block or inline code of the team's own steering files, AGENTS.md, CLAUDE.md, README, docs or runbooks, cited by file and line.
// The one best command tied to tests becomes the test check (the others are listed as alternatives); with none, the question stays. Brazil report paths are not public, so none is ever built in: a report or
// coverage path comes from the team's own words near the command (cited) or from the language tool's own detector, which keeps running inside a Brazil package (Brazil wraps the language tool, so the proposal can
// show both and the Prove run decides). Everything here is a PROPOSAL; nothing is run.
import type { DetectedCheck, DetectedSource, Detector } from "./types.js";

const MAX_DOCS = 30;
const MAX_LINES = 4_000;
const MAX_ALTERNATIVES = 5;
const TIMEOUT = { test: 1_800, build: 900 } as const;
const COMMAND_WORD = /^[A-Za-z0-9_@%+=:,./-]{1,200}$/u;
/** Anything a shell would treat as more than one plain command, a variable, a placeholder, a quote, a glob or a continuation. */
const NOT_PLAIN = /[|;&<>`$\\"'(){}[\]*?!~]|\.\.\./u;
/** Words that make a team-written command something Rovara will not propose (it downloads, deploys, deletes or opens a shell). */
const BANNED_WORD = /^(?:sh|bash|zsh|csh|ksh|curl|wget|eval|sudo|rm|ssh|scp|nc)$/u;
const BANNED_ARG = /(?:deploy|publish|promote|push|delete|remove|cleanup|rollback|merge|submit)/u;
const NEGATED = /\b(?:never|don'?t|do not|must not|should not|avoid|deprecated|obsolete|instead of)\b/iu;
const TEST_WORDS = /\b(?:test|tests|testing|unit|integ|integration|coverage|pytest|junit)\b/iu;
const BUILD_WORDS = /\b(?:build|compile|package)\b/iu;

interface Candidate {
  line: string;
  executable: string;
  args: string[];
  path: string;
  at: number;
  rank: number;
  test: number;
  build: number;
}

const rankOf = (path: string): number => {
  if (/^\.kiro\/steering\/[^/]+\.md$/iu.test(path)) return 0;
  if (path === "AGENTS.md") return 1;
  if (path === "CLAUDE.md") return 2;
  if (/^README(?:\.[A-Za-z]+)?$/iu.test(path)) return 3;
  if (/^docs\/.+\.md$/iu.test(path)) return 4;
  if (/(?:^|\/)runbooks?\/.+\.(?:md|txt)$/iu.test(path) || /(?:^|\/)[^/]*runbook[^/]*\.(?:md|txt)$/iu.test(path)) return 5;
  return -1;
};

/** One plain `brazil-...` command, or undefined. */
function brazilCommand(span: string): { executable: string; args: string[] } | undefined {
  const text = span.replace(/^(?:\$|>)\s+/u, "").replace(/\s+#.*$/u, "").trim();
  if (text.length === 0 || text.length > 400 || NOT_PLAIN.test(text)) return undefined;
  const words = text.split(/\s+/u);
  const [executable, ...args] = words as [string, ...string[]];
  if (!/^brazil(?:-[a-z0-9]+)+$/u.test(executable) || words.length > 40) return undefined;
  if (!words.every((word) => COMMAND_WORD.test(word) && !BANNED_WORD.test(word)) || args.some((word) => BANNED_ARG.test(word.toLowerCase()))) return undefined;
  return { executable, args };
}

/** A line's own words for scoring: inline code and Brazil command lines are removed, so a command never makes its own context (`brazil-build` is not the word "build"). */
const prose = (line: string): string => (/^(?:[$>]\s*)?brazil-/u.test(line.trim()) ? "" : line.replace(/`[^`\n]*`/gu, " "));

function scan(path: string, text: string): Candidate[] {
  const lines = text.split("\n").slice(0, MAX_LINES);
  const found: Candidate[] = [];
  let fenced = false;
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (/^(?:```|~~~)/u.test(trimmed)) { fenced = !fenced; return; }
    const spans = fenced ? [trimmed] : [...raw.matchAll(/`([^`\n]{1,300})`/gu)].map((match) => match[1]!.trim());
    if (spans.length === 0 || NEGATED.test(raw)) return;
    const context: string[] = [prose(raw)];
    let heading: string | undefined;
    for (let back = index - 1; back >= 0 && back >= index - 30; back -= 1) { if (/^#{1,6}\s/u.test(lines[back]!)) { heading = lines[back]; break; } }
    if (heading !== undefined) context.push(prose(heading));
    for (let back = index - 1, taken = 0; back >= 0 && taken < 3; back -= 1) {
      const previous = lines[back]!.trim();
      if (previous === "" || /^(?:```|~~~)/u.test(previous)) continue;
      context.push(prose(previous)); taken += 1;
    }
    const around = context.join("\n");
    for (const span of spans) {
      const command = brazilCommand(span);
      if (command === undefined) continue;
      const argText = command.args.join(" ");
      const test = (TEST_WORDS.test(argText) ? 3 : 0) + (/\brelease\b/u.test(argText) ? 1 : 0) + (TEST_WORDS.test(around) ? 2 : 0) + (/\brelease\b/iu.test(around) ? 1 : 0);
      const build = (command.args.length === 0 || BUILD_WORDS.test(argText) ? 3 : 0) + (BUILD_WORDS.test(around) ? 2 : 0);
      found.push({ line: [command.executable, ...command.args].join(" "), ...command, path, at: index + 1, rank: rankOf(path), test, build });
    }
  });
  return found;
}

const better = (left: Candidate, right: Candidate, score: "test" | "build"): boolean => left[score] > right[score] || (left[score] === right[score] && (left.rank < right.rank || (left.rank === right.rank && (left.path < right.path || (left.path === right.path && left.at < right.at)))));

/** The team's own words near a command that name a report file: a relative `.xml` path on a line that says what it is. Cited by that line. */
function pathNear(lines: readonly string[], at: number, keyword: RegExp): { path: string; line: number } | undefined {
  for (let index = Math.max(0, at - 9); index <= Math.min(lines.length - 1, at + 7); index += 1) {
    const text = lines[index]!;
    if (!keyword.test(text)) continue;
    for (const match of text.matchAll(/(?<![\w/.-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.xml)(?![\w/])/gu)) {
      const value = match[1]!;
      if (value.split("/").every((part) => part !== "" && part !== "." && part !== "..") && value.length <= 200) return { path: value, line: index + 1 };
    }
  }
  return undefined;
}

export const detectBrazil: Detector = async ({ repo, cwd }) => {
  const config = repo.paths.includes("Config") ? await repo.read("Config") : undefined;
  if (config === undefined || !/\bpackage\.|\bbrazil\b|\bbuild-system\b|\bBuildSystem\b/iu.test(config)) return {};
  const notes = ["A Brazil package file (Config) was found. Brazil wraps the language tool, so the proposal can show both the language tool's own command and a Brazil command; the Prove run decides which one works and a maintainer confirms it."];

  const docs = repo.paths.filter((path) => rankOf(path) >= 0).sort((left, right) => rankOf(left) - rankOf(right) || (left < right ? -1 : left > right ? 1 : 0)).slice(0, MAX_DOCS);
  const texts = new Map<string, string[]>();
  const all: Candidate[] = [];
  for (const path of docs) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    texts.set(path, text.split("\n"));
    all.push(...scan(path, text));
  }
  // The best occurrence of each distinct command.
  const distinct = new Map<string, Candidate>();
  for (const candidate of all) {
    const known = distinct.get(candidate.line);
    if (known === undefined || better(candidate, known, "test")) distinct.set(candidate.line, candidate);
  }
  const candidates = [...distinct.values()];
  const test = candidates.filter((candidate) => candidate.test >= 2).reduce<Candidate | undefined>((best, candidate) => (best === undefined || better(candidate, best, "test") ? candidate : best), undefined);
  const build = candidates.filter((candidate) => candidate !== test && candidate.build >= 2).reduce<Candidate | undefined>((best, candidate) => (best === undefined || better(candidate, best, "build") ? candidate : best), undefined);

  if (test === undefined && build === undefined) {
    notes.push("Rovara does not guess how Brazil runs tests in your setup: no Brazil build or test command was written down in the steering files, AGENTS.md, CLAUDE.md, README, docs or runbooks.");
    return { notes, questions: ["How does your build system run the unit tests, and where does it write the JUnit and coverage reports?"] };
  }

  const checks: Array<{ value: DetectedCheck; source: DetectedSource }> = [];
  const checkOf = (candidate: Candidate, id: string, label: string, kind: "test" | "build"): { value: DetectedCheck; source: DetectedSource } => {
    const lines = texts.get(candidate.path) ?? [];
    const report = kind === "test" ? pathNear(lines, candidate.at, /junit/iu) : undefined;
    const coverage = kind === "test" ? pathNear(lines, candidate.at, /coverage|cobertura|jacoco/iu) : undefined;
    return {
      value: {
        id, label, kind, command: { cwd, executable: candidate.executable, args: candidate.args, timeoutSeconds: TIMEOUT[kind] },
        ...(report === undefined ? {} : { reportPath: report.path, reportSource: { path: candidate.path, line: report.line } }),
        ...(coverage === undefined ? {} : { coveragePath: coverage.path, coverageSource: { path: candidate.path, line: coverage.line } }),
      },
      source: { path: candidate.path, line: candidate.at },
    };
  };
  if (test !== undefined) checks.push(checkOf(test, "brazil-test", "Tests (Brazil command from your docs)", "test"));
  if (build !== undefined) checks.push(checkOf(build, "brazil-build", "Build (Brazil command from your docs)", "build"));
  notes.push("The Brazil commands below were written down by your team (each is cited with its file and line); Rovara did not invent them.");
  if (test !== undefined && checks[0]?.value.reportPath === undefined) notes.push("Rovara does not know where Brazil writes test reports, so no report path is proposed for the Brazil command; counts come from the exit code unless the language tool's own report is found or a maintainer sets one.");
  if (test === undefined) notes.push("The team's docs name a Brazil build command but none tied to tests, so no Brazil test command is proposed.");
  const used = new Set([test, build]);
  const others = candidates.filter((candidate) => !used.has(candidate)).sort((left, right) => (better(left, right, "test") ? -1 : better(right, left, "test") ? 1 : 0)).slice(0, MAX_ALTERNATIVES);
  if (others.length > 0) notes.push(`Other Brazil commands the team wrote down: ${others.map((candidate) => `${candidate.line} (${candidate.path} line ${String(candidate.at)})`).join("; ")}.`);
  return test === undefined ? { checks, notes, questions: ["How does your build system run the unit tests, and where does it write the JUnit and coverage reports?"] } : { checks, notes };
};
