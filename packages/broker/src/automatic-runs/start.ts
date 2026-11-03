// Starting an automatic run as a project's system owner (owner decision 2026-11-02). THE one function every automatic job calls to start a run: the nightly run (`test-env/nightly-run.ts`) and, from the saved-environments lane, a
// saved image's rebuild and a scheduled check. It does, in this order:
//   1. takes one place of the project's monthly cap (`claimAutomaticRun`): at the cap the run is NOT started and the answer is `{ skipped: "automatic_cap" }` (the project page says automatic runs are paused);
//   2. starts the run through the shared `startAgentRun` with the project's system owner as owner, no one as starter, the project as payer and the job in the record (`automatic`): nothing about it is a person's;
//   3. gives the place back when the run was not started (a refusal or a fault), and records the start in the audit trail ("automatic: <job>", with the person who approved the setup it runs).
// It never reads who approved the setup to decide whether the run happens: an approver who left changes nothing but a reminder on the project page (`reviewReminderOf`).
import { createHash } from "node:crypto";
import { INDEX_EXPIRY_ATTRIBUTE, projectPk, systemOwnerIdOf, type AgentId, type AutomaticJob, type NightlyRunWire, type OrgId, type RunInput, type WorkOrigin } from "@agentx/contracts";
import { auditAutomaticRunStarted, auditOccurrence } from "../audit/events.js";
import { auditTransact, tryAuditEvent } from "../audit/outbox.js";
import type { AgentRunRequest, AgentRunResult } from "../agents/runs.js";
import type { TestEnvDeps } from "../org/test-environment.js";
import { AUTOMATIC_RUNS_STARTED_PREFIX, claimAutomaticRun, releaseAutomaticRun } from "./cap.js";

export interface AutomaticRunDependencies extends TestEnvDeps {
  /** The shared run start (`startAgentRun` bound to the install's starter). */
  startAgentRun(request: AgentRunRequest): Promise<AgentRunResult>;
}

export interface AutomaticRunInput {
  orgId: OrgId;
  project: string;
  job: AutomaticJob;
  /** One run per request id: a retried start answers the first and counts once. A version 4 shaped id (`startAgentRun` checks it). */
  requestId: string;
  agent: { agentId: AgentId };
  input: RunInput;
  /** The work origin the payer rules see; the project must pay for it (a person's origin is refused). `nightly` for the nightly run, `automatic` for any other automatic job. */
  origin: Extract<WorkOrigin, "nightly" | "automatic">;
  /** The person who approved the setup this run runs (kept for the audit trail and the reminder; they own nothing). */
  setupApprovedBy?: string | undefined;
  /** The nightly run's facts, when the job is the nightly. */
  nightlyRun?: NightlyRunWire | undefined;
}

export type AutomaticRunOutcome = { started: AgentRunResult } | { skipped: "automatic_cap" };

/** Starts an automatic run, or says the project's cap has paused them. Anything else that stops the start is thrown as the shared start threw it (the caller maps a refusal; a fault may pass). */
export async function startAutomaticRun(deps: AutomaticRunDependencies, input: AutomaticRunInput): Promise<AutomaticRunOutcome> {
  const claim = await claimAutomaticRun(deps, { orgId: input.orgId, project: input.project, requestId: input.requestId, job: input.job });
  if (!claim.claimed) return { skipped: "automatic_cap" };
  let started: AgentRunResult;
  try {
    started = await deps.startAgentRun({
      requestId: input.requestId, orgId: input.orgId, project: input.project, agent: input.agent, input: input.input, origin: input.origin,
      owner: { developerId: systemOwnerIdOf(input.orgId, input.project) },
      automatic: { job: input.job, ...(input.setupApprovedBy === undefined ? {} : { approvedBy: input.setupApprovedBy }) },
      ...(input.nightlyRun === undefined ? {} : { nightlyRun: input.nightlyRun }),
      // The payer is the project's (the origin says so); named here so a start that worked out another is refused, never charged to someone else.
      payer: { kind: "project", project: input.project }, payerFromRules: true,
    });
  } catch (error) {
    // The run did not start, so it takes no place of the month. (A retried start finds the claim again.)
    await releaseAutomaticRun(deps, { orgId: input.orgId, project: input.project, requestId: input.requestId }).catch(() => undefined);
    throw error;
  }
  await recordStart(deps, input, claim.used, claim.cap, started.taskId).catch(() => undefined);
  return { started };
}

/** The audit record of the start, once per request id: the actor is Rovara (the system), the facts name the job and the person who approved the setup. Best effort: the run does not wait on its audit trail. */
async function recordStart(deps: AutomaticRunDependencies, input: AutomaticRunInput, used: number, cap: number, taskId: string): Promise<void> {
  const at = new Date(deps.now()).toISOString();
  const event = await tryAuditEvent(deps, () => auditAutomaticRunStarted({
    orgId: input.orgId, actor: { kind: "system", id: "rovara" }, occurredAt: at, occurrence: auditOccurrence(input.project, input.requestId), projectName: input.project, job: input.job, setupApprovedBy: input.setupApprovedBy, runsThisMonth: used, cap,
  }));
  if (event === undefined) return;
  const marker = { pk: projectPk(input.orgId, input.project), sk: `${AUTOMATIC_RUNS_STARTED_PREFIX}${createHash("sha256").update(input.requestId).digest("hex").slice(0, 32)}` };
  try {
    await auditTransact(deps, { Put: { TableName: deps.tableName, Item: { ...marker, entityType: "AUTOMATIC_RUN_STARTED", orgId: input.orgId, project: input.project, job: input.job, taskId, at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((deps.now() + 62 * 86_400_000) / 1000) }, ConditionExpression: "attribute_not_exists(pk)" } }, [event]);
  } catch (error) {
    // The marker is there: this start was recorded already (a retry).
    if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
  }
}
