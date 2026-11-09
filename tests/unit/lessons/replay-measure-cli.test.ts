// Lane 7: the operator script end to end with a fake operator module: select, snapshots, plan, run, blind sheet, marks, report. No AWS, no model.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../scripts/lessons-replay-measure.js";
import { lessonContentKey } from "../../../packages/broker/src/lessons/replay-lessonset.js";
import type { ReplayCandidate } from "../../../packages/broker/src/lessons/replay-select.js";
import { lessonRecord } from "./lesson-helpers.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  return main(argv, { out: (t) => out.push(t), err: (t) => err.push(t) }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

/** An operator module, as plain JavaScript text: pipeline "current" and "consolidated" each build the lesson sets given; the executor loads the pipeline's lessons; the grader solves by arm without seeing it. */
function moduleSource(sets: Record<string, Array<{ title: string; body: string }>>): string {
  const lessons = Object.fromEntries(Object.entries(sets).map(([pipeline, list]) => [pipeline, list.map((l, i) => lessonRecord({ id: `les_${pipeline.slice(0, 4)}${String(i).padStart(4, "0")}`, title: l.title, body: l.body, createdAt: T0 - DAY, updatedAt: T0 - DAY, expiresAt: T0 + 900 * DAY }))]));
  const keys = Object.fromEntries(Object.entries(sets).map(([pipeline, list]) => [pipeline, list.map((l) => lessonContentKey(l))]));
  return `
const lessons = ${JSON.stringify(lessons)};
const keys = ${JSON.stringify(keys)};
export default function make() {
  const builder = (pipeline) => ({ build: async (req) => ({ snapshotId: "snp_" + req.day.replace(/-/g, "").padEnd(20, "0"), lessons: lessons[pipeline], costUsd: 0.25, calls: 3 }) });
  let solved = 0;
  return {
    builders: { current: builder("current"), consolidated: builder("consolidated") },
    executor: { run: async ({ run }) => ({ loaded: run.arm === "off" ? [] : keys[run.arm.slice(3)] ?? [], costUsd: 0.1, evidence: "ev:" + run.key.length, evalRunMarked: run.evalRun === true, learningCalls: 0 }) },
    grader: { identity: { model: "grader-model", version: "v1" }, grade: async () => { solved += 1; return { resolved: solved % 3 !== 0, gradedBy: "hidden_tests", mistakes: [] }; } },
  };
}`;
}

function setupDir(sets: Record<string, Array<{ title: string; body: string }>>) {
  const dir = mkdtempSync(path.join(tmpdir(), "l7-cli-"));
  const f = (name: string): string => path.join(dir, name);
  const candidates: ReplayCandidate[] = Array.from({ length: 70 }, (_, i) => ({ taskId: `t${String(i).padStart(2, "0")}`, project: "proj-1", repository: ["api", "web", "infra"][i % 3]!, at: T0 + Math.floor(i / 2) * DAY, memberCorrections: 1 + (i % 5), outcome: "merged" }));
  writeFileSync(f("candidates.json"), JSON.stringify(candidates));
  writeFileSync(f("module.mjs"), moduleSource(sets));
  writeFileSync(f("corrections.json"), JSON.stringify([{ id: "c1", taskId: "t00", at: T0, kind: "send_back", member: true, text: "use withRetry" }]));
  return { dir, f };
}
const DIFFERENT = { current: [{ title: "Use withRetry", body: "Use withRetry for HTTP retries." }, { title: "Run lint", body: "Run lint before unit tests." }], consolidated: [{ title: "Retries", body: "All HTTP retries go through withRetry." }, { title: "Lint then test", body: "Lint runs before the tests." }] };
const SAME = { current: DIFFERENT.current, consolidated: DIFFERENT.current };

async function pipeline(sets: typeof DIFFERENT) {
  const { dir, f } = setupDir(sets);
  const arms = "off,on:current,on:consolidated";
  expect((await run(["select", "--candidates", f("candidates.json"), "--seed", "s1", "--target", "40", "--out", f("selection.json")])).code).toBe(0);
  expect((await run(["snapshots", "--selection", f("selection.json"), "--arms", arms, "--module", f("module.mjs"), "--out-dir", f("out")])).code).toBe(0);
  expect((await run(["plan", "--selection", f("selection.json"), "--arms", arms, "--seed", "s1", "--grader-model", "grader-model", "--grader-version", "v1", "--snapshots", f("out/snapshots.json"), "--out", f("plan.json")])).code).toBe(0);
  const ran = await run(["run", "--plan", f("plan.json"), "--module", f("module.mjs"), "--corrections", f("corrections.json"), "--results", f("results.jsonl")]);
  expect(ran.code).toBe(0);
  return { dir, f, ran };
}

describe("the operator script", () => {
  it("select, snapshots, plan and run produce 3 runs per task per arm, resumable", async () => {
    const { f, ran } = await pipeline(DIFFERENT);
    expect(ran.out).toMatch(/ran 360 runs/);
    expect(readFileSync(f("results.jsonl"), "utf8").trim().split("\n")).toHaveLength(360);
    const again = await run(["run", "--plan", f("plan.json"), "--module", f("module.mjs"), "--corrections", f("corrections.json"), "--results", f("results.jsonl")]);
    expect(again.out).toMatch(/ran 0 runs \(360 already recorded/);
  });

  it("the report starts with the loaded-lesson difference, then the numbers, and gives no verdict", async () => {
    const { f } = await pipeline(DIFFERENT);
    const common = ["--results", f("results.jsonl"), "--plan", f("plan.json"), "--compare", "on:current,on:consolidated", "--dir", f("out"), "--corrections", f("corrections.json")];
    const text = await run(["report", ...common]);
    expect(text.code).toBe(0);
    expect(text.out.indexOf("Did on:current and on:consolidated load different lessons")).toBeLessThan(text.out.indexOf("Pass rate"));
    expect(text.out).toMatch(/95% interval/);
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
    lines[5]!.row.grader = { model: "someone-else" };
    (lines[5]!.row.grader as { version?: string }).version = "v9";
    writeFileSync(f("results.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const report = await run(["report", "--results", f("results.jsonl"), "--plan", f("plan.json"), "--compare", "on:current,on:consolidated", "--dir", f("out")]);
    expect(report.code).toBe(1);
    expect(report.err).toMatch(/different graders/);
  });

  it("a file arm refuses to run until its adapter is built", async () => {
    const { f } = await pipeline(DIFFERENT);
    const arms = "off,on:current,file:current";
    expect((await run(["plan", "--selection", f("selection.json"), "--arms", arms, "--seed", "s1", "--grader-model", "grader-model", "--grader-version", "v1", "--snapshots", f("out/snapshots.json"), "--out", f("plan2.json")])).code).toBe(0);
    const ran = await run(["run", "--plan", f("plan2.json"), "--module", f("module.mjs"), "--corrections", f("corrections.json"), "--results", f("results2.jsonl")]);
    expect(ran.code).toBe(3);
    expect(ran.err).toMatch(/not built/);
  });

  it("bad usage is refused with a message, not a crash", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["select", "--nope", "x"])).code).toBe(1);
    expect((await run(["select", "--seed"])).code).toBe(1);
  });
});
