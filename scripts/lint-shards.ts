// Full-repository lint, run in shards so it fits in about 4 GB (C90). `eslint .` with the type-aware rules builds ONE
// TypeScript program over tsconfig.lint.json (about 2,900 files) and keeps it, plus every file's lint state, in one heap;
// that needed more than 6 GB and ran out of memory on a 2-core CI runner. The stricter type check already splits that
// program into the programs in tsconfig.lint/ (scripts/typecheck-programs.ts), and those own exactly the files
// tsconfig.lint.json owns (tests/contract/typecheck-programs.test.ts). This script lints each program's files in its own
// eslint process, one after the other, with that program as the type information source, and then lints everything else
// `eslint .` would lint (the web app, the UI package, scripts/*.mjs, web/*.js, root files) in a last process. The rules,
// the config and the ignore list are the very same eslint.config.js: only `parserOptions.project` and one extra ignore list
// (the files the program shards already linted) come from the environment. Nothing is turned off or skipped.
// Node runs this file directly, so only erasable syntax. Usage, from the repository root, after `tsc -b` (the programs read
// the built declarations of the packages they reference):
//   node scripts/lint-shards.ts [--list] [--only <shard>[,<shard>...]] [--heap <MB>] [--stats]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPrograms, runProcess, type Program, type ProcessRun } from "./typecheck-programs.ts";

/** The heap cap of one shard. The heaviest shards (the test programs) need 3.1 to 3.5 GB of heap and peak near 3.6 GB in all, measured on macOS. */
export const DEFAULT_HEAP_MB = 4096;
/** The name of the last shard, which lints every file that no program and no directory shard owns. */
export const REST = "rest";
/**
 * The type information for the last shard's TypeScript files outside every program: the root vitest configs (the one for the native P0 journeys is
 * in no program; tests/contract/vitest-config.test.ts imports it, which is how the whole-repository program used to reach it). Same options as tsconfig.lint.json.
 */
export const REST_PROJECT = "./tsconfig.lint-rest.json";
/**
 * The web app's directories. No program owns them (tsconfig.lint.json leaves them out); eslint.config.js types them with the
 * TypeScript project service instead, which holds a separate set of programs, so each directory is its own process.
 */
export const DIRECTORY_SHARDS: readonly { name: string; directory: string }[] = [
  { name: "web-ui", directory: "packages/ui" },
  { name: "web-app", directory: "packages/web" },
  { name: "web-tests", directory: "tests/web" },
  { name: "web-e2e-tests", directory: "tests/web-e2e" },
];

export interface Shard {
  name: string;
  /** The tsconfig that supplies type information to the config blocks that use `parserOptions.project`. Absent for a web directory, whose blocks use the project service. */
  project?: string;
  /** What eslint is given: a program's files, or "." for the last shard. */
  targets: readonly string[];
  /** The last shard only: files and directories (a trailing "/") to leave out because another shard lints them. */
  exclude?: readonly string[];
}

/** One shard per program, the biggest first, one per web directory, then the shard for everything else. */
export function planShards(programs: readonly Program[]): Shard[] {
  const ordered = [...programs].sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name));
  return [
    ...ordered.map((program): Shard => ({ name: program.name, project: `./${program.config}`, targets: program.files })),
    ...DIRECTORY_SHARDS.map(({ name, directory }): Shard => ({ name, targets: [directory] })),
    { name: REST, project: REST_PROJECT, targets: ["."], exclude: [...programs.flatMap((program) => program.files).sort(), ...DIRECTORY_SHARDS.map(({ directory }) => `${directory}/`)] },
  ];
}

/** The arguments eslint is started with. */
export function eslintArguments(eslintBin: string, shard: Shard, heapMb: number): string[] {
  return [`--max-old-space-size=${heapMb}`, eslintBin, "--no-warn-ignored", ...shard.targets];
}

export interface Options { list: boolean; stats: boolean; heapMb: number; only?: ReadonlySet<string> }

export function parseOptions(argv: readonly string[]): Options | string {
  const options: Options = { list: false, stats: false, heapMb: DEFAULT_HEAP_MB };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--list") options.list = true;
    else if (arg === "--stats") options.stats = true;
    else if (arg === "--heap") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 512) return "--heap needs a number of megabytes, at least 512";
      options.heapMb = value;
    } else if (arg === "--only") {
      const value = argv[++index];
      if (value === undefined || value === "") return "--only needs a comma-separated list of shard names";
      options.only = new Set(value.split(","));
    } else return `Unknown option ${arg}. Usage: node scripts/lint-shards.ts [--list] [--only <shard>[,<shard>...]] [--heap <MB>] [--stats]`;
  }
  return options;
}

function megabytes(bytes: number | undefined): string {
  return bytes === undefined ? "n/a" : `${Math.round(bytes / 1024 / 1024)} MB`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (typeof options === "string") { console.error(options); process.exitCode = 2; return; }
  const listed = listPrograms();
  if (!listed.ok) { console.error(`Cannot plan the lint shards: ${listed.reason}`); process.exitCode = 1; return; }
  const all = planShards(listed.programs);
  const unknown = [...(options.only ?? [])].filter((name) => !all.some((shard) => shard.name === name));
  if (unknown.length > 0) { console.error(`No such shard: ${unknown.join(", ")}. Shards: ${all.map((shard) => shard.name).join(", ")}`); process.exitCode = 2; return; }
  const selected = all.filter((shard) => options.only === undefined || options.only.has(shard.name));
  if (options.list) {
    console.log(selected.map((shard) => `${shard.name}: ${shard.project ?? "the config blocks' own project service"}, ${shard.targets.length === 1 && shard.targets[0] === "." ? `everything else (${shard.exclude?.length ?? 0} files and directories left to the other shards)` : shard.project === undefined ? shard.targets.join(" ") : `${shard.targets.length} files`}`).join("\n"));
    return;
  }

  const eslintBin = "node_modules/eslint/bin/eslint.js";
  const scratch = mkdtempSync(join(tmpdir(), "lint-shards-"));
  const results: { shard: Shard; run: ProcessRun }[] = [];
  const started = Date.now();
  try {
    for (const shard of selected) {
      // Only the environment differs between shards; eslint.config.js reads it.
      if (shard.project === undefined) delete process.env.ROVARA_LINT_PROJECT; else process.env.ROVARA_LINT_PROJECT = shard.project;
      if (shard.exclude === undefined) delete process.env.ROVARA_LINT_EXCLUDE_FILE;
      else {
        const file = join(scratch, "exclude.txt");
        writeFileSync(file, `${shard.exclude.join("\n")}\n`);
        process.env.ROVARA_LINT_EXCLUDE_FILE = file;
      }
      // NODE_OPTIONS (heavy.sh sets a 6 GB heap) never loosens the cap: the command-line flag comes after it and wins.
      const run = await runProcess(process.execPath, eslintArguments(eslintBin, shard, options.heapMb), { measure: options.stats, timeoutMs: 20 * 60 * 1000 });
      results.push({ shard, run });
      const ok = run.status === 0 && run.error === undefined;
      console.log(`${ok ? "ok  " : "FAIL"} ${shard.name} (${shard.targets.length === 1 && shard.targets[0] === "." ? "everything else" : shard.project === undefined ? shard.targets[0] : `${shard.targets.length} files`}, ${run.seconds.toFixed(0)}s${options.stats ? `, peak ${megabytes(run.peakBytes)}` : ""})`);
      if (!ok) {
        if (run.stdout !== "") console.log(run.stdout.trimEnd());
        if (run.stderr !== "") console.error(run.stderr.trimEnd());
        if (run.signal !== null) console.error(`eslint was stopped by ${run.signal}${run.signal === "SIGABRT" ? ". It may have run out of memory: Node aborts when its heap is full. The cap is --max-old-space-size in eslintArguments (scripts/lint-shards.ts); if one shard needs more, split its program in tsconfig.lint/ (the stricter type check uses the same programs)." : ""}`);
        if (run.error !== undefined) console.error(String(run.error));
      } else if (run.stdout.trim() !== "") console.log(run.stdout.trimEnd());
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const failed = results.filter(({ run }) => run.status !== 0 || run.error !== undefined);
  const peak = Math.max(0, ...results.map(({ run }) => run.peakBytes ?? 0));
  console.log(`${results.length - failed.length} of ${results.length} lint shards passed in ${((Date.now() - started) / 1000).toFixed(0)}s${options.stats ? `; largest peak ${megabytes(peak)}` : ""}.`);
  if (failed.length > 0) console.error(`Failed: ${failed.map(({ shard }) => shard.name).join(", ")}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

// Usage: node scripts/lint-shards.ts [options], from the repository root, after tsc -b
if (process.argv[1]?.endsWith("lint-shards.ts")) await main();
