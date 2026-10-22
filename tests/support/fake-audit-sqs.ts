// An in-memory SQS FIFO intake queue for the audit outbox tests: the SendMessageBatch call, with the queue's
// deduplication on (message group, deduplication id), and the failure modes a test needs.
import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";

export interface FakeQueuedMessage { groupId: string; dedupId: string; body: string }

export class FakeAuditSqs {
  /** Every SendMessageBatch call's entries, in order, accepted or not. */
  readonly calls: Array<Array<{ Id: string; MessageGroupId: string; MessageDeduplicationId: string; MessageBody: string }>> = [];
  /** What the queue holds: an accepted entry whose group and deduplication id were seen before is not queued twice. */
  readonly queue: FakeQueuedMessage[] = [];
  /** `ok`; `hang` (a call never resolves); `throw` (a call throws, as an outage does). */
  mode: "ok" | "hang" | "throw" = "ok";
  /** Deduplication ids reported back as Failed entries. */
  readonly rejected = new Set<string>();
  /** Called at the start of every call, before the mode applies. */
  onCall: (() => void) | undefined;
  private readonly seen = new Set<string>();

  readonly client = { send: (command: unknown) => this.send(command) } as unknown as SQSClient;

  private async send(command: unknown): Promise<unknown> {
    if (!(command instanceof SendMessageBatchCommand)) throw new Error("FakeAuditSqs only supports SendMessageBatch");
    const entries = (command.input.Entries ?? []) as Array<{ Id: string; MessageGroupId: string; MessageDeduplicationId: string; MessageBody: string }>;
    if (entries.length > 10) throw Object.assign(new Error("TooManyEntriesInBatchRequest"), { name: "TooManyEntriesInBatchRequest" });
    this.calls.push(entries);
    this.onCall?.();
    if (this.mode === "hang") return new Promise(() => undefined);
    if (this.mode === "throw") throw Object.assign(new Error("queue unavailable"), { name: "ServiceUnavailable" });
    const Successful: Array<{ Id: string }> = [];
    const Failed: Array<{ Id: string; SenderFault: boolean; Code: string }> = [];
    for (const entry of entries) {
      if (this.rejected.has(entry.MessageDeduplicationId)) {
        Failed.push({ Id: entry.Id, SenderFault: false, Code: "InternalError" });
        continue;
      }
      const key = `${entry.MessageGroupId}|${entry.MessageDeduplicationId}`;
      if (!this.seen.has(key)) {
        this.seen.add(key);
        this.queue.push({ groupId: entry.MessageGroupId, dedupId: entry.MessageDeduplicationId, body: entry.MessageBody });
      }
      Successful.push({ Id: entry.Id });
    }
    return { Successful, Failed };
  }

  /** How many entries were offered, counting repeats. */
  offered(): number {
    return this.calls.reduce((total, call) => total + call.length, 0);
  }
}
