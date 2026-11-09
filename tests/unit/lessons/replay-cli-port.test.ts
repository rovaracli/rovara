// Lane 7: the executor port over the `agentx` CLI. A fake CLI answers in the CLI's `--json` envelope; nothing runs, no network.
import { describe, expect, it } from "vitest";
import { cliReplayPort, uuidOf, type CliResult } from "../../../scripts/lessons-replay-port.js";
import { stagingExecutor } from "../../../packages/broker/src/lessons/replay-executor.js";

const ok = (data: unknown): CliResult => ({ status: 0, stdout: JSON.stringify({ ok: true, data }), stderr: "" });
const COPY = "22222222-2222-4222-8222-222222222222";
const SNAP = `snp_${"a".repeat(20)}`;

function fake(over: { startAnswer?: CliResult; views?: unknown[] } = {}) {
  const calls: string[][] = [];
  const files: string[] = [];
  const views = [...(over.views ?? [{ taskId: COPY, workspaceId: "ws-1", evalRun: true, state: "completed", costUsd: 0.4, learningCalls: 0, loadedKeys: ["k1"] }])];
  let clock = 0;
  const port = cliReplayPort({
    env: "stg", now: () => clock, sleep: async (ms) => { clock += ms; }, pollSeconds: 1, timeoutMinutes: 1,
    cli: (args) => {
      calls.push([...args]);
      if (args[3] === "start") { const at = args.indexOf("--lessons"); if (at >= 0) files.push(args[at + 1]!); return over.startAnswer ?? ok({ replay: { taskId: COPY, evalRun: true, memory: args[args.indexOf("--memory") + 1] === "off" ? "off" : "snapshot" } }); }
      if (args[3] === "show") return ok({ replay: views.length > 1 ? views.shift() : views[0] });
      return ok({});
    },
  });
  return { port, calls, files };
}

describe("the CLI port", () => {
  it("starts a copy with the run's own limit and memory, the same request id for the same run, and a snapshot's lessons in a file", async () => {
    const w = fake();
    const started = await w.port.start({ sourceTaskId: "past-1", runKey: "run-1", evalRun: true, maxUsd: 2.5, memory: { mode: "snapshot", snapshotId: SNAP, lessons: [{ id: "les_aaaaaaaaaaaaaaaaaa01", version: 1 }] } });
    expect(started).toEqual({ taskId: COPY });
    const args = w.calls[0]!;
    expect(args.slice(0, 4)).toEqual(["admin", "task", "lessons-replay", "start"]);
    expect(args).toEqual(expect.arrayContaining(["--task", "past-1", "--max-usd", "2.5", "--memory", `snapshot:${SNAP}`, "--request-id", uuidOf("run-1")]));
    expect(uuidOf("run-1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidOf("run-1")).toBe(uuidOf("run-1"));
    expect(uuidOf("run-2")).not.toBe(uuidOf("run-1"));
    expect(w.files).toHaveLength(1);
    const off = fake();
    await off.port.start({ sourceTaskId: "past-1", runKey: "run-1", evalRun: true, maxUsd: 1, memory: { mode: "off" } });
    expect(off.calls[0]).toEqual(expect.arrayContaining(["--memory", "off"]));
    expect(off.calls[0]).not.toContain("--lessons");
  });
  it("a refused start is an error that says why, never a task id", async () => {
    const w = fake({ startAnswer: { status: 1, stdout: JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "administrator project membership is required" } }), stderr: "" } });
    await expect(w.port.start({ sourceTaskId: "past-1", runKey: "run-1", evalRun: true, maxUsd: 1 })).rejects.toThrow(/administrator project membership/);
  });
  it("reads the mark as the install stored it, waits for the end, reads what it loaded and that it made no learning call", async () => {
    const w = fake({ views: [{ taskId: COPY, workspaceId: "ws-1", evalRun: true, state: "running", costUsd: null, learningCalls: 0, loadedKeys: [] }, { taskId: COPY, workspaceId: "ws-1", evalRun: true, state: "completed", costUsd: 0.4, learningCalls: 0, loadedKeys: ["k1"] }] });
    expect(await w.port.readMark(COPY)).toBe(true);
    expect(await w.port.waitForEnd(COPY)).toEqual({ state: "completed", evidence: COPY, costUsd: 0.4 });
    expect(await w.port.loadedKeys(COPY)).toEqual(["k1"]);
    expect(await w.port.learningCalls(COPY)).toBe(0);
  });
  it("a mark the install does not show reads as nothing (so the executor stops the replay); a copy that never ends times out; a learning call is not 0", async () => {
    const unmarked = fake({ views: [{ taskId: COPY, state: "running" }] });
    expect(await unmarked.port.readMark(COPY)).toBeUndefined();
    expect(await unmarked.port.learningCalls(COPY)).toBe(1);
    await expect(unmarked.port.waitForEnd(COPY)).rejects.toThrow(/did not finish/);
  });
  it("cancels through the existing workspace cancel, for the copy's own workspace", async () => {
    const w = fake();
    await w.port.readMark(COPY);
    await w.port.cancel(COPY);
    expect(w.calls.at(-1)).toEqual(["admin", "cancel", "--workspace", "ws-1"]);
  });
  it("with the executor: an install that does not show the mark gets the copy cancelled and the replay stopped", async () => {
    const w = fake({ views: [{ taskId: COPY, workspaceId: "ws-1", state: "running" }] });
    const executor = stagingExecutor(w.port, { maxUsdPerRun: 2 });
    await expect(executor.run({ run: { key: "r1", task: "t", repeat: 1, arm: "off", day: "2026-09-01", memory: { mode: "off" }, evalRun: true }, task: { taskId: "t" } as never, learning: { lessonsSwitch: "off", calls: "none" } })).rejects.toThrow(/not marked/);
    expect(w.calls.some((c) => c[0] === "admin" && c[1] === "cancel")).toBe(true);
  });
});
