// Lessons in production, lane 2 (WB-4): the queue a finished task's reflection waits in. The message holds ids and one fixed word only (never a person's words, a task title or any text): the org, the task, how
// the task ended and the request that asked. A worker (`reflect-worker.ts`) reads everything else fresh, so what it reflects on is what is true when it runs (an erased person, a deleted place and a changed
// project setting are all seen).
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { OrgIdSchema, lessonsReflectQueueName } from "@agentx/contracts";
import { z } from "zod";

export const REFLECT_OUTCOMES = ["merged", "closed", "abandoned", "reverted"] as const;
export type ReflectOutcome = (typeof REFLECT_OUTCOMES)[number];

const IdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:#-]+$/u);
export const ReflectMessageSchema = z.object({ orgId: OrgIdSchema, taskId: IdSchema, outcome: z.enum(REFLECT_OUTCOMES), requestId: IdSchema }).strict();
export type ReflectMessage = z.infer<typeof ReflectMessageSchema>;

/** Where a reflection is sent. Throws when the queue did not take it (the caller turns that into one fixed log line). */
export interface ReflectQueue { send(message: ReflectMessage): Promise<void> }

export function sqsReflectQueue(client: { send(command: SendMessageCommand): Promise<unknown> }, queueUrl: string): ReflectQueue {
  return {
    async send(message) {
      const body = JSON.stringify(ReflectMessageSchema.parse(message));
      await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
    },
  };
}

/** The queue's URL, built from the install's own environment name, region and account (the same derivation as the Team record's queues). `undefined` when any is missing. */
export function reflectQueueUrlOf(env: Record<string, string | undefined>): string | undefined {
  const { AGENTX_ENV: name, AWS_REGION: region, AGENTX_ACCOUNT_ID: account } = env;
  if (!name || !region || !account) return undefined;
  return `https://sqs.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}/${account}/${lessonsReflectQueueName(name)}`;
}

/** The message in a queue record's body, or undefined when it is not exactly one (never throws). */
export function parseReflectMessage(body: string): ReflectMessage | undefined {
  try {
    const parsed = ReflectMessageSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
