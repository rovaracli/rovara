// Cloud's stores in one DynamoDB table, so several servers share them (PrepLabsAI/Rovara-cloud#11): sign-ins, Cloud's sessions
// with their comments, and who is viewing a session. Each implements the same interface as its local store, and the shared
// tests (tests/unit/cloud-stores.test.ts) hold both to the same behaviour.
//
//   pk                      sk                              what
//   SIGNIN#<cookie hash>    SIGNIN                          a sign-in: the person's Code tokens, sealed (expires; session-table.ts)
//   PENDING#<state>         PENDING                         a sign-in under way (expires after ten minutes)
//   SESSION#<ses_…>         META                            a Cloud session without its comments; `version` guards writes
//   SESSION#<ses_…>         COMMENT#<createdAt>#<msg_…>     one comment, so a session's comments can outgrow an item
//   REQUEST#<request id>    REQUEST                         the session a start request made
//   PRESENCE#<ses_…>        VIEWER#<developer id>           a person's last heartbeat on a session (expires)
//
// The `startedBy` index (STARTED#<developer id>, `<createdAt>#<ses_…>`) holds only META items: a person's sessions, newest first.
import { ConditionalCheckFailedException, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { PendingSignIn } from "./code-client.js";
import { PRESENCE_TTL_MS, currentViewers, type PresenceBoard, type Viewer } from "./presence.js";
import { SealedRecordRefused, type TokenSealer } from "./session-crypto.js";
import { DynamoSessionTable } from "./session-table.js";
import { SessionKeeper, type PendingSignIns } from "./sessions.js";
import { StoreConflict, type SessionComment, type WorkSession, type WorkSessionStore } from "./work-sessions.js";

/** The table's shape, which infra/lib (the table) and the tests (DynamoDB Local) create from. */
export const CLOUD_TABLE = {
  partitionKey: "pk",
  sortKey: "sk",
  /** Epoch seconds; DynamoDB removes the item some time after. Reads check it too. */
  ttlAttribute: "expiresAt",
  startedByIndex: "startedBy",
  startedByKey: "gsi1pk",
  startedBySort: "gsi1sk",
} as const;

/** A sign-in under way: the handler refuses it after ten minutes too (SIGN_IN_TTL_MS). */
export const PENDING_LIFETIME_S = 10 * 60;
/** One transaction holds at most 100 writes: the session, its start request, and the comments that changed. */
const TRANSACTION_MAX = 100;

export function cloudDocumentClient(client: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false } });
}

type Clock = () => number;
const seconds = (ms: number) => Math.floor(ms / 1000);
const live = (item: Record<string, unknown> | undefined, nowMs: number) =>
  item !== undefined && (typeof item.expiresAt !== "number" || item.expiresAt > seconds(nowMs)) ? item : undefined;

/**
 * Sign-ins under way, in the table: a state is taken with one delete, so it is used once whichever server takes it.
 * (The PKCE verifier only lives ten minutes and is useless without the code Code sends back to the browser.)
 */
export class DynamoPendingSignIns implements PendingSignIns {
  constructor(private readonly db: Pick<DynamoDBDocumentClient, "send">, private readonly table: string, private readonly sealer: TokenSealer, private readonly now: Clock = Date.now) {}

  async putPending(state: string, pending: PendingSignIn): Promise<void> {
    // The PKCE verifier and where to go back are sealed like the sign-ins, bound to this state's row.
    const sealed = await this.sealer.seal(JSON.stringify(pending), `PENDING#${state}`);
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { pk: `PENDING#${state}`, sk: "PENDING", sealed, expiresAt: seconds(this.now()) + PENDING_LIFETIME_S },
    }));
  }

  async takePending(state: string): Promise<PendingSignIn | undefined> {
    const { Attributes } = await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: `PENDING#${state}`, sk: "PENDING" }, ReturnValues: "ALL_OLD" }));
    const sealed = live(Attributes, this.now())?.sealed;
    if (typeof sealed !== "string") return undefined;
    try {
      const pending = JSON.parse(await this.sealer.open(sealed, `PENDING#${state}`)) as Partial<PendingSignIn> | null;
      return typeof pending?.verifier === "string" && typeof pending.returnTo === "string" && typeof pending.at === "number" ? pending as PendingSignIn : undefined;
    } catch (error) {
      if (error instanceof SealedRecordRefused || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
}

/**
 * Sign-ins in the table (migration plan v3.2, 7.2 change 4): SessionKeeper's rules (a hash of the cookie, sealed tokens,
 * idle and absolute limits, the refresh hold) over the `SIGNIN#<hash>` items, and sign-ins under way as `PENDING#` items.
 */
export class DynamoSessionStore extends SessionKeeper {
  constructor(db: DynamoDBDocumentClient, table: string, sealer: TokenSealer, now: Clock = Date.now) {
    super({ table: new DynamoSessionTable(db, table), sealer, now, pending: new DynamoPendingSignIns(db, table, sealer, now) });
  }
}

/** A META item: the session without its comments, its version, and its place in the person's list. */
function metaItem(session: WorkSession, version: number): Record<string, unknown> {
  const stored: WorkSession = { ...session };
  delete stored.messages;
  delete stored.storeVersion;
  return {
    pk: `SESSION#${session.sessionId}`, sk: "META", session: stored, version,
    gsi1pk: `STARTED#${session.startedBy.developerId}`, gsi1sk: `${session.createdAt}#${session.sessionId}`,
  };
}

const commentKey = (sessionId: string, comment: SessionComment) => ({ pk: `SESSION#${sessionId}`, sk: `COMMENT#${comment.createdAt}#${comment.messageId}` });

export class DynamoWorkSessionStore implements WorkSessionStore {
  /** The comments as this server read them: `put` writes only the ones a route replaced or added. */
  private readonly unchanged = new WeakSet<SessionComment>();

  constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string) {}

  async get(sessionId: string): Promise<WorkSession | undefined> {
    const items: Array<Record<string, unknown>> = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": `SESSION#${sessionId}` },
        ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }));
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    const meta = items.find((item) => item.sk === "META");
    if (meta === undefined) return undefined;
    const comments = items.filter((item) => typeof item.sk === "string" && item.sk.startsWith("COMMENT#")).map((item) => item.comment as SessionComment);
    for (const comment of comments) this.unchanged.add(comment);
    return { ...(meta.session as WorkSession), ...(comments.length === 0 ? {} : { messages: comments }), storeVersion: meta.version as number };
  }

  async byRequest(requestId: string): Promise<WorkSession | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `REQUEST#${requestId}`, sk: "REQUEST" }, ConsistentRead: true }));
    return typeof Item?.sessionId === "string" ? this.get(Item.sessionId) : undefined;
  }

  async put(session: WorkSession, requestId?: string): Promise<void> {
    const expected = session.storeVersion;
    const meta: NonNullable<TransactWriteCommandInput["TransactItems"]>[number] = {
      Put: {
        TableName: this.table,
        Item: metaItem(session, (expected ?? -1) + 1),
        ...(expected === undefined
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : { ConditionExpression: "version = :expected", ExpressionAttributeValues: { ":expected": expected } }),
      },
    };
    const changed = (session.messages ?? []).filter((comment) => !this.unchanged.has(comment));
    const writes: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
      meta,
      ...(requestId === undefined ? [] : [{ Put: { TableName: this.table, Item: { pk: `REQUEST#${requestId}`, sk: "REQUEST", sessionId: session.sessionId } } }]),
      ...changed.map((comment) => ({ Put: { TableName: this.table, Item: { ...commentKey(session.sessionId, comment), comment } } })),
    ];
    // A request changes a comment or two; only a copy of a whole session (moving to this store) writes more than one transaction holds.
    const first = writes.slice(0, TRANSACTION_MAX), rest = writes.slice(TRANSACTION_MAX);
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: first }));
    } catch (error) {
      const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
      if (error instanceof ConditionalCheckFailedException || reasons?.[0]?.Code === "ConditionalCheckFailed") throw new StoreConflict(session.sessionId);
      throw error;
    }
    for (let at = 0; at < rest.length; at += TRANSACTION_MAX) await this.db.send(new TransactWriteCommand({ TransactItems: rest.slice(at, at + TRANSACTION_MAX) }));
    for (const comment of session.messages ?? []) this.unchanged.add(comment);
  }

  async startedBy(developerId: string): Promise<WorkSession[]> {
    const sessions: WorkSession[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(new QueryCommand({
        TableName: this.table, IndexName: CLOUD_TABLE.startedByIndex, KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `STARTED#${developerId}` }, ScanIndexForward: false, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }));
      for (const item of page.Items ?? []) {
        const stored = { ...(item.session as WorkSession), storeVersion: item.version as number };
        delete stored.messageRequests;
        sessions.push(stored);
      }
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    return sessions;
  }
}

export class DynamoPresenceBoard implements PresenceBoard {
  constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string) {}

  async heartbeat(sessionId: string, person: Viewer, nowMs: number): Promise<Viewer[]> {
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { pk: `PRESENCE#${sessionId}`, sk: `VIEWER#${person.developerId}`, developerId: person.developerId, name: person.name, at: nowMs, expiresAt: seconds(nowMs + PRESENCE_TTL_MS) + 60 },
    }));
    return this.viewing(sessionId, nowMs);
  }

  async viewing(sessionId: string, nowMs: number): Promise<Viewer[]> {
    const { Items } = await this.db.send(new QueryCommand({
      TableName: this.table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": `PRESENCE#${sessionId}` }, ConsistentRead: true,
    }));
    return currentViewers((Items ?? []).map((item) => ({ developerId: item.developerId as string, name: item.name as string, at: item.at as number })), nowMs);
  }
}
