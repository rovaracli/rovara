// Test services, slice 3 (s3-fakes-store, TS-FAKES-1): the real ports of the fixture store, on a fake S3 that implements ETag preconditions (If-Match, If-None-Match) and a fake DynamoDB document client that implements the
// conditions the adapter writes. The store's own rules are tested in test-env-fixture-store.test.ts; these tests prove what only the real ports can get wrong: tenancy, the conditional writes, the scans before anything is stored,
// and `tx` off.
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { FixtureSetSchema, canonicalJson, fixtureEntry, fixtureSetDigest, type FixtureSet, type TestEnvProdDeny } from "@agentx/contracts";
import { createFixtureStore, fixtureObjectKey, verifiedFixtureDecision, type FixtureRecord } from "../../packages/broker/src/test-env/fixture-store.js";
import { awsFixtureStore, dynamoFixtureIndex, fixtureStoreForRoutes, s3FixtureObjects } from "../../packages/broker/src/test-env/fixture-store-aws.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const PROJ = "web";
const KEY_ARN = `arn:aws:kms:us-west-2:944937319445:key/${"1234abcd-12ab-34cd-56ef-1234567890ab"}`;
const BUCKET = "agentx-staging-artifacts";
const TABLE = "agentx-staging-state";
const DENY: TestEnvProdDeny = { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: [] };
const NOW = new Date("2026-11-03T12:00:00.000Z");
const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array | undefined) => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));

interface StoredObject { bytes: Uint8Array; etag: string; sse: unknown; keyId: unknown }
const awsError = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

/** A fake S3 with strong ETags and the three preconditions the adapter uses. `afterRead` runs once after a GetObject has answered (another writer, at the worst moment). */
function fakeS3() {
  const objects = new Map<string, StoredObject>();
  const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
  let counter = 0;
  const hooks: { afterRead?: ((key: string) => void) | undefined } = {};
  const put = (key: string, bytes: Uint8Array, extra: Partial<StoredObject> = {}) => { counter += 1; objects.set(key, { bytes, etag: `"etag-${String(counter)}"`, sse: undefined, keyId: undefined, ...extra }); };
  const s3 = {
    send: (command: unknown): Promise<unknown> => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      sent.push({ command: name, input });
      const key = input["Key"] as string;
      const current = objects.get(key);
      if (command instanceof PutObjectCommand) {
        if (input["IfNoneMatch"] === "*" && current !== undefined) return Promise.reject(awsError("PreconditionFailed", 412));
        if (input["IfMatch"] !== undefined && (current === undefined || current.etag !== input["IfMatch"])) return Promise.reject(awsError("PreconditionFailed", 412));
        put(key, input["Body"] as Uint8Array, { sse: input["ServerSideEncryption"], keyId: input["SSEKMSKeyId"] });
        return Promise.resolve({});
      }
      if (command instanceof HeadObjectCommand) {
        if (current === undefined) return Promise.reject(awsError("NotFound", 404));
        return Promise.resolve({ ETag: current.etag, ContentLength: current.bytes.length });
      }
      if (command instanceof GetObjectCommand) {
        if (current === undefined) return Promise.reject(awsError("NoSuchKey", 404));
        if (input["IfMatch"] !== undefined && current.etag !== input["IfMatch"]) return Promise.reject(awsError("PreconditionFailed", 412));
        const range = /^bytes=0-(\d+)$/u.exec(typeof input["Range"] === "string" ? input["Range"] : "");
        const body = range === null ? current.bytes : current.bytes.slice(0, Number(range[1]) + 1);
        const after = hooks.afterRead;
        hooks.afterRead = undefined;
        after?.(key);
        return Promise.resolve({ Body: { transformToByteArray: () => Promise.resolve(body) }, ETag: current.etag });
      }
      return Promise.reject(new Error(`unexpected command ${name}`));
    },
  };
  return { s3, objects, sent, hooks, put };
}

/** A fake document client for exactly the three commands and the conditions the index adapter writes. */
function fakeTable() {
  const items = new Map<string, Record<string, unknown>>();
  const sent: string[] = [];
  const idOf = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;
  const client = {
    send: (command: unknown): Promise<unknown> => {
      sent.push((command as { constructor: { name: string } }).constructor.name);
      if (command instanceof GetCommand) {
        const key = command.input.Key as { pk: string; sk: string };
        return Promise.resolve({ Item: items.get(idOf(key.pk, key.sk)) });
      }
      if (command instanceof PutCommand) {
        const item = command.input.Item as Record<string, unknown>;
        const id = idOf(item["pk"], item["sk"]);
        const existing = items.get(id);
        const condition = command.input.ConditionExpression;
        if (condition === "attribute_not_exists(pk)" && existing !== undefined) return Promise.reject(awsError("ConditionalCheckFailedException", 400));
        if (condition?.startsWith("attribute_exists(pk)") === true) {
          const expected = (command.input.ExpressionAttributeValues as Record<string, unknown>)[":expected"];
          if (existing === undefined || existing["version"] !== expected) return Promise.reject(awsError("ConditionalCheckFailedException", 400));
        }
        items.set(id, item);
        return Promise.resolve({});
      }
      if (command instanceof QueryCommand) {
        const values = command.input.ExpressionAttributeValues as Record<string, string>;
        const found = [...items.values()].filter((item) => item["pk"] === values[":pk"] && String(item["sk"]).startsWith(values[":sk"]!) && item["dependencyId"] === values[":dependency"]);
        return Promise.resolve({ Items: found });
      }
      return Promise.reject(new Error("unexpected command"));
    },
  };
  return { client, items, sent };
}

const dependency = { id: "payments-api", family: "http:api.example-pay.com", protocol: "http_json", target: "api.example-pay.com" } as const;
const match = { ignorePaths: ["/requestedAt"], query: ["customer"] };
const json = "application/json";
const request = (amount: number, over: Record<string, unknown> = {}) => ({ method: "POST" as const, path: "/v1/charges", query: [{ name: "customer", value: "c1" }], contentType: json, body: JSON.stringify({ amount }), ...over });
const answer = (body: unknown) => ({ status: 200, headers: [{ name: "etag" as const, value: "abc" }], contentType: json, body: JSON.stringify(body), latencyMs: 0 });
function makeSet(over: Record<string, unknown> = {}): FixtureSet {
  const shell = { dependency, match };
  return FixtureSetSchema.parse({
    schemaVersion: 2, dependency, origin: "written", revision: 1, writtenBy: "maya", syntheticOnly: true, match,
    entries: [1, 2, 3].map((n) => fixtureEntry(shell, request(n), answer({ ok: true, id: `ch_${String(n)}` }))), faults: [], ...over,
  });
}
const by = (action: "approve" | "reject" | "withdraw", orgId: string, digest: string) => {
  const decision = verifiedFixtureDecision({ orgId, project: PROJ, actor: "lead", role: "maintainer", action, digest, signedInAt: undefined, schemaSynth: false });
  if (decision === undefined) throw new Error("not a maintainer");
  return decision;
};

function world(env: NodeJS.ProcessEnv = { TEST_SERVICES_ENABLED: "1" }) {
  const s3 = fakeS3();
  const table = fakeTable();
  const store = awsFixtureStore({ s3: s3.s3, bucket: BUCKET, kmsKeyArn: KEY_ARN, documentClient: table.client, tableName: TABLE, now: () => NOW, presign: (key, seconds) => Promise.resolve(`https://signed.invalid/${key}?e=${String(seconds)}`) }, () => Promise.resolve(DENY), env);
  return { s3, table, store };
}
const submitOk = async (store: ReturnType<typeof world>["store"], set = makeSet(), org = ORG_A) => {
  const outcome = await store.submit(org, PROJ, set, { actor: "maya", recordedFrom: "written" });
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.record;
};

describe("the S3 object port", () => {
  const port = (s3: ReturnType<typeof fakeS3>) => s3FixtureObjects({ s3: s3.s3, bucket: BUCKET, kmsKeyArn: KEY_ARN });
  const key = fixtureObjectKey(ORG_A, PROJ, "a".repeat(64));

  it("writes with SSE-KMS under the fixture key and only if the key is free", async () => {
    const s3 = fakeS3();
    expect(await port(s3).putIfAbsent(key, enc("one"), json)).toBe("created");
    expect(await port(s3).putIfAbsent(key, enc("two"), json)).toBe("exists");
    expect(dec(s3.objects.get(key)?.bytes)).toBe("one");
    expect(s3.objects.get(key)).toMatchObject({ sse: "aws:kms", keyId: KEY_ARN });
    expect(s3.sent.every((entry) => entry.input["IfNoneMatch"] === "*")).toBe(true);
  });
  it("replaces an object only while it is exactly what the caller observed, with the ETag it read (If-Match)", async () => {
    const s3 = fakeS3();
    s3.put(key, enc("old"));
    expect(await port(s3).replaceIfUnchanged(key, enc("old"), enc("new"), json)).toBe("replaced");
    expect(dec(s3.objects.get(key)?.bytes)).toBe("new");
    expect(s3.objects.get(key)).toMatchObject({ sse: "aws:kms", keyId: KEY_ARN });
    const write = s3.sent.filter((entry) => entry.command === "PutObjectCommand").at(-1)!;
    expect(write.input["IfMatch"]).toBe('"etag-1"');
    // What the caller observed is not what is there: nothing is written.
    expect(await port(s3).replaceIfUnchanged(key, enc("old"), enc("newer"), json)).toBe("changed");
    expect(await port(s3).replaceIfUnchanged(key, enc("ne!"), enc("newer"), json)).toBe("changed");
    expect(dec(s3.objects.get(key)?.bytes)).toBe("new");
    // A missing object is "changed", not created.
    expect(await port(s3).replaceIfUnchanged(fixtureObjectKey(ORG_A, PROJ, "b".repeat(64)), enc("x"), enc("y"), json)).toBe("changed");
  });
  it("refuses a concurrent replace: a writer that gets in between the read and the write wins, and nothing is overwritten", async () => {
    const s3 = fakeS3();
    s3.put(key, enc("old"));
    s3.hooks.afterRead = (k) => s3.put(k, enc("theirs"));
    expect(await port(s3).replaceIfUnchanged(key, enc("old"), enc("mine"), json)).toBe("changed");
    expect(dec(s3.objects.get(key)?.bytes)).toBe("theirs");
    // The write that lost was sent with the ETag of the version it read, and S3 refused it.
    expect(s3.sent.filter((entry) => entry.command === "PutObjectCommand")).toHaveLength(1);
    expect(s3.sent.at(-1)?.input["IfMatch"]).toBe('"etag-1"');
  });
  it("reads at most the bound, and a missing object is undefined", async () => {
    const s3 = fakeS3();
    s3.put(key, enc("0123456789"));
    expect(dec(await port(s3).get(key, 4))).toBe("0123");
    expect(await port(s3).get(fixtureObjectKey(ORG_A, PROJ, "c".repeat(64)), 4)).toBeUndefined();
    await expect(port(s3).get(key, 0)).rejects.toThrow();
  });
  it("signs one key for at most 15 minutes", async () => {
    const s3 = fakeS3();
    const signed = s3FixtureObjects({ s3: s3.s3, bucket: BUCKET, kmsKeyArn: KEY_ARN, presign: (k, seconds) => Promise.resolve(`${k}:${String(seconds)}`) });
    expect(await signed.presignGet(key, 900)).toBe(`${key}:900`);
    await expect(signed.presignGet(key, 901)).rejects.toThrow();
    await expect(signed.presignGet(key, 0)).rejects.toThrow();
  });
  it.each([
    ["another prefix of the bucket", "private/org_aaaaaaaaaaaaaaaaaaaa/evidence/" + "a".repeat(64)],
    ["a workspace named fixtures with a deeper path", "private/org_aaaaaaaaaaaaaaaaaaaa/fixtures/evidence/task/" + "a".repeat(64)],
    ["a path out of the prefix", `private/org_aaaaaaaaaaaaaaaaaaaa/fixtures/../${"a".repeat(64)}`],
    ["a digest that is not 64 hex characters", "private/org_aaaaaaaaaaaaaaaaaaaa/fixtures/web/abc"],
    ["something that is not an org", `private/someone/fixtures/web/${"a".repeat(64)}`],
    ["a public prefix", `public/org_aaaaaaaaaaaaaaaaaaaa/fixtures/web/${"a".repeat(64)}`],
    ["the empty key", ""],
  ])("never sends a request for %s", async (_label, badKey) => {
    const s3 = fakeS3();
    await expect(port(s3).putIfAbsent(badKey, enc("x"), json)).rejects.toThrow("not a fixture key");
    await expect(port(s3).replaceIfUnchanged(badKey, enc("x"), enc("y"), json)).rejects.toThrow("not a fixture key");
    await expect(port(s3).get(badKey, 10)).rejects.toThrow("not a fixture key");
    await expect(port(s3).presignGet(badKey, 60)).rejects.toThrow("not a fixture key");
    expect(s3.sent).toEqual([]);
  });
  it("is not built for a bad bucket, key or prefix", () => {
    const s3 = fakeS3();
    expect(() => s3FixtureObjects({ s3: s3.s3, bucket: " ", kmsKeyArn: KEY_ARN })).toThrow();
    expect(() => s3FixtureObjects({ s3: s3.s3, bucket: BUCKET, kmsKeyArn: "alias/aws/s3" })).toThrow();
    expect(() => s3FixtureObjects({ s3: s3.s3, bucket: BUCKET, kmsKeyArn: KEY_ARN, prefix: "../private" })).toThrow();
  });
});

describe("the DynamoDB index", () => {
  const record = (over: Partial<FixtureRecord> = {}): FixtureRecord => ({
    storeId: `fxs:${ORG_A}:${PROJ}:${"a".repeat(64)}`, orgId: ORG_A, project: PROJ, digest: "a".repeat(64), dependencyId: "payments-api", family: "http:api.example-pay.com", protocol: "http_json", origin: "written", revision: 1,
    entries: 3, faults: 0, bytes: 900, recordedFrom: "written", firstFromTestAccount: false, scanClean: true, status: "pending", submittedBy: "maya", submittedAt: NOW.toISOString(), version: 1, ...over,
  });

  it("keeps a row in its org's partition and reads it back exactly", async () => {
    const table = fakeTable();
    const index = dynamoFixtureIndex({ documentClient: table.client, tableName: TABLE });
    expect(await index.putIfAbsent(record())).toBe(true);
    expect([...table.items.keys()]).toEqual([`ORG#${ORG_A}|FIXTURE#${PROJ}#${"a".repeat(64)}`]);
    expect(await index.get(ORG_A, PROJ, "a".repeat(64))).toEqual(record());
    expect(await index.putIfAbsent(record({ submittedBy: "someone else" }))).toBe(false);
    expect((await index.get(ORG_A, PROJ, "a".repeat(64)))?.submittedBy).toBe("maya");
  });
  it("replaces a row only at the version it expects", async () => {
    const table = fakeTable();
    const index = dynamoFixtureIndex({ documentClient: table.client, tableName: TABLE });
    await index.putIfAbsent(record());
    expect(await index.replace(record({ status: "approved", version: 2 }), 1)).toBe(true);
    expect(await index.replace(record({ status: "rejected", version: 2 }), 1)).toBe(false);
    expect((await index.get(ORG_A, PROJ, "a".repeat(64)))?.status).toBe("approved");
    // No row, no replace.
    expect(await index.replace(record({ digest: "b".repeat(64), storeId: `fxs:${ORG_A}:${PROJ}:${"b".repeat(64)}`, version: 2 }), 1)).toBe(false);
  });
  it("never returns another org's row, for the same digest or for a planted copy", async () => {
    const table = fakeTable();
    const index = dynamoFixtureIndex({ documentClient: table.client, tableName: TABLE });
    await index.putIfAbsent(record());
    expect(await index.get(ORG_B, PROJ, "a".repeat(64))).toBeUndefined();
    // A row of org A copied under org B's partition is not org B's.
    const copy = { ...[...table.items.values()][0]!, pk: `ORG#${ORG_B}` };
    table.items.set(`ORG#${ORG_B}|FIXTURE#${PROJ}#${"a".repeat(64)}`, copy);
    expect(await index.get(ORG_B, PROJ, "a".repeat(64))).toBeUndefined();
    expect(await index.listByDependency(ORG_B, PROJ, "payments-api")).toEqual([]);
    expect((await index.listByDependency(ORG_A, PROJ, "payments-api")).map((row) => row.orgId)).toEqual([ORG_A]);
  });
  it("H1: the project is in the row's key: another project never gets the row, for the same digest or for a planted copy", async () => {
    const table = fakeTable();
    const index = dynamoFixtureIndex({ documentClient: table.client, tableName: TABLE });
    await index.putIfAbsent(record());
    expect(await index.get(ORG_A, "api", "a".repeat(64))).toBeUndefined();
    expect(await index.listByDependency(ORG_A, "api", "payments-api")).toEqual([]);
    // the same set in another project is its own row
    expect(await index.putIfAbsent(record({ project: "api", storeId: `fxs:${ORG_A}:api:${"a".repeat(64)}` }))).toBe(true);
    expect([...table.items.keys()].sort()).toEqual([`ORG#${ORG_A}|FIXTURE#api#${"a".repeat(64)}`, `ORG#${ORG_A}|FIXTURE#${PROJ}#${"a".repeat(64)}`].sort());
    // a row of project web copied under api's key (a planted item) names web, so it is not api's
    const web = table.items.get(`ORG#${ORG_A}|FIXTURE#${PROJ}#${"a".repeat(64)}`)!;
    table.items.set(`ORG#${ORG_A}|FIXTURE#api#${"a".repeat(64)}`, { ...web, sk: `FIXTURE#api#${"a".repeat(64)}` });
    expect(await index.get(ORG_A, "api", "a".repeat(64))).toBeUndefined();
    expect(await index.listByDependency(ORG_A, "api", "payments-api")).toEqual([]);
    expect((await index.listByDependency(ORG_A, PROJ, "payments-api")).map((row) => row.project)).toEqual([PROJ]);
  });
  it("ignores an item that is not exactly a fixture row", async () => {
    const table = fakeTable();
    const index = dynamoFixtureIndex({ documentClient: table.client, tableName: TABLE });
    await index.putIfAbsent(record());
    const planted = { ...[...table.items.values()][0]!, status: "approved-ish", extra: true };
    table.items.set(`ORG#${ORG_A}|FIXTURE#${PROJ}#${"a".repeat(64)}`, planted);
    expect(await index.get(ORG_A, PROJ, "a".repeat(64))).toBeUndefined();
    expect(await index.listByDependency(ORG_A, PROJ, "payments-api")).toEqual([]);
  });
  it("refuses a key that is not an org or a digest before it asks the table anything", async () => {
    const table = fakeTable();
    const index = dynamoFixtureIndex({ documentClient: table.client, tableName: TABLE });
    await expect(index.get("ORG#x", PROJ, "a".repeat(64))).rejects.toThrow();
    await expect(index.get(ORG_A, PROJ, "nope")).rejects.toThrow();
    await expect(index.listByDependency("nope", PROJ, "payments-api")).rejects.toThrow();
    expect(table.sent).toEqual([]);
  });
});

describe("the store on the real ports", () => {
  it("stores a hand-written set encrypted under its org's key, approves it, and hands out a signed read of that one key", async () => {
    const { store, s3, table } = world();
    const set = makeSet();
    const record = await submitOk(store, set);
    const key = fixtureObjectKey(ORG_A, PROJ, record.digest);
    expect([...s3.objects.keys()]).toEqual([key]);
    expect(dec(s3.objects.get(key)?.bytes)).toBe(canonicalJson(set));
    expect(s3.objects.get(key)).toMatchObject({ sse: "aws:kms", keyId: KEY_ARN });
    expect(record.digest).toBe(fixtureSetDigest(set));
    expect([...table.items.keys()]).toEqual([`ORG#${ORG_A}|FIXTURE#${PROJ}#${record.digest}`]);
    expect((await store.deliver(ORG_A, PROJ, record.digest))).toEqual({ ok: false, reason: "not_approved" });
    expect((await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest))).ok).toBe(true);
    const delivered = await store.deliver(ORG_A, PROJ, record.digest);
    expect(delivered).toMatchObject({ ok: true, digest: record.digest, url: `https://signed.invalid/${key}?e=900` });
  });
  it("one org can never read, review, decide or fetch another org's fixtures, and the same set in two orgs is two objects", async () => {
    const { store, s3 } = world();
    const set = makeSet();
    const a = await submitOk(store, set, ORG_A);
    await store.approve(ORG_A, PROJ, a.digest, by("approve", ORG_A, a.digest));
    const refusal = { ok: false, reason: "not_found" } as const;
    // Org B asks for org A's digest: every read answers as for a digest nobody holds.
    expect(await store.record(ORG_B, PROJ, a.digest)).toEqual(refusal);
    expect(await store.review(ORG_B, PROJ, a.digest)).toEqual(refusal);
    expect(await store.deliver(ORG_B, PROJ, a.digest)).toEqual(refusal);
    expect(await store.readApproved(ORG_B, PROJ, a.digest)).toEqual(refusal);
    expect(await store.deliverById(ORG_B, PROJ, a.storeId)).toEqual(refusal);
    // A decision org B's maintainer is entitled to make is still not a decision on org A's set.
    expect(await store.approve(ORG_B, PROJ, a.digest, by("approve", ORG_B, a.digest))).toEqual(refusal);
    expect(await store.withdraw(ORG_B, PROJ, a.digest, by("withdraw", ORG_B, a.digest))).toEqual(refusal);
    // ... and org A's decision does not work in org B's name.
    expect(await store.approve(ORG_B, PROJ, a.digest, by("approve", ORG_A, a.digest))).toEqual({ ok: false, reason: "unauthorised" });
    expect((await store.review(ORG_A, PROJ, a.digest)).ok).toBe(true);
    // The same bytes submitted by org B are a different object and a different row, still pending.
    const b = await submitOk(store, set, ORG_B);
    expect(b.digest).toBe(a.digest);
    expect(b.storeId).not.toBe(a.storeId);
    expect([...s3.objects.keys()].sort()).toEqual([fixtureObjectKey(ORG_A, PROJ, a.digest), fixtureObjectKey(ORG_B, PROJ, a.digest)].sort());
    expect((await store.record(ORG_A, PROJ, a.digest) as { record: FixtureRecord }).record.status).toBe("approved");
    expect((await store.record(ORG_B, PROJ, a.digest) as { record: FixtureRecord }).record.status).toBe("pending");
    expect(await store.deliver(ORG_B, PROJ, a.digest)).toEqual({ ok: false, reason: "not_approved" });
  });
  it("repairs a corrupt object with a conditional write, and a writer that gets in between wins instead of being overwritten", async () => {
    const { store, s3 } = world();
    const set = makeSet();
    const key = fixtureObjectKey(ORG_A, PROJ, fixtureSetDigest(set));
    s3.put(key, enc("planted"));
    // Another writer replaces the planted bytes with something else after the store has read them.
    s3.hooks.afterRead = (k) => s3.put(k, enc("raced"));
    const outcome = await store.submit(ORG_A, PROJ, set, { actor: "maya", recordedFrom: "written" });
    // The store reads again and repairs the second bad object; it never wrote over "raced" without having read it.
    expect(outcome.ok).toBe(true);
    expect(dec(s3.objects.get(key)?.bytes)).toBe(canonicalJson(set));
    // The first attempt found the object had changed under it and wrote nothing; the repair replaced the second version, held to that version's ETag, never the planted one's.
    const writes = s3.sent.filter((entry) => entry.command === "PutObjectCommand" && entry.input["IfMatch"] !== undefined);
    expect(writes.map((entry) => entry.input["IfMatch"])).toEqual(['"etag-2"']);
  });
  it("gives up with digest_mismatch, leaving the other writer's object, when the key keeps changing under it", async () => {
    const { store, s3 } = world();
    const set = makeSet();
    const key = fixtureObjectKey(ORG_A, PROJ, fixtureSetDigest(set));
    s3.put(key, enc("planted"));
    let turns = 0;
    const race = (k: string) => { turns += 1; s3.put(k, enc(`raced-${String(turns)}`)); s3.hooks.afterRead = turns < 10 ? race : undefined; };
    s3.hooks.afterRead = race;
    expect(await store.submit(ORG_A, PROJ, set, { actor: "maya", recordedFrom: "written" })).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(dec(s3.objects.get(key)?.bytes)).toMatch(/^raced-/u);
  });
  it.each([
    ["an email address", () => answer({ contact: "jane.roe@acme-corp.com" })],
    ["a production host", () => answer({ callback: "https://a.prod.example.com/x" })],
    ["a credential", () => answer({ debug: `key ${"AKIA"}${"ABCDEFGHIJKLMNOP"}` })],
    ["a card number", () => answer({ pan: ["4111", "1111", "1111", "1111"].join("") })],
  ])("scans for %s before anything is written: nothing reaches S3 or the table", async (_label, make) => {
    const { store, s3, table } = world();
    const shell = { dependency, match };
    const outcome = await store.submit(ORG_A, PROJ, makeSet({ entries: [fixtureEntry(shell, request(1), make())] }), { actor: "maya", recordedFrom: "written" });
    expect(outcome).toEqual({ ok: false, reason: "data_guard" });
    expect(s3.sent).toEqual([]);
    expect(table.sent).toEqual([]);
    expect(s3.objects.size).toBe(0);
    expect(table.items.size).toBe(0);
  });
  it("scans again at approve with today's deny list: a host marked production after the set was stored stops its approval", async () => {
    const s3 = fakeS3();
    const table = fakeTable();
    let deny = DENY;
    const store = awsFixtureStore({ s3: s3.s3, bucket: BUCKET, kmsKeyArn: KEY_ARN, documentClient: table.client, tableName: TABLE, now: () => NOW }, () => Promise.resolve(deny), { TEST_SERVICES_ENABLED: "1" });
    const shell = { dependency, match };
    const record = await submitOk(store, makeSet({ entries: [fixtureEntry(shell, request(1), answer({ link: "https://api.example-pay.com/receipt" }))] }));
    deny = { ...DENY, hosts: ["api.example-pay.com"] };
    expect(await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest))).toEqual({ ok: false, reason: "data_guard" });
  });
  it("fails closed when the deny list cannot be read: nothing is stored", async () => {
    const s3 = fakeS3();
    const table = fakeTable();
    const store = awsFixtureStore({ s3: s3.s3, bucket: BUCKET, kmsKeyArn: KEY_ARN, documentClient: table.client, tableName: TABLE }, () => Promise.reject(new Error("unavailable")), { TEST_SERVICES_ENABLED: "1" });
    await expect(store.submit(ORG_A, PROJ, makeSet(), { actor: "maya", recordedFrom: "written" })).rejects.toThrow();
    expect(s3.sent).toEqual([]);
    expect(table.sent).toEqual([]);
  });
});

describe("with tx off nothing changes", () => {
  it("answers `disabled` to every call and never touches S3 or the table", async () => {
    const { store, s3, table } = world({});
    const set = makeSet();
    const digest = fixtureSetDigest(set);
    const off = { ok: false, reason: "disabled" } as const;
    expect(await store.submit(ORG_A, PROJ, set, { actor: "maya", recordedFrom: "written" })).toEqual(off);
    expect(await store.record(ORG_A, PROJ, digest)).toEqual(off);
    expect(await store.review(ORG_A, PROJ, digest)).toEqual(off);
    expect(await store.approve(ORG_A, PROJ, digest, by("approve", ORG_A, digest))).toEqual(off);
    expect(await store.reject(ORG_A, PROJ, digest, by("reject", ORG_A, digest))).toEqual(off);
    expect(await store.withdraw(ORG_A, PROJ, digest, by("withdraw", ORG_A, digest))).toEqual(off);
    expect(await store.deliver(ORG_A, PROJ, digest)).toEqual(off);
    expect(await store.readApproved(ORG_A, PROJ, digest)).toEqual(off);
    expect(s3.sent).toEqual([]);
    expect(table.sent).toEqual([]);
  });
  it("is read on every call: switching tx off stops delivery of an approved set", async () => {
    const env: NodeJS.ProcessEnv = { TEST_SERVICES_ENABLED: "1" };
    const { store } = world(env);
    const record = await submitOk(store);
    await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest));
    expect((await store.deliver(ORG_A, PROJ, record.digest)).ok).toBe(true);
    env["TEST_SERVICES_ENABLED"] = "0";
    expect(await store.deliver(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "disabled" });
  });
  it("gives the routes no store while tx is off, without the fixture key, or with a key that is not a KMS key ARN", () => {
    const s3 = fakeS3();
    const table = fakeTable();
    const input = { s3: s3.s3, documentClient: table.client, tableName: TABLE, artifactBucketName: BUCKET };
    expect(fixtureStoreForRoutes(input, { FIXTURE_KEY_ARN: KEY_ARN })).toEqual({});
    expect(fixtureStoreForRoutes(input, { TEST_SERVICES_ENABLED: "1" })).toEqual({});
    expect(fixtureStoreForRoutes(input, { TEST_SERVICES_ENABLED: "1", FIXTURE_KEY_ARN: "alias/aws/s3" })).toEqual({});
    expect(fixtureStoreForRoutes({ ...input, artifactBucketName: "" }, { TEST_SERVICES_ENABLED: "1", FIXTURE_KEY_ARN: KEY_ARN })).toEqual({});
    expect(typeof fixtureStoreForRoutes(input, { TEST_SERVICES_ENABLED: "1", FIXTURE_KEY_ARN: KEY_ARN }).fixtureStore).toBe("function");
    expect(s3.sent).toEqual([]);
    expect(table.sent).toEqual([]);
  });
});

// The memory store and the real ports implement one contract: the same flow gives the same answers on both.
describe("the real ports answer as the memory ports do", () => {
  it("gives the same refusal reasons for the same calls", async () => {
    const real = world().store;
    const { createMemoryFixturePorts } = await import("../../packages/broker/src/test-env/fixture-store.js");
    const ports = createMemoryFixturePorts();
    const memory = createFixtureStore({ enabled: () => true, objects: ports.objects, index: ports.index, denyFor: () => Promise.resolve(DENY), now: () => NOW });
    const set = makeSet();
    const run = async (store: typeof real) => {
      const first = await store.submit(ORG_A, PROJ, set, { actor: "maya", recordedFrom: "written" });
      const again = await store.submit(ORG_A, PROJ, set, { actor: "maya", recordedFrom: "written" });
      const digest = fixtureSetDigest(set);
      return [first.ok && first.created, again.ok && again.created, (await store.reject(ORG_A, PROJ, digest, by("reject", ORG_A, digest))).ok, (await store.approve(ORG_A, PROJ, digest, by("approve", ORG_A, digest))).ok === false ? "already_decided" : "approved"];
    };
    expect(await run(real)).toEqual(await run(memory));
  });
});
