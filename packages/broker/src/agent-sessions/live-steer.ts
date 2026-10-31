// Live steer, broker side (the send): a message the task takes as a note is also handed, when its task's step is running right now on a worker, to that step's pi session within seconds. The note
// stays the durable record and the fallback: nothing here changes it, and a message that cannot go live (no running step, a step that takes no message, a runtime that is not an ec2 worker,
// no signing key) is simply a note, read by the next step as before.
//
// The live path is one OUTBOX item holding a signed-later `steer` invocation (the same table, stream, queue and dispatcher a cancel uses), written once per message (its id is derived from the
// message id, so a repeated request is the same item). The dispatcher (`live-steer-dispatch.ts`) delivers it and marks the message `delivered` when the worker says its session took it.
// Authority: the sender is the task's owner (`owner_instruction`, an instruction only inside the approved plan) or anyone else with "can use" (`information`, never an instruction); the worker
// words the message that way. Nothing in a message can reach a budget, a tool, a permission or an approval: the invocation has no field for them. No log line or event holds the text.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE,
  LIVE_STEER_STEPS,
  LIVE_STEER_TEXT_MAX_CHARS,
  liveSteerOperationId,
  redactText,
  type AgentSessionRecord,
  type LiveSteerStep,
  type SessionMessage,
  type WorkerInvocation,
} from "@agentx/contracts";
import { issueCapability, operationKey } from "../aws/cancellation.js";
import { taskPointerKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { SteerDependencies } from "./steer.js";

export interface LiveSteerDependencies extends Pick<SteerDependencies, "documentClient" | "tableName" | "now" | "log"> {
  /** The key the broker signs a worker's callback capability with; without it nothing goes live. */
  callbackSigningKey?: string | undefined;
}

/**
 * The kill switch: live steer is on only when the broker's `LIVE_STEER_ENABLED` is exactly "1" (default off). Off, `sendSessionMessage` never enqueues a live steer and a message behaves exactly
 * as it did before this feature (a note for the next step). Turn it on only after the dispatcher and the worker image that carry `task.liveSteer.v1` are live; it is also the rollback lever.
 */
export function liveSteerFromEnvironment(callbackSigningKey: string, env: Record<string, string | undefined> = process.env): { callbackSigningKey: string } | undefined {
  return env["LIVE_STEER_ENABLED"] === "1" ? { callbackSigningKey } : undefined;
}

/** How long an undelivered live steer lives in the table (its text is in it): a day is far past the dispatcher's own bounded retries. */
const OUTBOX_LIFETIME_SECONDS = 86_400;

/** What the outbox item carries beside the invocation, so the dispatcher finds the message without reading anything else. */
export interface LiveSteerOutboxFields { orgId: string; sessionId: string; messageId: string; taskId: string }

/** A person as a prompt names them: a fixed word and a short id, the same for the same person, never the name they chose (the task notes use the same label). */
export const livePersonLabel = (developerId: string): string => `person p_${createHash("sha256").update(`person\0${developerId}`, "utf8").digest("hex").slice(0, 6)}`;

type Item = Record<string, unknown>;
const getItem = async (deps: Pick<LiveSteerDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

/** The running step a message could reach, or why not: only a RUNNING Understand, Plan or Implement operation of this task, on the workspace that is busy with it, on an ec2 worker. */
async function runningStep(deps: LiveSteerDependencies, task: DeveloperTaskRecord): Promise<{ workspace: Item; operationId: string; step: LiveSteerStep } | undefined> {
  if (task.workspaceId === undefined) return undefined;
  const workspace = await getItem(deps, { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" });
  if (workspace === undefined || workspace["deploymentMode"] !== "ec2-ebs" || workspace["status"] !== "BUSY" || typeof workspace["activeOperationId"] !== "string"
    || typeof workspace["fence"] !== "number" || typeof workspace["projectRevision"] !== "number") return undefined;
  // The workspace is this task's own.
  if ((await getItem(deps, taskPointerKey(task.workspaceId)))?.["taskId"] !== task.taskId) return undefined;
  const operation = await getItem(deps, operationKey(task.workspaceId, workspace["activeOperationId"]));
  const step = LIVE_STEER_STEPS.find((candidate) => candidate === operation?.["workflowMode"]);
  if (operation === undefined || step === undefined || operation["kind"] !== "task" || operation["status"] !== "RUNNING" || operation["fence"] !== workspace["fence"] || operation["programStepId"] !== undefined) return undefined;
  return { workspace, operationId: workspace["activeOperationId"], step };
}

/**
 * Hands a message the task just took as a note to its running step, when there is one. `owner` is whether the sender is the task's effective owner. Answers whether an item was written; never
 * throws (the note is already saved, so a failure here only means the message waits for the next step), and logs only names.
 */
export async function enqueueLiveSteer(deps: LiveSteerDependencies, session: AgentSessionRecord, message: SessionMessage, task: DeveloperTaskRecord, owner: boolean): Promise<boolean> {
  // Only a task's own session has an owner whose word is an instruction; a chain's step takes the message as information.
  const authority = owner && session.subject.kind === "task" ? "owner_instruction" : "information";
  try {
    if (deps.callbackSigningKey === undefined || deps.callbackSigningKey.length < 32 || message.kind !== "steer" || message.delivery?.state !== "queued") return false;
    const running = await runningStep(deps, task);
    if (running === undefined) return false;
    const text = redactText(message.text).trim().slice(0, LIVE_STEER_TEXT_MAX_CHARS).trim();
    if (text === "") return false;
    const operationId = liveSteerOperationId(message.messageId);
    const workspaceId = String(task.workspaceId);
    const fence = running.workspace["fence"] as number;
    const invocation: WorkerInvocation = {
      protocolVersion: 1, kind: "steer", operationId, workspaceId, fence, projectRevision: running.workspace["projectRevision"] as number,
      callbackCapability: issueCapability({ callbackSigningKey: deps.callbackSigningKey }, workspaceId, operationId, fence),
      payload: { targetOperationId: running.operationId, messageId: message.messageId, step: running.step, authority, sender: livePersonLabel(message.author.developerId), text },
    };
    const fields: LiveSteerOutboxFields = { orgId: session.orgId, sessionId: session.sessionId, messageId: message.messageId, taskId: task.taskId };
    try {
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName,
        Item: {
          pk: `OUTBOX#${operationId}`, sk: "OUTBOX", id: operationId, entityType: "OUTBOX", status: "PENDING", operationId, workspaceId, deploymentMode: "ec2-ebs", invocation,
          createdAt: new Date(deps.now()).toISOString(), liveSteer: fields, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1000) + OUTBOX_LIFETIME_SECONDS,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return true;
    } catch (error) {
      // Written already (a repeat of the same message): that item is the delivery.
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  } catch (error) {
    deps.log?.({ event: "agent_session.live_steer_enqueue_failed", orgId: session.orgId, sessionId: session.sessionId, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}
