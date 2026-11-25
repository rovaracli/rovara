// Gate: the canary (phase proof, beta; L9). One tiny real task through the canary lane for THESE shas (lib/canary.ts, ported from the staging pack's canary).
// FAIL: a step the release could cause failed, or the run cost more than the cap: the proof step stops (exit 20) and last-good does not move.
// INCONCLUSIVE (lane busy, provider outage, unreadable report, Lambda Errors above zero, the lane's daily counter used up): skipped WITH a reason and holdsLastGood, so last-good stays
// on the last release that was proven, and the summary says so. Nothing is rolled back on a doubt.
// Lane not deployed (neither function name is in SSM): skipped with that reason; last-good moves, recorded with proofSkipped. Only one name present is a misconfiguration: fail.
import { ssmChecksPrefixFor } from "../config.ts";
import { awsLane, checkLambdaErrors, plain, runLane } from "../lib/canary.ts";
import type { LaneRun } from "../lib/canary.ts";
import type { Gate } from "../types.ts";
import { codeShaAfterRun } from "../lib/manifest.ts";

const NAME = /^[A-Za-z0-9_-]{1,64}$/u;

export const gate: Gate = {
  name: "canary",
  phases: ["proof"],
  envs: ["beta"],
  async run(input) {
    const { ports, manifest, env } = input;
    const prefix = ssmChecksPrefixFor(input.config, env);
    const [start, status] = [await ports.ssm.get(`${prefix}/canary-start-function`), await ports.ssm.get(`${prefix}/canary-status-function`)];
    if (start === null && status === null) return { result: "skipped", skippedReason: `the ${env} canary lane is not deployed (no ${prefix}/canary-start-function)`, data: { lane: "absent" } };
    if (start === null || status === null) return { result: "fail", failures: [`only one of canary-start-function and canary-status-function is set under ${prefix}: the lane is half configured`] };
    if (!NAME.test(start) || !NAME.test(status)) return { result: "fail", failures: ["a canary function name under the checks prefix is not a Lambda function name"] };
    // The Code sha under test: what is promoted, or in a run that skips Code the sha Code is pinned to.
    const codeSha = codeShaAfterRun(manifest, env);
    const hold = (reason: string, data: Record<string, unknown> = {}) => ({ result: "skipped" as const, skippedReason: plain(reason, 200), data: { holdsLastGood: true, ...data } });
    if (codeSha === null) return hold("no Code sha is known for this run, so the lane cannot name both shas");
    const run: LaneRun = { runId: `rel-cloud-${manifest.executionId}`, codeSha, cloudSha: manifest.cloud.sha, installId: `cloud-${manifest.exec8}` };
    const { lane, errors } = awsLane(ports, { start, status }, `${input.dirs.work}/canary`);
    const startedMs = lane.nowMs();
    const verdict = await checkLambdaErrors(await runLane(lane, run), () => errors(startedMs, lane.nowMs()));
    const data = { runId: verdict.runId, ...("report" in verdict && verdict.report !== null ? { report: verdict.report } : {}) };
    if (verdict.kind === "pass") return { result: "pass", data, notes: [`canary PASS on ${manifest.cloud.sha.slice(0, 12)} with Code ${codeSha.slice(0, 12)}`] };
    if (verdict.kind === "fail") return { result: "fail", failures: [`canary FAIL: ${verdict.reason}`], data };
    return hold(`canary inconclusive: ${verdict.reason}`, data);
  },
};
