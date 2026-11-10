// Lane 7: the executor, the grader's model and evidence, and the importer over the `agentx` CLI. A fake CLI answers in the CLI's `--json` envelope; nothing runs, no network.
import { describe, expect, it } from "vitest";
import { cliEvidenceReader, cliGraderModel, cliPipelineModel, cliReplayPort, cliSubjectOf, importSnapshot, uuidOf, type CliResult } from "../../../scripts/lessons-replay-port.js";
import { stagingExecutor } from "../../../packages/broker/src/lessons/replay-executor.js";
import { ReplayRunFailed } from "../../../packages/broker/src/lessons/replay-harness.js";
import { lessonRecord } from "./lesson-helpers.js";

const ok = (data: unknown): CliResult => ({ status: 0, stdout: JSON.stringify({ ok: true, data }), stderr: "" });
const refused = (message: string): CliResult => ({ status: 1, stdout: JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message } }), stderr: "" });
const COPY = "22222222-2222-4222-8222-222222222222";
const SNAP = `snp_${"a".repeat(20)}`;
const view = (over: Record<string, unknown> = {}) => ({ taskId: COPY, workspaceId: "ws-1", evalRun: true, state: "completed", costUsd: 0.4, learningCalls: null, loadedKeys: ["k1"], ...over });

function fake(over: { startAnswer?: CliResult; views?: unknown[] } = {}) {
  const calls: string[][] = [];
  const views = [...(over.views ?? [view()])];
  let clock = 0;
  const options = {
    env: "stg", now: () => clock, sleep: async (ms: number) => { clock += ms; }, pollSeconds: 1, timeoutMinutes: 1,
    cli: (args: readonly string[]): CliResult => {
      calls.push([...args]);
      if (args[0] === "admin" && args[1] === "task" && args[3] === "start") return over.startAnswer ?? ok({ replay: { taskId: COPY, evalRun: true, memory: "off" } });
      if (args[3] === "show") return ok({ replay: views.length > 1 ? views.shift() : views[0] });
      return ok({});
    },
  };
  return { port: cliReplayPort(options), options, calls };
}

describe("the CLI port", () => {
  it("starts a copy with the run's own limit and memory, the same request id for the same run, and the file flag for the file arm", async () => {
    const w = fake();
    expect(await w.port.start({ sourceTaskId: "past-1", runKey: "run-1", evalRun: true, maxUsd: 2.5, memory: { mode: "snapshot", snapshotId: SNAP }, file: true })).toEqual({ taskId: COPY });
    expect(w.calls[0]).toEqual(expect.arrayContaining(["--task", "past-1", "--max-usd", "2.5", "--memory", `snapshot:${SNAP}`, "--request-id", uuidOf("run-1"), "--file"]));
    expect(uuidOf("run-1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    const off = fake();
    await off.port.start({ sourceTaskId: "past-1", runKey: "run-1", evalRun: true, maxUsd: 1, memory: { mode: "off" } });
    expect(off.calls[0]).toEqual(expect.arrayContaining(["--memory", "off"]));
    expect(off.calls[0]).not.toContain("--file");
  });
  it("a refused start is an error that says why, never a task id", async () => {
    const w = fake({ startAnswer: refused("a company owner or admin is required to replay tasks") });
    await expect(w.port.start({ sourceTaskId: "past-1", runKey: "run-1", evalRun: true, maxUsd: 1 })).rejects.toThrow(/company owner or admin/);
  });
  it("approves a plan that waits, and only then; ends when the copy completes, with the cost the install read", async () => {
    const w = fake({ views: [view({ state: "running", costUsd: null }), view({ state: "awaiting_plan", costUsd: 0.1 }), view({ state: "running", costUsd: 0.2 }), view({ state: "completed", costUsd: 0.4 })] });
    expect(await w.port.readMark(COPY)).toBe(true);
    expect(await w.port.waitForEnd(COPY, { maxUsd: 2 })).toEqual({ state: "completed", evidence: COPY, costUsd: 0.4 });
    expect(w.calls.filter((c) => c[3] === "approve")).toHaveLength(1);
    expect(await w.port.loadedKeys(COPY)).toEqual(["k1"]);
    expect(await w.port.learningCalls(COPY)).toBe(0);
    await w.port.close(COPY);
    expect(w.calls.at(-1)).toEqual(["admin", "task", "lessons-replay", "close", "--task", COPY]);
  });
  it("cancels a copy whose cost reaches the run's limit, or that does not finish in time, and says what it cost", async () => {
    const dear = fake({ views: [view({ state: "running", costUsd: 2.1 })] });
    await dear.port.readMark(COPY);
    expect(await dear.port.waitForEnd(COPY, { maxUsd: 2 })).toEqual({ state: "failed", evidence: COPY, costUsd: 2.1 });
    expect(dear.calls.some((c) => c[0] === "admin" && c[1] === "cancel" && c[3] === "ws-1")).toBe(true);
    const slow = fake({ views: [view({ state: "running", costUsd: 0.3 })] });
    await slow.port.readMark(COPY);
    expect(await slow.port.waitForEnd(COPY, { maxUsd: 2 })).toEqual({ state: "failed", evidence: COPY, costUsd: 0.3 });
    expect(slow.calls.some((c) => c[1] === "cancel")).toBe(true);
    expect(await slow.port.costOf(COPY)).toBe(0.3);
  });
  it("a failed copy ends the wait at once; a copy that cannot be read counts as one that made a learning call, so the replay stops", async () => {
    const failed = fake({ views: [view({ state: "failed", costUsd: 0.9 })] });
    expect(await failed.port.waitForEnd(COPY, { maxUsd: 2 })).toMatchObject({ state: "failed", costUsd: 0.9 });
    const unreadable = fake({ views: [undefined] });
    unreadable.options.cli = () => refused("down");
    expect(await cliReplayPort(unreadable.options).learningCalls(COPY)).toBe(1);
  });
  it("with the executor: an install that does not show the mark gets the copy cancelled and the replay stopped; a copy that fails is a failed run with its cost", async () => {
    const w = fake({ views: [{ taskId: COPY, workspaceId: "ws-1", state: "running" }] });
    const executor = stagingExecutor(w.port, { maxUsdPerRun: 2 });
    const run = { key: "r1", task: "t", repeat: 1, arm: "off", day: "2026-09-01", memory: { mode: "off" as const }, evalRun: true as const };
    await expect(executor.run({ run, task: { taskId: "t" } as never, learning: { lessonsSwitch: "off", calls: "none" } })).rejects.toThrow(/not marked/);
    expect(w.calls.some((c) => c[1] === "cancel")).toBe(true);
    const failing = fake({ views: [view({ state: "failed", costUsd: 1.7 })] });
    const failure = await stagingExecutor(failing.port, { maxUsdPerRun: 2 }).run({ run, task: { taskId: "t" } as never, learning: { lessonsSwitch: "off", calls: "none" } }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ReplayRunFailed);
    expect((failure as ReplayRunFailed).costUsd).toBe(1.7);
    expect(failing.calls.some((c) => c[1] === "cancel")).toBe(true);
    expect(failing.calls.some((c) => c[3] === "close")).toBe(true);
  });
});

describe("the grader's model, the evidence, the importer and the offline pipeline's calls", () => {
  it("a grading is one call on the company's model path with the label and the hold; its reply carries the cost", async () => {
    const seen: string[][] = [];
    const options = { env: "stg", now: () => 0, sleep: async () => undefined, cli: (args: readonly string[]) => { seen.push([...args]); return ok({ text: "{\"resolved\":true,\"mistakes\":[]}", costUsd: 0.03 }); } };
    const model = cliGraderModel(options, { project: "payments", model: "grader", version: "1", holdUsd: 0.2 });
    expect(await model.complete({ system: "s", user: "u" })).toEqual({ text: "{\"resolved\":true,\"mistakes\":[]}", costUsd: 0.03 });
    expect(seen[0]).toEqual(expect.arrayContaining(["admin", "lessons-replay", "model", "--project", "payments"]));
    expect(model.holdUsd).toBe(0.2);
    const refusing = cliGraderModel({ ...options, cli: () => refused("month full") }, { project: "payments", model: "g", version: "1", holdUsd: 0.2 });
    await expect(refusing.complete({ system: "s", user: "u" })).rejects.toThrow(/refused: month full/);
  });
  it("the offline pipeline's model counts the reply's cost; the evidence reader needs the request", async () => {
    const options = { env: "stg", now: () => 0, sleep: async () => undefined, cli: (args: readonly string[]): CliResult => (args[2] === "model" ? ok({ text: "x", costUsd: 0.05 }) : args[3] === "evidence" ? ok({ evidence: { request: "Fix it", attempt: "diff a", reference: "diff b" } }) : refused("no")) };
    const pipeline = cliPipelineModel(options, { project: "payments", holdUsd: 0.3 });
    expect(await pipeline.complete({ purpose: "reflect", system: "s", user: "u", maxOutputTokens: 100, workspaceId: "w" })).toMatchObject({ text: "x", costUsd: 0.05 });
    expect(await pipeline.quote!({ purpose: "reflect", system: "s", user: "u", maxOutputTokens: 1, workspaceId: "w" })).toEqual({ ok: true, usd: 0.3 });
    expect(await cliEvidenceReader(options).read(COPY)).toEqual({ request: "Fix it", attempt: "diff a", reference: "diff b" });
    await expect(cliEvidenceReader({ ...options, cli: () => refused("no") }).read(COPY)).rejects.toThrow(/could not be read/);
  });
  it("imports a snapshot and returns the id the install derived; a subject is read, or is none", async () => {
    const options = { env: "stg", now: () => 0, sleep: async () => undefined, cli: (args: readonly string[]): CliResult => (args[2] === "import-snapshot" ? ok({ snapshot: { snapshotId: SNAP, lessons: 1 } }) : args[2] === "subject" ? ok({ subject: { id: "t1" } }) : refused("no")) };
    expect(importSnapshot(options, { project: "payments", pipeline: "current", day: "2026-09-01", lessons: [lessonRecord()] })).toBe(SNAP);
    expect(() => importSnapshot({ ...options, cli: () => refused("not valid") }, { project: "payments", pipeline: "current", day: "2026-09-01", lessons: [] })).toThrow(/not imported: not valid/);
    expect(await cliSubjectOf(options, "payments")("t1")).toEqual({ id: "t1" });
    expect(await cliSubjectOf({ ...options, cli: () => refused("no") }, "payments")("t1")).toBeUndefined();
  });
});
