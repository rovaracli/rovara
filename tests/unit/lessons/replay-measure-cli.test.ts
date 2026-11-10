// Lane 7: the operator script end to end with a fake operator module: select, snapshots, import, plan, run, blind sheet, marks, report. No AWS, no model.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../scripts/lessons-replay-measure.js";
import { lessonContentKey } from "../../../packages/broker/src/lessons/replay-lessonset.js";
import type { ReplayCandidate } from "../../../packages/broker/src/lessons/replay-select.js";
import { WS, lessonRecord } from "./lesson-helpers.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  return main(argv, { out: (t) => out.push(t), err: (t) => err.push(t) }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

/** An operator module, as plain JavaScript text: the pipelines "current" and "consolidated" build the lesson sets given; the executor loads the pipeline's lessons; the grader solves by count without seeing the arm. */
function moduleSource(sets: Record<string, Array<{ title: string; body: string }>>, perRunUsd = 0.5): string {
  const lessons = Object.fromEntries(Object.entries(sets).map(([pipeline, list]) => [pipeline, list.map((l, i) => lessonRecord({ id: `les_${(pipeline === "current" ? "a" : "b").repeat(18)}${String(i).padStart(2, "0")}`, workspaceId: WS, project: "proj-1", title: l.title, body: l.body, createdAt: T0 - DAY, updatedAt: T0 - DAY, expiresAt: T0 + 900 * DAY, scope: {} }))]));
  const keys = Object.fromEntries(Object.entries(sets).map(([pipeline, list]) => [pipeline, list.map((l) => lessonContentKey(l))]));
  return `
const lessons = ${JSON.stringify(lessons)};
const keys = ${JSON.stringify(keys)};
export default function make() {
  const builder = (pipeline) => ({ build: async () => ({ snapshotId: "ignored", lessons: lessons[pipeline], costUsd: 0.25, calls: 3 }) });
  let solved = 0;
  const ids = process.env.L7_IDS ? JSON.parse(process.env.L7_IDS) : {};
  return {
    perRunUsd: ${String(perRunUsd)},
    builders: { current: builder("current"), consolidated: builder("consolidated") },
    importSnapshot: (pipeline, day) => (process.env.L7_WRONG ? "snp_" + "0".repeat(20) : ids[pipeline][day]),
    executor: { run: async ({ run }) => ({ loaded: run.arm === "off" ? [] : keys[run.arm.replace(/^[a-z]+:/, "")] ?? [], costUsd: 0.1, evidence: "ev:" + run.key.length, evalRunMarked: run.evalRun === true, learningCalls: 0 }) },
    grader: { identity: { model: "grader-model", version: "v1" }, grade: async () => { solved += 1; return { resolved: solved % 3 !== 0, gradedBy: "hidden_tests", mistakes: [], costUsd: 0.02 }; } },
  };
}`;
}

function setupDir(sets: Record<string, Array<{ title: string; body: string }>>, perRunUsd?: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "l7-cli-"));
  const f = (name: string): string => path.join(dir, name);
  const candidates: ReplayCandidate[] = Array.from({ length: 70 }, (_, i) => ({ taskId: `t${String(i).padStart(2, "0")}`, project: "proj-1", repository: ["api", "web", "infra"][i % 3]!, at: T0 + Math.floor(i / 2) * DAY, memberCorrections: 1 + (i % 5), outcome: "merged" }));
  writeFileSync(f("candidates.json"), JSON.stringify(candidates));
  writeFileSync(f("module.mjs"), moduleSource(sets, perRunUsd));
  writeFileSync(f("corrections.json"), JSON.stringify([{ id: "c1", taskId: "t00", at: T0, kind: "send_back", member: true, text: "use withRetry" }]));
  return { dir, f };
}
const DIFFERENT = { current: [{ title: "Use withRetry", body: "Use withRetry for HTTP retries." }, { title: "Run lint", body: "Run lint before unit tests." }], consolidated: [{ title: "Retries", body: "All HTTP retries go through withRetry." }, { title: "Lint then test", body: "Lint runs before the tests." }] };
const SAME = { current: DIFFERENT.current, consolidated: DIFFERENT.current };

async function pipeline(sets: typeof DIFFERENT) {
  const { dir, f } = setupDir(sets);
  const arms = "off,on:current,on:consolidated";
  expect((await run(["select", "--candidates", f("candidates.json"), "--seed", "s1", "--target", "40", "--out", f("selection.json")])).code).toBe(0);
  const built = await run(["snapshots", "--selection", f("selection.json"), "--arms", arms, "--module", f("module.mjs"), "--workspace", WS, "--out-dir", f("out"), "--max-usd", "100"]);
  expect(built.code, built.err).toBe(0);
  const ids = JSON.parse(readFileSync(f("out/snapshots.json"), "utf8")) as Record<string, Record<string, string>>;
  process.env["L7_IDS"] = JSON.stringify(ids);
  expect((await run(["import-snapshots", "--dir", f("out"), "--module", f("module.mjs")])).code).toBe(0);
  expect((await run(["plan", "--selection", f("selection.json"), "--arms", arms, "--seed", "s1", "--grader-model", "grader-model", "--grader-version", "v1", "--snapshots", f("out/snapshots.json"), "--out", f("plan.json")])).code).toBe(0);
  const ran = await run(["run", "--plan", f("plan.json"), "--module", f("module.mjs"), "--corrections", f("corrections.json"), "--results", f("results.jsonl"), "--max-usd", "1000", "--per-run-usd", "0.5", "--dir", f("out")]);
  expect(ran.code, ran.err).toBe(0);
  return { dir, f, ran };
}

describe("the operator script", () => {
  it("select, snapshots, import, plan and run produce 3 runs per task per arm, resumable, and the limit counts what building the arms' lessons spent", async () => {
    const { f, ran } = await pipeline(DIFFERENT);
    expect(ran.out).toMatch(/ran 360 runs/);
    expect(ran.out).toMatch(/and \$[0-9.]+ building the arms' lessons/);
    expect(readFileSync(f("results.jsonl"), "utf8").trim().split("\n")).toHaveLength(360);
    const again = await run(["run", "--plan", f("plan.json"), "--module", f("module.mjs"), "--corrections", f("corrections.json"), "--results", f("results.jsonl"), "--max-usd", "1000", "--per-run-usd", "0.5", "--dir", f("out")]);
    expect(again.out).toMatch(/ran 0 runs \(360 already recorded/);
  });

  it("the report starts with the loaded-lesson difference, then the numbers, and gives no verdict", async () => {
    const { f } = await pipeline(DIFFERENT);
    const common = ["--results", f("results.jsonl"), "--plan", f("plan.json"), "--compare", "on:current,on:consolidated", "--dir", f("out"), "--corrections", f("corrections.json")];
    const text = await run(["report", ...common]);
    expect(text.code).toBe(0);
    expect(text.out.indexOf("Did on:current and on:consolidated load different lessons")).toBeLessThan(text.out.indexOf("Pass rate"));
    expect(text.out).toMatch(/95% interval/);
    expect(text.out).toMatch(/by task/);
    expect(text.out).toMatch(/per project-day/);
    expect(text.out).toMatch(/replays made 0 learning calls/);
    expect(text.out).not.toMatch(/verdict|winner|recommend/i);
    const json = JSON.parse((await run(["report", ...common, "--json"])).out) as { stopped: boolean; results: { arms: unknown[]; pairs: number } };
    expect(json.stopped).toBe(false);
    expect(json.results.pairs).toBe(120);
    expect(json.results.arms).toHaveLength(3);
  });

  it("when the two pipelines built the same lessons the report stops with the STOP line and nothing else, unless asked to continue", async () => {
    const { f } = await pipeline(SAME);
    const common = ["report", "--results", f("results.jsonl"), "--plan", f("plan.json"), "--compare", "on:current,on:consolidated", "--dir", f("out")];
    const stopped = await run(common);
    expect(stopped.out).toMatch(/STOP/);
    expect(stopped.out).not.toMatch(/Pass rate/);
    const forced = await run([...common, "--continue-anyway"]);
    expect(forced.out.indexOf("STOP")).toBeLessThan(forced.out.indexOf("Pass rate"));
  });

  it("a blind sheet hides the arms, and marks come back per arm in the report", async () => {
    const { f } = await pipeline(DIFFERENT);
    const final = JSON.parse(readFileSync(f("out/final-lessons.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(final).sort()).toEqual(["on:consolidated", "on:current"]);
    expect((await run(["blind-sheet", "--final-lessons", f("out/final-lessons.json"), "--seed", "r1", "--out-sheet", f("sheet.json"), "--out-key", f("key.json")])).code).toBe(0);
    const sheet = JSON.parse(readFileSync(f("sheet.json"), "utf8")) as { items: Array<{ id: string }> };
    expect(JSON.stringify(sheet)).not.toMatch(/current|consolidated|on:/);
    expect(sheet.items).toHaveLength(4);
    writeFileSync(f("marks.json"), JSON.stringify({ marks: sheet.items.map((item, i) => ({ id: item.id, useful: i % 2 === 0 })) }));
    expect((await run(["import-marks", "--key", f("key.json"), "--marks", f("marks.json"), "--out", f("marks-by-arm.json")])).code).toBe(0);
    const report = await run(["report", "--results", f("results.jsonl"), "--plan", f("plan.json"), "--compare", "on:current,on:consolidated", "--dir", f("out"), "--marks", f("marks-by-arm.json")]);
    expect(report.out).toMatch(/useful of 2 marked/);
  });

  it("refuses a results file graded by a second grader", async () => {
    const { f } = await pipeline(DIFFERENT);
    const lines = readFileSync(f("results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { key: string; row: { grader: { model: string } | null } });
    lines[5]!.row.grader = { model: "someone-else" } as never;
    (lines[5]!.row.grader as { version?: string }).version = "v9";
    writeFileSync(f("results.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const report = await run(["report", "--results", f("results.jsonl"), "--plan", f("plan.json"), "--compare", "on:current,on:consolidated", "--dir", f("out")]);
    expect(report.code).toBe(1);
    expect(report.err).toMatch(/different graders/);
  });

  it("the MCP arm refuses to run (code 3); the file arm is planned and runs", async () => {
    const { f } = await pipeline(DIFFERENT);
    const plan = async (arms: string, out: string) => run(["plan", "--selection", f("selection.json"), "--arms", arms, "--seed", "s1", "--grader-model", "grader-model", "--grader-version", "v1", "--snapshots", f("out/snapshots.json"), "--out", f(out)]);
    const runArgs = (planFile: string, results: string) => ["run", "--plan", f(planFile), "--module", f("module.mjs"), "--corrections", f("corrections.json"), "--results", f(results), "--max-usd", "1000", "--per-run-usd", "0.5"];
    expect((await plan("off,on:current,mcp:current", "plan-mcp.json")).code).toBe(0);
    const refused = await run(runArgs("plan-mcp.json", "results-mcp.jsonl"));
    expect(refused.code).toBe(3);
    expect(refused.err).toMatch(/not built/);
    expect((await plan("off,file:current", "plan-file.json")).code).toBe(0);
    const ok = await run(runArgs("plan-file.json", "results-file.jsonl"));
    expect(ok.code, ok.err).toBe(0);
    const rows = readFileSync(f("results-file.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { row: { arm: string } });
    expect(rows.some((r) => r.row.arm === "file:current")).toBe(true);
  });

  it("the run step needs --max-usd and --per-run-usd, stops at the limit counting grading, and refuses a per-run limit the module does not hold", async () => {
    const { f } = await pipeline(DIFFERENT);
    const base = ["run", "--plan", f("plan.json"), "--module", f("module.mjs"), "--corrections", f("corrections.json"), "--results", f("results-capped.jsonl")];
    expect((await run(base)).err).toMatch(/--max-usd is required/);
    expect((await run([...base, "--max-usd", "5"])).err).toMatch(/--per-run-usd is required/);
    const wrong = await run([...base, "--max-usd", "5", "--per-run-usd", "0.9"]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/not the limit the module holds/);
    const capped = await run([...base, "--max-usd", "1.6", "--per-run-usd", "0.5"]);
    expect(capped.out).toMatch(/stopped by: max_usd/);
    // Each run is 0.1 + 0.02 of spend and a run starts only if the limit has room for its hold (0.5): 10 runs, then the 11th cannot start (1.2 + 0.5 > 1.6).
    expect(readFileSync(f("results-capped.jsonl"), "utf8").trim().split("\n")).toHaveLength(10);
    // With the arms' lessons counted (the module's builders spent $10), the same limit leaves room for nothing.
    const withBuild = await run(["run", "--plan", f("plan.json"), "--module", f("module.mjs"), "--corrections", f("corrections.json"), "--results", f("results-built.jsonl"), "--max-usd", "1.6", "--per-run-usd", "0.5", "--dir", f("out")]);
    expect(withBuild.out).toMatch(/ran 0 runs/);
    expect(withBuild.out).toMatch(/stopped by: max_usd/);
  });

  it("an import whose id is not the planned one stops the replay before it runs on something else", async () => {
    const { f } = await pipeline(DIFFERENT);
    process.env["L7_WRONG"] = "1";
    try {
      const refused = await run(["import-snapshots", "--dir", f("out"), "--module", f("module.mjs")]);
      expect(refused.code).toBe(1);
      expect(refused.err).toMatch(/not the planned/);
    } finally { delete process.env["L7_WRONG"]; }
  });

  it("bad usage is refused with a message, not a crash", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["select", "--nope", "x"])).code).toBe(1);
    expect((await run(["select", "--seed"])).code).toBe(1);
  });
});
