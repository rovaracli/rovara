// The explicit rollback (the fallback role's use): CodePipeline's native rollback goes to the LAST execution that succeeded in Release, which can be an unproven (SKIPPED-CAP) run,
// so a rollback to last-good is asked for by name: `rollback-stage --target-pipeline-execution-id <the recorded last-good execution>`. This runs under the rollback role (the
// approver principal assumes it) and does nothing but check, hold, alert and ask. The guard then re-judges the rollback inside the rollback execution; nothing here deploys.
import { publishAll } from "../../canary/src/alerts.ts";
import { holdName, writeHold } from "../../canary/src/holds.ts";
import { errorText, exec8, isKind, plain } from "../../canary/src/util.ts";
import { baseName, checkTarget, holdsDir, priorRollbackStarts, readRecorded } from "./facts.ts";
import type { RollbackContext, RollbackPorts } from "./types.ts";

export interface ExplicitResult {
  requested: boolean;
  dryRun: boolean;
  reasons: string[];
  targetExecutionId: string | null;
  sha: string | null;
}

export async function requestExplicitRollback(ctx: Pick<RollbackContext, "kind" | "parameterPrefix" | "topics" | "s3Path">, ports: RollbackPorts, options: { execute: boolean }): Promise<ExplicitResult> {
  const dryRun = !options.execute;
  const refused = (reasons: string[], targetExecutionId: string | null = null, sha: string | null = null): ExplicitResult => ({ requested: false, dryRun, reasons, targetExecutionId, sha });
  if (!isKind(ctx.kind)) return refused(["the pipeline kind is neither code nor cloud"]);
  const kind = ctx.kind;
  try {
    const rec = await readRecorded(ports, ctx.parameterPrefix, kind);
    // The target is the recorded last-good execution, never a chosen one.
    const reasons = await checkTarget(ports, rec, rec.lastGoodExecution);
    const holds = await ports.listHolds(holdsDir(ctx.parameterPrefix, kind));
    const prior = priorRollbackStarts(holds, "");
    if (prior.length > 0) reasons.push(`one automatic rollback per HOLD: ${prior.length} already started (${prior.map(baseName).join(", ")})`);
    if (reasons.length > 0) return refused(reasons, rec.lastGoodExecution, rec.lastGood);
    const target = rec.lastGoodExecution as string;
    const sha = rec.lastGood as string;
    if (dryRun) return { requested: false, dryRun, reasons: [], targetExecutionId: target, sha };
    // A person asking for a rollback is itself a reason to hold: set it before asking, so no new merge deploys meanwhile.
    const holdError = await writeHold(ports, holdName(ctx.parameterPrefix, kind, "rollback-requested", target), "an explicit rollback to last-good was requested", sha, target);
    if (holdError !== null) return refused([`the HOLD could not be written (${holdError}): a rollback never starts without one`], target, sha);
    await ports.rollbackStage(target);
    await publishAll(ports, ctx.topics, [{ code: "rollback-requested", title: "rollback REQUESTED", message: `An explicit rollback of ${kind} to last-good ${sha} (execution ${exec8(target)}) was requested. The rollback guard re-checks it before anything deploys.`, pipeline: kind, sha, executionId: target, s3Path: ctx.s3Path }]);
    return { requested: true, dryRun, reasons: [], targetExecutionId: target, sha };
  } catch (error) {
    return refused([`the explicit rollback hit an error (${plain(errorText(error), 300)})`]);
  }
}
