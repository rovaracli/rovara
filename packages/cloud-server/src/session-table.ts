// Where stored logins live: one record per login, keyed by a hash of its cookie, with a version every change must name
// (a conditional write) and an expiry time the table deletes it by. Deployed: Cloud's DynamoDB table (TTL on expiresAt).
// On this computer: memory, or a private file.
import { readFileSync, writeFileSync } from "node:fs";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface SessionRecord {
  /** The hash of the cookie (sessionKey), never the cookie. */
  key: string;
  /** Goes up by one on every change; a write names the version it read. */
  version: number;
  /** Epoch milliseconds. */
  createdAt: number;
  lastSeenAt: number;
  /** Epoch seconds: the table deletes the record after this (DynamoDB TTL). */
  expiresAt: number;
  /** Epoch milliseconds: while in the future, one server is refreshing the tokens and the others wait for it. */
  refreshingUntil?: number;
  /** Which server's refresh holds that wait: only it may save the refreshed tokens under it. */
  refreshLease?: string;
  /** The session, sealed (session-crypto.ts). */
  sealed: string;
}

/** `absent`: only if no record has this key. `version`: only if the stored record still has this version. */
export type WriteCondition = { absent: true } | { version: number };

export interface SessionTable {
  get(key: string): Promise<SessionRecord | undefined>;
  /** False when the condition no longer holds (someone else wrote first). */
  put(record: SessionRecord, condition: WriteCondition): Promise<boolean>;
  /** Moves the idle clock only (no version change); false when the record is gone. */
  touch(key: string, lastSeenAt: number, expiresAt: number): Promise<boolean>;
  delete(key: string): Promise<void>;
}

const FILE_FORMAT = 2;

/** Records in memory; with `file`, also in that file (mode 600). A file in an older format (keyed by raw cookies) is dropped at once. */
export class LocalSessionTable implements SessionTable {
  private readonly records = new Map<string, SessionRecord>();

  constructor(private readonly file?: string) {
    if (file === undefined) return;
    let loaded: unknown;
    try {
      loaded = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      loaded = undefined;
    }
    const parsed = loaded as { format?: unknown; records?: unknown } | undefined;
    if (parsed?.format === FILE_FORMAT && typeof parsed.records === "object" && parsed.records !== null) {
      for (const record of Object.values(parsed.records as Record<string, SessionRecord>)) this.records.set(record.key, record);
    } else if (loaded !== undefined) {
      this.save();
    }
  }

  private save(): void {
    if (this.file === undefined) return;
    writeFileSync(this.file, JSON.stringify({ format: FILE_FORMAT, records: Object.fromEntries(this.records) }), { mode: 0o600 });
  }

  /** Every record, for tests. */
  rows(): SessionRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  /** Replaces a record without a condition, for tests. */
  overwrite(record: SessionRecord): void {
    this.records.set(record.key, { ...record });
  }

  async get(key: string): Promise<SessionRecord | undefined> {
    const record = this.records.get(key);
    return record === undefined ? undefined : { ...record };
  }

  async put(record: SessionRecord, condition: WriteCondition): Promise<boolean> {
    const current = this.records.get(record.key);
    if ("absent" in condition ? current !== undefined : current?.version !== condition.version) return false;
    this.records.set(record.key, { ...record });
    this.save();
    return true;
  }

  async touch(key: string, lastSeenAt: number, expiresAt: number): Promise<boolean> {
    const current = this.records.get(key);
    if (current === undefined) return false;
    this.records.set(key, { ...current, lastSeenAt, expiresAt });
    this.save();
    return true;
  }

  async delete(key: string): Promise<void> {
    if (this.records.delete(key)) this.save();
  }
}

const num = (item: Record<string, unknown>, name: string): number | undefined => (typeof item[name] === "number" ? item[name] : undefined);

/**
 * Records as `SIGNIN#<key>` / `SIGNIN` items in Cloud's table (dynamo-stores.ts CLOUD_TABLE: pk, sk, TTL on expiresAt).
 * Reads are consistent; writes name the version they read.
 */
export class DynamoSessionTable implements SessionTable {
  constructor(private readonly db: Pick<DynamoDBDocumentClient, "send">, private readonly tableName: string) {}

  private itemKey(key: string) {
    return { pk: `SIGNIN#${key}`, sk: "SIGNIN" };
  }

  async get(key: string): Promise<SessionRecord | undefined> {
    const { Item: item } = await this.db.send(new GetCommand({ TableName: this.tableName, Key: this.itemKey(key), ConsistentRead: true }));
    if (item === undefined) return undefined;
    const version = num(item, "version");
    const createdAt = num(item, "createdAt");
    const lastSeenAt = num(item, "lastSeenAt");
    const expiresAt = num(item, "expiresAt");
    const sealed: unknown = item.sealed;
    if (item.pk !== this.itemKey(key).pk || version === undefined || createdAt === undefined || lastSeenAt === undefined || expiresAt === undefined || typeof sealed !== "string") return undefined;
    const refreshingUntil = num(item, "refreshingUntil");
    const refreshLease = typeof item.refreshLease === "string" ? item.refreshLease : undefined;
    return { key, version, createdAt, lastSeenAt, expiresAt, sealed, ...(refreshingUntil === undefined ? {} : { refreshingUntil }), ...(refreshLease === undefined ? {} : { refreshLease }) };
  }

  async put(record: SessionRecord, condition: WriteCondition): Promise<boolean> {
    const item: Record<string, unknown> = {
      ...this.itemKey(record.key), version: record.version, createdAt: record.createdAt, lastSeenAt: record.lastSeenAt, expiresAt: record.expiresAt, sealed: record.sealed,
      ...(record.refreshingUntil === undefined ? {} : { refreshingUntil: record.refreshingUntil }),
      ...(record.refreshLease === undefined ? {} : { refreshLease: record.refreshLease }),
    };
    return this.conditional(() => this.db.send(new PutCommand({
      TableName: this.tableName, Item: item,
      ...("absent" in condition
        ? { ConditionExpression: "attribute_not_exists(pk)" }
        : { ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": condition.version } }),
    })));
  }

  async touch(key: string, lastSeenAt: number, expiresAt: number): Promise<boolean> {
    return this.conditional(() => this.db.send(new UpdateCommand({
      TableName: this.tableName, Key: this.itemKey(key),
      UpdateExpression: "SET lastSeenAt = :seen, expiresAt = :expires", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":seen": lastSeenAt, ":expires": expiresAt },
    })));
  }

  async delete(key: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.tableName, Key: this.itemKey(key) }));
  }

  private async conditional(write: () => Promise<unknown>): Promise<boolean> {
    try {
      await write();
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException || (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
}
