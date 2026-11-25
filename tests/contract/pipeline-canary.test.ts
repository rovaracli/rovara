// L9: the canary, ported from the staging pack (ops/staging-release/canary). Fakes only: no AWS, no lane. The staging original is untouched.
import { describe, expect, it } from "vitest";
import { gate } from "../../ops/pipeline/gates/canary.gate.ts";
import { awsLane, checkLambdaErrors, COST_CAP_USD, DEADLINE_MS, judgeReport, runLane } from "../../ops/pipeline/lib/canary.ts";
import type { LanePorts, LaneRun, LaneVerdict } from "../../ops/pipeline/lib/canary.ts";
import type { GateInput, Manifest, Ports } from "../../ops/pipeline/types.ts";
import { EXEC8, EXEC_ID, config, makePorts, newState, sha } from "./pipeline-stage-fakes.ts";
import type { FakeState } from "./pipeline-stage-fakes.ts";

/** expect.stringMatching typed as a string, so it can sit inside toMatchObject without an any. */
const like = (re: RegExp): string => expect.stringMatching(re) as string;
const RUN: LaneRun = { runId: `rel-cloud-${EXEC_ID}`, codeSha: sha("c"), cloudSha: sha("4"), installId: `cloud-${EXEC8}` };
const steps = (n: number, status = "PASS") => Array.from({ length: n }, (_, i) => ({ id: `S${i + 1}`, status }));
const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ runId: RUN.runId, mode: "real", codeSha: RUN.codeSha, cloudSha: RUN.cloudSha, result: "PASS", outcome: "pass", costUsd: 0.2, capUsd: 1, steps: steps(13), ...over });
const kind = (v: LaneVerdict): string => v.kind;

describe("canary: judging the lane's report (ported checks)", () => {
  it("a real run of these shas with every step passed inside the cap is a PASS", () => {
    expect(kind(judgeReport(report(), RUN))).toBe("pass");
  });

  it("a PASS that is not proof is INCONCLUSIVE: other run, other shas, a dry run, no cost, a failed step, an odd outcome", () => {
    for (const over of [{ runId: "other" }, { codeSha: sha("9") }, { cloudSha: sha("9") }, { mode: "dry" }, { costUsd: undefined }, { steps: [...steps(3), ...steps(1, "FAIL")] }, { steps: [] }, { outcome: "weird" }]) {
      expect(kind(judgeReport(report(over), RUN))).toBe("inconclusive");
    }
    expect(kind(judgeReport("nope", RUN))).toBe("inconclusive");
    expect(kind(judgeReport({ ...report(), result: "MAYBE" }, RUN))).toBe("inconclusive");
  });

  it("a run above the cost cap is a FAIL", () => {
    expect(judgeReport(report({ costUsd: COST_CAP_USD + 0.01 }), RUN)).toMatchObject({ kind: "fail", reason: like(/above the 1 USD cap/u) });
  });

  it("only a release-caused step failure is a FAIL; the lane's setup steps, outages and unknown outcomes are not", () => {
    const failed = (over: Record<string, unknown>) => kind(judgeReport(report({ result: "FAIL", outcome: "step-failed", ...over }), RUN));
    expect(failed({ firstFailure: "S5" })).toBe("fail");
    expect(failed({ firstFailure: "S0" })).toBe("inconclusive");
    expect(failed({ firstFailure: "S12" })).toBe("inconclusive");
    expect(failed({ firstFailure: undefined })).toBe("inconclusive");
    expect(failed({ firstFailure: "S99" })).toBe("inconclusive");
    expect(failed({ outcome: "provider-outage", firstFailure: "S5" })).toBe("inconclusive");
    expect(failed({ outcome: "something-new", firstFailure: "S5" })).toBe("inconclusive");
  });
});

/** A scripted lane: answers in order per function; records every call. */
function scripted(answers: { start: unknown[]; status: unknown[] }): { lane: LanePorts; calls: string[]; now: () => number } {
  let clock = 0;
  const calls: string[] = [];
  const queues = { start: [...answers.start], status: [...answers.status] };
  return {
    calls, now: () => clock,
    lane: {
      invoke: (fn, payload) => {
        calls.push(`${fn} ${JSON.stringify(payload)}`);
        const next = queues[fn].shift();
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
      sleep: (ms) => { clock += ms; return Promise.resolve(); },
      nowMs: () => clock,
    },
  };
}
const START_OK = [{ ok: true }, { runId: RUN.runId, executionArn: "x" }];

describe("canary: running the lane", () => {
  it("closes the install, starts a real run, polls until done and judges the report", async () => {
    const s = scripted({ start: START_OK, status: [{ state: "running" }, { state: "done", report: report() }] });
    expect(kind(await runLane(s.lane, RUN))).toBe("pass");
    expect(s.calls[0]).toContain('"op":"install-close"');
    expect(s.calls[1]).toContain('"mode":"real"');
    expect(s.calls.filter((c) => c.startsWith("status"))).toHaveLength(2);
  });

  it("waits while the lane is busy, then gives up as INCONCLUSIVE; its own counter is a cap, not a fail", async () => {
    const busy = scripted({ start: [{ ok: true }, ...Array.from({ length: 8 }, () => ({ refusal: "lock-busy" }))], status: [] });
    expect(await runLane(busy.lane, RUN)).toMatchObject({ kind: "inconclusive", reason: like(/stayed busy/u) });
    expect(busy.now()).toBe(6 * 60_000);
    expect(kind(await runLane(scripted({ start: [{ ok: true }, { refusal: "counter-exhausted" }], status: [] }).lane, RUN))).toBe("cap");
    expect(await runLane(scripted({ start: [{ ok: true }, { refusal: "spend-cap" }], status: [] }).lane, RUN)).toMatchObject({ kind: "inconclusive" });
  });

  it("never throws: an unreachable lane, a wrong run id, unreadable answers and a missed deadline are INCONCLUSIVE", async () => {
    expect(await runLane(scripted({ start: [new Error("boom")], status: [] }).lane, RUN)).toMatchObject({ kind: "inconclusive", reason: like(/unreachable/u) });
    expect(await runLane(scripted({ start: [{ ok: true }, { runId: "other" }], status: [] }).lane, RUN)).toMatchObject({ kind: "inconclusive" });
    expect(await runLane(scripted({ start: START_OK, status: ["x", "y", "z"] }).lane, RUN)).toMatchObject({ kind: "inconclusive", reason: like(/unreadable/u) });
    expect(await runLane(scripted({ start: START_OK, status: [new Error("a"), new Error("b"), new Error("c")] }).lane, RUN)).toMatchObject({ kind: "inconclusive", reason: like(/3 times/u) });
    const slow = scripted({ start: START_OK, status: Array.from({ length: 200 }, () => ({ state: "running" })) });
    expect(await runLane(slow.lane, RUN)).toMatchObject({ kind: "inconclusive", reason: like(/no report in time/u) });
    expect(slow.now()).toBeGreaterThanOrEqual(DEADLINE_MS);
    expect(await runLane(scripted({ start: [], status: [] }).lane, { ...RUN, codeSha: "short" })).toMatchObject({ kind: "inconclusive", reason: like(/40-hex/u) });
  });

  it("a lane PASS still needs Lambda Errors = 0; an unreadable or non-zero count is INCONCLUSIVE", async () => {
    const pass: LaneVerdict = { kind: "pass", report: { result: "PASS", outcome: "pass", firstFailure: null, costUsd: 0.1 }, runId: RUN.runId };
    expect(kind(await checkLambdaErrors(pass, () => Promise.resolve(0)))).toBe("pass");
    expect(await checkLambdaErrors(pass, () => Promise.resolve(2))).toMatchObject({ kind: "inconclusive", reason: like(/Errors was 2/u) });
    expect(kind(await checkLambdaErrors(pass, () => Promise.resolve(null)))).toBe("inconclusive");
    expect(kind(await checkLambdaErrors(pass, () => Promise.reject(new Error("x"))))).toBe("inconclusive");
    const fail: LaneVerdict = { kind: "fail", reason: "r", report: pass.report, runId: RUN.runId };
    expect(await checkLambdaErrors(fail, () => Promise.reject(new Error("never called")))).toBe(fail);
  });
});

// ---- the gate, with fake ports.aws ----

const PREFIX = "/rovara-cloud/beta/release-checks";
const manifest = (over: Partial<Manifest["code"]> = {}): Manifest => ({
  schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "t", mode: "release",
  cloud: { tag: "v0.13.10", sha: sha("4"), ref: "latest-tag", trunk: "cloud/next", liveSha: { beta: null, production: null } },
  code: { sha: sha("c"), release: "run", requestedRelease: "run", pinnedSha: { beta: null, production: null }, supersedes: null, ...over },
  gateway: { digest: null, source: null, imageTag: null, repository: null }, stages: {},
});

interface Lane { start: unknown[]; status: unknown[]; errors?: unknown }
function gateInput(state: FakeState, lane: Lane, m: Manifest = manifest()): { input: GateInput; awsCalls: string[][] } {
  const awsCalls: string[][] = [];
  const base = makePorts(state);
  const queues = { start: [...lane.start], status: [...lane.status] };
  const ports: Ports = {
    ...base,
    aws: {
      json: (args, opts) => {
        awsCalls.push([...args, ...(opts?.env === undefined ? [] : [`env:${JSON.stringify(opts.env)}`])]);
        if (args[0] === "lambda") {
          const fn = args[args.indexOf("--function-name") + 1] === "lane-start" ? "start" : "status";
          const answer = queues[fn].shift();
          if (answer instanceof Error) return Promise.reject(answer);
          state.files[args.at(-1)!] = JSON.stringify(answer);
          return Promise.resolve({ StatusCode: 200 });
        }
        return Promise.resolve(lane.errors ?? { Datapoints: [{ Sum: 0 }] });
      },
    },
  };
  return { input: { env: "beta", phase: "proof", region: "us-east-1", config, manifest: m, changeSets: [], dirs: { pipeline: "/p", cloud: null, out: "/out", work: "/w" }, ports, log: () => {} }, awsCalls };
}
const deployed = (): FakeState => newState({ ssm: { [`${PREFIX}/canary-start-function`]: "lane-start", [`${PREFIX}/canary-status-function`]: "lane-status" } });
const LANE_OK: Lane = { start: START_OK, status: [{ state: "done", report: report() }] };

describe("the canary gate", () => {
  it("passes on a real, in-cap, error-free run, naming both shas to the lane and calling Lambda with one attempt only", async () => {
    const { input, awsCalls } = gateInput(deployed(), LANE_OK);
    const out = await gate.run(input);
    expect(out).toMatchObject({ result: "pass", data: { runId: RUN.runId, report: { result: "PASS", costUsd: 0.2 } } });
    const invoke = awsCalls.find((c) => c[0] === "lambda")!;
    expect(invoke).toContain("--cli-binary-format");
    expect(invoke.at(-1)).toBe('env:{"AWS_MAX_ATTEMPTS":"1"}');
    expect(awsCalls.flat().some((a) => a.includes(`"codeSha":"${sha("c")}","cloudSha":"${sha("4")}"`))).toBe(true);
    expect(awsCalls.some((c) => c[0] === "cloudwatch" && c.includes("Errors"))).toBe(true);
  });

  it("uses the pinned Code sha when the run skips Code (a rollback)", async () => {
    const rollbackReport = report({ codeSha: sha("d") });
    const { input } = gateInput(deployed(), { start: START_OK, status: [{ state: "done", report: rollbackReport }] }, manifest({ release: "skip", pinnedSha: { beta: sha("d"), production: null } }));
    expect((await gate.run(input)).result).toBe("pass");
  });

  it("fails on a step the release could cause", async () => {
    const { input } = gateInput(deployed(), { start: START_OK, status: [{ state: "done", report: report({ result: "FAIL", outcome: "step-failed", firstFailure: "S4", steps: steps(3, "FAIL") }) }] });
    expect(await gate.run(input)).toMatchObject({ result: "fail", failures: ["canary FAIL: step S4 failed"] });
  });

  it("an inconclusive canary skips with its reason and HOLDS last-good (nothing rolls back)", async () => {
    for (const lane of [
      { start: [{ ok: true }, { refusal: "counter-exhausted" }], status: [] },
      { start: START_OK, status: [{ state: "done", report: report({ result: "FAIL", outcome: "provider-outage" }) }] },
      { ...LANE_OK, errors: { Datapoints: [{ Sum: 3 }] } },
      { ...LANE_OK, errors: "not metrics" },
    ] as Lane[]) {
      const out = await gate.run(gateInput(deployed(), lane).input);
      expect(out).toMatchObject({ result: "skipped", data: { holdsLastGood: true } });
      expect(out.skippedReason).toMatch(/^canary inconclusive: /u);
    }
  });

  it("no known Code sha is a hold, not a pass", async () => {
    const out = await gate.run(gateInput(deployed(), LANE_OK, manifest({ sha: null })).input);
    expect(out).toMatchObject({ result: "skipped", data: { holdsLastGood: true } });
  });

  it("a lane that is not deployed is skipped with that reason and does NOT hold last-good; half configured fails; a bad name fails", async () => {
    const none = await gate.run(gateInput(newState(), LANE_OK).input);
    expect(none).toMatchObject({ result: "skipped", skippedReason: like(/canary lane is not deployed/u), data: { lane: "absent" } });
    expect(none.data).not.toHaveProperty("holdsLastGood");
    expect((await gate.run(gateInput(newState({ ssm: { [`${PREFIX}/canary-start-function`]: "lane-start" } }), LANE_OK).input)).result).toBe("fail");
    expect((await gate.run(gateInput(newState({ ssm: { [`${PREFIX}/canary-start-function`]: "a b", [`${PREFIX}/canary-status-function`]: "lane-status" } }), LANE_OK).input)).result).toBe("fail");
  });

  it("runs for beta only", () => {
    expect(gate.envs).toEqual(["beta"]);
    expect(gate.phases).toEqual(["proof"]);
  });

  it("awsLane: a function error or a non-200 answer is an error, never a verdict", async () => {
    const state = newState();
    for (const meta of [{ FunctionError: "Unhandled" }, { StatusCode: 500 }]) {
      const ports: Ports = { ...makePorts(state), aws: { json: () => Promise.resolve(meta) } };
      await expect(awsLane(ports, { start: "a", status: "b" }, "/w").lane.invoke("start", {})).rejects.toThrow();
    }
  });
});
