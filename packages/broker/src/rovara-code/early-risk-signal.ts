// Track record (v1.2, slice 1): the early "PR risk low" score, private to the task's owner. It is read for one task: only when the task's pull request was published with risk "low" (the risk is of the
// code now on the task and a pull request exists), from the outcome store's rate of the claim over the last 30 days. A read that fails leaves it out. The caller adds it to the task view only for the task's owner
// (`taskView`'s `actor: "owner"`); nothing here is read for a thread post, the shared card or the pull request.
import type { EarlyRiskSignal, OrgId, WorkflowSnapshot } from "@agentx/contracts";
import { errorName } from "../agents/table-writes.js";
import { readOutcomeRate } from "./outcomes.js";

export interface EarlyRiskSignalDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

/** Whether this task's pull request was published with risk low (the risk is that of the code now on the task). */
export const publishedWithLowRisk = (workflow: WorkflowSnapshot | undefined): boolean =>
  workflow?.risk?.level === "low" && workflow.candidate !== undefined && workflow.risk.candidateDigest === workflow.candidate.digest && (workflow.pullRequests ?? []).length > 0;

export async function readEarlyRiskSignal(deps: EarlyRiskSignalDependencies, task: { orgId?: OrgId | undefined; project: string; workflow?: WorkflowSnapshot | undefined }): Promise<EarlyRiskSignal | undefined> {
  if (task.orgId === undefined || !publishedWithLowRisk(task.workflow)) return undefined;
  try {
    const rate = await readOutcomeRate({ ddb: deps.documentClient, tableName: deps.tableName }, { org: task.orgId, project: task.project, stage: "risk", claim: "risk_low", now: deps.now() });
    return { held: rate.held, notHeld: rate.notHeld, closedUnmerged: rate.closedUnmerged, noOutcome: rate.noOutcome, unreviewedMerges: rate.unreviewedMerges, windowDays: 30, capped: rate.capped, enough: rate.enough };
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", level: "warn", event: "track_record.early_signal_failed", error: errorName(error) ?? "unknown" }));
    return undefined;
  }
}
