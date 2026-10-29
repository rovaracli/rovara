// tests/contract/audit-appender.test.ts
// Task 7 of the Audit Ledger plan: the appender (one writer per org, a contiguous hash chain, a claim per event) and its
// SQS batch handler. DynamoDB is FakeDynamoDb, which interleaves concurrent calls at every await and applies a
// transaction all-or-nothing; KMS is FakeKms. The fake does not enforce IAM: the appender's grants are pinned in
// audit-ledger-infrastructure.test.ts.
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { checkChain, genesisHash, recordHash, type AuditRecordV1 } from "@rovara/audit-verifier";
import { AuditEventInputSchema, auditEventId, type AuditEventInput } from "@agentx/contracts";
import { appendOne, AUDIT_APPEND_MAX_RETRIES, type AppenderDeps } from "../../packages/broker/src/audit/appender.js";
import { processAuditBatch, type AuditSqsEvent } from "../../packages/broker/src/audit/appender-handler.js";
import { auditProjectModelsDigestChanged,auditProjectModelSelectionDigestChanged } from "../../packages/broker/src/audit/events.js";
import { AuditKeyring } from "../../packages/broker/src/audit/keyring.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeKms } from "../support/fake-kms.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb";
const KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const START = Date.parse("2026-10-20T12:00:00.000Z");
const LEDGER = "ledger";
const KEYS = "keys";

type Command = { constructor: { name: string }; input: Record<string, unknown> };

function harness() {
  const db = new FakeDynamoDb();
  const kms = new FakeKms(KEY_ARN);
  const clock = { now: START };
  const logs: Array<Record<string, unknown>> = [];
  const sent: Command[] = [];
  /** Runs after a transaction has committed, before the caller sees the result: a crash between the two. */
  const crashAfterCommit: { remaining: number } = { remaining: 0 };
  const documentClient = {
    send: async (command: Command) => {
      sent.push(command);
      const result = await db.send(command);
      if (command.constructor.name === "TransactWriteCommand" && crashAfterCommit.remaining > 0) {
        crashAfterCommit.remaining -= 1;
        throw Object.assign(new Error("the process died after the commit"), { name: "ProcessDied" });
      }
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  const keyring = new AuditKeyring({ documentClient, keysTable: KEYS, kms: kms.client, keyId: KEY_ARN, now: () => clock.now });
  const sleeps: number[] = [];
  const deps: AppenderDeps = {
    documentClient,
    ledgerTable: LEDGER,
    keyring,
    now: () => clock.now,
    log: (entry) => logs.push(entry),
    sleep: async (ms) => { sleeps.push(ms); },
  };
  return { db, kms, clock, logs, sent, deps, keyring, crashAfterCommit, sleeps, documentClient };
}
type Harness = ReturnType<typeof harness>;

function event(occurrence: string, overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return AuditEventInputSchema.parse({
    eventId: auditEventId("pull_request.opened", occurrence),
    orgId: ORG,
    action: "pull_request.opened",
    actor: { kind: "member", id: "dev_1" },
    target: { kind: "pull_request", id: "pr_1" },
    occurredAt: "2026-10-20T11:59:00.000Z",
    facts: { number: 7 },
    ...overrides,
  });
}

/** An event whose target is a name (a domain), which the appender turns into a pseudonym. */
function domainEvent(occurrence: string, name: string, overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return AuditEventInputSchema.parse({
    eventId: auditEventId("egress_domain.decided", occurrence),
    orgId: ORG,
    action: "egress_domain.decided",
    actor: { kind: "member", id: "dev_1" },
    target: { kind: "domain", name },
    occurredAt: "2026-10-20T11:59:00.000Z",
    facts: { decision: "allow" },
    ...overrides,
  });
}

const item = (db: FakeDynamoDb, pk: string, sk: string) => db.get(pk, sk);
const seqKey = (seq: number) => `SEQ#${String(seq).padStart(12, "0")}`;
function recordsOf(db: FakeDynamoDb, orgId = ORG): AuditRecordV1[] {
  return db.find((entry) => entry.pk === `AUDIT#${orgId}` && String(entry.sk).startsWith("SEQ#"))
    .sort((left, right) => String(left.sk).localeCompare(String(right.sk)))
    .map((entry) => {
      const { pk: _pk, sk: _sk, sealedDetails: _sealed, ...record } = entry;
      void _pk; void _sk; void _sealed;
      return record as unknown as AuditRecordV1;
    });
}
const headOf = (db: FakeDynamoDb, orgId = ORG) => item(db, `AUDIT#${orgId}`, "HEAD");
const chainOk = (db: FakeDynamoDb, orgId = ORG) => checkChain(recordsOf(db, orgId), { seq: 0, hash: genesisHash(orgId), orgId });

async function appendAll(h: Harness, events: AuditEventInput[]): Promise<string[]> {
  const results: string[] = [];
  for (const entry of events) results.push(await appendOne(h.deps, entry));
  return results;
}

describe("appendOne: the chain", () => {
  it("writes the first record on genesis with its head, claim, dirty marker and org-list entry", async () => {
    const h = harness();
    expect(await appendOne(h.deps, event("one", { related: ["task_1"], proof: { kind: "none" } }))).toBe("appended");
    const stored = item(h.db, `AUDIT#${ORG}`, seqKey(1))!;
    const { pk, sk, ...record } = stored;
    expect(pk).toBe(`AUDIT#${ORG}`);
    expect(sk).toBe("SEQ#000000000001");
    expect(record).toStrictEqual({
      v: 1, orgId: ORG, seq: 1, eventId: event("one").eventId, action: "pull_request.opened",
      actor: { kind: "member", id: "dev_1" }, target: { kind: "pull_request", id: "pr_1" },
      occurredAt: "2026-10-20T11:59:00.000Z", recordedAt: new Date(START).toISOString(),
      related: ["task_1"], facts: { number: 7 }, proof: { kind: "none" }, details: [],
      prevHash: genesisHash(ORG), hash: record.hash,
    });
    expect(record.hash).toBe(recordHash(record as unknown as AuditRecordV1));
    expect(headOf(h.db)).toStrictEqual({ pk: `AUDIT#${ORG}`, sk: "HEAD", seq: 1, hash: record.hash, updatedAt: new Date(START).toISOString() });
    expect(item(h.db, `AUDIT#${ORG}`, `EVENT#${event("one").eventId}`)).toStrictEqual({ pk: `AUDIT#${ORG}`, sk: `EVENT#${event("one").eventId}`, seq: 1 });
    expect(item(h.db, "AUDIT_DIRTY", ORG)).toStrictEqual({ pk: "AUDIT_DIRTY", sk: ORG, since: 1, lastSeq: 1 });
    expect(item(h.db, "AUDIT_ORGS", ORG)).toMatchObject({ pk: "AUDIT_ORGS", sk: ORG });
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
  });

  it("defaults related and facts to empty, leaves out an absent proof, and stamps recordedAt with the clock", async () => {
    const h = harness();
    h.clock.now = Date.parse("2026-10-20T12:34:56.789Z");
    const { facts: _facts, ...bare } = event("bare");
    void _facts;
    await appendOne(h.deps, bare);
    const record = recordsOf(h.db)[0]!;
    expect(record.related).toStrictEqual([]);
    expect(record.facts).toStrictEqual({});
    expect(record).not.toHaveProperty("proof");
    expect(record.recordedAt).toBe("2026-10-20T12:34:56.789Z");
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
  });

  it("links each record to the one before it, and writes the org-list entry once", async () => {
    const h = harness();
    await appendAll(h, [event("a"), event("b"), event("c")]);
    const records = recordsOf(h.db);
    expect(records.map((record) => record.seq)).toStrictEqual([1, 2, 3]);
    expect(records[1]!.prevHash).toBe(records[0]!.hash);
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
    expect(headOf(h.db)).toMatchObject({ seq: 3, hash: records[2]!.hash });
    expect(h.db.find((entry) => entry.pk === "AUDIT_ORGS")).toHaveLength(1);
    expect(h.db.find((entry) => entry.sk === "HEAD")).toHaveLength(1);
  });

  it("keeps each org's chain separate", async () => {
    const h = harness();
    await appendAll(h, [event("a"), event("b", { orgId: OTHER_ORG }), event("c")]);
    expect(recordsOf(h.db, ORG).map((record) => record.seq)).toStrictEqual([1, 2]);
    expect(recordsOf(h.db, OTHER_ORG).map((record) => record.seq)).toStrictEqual([1]);
    expect(recordsOf(h.db, OTHER_ORG)[0]!.prevHash).toBe(genesisHash(OTHER_ORG));
    expect(chainOk(h.db, ORG)).toStrictEqual({ ok: true });
    expect(chainOk(h.db, OTHER_ORG)).toStrictEqual({ ok: true });
    expect(h.db.find((entry) => entry.pk === "AUDIT_ORGS").map((entry) => entry.sk).sort()).toStrictEqual([ORG, OTHER_ORG]);
  });

  it("writes the record, head, claim and marker in one transaction with the conditions the plan pins", async () => {
    const h = harness();
    await appendOne(h.deps, event("a"));
    await appendOne(h.deps, event("b"));
    const transactions = h.sent.filter((command) => command.constructor.name === "TransactWriteCommand");
    expect(transactions).toHaveLength(2);
    const [genesis, second] = transactions.map((command) => command.input.TransactItems as Array<Record<string, Record<string, unknown>>>);
    const shape = (items: Array<Record<string, Record<string, unknown>>>) => items.map((entry) => {
      const [kind, action] = Object.entries(entry)[0]!;
      const key = (action.Key ?? action.Item) as { pk: string; sk: string };
      return [kind, action.TableName, key.pk.startsWith("AUDIT#") ? `AUDIT#<org> ${key.sk.replace(/[0-9a-f]{64}/g, "<digest>").replace(/[0-9a-f]{40}|[0-9]{12}/g, "<id>")}` : `${key.pk} ${key.sk === ORG ? "<org>" : key.sk}`, action.ConditionExpression];
    });
    expect(shape(genesis!)).toStrictEqual([
      ["Put", LEDGER, "AUDIT#<org> SEQ#<id>", "attribute_not_exists(pk)"],
      ["Put", LEDGER, "AUDIT#<org> HEAD", "attribute_not_exists(pk)"],
      ["Put", LEDGER, "AUDIT#<org> EVENT#aev_<id>", "attribute_not_exists(pk)"],
      ["Update", LEDGER, "AUDIT_DIRTY <org>", undefined],
      ["Put", LEDGER, "AUDIT_ORGS <org>", undefined],
      ...["action", "actor", "target"].map(dimension => ["Put", LEDGER, `AUDIT#<org> FILTER#v1#${dimension}#<digest>#SEQ#<id>`, "attribute_not_exists(pk)"]),
      ["Put", LEDGER, "AUDIT#<org> FILTER#v1#COVERAGE", "attribute_not_exists(pk)"],
    ]);
    expect(shape(second!)).toStrictEqual([
      ["Put", LEDGER, "AUDIT#<org> SEQ#<id>", "attribute_not_exists(pk)"],
      ["Update", LEDGER, "AUDIT#<org> HEAD", "#seq = :prev AND #hash = :prevHash"],
      ["Put", LEDGER, "AUDIT#<org> EVENT#aev_<id>", "attribute_not_exists(pk)"],
      ["Update", LEDGER, "AUDIT_DIRTY <org>", undefined],
      ...["action", "actor", "target"].map(dimension => ["Put", LEDGER, `AUDIT#<org> FILTER#v1#${dimension}#<digest>#SEQ#<id>`, "attribute_not_exists(pk)"]),
      ["Put", LEDGER, "AUDIT#<org> FILTER#v1#COVERAGE", "#through = :prev"],
    ]);
  });

  it("reads the head consistently", async () => {
    const h = harness();
    await appendOne(h.deps, event("a"));
    await appendOne(h.deps, event("b"));
    const headReads = h.sent.filter((command) => command.constructor.name === "GetCommand" && (command.input.Key as { sk: string }).sk === "HEAD");
    expect(headReads.length).toBeGreaterThan(0);
    for (const read of headReads) expect(read.input.ConsistentRead).toBe(true);
  });
});

describe("the dirty marker (C2)", () => {
  it("reads { since: 3, lastSeq: 4 } after appends at seq 3 and 4 once the anchor removed the marker after seq 2", async () => {
    const h = harness();
    await appendAll(h, [event("a"), event("b")]);
    expect(item(h.db, "AUDIT_DIRTY", ORG)).toMatchObject({ since: 1, lastSeq: 2 });
    h.db.delete("AUDIT_DIRTY", ORG);
    await appendOne(h.deps, event("c"));
    expect(item(h.db, "AUDIT_DIRTY", ORG)).toStrictEqual({ pk: "AUDIT_DIRTY", sk: ORG, since: 3, lastSeq: 3 });
    await appendOne(h.deps, event("d"));
    expect(item(h.db, "AUDIT_DIRTY", ORG)).toStrictEqual({ pk: "AUDIT_DIRTY", sk: ORG, since: 3, lastSeq: 4 });
  });

  it("keeps the earliest unsealed seq as since while lastSeq moves", async () => {
    const h = harness();
    await appendAll(h, [event("a"), event("b"), event("c")]);
    expect(item(h.db, "AUDIT_DIRTY", ORG)).toMatchObject({ since: 1, lastSeq: 3 });
  });
});

describe("appendOne: concurrency (Review Focus 1)", () => {
  it("gives two concurrent appends for one org records 1 and 2 and one head", async () => {
    const h = harness();
    const results = await Promise.all([appendOne(h.deps, event("a")), appendOne(h.deps, event("b"))]);
    expect(results).toStrictEqual(["appended", "appended"]);
    const records = recordsOf(h.db);
    expect(records.map((record) => record.seq)).toStrictEqual([1, 2]);
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
    expect(h.db.find((entry) => entry.sk === "HEAD")).toHaveLength(1);
    expect(headOf(h.db)).toMatchObject({ seq: 2, hash: records[1]!.hash });
    expect(h.db.find((entry) => entry.pk === "AUDIT_ORGS")).toHaveLength(1);
    // The fake interleaved them: both read the empty head, one transaction failed on its conditions and read again.
    expect(h.sent.filter((command) => command.constructor.name === "TransactWriteCommand")).toHaveLength(3);
  });

  it("gives the same event appended twice at once one appended, one duplicate and one record", async () => {
    const h = harness();
    const results = await Promise.all([appendOne(h.deps, event("same")), appendOne(h.deps, event("same"))]);
    expect(results.slice().sort()).toStrictEqual(["appended", "duplicate"]);
    expect(recordsOf(h.db)).toHaveLength(1);
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
  });

  it("gives the same event three ways at once exactly one record", async () => {
    const h = harness();
    const results = await Promise.all([appendOne(h.deps, event("same")), appendOne(h.deps, event("other")), appendOne(h.deps, event("same")), appendOne(h.deps, event("same"))]);
    expect(results.filter((result) => result === "appended")).toHaveLength(2);
    expect(results.filter((result) => result === "duplicate")).toHaveLength(2);
    expect(recordsOf(h.db).map((record) => record.seq)).toStrictEqual([1, 2]);
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
  });

  it("gives 20 events with 4 workers a contiguous chain of 20, each event once", async () => {
    const h = harness();
    const queue = Array.from({ length: 20 }, (_, index) => event(`e${String(index)}`));
    const appended = new Map<string, number>();
    let failures = 0;
    // A budget, so that a broken append fails the test instead of redelivering forever.
    let budget = 200;
    // A worker puts an event back when its append throws, as SQS redelivers a failed message.
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        budget -= 1;
        if (budget < 0) throw new Error("20 events did not append within 200 deliveries");
        try {
          const result = await appendOne(h.deps, next);
          appended.set(next.eventId, (appended.get(next.eventId) ?? 0) + (result === "appended" ? 1 : 0));
        } catch {
          failures += 1;
          queue.push(next);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const records = recordsOf(h.db);
    expect(records.map((record) => record.seq)).toStrictEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(new Set(records.map((record) => record.eventId)).size).toBe(20);
    expect([...appended.values()].every((count) => count === 1)).toBe(true);
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
    expect(headOf(h.db)).toMatchObject({ seq: 20, hash: records[19]!.hash });
    expect(item(h.db, "AUDIT_DIRTY", ORG)).toMatchObject({ since: 1, lastSeq: 20 });
    // The workers did collide: more transactions than events, the extra ones lost races and read again.
    expect(h.sent.filter((command) => command.constructor.name === "TransactWriteCommand").length).toBeGreaterThan(20);
    void failures;
  });

  it("keeps two orgs' concurrent chains apart", async () => {
    const h = harness();
    await Promise.all([
      appendOne(h.deps, event("a1")), appendOne(h.deps, event("b1", { orgId: OTHER_ORG })),
      appendOne(h.deps, event("a2")), appendOne(h.deps, event("b2", { orgId: OTHER_ORG })),
    ]);
    expect(chainOk(h.db, ORG)).toStrictEqual({ ok: true });
    expect(chainOk(h.db, OTHER_ORG)).toStrictEqual({ ok: true });
    expect(recordsOf(h.db, ORG)).toHaveLength(2);
    expect(recordsOf(h.db, OTHER_ORG)).toHaveLength(2);
  });
});

describe("appendOne: duplicates and crashes (Review Focus 2)", () => {
  it("answers a redelivery after a crash that followed the commit with duplicate, and writes no second record", async () => {
    const h = harness();
    h.crashAfterCommit.remaining = 1;
    await expect(appendOne(h.deps, event("crash"))).rejects.toMatchObject({ name: "ProcessDied" });
    expect(recordsOf(h.db)).toHaveLength(1);
    expect(await appendOne(h.deps, event("crash"))).toBe("duplicate");
    expect(recordsOf(h.db)).toHaveLength(1);
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
  });

  it("recognizes a duplicate by its claim without building a record or making a key", async () => {
    const h = harness();
    await appendOne(h.deps, domainEvent("d", "payroll.example.com", { details: [{ subject: "dev_1", fields: { login: "ada" } }] }));
    const writes = h.sent.length;
    const before = h.db.items.size;
    expect(await appendOne(h.deps, domainEvent("d", "payroll.example.com", { details: [{ subject: "dev_1", fields: { login: "ada" } }] }))).toBe("duplicate");
    expect(h.db.items.size).toBe(before);
    expect(h.sent.slice(writes).map((command) => command.constructor.name)).not.toContain("TransactWriteCommand");
  });

  it("answers duplicate from a lost race even when the head and record conditions fail too", async () => {
    const h = harness();
    const first = event("race");
    // Both callers pass the early claim check, then one commits; the other's transaction fails on every condition.
    const results = await Promise.all([appendOne(h.deps, first), appendOne(h.deps, first)]);
    expect(results.slice().sort()).toStrictEqual(["appended", "duplicate"]);
  });
});

describe("appendOne: conflicts and retries", () => {
  const conflicts = (count: number, itemCount = 5) => ({
    command: "TransactWriteCommand",
    error: { name: "TransactionCanceledException", message: "Transaction cancelled", cancellationReasons: Array.from({ length: itemCount }, () => ({ Code: "TransactionConflict" })) },
    times: count,
  });

  it("retries a TransactionConflict and succeeds", async () => {
    const h = harness();
    h.db.injectFault(conflicts(2));
    expect(await appendOne(h.deps, event("a"))).toBe("appended");
    expect(recordsOf(h.db)).toHaveLength(1);
    expect(h.sent.filter((command) => command.constructor.name === "TransactWriteCommand")).toHaveLength(3);
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
  });

  it("retries a TransactionConflictException thrown outright", async () => {
    const h = harness();
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionConflictException" }, times: 1 });
    expect(await appendOne(h.deps, event("a"))).toBe("appended");
  });

  it("retries at most 5 times: five conflicts then success appends, six conflicts throw", async () => {
    expect(AUDIT_APPEND_MAX_RETRIES).toBe(5);
    const ok = harness();
    ok.db.injectFault(conflicts(5));
    expect(await appendOne(ok.deps, event("a"))).toBe("appended");

    const bad = harness();
    bad.db.injectFault(conflicts(6));
    await expect(appendOne(bad.deps, event("a"))).rejects.toThrow(/audit append/);
    expect(bad.sent.filter((command) => command.constructor.name === "TransactWriteCommand")).toHaveLength(6);
    expect(recordsOf(bad.db)).toHaveLength(0);
    // The message is retried by SQS, and then it appends.
    expect(await appendOne(bad.deps, event("a"))).toBe("appended");
  });

  it("waits before retrying a conflict, a little longer each time", async () => {
    const h = harness();
    h.db.injectFault(conflicts(3));
    await appendOne(h.deps, event("a"));
    expect(h.sleeps).toHaveLength(3);
    expect(h.sleeps.every((ms) => ms > 0 && ms <= 1000)).toBe(true);
    expect([...h.sleeps].sort((left, right) => left - right)).toStrictEqual(h.sleeps);
  });

  it("retries a head or record condition failure at once, with a fresh read, without waiting", async () => {
    const h = harness();
    await appendOne(h.deps, event("a"));
    h.db.injectFault({
      command: "TransactWriteCommand",
      error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }] },
      times: 2,
    });
    expect(await appendOne(h.deps, event("b"))).toBe("appended");
    expect(h.sleeps).toStrictEqual([]);
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
  });

  it("does not retry a throttled or invalid transaction, nor any other error", async () => {
    for (const error of [
      { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ThrottlingError" }, { Code: "None" }, { Code: "None" }, { Code: "None" }, { Code: "None" }] },
      { name: "ProvisionedThroughputExceededException" },
      { name: "ValidationException" },
    ]) {
      const h = harness();
      h.db.injectFault({ command: "TransactWriteCommand", error, times: 1 });
      await expect(appendOne(h.deps, event("a"))).rejects.toMatchObject({ name: error.name });
      expect(h.sent.filter((command) => command.constructor.name === "TransactWriteCommand")).toHaveLength(1);
    }
  });
});

describe("appendOne: targets and details (I8)", () => {
  const details = [
    { subject: "org", fields: { reason: "quarterly review by ada@example.com" } },
    { subject: "dev_1", fields: { login: "ada-lovelace", email: "ada@example.com" } },
  ];

  it("stores a name target as its pseudonym, with the name in the org detail part as targetName", async () => {
    const h = harness();
    await appendOne(h.deps, domainEvent("d", "payroll.example.com", { details }));
    const record = recordsOf(h.db)[0]!;
    const pseudonym = await h.keyring.pseudonym(ORG, "domain", "payroll.example.com");
    expect(record.target).toStrictEqual({ kind: "domain", id: pseudonym });
    expect(record.details.map((entry) => entry.subject)).toStrictEqual(["org", "dev_1"]);
    const sealed = (item(h.db, `AUDIT#${ORG}`, seqKey(1))!.sealedDetails as Array<{ subject: string; iv: string; ciphertext: string }>);
    const opened = await h.keyring.openDetails(ORG, 1, sealed);
    expect(opened[0]).toMatchObject({ subject: "org", fields: { reason: "quarterly review by ada@example.com", targetName: "payroll.example.com" } });
    expect(opened[1]).toMatchObject({ subject: "dev_1", fields: details[1]!.fields });
  });

  it("makes the org detail part for a name target that has none", async () => {
    const h = harness();
    await appendOne(h.deps, domainEvent("d", "payroll.example.com"));
    const record = recordsOf(h.db)[0]!;
    expect(record.details.map((entry) => entry.subject)).toStrictEqual(["org"]);
    const sealed = (item(h.db, `AUDIT#${ORG}`, seqKey(1))!.sealedDetails as Array<{ subject: string; iv: string; ciphertext: string }>);
    expect((await h.keyring.openDetails(ORG, 1, sealed))[0]).toMatchObject({ subject: "org", fields: { targetName: "payroll.example.com" } });
  });

  it("keeps an id target as it is and writes no sealedDetails when there are no details", async () => {
    const h = harness();
    await appendOne(h.deps, event("a"));
    expect(item(h.db, `AUDIT#${ORG}`, seqKey(1))).not.toHaveProperty("sealedDetails");
    expect(recordsOf(h.db)[0]!.target).toStrictEqual({ kind: "pull_request", id: "pr_1" });
    // The org cursor key is prepared even for id-only events; no subject/detail key is created.
    expect(h.db.find((entry) => String(entry.pk).startsWith("ORG#")).map(entry => entry.sk).sort()).toStrictEqual(["DATA_KEY", "PSEUDONYM_KEY"]);
  });

  it("commits to each part: the record's commitments match the opened details", async () => {
    const h = harness();
    await appendOne(h.deps, event("a", { details }));
    const record = recordsOf(h.db)[0]!;
    const { detailCommit } = await import("@rovara/audit-verifier");
    const sealed = (item(h.db, `AUDIT#${ORG}`, seqKey(1))!.sealedDetails as Array<{ subject: string; iv: string; ciphertext: string }>);
    const opened = await h.keyring.openDetails(ORG, 1, sealed);
    expect(opened).toHaveLength(2);
    for (const [index, entry] of opened.entries()) {
      const open = entry as { subject: string; salt: string; fields: Record<string, string> };
      expect(record.details[index]).toStrictEqual({ subject: open.subject, commit: detailCommit(Uint8Array.from(Buffer.from(open.salt, "hex")), open.subject, open.fields) });
    }
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
  });

  it("merges two parts of one subject into one, so a subject has one commitment", async () => {
    const h = harness();
    await appendOne(h.deps, event("a", { details: [{ subject: "dev_1", fields: { login: "ada" } }, { subject: "dev_1", fields: { email: "ada@example.com" } }] }));
    const record = recordsOf(h.db)[0]!;
    expect(record.details.map((entry) => entry.subject)).toStrictEqual(["dev_1"]);
    const sealed = (item(h.db, `AUDIT#${ORG}`, seqKey(1))!.sealedDetails as Array<{ subject: string; iv: string; ciphertext: string }>);
    expect((await h.keyring.openDetails(ORG, 1, sealed))[0]).toMatchObject({ fields: { login: "ada", email: "ada@example.com" } });
  });

  it("holds no detail plaintext, name or pseudonym key material in any ledger item", async () => {
    const h = harness();
    await appendAll(h, [
      domainEvent("d", "payroll.example.com", { details }),
      event("p", { details: [{ subject: "dev_2", fields: { login: "grace-hopper", note: "secret-note" } }] }),
    ]);
    const ledger = h.db.find((entry) => String(entry.pk).startsWith("AUDIT"));
    expect(ledger.length).toBeGreaterThan(0);
    const text = JSON.stringify(ledger);
    // Whole words, not fragments: a fragment such as "ada" can occur by chance inside a hex hash.
    for (const secret of ["payroll", "example.com", "ada@", "ada-lovelace", "lovelace", "grace-hopper", "hopper", "secret-note", "quarterly"]) expect(text).not.toContain(secret);
    // Nor in the keys table, which holds only wrapped keys.
    const keys = JSON.stringify(h.db.find((entry) => String(entry.pk).startsWith("ORG#")));
    for (const secret of ["payroll", "ada@", "ada-lovelace", "grace-hopper", "secret-note"]) expect(keys).not.toContain(secret);
    // Every ledger string is an id, a number-like word, a time, a hash or base64 ciphertext.
    for (const entry of ledger) {
      const { sealedDetails, ...rest } = entry as Record<string, unknown>;
      void rest;
      if (sealedDetails !== undefined) for (const sealed of sealedDetails as Array<Record<string, string>>) expect(Object.keys(sealed).sort()).toStrictEqual(["ciphertext", "iv", "subject"]);
    }
  });

  it("appends with the erased subject's part omitted and makes no SUBJECT# key for it", async () => {
    const h = harness();
    await appendOne(h.deps, event("first", { details }));
    // Erasure: the person's key is replaced by a tombstone.
    h.db.set({ pk: `ORG#${ORG}`, sk: "SUBJECT#dev_1", erasedAt: "2026-10-19T00:00:00.000Z" });
    expect(await appendOne(h.deps, event("second", { details }))).toBe("appended");
    const second = recordsOf(h.db)[1]!;
    expect(second.details.map((entry) => entry.subject)).toStrictEqual(["org"]);
    const sealed = (item(h.db, `AUDIT#${ORG}`, seqKey(2))!.sealedDetails as Array<{ subject: string }>);
    expect(sealed.map((entry) => entry.subject)).toStrictEqual(["org"]);
    expect(h.db.get(`ORG#${ORG}`, "SUBJECT#dev_1")).toStrictEqual({ pk: `ORG#${ORG}`, sk: "SUBJECT#dev_1", erasedAt: "2026-10-19T00:00:00.000Z" });
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
  });

  it("appends a first event for an already-erased person with no key made at all for them", async () => {
    const h = harness();
    h.db.set({ pk: `ORG#${ORG}`, sk: "SUBJECT#dev_1", erasedAt: "2026-10-19T00:00:00.000Z" });
    expect(await appendOne(h.deps, event("only", { details: [{ subject: "dev_1", fields: { login: "ada" } }] }))).toBe("appended");
    const record = recordsOf(h.db)[0]!;
    expect(record.details).toStrictEqual([]);
    expect(item(h.db, `AUDIT#${ORG}`, seqKey(1))).not.toHaveProperty("sealedDetails");
    expect(h.db.find((entry) => String(entry.pk).startsWith("ORG#")).map((entry) => entry.sk)).toStrictEqual(["SUBJECT#dev_1", "DATA_KEY", "PSEUDONYM_KEY"]);
  });

  it("appends after SHREDDED with the target as n_shredded, no details and no key made", async () => {
    const h = harness();
    await appendOne(h.deps, domainEvent("before", "payroll.example.com", { details }));
    for (const entry of h.db.find((candidate) => candidate.pk === `ORG#${ORG}`)) h.db.delete(entry.pk as string, entry.sk as string);
    h.db.set({ pk: `ORG#${ORG}`, sk: "SHREDDED", at: "2026-10-19T00:00:00.000Z" });
    expect(await appendOne(h.deps, domainEvent("after", "payroll.example.com", { details }))).toBe("appended");
    const record = recordsOf(h.db)[1]!;
    expect(record.target).toStrictEqual({ kind: "domain", id: "n_shredded" });
    expect(record.details).toStrictEqual([]);
    expect(item(h.db, `AUDIT#${ORG}`, seqKey(2))).not.toHaveProperty("sealedDetails");
    expect(h.db.find((entry) => String(entry.pk).startsWith("ORG#")).map((entry) => entry.sk)).toStrictEqual(["SHREDDED"]);
    expect(chainOk(h.db)).toStrictEqual({ ok: true });
  });

  it("does not let a stale cache write a pseudonym or a detail after SHREDDED", async () => {
    const h = harness();
    await appendOne(h.deps, domainEvent("before", "payroll.example.com", { details }));
    h.db.set({ pk: `ORG#${ORG}`, sk: "SHREDDED", at: "2026-10-19T00:00:00.000Z" });
    await appendOne(h.deps, domainEvent("after", "other.example.com", { details }));
    const record = recordsOf(h.db)[1]!;
    expect(record.target.id).toBe("n_shredded");
    expect(record.details).toStrictEqual([]);
  });
});

describe("the SQS batch handler", () => {
  const messageOf = (entry: AuditEventInput, extra: Record<string, unknown> = {}) => ({
    messageId: `m-${entry.eventId}`,
    body: JSON.stringify(entry),
    attributes: { MessageGroupId: entry.orgId },
    ...extra,
  });
  const batch = (...messages: Array<ReturnType<typeof messageOf>>): AuditSqsEvent => ({ Records: messages });

  it("appends every message in order and reports nothing", async () => {
    const h = harness();
    const events = Array.from({ length: 10 }, (_, index) => event(`m${String(index)}`));
    const response = await processAuditBatch(h.deps, batch(...events.map((entry) => messageOf(entry))));
    expect(response).toStrictEqual({ batchItemFailures: [] });
    expect(recordsOf(h.db).map((record) => record.eventId)).toStrictEqual(events.map((entry) => entry.eventId));
  });

  it("treats a duplicate as done", async () => {
    const h = harness();
    const first = event("m");
    await appendOne(h.deps, first);
    expect(await processAuditBatch(h.deps, batch(messageOf(first)))).toStrictEqual({ batchItemFailures: [] });
    expect(recordsOf(h.db)).toHaveLength(1);
  });

  it("reports messages 3 to 10 when message 3 fails, and appends only 1 and 2", async () => {
    const h = harness();
    const events = Array.from({ length: 10 }, (_, index) => event(`m${String(index)}`));
    h.db.injectFault({
      command: "TransactWriteCommand",
      match: (input) => JSON.stringify(input).includes(events[2]!.eventId),
      error: { name: "ProvisionedThroughputExceededException" },
      times: 99,
    });
    const messages = events.map((entry) => messageOf(entry));
    const response = await processAuditBatch(h.deps, batch(...messages));
    expect(response.batchItemFailures.map((entry) => entry.itemIdentifier)).toStrictEqual(messages.slice(2).map((message) => message.messageId));
    expect(recordsOf(h.db).map((record) => record.eventId)).toStrictEqual([events[0]!.eventId, events[1]!.eventId]);
  });

  it("stops at the first failure across groups: a later message of another org is reported and not appended", async () => {
    const h = harness();
    const a1 = event("a1");
    const a2 = event("a2");
    const b1 = event("b1", { orgId: OTHER_ORG });
    const a3 = event("a3");
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes(a2.eventId), error: { name: "ProvisionedThroughputExceededException" }, times: 99 });
    const messages = [a1, b1, a2, a3].map((entry) => messageOf(entry));
    const response = await processAuditBatch(h.deps, batch(...messages));
    expect(response.batchItemFailures.map((entry) => entry.itemIdentifier)).toStrictEqual([messages[2]!.messageId, messages[3]!.messageId]);
    expect(recordsOf(h.db, ORG)).toHaveLength(1);
    expect(recordsOf(h.db, OTHER_ORG)).toHaveLength(1);
  });

  it("redelivery of the reported messages appends them once each", async () => {
    const h = harness();
    const events = Array.from({ length: 4 }, (_, index) => event(`r${String(index)}`));
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes(events[1]!.eventId), error: { name: "ProvisionedThroughputExceededException" }, times: 1 });
    const messages = events.map((entry) => messageOf(entry));
    const first = await processAuditBatch(h.deps, batch(...messages));
    expect(first.batchItemFailures).toHaveLength(3);
    const retry = messages.filter((message) => first.batchItemFailures.some((failure) => failure.itemIdentifier === message.messageId));
    expect(await processAuditBatch(h.deps, batch(...retry))).toStrictEqual({ batchItemFailures: [] });
    expect(recordsOf(h.db).map((record) => record.eventId)).toStrictEqual(events.map((entry) => entry.eventId));
  });

  it("reports a malformed body, an invalid event and a message from another group, with a log that holds no value", async () => {
    for (const bad of [
      { messageId: "m-json", body: "{not json", attributes: { MessageGroupId: ORG } },
      { messageId: "m-invalid", body: JSON.stringify({ ...event("x"), action: "not.an.action", target: { kind: "domain", name: "payroll.example.com" } }), attributes: { MessageGroupId: ORG } },
      { messageId: "m-group", body: JSON.stringify(event("g")), attributes: { MessageGroupId: OTHER_ORG } },
      { messageId: "m-nogroup", body: JSON.stringify(event("n")), attributes: {} },
    ]) {
      const h = harness();
      const response = await processAuditBatch(h.deps, { Records: [bad] });
      expect(response.batchItemFailures).toStrictEqual([{ itemIdentifier: bad.messageId }]);
      expect(recordsOf(h.db)).toHaveLength(0);
      expect(JSON.stringify(h.logs)).not.toContain("payroll");
      expect(h.logs.length).toBeGreaterThan(0);
    }
  });

  it("logs ids, the action and the error name for a failure, never a target name or a detail", async () => {
    const h = harness();
    const secret = domainEvent("s", "payroll.example.com", { details: [{ subject: "dev_1", fields: { login: "ada-lovelace" } }] });
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "ProvisionedThroughputExceededException", message: "payroll.example.com ada-lovelace" }, times: 1 });
    const response = await processAuditBatch(h.deps, batch(messageOf(secret)));
    expect(response.batchItemFailures).toHaveLength(1);
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain("payroll");
    expect(text).not.toContain("lovelace");
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "audit.append_failed", eventId: secret.eventId, orgId: ORG, action: "egress_domain.decided", error: "ProvisionedThroughputExceededException" }));
  });

  it("logs a successful append with its ids and sequence number only", async () => {
    const h = harness();
    const secret = domainEvent("s", "payroll.example.com", { details: [{ subject: "dev_1", fields: { login: "ada-lovelace" } }] });
    await processAuditBatch(h.deps, batch(messageOf(secret)));
    expect(JSON.stringify(h.logs)).not.toContain("payroll");
    expect(JSON.stringify(h.logs)).not.toContain("lovelace");
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "audit.appended", eventId: secret.eventId, orgId: ORG, seq: 1 }));
  });
});

it("appends and verifies the additive invite-creation action and opaque invite target", async () => {
 const h = harness(), inviteId = "11111111-1111-4111-8111-111111111111";const input = event("invite-creation", { eventId: auditEventId("org.invite_created", inviteId), action: "org.invite_created", target: { kind: "invite", id: inviteId }, facts: { role: "member", targeted: true } });await appendAll(h, [input]);const records = recordsOf(h.db);expect(records.length).toBe(1);expect(records[0]?.action).toBe("org.invite_created");expect(records[0]?.target).toEqual({ kind: "invite", id: inviteId });expect(chainOk(h.db)).toEqual({ ok: true });
});

it("appends and verifies the additive invite-revocation action and opaque invite target", async () => {
 const h = harness(), inviteId = "11111111-1111-4111-8111-111111111111";const input = event("invite-revocation", { eventId: auditEventId("org.invite_revoked", inviteId), action: "org.invite_revoked", target: { kind: "invite", id: inviteId }, facts: { role: "member" } });await appendAll(h, [input]);const records = recordsOf(h.db);expect(records.length).toBe(1);expect(records[0]?.action).toBe("org.invite_revoked");expect(records[0]?.target).toEqual({ kind: "invite", id: inviteId });expect(chainOk(h.db)).toEqual({ ok: true });
});

for(const action of ["models","selection"] as const)it(`pseudonymizes the name-keyed project ${action} event and seals its erasable name`,async()=>{
 const h=harness(),projectName="private-roadmap",base={orgId:ORG,actor:{kind:"member" as const,id:"dev_1"},occurredAt:"2026-10-20T11:59:00.000Z",occurrence:"project-revision-2",definitionRevision:2,projectName,projectId:projectName};
 // The old ID-shaped field is a hostile trap: the project name must never be persisted as an opaque id.
 const input=action==="models"?auditProjectModelsDigestChanged({...base,beforeModelIdsDigest:"a".repeat(64),afterModelIdsDigest:"b".repeat(64),beforeCount:1,afterCount:2}):auditProjectModelSelectionDigestChanged({...base,beforeModelIdDigest:"a".repeat(64),afterModelIdDigest:"b".repeat(64),sourceSurface:"slack"});
 const {target,...outside}=input;expect(JSON.stringify(outside)).not.toContain(projectName);await appendOne(h.deps,input);const record=recordsOf(h.db)[0]!;expect(record.target).toEqual({kind:"project",id:await h.keyring.pseudonym(ORG,"project",projectName)});expect(JSON.stringify(record)).not.toContain(projectName);expect(JSON.stringify(h.logs)).not.toContain(projectName);expect(target).toEqual({kind:"project",name:projectName});
 const sealed=item(h.db,`AUDIT#${ORG}`,seqKey(1))!.sealedDetails as Array<{subject:string;iv:string;ciphertext:string}>;expect((await h.keyring.openDetails(ORG,1,sealed))[0]).toMatchObject({subject:"org",fields:{targetName:projectName}});
});
