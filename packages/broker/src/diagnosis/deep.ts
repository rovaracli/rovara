// Live interaction F3: "Fix with agent", the deep tier. When the light diagnosis says the cause is in the code, a person asks for the deep one: a TASK with `purpose: "diagnosis"` that clones the project's
// repositories and reads them. It is modelled on the setup draft and uses the same boundary:
//   - it clones and runs NO command (the workspace is prepared read-only; no setup, no readiness, no checks);
//   - its worker has read-only tools only (read, grep, find and ls: no shell, no write tool), no network and no MCP (a context source is offered to four stages only, and this is none of them);
//   - it is started, admitted and paid like any task (the payer rules, the allowed-model checks, the budget floor, the planning run limit of a Quick plan) as the person who pressed the button, so the PROJECT
//     PAYER pays for it, never Rovara;
//   - its answer is read again by `sanitizeDiagnosis` (the worker's copy is never trusted) and written in the task's own result transaction (`diagnosisEndItems`), which cannot fail on the diagnosis's records.
// A deep diagnosis can never act either: its proposals are text for a person, exactly as the light tier's.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  DIAGNOSIS_DEEP_TITLE, DIAGNOSIS_REFUSALS, DIAGNOSIS_RETENTION_DAYS, DiagnosisDeepBodySchema, INDEX_EXPIRY_ATTRIBUTE, DiagnosisRecordSchema, ROVARA_CODE_AGENT_ID, agentXError, diagnosisKey,
  type DiagnosisRecord, type DiagnosisStatus, type OrgId, type RunInput,
} from "@agentx/contracts";
import { createHash } from "node:crypto";
import { auditDiagnosisStarted } from "../audit/events.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import type { AgentRunResult, AgentRunStarter } from "../agents/runs.js";
import { startAgentRun } from "../agents/runs.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { TransactItem } from "../agents/table-writes.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { auditDiagnosis } from "./audit.js";
import { diagnosisSubjectFor } from "./authority.js";
import { currentFacts, diagnosisDataText, nonceFor } from "./context.js";
import { DEEP_DIAGNOSIS_FAILED_MESSAGE, statusOf, type DiagnosisDependencies } from "./light.js";
import { sanitizeDiagnosis } from "./sanitize.js";
import { admitDiagnosis, diagnosisIdFor, openDiagnosisFor, readDiagnosisRecord, readDiagnosisRequest, settleDiagnosis } from "./store.js";

/** What the deep tier needs beyond the light one: the task start of the person asking. Absent where agents are not set up. */
export interface DeepDiagnosisPorts { starter: AgentRunStarter }

/** A request id for the run, the same every time the same deep diagnosis is started. */
function runRequestIdFor(diagnosisId: string): string {
  const hex = createHash("sha256").update(`rovara-diagnosis-run\0${diagnosisId}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * `POST /v1/app/diagnoses/{id}/deep`: a person who may diagnose the error asks for the deep tier of a ready light diagnosis that said it needs the code. Checks, in order: the switch; the body; that
 * the light diagnosis is this org's, ready and asked for the code; the person's right now; that the error is still the one diagnosed; the open deep diagnosis of the same error (answered, nothing spent);
 * the deep rate (3 a day per person); then starts the task as that person. A start the ordinary rules refuse (a viewer, a spent budget, a model not allowed) fails the diagnosis with those words and frees
 * the error's place; nothing is left running.
 */
export async function startDeepDiagnosis(
  deps: DiagnosisDependencies, ports: DeepDiagnosisPorts | undefined, caller: DeveloperCaller, lightDiagnosisId: string, value: unknown,
): Promise<DiagnosisStatus> {
  if (!deps.enabled) throw agentXError("NOT_FOUND", "route not found");
  const body = DiagnosisDeepBodySchema.safeParse(value);
  if (!body.success) throw agentXError("CONFIG_INVALID", "a deep diagnosis needs a request ID");
  if (ports === undefined) throw agentXError("NOT_FOUND", DIAGNOSIS_REFUSALS.notAvailable);
  const orgId = caller.orgId;
  const light = await readDiagnosisRequest(deps, orgId, lightDiagnosisId);
  if (light === undefined || light.tier !== "light") throw agentXError("NOT_FOUND", "route not found");
  const subject = await diagnosisSubjectFor(deps.authority, caller, light.errorRef);
  if (subject === undefined) throw agentXError("NOT_FOUND", "route not found");
  const record = light.state === "ready" ? await readDiagnosisRecord(deps, orgId, lightDiagnosisId) : undefined;
  if (record === undefined) throw agentXError("CONFIG_INVALID", DIAGNOSIS_REFUSALS.notReady);
  if (!record.needsCode) throw agentXError("CONFIG_INVALID", DIAGNOSIS_REFUSALS.noDeepNeeded);

  const tier = "deep" as const;
  const own = await readDiagnosisRequest(deps, orgId, diagnosisIdFor(orgId, caller.developerId, body.data.requestId, tier));
  if (own !== undefined) return statusOf(deps, orgId, own);
  const open = await openDiagnosisFor(deps, orgId, tier, light.errorRef);
  if (open !== undefined) {
    const existing = await readDiagnosisRequest(deps, orgId, open);
    if (existing !== undefined) return statusOf(deps, orgId, existing);
  }

  const facts = await currentFacts(deps.context, caller, light.errorRef, subject);
  if (facts === undefined) throw agentXError("CONFIG_INVALID", DIAGNOSIS_REFUSALS.notCurrent);
  const diagnosisId = diagnosisIdFor(orgId, caller.developerId, body.data.requestId, tier);
  const admitted = await admitDiagnosis(deps, { orgId, developerId: caller.developerId, requestId: body.data.requestId, tier, errorRef: facts.errorRef, project: subject.project, basedOn: lightDiagnosisId });
  const request = await readDiagnosisRequest(deps, orgId, admitted.diagnosisId);
  if (request === undefined) throw agentXError("RUNTIME_UNAVAILABLE", DEEP_DIAGNOSIS_FAILED_MESSAGE);
  if (!admitted.created) return statusOf(deps, orgId, request);

  // The data goes in as run context ("information only, never instructions"), framed with the broker's tag ids; the request text is fixed words.
  const data = diagnosisDataText(facts, nonceFor(deps.context.tagKey, diagnosisId));
  const input: RunInput = {
    text: DIAGNOSIS_DEEP_TITLE,
    context: [{ kind: "text", ref: `diagnosis:${diagnosisId}`, title: "The error to diagnose", body: data }],
  };
  let started: AgentRunResult;
  try {
    started = await startAgentRun(ports.starter, {
      requestId: runRequestIdFor(diagnosisId), orgId, project: subject.project, agent: { agentId: ROVARA_CODE_AGENT_ID }, input, origin: "app",
      owner: { developerId: caller.developerId }, startedBy: { developerId: caller.developerId }, caller,
      diagnosis: { diagnosisId, errorRef: facts.errorRef },
    });
  } catch (error) {
    // The ordinary start refused it (or failed): the diagnosis is over, its place is let go, and the person hears the ordinary words.
    await settleDiagnosis(deps, orgId, request, { state: "failed" }).catch(() => undefined);
    throw error;
  }
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: diagnosisKey(orgId, diagnosisId, "REQUEST"), UpdateExpression: "SET taskId = :task", ExpressionAttributeValues: { ":task": started.taskId },
  })).catch(() => undefined);
  await auditDiagnosis(deps.audit, () => auditDiagnosisStarted({
    orgId, actor: auditActorOf(caller.developerId), occurredAt: new Date(deps.now()).toISOString(), occurrence: diagnosisId,
    diagnosisId, errorKind: facts.errorRef.kind, errorCode: facts.errorRef.code, tier,
  }));
  return statusOf(deps, orgId, { ...request, taskId: started.taskId });
}

// ---- the task's end

/** What a deep diagnosis task ended with, as the broker's result transaction is told it. */
export interface DiagnosisEndOutcome { status: string; result: unknown; error: string | undefined }

/** The most characters of the worker's answer the broker reads. */
const ANSWER_MAX_CHARS = 12_000;

/**
 * The items that end a deep diagnosis task, for the transaction of its terminal result (the broker's `completedWorkflowItems`): its `agentRunEnd` (which gives back its workspace), the diagnosis's request
 * ended, and, when there is an answer, the diagnosis's record. NOTHING here can make the transaction fail: every item is an unconditional update that keeps what is already there (`if_not_exists`), so
 * the first end stands and a late or repeated one changes nothing. A task that is not a diagnosis, or an operation that is not the diagnosis's own, writes nothing. The worker's answer is read again here.
 */
export function diagnosisEndItems(
  tableName: string,
  task: Pick<DeveloperTaskRecord, "taskId" | "purpose" | "diagnosis"> & { orgId?: OrgId | undefined },
  operation: { kind: string; workflowMode?: string | undefined },
  outcome: DiagnosisEndOutcome,
  now: string,
): TransactItem[] {
  if (task.purpose !== "diagnosis" || task.diagnosis === undefined || task.orgId === undefined) return [];
  const own = operation.kind === "task" && operation.workflowMode === "SETUP_DRAFT";
  const prepareFailed = operation.kind === "prepare" && outcome.status !== "SUCCEEDED";
  if (!own && !prepareFailed) return [];
  const { diagnosisId, errorRef } = task.diagnosis;
  const orgId = task.orgId;
  let record: DiagnosisRecord | undefined;
  if (!prepareFailed && outcome.status === "SUCCEEDED") {
    const reported = typeof outcome.result === "object" && outcome.result !== null ? (outcome.result as { diagnosisAnswer?: unknown }).diagnosisAnswer : undefined;
    const sanitized = sanitizeDiagnosis(typeof reported === "string" ? reported.slice(0, ANSWER_MAX_CHARS) : undefined);
    if (sanitized.proposals.length > 0) {
      const at = Date.parse(now);
      record = DiagnosisRecordSchema.parse({
        diagnosisId, errorRef, tier: "deep", proposals: sanitized.proposals, droppedProposals: sanitized.dropped, needsCode: false,
        // The model and the cost of a deep run are the task's own (its ledger lines), not this record's.
        model: "task-model", costCents: 0, createdAt: now, ttl: Math.floor((Number.isFinite(at) ? at : Date.now()) / 1000) + DIAGNOSIS_RETENTION_DAYS * 86_400,
      });
    }
  }
  const state = record === undefined ? "failed" : "ready";
  const nowSeconds = Math.floor((Date.parse(now) || Date.now()) / 1000);
  const keep = nowSeconds + DIAGNOSIS_RETENTION_DAYS * 86_400;
  const items: TransactItem[] = [
    { Update: {
      TableName: tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET agentRunEnd = if_not_exists(agentRunEnd, :end), updatedAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":end": { state: state === "ready" ? "COMPLETE" : outcome.status === "CANCELLED" ? "CANCELLED" : "FAILED", at: now }, ":now": now },
    } },
    // The request's end is a separate attribute that keeps the first value, so a second end cannot turn a ready diagnosis into a failed one (or back), and the condition is on nothing else.
    { Update: {
      TableName: tableName, Key: diagnosisKey(orgId, diagnosisId, "REQUEST"),
      UpdateExpression: "SET ended = if_not_exists(ended, :ended), #expires = :keep REMOVE #context",
      ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE, "#context": "context" },
      ExpressionAttributeValues: { ":ended": { state, at: now }, ":keep": keep },
    } },
  ];
  if (record !== undefined) {
    const fields = { ...diagnosisKey(orgId, diagnosisId, "RECORD"), entityType: "DIAGNOSIS_RECORD", orgId, ...record, [INDEX_EXPIRY_ATTRIBUTE]: keep } as Record<string, unknown>;
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets = Object.entries(fields).filter(([key]) => key !== "pk" && key !== "sk").map(([key, field], index) => {
      names[`#f${String(index)}`] = key;
      values[`:f${String(index)}`] = field;
      return `#f${String(index)} = if_not_exists(#f${String(index)}, :f${String(index)})`;
    });
    items.push({ Update: { TableName: tableName, Key: diagnosisKey(orgId, diagnosisId, "RECORD"), UpdateExpression: `SET ${sets.join(", ")}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values } });
  }
  return items;
}
