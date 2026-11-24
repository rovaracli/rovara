// The DEC 409 canary lane, called through its two Lambdas (the pipeline holds NO secret for it: the lane's step role holds the only credential, S6b is dropped).
// Contract used (PLAN-v2 of the lane; the lane is not built yet, so every shape is checked strictly and anything unexpected is INCONCLUSIVE, never a PASS and never a FAIL):
//   start  {op:"install-close", installId} -> {ok:true} | {refusal}         (the pipeline's deploy is an install: close it so the lane may start)
//   start  {runId, codeSha, cloudSha, installId, mode:"real"} -> {runId, executionArn} | {refusal:"lock-busy"|"install-open"|"counter-exhausted"|"spend-cap"|"not-configured"}
//   status {runId} -> {state:"running"} | {state:"done", report} | {report}
//   report {runId, mode, codeSha, cloudSha, result:"PASS"|"FAIL", outcome?, firstFailure?, costUsd, capUsd, steps:[{id,status}]}
import { BUSY_RETRIES, BUSY_WAIT_MS, COST_CAP_USD, DEADLINE_MS, FAULT_LANE_OUTCOMES, INCONCLUSIVE_LANE_OUTCOMES, LANE_SETUP_STEPS, MAX_BAD_CALLS, POLL_INTERVAL_MS, RELEASE_STEPS } from "./config.ts";
import { HEX40, errorText, isRecord, plain } from "./util.ts";
import type { CanaryPorts, LaneReportFacts } from "./types.ts";

export type LaneVerdict =
  | { kind: "pass"; report: LaneReportFacts; runId: string }
  | { kind: "fail"; report: LaneReportFacts; runId: string; reason: string }
  | { kind: "inconclusive"; reason: string; report: LaneReportFacts | null; runId: string }
  | { kind: "cap"; reason: string; runId: string };

export interface LaneRun {
  runId: string;
  codeSha: string;
  cloudSha: string;
  installId: string;
}

function refusalOf(response: unknown): string | null {
  return isRecord(response) && typeof response.refusal === "string" ? plain(response.refusal, 60) : null;
}

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
  // result FAIL: only an explicit product-step failure is a FAIL (the rollback trigger). Everything not clearly the release's fault is INCONCLUSIVE.
  if (outcome !== null && INCONCLUSIVE_LANE_OUTCOMES.includes(outcome)) return inconclusive(`the lane reports "${outcome}": not proof either way`, facts);
  if (firstFailure !== null && LANE_SETUP_STEPS.includes(firstFailure)) return inconclusive(`step ${firstFailure} is the lane's own setup check, not the release`, facts);
  if (outcome !== null && !FAULT_LANE_OUTCOMES.includes(outcome)) return inconclusive(`the lane reports an unknown outcome "${outcome}"`, facts);
  if (firstFailure === null || !RELEASE_STEPS.includes(firstFailure)) return inconclusive("FAIL without a known failing step", facts);
  return { kind: "fail", report: facts, runId: run.runId, reason: `step ${firstFailure} failed` };
}

/** Runs the lane to the end. Never throws: every problem is INCONCLUSIVE (no spend question, no rollback), except the lane's own counter, which is a cap. */
export async function runLane(ports: CanaryPorts, run: LaneRun): Promise<LaneVerdict> {
  const inconclusive = (reason: string): LaneVerdict => ({ kind: "inconclusive", reason, report: null, runId: run.runId });
  if (!HEX40.test(run.codeSha) || !HEX40.test(run.cloudSha)) return inconclusive("a sha under test is not a 40-hex sha");
  try {
    const closed = await ports.invokeLane("start", { op: "install-close", installId: run.installId });
    const refusal = refusalOf(closed);
    if (refusal !== null) return inconclusive(`install-close refused: ${refusal}`);
  } catch (error) {
    return inconclusive(`the canary lane is unreachable (install-close): ${errorText(error)}`);
  }

  let started = false;
  for (let attempt = 0; attempt <= BUSY_RETRIES && !started; attempt++) {
    let response: unknown;
    try {
      response = await ports.invokeLane("start", { runId: run.runId, codeSha: run.codeSha, cloudSha: run.cloudSha, installId: run.installId, mode: "real" });
    } catch (error) {
      return inconclusive(`the canary lane did not start (${errorText(error)})`);
    }
    const refusal = refusalOf(response);
    if (refusal === "lock-busy" || refusal === "install-open") {
      if (attempt === BUSY_RETRIES) return inconclusive(`the canary lane stayed busy (${refusal}) after ${BUSY_RETRIES} waits`);
      await ports.sleep(BUSY_WAIT_MS);
      continue;
    }
    if (refusal === "counter-exhausted") return { kind: "cap", reason: "the canary lane's own daily counter is exhausted", runId: run.runId };
    if (refusal !== null) return inconclusive(`the canary lane refused to start: ${refusal}`);
    if (!isRecord(response) || response.runId !== run.runId) return inconclusive("the lane's start answer does not name this run");
    started = true;
  }
  if (!started) return inconclusive("the canary lane did not start");

  const deadline = ports.nowMs() + DEADLINE_MS;
  let bad = 0;
  while (ports.nowMs() < deadline) {
    await ports.sleep(POLL_INTERVAL_MS);
    let response: unknown;
    try {
      response = await ports.invokeLane("status", { runId: run.runId });
    } catch {
      if (++bad >= MAX_BAD_CALLS) return inconclusive(`the lane's status call failed ${MAX_BAD_CALLS} times in a row`);
      continue;
    }
    if (!isRecord(response)) {
      if (++bad >= MAX_BAD_CALLS) return inconclusive("the lane's status answers are unreadable");
      continue;
    }
    if (response.state === "running") {
      bad = 0;
      continue;
    }
    if (response.state === "done" || (response.state === undefined && isRecord(response.report))) return judgeReport(response.report, run);
    if (response.state === undefined && typeof response.result === "string") return judgeReport(response, run);
    if (++bad >= MAX_BAD_CALLS) return inconclusive("the lane's status answers are unreadable");
  }
  return inconclusive("canary-no-answer: the lane gave no report in time");
}
