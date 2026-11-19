// Cloud's own audit records (plan v3.2 7.5): one record for each Cloud action (company rules, invites, budgets, sign-in clients) and each policy hook answer,
// company-scoped and append-only from the API. The same cases run against the local store and the DynamoDB store (on the in-memory fake).
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIT_EARLIEST_MS, AuditRecordRefused, CLOUD_AUDIT_ACTIONS, DynamoCloudAuditStore, LocalCloudAuditStore, auditIdFrom, recordCloudAction,
  type CloudAuditRecord, type CloudAuditStore,
} from "../../packages/cloud-server/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ACME = "org_aaaaaaaaaaaaaaaaaaaa";
/** The Dynamo store's clock: after every date the tests use. */
const LATER = () => Date.UTC(2027, 0, 1);
const dynamo = (db: FakeDynamoDb = new FakeDynamoDb()) => new DynamoCloudAuditStore(db, "cloud-table", LATER);
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb";
const ADA = { developerId: "a".repeat(64), name: "Ada" };
const BASE = Date.UTC(2026, 10, 14, 12, 0, 0);
const clockAt = (ms: number) => () => new Date(ms);
let counter = 0;
const record = (companyId: string, atMs: number, overrides: Partial<CloudAuditRecord> = {}): CloudAuditRecord => ({
  id: `aud_${String(counter++).padStart(20, "0")}`, companyId, at: new Date(atMs).toISOString(), actor: { ...ADA, type: "person" },
  action: "company.rules.changed", subject: "", outcome: "ok", ...overrides,
});
const ids = (rows: CloudAuditRecord[]) => rows.map((row) => row.id);

interface Made { store: CloudAuditStore }
function storeContract(name: string, make: () => Made) {
  describe(name, () => {
    it("reads one company's records newest first, ties by id (higher first)", async () => {
      const { store } = make();
      const old = record(ACME, BASE), tie1 = record(ACME, BASE + 1000), tie2 = record(ACME, BASE + 1000), fresh = record(ACME, BASE + 2000);
      for (const row of [tie1, old, fresh, tie2]) expect(await store.append(row)).toBe("added");
      const read = await store.read(ACME, { max: 10 });
      expect(ids(read.rows)).toEqual([fresh.id, tie2.id, tie1.id, old.id]);
      expect(read.more).toBe(false);
    });

    it("never shows one company's records to another", async () => {
      const { store } = make();
      const mine = record(ACME, BASE), theirs = record(OTHER, BASE + 1);
      await store.append(mine);
      await store.append(theirs);
      expect(ids((await store.read(ACME, { max: 10 })).rows)).toEqual([mine.id]);
      expect(ids((await store.read(OTHER, { max: 10 })).rows)).toEqual([theirs.id]);
      expect((await store.read("org_cccccccccccccccccccc", { max: 10 })).rows).toEqual([]);
    });

    it("is append-only: the same id again changes nothing and says so, and the store has no way to change or remove a record", async () => {
      const { store } = make();
      const first = record(ACME, BASE, { outcome: "ok" });
      expect(await store.append(first)).toBe("added");
      expect(await store.append({ ...first, outcome: "refused", action: "company.budget.changed" })).toBe("exists");
      expect((await store.read(ACME, { max: 10 })).rows).toEqual([first]);
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store) as object).sort()).toEqual(["append", "constructor", "read"]);
    });

    it("keeps one id to one record even when it is written again at another time", async () => {
      const { store } = make();
      const first = record(ACME, BASE);
      expect(await store.append(first)).toBe("added");
      expect(await store.append({ ...first, at: new Date(BASE + 60_000).toISOString() })).toBe("exists");
      expect(await store.append({ ...first, at: new Date(BASE + 40 * 86_400_000).toISOString() })).toBe("exists");
      expect((await store.read(ACME, { max: 10 })).rows).toEqual([first]);
    });

    it("answers a range that ends in the far future as it would one that ends now", async () => {
      const { store } = make();
      const row = record(ACME, BASE);
      await store.append(row);
      expect(ids((await store.read(ACME, { toMs: Date.UTC(9999, 11, 31), max: 10 })).rows)).toEqual([row.id]);
    });

    it("keeps the same id in two companies apart", async () => {
      const { store } = make();
      const a = record(ACME, BASE), b = { ...record(OTHER, BASE), id: a.id };
      expect(await store.append(a)).toBe("added");
      expect(await store.append(b)).toBe("added");
      expect((await store.read(ACME, { max: 5 })).rows[0]?.companyId).toBe(ACME);
      expect((await store.read(OTHER, { max: 5 })).rows[0]?.companyId).toBe(OTHER);
    });

    it("limits the range by time, both ends inclusive", async () => {
      const { store } = make();
      const rows = [0, 1000, 2000, 3000].map((offset) => record(ACME, BASE + offset));
      for (const row of rows) await store.append(row);
      expect(ids((await store.read(ACME, { fromMs: BASE + 1000, toMs: BASE + 2000, max: 10 })).rows)).toEqual([rows[2]!.id, rows[1]!.id]);
      expect(ids((await store.read(ACME, { fromMs: BASE + 3000, max: 10 })).rows)).toEqual([rows[3]!.id]);
      expect(ids((await store.read(ACME, { toMs: BASE, max: 10 })).rows)).toEqual([rows[0]!.id]);
    });

    it("answers at most max rows and says whether there are more, and goes on from a position (strictly older)", async () => {
      const { store } = make();
      const rows = [0, 1, 2, 3, 4].map((offset) => record(ACME, BASE + offset * 1000));
      for (const row of rows) await store.append(row);
      const first = await store.read(ACME, { max: 2 });
      expect(ids(first.rows)).toEqual([rows[4]!.id, rows[3]!.id]);
      expect(first.more).toBe(true);
      const last = first.rows.at(-1)!;
      const second = await store.read(ACME, { max: 2, olderThan: { atMs: Date.parse(last.at), id: last.id } });
      expect(ids(second.rows)).toEqual([rows[2]!.id, rows[1]!.id]);
      expect(second.more).toBe(true);
      const third = await store.read(ACME, { max: 2, olderThan: { atMs: Date.parse(second.rows.at(-1)!.at), id: second.rows.at(-1)!.id } });
      expect(ids(third.rows)).toEqual([rows[0]!.id]);
      expect(third.more).toBe(false);
      // Exactly max rows left: not "more".
      const exact = await store.read(ACME, { max: 5 });
      expect(exact.rows).toHaveLength(5);
      expect(exact.more).toBe(false);
    });

    it("goes on from a position among records of the same instant without skipping or repeating one", async () => {
      const { store } = make();
      const same = [0, 1, 2, 3].map(() => record(ACME, BASE));
      for (const row of same) await store.append(row);
      const seen: string[] = [];
      let position: { atMs: number; id: string } | undefined;
      for (let page = 0; page < 6; page += 1) {
        const read = await store.read(ACME, { max: 1, ...(position === undefined ? {} : { olderThan: position }) });
        seen.push(...ids(read.rows));
        if (!read.more) break;
        position = { atMs: Date.parse(read.rows[0]!.at), id: read.rows[0]!.id };
      }
      expect(seen).toEqual(ids([...same].reverse()));
    });

    it("reads across months, newest first, with the position carried over a month's end", async () => {
      const { store } = make();
      const dates = [Date.UTC(2026, 8, 30, 23, 59, 59, 999), Date.UTC(2026, 9, 1, 0, 0, 0, 0), Date.UTC(2026, 9, 31, 23, 59, 59, 999), Date.UTC(2026, 10, 1, 0, 0, 0, 0), Date.UTC(2026, 11, 1, 0, 0, 1, 0)];
      const rows = dates.map((at) => record(ACME, at));
      for (const row of rows) await store.append(row);
      expect(ids((await store.read(ACME, { max: 10 })).rows)).toEqual([...ids(rows)].reverse());
      expect(ids((await store.read(ACME, { fromMs: dates[1]!, toMs: dates[3]!, max: 10 })).rows)).toEqual([rows[3]!.id, rows[2]!.id, rows[1]!.id]);
      const two = await store.read(ACME, { max: 2, toMs: dates[3]! });
      expect(ids(two.rows)).toEqual([rows[3]!.id, rows[2]!.id]);
      expect(two.more).toBe(true);
    });

    it("does not read before the earliest instant a record can have", async () => {
      const { store } = make();
      await store.append(record(ACME, BASE));
      expect((await store.read(ACME, { fromMs: 0, toMs: BASE, max: 10 })).rows).toHaveLength(1);
      expect((await store.read(ACME, { toMs: AUDIT_EARLIEST_MS - 1, max: 10 })).rows).toEqual([]);
    });

    it("never reads a record older than the earliest instant, even one written by hand", async () => {
      const { store } = make();
      const ancient = record(ACME, AUDIT_EARLIEST_MS - 1000), fresh = record(ACME, BASE);
      await store.append(ancient);
      await store.append(fresh);
      expect(ids((await store.read(ACME, { max: 10 })).rows)).toEqual([fresh.id]);
      expect(ids((await store.read(ACME, { fromMs: 0, max: 10 })).rows)).toEqual([fresh.id]);
    });

    it("refuses a company id that could reach another company's rows", async () => {
      const { store } = make();
      for (const bad of ["", "a#2026-11", "org_a#b", "x".repeat(65), "org a", "org\u0000a"]) {
        await expect(store.read(bad, { max: 5 }), bad).rejects.toBeInstanceOf(AuditRecordRefused);
        await expect(store.append(record(bad, BASE)), bad).rejects.toBeInstanceOf(AuditRecordRefused);
      }
    });
  });
}

storeContract("the local audit store", () => ({ store: new LocalCloudAuditStore() }));
storeContract("the DynamoDB audit store", () => ({ store: dynamo() }));

describe("the DynamoDB audit store's reads", () => {
  it("looks at the months from the earliest instant to now and no further back", async () => {
    const db = new FakeDynamoDb();
    const queries: string[] = [];
    const spy = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => { if (command.constructor.name === "QueryCommand") queries.push(String((command.input["ExpressionAttributeValues"] as Record<string, unknown>)[":pk"])); return (db.send as (c: unknown) => Promise<unknown>)(command); } };
    const store = new DynamoCloudAuditStore(spy, "cloud-table", LATER);
    await store.read(ACME, { max: 10 });
    expect(queries[0]).toBe(`AUDIT#${ACME}#2027-01`);
    expect(queries.at(-1)).toBe(`AUDIT#${ACME}#2026-01`);
    expect(queries).toHaveLength(13);
  });
});

describe("the DynamoDB audit store's items", () => {
  it("keeps a company's month in one partition, with no expiry, so a record is never removed by time", async () => {
    const db = new FakeDynamoDb();
    const store = dynamo(db);
    const row = record(ACME, BASE);
    await store.append(row);
    const all = [...db.items.values()];
    // The record, and the marker that keeps its id to one record.
    expect(all.map((item) => item["pk"]).sort()).toEqual([`AUDIT#${ACME}#2026-11`, `AUDITID#${ACME}#${row.id}`].sort());
    const items = all.filter((item) => String(item["pk"]).startsWith("AUDIT#"));
    expect(items[0]!["pk"]).toBe(`AUDIT#${ACME}#2026-11`);
    expect(items[0]!["sk"]).toBe(`${row.at}#${row.id}`);
    expect(items[0]!["expiresAt"]).toBeUndefined();
    expect(items[0]!["record"]).toEqual(row);
  });

  it("writes with a condition that refuses an existing record, so two servers cannot replace one", async () => {
    const db = new FakeDynamoDb();
    const sent: Array<Record<string, unknown>> = [];
    const spy = { send: async (command: { input: Record<string, unknown> }) => { sent.push(command.input); return (db.send as (c: unknown) => Promise<unknown>)(command); } };
    const store = new DynamoCloudAuditStore(spy, "cloud-table", LATER);
    const row = record(ACME, BASE);
    await store.append(row);
    await store.append({ ...row, outcome: "refused" });
    const puts = sent.flatMap((input) => (input["TransactItems"] as Array<{ Put: { ConditionExpression?: string } }>).map((item) => item.Put.ConditionExpression));
    expect(puts).toEqual(Array(4).fill("attribute_not_exists(pk)"));
    expect([...db.items.values()].filter((item) => item["record"] !== undefined).map((item) => item["record"])).toEqual([row]);
  });

  it("does not show a row of another company that sits in this company's partition", async () => {
    const db = new FakeDynamoDb();
    const store = dynamo(db);
    const mine = record(ACME, BASE), planted = record(OTHER, BASE + 1000);
    await store.append(mine);
    db.items.set(JSON.stringify([`AUDIT#${ACME}#2026-11`, `${planted.at}#${planted.id}`]), { pk: `AUDIT#${ACME}#2026-11`, sk: `${planted.at}#${planted.id}`, record: planted });
    expect(ids((await store.read(ACME, { max: 10 })).rows)).toEqual([mine.id]);
  });
});

describe("the local audit store's file", () => {
  it("keeps records in a private file, one line each, and reads them back after a restart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cloud-audit-")), "audit.jsonl");
    const first = new LocalCloudAuditStore(file);
    const row = record(ACME, BASE);
    await first.append(row);
    await first.append(row);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(ids((await new LocalCloudAuditStore(file).read(ACME, { max: 5 })).rows)).toEqual([row.id]);
  });

  it("refuses to run deployed, where records would be lost", () => {
    expect(() => new LocalCloudAuditStore(undefined, { AWS_LAMBDA_FUNCTION_NAME: "cloud" })).toThrow(/local development only/u);
    expect(() => new LocalCloudAuditStore(undefined, { CLOUD_ENVIRONMENT: "production" })).toThrow(/local development only/u);
    expect(() => new LocalCloudAuditStore(undefined, { CLOUD_ENVIRONMENT: "local" })).not.toThrow();
  });
});

describe("recording a Cloud action", () => {
  const input = { companyId: ACME, actor: { ...ADA, type: "person" as const }, action: "company.rules.changed" as const, via: "web" };

  it("stamps the time itself, makes an id in Cloud's format and stores the record for that company only", async () => {
    const store = new LocalCloudAuditStore();
    const made = await recordCloudAction(store, { ...input, subject: "rules:company", detail: "second_person_on" }, clockAt(BASE));
    expect(made).toMatchObject({ companyId: ACME, at: new Date(BASE).toISOString(), actor: { developerId: ADA.developerId, name: "Ada", type: "person" }, action: "company.rules.changed", subject: "rules:company", outcome: "ok", via: "web", detail: "second_person_on" });
    expect(made.id).toMatch(/^aud_[0-9a-z]{20}$/u);
    expect((await store.read(ACME, { max: 5 })).rows).toEqual([made]);
    expect((await store.read(OTHER, { max: 5 })).rows).toEqual([]);
  });

  it("knows exactly the Cloud actions the plan names, each recordable, and refuses any other action", async () => {
    expect([...CLOUD_AUDIT_ACTIONS].sort()).toEqual([
      "agent_ai.bedrock.connected", "agent_ai.bedrock.recovered", "agent_ai.bedrock.removed", "agent_ai.bedrock.rotated",
      "agent_ai.endpoint.connected", "agent_ai.endpoint.removed", "agent_ai.endpoint.rotated",
      "agent_ai.source.changed",
      "company.budget.changed", "company.invite.created", "company.invite.revoked", "company.rules.changed", "company.rules.proposed", "company.rules.withdrawn", "company.signin_client.changed",
      "hook.decide.answered", "hook.decide.unanswered", "hook.start.answered", "hook.start.unanswered", "hook.values.answered", "hook.values.unanswered",
      "learning_ai.key.connected", "learning_ai.key.removed", "learning_ai.key.rotated",
      "product_ai.bedrock.connected", "product_ai.bedrock.linked", "product_ai.bedrock.removed", "product_ai.bedrock.rotated",
      "product_ai.eval_approval.recorded", "product_ai.eval_approval.withdrawn", "product_ai.eval_approvals.withdrawn_for_member", "product_ai.eval_budget.changed", "product_ai.key.connected", "product_ai.key.removed", "product_ai.key.rotated",
      "product_ai.vertex.connected", "product_ai.vertex.removed", "product_ai.vertex.rotated",
    ]);
    const store = new LocalCloudAuditStore();
    for (const action of CLOUD_AUDIT_ACTIONS) await recordCloudAction(store, { ...input, action }, clockAt(BASE));
    expect((await store.read(ACME, { max: 50 })).rows).toHaveLength(CLOUD_AUDIT_ACTIONS.length);
    await expect(recordCloudAction(store, { ...input, action: "task.approved" as never }, clockAt(BASE))).rejects.toBeInstanceOf(AuditRecordRefused);
  });

  it("refuses a record whose fields are not in the allowed shapes, and writes nothing", async () => {
    const store = new LocalCloudAuditStore();
    const bad: Array<[string, Record<string, unknown>]> = [
      ["company", { companyId: "org#1" }],
      ["actor id", { actor: { developerId: "", name: "Ada", type: "person" } }],
      ["actor id control character", { actor: { developerId: "a\u0007b", name: "Ada", type: "person" } }],
      ["actor id too long", { actor: { developerId: "a".repeat(257), name: "Ada", type: "person" } }],
      ["actor name empty", { actor: { developerId: ADA.developerId, name: "  ", type: "person" } }],
      ["actor name too long", { actor: { developerId: ADA.developerId, name: "n".repeat(201), type: "person" } }],
      ["actor type", { actor: { developerId: ADA.developerId, name: "Ada", type: "robot" } }],
      ["subject", { subject: "no colon" }],
      ["subject newline", { subject: "task:a\nb" }],
      ["project", { project: "Not A Project" }],
      ["via", { via: "Web" }],
      ["detail too long", { detail: "d".repeat(201) }],
      ["detail control", { detail: "a\u0007b" }],
      ["outcome", { outcome: "maybe" }],
      ["id", { id: "not an id" }],
    ];
    for (const [name, change] of bad) await expect(recordCloudAction(store, { ...input, ...change }, clockAt(BASE)), name).rejects.toBeInstanceOf(AuditRecordRefused);
    expect((await store.read(ACME, { max: 50 })).rows).toEqual([]);
  });

  it("refuses a clock before the earliest instant, and one that is not a date", async () => {
    const store = new LocalCloudAuditStore();
    await expect(recordCloudAction(store, input, clockAt(AUDIT_EARLIEST_MS - 1))).rejects.toBeInstanceOf(AuditRecordRefused);
    await expect(recordCloudAction(store, input, () => new Date(Number.NaN))).rejects.toBeInstanceOf(AuditRecordRefused);
    await expect(recordCloudAction(store, input, clockAt(AUDIT_EARLIEST_MS))).resolves.toBeDefined();
  });

  it("makes the same id from the same seed (a repeated hook question counts once) and different ids from different seeds", async () => {
    expect(auditIdFrom("a")).toBe(auditIdFrom("a"));
    expect(auditIdFrom("a")).not.toBe(auditIdFrom("b"));
    expect(auditIdFrom("a")).toMatch(/^aud_[0-9a-z]{20}$/u);
    const store = new LocalCloudAuditStore();
    await recordCloudAction(store, { ...input, id: auditIdFrom("q1") }, clockAt(BASE));
    await recordCloudAction(store, { ...input, id: auditIdFrom("q1") }, clockAt(BASE + 5000));
    expect((await store.read(ACME, { max: 5 })).rows).toHaveLength(1);
  });

  it("trims the actor's name and leaves optional fields out when none was given", async () => {
    const store = new LocalCloudAuditStore();
    const made = await recordCloudAction(store, { companyId: ACME, actor: { developerId: ADA.developerId, name: "  Ada  " }, action: "company.invite.created" }, clockAt(BASE));
    expect(made.actor).toEqual({ developerId: ADA.developerId, name: "Ada", type: "person" });
    expect(Object.keys(made).sort()).toEqual(["action", "actor", "at", "companyId", "id", "outcome", "subject"]);
  });
});
