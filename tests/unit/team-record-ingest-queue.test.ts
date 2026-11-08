import { describe, expect, it } from "vitest";
import type { SendMessageCommand } from "@aws-sdk/client-sqs";
import { QUEUE_REQUIREMENTS, createOpConsumer, createQueuedDistiller, createQueuedHumanEditJobs, createQueuedSink, createSqsOpQueue, OP_MAX_BYTES, TRANSIENT_MAX_RECEIVES, type RecordOp, type RecordOpQueue } from "../../packages/broker/src/team-record/sources/queue.js";
import { createSlackRecordTap } from "../../packages/broker/src/team-record/sources/slack.js";
import { createCodeHostTap, repoScope, type CodeHostRepo } from "../../packages/broker/src/team-record/sources/codehost.js";
import type { RecordDraft } from "../../packages/broker/src/team-record/sources/ports.js";
import { sha, world, WS } from "../support/team-record-ingest-fakes.js";

class FakeQueue implements RecordOpQueue {
  readonly sent: RecordOp[] = [];
  down = false;
  async send(op: RecordOp) {
    if (this.down) throw new Error("queue unavailable");
    this.sent.push(op);
  }
}

const draft: RecordDraft = { workspaceId: WS, source: "github", kind: "github.pr", occurredAt: "2026-10-30T10:00:00.000Z", sourceRef: { system: "github", id: "a/b#pr1", version: "v1" }, trust: "member", audience: { kind: "project" }, links: [], retention: "D", text: "hello" };
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const QUEUED_AT = new Date(NOW).toISOString();
const record = (op: unknown, receiveCount = 1, messageId = "m1") => ({ messageId, body: typeof op === "string" ? op : JSON.stringify(op), receiveCount });

describe("queued sink", () => {
  it("puts always go to the queue and answer 'queued'", async () => {
    const queue = new FakeQueue();
    const sink = createQueuedSink(queue, undefined, () => NOW);
    expect(await sink.put(draft)).toEqual({ status: "queued" });
    expect(queue.sent).toEqual([{ v: 1, op: "put", draft, queuedAt: QUEUED_AT }]);
  });

  it("a delete hides at once when it can, and is queued for retry when the direct write fails: it is never dropped", async () => {
    const w = world();
    const queue = new FakeQueue();
    const sink = createQueuedSink(queue, w.sink);
    await sink.tombstone({ workspaceId: WS, system: "slack", scope: "slack:T1", cause: "source_deleted" });
    expect(w.sink.tombstones).toHaveLength(1);
    expect(queue.sent).toEqual([]);
    w.sink.tombstone = async () => { throw new Error("table down"); };
    w.sink.changePrincipals = async () => { throw new Error("table down"); };
    w.sink.replaceScopeAudience = async () => { throw new Error("table down"); };
    await sink.tombstone({ workspaceId: WS, system: "slack", sourceIds: ["C1/1.1"], cause: "source_deleted" });
    await sink.changePrincipals({ workspaceId: WS, scope: "slack:T1/G1", add: ["U1"], at: "t" });
    await sink.replaceScopeAudience({ workspaceId: WS, scope: "slack:T1/G1", audience: { kind: "project" }, at: "t" });
    expect(queue.sent.map((op) => op.op)).toEqual(["tombstone", "principals", "audience"]);
  });

  it("without a direct path a delete is a queue message, and a queue that is down is an error the tap sees, not a silent drop", async () => {
    const queue = new FakeQueue();
    const sink = createQueuedSink(queue);
    await sink.tombstone({ workspaceId: WS, system: "slack", scope: "slack:T1", cause: "source_deleted" });
    expect(queue.sent).toHaveLength(1);
    queue.down = true;
    await expect(sink.tombstone({ workspaceId: WS, system: "slack", scope: "slack:T1", cause: "source_deleted" })).rejects.toThrow();
  });

  it("a code-host delete survives a record outage: the tap's tombstone ends up on the queue", async () => {
    const w = world();
    const queue = new FakeQueue();
    const repo: CodeHostRepo = { host: "github", id: "77", fullName: "acme/shop", isPrivate: true, workspaceId: WS, project: "shop" };
    const tap = createCodeHostTap({ sink: createQueuedSink(queue), actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config });
    await tap.handle({ type: "repository", repo, action: "deleted", at: "t" });
    expect(queue.sent).toEqual([{ v: 1, op: "tombstone", workspaceId: WS, system: "github", scope: repoScope(repo), cause: "source_deleted" }]);
  });
});

describe("retention B text", () => {
  it("Public notes-with-links text goes to the distiller queue, never to the ops queue, and nothing is stored", async () => {
    const w = world();
    w.config.set("slack", "slack:T0TEAM00001/C0123456789", { retention: "B" });
    const queue = new FakeQueue();
    const tap = createSlackRecordTap({
      edition: "public", sink: createQueuedSink(queue), distiller: createQueuedDistiller(queue), actors: w.actors, mode: w.mode, config: w.config, notesOptIn: async () => true,
      resolveWorkspace: async () => ({ workspaceId: WS }), directory: { channelInfo: async () => ({ kind: "public", extShared: false }) },
    });
    await tap({ type: "event_callback", team_id: "T0TEAM00001", event: { type: "message", channel: "C0123456789", user: "U0ALICE0001", text: "we pin the base image", ts: "1758657600.000200" } });
    expect(queue.sent.map((op) => op.op)).toEqual(["distill"]);
    const adapted: Array<{ QueueUrl?: string | undefined }> = [];
    const sqs = createSqsOpQueue({ client: { send: async (command: SendMessageCommand) => { adapted.push(command.input); } }, opsQueueUrl: "https://sqs/ops", transientQueueUrl: "https://sqs/transient" });
    await sqs.send(queue.sent[0]!);
    await sqs.send({ v: 1, op: "put", draft });
    expect(adapted.map((input) => input.QueueUrl)).toEqual(["https://sqs/transient", "https://sqs/ops"]);
  });

  it("refuses a message over the size limit instead of truncating it", async () => {
    const sqs = createSqsOpQueue({ client: { send: async () => undefined }, opsQueueUrl: "u", transientQueueUrl: "t" });
    await expect(sqs.send({ v: 1, op: "put", draft: { ...draft, text: "x".repeat(OP_MAX_BYTES) } })).rejects.toThrow(/too large/);
  });
});

describe("consumer", () => {
  function consumerWorld() {
    const w = world();
    const handled: unknown[] = [];
    const logs: string[] = [];
    const consumer = createOpConsumer({ sink: w.sink, distiller: w.distiller, humanEdit: async (job) => { handled.push(job); }, log: (event) => logs.push(event), now: () => NOW });
    return { w, consumer, handled, logs };
  }

  it("applies each kind of op to the real ports", async () => {
    const { w, consumer, handled } = consumerWorld();
    const ops: RecordOp[] = [
      { v: 1, op: "put", draft, queuedAt: QUEUED_AT },
      { v: 1, op: "tombstone", workspaceId: WS, system: "slack", sourceIds: ["C1/1.1"], cause: "source_deleted" },
      { v: 1, op: "principals", workspaceId: WS, scope: "slack:T/G", add: ["U1"], at: "t" },
      { v: 1, op: "audience", workspaceId: WS, scope: "slack:T/G", audience: { kind: "project" }, at: "t" },
      { v: 1, op: "distill", draft: { ...draft, text: "note" } },
    ];
    const result = await consumer.processBatch(ops.map((op, i) => record(op, 1, `m${i}`)));
    expect(result.batchItemFailures).toEqual([]);
    expect(w.sink.puts).toHaveLength(1);
    expect(w.sink.tombstones).toHaveLength(1);
    expect(w.sink.principalChanges).toHaveLength(1);
    expect(w.sink.audienceReplacements).toHaveLength(1);
    expect(w.distiller.received).toHaveLength(1);
    const jobs = new FakeQueue();
    await createQueuedHumanEditJobs(jobs).enqueue({ repo: { host: "github", id: "1", fullName: "a/b", isPrivate: false, workspaceId: WS }, project: "p", taskId: "t", pullRequest: { number: 1, url: "https://x" }, candidateHeadSha: sha(1), headSha: sha(2) });
    await consumer.processBatch(jobs.sent.map((op) => record(op)));
    expect(handled).toHaveLength(1);
  });

  it("a human-edit op with no handler (production: a model call has no place in this consumer) is dropped with one fixed line, never run, never retried", async () => {
    const w = world();
    const logs: string[] = [];
    const consumer = createOpConsumer({ sink: w.sink, distiller: w.distiller, log: (event) => logs.push(event), now: () => NOW });
    const jobs = new FakeQueue();
    await createQueuedHumanEditJobs(jobs).enqueue({ repo: { host: "github", id: "1", fullName: "a/b", isPrivate: false, workspaceId: WS }, project: "p", taskId: "t", pullRequest: { number: 1, url: "https://x" }, candidateHeadSha: sha(1), headSha: sha(2) });
    expect(jobs.sent).toHaveLength(1);
    expect((await consumer.processBatch(jobs.sent.map((op) => record(op)))).batchItemFailures).toEqual([]);
    expect(logs).toEqual(["record.human_edit_op_dropped"]);
  });

  it("a failed op is retried by the queue (reported as a partial-batch failure); the rest of the batch goes on", async () => {
    const { w, consumer, logs } = consumerWorld();
    let failures = 1;
    const put = w.sink.put.bind(w.sink);
    w.sink.put = async (d) => { if (failures > 0) { failures -= 1; throw new Error("table down"); } return put(d); };
    const first = await consumer.processBatch([record({ v: 1, op: "put", draft, queuedAt: QUEUED_AT }, 1, "a"), record({ v: 1, op: "tombstone", workspaceId: WS, system: "x", scope: "x:1", cause: "source_deleted" }, 1, "b")]);
    expect(first.batchItemFailures).toEqual([{ itemIdentifier: "a" }]);
    expect(w.sink.tombstones).toHaveLength(1);
    expect(logs).toContain("record.op_failed");
    const retry = await consumer.processBatch([record({ v: 1, op: "put", draft, queuedAt: QUEUED_AT }, 2, "a")]);
    expect(retry.batchItemFailures).toEqual([]);
    expect(w.sink.puts).toHaveLength(1);
  });

  it("drops a message it cannot read instead of blocking the queue", async () => {
    const { consumer, logs } = consumerWorld();
    const result = await consumer.processBatch([record("not json"), record({ v: 2, op: "put" }), record({ v: 1, op: "drop_tables" })]);
    expect(result.batchItemFailures).toEqual([]);
    expect(logs.filter((event) => event === "record.op_invalid")).toHaveLength(3);
  });

  it("a transient (retention B) message is retried, then dropped after three deliveries, so its text never reaches a dead-letter queue", async () => {
    const { w, consumer, logs } = consumerWorld();
    w.distiller.distillTransient = async () => { throw new Error("model down"); };
    const op: RecordOp = { v: 1, op: "distill", draft: { ...draft, text: "slack text" } };
    expect((await consumer.processBatch([record(op, 1)])).batchItemFailures).toHaveLength(1);
    expect((await consumer.processBatch([record(op, TRANSIENT_MAX_RECEIVES - 1)])).batchItemFailures).toHaveLength(1);
    expect((await consumer.processBatch([record(op, TRANSIENT_MAX_RECEIVES)])).batchItemFailures).toEqual([]);
    expect(logs).toContain("record.transient_dropped");
  });
});

describe("sink contract under a queue: arrival order never brings text back (R4)", () => {
  const slackDraft = (version: string, text: string, versionAt: string): RecordDraft => ({
    workspaceId: WS, source: "slack", kind: "slack.message", occurredAt: "2026-10-30T10:00:00.000Z", sourceRef: { system: "T1", id: "C1/1.1", version, versionAt },
    trust: "member", audience: { kind: "project" }, links: [], retention: "C", text,
  });

  it("a message posted and deleted within seconds: the delete lands first, the delayed put is refused, and the record stays empty (also on a dead-letter redrive)", async () => {
    const w = world();
    const queue = new FakeQueue();
    const sink = createQueuedSink(queue, w.sink);
    await sink.put(slackDraft("m:1.1", "oops a secret", "2026-10-30T10:00:00.000Z"));
    await sink.tombstone({ workspaceId: WS, system: "T1", sourceIds: ["C1/1.1"], cause: "source_deleted" });
    const consumer = createOpConsumer({ sink: w.sink, distiller: w.distiller, now: () => NOW });
    await consumer.processBatch(queue.sent.map((op) => ({ messageId: "m", body: JSON.stringify(op), receiveCount: 1 })));
    // A redrive of the same put later changes nothing.
    await consumer.processBatch(queue.sent.map((op) => ({ messageId: "m", body: JSON.stringify(op), receiveCount: 6 })));
    expect(w.sink.puts).toEqual([]);
    expect(await w.sink.put(slackDraft("m:1.1", "oops a secret", "2026-10-30T10:00:00.000Z"))).toMatchObject({ status: "refused" });
  });

  it("versions are ordered by their own time: an older edit that arrives late is a no-op", async () => {
    const w = world();
    const newer = slackDraft("e:2.0", "final text", "2026-10-30T10:05:00.000Z");
    const older = slackDraft("e:1.5", "first edit", "2026-10-30T10:02:00.000Z");
    expect(await w.sink.put(newer)).toEqual({ status: "stored" });
    expect(await w.sink.put(older)).toEqual({ status: "duplicate" });
    expect(w.sink.puts.map((draft) => draft.text)).toEqual(["final text"]);
  });

  it("the sink remembers the lowest trust ever stored for an item", async () => {
    const w = world();
    await w.sink.put({ ...slackDraft("m:1.1", "a", "2026-10-30T10:00:00.000Z"), trust: "outsider" });
    await w.sink.put({ ...slackDraft("e:2.0", "b", "2026-10-30T10:05:00.000Z"), trust: "member" });
    expect(await w.sink.lowestTrust({ workspaceId: WS, source: "slack", system: "T1", id: "C1/1.1" })).toBe("outsider");
  });
});

describe("queue requirements for the CDK (pinned)", () => {
  it("the transient queue is a short, encrypted buffer: visibility timeout fits three receives in the retention, no dead-letter queue, partial-batch reporting, alarms", () => {
    const t = QUEUE_REQUIREMENTS.transient;
    expect(t.visibilityTimeoutSeconds).toBeLessThanOrEqual(180);
    expect(t.visibilityTimeoutSeconds * TRANSIENT_MAX_RECEIVES).toBeLessThanOrEqual(t.retentionSeconds);
    expect(t.retentionSeconds).toBeLessThanOrEqual(15 * 60);
    expect(t.deadLetterQueue).toBe(false);
    expect(t.redriveAllowPolicy).toBe("denyAll");
    expect(t.reportBatchItemFailures).toBe(true);
    expect(t.alarms.join(" ")).toContain("record.transient_dropped");
    expect(t.alarms.join(" ")).toContain("ApproximateAgeOfOldestMessage");
    expect(QUEUE_REQUIREMENTS.ops.deadLetterQueue).toBe(true);
  });
});
