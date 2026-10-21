// tests/contract/audit-keyring.test.ts
// Task 7 of the Audit Ledger plan: the details vault. The keys table is FakeDynamoDb; KMS is FakeKms, which enforces the
// vault key policy's encryption-context conditions and KMS's rule that Decrypt needs the context the key was made with.
import { createDecipheriv, createHmac } from "node:crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { detailCommit } from "@rovara/audit-verifier";
import { AuditKeyring } from "../../packages/broker/src/audit/keyring.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeKms } from "../support/fake-kms.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb";
const KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const KEYS_TABLE = "keys";
const START = Date.parse("2026-10-20T12:00:00.000Z");

type Command = { constructor: { name: string }; input: Record<string, unknown> };

function harness(options: { cacheMs?: number } = {}) {
  const db = new FakeDynamoDb();
  const kms = new FakeKms(KEY_ARN);
  const clock = { now: START };
  /** Every command the keyring sent, and a hook that can run between a read and the write that follows it. */
  const sent: Command[] = [];
  const hooks: { afterGet?: (command: Command) => void } = {};
  const documentClient = {
    send: async (command: Command) => {
      sent.push(command);
      const result = await db.send(command);
      if (command.constructor.name === "GetCommand") hooks.afterGet?.(command);
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  const make = (client = kms) => new AuditKeyring({ documentClient, keysTable: KEYS_TABLE, kms: client.client, keyId: KEY_ARN, now: () => clock.now, ...(options.cacheMs === undefined ? {} : { cacheMs: options.cacheMs }) });
  return { db, kms, clock, sent, hooks, keyring: make(), make };
}

const keyItems = (db: FakeDynamoDb, orgId = ORG) => db.find((item) => item.pk === `ORG#${orgId}`);
const sorts = (db: FakeDynamoDb, orgId = ORG) => keyItems(db, orgId).map((item) => item.sk as string).sort();

/** Unwraps a stored subject or pseudonym key the way the keyring does, to check the format with an independent implementation. */
function unwrap(item: Record<string, unknown>, dataKey: Uint8Array, orgId: string): Buffer {
  const wrapped = Buffer.from(String(item.wrapped), "base64");
  const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(String(item.iv), "base64"));
  decipher.setAAD(Buffer.from(`${orgId}\n${String(item.sk)}`));
  decipher.setAuthTag(wrapped.subarray(wrapped.length - 16));
  return Buffer.concat([decipher.update(wrapped.subarray(0, wrapped.length - 16)), decipher.final()]);
}

describe("the data key", () => {
  it("is made once under the org's encryption context, named by the key's ARN, and stored only as KMS ciphertext", async () => {
    const h = harness();
    const key = await h.keyring.dataKey(ORG, true);
    expect(key).toBeInstanceOf(Uint8Array);
    expect((key as Uint8Array).length).toBe(32);
    const stored = h.db.get(`ORG#${ORG}`, "DATA_KEY")!;
    expect(Object.keys(stored).sort()).toStrictEqual(["createdAt", "pk", "sk", "wrapped"]);
    expect(stored.createdAt).toBe(new Date(START).toISOString());
    expect(h.kms.calls.map((call) => [call.operation, call.keyId, call.context])).toStrictEqual([
      ["GenerateDataKey", KEY_ARN, { "rovara:purpose": "audit-details", "rovara:org": ORG }],
    ]);
    // The plaintext key is nowhere in the table.
    expect(JSON.stringify(keyItems(h.db))).not.toContain(Buffer.from(key as Uint8Array).toString("base64"));
    expect(JSON.stringify(keyItems(h.db))).not.toContain(Buffer.from(key as Uint8Array).toString("hex"));
  });

  it("is read back with Decrypt under the same context by a keyring that has nothing cached", async () => {
    const h = harness();
    const first = await h.keyring.dataKey(ORG, true) as Uint8Array;
    const second = await h.make().dataKey(ORG, false) as Uint8Array;
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    expect(h.kms.calls.map((call) => call.operation)).toStrictEqual(["GenerateDataKey", "Decrypt"]);
    expect(h.kms.calls[1]).toMatchObject({ keyId: KEY_ARN, context: { "rovara:purpose": "audit-details", "rovara:org": ORG }, refused: false });
  });

  it("is not made when the caller only reads", async () => {
    const h = harness();
    expect(await h.keyring.dataKey(ORG, false)).toBeUndefined();
    expect(keyItems(h.db)).toStrictEqual([]);
    expect(h.kms.calls).toStrictEqual([]);
  });

  it("is cached for cacheMs (default five minutes) and decrypted again after that", async () => {
    const h = harness();
    await h.keyring.dataKey(ORG, true);
    const before = h.kms.calls.length;
    h.clock.now += 299_999;
    await h.keyring.dataKey(ORG, true);
    expect(h.kms.calls).toHaveLength(before);
    h.clock.now += 2;
    await h.keyring.dataKey(ORG, true);
    expect(h.kms.calls.map((call) => call.operation).slice(before)).toStrictEqual(["Decrypt"]);
  });

  it("honours a shorter cacheMs", async () => {
    const h = harness({ cacheMs: 1000 });
    await h.keyring.dataKey(ORG, true);
    const before = h.kms.calls.length;
    h.clock.now += 1001;
    await h.keyring.dataKey(ORG, true);
    expect(h.kms.calls).toHaveLength(before + 1);
  });

  it("settles a lost race on the stored key: both callers end with the same key and there is one item", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.keyring.dataKey(ORG, true), h.make().dataKey(ORG, true)]);
    expect(Buffer.from(a as Uint8Array).equals(Buffer.from(b as Uint8Array))).toBe(true);
    expect(h.db.find((item) => item.sk === "DATA_KEY")).toHaveLength(1);
  });

  it("is created only with attribute_not_exists(pk)", async () => {
    const h = harness();
    await h.keyring.dataKey(ORG, true);
    const puts = h.sent.filter((command) => command.constructor.name === "PutCommand");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.input.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(puts[0]!.input.TableName).toBe(KEYS_TABLE);
  });
});

describe("pseudonyms", () => {
  it('are "n_" and the first 32 hex of HMAC-SHA256(pseudonymKey, kind + "\\n" + name)', async () => {
    const h = harness();
    const pseudonym = await h.keyring.pseudonym(ORG, "project", "web");
    expect(pseudonym).toMatch(/^n_[0-9a-f]{32}$/);
    const dataKey = await h.keyring.dataKey(ORG, false) as Uint8Array;
    const pseudonymKey = unwrap(h.db.get(`ORG#${ORG}`, "PSEUDONYM_KEY")!, dataKey, ORG);
    expect(pseudonymKey.length).toBe(32);
    expect(pseudonym).toBe(`n_${createHmac("sha256", pseudonymKey).update("project\nweb").digest("hex").slice(0, 32)}`);
  });

  it("are stable across keyrings, differ by kind, by name and between orgs", async () => {
    const h = harness();
    const first = await h.keyring.pseudonym(ORG, "project", "web");
    expect(await h.make().pseudonym(ORG, "project", "web")).toBe(first);
    expect(await h.keyring.pseudonym(ORG, "repository", "web")).not.toBe(first);
    expect(await h.keyring.pseudonym(ORG, "project", "api")).not.toBe(first);
    expect(await h.keyring.pseudonym(OTHER_ORG, "project", "web")).not.toBe(first);
  });

  it("hold no name: the stored key is wrapped, and no table item mentions the name", async () => {
    const h = harness();
    await h.keyring.pseudonym(ORG, "domain", "payroll.example.com");
    expect(JSON.stringify([...h.db.items.values()])).not.toContain("payroll");
    expect(Object.keys(h.db.get(`ORG#${ORG}`, "PSEUDONYM_KEY")!).sort()).toStrictEqual(["iv", "pk", "sk", "wrapped"]);
  });

  it('become "n_shredded" after SHREDDED, and no key is made', async () => {
    const h = harness();
    h.db.set({ pk: `ORG#${ORG}`, sk: "SHREDDED", at: "2026-10-01T00:00:00.000Z" });
    expect(await h.keyring.pseudonym(ORG, "project", "web")).toBe("n_shredded");
    expect(sorts(h.db)).toStrictEqual(["SHREDDED"]);
    expect(h.kms.calls).toStrictEqual([]);
  });

  it("see SHREDDED at once, even with the data key cached", async () => {
    const h = harness();
    const before = await h.keyring.pseudonym(ORG, "project", "web");
    expect(before).not.toBe("n_shredded");
    h.db.set({ pk: `ORG#${ORG}`, sk: "SHREDDED", at: "2026-10-01T00:00:00.000Z" });
    expect(await h.keyring.pseudonym(ORG, "project", "web")).toBe("n_shredded");
    expect(await h.keyring.dataKey(ORG, true)).toBe("shredded");
  });
});

describe("sealing and opening details", () => {
  const parts = [
    { subject: "org", fields: { targetName: "payroll", reason: "ada@example.com asked" } },
    { subject: "dev_1", fields: { login: "ada-lovelace", email: "ada@example.com" } },
  ];

  it("seals each part for its subject with a commitment the verifier recomputes, and the plaintext is only in the ciphertext", async () => {
    const h = harness();
    const sealed = await h.keyring.sealDetails(ORG, 4, parts);
    expect(sealed.commits.map((entry) => entry.subject)).toStrictEqual(["org", "dev_1"]);
    expect(sealed.sealed.map((entry) => entry.subject)).toStrictEqual(["org", "dev_1"]);
    for (const entry of sealed.sealed) expect(Object.keys(entry).sort()).toStrictEqual(["ciphertext", "iv", "subject"]);
    const text = JSON.stringify(sealed);
    for (const secret of ["payroll", "ada@example.com", "ada-lovelace"]) expect(text).not.toContain(secret);
    expect(sorts(h.db)).toStrictEqual(["DATA_KEY", "SUBJECT#dev_1", "SUBJECT#org"]);

    const opened = await h.keyring.openDetails(ORG, 4, sealed.sealed);
    expect(opened).toHaveLength(2);
    for (const [index, entry] of opened.entries()) {
      expect(entry).not.toHaveProperty("erased");
      const open = entry as { subject: string; salt: string; fields: Record<string, string> };
      expect(open.subject).toBe(parts[index]!.subject);
      expect(open.fields).toStrictEqual(parts[index]!.fields);
      expect(open.salt).toMatch(/^[0-9a-f]{64}$/);
      expect(detailCommit(Uint8Array.from(Buffer.from(open.salt, "hex")), open.subject, open.fields)).toBe(sealed.commits[index]!.commit);
    }
  });

  it("uses a new salt and a new IV every time, so equal details have different commitments and ciphertexts", async () => {
    const h = harness();
    const [a, b] = [await h.keyring.sealDetails(ORG, 1, [parts[1]!]), await h.keyring.sealDetails(ORG, 1, [parts[1]!])];
    expect(a.commits[0]!.commit).not.toBe(b.commits[0]!.commit);
    expect(a.sealed[0]!.ciphertext).not.toBe(b.sealed[0]!.ciphertext);
    expect(a.sealed[0]!.iv).not.toBe(b.sealed[0]!.iv);
  });

  it("binds a ciphertext to its org, sequence number and subject: moved, it does not open", async () => {
    const h = harness();
    const sealed = (await h.keyring.sealDetails(ORG, 4, [parts[1]!])).sealed;
    await expect(h.keyring.openDetails(ORG, 5, sealed)).rejects.toThrow();
    await expect(h.keyring.openDetails(ORG, 4, [{ ...sealed[0]!, subject: "dev_2" }])).resolves.toStrictEqual([{ subject: "dev_2", erased: true }]);
    // Under another subject's key the same ciphertext is refused as well.
    await h.keyring.sealDetails(ORG, 4, [{ subject: "dev_2", fields: { login: "x" } }]);
    await expect(h.keyring.openDetails(ORG, 4, [{ ...sealed[0]!, subject: "dev_2" }])).rejects.toThrow();
  });

  it("omits an erased subject's part: the tombstone is the only thing stored, and no key is made for it", async () => {
    const h = harness();
    await h.keyring.sealDetails(ORG, 1, parts);
    h.db.set({ pk: `ORG#${ORG}`, sk: "SUBJECT#dev_1", erasedAt: "2026-10-19T00:00:00.000Z" });
    const sealed = await h.keyring.sealDetails(ORG, 2, parts);
    expect(sealed.commits.map((entry) => entry.subject)).toStrictEqual(["org"]);
    expect(sealed.sealed.map((entry) => entry.subject)).toStrictEqual(["org"]);
    expect(h.db.get(`ORG#${ORG}`, "SUBJECT#dev_1")).toStrictEqual({ pk: `ORG#${ORG}`, sk: "SUBJECT#dev_1", erasedAt: "2026-10-19T00:00:00.000Z" });
    expect(await h.keyring.subjectKey(ORG, "dev_1", true)).toBe("erased");
  });

  it("omits an erased subject at once, even when its key was used a moment ago", async () => {
    const h = harness();
    await h.keyring.sealDetails(ORG, 1, parts);
    h.db.delete(`ORG#${ORG}`, "SUBJECT#dev_1");
    h.db.set({ pk: `ORG#${ORG}`, sk: "SUBJECT#dev_1", erasedAt: "2026-10-19T00:00:00.000Z" });
    const sealed = await h.keyring.sealDetails(ORG, 2, [parts[1]!]);
    expect(sealed).toStrictEqual({ commits: [], sealed: [] });
  });

  it("opens an erased subject's old ciphertext as erased, and the others as before", async () => {
    const h = harness();
    const sealed = await h.keyring.sealDetails(ORG, 3, parts);
    h.db.set({ pk: `ORG#${ORG}`, sk: "SUBJECT#dev_1", erasedAt: "2026-10-19T00:00:00.000Z" });
    const opened = await h.keyring.openDetails(ORG, 3, sealed.sealed);
    expect(opened[0]).toMatchObject({ subject: "org", fields: parts[0]!.fields });
    expect(opened[1]).toStrictEqual({ subject: "dev_1", erased: true });
  });

  it("also treats a deleted subject key (no tombstone) as erased when reading, and makes no key when only reading", async () => {
    const h = harness();
    const sealed = await h.keyring.sealDetails(ORG, 3, parts);
    h.db.delete(`ORG#${ORG}`, "SUBJECT#dev_1");
    expect((await h.keyring.openDetails(ORG, 3, sealed.sealed))[1]).toStrictEqual({ subject: "dev_1", erased: true });
    expect(h.db.get(`ORG#${ORG}`, "SUBJECT#dev_1")).toBeUndefined();
  });

  it("omits every part after SHREDDED and makes no key, even for a keyring that has the data key cached", async () => {
    const h = harness();
    await h.keyring.sealDetails(ORG, 1, parts);
    h.db.set({ pk: `ORG#${ORG}`, sk: "SHREDDED", at: "2026-10-19T00:00:00.000Z" });
    for (const key of ["DATA_KEY", "SUBJECT#org", "SUBJECT#dev_1"]) h.db.delete(`ORG#${ORG}`, key);
    const sealed = await h.keyring.sealDetails(ORG, 2, [...parts, { subject: "dev_9", fields: { login: "new" } }]);
    expect(sealed).toStrictEqual({ commits: [], sealed: [] });
    expect(sorts(h.db)).toStrictEqual(["SHREDDED"]);
    expect(await h.keyring.subjectKey(ORG, "dev_9", true)).toBe("shredded");
    expect(await h.make().sealDetails(ORG, 2, parts)).toStrictEqual({ commits: [], sealed: [] });
    expect(sorts(h.db)).toStrictEqual(["SHREDDED"]);
  });

  it("opens everything as erased after SHREDDED", async () => {
    const h = harness();
    const sealed = await h.keyring.sealDetails(ORG, 1, parts);
    h.db.set({ pk: `ORG#${ORG}`, sk: "SHREDDED", at: "2026-10-19T00:00:00.000Z" });
    expect(await h.keyring.openDetails(ORG, 1, sealed.sealed)).toStrictEqual([{ subject: "org", erased: true }, { subject: "dev_1", erased: true }]);
  });

  it("never makes a key for a subject whose tombstone appears between the read and the write", async () => {
    const h = harness();
    // The data key must exist already, so the only create in play is the subject's.
    await h.keyring.dataKey(ORG, true);
    let injected = false;
    h.hooks.afterGet = (command) => {
      const key = command.input.Key as { sk?: string };
      if (injected || key.sk !== "SUBJECT#dev_1") return;
      injected = true;
      h.db.set({ pk: `ORG#${ORG}`, sk: "SUBJECT#dev_1", erasedAt: "2026-10-19T00:00:00.000Z" });
    };
    const sealed = await h.keyring.sealDetails(ORG, 1, [parts[1]!]);
    expect(injected).toBe(true);
    expect(sealed).toStrictEqual({ commits: [], sealed: [] });
    expect(h.db.get(`ORG#${ORG}`, "SUBJECT#dev_1")).toStrictEqual({ pk: `ORG#${ORG}`, sk: "SUBJECT#dev_1", erasedAt: "2026-10-19T00:00:00.000Z" });
  });

  it("creates every key with attribute_not_exists(pk), and never deletes or overwrites", async () => {
    const h = harness();
    await h.keyring.sealDetails(ORG, 1, parts);
    await h.keyring.pseudonym(ORG, "project", "web");
    const writes = h.sent.filter((command) => !["GetCommand"].includes(command.constructor.name));
    expect(writes.length).toBeGreaterThan(0);
    for (const command of writes) {
      expect(command.constructor.name).toBe("PutCommand");
      expect(command.input.ConditionExpression).toBe("attribute_not_exists(pk)");
      expect(command.input.TableName).toBe(KEYS_TABLE);
    }
  });

  it("settles two keyrings creating the same subject key together on one key", async () => {
    const h = harness();
    await h.keyring.dataKey(ORG, true);
    const other = h.make();
    const [first, second] = await Promise.all([h.keyring.sealDetails(ORG, 1, [parts[1]!]), other.sealDetails(ORG, 2, [parts[1]!])]);
    expect(h.db.find((item) => item.sk === "SUBJECT#dev_1")).toHaveLength(1);
    expect(await h.keyring.openDetails(ORG, 1, first.sealed)).toHaveLength(1);
    expect(await other.openDetails(ORG, 2, second.sealed)).toHaveLength(1);
  });
});

describe("one org's keys do not open another's", () => {
  it("refuses a decrypt with another org's context", async () => {
    const h = harness();
    await h.keyring.dataKey(ORG, true);
    const blob = Buffer.from(String(h.db.get(`ORG#${ORG}`, "DATA_KEY")!.wrapped), "base64");
    const { DecryptCommand } = await import("@aws-sdk/client-kms");
    await expect(h.kms.client.send(new DecryptCommand({ KeyId: KEY_ARN, CiphertextBlob: blob, EncryptionContext: { "rovara:purpose": "audit-details", "rovara:org": OTHER_ORG } })))
      .rejects.toMatchObject({ name: "InvalidCiphertextException" });
    await expect(h.kms.client.send(new DecryptCommand({ KeyId: KEY_ARN, CiphertextBlob: blob, EncryptionContext: { "rovara:purpose": "audit-details", "rovara:org": ORG } })))
      .resolves.toHaveProperty("Plaintext");
  });

  it("does not open org A's data key when it is copied into org B's partition", async () => {
    const h = harness();
    const sealed = await h.keyring.sealDetails(ORG, 1, [{ subject: "dev_1", fields: { login: "ada" } }]);
    for (const sk of ["DATA_KEY", "SUBJECT#dev_1"]) h.db.set({ ...h.db.get(`ORG#${ORG}`, sk)!, pk: `ORG#${OTHER_ORG}` });
    await expect(h.make().openDetails(OTHER_ORG, 1, sealed.sealed)).rejects.toMatchObject({ name: "InvalidCiphertextException" });
    expect(h.kms.calls.at(-1)).toMatchObject({ operation: "Decrypt", refused: true, context: { "rovara:org": OTHER_ORG } });
  });
});

describe("FakeKms enforces the key policy it stands for", () => {
  it("lets the broker Decrypt and not GenerateDataKey, and refuses anyone else", async () => {
    const h = harness();
    await h.keyring.dataKey(ORG, true);
    const asBroker = h.make(h.kms.as("broker"));
    expect((await asBroker.dataKey(ORG, false)) instanceof Uint8Array).toBe(true);
    await expect(h.make(h.kms.as("broker")).dataKey(OTHER_ORG, true)).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(h.make(h.kms.as("other")).dataKey(ORG, false)).rejects.toMatchObject({ name: "AccessDeniedException" });
  });

  it("refuses a context without rovara:org, with another purpose, and a key named by alias", async () => {
    const h = harness();
    const { GenerateDataKeyCommand } = await import("@aws-sdk/client-kms");
    const generate = (KeyId: string, EncryptionContext: Record<string, string>) => h.kms.client.send(new GenerateDataKeyCommand({ KeyId, KeySpec: "AES_256", EncryptionContext }));
    await expect(generate(KEY_ARN, { "rovara:purpose": "audit-details" })).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(generate(KEY_ARN, { "rovara:purpose": "something-else", "rovara:org": ORG })).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(generate("alias/agentx/production/audit-vault", { "rovara:purpose": "audit-details", "rovara:org": ORG })).rejects.toMatchObject({ name: "NotFoundException" });
  });

  it("the keyring never names the key by an alias", async () => {
    const h = harness();
    await h.keyring.sealDetails(ORG, 1, [{ subject: "dev_1", fields: { a: "b" } }]);
    await h.make().dataKey(ORG, false);
    expect(h.kms.calls.length).toBeGreaterThan(1);
    expect(new Set(h.kms.calls.map((call) => call.keyId))).toStrictEqual(new Set([KEY_ARN]));
  });
});
