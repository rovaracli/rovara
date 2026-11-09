// Lessons replay A/B (lane 7, 0.5.12, DECISIONS 38/47/49/50.5): the operator's tool. It makes NO AWS call and no model call itself. Everything that touches staging (running a replayed task, a lesson pipeline, the
// grader) is an operator MODULE you pass with --module; this script plans, orders, records and reports. The report states numbers and gives no verdict: the owner decides. See docs/runbooks/lessons-replay-measure.md.
//
//   npx tsx scripts/lessons-replay-measure.ts select      --candidates <file> --seed <text> [--target 50] [--per-repo-max 15] --out <selection.json>
//   npx tsx scripts/lessons-replay-measure.ts snapshots   --selection <file> --arms off,on:current,on:consolidated --module <file> --out-dir <dir>
//   npx tsx scripts/lessons-replay-measure.ts plan        --selection <file> --arms <list> --seed <text> --grader-model <m> --grader-version <v> --snapshots <dir>/snapshots.json --out <plan.json> [--small]
//   npx tsx scripts/lessons-replay-measure.ts run         --plan <file> --module <file> --corrections <file> --results <results.jsonl> --max-usd <usd> [--snapshot-lessons <dir>/snapshot-lessons.json]
//   npx tsx scripts/lessons-replay-measure.ts blind-sheet --final-lessons <dir>/final-lessons.json --seed <text> --out-sheet <sheet.json> --out-key <key.json>
//   npx tsx scripts/lessons-replay-measure.ts import-marks --key <key.json> --marks <marks.json> --out <marks-by-arm.json>
//   npx tsx scripts/lessons-replay-measure.ts report      --results <results.jsonl> --plan <plan.json> --compare on:current,on:consolidated [--dir <dir of snapshots outputs>] [--marks <marks-by-arm.json>] [--corrections <file>] [--json] [--continue-anyway]
//
// The operator module (--module) is an ES module whose default export is a function returning { builders?: Record<pipeline, SnapshotBuilder>, executor?: ReplayExecutor, grader?: ReplayGraderPort, deliveries?: ... }
// (the types are in packages/broker/src/lessons/replay-harness.ts). File and MCP deliveries are stubs until their lanes land.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { blindSheet, buildMeasureReport, importMarks, readReplayRunRows, renderMeasureReport, type ArmLessonSet, type ArmLearningCost, type ArmUsefulMarks, type BlindKey, type ReplayRunRow } from "@agentx/contracts";
import { fusedMatcher } from "../packages/broker/src/lessons/metric-source.js";
import type { CorrectionRecord, CorrectionSource } from "../packages/broker/src/lessons/metric.js";
import { FILE_DELIVERY } from "../packages/broker/src/lessons/replay-delivery.js";
import { ArmNotBuiltError, buildReplayPlan, buildSnapshots, runReplay, type ReplayExecutor, type ReplayGraderPort, type ReplayPlan, type RunSink, type SnapshotBuilder, type LessonDelivery } from "../packages/broker/src/lessons/replay-harness.js";
import { repeatMistakeChecks } from "../packages/broker/src/lessons/replay-mistakes.js";
import { selectReplayTasks, type ReplayCandidate } from "../packages/broker/src/lessons/replay-select.js";
import { LessonSchema, type Lesson } from "../packages/broker/src/lessons/types.js";

export interface Io { out(text: string): void; err(text: string): void }
export interface OperatorModule { builders?: Record<string, SnapshotBuilder>; executor?: ReplayExecutor; grader?: ReplayGraderPort; deliveries?: Partial<Record<"file" | "mcp", LessonDelivery>> }

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
function jsonlSink(file: string): RunSink {
  const done = new Set<string>();
  if (existsSync(file)) for (const line of readFileSync(file, "utf8").split("\n")) if (line.trim() !== "") done.add((JSON.parse(line) as { key: string }).key);
  return { done: () => done, append: async (key, row) => { appendFileSync(file, `${JSON.stringify({ key, row })}\n`); done.add(key); } };
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
        const o = options(rest, ["--selection", "--arms", "--module", "--out-dir", "--max-usd"]);
        const tasks = (read(need(o, "--selection")) as { tasks: ReplayCandidate[] }).tasks;
        const mod = await loadModule(need(o, "--module"));
        const built = await buildSnapshots({ tasks, arms: need(o, "--arms").split(","), builders: mod.builders ?? {}, ...(opt(o, "--max-usd") === undefined ? {} : { maxUsd: Number(opt(o, "--max-usd")) }) });
        const dir = need(o, "--out-dir");
        write(path.join(dir, "snapshots.json"), built.snapshots);
        write(path.join(dir, "learning.json"), built.learning);
        write(path.join(dir, "lesson-sets.json"), built.lessonSets);
        write(path.join(dir, "snapshot-lessons.json"), built.lessonsByDay);
        write(path.join(dir, "final-lessons.json"), Object.fromEntries(Object.entries(built.finalLessons).map(([pipeline, lessons]) => [`on:${pipeline}`, lessons])));
        io.out(`built snapshots for ${String(Object.keys(built.snapshots).length)} pipelines; learning cost ${built.learning.map((c) => `${c.arm} $${(c.usd ?? 0).toFixed(2)}`).join(", ")}`);
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
        const o = options(rest, ["--plan", "--module", "--corrections", "--results", "--max-usd", "--snapshot-lessons"]);
        const plan = read(need(o, "--plan")) as ReplayPlan;
        const mod = await loadModule(need(o, "--module"));
        if (mod.executor === undefined || mod.grader === undefined) throw new Error("the --module must provide an executor and a grader (the staging executor is an operator step)");
        const corrections = correctionsFrom(need(o, "--corrections"));
        const maxUsd = Number(need(o, "--max-usd"));
        const lessonsFile = opt(o, "--snapshot-lessons");
        const snapshotLessons = lessonsFile === undefined ? undefined : read(lessonsFile) as Record<string, Record<string, unknown[]>>;
        const report = await runReplay(plan, {
          executor: mod.executor, grader: mod.grader, sink: jsonlSink(need(o, "--results")), deliveries: { file: FILE_DELIVERY, ...mod.deliveries },
          ...(snapshotLessons === undefined ? {} : { snapshotLessons: async (pipeline: string, day: string) => (snapshotLessons[pipeline]?.[day] ?? []).map((l) => LessonSchema.parse(l)) }),
          priorCorrections: async (task) => corrections.filter((c) => c.member && c.at < task.at && c.taskId !== task.taskId).map((c) => c.id), maxUsd,
        });
        io.out(`ran ${String(report.ran)} runs (${String(report.skipped)} already recorded, ${String(report.ungraded)} ungraded), cost $${report.costUsd.toFixed(2)}, stopped by: ${report.stoppedBy}`);
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
        io.err("usage: lessons-replay-measure.ts <select|snapshots|plan|run|blind-sheet|import-marks|report> [options]; see the header of this file");
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
