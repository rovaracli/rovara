// The stricter type check, split into programs (see TYPECHECK-SPLIT.md). Each tsconfig.lint/<name>.json
// except the base*.json files is one TypeScript program: one package, one slice of tests/contract, the
// rest of tests/, scripts/, or infra/. This file lists the programs, works out which of them a set of
// changed files can affect, and runs them a few at a time. scripts/typecheck-baseline.ts reads each
// program's output and applies the baseline. Node runs both files directly, so only erasable syntax.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";
import type * as TypeScript from "typescript";

export const PROGRAMS_DIR = "tsconfig.lint";
/** The monolithic config the programs replace. ESLint still reads it, and the tests keep the two in step. */
export const MONOLITH_CONFIG = "tsconfig.lint.json";

export interface Program { name: string; config: string; files: readonly string[] }
export type ProgramsList = { ok: true; programs: readonly Program[] } | { ok: false; reason: string };

const require = createRequire(import.meta.url);

/** Reads every program's tsconfig (no type checking) to learn which files it owns. */
export function listPrograms(cwd = process.cwd()): ProgramsList {
  const ts = require("typescript") as typeof TypeScript;
  const dir = join(cwd, PROGRAMS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((file) => file.endsWith(".json") && !file.startsWith("base")).map((file) => file.slice(0, -".json".length)).sort();
  } catch (error) {
    return { ok: false, reason: `Could not read ${PROGRAMS_DIR}/: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (names.length === 0) return { ok: false, reason: `${PROGRAMS_DIR}/ has no program configs` };
  const programs: Program[] = [];
  for (const name of names) {
    const config = `${PROGRAMS_DIR}/${name}.json`;
    const problems: string[] = [];
    const parsed = ts.getParsedCommandLineOfConfigFile(join(cwd, config), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => { problems.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
    });
    const errors = [...problems, ...(parsed?.errors ?? []).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))];
    if (parsed === undefined || errors.length > 0) return { ok: false, reason: `${config}: ${errors.join("\n") || "could not be parsed"}` };
    if (parsed.options.noCheck === true) return { ok: false, reason: `${config} sets noCheck, so it would report no errors at all` };
    programs.push({ name, config, files: parsed.fileNames.map((file) => relative(cwd, file).replaceAll("\\", "/")).sort() });
  }
  return { ok: true, programs };
}

// ---- Which programs can a change affect? -------------------------------------------------------

/** Files whose change can alter any program: compiler options, dependencies, the check itself. */
const EVERYTHING = [
  /(^|\/)tsconfig[^/]*\.json$/,
  /^tsconfig\.lint\//,
  /(^|\/)package(-lock)?\.json$/,
  /^\.node-version$/,
  /^scripts\/typecheck-(baseline|programs)\.ts$/,
];

const SPECIFIER = /["'`](\.{1,2}\/[^"'`\s]*|@agentx\/[^"'`\s]*)["'`]/g;
const PROJECT_DIRS = /^(packages\/[^/]+|infra)(\/|$)/;

/** The project (a package or infra) a repository path belongs to, as a graph node name; undefined for anything else. */
export function projectOf(path: string): string | undefined {
  const match = PROJECT_DIRS.exec(path);
  return match === null ? undefined : `project:${match[1]}`;
}

function candidates(from: string, specifier: string): string[] {
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  const swapped = joined.replace(/\.js$/, ".ts").replace(/\.jsx$/, ".tsx").replace(/\.mjs$/, ".mts").replace(/\.cjs$/, ".cts");
  return [...new Set([swapped, joined, `${joined}.ts`, `${joined}/index.ts`])];
}

export interface GraphDeps { read(path: string): string | undefined; exists(path: string): boolean }

/**
 * The nodes one file leads to: the files it imports (resolved like TypeScript would, `.js` meaning `.ts`) and
 * the project of every package or infra file it touches. A project is one node, because the programs read it
 * through its built declarations, which a change anywhere in it can alter.
 */
export function importsOf(file: string, deps: GraphDeps): string[] {
  const text = deps.read(file);
  if (text === undefined) return [];
  const nodes = new Set<string>();
  const own = projectOf(file);
  if (own !== undefined) nodes.add(own);
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1]!;
    if (specifier.startsWith("@agentx/")) {
      nodes.add(`project:packages/${specifier.slice("@agentx/".length).split("/")[0]!}`);
      continue;
    }
    for (const candidate of candidates(file, specifier)) {
      if (!deps.exists(candidate)) continue;
      nodes.add(candidate);
      const project = projectOf(candidate);
      if (project !== undefined) nodes.add(project);
      break;
    }
  }
  return [...nodes];
}

/** The projects a project builds on: its tsconfig references and the @agentx packages in its package.json. */
export function projectDependencies(project: string, deps: GraphDeps): string[] {
  const dir = project.slice("project:".length);
  const found = new Set<string>();
  const references = deps.read(`${dir}/tsconfig.json`);
  if (references !== undefined) for (const match of references.matchAll(/"path"\s*:\s*"([^"]+)"/g)) found.add(posix.normalize(posix.join(dir, match[1]!)).replace(/\/tsconfig[^/]*\.json$/, ""));
  const manifest = deps.read(`${dir}/package.json`);
  if (manifest !== undefined) for (const match of manifest.matchAll(/"@agentx\/([^"]+)"\s*:/g)) found.add(`packages/${match[1]!}`);
  found.delete(dir);
  return [...found].map((path) => `project:${path}`);
}

/** Every node each program can reach, so a change to any of them means the program must run again. */
export function reachableNodes(program: Program, deps: GraphDeps, memo: Map<string, readonly string[]> = new Map()): Set<string> {
  const seen = new Set<string>();
  const queue = [...program.files];
  const edges = (node: string): readonly string[] => {
    const known = memo.get(node);
    if (known !== undefined) return known;
    const next = node.startsWith("project:") ? projectDependencies(node, deps) : importsOf(node, deps);
    memo.set(node, next);
    return next;
  };
  while (queue.length > 0) {
    const node = queue.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of edges(node)) if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

export interface Affected { names: Set<string>; reasons: Map<string, string> }

/** The programs a set of changed files can affect. Anything that could change every program selects them all. */
export function affectedPrograms(programs: readonly Program[], changed: readonly string[], deps: GraphDeps): Affected {
  const names = new Set<string>();
  const reasons = new Map<string, string>();
  const trigger = changed.find((file) => EVERYTHING.some((pattern) => pattern.test(file)));
  if (trigger !== undefined) {
    for (const program of programs) { names.add(program.name); reasons.set(program.name, `${trigger} can change every program`); }
    return { names, reasons };
  }
  const changedNodes = new Set<string>();
  for (const file of changed) {
    changedNodes.add(file);
    const project = projectOf(file);
    if (project !== undefined) changedNodes.add(project);
  }
  const memo = new Map<string, readonly string[]>();
  for (const program of programs) {
    const reach = reachableNodes(program, deps, memo);
    const hit = [...changedNodes].find((node) => reach.has(node));
    if (hit !== undefined) { names.add(program.name); reasons.set(program.name, hit); }
  }
  return { names, reasons };
}

export function fileGraphDeps(cwd = process.cwd()): GraphDeps {
  return {
    read: (path) => { try { return readFileSync(join(cwd, path), "utf8"); } catch { return undefined; } },
    exists: (path) => { try { return statSync(join(cwd, path)).isFile(); } catch { return false; } },
  };
}

// ---- Running ------------------------------------------------------------------------------------

export interface ProcessRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  seconds: number;
  /** Peak resident memory in bytes, when `measure` was on and /usr/bin/time could report it. */
  peakBytes?: number;
}

/** Runs one command, optionally under /usr/bin/time so its peak memory is known. */
export function runProcess(command: string, args: readonly string[], options: { measure: boolean; timeoutMs: number }): Promise<ProcessRun> {
  const started = Date.now();
  let timing: { dir: string; file: string } | undefined;
  let program = command;
  let programArgs = [...args];
  if (options.measure && existsSync("/usr/bin/time")) {
    const dir = mkdtempSync(join(tmpdir(), "typecheck-time-"));
    timing = { dir, file: join(dir, "time.txt") };
    program = "/usr/bin/time";
    programArgs = [process.platform === "darwin" ? "-l" : "-v", "-o", timing.file, command, ...args];
  }
  return new Promise((resolve) => {
    const child = spawn(program, programArgs, { stdio: ["ignore", "pipe", "pipe"], timeout: options.timeoutMs });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let spawnError: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (status, signal) => {
      let peakBytes: number | undefined;
      if (timing !== undefined) {
        try { peakBytes = parsePeakBytes(readFileSync(timing.file, "utf8")); } catch { /* No figure: the run still counts. */ }
        rmSync(timing.dir, { recursive: true, force: true });
      }
      resolve({
        status, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"),
        ...(spawnError === undefined ? {} : { error: spawnError }),
        seconds: (Date.now() - started) / 1000,
        ...(peakBytes === undefined ? {} : { peakBytes }),
      });
    });
  });
}

/** The peak memory in a /usr/bin/time report: bytes on macOS (`-l`), kilobytes on Linux (`-v`). */
export function parsePeakBytes(report: string): number | undefined {
  const mac = /^\s*(\d+)\s+maximum resident set size/m.exec(report);
  if (mac !== null) return Number(mac[1]);
  const linux = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(report);
  return linux === null ? undefined : Number(linux[1]) * 1024;
}

/** Runs `task` over `items` with at most `limit` in flight, starting them in the given order. */
export async function runPool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
