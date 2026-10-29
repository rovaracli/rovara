// The audit ledger's details vault. Personal details (names, emails, logins, reasons) never enter the chain: a record
// holds a salted commitment per subject, and the details themselves are sealed here with AES-256-GCM under a key that
// belongs to one subject (`org` or a developer id). That key is wrapped by the org's data key, which KMS wrapped under
// the vault key. Erasing a person deletes their key and leaves a tombstone; shredding an org leaves SHREDDED. After either,
// this keyring never creates that key again: a person's later events are recorded without their details.
//
// Keys table (AuditKeysTable), all under pk `ORG#<orgId>`:
//   DATA_KEY          { wrapped /* KMS ciphertext, base64 */, createdAt }
//   PSEUDONYM_KEY     { iv, wrapped }   32 random bytes, AES-256-GCM under the data key, AAD "<orgId>\n<sk>"
//   SUBJECT#<subject> { iv, wrapped }, or the tombstone { erasedAt } with no key
//   SHREDDED          { at }
//
// Every KMS call carries the encryption context { "rovara:purpose": "audit-details", "rovara:org": <orgId> }, which the
// vault key policy requires, and names the key by its ARN (never by the alias, which an administrator could repoint).
import { auditFramed } from "./search-index.js";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { auditCanonicalJson, detailCommit, type AuditDetailPart } from "@agentx/contracts";

export const AUDIT_KEY_CACHE_MS = 300_000;
/** What a name-keyed target becomes once its org is shredded. */
export const AUDIT_SHREDDED_PSEUDONYM = "n_shredded";

export interface AuditKeyringOptions {
  documentClient: DynamoDBDocumentClient;
  keysTable: string;
  kms: KMSClient;
  /** The vault key's ARN. */
  keyId: string;
  now: () => number;
  /** How long a decrypted data key stays in memory. Erasure and shredding are still seen at once: only KMS output is cached. */
  cacheMs?: number;
}

/** One detail part, sealed: base64 IV, and base64 ciphertext with the GCM tag appended. */
export interface SealedDetail {
  subject: string;
  iv: string;
  ciphertext: string;
}

export interface SealedDetails {
  /** One commitment per sealed part, in the order of the parts. The record holds these. */
  commits: Array<{ subject: string; commit: string }>;
  sealed: SealedDetail[];
}

export type OpenedDetail =
  | { subject: string; salt: string; fields: Record<string, string> }
  | { subject: string; erased: true };

const GCM_TAG_BYTES = 16;
const GCM_IV_BYTES = 12;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function encryptionContext(orgId: string): Record<string, string> {
  return { "rovara:purpose": "audit-details", "rovara:org": orgId };
}

function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): { iv: string; ciphertext: string } {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString("base64"), ciphertext: body.toString("base64") };
}

function open(key: Uint8Array, sealed: { iv: string; ciphertext: string }, aad: string): Buffer {
  const body = Buffer.from(sealed.ciphertext, "base64");
  if (body.length < GCM_TAG_BYTES) throw new Error("audit keyring: a sealed value is too short");
  const iv = Buffer.from(sealed.iv, "base64");
  if (iv.length !== GCM_IV_BYTES) throw new Error("audit keyring: a sealed value has a malformed IV");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(body.subarray(body.length - GCM_TAG_BYTES));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - GCM_TAG_BYTES)), decipher.final()]);
}

export class AuditKeyring {
  private readonly documentClient: DynamoDBDocumentClient;
  private readonly keysTable: string;
  private readonly kms: KMSClient;
  private readonly keyId: string;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly cache = new Map<string, { key: Buffer; expiresAt: number }>();

  constructor(options: AuditKeyringOptions) {
    this.documentClient = options.documentClient;
    this.keysTable = options.keysTable;
    this.kms = options.kms;
    this.keyId = options.keyId;
    this.now = options.now;
    this.cacheMs = options.cacheMs ?? AUDIT_KEY_CACHE_MS;
  }

  private async item(orgId: string, sk: string): Promise<Record<string, unknown> | undefined> {
    // Strongly consistent: an erasure or a shred must be seen by the very next append.
    const response = await this.documentClient.send(new GetCommand({ TableName: this.keysTable, Key: { pk: `ORG#${orgId}`, sk }, ConsistentRead: true }));
    return response.Item;
  }

  private async put(orgId: string, sk: string, fields: Record<string, unknown>): Promise<"created" | "exists"> {
    try {
      // attribute_not_exists(pk) on the item itself: an existing key, or a tombstone, is never overwritten.
      await this.documentClient.send(new PutCommand({
        TableName: this.keysTable,
        Item: { pk: `ORG#${orgId}`, sk, ...fields },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return "created";
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return "exists";
      throw error;
    }
  }

  /**
   * Whether the org is shredded (also forgets its cached data key). Hand-off to Task 15: its shred sweep starts at least 30 s
   * (the appender's timeout plus margin) after SHREDDED is written and deletes every item in the ORG#<org> partition of the keys table except SHREDDED itself (which must stay, or keys would be created again).
   * Until then, every key creation here re-checks this after its write (see liveDataKey and wrappedKey).
   */
  private async isShredded(orgId: string): Promise<boolean> {
    const shredded = (await this.item(orgId, "SHREDDED")) !== undefined;
    if (shredded) this.cache.delete(orgId);
    return shredded;
  }

  /**
   * Whether the org has been shredded (read consistently). The export code asks this before it starts, builds or signs anything for
   * an org: a shredded company's details are gone for good, and nothing may be handed out as if they were not.
   */
  async isOrgShredded(orgId: string): Promise<boolean> {
    return this.isShredded(orgId);
  }

  private remember(orgId: string, key: Buffer): Buffer {
    // Keep a warm Lambda's memory bounded: forget every key whose time is up.
    for (const [cachedOrg, entry] of this.cache) if (this.now() >= entry.expiresAt) this.cache.delete(cachedOrg);
    this.cache.set(orgId, { key, expiresAt: this.now() + this.cacheMs });
    return key;
  }

  private async unwrapDataKey(orgId: string, wrapped: unknown): Promise<Buffer> {
    if (typeof wrapped !== "string") throw new Error("audit keyring: the stored data key is malformed");
    const response = await this.kms.send(new DecryptCommand({
      KeyId: this.keyId,
      CiphertextBlob: Buffer.from(wrapped, "base64"),
      EncryptionContext: encryptionContext(orgId),
    }));
    if (response.Plaintext === undefined) throw new Error("audit keyring: KMS returned no data key");
    return Buffer.from(response.Plaintext);
  }

  /** The org's data key, assuming the org is not shredded (the callers have checked). "shredded" if a shred landed during a create. */
  private async liveDataKey(orgId: string, create: boolean): Promise<Buffer | "shredded" | undefined> {
    const cached = this.cache.get(orgId);
    if (cached !== undefined && this.now() < cached.expiresAt) return cached.key;
    const stored = await this.item(orgId, "DATA_KEY");
    if (stored !== undefined) return this.remember(orgId, await this.unwrapDataKey(orgId, stored.wrapped));
    if (!create) return undefined;
    const generated = await this.kms.send(new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: "AES_256", EncryptionContext: encryptionContext(orgId) }));
    if (generated.Plaintext === undefined || generated.CiphertextBlob === undefined) throw new Error("audit keyring: KMS returned no data key");
    const created = await this.put(orgId, "DATA_KEY", { wrapped: Buffer.from(generated.CiphertextBlob).toString("base64"), createdAt: new Date(this.now()).toISOString() });
    if (created === "exists") {
      // Lost the race: use the key that won.
      const winner = await this.item(orgId, "DATA_KEY");
      if (winner === undefined) throw new Error("audit keyring: the data key vanished during creation");
      if (await this.isShredded(orgId)) return "shredded";
      return this.remember(orgId, await this.unwrapDataKey(orgId, winner.wrapped));
    }
    // SHREDDED hand-off (Task 15): the keys table grants no ConditionCheckItem, so a shred cannot be made a condition of
    // this write. Look again instead: a shred that landed in between leaves this one unused key, and nothing is sealed under
    // it. The shred sweep must therefore start at least 30 s (the appender's timeout, plus margin) after SHREDDED is
    // written and delete every item in the ORG#<org> partition of the keys table except SHREDDED (a query, not a list of known sort keys), so that
    // every create already in flight has landed before the sweep and no key outlives it.
    if (await this.isShredded(orgId)) return "shredded";
    return this.remember(orgId, Buffer.from(generated.Plaintext));
  }

  /**
   * The org's data key. `create` makes it (once: a lost race returns the winner's key); without it a missing key is
   * `undefined`. `"shredded"` when the org has been shredded; nothing is ever created after that.
   */
  async dataKey(orgId: string, create: boolean): Promise<Uint8Array | "shredded" | undefined> {
    if (await this.isShredded(orgId)) return "shredded";
    return this.liveDataKey(orgId, create);
  }

  /**
   * A key stored as { iv, wrapped } under the data key: `PSEUDONYM_KEY` or `SUBJECT#<subject>`. `"erased"` for a tombstone
   * (the item exists with `erasedAt` and no key). Created when missing and `create` is set, never over an existing item,
   * so a tombstone that appears between the read and the write wins. Assumes the org is not shredded.
   */
  private async wrappedKey(orgId: string, sk: string, create: boolean): Promise<Buffer | "erased" | "shredded" | undefined> {
    const stored = await this.item(orgId, sk);
    if (stored?.erasedAt !== undefined) return "erased";
    if (stored !== undefined) return this.unwrapKey(orgId, sk, stored, create);
    if (!create) return undefined;
    const dataKey = await this.liveDataKey(orgId, true);
    if (dataKey === "shredded") return "shredded";
    if (dataKey === undefined) throw new Error("audit keyring: no data key");
    const fresh = randomBytes(32);
    const wrapped = seal(dataKey, fresh, `${orgId}\n${sk}`);
    const created = await this.put(orgId, sk, { iv: wrapped.iv, wrapped: wrapped.ciphertext });
    // The same SHREDDED hand-off as in liveDataKey: the data key may have come from the cache, and a shred plus sweep can
    // land after the caller's check and before this put, which then succeeds because the sweep removed the item. Look
    // again after every create and after a lost race, and use nothing if the org is shredded.
    if (created === "created") {
      if (await this.isShredded(orgId)) return "shredded";
      // A tombstone can replace the new key before it is used (erasure writes the tombstone as one overwriting Put).
      const current = await this.item(orgId, sk);
      if (current?.erasedAt !== undefined) return "erased";
      return fresh;
    }
    // Another writer, or a tombstone, got there first: read what is there.
    const winner = await this.item(orgId, sk);
    if (winner === undefined) throw new Error("audit keyring: a key vanished during creation");
    if (winner.erasedAt !== undefined) return "erased";
    if (await this.isShredded(orgId)) return "shredded";
    return this.unwrapKey(orgId, sk, winner, true);
  }

  private async unwrapKey(orgId: string, sk: string, stored: Record<string, unknown>, create: boolean): Promise<Buffer | undefined> {
    const dataKey = await this.liveDataKey(orgId, false);
    if (dataKey === undefined || dataKey === "shredded") {
      // A key without its data key: while sealing that is a fault to surface; while reading, the details are unrecoverable.
      if (create) throw new Error("audit keyring: a stored key has no data key");
      return undefined;
    }
    if (typeof stored.iv !== "string" || typeof stored.wrapped !== "string") throw new Error("audit keyring: a stored key is malformed");
    return open(dataKey, { iv: stored.iv, ciphertext: stored.wrapped }, `${orgId}\n${sk}`);
  }

  /** One subject's key: `"erased"` after a tombstone, `"shredded"` after SHREDDED; created on first use when `create`. */
  async subjectKey(orgId: string, subject: string, create: boolean): Promise<Uint8Array | "erased" | "shredded" | undefined> {
    if (await this.isShredded(orgId)) return "shredded";
    return this.wrappedKey(orgId, `SUBJECT#${subject}`, create);
  }

  /** Appender preparation only. Readers never create a cursor key; a shredded org stays shredded. */
  async prepareCursorKey(orgId: string): Promise<void> {
    if (await this.isShredded(orgId)) return;
    await this.wrappedKey(orgId, "PSEUDONYM_KEY", true);
  }

  /** Full, domain-separated MAC from the existing org key, never a pseudonym output. */
  async auditCursorTag(orgId: string, payload: string): Promise<string> {
    if (await this.isShredded(orgId)) throw new Error("audit cursor unavailable");
    const key = await this.wrappedKey(orgId, "PSEUDONYM_KEY", false);
    if (!Buffer.isBuffer(key) || await this.isShredded(orgId)) throw new Error("audit cursor unavailable");
    return createHmac("sha256", key).update(auditFramed(["rovara.audit.cursor.v1", orgId, payload])).digest("hex");
  }

  /**
   * The id a name-keyed target has in the chain: `"n_" + HMAC-SHA256(pseudonymKey, kind + "\n" + name).hex.slice(0, 32)`.
   * Stable for an org, different between orgs, and meaningless without the org's pseudonym key. After SHREDDED every name
   * becomes `"n_shredded"` and no key is made.
   */
  async pseudonym(orgId: string, kind: string, name: string): Promise<string> {
    if (await this.isShredded(orgId)) return AUDIT_SHREDDED_PSEUDONYM;
    const key = await this.wrappedKey(orgId, "PSEUDONYM_KEY", true);
    if (key === "shredded") return AUDIT_SHREDDED_PSEUDONYM;
    // Nothing erases a pseudonym key: a tombstone here is corruption, and folding every name into one id would hide it.
    if (key === "erased") throw new Error("audit keyring: the pseudonym key reads as a tombstone");
    if (key === undefined) throw new Error("audit keyring: no pseudonym key");
    return `n_${createHmac("sha256", key).update(`${kind}\n${name}`).digest("hex").slice(0, 32)}`;
  }

  /**
   * Seals each part under its subject's key, with a fresh 32-byte salt (the commitment is `detailCommit(salt, subject,
   * fields)`) and a fresh IV; AAD is `"<orgId>\n<seq>\n<subject>"`, so a ciphertext opens only for its own org, record and
   * subject. A part whose subject is erased, or every part of a shredded org, is omitted: the event still appends.
   */
  async sealDetails(orgId: string, seq: number, parts: readonly AuditDetailPart[]): Promise<SealedDetails> {
    const result: SealedDetails = { commits: [], sealed: [] };
    if (await this.isShredded(orgId)) return result;
    for (const part of parts) {
      const key = await this.wrappedKey(orgId, `SUBJECT#${part.subject}`, true);
      if (key === "shredded") return { commits: [], sealed: [] };
      if (key === "erased" || key === undefined) continue;
      const salt = randomBytes(32);
      const plaintext = Buffer.from(auditCanonicalJson({ salt: salt.toString("hex"), fields: part.fields }));
      const sealed = seal(key, plaintext, `${orgId}\n${String(seq)}\n${part.subject}`);
      result.commits.push({ subject: part.subject, commit: detailCommit(salt, part.subject, part.fields) });
      result.sealed.push({ subject: part.subject, ...sealed });
    }
    return result;
  }

  /** Opens sealed parts; a part whose subject was erased (or whose org was shredded) comes back `{ erased: true }`. A tampered or misplaced ciphertext throws. */
  async openDetails(orgId: string, seq: number, sealed: readonly SealedDetail[]): Promise<OpenedDetail[]> {
    const shredded = await this.isShredded(orgId);
    const opened: OpenedDetail[] = [];
    for (const entry of sealed) {
      const key = shredded ? "shredded" : await this.wrappedKey(orgId, `SUBJECT#${entry.subject}`, false);
      if (typeof key === "string" || key === undefined) {
        opened.push({ subject: entry.subject, erased: true });
        continue;
      }
      const plaintext = open(key, entry, `${orgId}\n${String(seq)}\n${entry.subject}`);
      const parsed = JSON.parse(plaintext.toString()) as { salt: string; fields: Record<string, string> };
      opened.push({ subject: entry.subject, salt: parsed.salt, fields: parsed.fields });
    }
    return opened;
  }
}
