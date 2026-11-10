// Lessons replay A/B (lane 7, 0.5.12, DECISIONS 38/47/49/50.5): the operator's tool. It makes NO AWS call and no model call itself. Everything that touches staging (running a replayed task, a lesson pipeline, the
// grader) is an operator MODULE you pass with --module; this script plans, orders, records and reports. The report states numbers and gives no verdict: the owner decides. See docs/runbooks/lessons-replay-measure.md.
//
//   npx tsx scripts/lessons-replay-measure.ts select      --candidates <file> --seed <text> [--target 50] [--per-repo-max 15] --out <selection.json>
//   npx tsx scripts/lessons-replay-measure.ts snapshots   --selection <file> --arms off,on:current --module <file> --workspace <org id> --out-dir <dir> --max-usd <usd>
//   npx tsx scripts/lessons-replay-measure.ts import-snapshots --dir <dir> --module <file>
//   npx tsx scripts/lessons-replay-measure.ts plan        --selection <file> --arms <list> --seed <text> --grader-model <m> --grader-version <v> --snapshots <dir>/snapshots.json --out <plan.json> [--small]
//   npx tsx scripts/lessons-replay-measure.ts run         --plan <file> --module <file> --corrections <file> --results <results.jsonl> --max-usd <usd> --per-run-usd <usd> --planning-usd <usd> [--dir <dir>]
//   npx tsx scripts/lessons-replay-measure.ts blind-sheet --final-lessons <dir>/final-lessons.json --seed <text> --out-sheet <sheet.json> --out-key <key.json>
//   npx tsx scripts/lessons-replay-measure.ts import-marks --key <key.json> --marks <marks.json> --out <marks-by-arm.json>
//   npx tsx scripts/lessons-replay-measure.ts report      --results <results.jsonl> --plan <plan.json> --compare on:current,on:consolidated [--dir <dir of snapshots outputs>] [--marks <marks-by-arm.json>] [--corrections <file>] [--json] [--continue-anyway]
//
// The operator module (--module) is an ES module whose default export is a function returning OperatorModule (below). `scripts/lessons-replay-staging-module.ts` is the one for a real staging run; tests pass their own.
// The MCP arm is not built: a plan with one refuses by name.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { blindSheet, buildMeasureReport, importMarks, readReplayRunRows, renderMeasureReport, type ArmLessonSet, type ArmLearningCost, type ArmUsefulMarks, type BlindKey, type ReplayRunRow } from "@agentx/contracts";
import { fusedMatcher } from "../packages/broker/src/lessons/metric-source.js";
import type { CorrectionRecord, CorrectionSource } from "../packages/broker/src/lessons/metric.js";
import { ArmNotBuiltError, buildReplayPlan, copyWorstCaseUsd, buildSnapshots, runReplay, type ReplayExecutor, type ReplayGraderPort, type ReplayPlan, type RunSink, type SnapshotBuilder } from "../packages/broker/src/lessons/replay-harness.js";
import { repeatMistakeChecks } from "../packages/broker/src/lessons/replay-mistakes.js";
import { selectReplayTasks, type ReplayCandidate } from "../packages/broker/src/lessons/replay-select.js";
import { LessonSchema, type Lesson } from "../packages/broker/src/lessons/types.js";

export interface Io { out(text: string): void; err(text: string): void }
export interface OperatorModule {
  builders?: Record<string, SnapshotBuilder>;
  executor?: ReplayExecutor;
  grader?: ReplayGraderPort;
  /** What one copy may spend once its plan is approved: the same number the executor holds its copies to. */
  perRunUsd?: number;
  /** What a copy may spend planning, before approval: the project's planning limit for the workflow path. The budget reserves planning plus the run limit for every copy. */
  planningLimitUsd?: number;
  /** Imports an arm's lessons for a day as a frozen snapshot of the project; answers the id the install derived. */
  importSnapshot?: (pipeline: string, day: string, lessons: readonly Lesson[]) => string;
  /** Hands the grader the text of the historical corrections it judges repeats by. */
  setCorrectionTexts?: (texts: ReadonlyMap<string, string>) => void;
}

const read = (file: string): unknown => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`cannot read ${file} as JSON`); } };
const write = (file: string, value: unknown): void => { mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };

function options(argv: readonly string[], known: readonly string[], flags: readonly string[] = []): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i] ?? "";
    if (flags.includes(name)) { out.set(name, true); continue; }
    if (!known.includes(name)) throw new Error(`unknown option ${name}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (out.has(name)) throw new Error(`${name} was given twice`);
    out.set(name, value);
    i += 1;
  }
  return out;
}
const need = (o: Map<string, string | true>, name: string): string => { const v = o.get(name); if (typeof v !== "string") throw new Error(`${name} is required`); return v; };
const opt = (o: Map<string, string | true>, name: string): string | undefined => { const v = o.get(name); return typeof v === "string" ? v : undefined; };

async function loadModule(file: string): Promise<OperatorModule> {
  const loaded = (await import(pathToFileURL(path.resolve(file)).href)) as { default?: unknown };
  const made = typeof loaded.default === "function" ? await (loaded.default as () => unknown)() : loaded.default;
  if (typeof made !== "object" || made === null) throw new Error("the --module must export a function or object");
  return made;
}

/** A results file: one JSON object per line, { key, row }. */
/** Takes the results file's lock (`<file>.lock`, holding this process's id) or refuses; a lock whose process is gone is taken over. Returns the release. */
export function lockResults(file: string): () => void {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let exists: boolean;
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return () => { try { unlinkSync(lock); } catch { /* already gone */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      exists = true;
    }
    if (exists) {
      const holder = Number(readFileSync(lock, "utf8").trim());
      let alive = true;
      try { process.kill(holder, 0); } catch { alive = false; }
      if (alive && holder !== process.pid) throw new Error(`another replay run is using ${file} (process ${String(holder)}); two runs on one results file would each spend up to the limit`);
      try { unlinkSync(lock); } catch { /* raced with another taker: the next attempt decides */ }
    }
  }
  throw new Error(`could not take the lock on ${file}`);
}

function jsonlSink(file: string): RunSink {
  const done = new Set<string>();
  let spent = 0;
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line) as { key: string; charge?: number };
      done.add(entry.key);
      spent += typeof entry.charge === "number" ? entry.charge : 0;
    }
  }
  return { done: () => done, spentUsd: () => spent, append: async (key, row, charge) => { appendFileSync(file, `${JSON.stringify({ key, row, charge })}\n`); done.add(key); spent += charge; } };
}
const readResults = (file: string): ReplayRunRow[] => readReplayRunRows(readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => (JSON.parse(line) as { row: unknown }).row));

const correctionsFrom = (file: string): CorrectionRecord[] => {
  const raw = read(file);
  if (!Array.isArray(raw)) throw new Error("the corrections file is a list");
  return raw.map((entry: Record<string, unknown>) => ({ id: String(entry["id"]), taskId: String(entry["taskId"]), at: Number(entry["at"]), kind: entry["kind"] as CorrectionRecord["kind"], member: entry["member"] === true,
    ...(typeof entry["text"] === "string" ? { text: entry["text"] } : {}), ...(Array.isArray(entry["paths"]) ? { paths: entry["paths"] as string[] } : {}) }));
};
const sourceOver = (corrections: readonly CorrectionRecord[]): CorrectionSource => ({ list: async (_k, range) => ({ corrections: corrections.filter((c) => c.at >= range.since && c.at < range.until), truncated: false }) });

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "select": {
        const o = options(rest, ["--candidates", "--seed", "--target", "--per-repo-max", "--out"]);
        const target = opt(o, "--target"), cap = opt(o, "--per-repo-max");
        const result = selectReplayTasks(read(need(o, "--candidates")) as ReplayCandidate[], { seed: need(o, "--seed"), ...(target === undefined ? {} : { target: Number(target) }), ...(cap === undefined ? {} : { perRepoMax: Number(cap) }) });
        if (!result.ok) { io.err(`selection refused: ${result.reason}${result.detail === undefined ? "" : ` (${result.detail})`}`); return 2; }
        write(need(o, "--out"), result);
        io.out(`selected ${String(result.tasks.length)} tasks from ${String(result.repositories.length)} repositories (mean ${result.meanCorrections.toFixed(1)} member corrections per task; the pool's mean is ${result.poolMeanCorrections.toFixed(1)})`);
        return 0;
      }
      case "snapshots": {
        const o = options(rest, ["--selection", "--arms", "--module", "--out-dir", "--max-usd", "--workspace"]);
        const tasks = (read(need(o, "--selection")) as { tasks: ReplayCandidate[] }).tasks;
        const mod = await loadModule(need(o, "--module"));
        const project = tasks[0]?.project;
        if (project === undefined || tasks.some((t) => t.project !== project)) throw new Error("a replay is of one project: the selection holds tasks of several");
        const built = await buildSnapshots({ key: { workspaceId: need(o, "--workspace"), project }, tasks, arms: need(o, "--arms").split(","), builders: mod.builders ?? {}, ...(opt(o, "--max-usd") === undefined ? {} : { maxUsd: Number(opt(o, "--max-usd")) }) });
        const dir = need(o, "--out-dir");
        write(path.join(dir, "snapshots.json"), built.snapshots);
        write(path.join(dir, "learning.json"), built.learning);
        write(path.join(dir, "lesson-sets.json"), built.lessonSets);
        write(path.join(dir, "snapshot-lessons.json"), built.lessonsByDay);
        write(path.join(dir, "final-lessons.json"), Object.fromEntries(Object.entries(built.finalLessons).map(([pipeline, lessons]) => [`on:${pipeline}`, lessons])));
        io.out(`built snapshots for ${String(Object.keys(built.snapshots).length)} pipelines; learning cost ${built.learning.map((c) => `${c.arm} $${(c.usd ?? 0).toFixed(2)}`).join(", ")}`);
        return 0;
      }
      case "import-snapshots": {
        const o = options(rest, ["--dir", "--module"]);
        const mod = await loadModule(need(o, "--module"));
        if (mod.importSnapshot === undefined) throw new Error("the --module must provide importSnapshot");
        const dir = need(o, "--dir");
        const ids = read(path.join(dir, "snapshots.json")) as Record<string, Record<string, string>>;
        const lessons = read(path.join(dir, "snapshot-lessons.json")) as Record<string, Record<string, unknown[]>>;
        let imported = 0;
        for (const [pipeline, days] of Object.entries(lessons)) {
          for (const [day, list] of Object.entries(days)) {
            const id = mod.importSnapshot(pipeline, day, list.map((l) => LessonSchema.parse(l)));
            // The id the install derived must be the one the plan will name: a difference means the lessons changed on the way, and the replay would run on something else.
            if (id !== ids[pipeline]?.[day]) throw new Error(`the install derived snapshot ${id} for ${pipeline} on ${day}, not the planned ${String(ids[pipeline]?.[day])}`);
            imported += 1;
          }
        }
        io.out(`imported ${String(imported)} frozen snapshots`);
        return 0;
      }
      case "plan": {
        const o = options(rest, ["--selection", "--arms", "--seed", "--grader-model", "--grader-version", "--snapshots", "--out"], ["--small"]);
        const plan = buildReplayPlan({
          tasks: (read(need(o, "--selection")) as { tasks: ReplayCandidate[] }).tasks, arms: need(o, "--arms").split(","), seed: need(o, "--seed"), grader: { model: need(o, "--grader-model"), version: need(o, "--grader-version") },
          snapshots: read(need(o, "--snapshots")) as Record<string, Record<string, string>>, ...(o.get("--small") === true ? { allowSmall: true, repeats: 1 } : {}),
        });
        write(need(o, "--out"), plan);
        io.out(`planned ${String(plan.runs.length)} runs over ${String(plan.tasks.length)} tasks and ${String(plan.arms.length)} arms; ${String(plan.projectDays)} project-days`);
        io.out(plan.notes.join("\n"));
        return 0;
      }
      case "run": {
        const o = options(rest, ["--plan", "--module", "--corrections", "--results", "--max-usd", "--per-run-usd", "--planning-usd", "--dir"]);
        const plan = read(need(o, "--plan")) as ReplayPlan;
        const mod = await loadModule(need(o, "--module"));
        if (mod.executor === undefined || mod.grader === undefined) throw new Error("the --module must provide an executor and a grader");
        const maxUsd = Number(need(o, "--max-usd")), perRunUsd = Number(need(o, "--per-run-usd")), planningUsd = Number(need(o, "--planning-usd"));
        if (mod.perRunUsd !== undefined && mod.perRunUsd !== perRunUsd) throw new Error(`--per-run-usd ${String(perRunUsd)} is not the limit the module holds its copies to (${String(mod.perRunUsd)})`);
        if (mod.planningLimitUsd !== undefined && mod.planningLimitUsd !== planningUsd) throw new Error(`--planning-usd ${String(planningUsd)} is not the planning limit the module reserves for (${String(mod.planningLimitUsd)})`);
        if (!Number.isFinite(planningUsd) || planningUsd < 0) throw new Error("--planning-usd must be the project's planning limit in dollars (zero or more)");
        const corrections = correctionsFrom(need(o, "--corrections"));
        mod.setCorrectionTexts?.(new Map(corrections.flatMap((c) => (c.text === undefined ? [] : [[c.id, c.text] as const]))));
        // What building the arms' lessons spent counts in the same limit.
        const dir = opt(o, "--dir");
        const built = dir === undefined || !existsSync(path.join(dir, "learning.json")) ? 0 : (read(path.join(dir, "learning.json")) as ArmLearningCost[]).reduce((sum, c) => sum + (c.usd ?? 0), 0);
        // One invocation at a time on a results file: two would each read the spent total once and together pass the limit.
        const results = need(o, "--results");
        const unlock = lockResults(results);
        let report: Awaited<ReturnType<typeof runReplay>>;
        try {
          report = await runReplay(plan, {
            // Every copy is reserved at its WORST CASE: what planning may spend plus the run limit its approval sets.
            executor: mod.executor, grader: mod.grader, sink: jsonlSink(results), maxUsd, holdPerRunUsd: copyWorstCaseUsd({ planningLimitUsd: planningUsd, runLimitUsd: perRunUsd }), alreadySpentUsd: built,
            priorCorrections: async (task) => corrections.filter((c) => c.member && c.at < task.at && c.taskId !== task.taskId).map((c) => c.id),
          });
        } finally { unlock(); }
        io.out(`ran ${String(report.ran)} runs (${String(report.skipped)} already recorded, ${String(report.ungraded)} ungraded), cost $${report.costUsd.toFixed(2)} (and $${built.toFixed(2)} building the arms' lessons), stopped by: ${report.stoppedBy}`);
        return 0;
      }
      case "blind-sheet": {
        const o = options(rest, ["--final-lessons", "--seed", "--out-sheet", "--out-key"]);
        const finals = read(need(o, "--final-lessons")) as Record<string, Array<{ title: string; body: string }>>;
        const { sheet, key } = blindSheet(Object.entries(finals).flatMap(([arm, lessons]) => lessons.map((l) => ({ arm, title: l.title, body: l.body }))), need(o, "--seed"));
        write(need(o, "--out-sheet"), sheet);
        write(need(o, "--out-key"), key);
        io.out(`wrote a sheet of ${String(sheet.items.length)} lessons for the reviewer, and the key (keep the key from the reviewer)`);
        return 0;
      }
      case "import-marks": {
        const o = options(rest, ["--key", "--marks", "--out"]);
        const marks = importMarks(read(need(o, "--key")) as BlindKey, ((read(need(o, "--marks")) as { marks: Array<{ id: string; useful: boolean | null }> }).marks));
        write(need(o, "--out"), marks);
        io.out(marks.map((m) => `${m.arm}: ${String(m.useful)} useful of ${String(m.marked)} marked`).join("\n"));
        return 0;
      }
      case "report": {
        const o = options(rest, ["--results", "--plan", "--compare", "--dir", "--marks", "--corrections"], ["--json", "--continue-anyway"]);
        const plan = read(need(o, "--plan")) as ReplayPlan;
        const rows = readResults(need(o, "--results"));
        const [b, c] = need(o, "--compare").split(",");
        if (b === undefined || c === undefined) throw new Error("--compare names two arms: B,C");
        const dir = opt(o, "--dir");
        const learning = dir === undefined ? [] : read(path.join(dir, "learning.json")) as ArmLearningCost[];
        const lessonSets = dir === undefined ? [] : read(path.join(dir, "lesson-sets.json")) as ArmLessonSet[];
        const marksFile = opt(o, "--marks");
        let sameMistakeChecks;
        const correctionsFile = opt(o, "--corrections");
        if (correctionsFile !== undefined && dir !== undefined && existsSync(path.join(dir, "final-lessons.json"))) {
          const finals = read(path.join(dir, "final-lessons.json")) as Record<string, unknown[]>;
          const lessons = new Map<string, Lesson[]>(Object.entries(finals).map(([arm, list]) => [arm, list.map((l) => LessonSchema.parse(l))]));
          const first = [...lessons.values()].flat()[0];
          if (first !== undefined) sameMistakeChecks = await repeatMistakeChecks(rows, { key: { workspaceId: first.workspaceId, project: first.project }, tasks: plan.tasks, corrections: sourceOver(correctionsFrom(correctionsFile)), matcher: (budget) => fusedMatcher(budget, undefined), lessonsOf: (arm) => lessons.get(arm) ?? [] });
        }
        const report = buildMeasureReport({
          rows, compare: { b, c }, projectDays: plan.projectDays, learning, lessonSets, learningCalls: plan.learningCalls, ...(o.get("--continue-anyway") === true ? { continueAnyway: true } : {}),
          ...(marksFile === undefined ? {} : { marks: read(marksFile) as ArmUsefulMarks[] }), ...(sameMistakeChecks === undefined ? {} : { sameMistakeChecks }),
        });
        io.out(o.get("--json") === true ? JSON.stringify(report, null, 2) : renderMeasureReport(report));
        return 0;
      }
      default:
        io.err("usage: lessons-replay-measure.ts <select|snapshots|import-snapshots|plan|run|blind-sheet|import-marks|report> [options]; see the header of this file");
        return 2;
    }
  } catch (error) {
    io.err(`${error instanceof ArmNotBuiltError ? "not built: " : "error: "}${error instanceof Error ? error.message : String(error)}`);
    return error instanceof ArmNotBuiltError ? 3 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t) }).then((code) => { process.exitCode = code; }, (error: unknown) => { console.error(String(error)); process.exitCode = 1; });
}
