// The nightly run on the workers, broker side (NH-1; switch `nh`, with the test environment `ev`).
//
// The fire (nightly.ts `handleNightlyFire`) decides WHETHER a night runs; this module is how it STARTS one, as the ports `NightlyRunPort` asks for:
//   admit    the project's budget has room (the same `admitWork` a task meets, with the project as payer);
//   headOf   the branch's head commit as the broker's code host says (the commit the run will test; the worker refuses a workspace that holds any other);
//   startRun the shared task start (`startAgentRun`): a workspace with a read-only preparation of the default branch, the payer rules, the budget floor and the workspace limits, exactly as any task meets them.
//            The task has purpose `nightly_run`, origin `nightly` (the PROJECT pays, whatever its AI settings say about paying for tasks) and carries what it was started to run. Its first operation is the
//            verification mode (CHECKS) with the payload `nightlyRun`: no model is asked, so no model key is minted (the capability has no `model-access`).
//
// Who it runs as: a task has a member for its owner, and a night has no person. It is the person who APPROVED the environment revision (the approval is on the revision's record). If they cannot start
// work any more (left the company, lost the project) the night is skipped with `owner_unavailable`, nothing is charged and nothing is held; the next approval puts a person in their place.
//
// The task ends like a setup run: `nightlyEndItems` sets `agentRunEnd`, which gives back its workspace slot and workspace, and the run never feeds the cost estimates (it has a purpose).
import { createHash } from "node:crypto";
import { NIGHTLY_RUN_ORIGIN, NIGHTLY_RUN_PURPOSE, ROVARA_CODE_AGENT_ID, agentXError, type NightlyRunPayload, type NightlyRunWire, type NightlySkipReason, type OrgId } from "@agentx/contracts";
import type { AgentRunRequest, AgentRunResult } from "../agents/runs.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { readApprovedBy, readApprovedTestEnvironment, type TestEnvDeps } from "../org/test-environment.js";
import { BUDGET_CODES, type NightlyRunPort } from "./nightly.js";

/** The words of the task's request: the project's name and nothing from a repository. */
export const nightlyRunText = (project: string): string => `Run the nightly test baseline for the project ${project}.`;

/** The start's request id: one per slot, so a retried fire starts one run and the repeat answers the first. A version 4 shaped id made from the slot. */
export function nightlyRequestId(slotId: string): string {
  const hex = [...createHash("sha256").update(`nightly-run:${slotId}`).digest("hex").slice(0, 32)];
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

export interface NightlyRunDependencies extends TestEnvDeps {
  /** The `admitWork` of the install, with the project as payer. Throws the scope's own error when a budget has no room. */
  admitProject(input: { orgId: OrgId; project: string }): Promise<void>;
  /** The head commit of the branch, or undefined when it cannot be read. */
  headOf(input: { orgId: OrgId; project: string; branch: string }): Promise<string | undefined>;
  /** The shared run start (`startAgentRun` bound to the install's starter). */
  startAgentRun(request: AgentRunRequest): Promise<AgentRunResult>;
}

/** Why a start was refused as a night that cannot run today (not a fault the scheduler's retry would cure). */
export function skipReasonOf(error: unknown): NightlySkipReason | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code !== "string") return undefined;
  if (BUDGET_CODES.has(code) || code.startsWith("TASK_STOP_")) return "budget";
  if (code === "WORKSPACE_LIMIT") return "workspace_limit";
  if (code === "FORBIDDEN" || code === "PROJECT_ARCHIVED" || code === "PROJECT_NOT_FOUND" || code === "NOT_FOUND") return "owner_unavailable";
  return undefined;
}

export function nightlyRunPort(deps: NightlyRunDependencies): NightlyRunPort {
  return {
    admit: (input) => deps.admitProject({ orgId: input.orgId, project: input.project }),
    headOf: (input) => deps.headOf(input),
    async startRun(input) {
      const owner = await readApprovedBy(deps, input.orgId, input.project, input.envRevision);
      if (owner === undefined) return { skipped: "owner_unavailable" as const };
      const nightlyRun: NightlyRunWire = { slotId: input.slotId, envRevision: input.envRevision, branch: input.branch, headSha: input.headSha };
      try {
        await deps.startAgentRun({
          requestId: nightlyRequestId(input.slotId), orgId: input.orgId, project: input.project, agent: { agentId: ROVARA_CODE_AGENT_ID }, input: { text: nightlyRunText(input.project) },
          origin: NIGHTLY_RUN_ORIGIN, owner: { developerId: owner }, startedBy: { developerId: owner }, nightlyRun,
          // The payer is the project's (the origin says so); named here so a start that worked out another is refused, never charged to someone else.
          payer: { kind: "project", project: input.project }, payerFromRules: true,
        });
      } catch (error) {
        const reason = skipReasonOf(error);
        if (reason !== undefined) return { skipped: reason };
        throw error;
      }
      return undefined;
    },
  };
}

// ---- what the worker is sent

/**
 * The payload of the nightly operation: what the task was started to run, with the APPROVED environment of that revision read from the broker's own record now. A revision that is not there (or whose nightly branch is
 * not the one the run was started for) means the environment changed after the fire: the operation is not made, and the next fire starts from what is approved then.
 */
export async function nightlyRunPayloadOf(deps: TestEnvDeps, orgId: OrgId, project: string, run: NightlyRunWire): Promise<NightlyRunPayload> {
  const approved = await readApprovedTestEnvironment(deps, orgId, project, run.envRevision);
  if (approved === undefined || approved.environment.nightly.branch !== run.branch) throw agentXError("CHANGE_STALE", "the environment changed since this nightly run was started");
  return { ...run, environment: approved.environment };
}

// ---- the end of the task

/**
 * The items that end a nightly task, for the transaction of its terminal result (the broker's `completedWorkflowItems`): its `agentRunEnd`, which gives back its workspace. Never conditioned on anything but the
 * task being there, and the first value is kept, so a late or repeated end changes nothing. A task that is not a nightly run, or an operation that is not the run's own (or its preparation failing), writes nothing.
 */
export function nightlyEndItems(
  tableName: string,
  task: Pick<DeveloperTaskRecord, "taskId" | "purpose">,
  operation: { kind: string; workflowMode?: string | undefined },
  outcome: { status: string },
  now: string,
): Array<{ Update: { TableName: string; Key: { pk: string; sk: string }; UpdateExpression: string; ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> } }> {
  if (task.purpose !== NIGHTLY_RUN_PURPOSE) return [];
  const own = operation.kind === "task" && operation.workflowMode === "CHECKS";
  const prepareFailed = operation.kind === "prepare" && outcome.status !== "SUCCEEDED";
  if (!own && !prepareFailed) return [];
  const state = outcome.status === "SUCCEEDED" ? "COMPLETE" : outcome.status === "CANCELLED" ? "CANCELLED" : "FAILED";
  return [{ Update: {
    TableName: tableName,
    Key: taskKey(task.taskId),
    UpdateExpression: "SET agentRunEnd = if_not_exists(agentRunEnd, :end), updatedAt = :now",
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":end": { state, at: now }, ":now": now },
  } }];
}
