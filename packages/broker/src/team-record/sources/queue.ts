// The ingestion queue (DECISIONS: "Foundations: ingestion queue"). The taps never write to the record directly in production: they hand each write,
// each tombstone, each ACL change and each human-edit read to a durable queue, and a consumer applies them to the real sink with retries. That keeps
// the webhook's and Slack's answer fast, and it means a record outage cannot lose a delete (the source sends a delete only once).
//
// Two queues, by what they may hold:
//  - `ops`: puts, tombstones, ACL changes, human-edit jobs. Retention days, SSE-KMS, a dead-letter queue and an alarm on it.
//  - `transient`: Public retention B (Slack "notes with links") text for the distiller. A persisted copy of Slack text is exactly what the terms forbid, so this
//    queue holds a message for 15 minutes at most, is encrypted, and has NO dead-letter queue: after three tries the consumer drops the message and logs a
//    fixed code. (CDK for both queues belongs with the storage lane's `infra/lib/team-record.ts`; the properties are in the lane report.)
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { TEAM_RECORD_OPS_MAX_RECEIVES, TEAM_RECORD_QUEUED_PUT_MAX_AGE_MS } from "@agentx/contracts";
import type { CodeHostTapDependencies, HumanEditJob } from "./codehost.js";
import type { Audience, RecordDraft, RecordSinkPort, TapLog, TombstoneCause, TransientDistillerPort } from "./ports.js";

export type RecordOp =
  /** `queuedAt`: when the put was queued (ISO). The draft holds text, so the consumer drops a put older than a day, and one that fails at its last delivery (never dead-lettered with its text). */
  | { v: 1; op: "put"; draft: RecordDraft; queuedAt?: string }
  | { v: 1; op: "tombstone"; workspaceId: string; system: string; sourceIds?: string[]; scope?: string; cause: TombstoneCause }
  | { v: 1; op: "principals"; workspaceId: string; scope: string; add?: string[]; remove?: string[]; at: string }
  | { v: 1; op: "audience"; workspaceId: string; scope: string; audience: Audience; at: string }
  | { v: 1; op: "distill"; draft: RecordDraft & { text: string } }
  | { v: 1; op: "human_edit"; job: HumanEditJob };

/** A durable send. It throws if the message was not accepted. */
export interface RecordOpQueue {
  send(op: RecordOp): Promise<void>;
}

export const OP_MAX_BYTES = 200_000;

/**
 * What the two queues must be created with (the CDK is the storage lane's `infra/lib/team-record.ts`; these are the values it must use, and a test pins them).
 * The transient queue holds Public "notes with links" text, which is a persisted copy of Slack text for as long as it lives, so it is a short, encrypted
 * processing buffer and nothing else: Q4's legal review must cover it under that name. Without that sign-off, B stays off.
 */
export const QUEUE_REQUIREMENTS = {
  ops: {
    encryption: "SSE-KMS (customer key; the customer's key in Enterprise)",
    retentionSeconds: 4 * 86_400,
    deadLetterQueue: true,
    maxReceiveCount: 5,
    reportBatchItemFailures: true,
    alarms: ["dead-letter queue depth > 0", "ApproximateAgeOfOldestMessage > 15 minutes"],
  },
  transient: {
    encryption: "SSE-KMS (SSE-SQS at the least)",
    retentionSeconds: 15 * 60,
    /** Three receives must fit inside the retention period, so the visibility timeout is at most three minutes. */
    visibilityTimeoutSeconds: 180,
    deadLetterQueue: false,
    /** Denies the queue being named as any other queue's dead-letter target. */
    redriveAllowPolicy: "denyAll",
    reportBatchItemFailures: true,
    alarms: ["metric filter on the log event record.transient_dropped > 0", "ApproximateAgeOfOldestMessage > 5 minutes"],
    consumerNeverLogsBody: true,
  },
} as const;
/** After this many deliveries a transient (retention B) message is dropped, not dead-lettered: its text must not outlive the queue's retention. */
export const TRANSIENT_MAX_RECEIVES = 3;

/**
 * A `RecordSinkPort` that queues. Ordinary writes always go to the queue. Control operations (a delete, an ACL change) try `immediate` first when one is given, so
 * a delete hides at once, and fall back to the queue if that fails: a delete is never dropped because the table was down for a moment.
 */
export function createQueuedSink(queue: RecordOpQueue, immediate?: Pick<RecordSinkPort, "tombstone" | "changePrincipals" | "replaceScopeAudience" | "ensureAccessSeed">, now: () => number = Date.now): RecordSinkPort {
  return {
    async put(draft) {
      await queue.send({ v: 1, op: "put", draft, queuedAt: new Date(now()).toISOString() });
      return { status: "queued" };
    },
    async tombstone(input) {
      if (immediate !== undefined) {
        try {
          return await immediate.tombstone(input);
        } catch {
          // Fall through: the queue retries it.
        }
      }
      await queue.send({ v: 1, op: "tombstone", workspaceId: input.workspaceId, system: input.system, ...(input.sourceIds === undefined ? {} : { sourceIds: [...input.sourceIds] }), ...(input.scope === undefined ? {} : { scope: input.scope }), cause: input.cause });
      return { hidden: 0 };
    },
    async changePrincipals(input) {
      if (immediate !== undefined) {
        try {
          await immediate.changePrincipals(input);
          return;
        } catch {
          // Fall through.
        }
      }
      await queue.send({ v: 1, op: "principals", workspaceId: input.workspaceId, scope: input.scope, ...(input.add === undefined ? {} : { add: [...input.add] }), ...(input.remove === undefined ? {} : { remove: [...input.remove] }), at: input.at });
    },
    async ensureAccessSeed(input) {
      // Immediate only, and safe to skip: the seed is read from the source just now and a row's own snapshot seeds the unit anyway, so a failure or a missing `immediate` queues nothing.
      try { await immediate?.ensureAccessSeed?.(input); } catch { /* skipped: the first row seeds it */ }
    },
    async replaceScopeAudience(input) {
      if (immediate !== undefined) {
        try {
          await immediate.replaceScopeAudience(input);
          return;
        } catch {
          // Fall through.
        }
      }
      await queue.send({ v: 1, op: "audience", workspaceId: input.workspaceId, scope: input.scope, audience: input.audience, at: input.at });
    },
  };
}

/** Retention B text goes to the transient queue; the distiller (R8) dedupes on `idempotencyKey` because Slack and the queue both retry. */
export function createQueuedDistiller(queue: RecordOpQueue): TransientDistillerPort {
  return {
    async distillTransient(draft) {
      await queue.send({ v: 1, op: "distill", draft });
      return { accepted: true };
    },
  };
}

export function createQueuedHumanEditJobs(queue: RecordOpQueue): NonNullable<CodeHostTapDependencies["humanEditJobs"]> {
  return { enqueue: (job) => queue.send({ v: 1, op: "human_edit", job }) };
}

export interface SqsLike {
  send(command: SendMessageCommand): Promise<unknown>;
}

/** The AWS adapter: `distill` messages to the transient queue, everything else to the ops queue. A message over 200 KB is refused, not truncated. */
export function createSqsOpQueue(input: { client: SqsLike; opsQueueUrl: string; transientQueueUrl: string }): RecordOpQueue {
  return {
    async send(op) {
      const body = JSON.stringify(op);
      if (Buffer.byteLength(body, "utf8") > OP_MAX_BYTES) throw new Error("record op is too large");
      await input.client.send(new SendMessageCommand({ QueueUrl: op.op === "distill" ? input.transientQueueUrl : input.opsQueueUrl, MessageBody: body }));
    },
  };
}

export interface OpConsumerDependencies {
  sink: RecordSinkPort;
  distiller: TransientDistillerPort;
  /** Runs a human-edit read: `(job) => runHumanEdit({ ...deps, diffs }, job)`. Absent: such jobs are dropped. */
  humanEdit?: (job: HumanEditJob) => Promise<unknown>;
  log?: TapLog;
  /** Milliseconds, for the age of a queued put. Default `Date.now`. */
  now?: () => number;
}

export interface QueueRecord {
  messageId: string;
  body: string;
  receiveCount: number;
}

const OPS = new Set(["put", "tombstone", "principals", "audience", "distill", "human_edit"]);

function parseOp(body: string): RecordOp | undefined {
  try {
    const value = JSON.parse(body) as { v?: unknown; op?: unknown };
    return value !== null && typeof value === "object" && value.v === 1 && typeof value.op === "string" && OPS.has(value.op) ? (value as RecordOp) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Applies a batch of queue messages and answers in SQS's partial-batch shape: the ids to retry. A message that cannot be read is dropped (a poison message must
 * not block the queue); a failed op is retried by the queue's own redelivery and ends in the dead-letter queue. A transient (retention B) message is dropped
 * after three deliveries instead.
 */
export function createOpConsumer(deps: OpConsumerDependencies): { processBatch(records: readonly QueueRecord[]): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> } {
  const log: TapLog = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  async function apply(op: RecordOp): Promise<void> {
    switch (op.op) {
      case "put": await deps.sink.put(op.draft); return;
      case "tombstone": await deps.sink.tombstone({ workspaceId: op.workspaceId, system: op.system, ...(op.sourceIds === undefined ? {} : { sourceIds: op.sourceIds }), ...(op.scope === undefined ? {} : { scope: op.scope }), cause: op.cause }); return;
      case "principals": await deps.sink.changePrincipals({ workspaceId: op.workspaceId, scope: op.scope, ...(op.add === undefined ? {} : { add: op.add }), ...(op.remove === undefined ? {} : { remove: op.remove }), at: op.at }); return;
      case "audience": await deps.sink.replaceScopeAudience({ workspaceId: op.workspaceId, scope: op.scope, audience: op.audience, at: op.at }); return;
      case "distill": await deps.distiller.distillTransient(op.draft); return;
      case "human_edit": if (deps.humanEdit !== undefined) await deps.humanEdit(op.job); return;
    }
  }
  return {
    async processBatch(records) {
      const failures: Array<{ itemIdentifier: string }> = [];
      for (const record of records) {
        const op = parseOp(record.body);
        if (op === undefined) {
          log("record.op_invalid", {});
          continue;
        }
        // A put holds text. One that has waited more than a day (or has no time on it) is dropped unapplied.
        if (op.op === "put" && !(typeof op.queuedAt === "string" && now() - Date.parse(op.queuedAt) <= TEAM_RECORD_QUEUED_PUT_MAX_AGE_MS)) {
          log("record.put_dropped", { why: "too_old" });
          continue;
        }
        try {
          await apply(op);
        } catch {
          if (op.op === "distill" && record.receiveCount >= TRANSIENT_MAX_RECEIVES) {
            log("record.transient_dropped", {});
            continue;
          }
          // The queue's next failure would dead-letter the message for 14 days with the draft's text in it. A put is not a delete: dropping it loses a row, never a removal.
          if (op.op === "put" && record.receiveCount >= TEAM_RECORD_OPS_MAX_RECEIVES) {
            log("record.put_dropped", { why: "failed" });
            continue;
          }
          log("record.op_failed", { op: op.op, receiveCount: record.receiveCount });
          failures.push({ itemIdentifier: record.messageId });
        }
      }
      return { batchItemFailures: failures };
    },
  };
}

