// The Team record's durable queue (wire-team-record fix round 1, B1): removals and edits that cannot be applied at once wait here, and the broker drains them (aws/broker/team-record-wiring.ts).
// The queue holds ids and fixed words for removals. A new version of an item (an edit) may carry text, so it is queued only where the text may be kept (runtime.ts `keepsText`): never a Slack
// message in the Public edition. The queue is encrypted, keeps a message at most 4 days and has a dead-letter queue; the message size is capped.
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { teamRecordOpsDeadLetterName, teamRecordOpsQueueName } from "@agentx/cloud-contracts";
import type { RecordOp } from "./sources/queue.js";

/** A Slack event that only removes or hides (a deleted message or channel, an uninstall): the ingress strips it to ids and sends it here without any Slack lookup. */
export type SlackRemovalOp = { v: 1; op: "slack_removal"; payload: Record<string, unknown> };
/** A project archive whose erase marker could not be written: ids and fixed words only. The consumer writes the marker and erases the project, if it is still archived (runtime.ts `drain`). */
export type EraseProjectOp = { v: 1; op: "erase_project"; workspaceId: string; project: string; cause: "project_archived" | "org_closed" };
export type QueuedOp = RecordOp | SlackRemovalOp | EraseProjectOp;
export const OPS_MESSAGE_MAX_BYTES = 200_000;

export interface OpsQueue { send(op: QueuedOp): Promise<void> }

export function sqsOpsQueue(client: { send(command: SendMessageCommand): Promise<unknown> }, queueUrl: string): OpsQueue {
  return {
    async send(op) {
      const body = JSON.stringify(op);
      if (Buffer.byteLength(body, "utf8") > OPS_MESSAGE_MAX_BYTES) throw new Error("record op is too large");
      await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
    },
  };
}

/** The queue's URL, built from the install's own environment name, region and account (the same derivation as the other fixed-name queues). `undefined` when any is missing. */
export function opsQueueUrlOf(env: Record<string, string | undefined>): string | undefined {
  const { AGENTX_ENV: name, AWS_REGION: region, AGENTX_ACCOUNT_ID: account } = env;
  if (!name || !region || !account) return undefined;
  return `https://sqs.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}/${account}/${teamRecordOpsQueueName(name)}`;
}

/** The dead-letter queue's URL, built the same way. */
export function deadLetterUrlOf(env: Record<string, string | undefined>): string | undefined {
  const { AGENTX_ENV: name, AWS_REGION: region, AGENTX_ACCOUNT_ID: account } = env;
  if (!name || !region || !account) return undefined;
  return `https://sqs.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}/${account}/${teamRecordOpsDeadLetterName(name)}`;
}

/**
 * The dead-letter queue, read only to take TEXT out of it (TRW-5 S1): a put that was dead-lettered despite the consumer's own drop (an invocation that timed out or was throttled raises the receive count
 * without the code running) holds a draft's text for 14 days outside retention and erase. The hourly job deletes those. Messages that carry no text (removals, member changes) are left for a person.
 */
export interface DeadLetterPort {
  receive(max: number): Promise<Array<{ handle: string; body: string }>>;
  remove(handle: string): Promise<void>;
}

export function sqsDeadLetters(client: { send(command: ReceiveMessageCommand | DeleteMessageCommand): Promise<unknown> }, queueUrl: string): DeadLetterPort {
  return {
    async receive(max) {
      const answer = (await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: Math.min(10, max), WaitTimeSeconds: 0, VisibilityTimeout: 60 }))) as { Messages?: Array<{ ReceiptHandle?: string; Body?: string }> };
      return (answer.Messages ?? []).flatMap((message) => (typeof message.ReceiptHandle === "string" && typeof message.Body === "string" ? [{ handle: message.ReceiptHandle, body: message.Body }] : []));
    },
    async remove(handle) { await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: handle })); },
  };
}

/** A delete that neither the table nor the durable queue took (ids only). The broker sends it to itself as an asynchronous Event, which Lambda retries twice and then hands to the broker's failure destination. */
export const TEAM_RECORD_REMOVAL_SOURCE = "agentx.team-record-removal";
export interface RemovalFallbackEvent { source: typeof TEAM_RECORD_REMOVAL_SOURCE; workspaceId: string; system: string; sourceIds?: string[]; scope?: string; cause: "source_deleted" | "person_erased" | "project_archived" | "excluded" }
export type RemovalFallback = (event: RemovalFallbackEvent) => Promise<void>;
