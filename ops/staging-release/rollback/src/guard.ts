// The rollback-mode guard (plan P-RB): the first action of the Release stage when the execution is a ROLLBACK (a rollback re-runs only Release, so Decide and Approve never run,
// and this is where the rollback is judged). It returns proceed only when ALL of these hold; every refusal leaves the HOLD in place, alerts, and stops the stage so nothing deploys:
//   - the HOLD is written FIRST (rollback-attempt-<exec8>): every new merge is MANUAL from then on
//   - the target is exactly the recorded last-good execution, proven by a real canary PASS (never a SKIPPED-CAP run), above the floor, strictly behind installed, artifacts present
//   - ONE rollback per HOLD (a `rollback-started-*` marker from another execution refuses)
//   - the evaluator input is checked against what this guard read itself, and the PINNED evaluator, in rollback mode, says AUTO: "routine in reverse". A non-routine row (the bad
//     release added a resource, so going back is a Remove) means STOP + alert, and the HOLD stays for the controller.
//   - the `rollback-started-<exec8>` marker is written before it returns (so a second rollback in this HOLD is refused even if this one then fails)
import { fromDecisionAlerts, publishAll, type Alert } from "../../canary/src/alerts.ts";
import { holdName, writeHold } from "../../canary/src/holds.ts";
import { HEX40, errorText, exec8, isKind, isRecord, plain } from "../../canary/src/util.ts";
import { baseName, checkTarget, holdsDir, priorRollbackStarts, readRecorded } from "./facts.ts";
import type { DecisionLike, RollbackContext, RollbackPorts } from "./types.ts";

export interface GuardResult {
  proceed: boolean;
  mode: "standard" | "rollback" | "refused";
  reasons: string[];
  decision: DecisionLike | null;
  holds: string[];
}

export async function guardRollback(ctx: RollbackContext, evaluatorInput: unknown, ports: RollbackPorts): Promise<GuardResult> {
  const reasons: string[] = [];
  const holds: string[] = [];
  let decision: DecisionLike | null = null;
  const alertBase = { pipeline: plain(ctx.kind, 10), sha: "unknown", executionId: plain(ctx.executionId, 40), s3Path: ctx.s3Path };
  const kind = ctx.kind;

  if (ctx.executionType === "STANDARD") return { proceed: true, mode: "standard", reasons: [], decision: null, holds: [] };

  const refuse = async (extra: Alert[] = [], sha = alertBase.sha): Promise<GuardResult> => {
    const unique = [...new Set(reasons)];
    if (isKind(kind)) {
      const error = await writeHold(ports, holdName(ctx.parameterPrefix, kind, "rollback-refused", ctx.executionId), plain(unique.join("; "), 300), sha, ctx.executionId);
      if (error === null) holds.push(holdName(ctx.parameterPrefix, kind, "rollback-refused", ctx.executionId));
    }
    const alerts: Alert[] = [
      { code: "rollback-refused", title: "rollback REFUSED", message: `The rollback did not deploy: ${plain(unique.join("; "), 900)}. The HOLD stays; the controller decides.`, ...alertBase, sha, verdict: "REFUSED" },
      ...extra,
    ];
    await publishAll(ports, ctx.topics, alerts);
    const result: GuardResult = { proceed: false, mode: "refused", reasons: unique, decision, holds };
    writeOut(ports, result);
    return result;
  };

  if (ctx.executionType !== "ROLLBACK") {
    reasons.push(`the execution type "${plain(ctx.executionType, 20)}" is neither STANDARD nor ROLLBACK`);
    return refuse();
  }
  if (!isKind(kind)) {
    reasons.push("the pipeline kind is neither code nor cloud");
    return refuse();
  }
  const prefix = ctx.parameterPrefix;

  // 1. The HOLD first: before any check, so it exists whatever happens next.
  const attempt = holdName(prefix, kind, "rollback-attempt", ctx.executionId);
  const attemptError = await writeHold(ports, attempt, "a rollback execution started", "unknown", ctx.executionId);
  if (attemptError !== null) {
    reasons.push(`the HOLD could not be written (${attemptError}): a rollback never deploys without one`);
    return refuse();
  }
  holds.push(attempt);

  try {
    // 2. Facts this guard reads itself.
    const rec = await readRecorded(ports, prefix, kind);
    const sha = rec.lastGood !== null && HEX40.test(rec.lastGood) ? rec.lastGood : "unknown";
    alertBase.sha = sha;
    const now = await ports.getExecution(ctx.executionId);
    if (now.executionType !== "ROLLBACK") reasons.push("CodePipeline does not report this execution as a ROLLBACK");
    reasons.push(...(await checkTarget(ports, rec, now.rollbackTargetId)));
    const currentHolds = await ports.listHolds(holdsDir(prefix, kind));
    const prior = priorRollbackStarts(currentHolds, exec8(ctx.executionId));
    if (prior.length > 0) reasons.push(`one automatic rollback per HOLD: ${prior.length} already started (${prior.map(baseName).join(", ")})`);

    // 3. The evaluator input is assembled by someone else (git facts, change sets): what it says about the sha, the pipeline, the installed sha and the rollback must match what this
    //    guard read itself. The facts the guard owns (the holds, the prior rollbacks) are NOT taken from it: the guard puts its own reading in before the evaluator runs.
    const input = isRecord(evaluatorInput) ? evaluatorInput : null;
    const trigger = input !== null && isRecord(input.trigger) ? input.trigger : null;
    const rb = trigger !== null && isRecord(trigger.rollback) ? trigger.rollback : null;
    if (input === null) reasons.push("the evaluator input is not an object");
    else {
      if (input.pipeline !== kind) reasons.push("the evaluator input is for another pipeline");
      if (input.sha !== rec.lastGood) reasons.push("the evaluator input's sha is not the recorded last-good sha");
      if (input.previousInstalledSha !== rec.installed) reasons.push("the evaluator input's installed sha is not the recorded installed sha");
      if (trigger === null || trigger.kind !== "rollback" || rb === null) reasons.push("the evaluator input is not in rollback mode");
      else {
        if (rb.lastGoodSha !== rec.lastGood) reasons.push("the evaluator input's last-good sha is not the recorded one");
        if (isRecord(trigger.variables) && Object.keys(trigger.variables).length > 0) reasons.push("the evaluator input carries variables");
      }
    }
    if (input !== null && trigger !== null && rb !== null) {
      // 4. The pinned evaluator, in rollback mode: floors, no access rows, routine in reverse (every row on the allow-list), the manual-paths and requires checks over the range.
      const judged = { ...input, holdParameters: currentHolds, trigger: { ...trigger, rollback: { ...rb, priorAutoRollbacksThisHold: prior.length } } };
      decision = ports.evaluate(judged);
      if (decision.verdict !== "AUTO") reasons.push(`non-routine rollback, the evaluator says ${plain(decision.verdict, 20)}: ${plain(decision.reasons.map((r) => `${r.rule}/${r.code}`).join(", "), 300)}`);
      if (decision.sha !== rec.lastGood || decision.pipeline !== kind) reasons.push("the evaluator's decision is for another sha or pipeline");
    }
  } catch (error) {
    reasons.push(`the rollback guard hit an error (${errorText(error)})`);
  }
  const decisionAlerts = decision === null ? [] : fromDecisionAlerts(decision.alerts, alertBase);
  if (reasons.length > 0) return refuse(decisionAlerts, alertBase.sha);

  // 5. Everything passed: record the start (before any deploy) so a second rollback in this HOLD is refused.
  const started = holdName(prefix, kind, "rollback-started", ctx.executionId);
  const startedError = await writeHold(ports, started, "the rollback guard passed", alertBase.sha, ctx.executionId);
  if (startedError !== null) {
    reasons.push(`the rollback-started record could not be written (${startedError})`);
    return refuse(decisionAlerts, alertBase.sha);
  }
  holds.push(started);
  await publishAll(ports, ctx.topics, [
    { code: "rollback-started", title: "rollback STARTED", message: `Rolling ${kind} back to last-good ${alertBase.sha}. The HOLD stays until the controller clears it; every new merge is MANUAL. One automatic rollback per HOLD.`, ...alertBase, verdict: "AUTO" },
    ...decisionAlerts,
  ]);
  const result: GuardResult = { proceed: true, mode: "rollback", reasons: [], decision, holds };
  writeOut(ports, result);
  return result;
}

function writeOut(ports: RollbackPorts, result: GuardResult): void {
  try {
    ports.writeFile("rollback-guard.json", `${JSON.stringify({ schema: 1, proceed: result.proceed, mode: result.mode, reasons: result.reasons, holds: result.holds, verdict: result.decision?.verdict ?? null, decisionReasons: result.decision?.reasons ?? [], decisionAlerts: result.decision?.alerts ?? [] }, null, 2)}\n`);
    ports.writeFile("summary.txt", `${result.proceed ? "rollback guard: proceed" : `rollback guard: REFUSED (${plain(result.reasons.join("; "), 500)})`}\n`);
  } catch {
    // The stage's upload reports a missing file; the HOLD and the alerts already happened.
  }
}
