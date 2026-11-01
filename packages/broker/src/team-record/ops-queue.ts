// The Team record's durable queue (wire-team-record fix round 1, B1): removals and edits that cannot be applied at once wait here, and the broker drains them (aws/broker/team-record-wiring.ts).
// The queue holds ids and fixed words for removals. A new version of an item (an edit) may carry text, so it is queued only where the text may be kept (runtime.ts `keepsText`): never a Slack
// message in the Public edition. The queue is encrypted, keeps a message at most 4 days and has a dead-letter queue; the message size is capped.
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { teamRecordOpsQueueName } from "@agentx/contracts";
import type { RecordOp } from "./sources/queue.js";

/** A Slack event that only removes or hides (a deleted message or channel, an uninstall): the ingress strips it to ids and sends it here without any Slack lookup. */
export type SlackRemovalOp = { v: 1; op: "slack_removal"; payload: Record<string, unknown> };
export type QueuedOp = RecordOp | SlackRemovalOp;
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
