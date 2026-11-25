// The canary checks for the single pipeline (L9): a PORT of the staging pack's canary (ops/staging-release/canary/src/lane.ts, canary.ts, config.ts), which stays where it is until
// beta has run this once. The checks are the same: one tiny REAL task through the canary lane (two Lambdas), a report that must be a real run of THESE shas with every step passed
// within the cost cap, a failing step that only the release could cause (the lane's own setup steps and outages are not proof), and Lambda Errors = 0 over the window.
// Fail closed: a doubt is INCONCLUSIVE (nothing rolls back, last-good does not move), never a PASS.
// Left behind on purpose: the staging pack's HOLD parameters (the pipeline itself stops on a FAIL), its 16-per-24-hours S3 ledger (the lane keeps its own counter and says
// "counter-exhausted"; see the DONE file) and its alert topics.
import type { Ports } from "../types.ts";

export const COST_CAP_USD = 1.0;
export const POLL_INTERVAL_MS = 20_000;
export const DEADLINE_MS = 42 * 60_000;
export const BUSY_RETRIES = 6;
export const BUSY_WAIT_MS = 60_000;
export const MAX_BAD_CALLS = 3;
/** Lane steps whose failure is a fault of the lane or its setup rather than of the release. */
export const LANE_SETUP_STEPS: readonly string[] = ["S0", "S12"];
export const RELEASE_STEPS: readonly string[] = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S13"];
export const INCONCLUSIVE_LANE_OUTCOMES: readonly string[] = ["budget-refused", "provider-outage", "canary-no-answer", "spend-cap", "not-configured", "lock-busy", "install-open"];
export const FAULT_LANE_OUTCOMES: readonly string[] = ["step-failed", "budget-near-cap", "over-cap"];

const HEX40 = /^[0-9a-f]{40}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Printable ASCII only, one bounded string. */
export const plain = (text: unknown, max = 300): string => {
  const cleaned = String(text).replace(/[^\x20-\x7e]/gu, "?");
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
};
const errorText = (error: unknown): string => plain(error instanceof Error ? error.message : "unknown error");

export interface LaneReportFacts { result: string; outcome: string | null; firstFailure: string | null; costUsd: number | null }
export type LaneVerdict =
  | { kind: "pass"; report: LaneReportFacts; runId: string }
  | { kind: "fail"; report: LaneReportFacts; runId: string; reason: string }
  | { kind: "inconclusive"; reason: string; report: LaneReportFacts | null; runId: string }
  | { kind: "cap"; reason: string; runId: string };

export interface LaneRun { runId: string; codeSha: string; cloudSha: string; installId: string }

/** What the lane runner needs: the lane's two Lambdas and a clock. The gate builds it from ports.aws; tests pass fakes. */
export interface LanePorts {
  invoke(fn: "start" | "status", payload: Record<string, unknown>): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
}

const refusalOf = (response: unknown): string | null => (isRecord(response) && typeof response.refusal === "string" ? plain(response.refusal, 60) : null);

/** The report must be a REAL run of THESE shas that every step passed within the cost cap; otherwise a PASS is not proof. */
export function judgeReport(report: unknown, run: LaneRun): LaneVerdict {
  const inconclusive = (reason: string, facts: LaneReportFacts | null = null): LaneVerdict => ({ kind: "inconclusive", reason, report: facts, runId: run.runId });
  if (!isRecord(report)) return inconclusive("report-invalid: not an object");
  const result = report.result;
  if (result !== "PASS" && result !== "FAIL") return inconclusive("report-invalid: result is neither PASS nor FAIL");
  const outcome = typeof report.outcome === "string" ? plain(report.outcome, 60) : null;
  const firstFailure = typeof report.firstFailure === "string" ? plain(report.firstFailure, 20) : null;
  const costUsd = typeof report.costUsd === "number" && Number.isFinite(report.costUsd) && report.costUsd >= 0 ? report.costUsd : null;
  const facts: LaneReportFacts = { result, outcome, firstFailure, costUsd };
  if (report.runId !== run.runId) return inconclusive("report-invalid: the report is for another run", facts);
  if (report.codeSha !== run.codeSha || report.cloudSha !== run.cloudSha) return inconclusive("report-invalid: the report names other shas than the ones under test", facts);
  if (report.mode !== "real") return inconclusive("report-invalid: the report is not from a real run (a dry run proves nothing)", facts);
  if (result === "PASS") {
    if (outcome !== null && outcome !== "pass") return inconclusive(`report-invalid: PASS with outcome "${outcome}"`, facts);
    if (costUsd === null) return inconclusive("report-invalid: no readable cost", facts);
    if (costUsd > COST_CAP_USD) return { kind: "fail", report: facts, runId: run.runId, reason: `the canary cost ${costUsd} USD, above the ${COST_CAP_USD} USD cap` };
    const steps = report.steps;
    if (!Array.isArray(steps) || steps.length === 0 || !steps.every((s) => isRecord(s) && s.status === "PASS")) return inconclusive("report-invalid: PASS but not every step passed", facts);
    return { kind: "pass", report: facts, runId: run.runId };
  }
  // result FAIL: only an explicit product-step failure is a FAIL. Everything not clearly the release's fault is INCONCLUSIVE.
  if (outcome !== null && INCONCLUSIVE_LANE_OUTCOMES.includes(outcome)) return inconclusive(`the lane reports "${outcome}": not proof either way`, facts);
  if (firstFailure !== null && LANE_SETUP_STEPS.includes(firstFailure)) return inconclusive(`step ${firstFailure} is the lane's own setup check, not the release`, facts);
  if (outcome !== null && !FAULT_LANE_OUTCOMES.includes(outcome)) return inconclusive(`the lane reports an unknown outcome "${outcome}"`, facts);
  if (firstFailure === null || !RELEASE_STEPS.includes(firstFailure)) return inconclusive("FAIL without a known failing step", facts);
  return { kind: "fail", report: facts, runId: run.runId, reason: `step ${firstFailure} failed` };
}

/** Runs the lane to the end. Never throws: every problem is INCONCLUSIVE, except the lane's own counter, which is a cap. */
export async function runLane(lane: LanePorts, run: LaneRun): Promise<LaneVerdict> {
  const inconclusive = (reason: string): LaneVerdict => ({ kind: "inconclusive", reason, report: null, runId: run.runId });
  if (!HEX40.test(run.codeSha) || !HEX40.test(run.cloudSha)) return inconclusive("a sha under test is not a 40-hex sha");
  try {
    const refusal = refusalOf(await lane.invoke("start", { op: "install-close", installId: run.installId }));
    if (refusal !== null) return inconclusive(`install-close refused: ${refusal}`);
  } catch (error) { return inconclusive(`the canary lane is unreachable (install-close): ${errorText(error)}`); }
  let started = false;
  for (let attempt = 0; attempt <= BUSY_RETRIES && !started; attempt++) {
    let response: unknown;
    try { response = await lane.invoke("start", { runId: run.runId, codeSha: run.codeSha, cloudSha: run.cloudSha, installId: run.installId, mode: "real" }); } catch (error) { return inconclusive(`the canary lane did not start (${errorText(error)})`); }
    const refusal = refusalOf(response);
    if (refusal === "lock-busy" || refusal === "install-open") {
      if (attempt === BUSY_RETRIES) return inconclusive(`the canary lane stayed busy (${refusal}) after ${BUSY_RETRIES} waits`);
      await lane.sleep(BUSY_WAIT_MS);
      continue;
    }
    if (refusal === "counter-exhausted") return { kind: "cap", reason: "the canary lane's own daily counter is exhausted", runId: run.runId };
    if (refusal !== null) return inconclusive(`the canary lane refused to start: ${refusal}`);
    if (!isRecord(response) || response.runId !== run.runId) return inconclusive("the lane's start answer does not name this run");
    started = true;
  }
  if (!started) return inconclusive("the canary lane did not start");
  const deadline = lane.nowMs() + DEADLINE_MS;
  let bad = 0;
  while (lane.nowMs() < deadline) {
    await lane.sleep(POLL_INTERVAL_MS);
    let response: unknown;
    try { response = await lane.invoke("status", { runId: run.runId }); } catch { if (++bad >= MAX_BAD_CALLS) return inconclusive(`the lane's status call failed ${MAX_BAD_CALLS} times in a row`); continue; }
    if (!isRecord(response)) { if (++bad >= MAX_BAD_CALLS) return inconclusive("the lane's status answers are unreadable"); continue; }
    if (response.state === "running") { bad = 0; continue; }
    if (response.state === "done" || (response.state === undefined && isRecord(response.report))) return judgeReport(response.report, run);
    if (response.state === undefined && typeof response.result === "string") return judgeReport(response, run);
    if (++bad >= MAX_BAD_CALLS) return inconclusive("the lane's status answers are unreadable");
  }
  return inconclusive("canary-no-answer: the lane gave no report in time");
}

/** A lane PASS still needs Lambda Errors = 0 over the canary's window; a count that cannot be read, or is not zero, is not proof. */
export async function checkLambdaErrors(verdict: LaneVerdict, errors: () => Promise<number | null>): Promise<LaneVerdict> {
  if (verdict.kind !== "pass") return verdict;
  let count: number | null;
  try { count = await errors(); } catch { count = null; }
  if (count === null) return { kind: "inconclusive", reason: "the lane passed but Lambda Errors could not be read", report: verdict.report, runId: verdict.runId };
  if (count > 0) return { kind: "inconclusive", reason: `the lane passed but Lambda Errors was ${count} during the canary`, report: verdict.report, runId: verdict.runId };
  return verdict;
}

/** The lane's Lambdas and the Lambda Errors metric through `ports.aws` (one attempt only: a CLI retry on a timeout must never become two paid runs). */
export function awsLane(ports: Ports, names: { start: string; status: string }, dir: string): { lane: LanePorts; errors: (fromMs: number, toMs: number) => Promise<number | null> } {
  let n = 0;
  const lane: LanePorts = {
    async invoke(fn, payload) {
      n += 1;
      const out = `${dir}/canary-response-${n}.json`;
      ports.fs.mkdirp(dir);
      const meta = await ports.aws.json(["lambda", "invoke", "--function-name", fn === "start" ? names.start : names.status, "--invocation-type", "RequestResponse", "--cli-read-timeout", "60", "--cli-binary-format", "raw-in-base64-out", "--payload", JSON.stringify(payload), out], { env: { AWS_MAX_ATTEMPTS: "1" } });
      if (isRecord(meta) && meta.FunctionError !== undefined && meta.FunctionError !== null) throw new Error("the lane function reported an error");
      if (isRecord(meta) && typeof meta.StatusCode === "number" && meta.StatusCode !== 200) throw new Error(`the lane function answered ${meta.StatusCode}`);
      return JSON.parse(ports.fs.readText(out)) as unknown;
    },
    sleep: (ms) => ports.clock.sleep(ms),
    nowMs: () => ports.clock.now().getTime(),
  };
  const errors = async (fromMs: number, toMs: number): Promise<number | null> => {
    const iso = (ms: number): string => new Date(ms).toISOString();
    const body = await ports.aws.json(["cloudwatch", "get-metric-statistics", "--namespace", "AWS/Lambda", "--metric-name", "Errors", "--start-time", iso(fromMs), "--end-time", iso(Math.max(toMs, fromMs + 60_000)), "--period", "60", "--statistics", "Sum"]);
    if (!isRecord(body) || !Array.isArray(body.Datapoints)) return null;
    let sum = 0;
    for (const point of body.Datapoints) {
      if (!isRecord(point) || typeof point.Sum !== "number") return null;
      sum += point.Sum;
    }
    return sum;
  };
  return { lane, errors };
}
