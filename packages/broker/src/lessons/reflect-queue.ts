// Lessons in production, lane 2 (WB-4): the queue a finished task's reflection waits in. The message holds ids and one fixed word only (never a person's words, a task title or any text): the org, the task, how
// the task ended and the request that asked. A worker (`reflect-worker.ts`) reads everything else fresh, so what it reflects on is what is true when it runs (an erased person, a deleted place and a changed
// project setting are all seen).
import { ChangeMessageVisibilityCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { OrgIdSchema } from "@rovara-code/contracts";
import { lessonsReflectQueueName } from "@agentx/cloud-contracts";
import { z } from "zod";
import type { HumanEditJob } from "../team-record/sources/codehost.js";

export const REFLECT_OUTCOMES = ["merged", "closed", "abandoned", "reverted"] as const;
export type ReflectOutcome = (typeof REFLECT_OUTCOMES)[number];

const IdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:#-]+$/u);
export const ReflectMessageSchema = z.object({ orgId: OrgIdSchema, taskId: IdSchema, outcome: z.enum(REFLECT_OUTCOMES), requestId: IdSchema }).strict();
export type ReflectMessage = z.infer<typeof ReflectMessageSchema>;

/**
 * Lessons capture: a human fix-up commit on a merged Rovara pull request, to be read from the code host and learned from (`team-record/sources/codehost.ts runHumanEdit`). A sibling message type on the same queue (the same
 * worker, dead-letter queue and alarms). It holds coordinates only: the company, the task, the repository's address, the pull request's number and link, and the two commits to compare. Never a diff, a file name, a
 * commit message, a person's name or any words: the worker reads the compare live and proves the authors itself. `kind` is what tells it from a reflection (which has none).
 */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PlainSchema = (max: number) => z.string().min(1).max(max).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
export const HumanEditMessageSchema = z.object({
  kind: z.literal("human_edit"),
  orgId: OrgIdSchema,
  taskId: IdSchema,
  requestId: IdSchema,
  repo: z.object({ host: IdSchema, id: PlainSchema(100), fullName: PlainSchema(200), isPrivate: z.boolean(), defaultBranch: PlainSchema(255).optional() }).strict(),
  project: PlainSchema(200),
  pullRequest: z.object({ number: z.number().int().positive(), url: PlainSchema(500).regex(/^https:\/\//u) }).strict(),
  candidateHeadSha: z.string().regex(SHA),
  headSha: z.string().regex(SHA),
  headRef: PlainSchema(255).optional(),
}).strict();
export type HumanEditMessage = z.infer<typeof HumanEditMessageSchema>;

/** The queue message of a human edit, from the tap's job. The workspace of the job is the company (a job whose workspace is not a company id is refused). */
export function humanEditMessageOf(job: HumanEditJob, requestId: string): HumanEditMessage {
  const { repo } = job;
  return HumanEditMessageSchema.parse({
    kind: "human_edit", orgId: repo.workspaceId, taskId: job.taskId, requestId,
    repo: { host: repo.host, id: repo.id, fullName: repo.fullName, isPrivate: repo.isPrivate, ...(repo.defaultBranch === undefined ? {} : { defaultBranch: repo.defaultBranch }) },
    project: job.project, pullRequest: { number: job.pullRequest.number, url: job.pullRequest.url }, candidateHeadSha: job.candidateHeadSha, headSha: job.headSha, ...(job.headRef === undefined ? {} : { headRef: job.headRef }),
  });
}

/** The job the tap's `runHumanEdit` takes, from a message. The repository's workspace and project are the message's (the company and the project the tap read from its own indexes). */
export function humanEditJobOf(message: HumanEditMessage): HumanEditJob {
  return {
    repo: { host: message.repo.host, id: message.repo.id, fullName: message.repo.fullName, isPrivate: message.repo.isPrivate, workspaceId: message.orgId, project: message.project, ...(message.repo.defaultBranch === undefined ? {} : { defaultBranch: message.repo.defaultBranch }) },
    project: message.project, taskId: message.taskId, pullRequest: message.pullRequest, candidateHeadSha: message.candidateHeadSha, headSha: message.headSha, ...(message.headRef === undefined ? {} : { headRef: message.headRef }),
  };
}

/** What the queue carries: a finished task's reflection, or a human edit. */
export type ReflectQueueMessage = ReflectMessage | HumanEditMessage;

/** The lease a human edit takes: one per task and head commit (the same identity as the tap's once-claim), in the reflections' own lease table. */
export const humanEditLeaseOutcome = (message: Pick<HumanEditMessage, "headSha">): string => `human_edit-${message.headSha}`;

/** Where a reflection (or a human edit) is sent. Throws when the queue did not take it (the caller turns that into one fixed log line). */
export interface ReflectQueue { send(message: ReflectQueueMessage): Promise<void> }

/** M1: how long a task end (or the nightly job) waits for the queue. The client gives up sooner (`reflectQueueClientConfiguration`); this is the last guard, for a client that does not. */
export const REFLECT_SEND_TIMEOUT_MS = 2000;
/** The reflect queue's own SQS client settings: two tries and 1.5 s on the request and the connection (the same kind of limits as the audit client), so a queue brownout cannot hold a task end. */
export const REFLECT_SDK_REQUEST_TIMEOUT_MS = 1500;

export function sqsReflectQueue(client: { send(command: SendMessageCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown> }, queueUrl: string, options: { timeoutMs?: number } = {}): ReflectQueue {
  const timeoutMs = options.timeoutMs ?? REFLECT_SEND_TIMEOUT_MS;
  return {
    async send(message) {
      const body = JSON.stringify("kind" in message ? HumanEditMessageSchema.parse(message) : ReflectMessageSchema.parse(message));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }), { abortSignal: AbortSignal.timeout(timeoutMs) }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("the reflection queue did not answer in time")), timeoutMs); }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

/** The worker's side of a retry: the message comes back after `seconds`, not after the queue's whole visibility timeout. Best effort (the caller ignores a failure). */
export interface ReflectVisibility { delay(receiptHandle: string, seconds: number): Promise<void> }
export function sqsReflectVisibility(client: { send(command: ChangeMessageVisibilityCommand): Promise<unknown> }, queueUrl: string): ReflectVisibility {
  return { async delay(receiptHandle, seconds) { await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds })); } };
}

/** The queue's URL, built from the install's own environment name, region and account (the same derivation as the Team record's queues). `undefined` when any is missing. */
export function reflectQueueUrlOf(env: Record<string, string | undefined>): string | undefined {
  const { AGENTX_ENV: name, AWS_REGION: region, AGENTX_ACCOUNT_ID: account } = env;
  if (!name || !region || !account) return undefined;
  return `https://sqs.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}/${account}/${lessonsReflectQueueName(name)}`;
}

/** The human edit in a queue record's body, or undefined when it is not exactly one (never throws). */
export function parseHumanEditMessage(body: string): HumanEditMessage | undefined {
  try {
    const parsed = HumanEditMessageSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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
