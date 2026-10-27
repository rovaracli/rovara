// The stricter type check's ratchet (issue #50). The programs in tsconfig.lint/ also check tests/ and
// scripts/, which `npm run typecheck` (tsc -b) leaves out, and those files may have known errors.
// Each program is one tsc run (scripts/typecheck-programs.ts); together they cover what the single
// tsconfig.lint.json program used to, without one run needing the whole repository in memory.
// This script counts the errors per file and compares them with tests/typecheck-baseline.json:
// a file whose count goes up, or a new file with errors, fails; a count that goes down passes with
// a reminder to lower the baseline. `update` rewrites the baseline, but only ever lowers it.
// A tsc crash or config error always fails: it must never read as "0 errors". So does a baseline
// file the check no longer reads (a narrowed tsconfig), which would otherwise look like a fix.
// A renamed file keeps its errors under its new path: move its entry in the baseline by hand.
// Node runs this file directly; it loads TypeScript, a dev dependency, only to list the programs.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { PROGRAMS_DIR, affectedPrograms, fileGraphDeps, listPrograms, runPool, runProcess, type Program, type ProcessRun } from "./typecheck-programs.ts";

export type Counts = Record<string, number>;
export interface ParsedOutput { counts: Counts; problems: string[] }
export interface TscRun { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Error }
export type RunResult = { ok: true; counts: Counts } | { ok: false; reason: string };
export interface Change { file: string; baseline: number; current: number }
export interface Comparison { pass: boolean; raised: Change[]; lowered: Change[]; lines: string[] }
export type ProgramList = { ok: true; files: readonly string[] } | { ok: false; reason: string };
/** What running the programs produced: the merged verdict, and the raw output for hints. */
export interface Checks { run: RunResult; stdout: string }
export interface RatchetDeps {
  github: boolean;
  readBaseline(): string;
  /** Runs the programs (all of them, or the ones a change affects) and merges their errors. */
  runChecks(): Promise<Checks>;
  /** Every file the programs type-check, whether or not this run executes the program that owns it. */
  listProgram(): ProgramList;
  /** When only some programs ran: the files they own. Counts can only be lowered for those files. */
  scope?: ReadonlySet<string>;
  writeBaseline(text: string): void;
}
export interface RatchetResult { code: 0 | 1; out: string[]; err: string[] }

export const BASELINE_PATH = "tests/typecheck-baseline.json";
const LOCATED = /^(.+?)\((\d+),(\d+)\): error (TS\d+): /;
const UNLOCATED = /^error TS\d+: /;
const REPO_PATH = /^[^/\\:][^\\:]*$/;

/** Per-file error keys (position, code, first message line) from `tsc --pretty false` output; anything unexpected goes in `problems`. */
export function parseTscErrors(text: string): { errors: Record<string, string[]>; problems: string[] } {
  const errors: Record<string, string[]> = {};
  const problems: string[] = [];
  let inError = false;
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    const located = LOCATED.exec(line);
    if (located !== null) {
      const file = located[1]!.replaceAll("\\", "/");
      const code = located[4]!;
      // A compiler option error, or any error inside a JSON config file, means the check itself is
      // broken, so it is a problem, not a count a baseline could absorb.
      if (code.startsWith("TS5") || file.endsWith(".json")) problems.push(line);
      else (errors[file] ??= []).push(line.slice(located[1]!.length));
      inError = true;
    } else if (/^\s/.test(line) && inError) {
      continue; // The indented lines that continue a multi-line error.
    } else {
      problems.push(line);
      inError = UNLOCATED.test(line);
    }
  }
  return { errors, problems };
}

/** Per-file error counts from `tsc --pretty false` output; anything unexpected goes in `problems`. */
export function parseTscOutput(text: string): ParsedOutput {
  const { errors, problems } = parseTscErrors(text);
  return { counts: Object.fromEntries(Object.entries(errors).map(([file, keys]) => [file, keys.length])), problems };
}

/**
 * Merges the errors several programs reported. Two programs that both import a file report its errors twice,
 * so an error counts once however many programs saw it: per file and error, the highest count of any program.
 */
export function mergeErrors(runs: readonly Record<string, string[]>[]): Counts {
  const best = new Map<string, Map<string, number>>();
  for (const errors of runs) {
    for (const [file, keys] of Object.entries(errors)) {
      const seen = new Map<string, number>();
      for (const key of keys) seen.set(key, (seen.get(key) ?? 0) + 1);
      const merged = best.get(file) ?? new Map<string, number>();
      for (const [key, count] of seen) merged.set(key, Math.max(merged.get(key) ?? 0, count));
      best.set(file, merged);
    }
  }
  return Object.fromEntries([...best].map(([file, keys]) => [file, [...keys.values()].reduce((sum, count) => sum + count, 0)]));
}

/** Turns a tsc run into per-file counts, or a reason the run cannot be trusted. */
export function interpretTscRun(run: TscRun): RunResult {
  if (run.error !== undefined) return { ok: false, reason: `tsc could not run: ${run.error.message}` };
  if (run.signal === "SIGABRT") {
    return { ok: false, reason: `tsc was stopped by SIGABRT. It may have run out of memory: Node aborts when its heap is full. The heap limit is set by --max-old-space-size in tscArguments (scripts/typecheck-baseline.ts); if one program needs more, split it in tsconfig.lint/.` };
  }
  if (run.signal !== null) return { ok: false, reason: `tsc was stopped by ${run.signal}` };
  if (run.status === null) return { ok: false, reason: "tsc exited without an exit code" };
  if (run.stderr.trim() !== "") return { ok: false, reason: `tsc wrote to stderr:\n${run.stderr.trim()}` };
  const parsed = parseTscOutput(run.stdout);
  if (parsed.problems.length > 0) return { ok: false, reason: `tsc printed output that is not a per-file type error:\n${parsed.problems.join("\n")}` };
  const found = Object.keys(parsed.counts).length > 0;
  if (run.status === 0) return found ? { ok: false, reason: "tsc exited with code 0 but reported errors" } : { ok: true, counts: {} };
  if (run.status !== 1 && run.status !== 2) return { ok: false, reason: `tsc exited with code ${run.status}, which means the project setup is broken` };
  if (!found) return { ok: false, reason: `tsc exited with code ${run.status} but reported no errors` };
  return { ok: true, counts: parsed.counts };
}

function changes(baseline: Counts, current: Counts): { raised: Change[]; lowered: Change[] } {
  const raised: Change[] = [];
  const lowered: Change[] = [];
  for (const file of [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()) {
    const was = baseline[file] ?? 0;
    const now = current[file] ?? 0;
    if (now > was) raised.push({ file, baseline: was, current: now });
    else if (now < was) lowered.push({ file, baseline: was, current: now });
  }
  return { raised, lowered };
}

const describeChange = (change: Change): string => `  ${change.file}: ${change.baseline} -> ${change.current}`;
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
function summary(counts: Counts): string {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return `${plural(total, "error")} in ${plural(Object.keys(counts).length, "file")}`;
}

/**
 * Compares the current counts with the baseline: any raised or new file fails. When only some programs ran,
 * `scope` is the files they own: a file outside it that the run did not report is not "fixed", just unchecked.
 */
export function compareToBaseline(baseline: Counts, current: Counts, scope?: ReadonlySet<string>): Comparison {
  const all = changes(baseline, current);
  const raised = all.raised;
  const lowered = scope === undefined ? all.lowered : all.lowered.filter((change) => scope.has(change.file));
  const inScope = scope === undefined ? baseline : Object.fromEntries(Object.entries(baseline).filter(([file]) => scope.has(file)));
  const lines = [`Stricter type check (${PROGRAMS_DIR}/): ${summary(current)} (baseline${scope === undefined ? "" : " for the files checked"}: ${summary(inScope)}).`];
  if (raised.length > 0) {
    lines.push("", "These files have more type errors than the baseline allows. Fix the new errors:", ...raised.map(describeChange));
  }
  if (lowered.length > 0) {
    lines.push("", "These files have fewer type errors than the baseline. Lower the baseline with `npm run typecheck:baseline` and commit it:", ...lowered.map(describeChange));
  }
  return { pass: raised.length === 0, raised, lowered, lines };
}

/** The new baseline after errors were fixed; refuses to raise any count or add any file. */
export function lowerBaseline(baseline: Counts, current: Counts): { ok: true; baseline: Counts } | { ok: false; reason: string } {
  const { raised } = changes(baseline, current);
  if (raised.length > 0) {
    return {
      ok: false,
      reason: [
        "The baseline can only go down. Fix these errors instead of adding them to the baseline:",
        ...raised.map(describeChange),
        `If you renamed a file that already had errors, move its entry in ${BASELINE_PATH} by hand.`,
      ].join("\n"),
    };
  }
  return { ok: true, baseline: { ...current } };
}

export function formatBaseline(counts: Counts): string {
  const files = Object.fromEntries(Object.keys(counts).sort().map((file) => [file, counts[file]!]));
  return `${JSON.stringify({ files }, null, 2)}\n`;
}

export function parseBaseline(text: string): Counts {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${BASELINE_PATH} must be an object with a "files" map`);
  const extra = Object.keys(value).filter((key) => key !== "files");
  if (extra.length > 0) throw new Error(`${BASELINE_PATH} has unknown keys: ${extra.join(", ")}`);
  const files = (value as { files?: unknown }).files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) throw new Error(`${BASELINE_PATH} must have a "files" map`);
  const counts: Counts = {};
  for (const [file, count] of Object.entries(files)) {
    if (!REPO_PATH.test(file) || file.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`${BASELINE_PATH}: "${file}" must be a repository-relative path with forward slashes`);
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) throw new Error(`${BASELINE_PATH}: ${file} must have a whole-number count of at least 1`);
    counts[file] = count;
  }
  return counts;
}

/** Baseline files the type check no longer reads, so their errors cannot be counted. */
export function uncheckedBaselineFiles(baseline: Counts, programFiles: readonly string[]): string[] {
  const checked = new Set(programFiles);
  return Object.keys(baseline).filter((file) => !checked.has(file)).sort();
}

/** GitHub Actions annotations, so a raised or lowered count shows on the pull request. */
export function githubAnnotations(comparison: Comparison): string[] {
  return [
    ...comparison.raised.map((change) => `::error file=${BASELINE_PATH}::${change.file} has ${plural(change.current, "type error")}, more than its baseline of ${change.baseline}. Fix the new errors.`),
    ...comparison.lowered.map((change) => `::warning file=${BASELINE_PATH}::${change.file} has ${plural(change.current, "type error")}, fewer than its baseline of ${change.baseline}. Run npm run typecheck:baseline and commit it.`),
  ];
}

/** The whole command, with its side effects passed in: `check` compares, `update` lowers the baseline. */
export async function runRatchet(mode: "check" | "update", deps: RatchetDeps): Promise<RatchetResult> {
  const out: string[] = [];
  const err: string[] = [];
  const fail = (...lines: string[]): RatchetResult => ({ code: 1, out, err: [...err, ...lines] });
  let baseline: Counts;
  try {
    baseline = parseBaseline(deps.readBaseline());
  } catch (error) {
    return fail(`Could not read the baseline: ${error instanceof Error ? error.message : String(error)}`);
  }
  const program = deps.listProgram();
  if (!program.ok) return fail(`Could not list the files the stricter type check covers: ${program.reason}`);
  if (mode === "update" && deps.scope !== undefined) return fail("The baseline can only be lowered by a run of every program: leave out --changed and --only.");
  const { run, stdout } = await deps.runChecks();
  if (!run.ok) return fail("The stricter type check did not run cleanly, so it cannot be compared with the baseline.", run.reason);
  const unchecked = uncheckedBaselineFiles(baseline, program.files);
  if (unchecked.length > 0) {
    return fail(
      ...unchecked.map((file) => `${file} is in the baseline but is no longer type-checked by any program in ${PROGRAMS_DIR}/.`),
      `If the file was deleted or renamed, remove or move its entry in ${BASELINE_PATH} by hand. Otherwise put it back in the check.`,
    );
  }
  if (mode === "check") {
    const result = compareToBaseline(baseline, run.counts, deps.scope);
    (result.pass ? out : err).push(...result.lines);
    if (deps.github) out.push(...githubAnnotations(result));
    if (result.pass) return { code: 0, out, err };
    if (/error TS(2307|6305)/.test(stdout)) err.push("", "Some errors are missing-module or unbuilt-output errors (TS2307, TS6305). Run `npm run typecheck` first: this check reads the packages' built outputs.");
    return { code: 1, out, err };
  }
  const lowered = lowerBaseline(baseline, run.counts);
  if (!lowered.ok) return fail(lowered.reason);
  deps.writeBaseline(formatBaseline(lowered.baseline));
  out.push(`Wrote ${BASELINE_PATH}: ${summary(lowered.baseline)} (was ${summary(baseline)}).`);
  return { code: 0, out, err };
}

const require = createRequire(import.meta.url);

/** Node's arguments for one program's tsc run. A program is one package, a slice of tests or the scripts,
 * so the default heap (about 4 GB) is the ceiling; each program peaks well under 3 GB (TYPECHECK-SPLIT.md). */
export function tscArguments(tscPath: string, config: string, heapMb = 4096): string[] {
  return [`--max-old-space-size=${heapMb}`, tscPath, "-p", config, "--noEmit", "--pretty", "false"];
}

export interface ProgramResult { program: Program; run: ProcessRun }

/** Judges each program's run on its own (a crash in any one fails the whole check), then merges the errors. */
export function mergeProgramRuns(results: readonly ProgramResult[]): Checks {
  const errors: Record<string, string[]>[] = [];
  let stdout = "";
  for (const { program, run } of results) {
    const judged = interpretTscRun(run);
    if (!judged.ok) return { run: { ok: false, reason: `${program.config}: ${judged.reason}` }, stdout };
    errors.push(parseTscErrors(run.stdout).errors);
    stdout += run.stdout;
  }
  return { run: { ok: true, counts: mergeErrors(errors) }, stdout };
}

export interface Options {
  mode: "check" | "update";
  changed: boolean;
  base: string;
  only: string[];
  jobs: number;
  stats: boolean;
  list: boolean;
}

export function parseArguments(argv: readonly string[], cpus = availableParallelism()): Options | string {
  const options: Options = { mode: "check", changed: false, base: "HEAD", only: [], jobs: Math.max(1, Math.min(4, Math.floor(cpus / 2))), stats: false, list: false };
  const [mode, ...rest] = argv;
  if (mode !== "check" && mode !== "update") return usage();
  options.mode = mode;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = (): string | undefined => rest[++i];
    if (arg === "--changed") options.changed = true;
    else if (arg === "--stats") options.stats = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--base") { const v = value(); if (v === undefined || v.startsWith("--")) return usage(); options.base = v; }
    else if (arg === "--only") { const v = value(); if (v === undefined || v.startsWith("--")) return usage(); options.only.push(...v.split(",").filter((name) => name !== "")); }
    else if (arg === "--jobs") { const v = Number(value()); if (!Number.isInteger(v) || v < 1) return usage(); options.jobs = v; }
    else return usage();
  }
  if (options.base !== "HEAD" && !options.changed) return "--base only makes sense with --changed";
  return options;
}

const usage = (): string => "usage: node scripts/typecheck-baseline.ts check|update [--changed [--base REF]] [--only NAME[,NAME]] [--jobs N] [--stats] [--list]";

/** Files that differ from the merge base with REF (committed, staged, unstaged, untracked), deleted ones included. */
function changedSince(base: string): string[] {
  const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  const mergeBase = git("merge-base", base, "HEAD");
  const tracked = git("diff", "--name-only", "--no-renames", mergeBase).split("\n");
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n");
  return [...new Set([...tracked, ...untracked])].filter((file) => file !== "");
}

function formatStats(results: readonly ProgramResult[], wallSeconds: number): string[] {
  const rows = results.map(({ program, run }) => `  ${program.name.padEnd(24)} ${String(program.files.length).padStart(5)} files ${run.seconds.toFixed(1).padStart(6)} s ${run.peakBytes === undefined ? "     n/a" : `${(run.peakBytes / 1024 ** 3).toFixed(2).padStart(6)} GB`}`);
  const peak = Math.max(0, ...results.map(({ run }) => run.peakBytes ?? 0));
  return ["Programs (name, root files, time, peak memory):", ...rows, `  ${results.length} programs in ${wallSeconds.toFixed(1)} s wall time, ${peak === 0 ? "peak memory n/a" : `highest single-program peak ${(peak / 1024 ** 3).toFixed(2)} GB`}.`];
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (typeof options === "string") { console.error(options); process.exitCode = 1; return; }
  const listed = listPrograms();
  if (!listed.ok) { console.error(`Could not list the stricter type check's programs: ${listed.reason}`); process.exitCode = 1; return; }
  const all = listed.programs;
  const unknown = options.only.filter((name) => !all.some((program) => program.name === name));
  if (unknown.length > 0) { console.error(`Unknown program ${unknown.join(", ")}. Programs: ${all.map((program) => program.name).join(", ")}`); process.exitCode = 1; return; }

  let selected: readonly Program[] = all;
  const notes: string[] = [];
  if (options.only.length > 0) selected = all.filter((program) => options.only.includes(program.name));
  if (options.changed) {
    let changed: string[];
    try { changed = changedSince(options.base); } catch (error) { console.error(`Could not list the files changed since ${options.base}: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; return; }
    const affected = affectedPrograms(all, changed, fileGraphDeps());
    selected = selected.filter((program) => affected.names.has(program.name));
    notes.push(`${changed.length} changed file${changed.length === 1 ? "" : "s"} since ${options.base}: ${selected.length} of ${all.length} programs affected.`);
    if (options.list) notes.push(...selected.map((program) => `  ${program.name}: ${affected.reasons.get(program.name)}`));
  } else if (options.list) {
    notes.push(...selected.map((program) => `  ${program.name}: ${program.files.length} files`));
  }
  if (options.list) { console.log(notes.join("\n")); return; }
  if (notes.length > 0) console.log(notes.join("\n"));
  if (selected.length === 0) { console.log("No program is affected, so there is nothing to type-check."); return; }

  const tsc = require.resolve("typescript/bin/tsc");
  const started = Date.now();
  let results: ProgramResult[] = [];
  const scope = selected.length === all.length ? undefined : new Set(selected.flatMap((program) => program.files));
  const result = await runRatchet(options.mode, {
    github: process.env.GITHUB_ACTIONS === "true",
    readBaseline: () => readFileSync(BASELINE_PATH, "utf8"),
    runChecks: async () => {
      // The biggest programs start first, so the last ones to finish are the small ones.
      const ordered = [...selected].sort((a, b) => b.files.length - a.files.length);
      results = await runPool(ordered, options.jobs, async (program) => ({
        program,
        run: await runProcess(process.execPath, tscArguments(tsc, program.config), { measure: options.stats, timeoutMs: 15 * 60 * 1000 }),
      }));
      return mergeProgramRuns(results);
    },
    listProgram: () => ({ ok: true, files: all.flatMap((program) => program.files) }),
    ...(scope === undefined ? {} : { scope }),
    writeBaseline: (text) => { writeFileSync(BASELINE_PATH, text); },
  });
  if (result.out.length > 0) console.log(result.out.join("\n"));
  if (result.err.length > 0) console.error(result.err.join("\n"));
  if (options.stats && results.length > 0) console.log(formatStats(results, (Date.now() - started) / 1000).join("\n"));
  process.exitCode = result.code;
}

// Usage: node scripts/typecheck-baseline.ts check|update [options], from the repository root, after tsc -b
if (process.argv[1]?.endsWith("typecheck-baseline.ts")) await main();
