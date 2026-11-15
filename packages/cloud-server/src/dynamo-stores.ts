// Cloud's stores in one DynamoDB table, so several servers share them (PrepLabsAI/Rovara-cloud#11): sign-ins, Cloud's sessions
// with their comments, and who is viewing a session. Each implements the same interface as its local store, and the shared
// tests (tests/unit/cloud-stores.test.ts) hold both to the same behaviour.
//
//   pk                      sk                              what
//   SIGNIN#<cookie id>      SIGNIN                          a sign-in: the person's Code tokens (expires)
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
import type { CodeSession, SessionStore } from "./sessions.js";
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

/** A sign-in lasts this long after it was last saved (made, or its tokens refreshed). */
export const SIGN_IN_LIFETIME_S = 30 * 24 * 3600;
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

export class DynamoSessionStore implements SessionStore {
  constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string, private readonly now: Clock = Date.now) {}

  async get(id: string): Promise<CodeSession | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `SIGNIN#${id}`, sk: "SIGNIN" }, ConsistentRead: true }));
    return live(Item, this.now())?.session as CodeSession | undefined;
  }

  async put(id: string, session: CodeSession): Promise<void> {
    const stored: CodeSession = { ...session };
    delete stored.changed;
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { pk: `SIGNIN#${id}`, sk: "SIGNIN", session: stored, expiresAt: seconds(this.now()) + SIGN_IN_LIFETIME_S },
    }));
  }

  async delete(id: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: `SIGNIN#${id}`, sk: "SIGNIN" } }));
  }

  async putPending(state: string, pending: PendingSignIn): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { pk: `PENDING#${state}`, sk: "PENDING", pending, expiresAt: seconds(this.now()) + PENDING_LIFETIME_S },
    }));
  }

  /** One delete that answers what it removed: a sign-in under way is used once, whichever server takes it. */
  async takePending(state: string): Promise<PendingSignIn | undefined> {
    const { Attributes } = await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: `PENDING#${state}`, sk: "PENDING" }, ReturnValues: "ALL_OLD" }));
    return live(Attributes, this.now())?.pending as PendingSignIn | undefined;
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
