// Setup and test health SH31: changed-line coverage from a Go cover profile (`go test -coverprofile`). The profile is read into line ranges per repository file; `changedLineCoverage` then answers, for the lines a change
// added or changed, how many are statements the tests ran. The intersection is format-neutral (ranges per path), so another reader (Cobertura, LCOV) can feed it later.
//
// A profile line is `import/path/file.go:startLine.startCol,endLine.endCol statements count`. The import path is mapped to a repository path through the module paths and directories the caller gives (from go.mod /
// go.work); a block outside every known module, or whose path leaves the repository, is dropped and counted. A block covers whole lines (columns are ignored): a line is a statement when any block touches it and is
// covered when ANY block on it ran, so `if cond {` is covered when the condition ran even if the body did not. Comment lines inside a block's lines are counted with it.
// Fail closed and bounded: a text that is not a complete, well-formed profile (a wrong header, a malformed line, mixed modes, a reversed or enormous range, more than 1,000,000 blocks) is `undefined`, "not measured".
// Ranges are merged, never expanded line by line, so a block over millions of lines costs nothing.
import { EVIDENCE_COVERAGE_FILES_MAX, EVIDENCE_UNCOVERED_LINES_MAX } from "@agentx/contracts";

/** A cover profile larger than this, or with more blocks, is not read. */
export const GO_COVER_PROFILE_MAX_BYTES = 8 * 1024 * 1024;
export const GO_COVER_PROFILE_MAX_BLOCKS = 1_000_000;
const LINE_MAX = 10_000_000;
const MODES: ReadonlySet<string> = new Set(["set", "count", "atomic"]);
const BLOCK = /^(.+):(\d{1,8})\.\d{1,8},(\d{1,8})\.\d{1,8} \d{1,12} (\d{1,16})$/u;

/** Inclusive line ranges, sorted and non-overlapping. */
type Ranges = ReadonlyArray<readonly [number, number]>;
export interface FileLines { statements: Ranges; covered: Ranges }
export interface LineCoverage {
  /** Repository-relative POSIX path to the file's lines. */
  files: ReadonlyMap<string, FileLines>;
  /** Blocks dropped because their file is outside every known module. */
  unmappedBlocks: number;
}

/** A module of the repository: its module path (go.mod's `module`) and its directory from the repository root (`.` for the root). */
export interface GoModuleRoot { path: string; dir: string }

/** Whether the text starts with a Go cover profile header (`mode: set|count|atomic`): how a coverage file is told from Cobertura XML or LCOV. */
export function looksLikeGoCoverProfile(text: string): boolean {
  const header = /^\s*mode:[ \t]*(\w+)[ \t]*$/mu.exec(text.slice(0, 256));
  return header !== null && text.slice(0, header.index).trim() === "" && MODES.has(header[1]!);
}

function merge(ranges: Array<[number, number]>): Array<[number, number]> {
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function repositoryPath(importPath: string, modules: readonly GoModuleRoot[]): string | undefined {
  let best: GoModuleRoot | undefined;
  for (const module of modules) if (importPath.startsWith(`${module.path}/`) && (best === undefined || module.path.length > best.path.length)) best = module;
  if (best === undefined) return undefined;
  const rest = importPath.slice(best.path.length + 1);
  const joined = best.dir === "." || best.dir === "" ? rest : `${best.dir}/${rest}`;
  const parts = joined.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\")) && joined.length <= 500 ? joined : undefined;
}

export function parseGoCoverProfile(text: string, options: { modules: readonly GoModuleRoot[] }): LineCoverage | undefined {
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > GO_COVER_PROFILE_MAX_BYTES || options.modules.length === 0) return undefined;
  const perFile = new Map<string, { all: Array<[number, number]>; ran: Array<[number, number]> }>();
  let mode: string | undefined;
  let blocks = 0;
  let unmapped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("mode:")) {
      const found = line.slice("mode:".length).trim();
      if (!MODES.has(found) || (mode !== undefined && found !== mode)) return undefined;
      mode = found;
      continue;
    }
    const match = BLOCK.exec(line);
    if (mode === undefined || match === null) return undefined;
    const start = Number(match[2]);
    const end = Number(match[3]);
    const count = Number(match[4]);
    if (!Number.isSafeInteger(count) || start < 1 || end < start || end > LINE_MAX) return undefined;
    blocks += 1;
    if (blocks > GO_COVER_PROFILE_MAX_BLOCKS) return undefined;
    const path = repositoryPath(match[1]!, options.modules);
    if (path === undefined) { unmapped += 1; continue; }
    const entry = perFile.get(path) ?? { all: [], ran: [] };
    entry.all.push([start, end]);
    if (count > 0) entry.ran.push([start, end]);
    perFile.set(path, entry);
  }
  if (perFile.size === 0) return undefined;
  const files = new Map<string, FileLines>();
  for (const [path, entry] of perFile) files.set(path, { statements: merge(entry.all), covered: merge(entry.ran) });
  return { files, unmappedBlocks: unmapped };
}

function contains(ranges: Ranges, line: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle]!;
    if (line < start) high = middle - 1;
    else if (line > end) low = middle + 1;
    else return true;
  }
  return false;
}

/** The evidence's `coverage` part (`EvidenceCoverageSchema`). */
export interface ChangedCoverage {
  linesChanged: number;
  linesCovered: number;
  files: Array<{ path: string; uncovered: number[] }>;
}

/**
 * The changed lines (path to new-file line numbers) against the coverage. Only lines the profile calls statements are counted. Files with uncovered lines are listed in path order, at most
 * `EVIDENCE_COVERAGE_FILES_MAX` of them with at most `EVIDENCE_UNCOVERED_LINES_MAX` lines each (the counts stay true). `unmeasured` lists changed Go source files the profile does not name at all (no
 * statements there, or their package was not covered): the caller can say so, and their lines are not in the counts.
 */
export function changedLineCoverage(coverage: LineCoverage, changed: ReadonlyMap<string, readonly number[]>): { coverage: ChangedCoverage; unmeasured: string[] } {
  let linesChanged = 0;
  let linesCovered = 0;
  const files: ChangedCoverage["files"] = [];
  const unmeasured: string[] = [];
  for (const path of [...changed.keys()].sort()) {
    const lines = coverage.files.get(path);
    if (lines === undefined) {
      if (path.endsWith(".go") && !path.endsWith("_test.go")) unmeasured.push(path);
      continue;
    }
    const uncovered: number[] = [];
    for (const line of [...new Set(changed.get(path))].filter((value) => Number.isSafeInteger(value) && value >= 1).sort((a, b) => a - b)) {
      if (!contains(lines.statements, line)) continue;
      linesChanged += 1;
      if (contains(lines.covered, line)) linesCovered += 1;
      else uncovered.push(line);
    }
    if (uncovered.length > 0 && files.length < EVIDENCE_COVERAGE_FILES_MAX) files.push({ path, uncovered: uncovered.slice(0, EVIDENCE_UNCOVERED_LINES_MAX) });
  }
  return { coverage: { linesChanged, linesCovered, files }, unmeasured };
}
