// Sealing a stored login (migration plan v3.2, 7.2 change 4): envelope encryption. Each write asks a key service for a
// fresh data key, seals the record with AES-256-GCM under it, and keeps only the wrapped data key beside the result.
// Deployed, the key service is KMS with a key only Cloud's server role may use; tests and this computer use a local key.
// Both the data key and the sealed record are bound to the row (KMS encryption context and GCM additional data), so a
// record copied onto another person's row does not open.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";

/** Turns a record's text into sealed text and back, bound to its row. `open` throws for anything it did not seal. */
export interface TokenSealer {
  seal(plaintext: string, row: string): Promise<string>;
  open(sealed: string, row: string): Promise<string>;
}

/** Where data keys come from (KMS deployed). Both calls are bound to the row by `context`. */
export interface KeyService {
  generateDataKey(context: Record<string, string>): Promise<{ plaintext: Uint8Array; wrapped: Uint8Array }>;
  unwrapDataKey(wrapped: Uint8Array, context: Record<string, string>): Promise<Uint8Array>;
}

/** Thrown for a record that can't be opened: another key, another row, or damaged. Fixed words, no detail. */
export class SealedRecordRefused extends Error {
  constructor() {
    super("the stored login could not be opened");
  }
}

const PURPOSE = "rovara-cloud-session";
const FORMAT = "v1";
const context = (row: string) => ({ purpose: PURPOSE, session: row });
const aad = (row: string) => Buffer.from(`${PURPOSE}:${FORMAT}:${row}`);

export class EnvelopeSealer implements TokenSealer {
  constructor(private readonly keys: KeyService) {}

  async seal(plaintext: string, row: string): Promise<string> {
    const { plaintext: dataKey, wrapped } = await this.keys.generateDataKey(context(row));
    const iv = randomBytes(12);
    try {
      const cipher = createCipheriv("aes-256-gcm", dataKey, iv).setAAD(aad(row));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [FORMAT, Buffer.from(wrapped).toString("base64url"), iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
    } finally {
      dataKey.fill(0);
    }
  }

  async open(sealed: string, row: string): Promise<string> {
    const parts = sealed.split(".");
    if (parts.length !== 5 || parts[0] !== FORMAT) throw new SealedRecordRefused();
    const [, wrapped, iv, tag, body] = parts.map((part) => Buffer.from(part, "base64url")) as [Buffer, Buffer, Buffer, Buffer, Buffer];
    if (iv.length !== 12 || tag.length !== 16) throw new SealedRecordRefused();
    // A refusal (another key, another row) throws SealedRecordRefused; a KMS outage throws as it is, and keeps the record.
    const dataKey = await this.keys.unwrapDataKey(wrapped, context(row));
    try {
      const decipher = createDecipheriv("aes-256-gcm", dataKey, iv).setAAD(aad(row)).setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      throw new SealedRecordRefused();
    } finally {
      dataKey.fill(0);
    }
  }
}

/** Data keys from KMS, under Cloud's own key. Decrypt names the key too, so a record wrapped by any other key is refused. */
export class KmsKeyService implements KeyService {
  constructor(private readonly kms: Pick<KMSClient, "send">, private readonly keyId: string) {}

  async generateDataKey(encryptionContext: Record<string, string>): Promise<{ plaintext: Uint8Array; wrapped: Uint8Array }> {
    const answer = await this.kms.send(new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: "AES_256", EncryptionContext: encryptionContext }));
    if (answer.Plaintext?.length !== 32 || answer.CiphertextBlob === undefined) throw new Error("KMS did not return a data key");
    return { plaintext: answer.Plaintext, wrapped: answer.CiphertextBlob };
  }

  async unwrapDataKey(wrapped: Uint8Array, encryptionContext: Record<string, string>): Promise<Uint8Array> {
    let answer;
    try {
      answer = await this.kms.send(new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: wrapped, EncryptionContext: encryptionContext }));
    } catch (error) {
      // Only KMS's own refusals mean the record can't be opened; throttling or a network failure is passed on.
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "InvalidCiphertextException" || name === "IncorrectKeyException") throw new SealedRecordRefused();
      throw error;
    }
    if (answer.Plaintext?.length !== 32) throw new SealedRecordRefused();
    return answer.Plaintext;
  }
}

/** Data keys wrapped by a 32-byte key held in memory: for tests and this computer, never a deployed Cloud. */
export function localKeyService(key: Uint8Array): KeyService {
  if (key.length !== 32) throw new Error("a local session key is 32 bytes");
  const master = Buffer.from(key);
  const bind = (encryptionContext: Record<string, string>) => Buffer.from(JSON.stringify(Object.entries(encryptionContext).sort(([a], [b]) => a.localeCompare(b))));
  return {
    async generateDataKey(encryptionContext) {
      const plaintext = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", master, iv).setAAD(bind(encryptionContext));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { plaintext, wrapped: Buffer.concat([iv, cipher.getAuthTag(), body]) };
    },
    async unwrapDataKey(wrapped, encryptionContext) {
      const bytes = Buffer.from(wrapped);
      try {
        const decipher = createDecipheriv("aes-256-gcm", master, bytes.subarray(0, 12)).setAAD(bind(encryptionContext)).setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      } catch {
        throw new SealedRecordRefused();
      }
    },
  };
}

/** No sealing: the file store on this computer only (LocalSessionStore refuses to run anywhere deployed). */
export const PLAIN_LOCAL_SEALER: TokenSealer = {
  async seal(plaintext) { return `plain.${Buffer.from(plaintext, "utf8").toString("base64url")}`; },
  async open(sealed) {
    if (!sealed.startsWith("plain.")) throw new SealedRecordRefused();
    return Buffer.from(sealed.slice("plain.".length), "base64url").toString("utf8");
  },
};
