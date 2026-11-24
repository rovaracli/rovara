// What a rollback target must be, checked the same way by the guard (inside the rollback execution) and by the explicit rollback request (before it asks for one).
import { holdDir, pointerName } from "../../canary/src/holds.ts";
import { HEX40, UUID, errorText, isRecord } from "../../canary/src/util.ts";
import type { Kind } from "../../canary/src/config.ts";
import type { RollbackPorts } from "./types.ts";

export interface Recorded {
  installed: string | null;
  lastGood: string | null;
  lastGoodExecution: string | null;
}

export async function readRecorded(ports: RollbackPorts, prefix: string, kind: Kind): Promise<Recorded> {
  const [installed, lastGood, lastGoodExecution] = await Promise.all([
    ports.getParameter(pointerName(prefix, kind, "installed")),
    ports.getParameter(pointerName(prefix, kind, "last-good")),
    ports.getParameter(pointerName(prefix, kind, "last-good-execution")),
  ]);
  return { installed, lastGood, lastGoodExecution };
}

export function baseName(parameter: string): string {
  return parameter.slice(parameter.lastIndexOf("/") + 1);
}

/** Rollbacks already started in this HOLD: one automatic rollback per HOLD. The marker lives under the hold directory, so clearing the HOLD (the human approver deletes every hold) resets it. */
export function priorRollbackStarts(holds: readonly string[], ownExecution8: string): string[] {
  return holds.filter((h) => baseName(h).startsWith("rollback-started-") && baseName(h) !== `rollback-started-${ownExecution8}`);
}

/**
 * The target must be exactly the recorded last-good execution, a STANDARD execution that Succeeded with the last-good sha as its source, with a canary record that is a real PASS
 * which moved last-good (never a SKIPPED-CAP, INCONCLUSIVE or placeholder run), with its artifacts still present, and strictly behind the installed sha. Returns the refusal reasons.
 */
export async function checkTarget(ports: RollbackPorts, rec: Recorded, targetExecutionId: string | null): Promise<string[]> {
  const reasons: string[] = [];
  if (rec.installed === null || !HEX40.test(rec.installed)) reasons.push("the installed pointer is missing or not a sha");
  if (rec.lastGood === null || !HEX40.test(rec.lastGood)) reasons.push("no last-good sha is recorded: nothing has passed a canary yet");
  if (rec.lastGoodExecution === null || !UUID.test(rec.lastGoodExecution)) reasons.push("no last-good execution id is recorded");
  if (reasons.length > 0) return reasons;
  const lastGood = rec.lastGood as string;
  const lastGoodExecution = rec.lastGoodExecution as string;
  if (rec.installed === lastGood) reasons.push("last-good is the installed sha: there is nothing to roll back to");
  if (targetExecutionId === null || !UUID.test(targetExecutionId)) {
    reasons.push("the rollback names no valid target execution");
    return reasons;
  }
  if (targetExecutionId !== lastGoodExecution) reasons.push("the rollback target is not the recorded last-good execution (a native rollback goes to the last stage success, which may be an unproven run)");
  try {
    const target = await ports.getExecution(targetExecutionId);
    if (target.executionType !== "STANDARD") reasons.push("the target execution is not a STANDARD execution (a rollback execution can never be a target)");
    if (target.status !== "Succeeded") reasons.push(`the target execution did not succeed (status ${target.status ?? "unknown"})`);
    if (target.sourceSha !== lastGood) reasons.push("the target execution's source sha is not the recorded last-good sha");
  } catch (error) {
    reasons.push(`the target execution could not be read (${errorText(error)})`);
  }
  try {
    const record = await ports.readCanaryResult(targetExecutionId);
    if (!isRecord(record)) reasons.push("the target execution has no canary record");
    else {
      if (record.result !== "PASS" || record.lastGoodMoved !== true) reasons.push(`the target's canary record is not a PASS that moved last-good (it says ${typeof record.result === "string" ? record.result : "nothing"})`);
      if (record.sha !== lastGood || record.executionId !== targetExecutionId || record.executionType !== "STANDARD") reasons.push("the target's canary record names another sha or execution");
    }
  } catch (error) {
    reasons.push(`the target's canary record could not be read (${errorText(error)})`);
  }
  try {
    if (!(await ports.releasePackagePresent(targetExecutionId))) reasons.push("the target's release artifacts are gone");
  } catch (error) {
    reasons.push(`the target's release artifacts could not be checked (${errorText(error)})`);
  }
  return reasons;
}

export function holdsDir(prefix: string, kind: Kind): string {
  return holdDir(prefix, kind);
}
