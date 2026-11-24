// The Canary action (Release stage, after PostCheck): one tiny real task through the DEC 409 lane, then a verdict that is one of
//   PASS          every step passed on THESE shas within the cost cap -> move last-good (the ONLY place it moves)
//   FAIL          a fault the release could cause -> HOLD first, alert, exit 1 (the stage fails; the rollback guards decide, and never to a SKIPPED-CAP run)
//   INCONCLUSIVE  not proof either way (budget refusal, provider outage, lane unreachable, unreadable report, anything unexpected) -> exit 0 + HOLD, alert, NO rollback
//   SKIPPED-CAP   16 canaries already ran in the rolling 24 h (both pipelines together) -> exit 0, say so, `installed` moves (PostCheck) but last-good does not
// It fails closed: a doubt is INCONCLUSIVE (a HOLD, nothing destroyed, nothing spent), never a PASS and never a rollback. It never throws.
import { CANARY_CAP, type Kind, type Outcome } from "./config.ts";
import { publishAll, type Alert, type AlertDelivery } from "./alerts.ts";
import { holdName, pointerName, writeHold, type HoldKind } from "./holds.ts";
import { claimSlot, recordRollbackCanary } from "./ledger.ts";
import { runLane, type LaneRun, type LaneVerdict } from "./lane.ts";
import { HEX40, UUID, errorText, exec8, isKind, plain } from "./util.ts";
import type { CanaryInput, CanaryPorts, CanaryResult, LaneReportFacts, ValidInput } from "./types.ts";

const PREFIX_PATTERN = /^\/rovara-release\/[a-z0-9-]{1,40}$/;

/** Returns the valid input, or the reason it is not. */
export function validateInput(input: CanaryInput): { ok: true; value: ValidInput } | { ok: false; reason: string } {
  if (!isKind(input.kind)) return { ok: false, reason: "the pipeline kind is neither code nor cloud" };
  if (!UUID.test(input.executionId)) return { ok: false, reason: "the execution id is not a pipeline execution id" };
  if (!HEX40.test(input.sha)) return { ok: false, reason: "the release sha is not a 40-hex sha" };
  if (input.executionType !== "STANDARD" && input.executionType !== "ROLLBACK") return { ok: false, reason: `the execution type "${plain(input.executionType, 20)}" is neither STANDARD nor ROLLBACK` };
  if (!PREFIX_PATTERN.test(input.parameterPrefix)) return { ok: false, reason: "the parameter prefix is not /rovara-release/<environment>" };
  if (input.topics.operator === null || input.topics.operator === "") return { ok: false, reason: "the OperatorAlerts topic is not configured, so no alert could reach a person" };
  return { ok: true, value: { ...input, kind: input.kind } };
}

interface Conclusion {
  outcome: Outcome;
  exitCode: number;
  reason: string;
  hold?: HoldKind;
  alerts: Alert[];
  cap?: number | null;
  report?: LaneReportFacts | null;
  lastGoodMoved?: boolean;
  laneRunId?: string | null;
}

export async function runCanary(input: CanaryInput, ports: CanaryPorts): Promise<CanaryResult> {
  const startedMs = ports.nowMs();
  const valid = validateInput(input);
  const holds: string[] = [];
  const deliveries: AlertDelivery[] = [];

  const finish = async (c: Conclusion): Promise<CanaryResult> => {
    let { exitCode, reason } = c;
    const alerts = [...c.alerts];
    const kind: Kind | null = isKind(input.kind) ? input.kind : null;
    // The HOLD is written BEFORE anything else (and before a FAIL's stage failure starts a rollback): every new merge is MANUAL from this moment.
    if (c.hold !== undefined && kind !== null) {
      const suffix = /^[0-9a-f]{8}/.test(input.executionId) ? input.executionId : `${"0".repeat(8)}`;
      const name = holdName(input.parameterPrefix, kind, c.hold, suffix);
      const error = await writeHold(ports, name, plain(reason, 200), input.sha, input.executionId);
      if (error === null) {
        holds.push(name);
        alerts.push({ code: "hold-set", title: "HOLD set", message: `HOLD ${c.hold} was set: every new merge is MANUAL until the controller clears it. ${plain(reason, 300)}`, pipeline: input.kind, sha: input.sha, executionId: input.executionId, s3Path: input.s3Path });
      } else {
        // Fail closed: a verdict that needed a HOLD and could not write one must not look like a quiet success.
        exitCode = 4;
        reason = `${reason}; the HOLD could not be written (${error})`;
        alerts.push({ code: "hold-failed", title: "HOLD could not be written", message: plain(reason, 500), pipeline: input.kind, sha: input.sha, executionId: input.executionId, s3Path: input.s3Path });
      }
    } else if (c.hold !== undefined) {
      exitCode = 4;
    }
    deliveries.push(...(await publishAll(ports, input.topics, alerts)));
    const result: CanaryResult = {
      outcome: c.outcome,
      exitCode,
      reason: plain(reason, 500),
      cap: { limit: CANARY_CAP, n: c.cap ?? null },
      report: c.report ?? null,
      holds,
      lastGoodMoved: c.lastGoodMoved ?? false,
      alertDelivery: deliveries.map((d) => ({ operator: d.operator, slack: d.slack })),
    };
    const slackNote = deliveries.some((d) => d.slack === "not-configured") ? " Slack: not configured." : "";
    const summary = c.outcome === "SKIPPED-CAP" ? `canary skipped: cap ${CANARY_CAP}/24h reached (n=${c.cap ?? "?"}). last-good did not move.${slackNote}` : `canary ${c.outcome}: ${plain(reason, 300)}.${slackNote}`;
    try {
      ports.writeFile(
        "result.json",
        `${JSON.stringify({ schema: 1, result: c.outcome, reason: result.reason, kind: plain(input.kind, 10), executionId: plain(input.executionId, 40), executionType: plain(input.executionType, 12), sha: plain(input.sha, 40), cap: result.cap, laneRunId: c.laneRunId ?? null, report: result.report, holds, lastGoodMoved: result.lastGoodMoved, exitCode, alertDelivery: result.alertDelivery, startedAt: new Date(startedMs).toISOString(), finishedAt: new Date(ports.nowMs()).toISOString() }, null, 2)}\n`,
      );
      ports.writeFile("summary.txt", `${summary}\n`);
    } catch {
      // The stage's own upload step reports a missing record; the verdict, holds and alerts above already happened.
    }
    return result;
  };

  if (!valid.ok) {
    const bad: Conclusion = { outcome: "INCONCLUSIVE", exitCode: 0, reason: `invalid canary input: ${valid.reason}`, hold: "canary-inconclusive", alerts: [{ code: "canary-inconclusive", title: "canary INCONCLUSIVE", message: `invalid canary input: ${valid.reason}`, pipeline: plain(input.kind, 10), sha: plain(input.sha, 40), executionId: plain(input.executionId, 40), s3Path: input.s3Path }] };
    return finish(bad);
  }
  const ctx = valid.value;
  const alertBase = { pipeline: ctx.kind, sha: ctx.sha, executionId: ctx.executionId, s3Path: ctx.s3Path };
  const inconclusive = (reason: string, extra: Partial<Conclusion> = {}): Promise<CanaryResult> =>
    finish({ outcome: "INCONCLUSIVE", exitCode: 0, reason, hold: "canary-inconclusive", alerts: [{ code: "canary-inconclusive", title: "canary INCONCLUSIVE", message: `${reason}. A HOLD is set and nothing is rolled back: the controller decides.`, ...alertBase }], ...extra });

  try {
    const rollback = ctx.executionType === "ROLLBACK";
    const names = {
      installed: pointerName(ctx.parameterPrefix, ctx.kind, "installed"),
      lastGood: pointerName(ctx.parameterPrefix, ctx.kind, "last-good"),
      lastGoodExecution: pointerName(ctx.parameterPrefix, ctx.kind, "last-good-execution"),
      other: pointerName(ctx.parameterPrefix, ctx.kind === "code" ? "cloud" : "code", "installed"),
    };

    // 1. What is installed must be exactly what was deployed in this execution (PostCheck wrote it); nothing newer and nothing else.
    const installed = await ports.getParameter(names.installed);
    if (installed !== ctx.sha) return await inconclusive(`the installed pointer (${plain(installed ?? "missing", 40)}) is not the sha under test`);
    const otherSha = await ports.getParameter(names.other);
    if (otherSha === null || !HEX40.test(otherSha)) return await inconclusive(`the ${ctx.kind === "code" ? "cloud" : "code"} installed sha is not readable, so the lane cannot name both shas`);
    const run: LaneRun = {
      runId: `rel-${ctx.kind}-${ctx.executionId}`,
      codeSha: ctx.kind === "code" ? ctx.sha : otherSha,
      cloudSha: ctx.kind === "cloud" ? ctx.sha : otherSha,
      installId: `${ctx.kind}-${exec8(ctx.executionId)}`,
    };

    if (rollback) {
      // A rollback canary is exempt from the cap (at most one per HOLD, because only one rollback is allowed per HOLD) and moves no pointer.
      const started = await ports.getParameter(holdName(ctx.parameterPrefix, ctx.kind, "rollback-started", ctx.executionId));
      if (started === null) return await inconclusive("this rollback execution has no rollback-started record: the rollback guard did not pass");
      const lastGood = await ports.getParameter(names.lastGood);
      if (lastGood !== ctx.sha) return await inconclusive("the rollback canary's sha is not the recorded last-good sha");
      await recordRollbackCanary(ports, ctx.kind, ctx.executionId);
      const verdict = await runLane(ports, run);
      const checked = await afterLane(ports, verdict, startedMs);
      if (checked.kind === "pass") {
        return await finish({ outcome: "PASS", exitCode: 0, reason: "the rolled-back release passed the canary; the HOLD stays until the controller clears it", report: checked.report, laneRunId: run.runId, alerts: [{ code: "rollback-finished", title: "rollback finished", message: "The rollback to last-good finished and passed the canary. The HOLD stays until the controller clears it; no pointer was moved.", ...alertBase, verdict: "PASS" }] });
      }
      if (checked.kind === "fail") {
        return await finish({ outcome: "FAIL", exitCode: 1, reason: `the rollback itself failed its canary: ${checked.reason}`, hold: "canary-fail", report: checked.report, laneRunId: run.runId, alerts: [{ code: "rollback-failed", title: "rollback FAILED its canary", message: `${checked.reason}. There is no second automatic rollback in this HOLD: the controller decides.`, ...alertBase, verdict: "FAIL" }] });
      }
      return await inconclusive(`the rollback canary: ${checked.kind === "cap" ? checked.reason : checked.reason}`, { report: checked.kind === "inconclusive" ? checked.report : null, laneRunId: run.runId });
    }

    // 2. The cap: one ledger for both pipelines. A ledger that cannot be read means "do not spend", which is INCONCLUSIVE, never a canary past the cap.
    let claim;
    try {
      claim = await claimSlot(ports, ctx.kind, ctx.executionId);
    } catch (error) {
      return await inconclusive(`the canary cap ledger could not be read or written (${errorText(error)}), so no canary was started`);
    }
    if (claim.state === "cap") {
      return await finish({
        outcome: "SKIPPED-CAP",
        exitCode: 0,
        reason: `canary skipped: cap ${CANARY_CAP}/24h reached (n=${claim.n})`,
        cap: claim.n,
        alerts: [{ code: "canary-skipped-cap", title: `canary skipped: cap ${CANARY_CAP}/24h reached`, message: `canary skipped: cap ${CANARY_CAP}/24h reached (n=${claim.n}). The deploy is installed but unproven: last-good did not move, so a later rollback goes back to the last canaried sha. The 89 audit lists this run.`, ...alertBase, verdict: "SKIPPED-CAP" }],
      });
    }

    // 3. The real task.
    const verdict = await runLane(ports, run);
    const checked = await afterLane(ports, verdict, startedMs);
    if (checked.kind === "fail") {
      return await finish({ outcome: "FAIL", exitCode: 1, reason: checked.reason, hold: "canary-fail", cap: claim.n, report: checked.report, laneRunId: run.runId, alerts: [{ code: "canary-fail", title: "canary FAIL", message: `${checked.reason}. A HOLD is set. A rollback to last-good follows only if the rollback guards allow it; it never goes to an unproven (SKIPPED-CAP) run.`, ...alertBase, verdict: "FAIL" }] });
    }
    if (checked.kind === "cap") return await inconclusive(checked.reason, { cap: claim.n, laneRunId: run.runId });
    if (checked.kind === "inconclusive") return await inconclusive(checked.reason, { cap: claim.n, report: checked.report, laneRunId: run.runId });

    // 4. PASS: last-good moves here and only here, execution id first, then the sha (a crash between them leaves a pair the rollback guard refuses). The installed pointer is
    //    read again: a run that is no longer the installed one proves nothing for last-good.
    const again = await ports.getParameter(names.installed);
    if (again !== ctx.sha) return await inconclusive("the installed pointer changed during the canary, so last-good was not moved", { cap: claim.n, report: checked.report, laneRunId: run.runId });
    try {
      await ports.putPointer(names.lastGoodExecution, ctx.executionId);
      await ports.putPointer(names.lastGood, ctx.sha);
    } catch (error) {
      return await inconclusive(`the canary passed but last-good could not be written (${errorText(error)})`, { cap: claim.n, report: checked.report, laneRunId: run.runId });
    }
    return await finish({ outcome: "PASS", exitCode: 0, reason: "the canary passed; last-good moved", cap: claim.n, report: checked.report, lastGoodMoved: true, laneRunId: run.runId, alerts: [] });
  } catch (error) {
    return inconclusive(`the canary hit an unexpected error (${errorText(error)})`);
  }
}

/** A lane PASS still needs Lambda Errors = 0 over the canary's window; a count that cannot be read, or is not zero, is not proof (INCONCLUSIVE, a human looks). */
async function afterLane(ports: CanaryPorts, verdict: LaneVerdict, startedMs: number): Promise<LaneVerdict> {
  if (verdict.kind !== "pass") return verdict;
  let errors: number | null;
  try {
    errors = await ports.lambdaErrors(startedMs, ports.nowMs());
  } catch {
    errors = null;
  }
  if (errors === null) return { kind: "inconclusive", reason: "the lane passed but Lambda Errors could not be read", report: verdict.report, runId: verdict.runId };
  if (errors > 0) return { kind: "inconclusive", reason: `the lane passed but Lambda Errors was ${errors} during the canary`, report: verdict.report, runId: verdict.runId };
  return verdict;
}
