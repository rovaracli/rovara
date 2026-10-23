// The agent session store (Plan 5 Task 2): reads a session, finds the one a task belongs to, and writes events. Every key is built from
// the org the caller checked; a session or task of another org reads as absent.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentSessionRecordSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  SESSION_EVENT_TEXT_MAX,
  SESSION_RETENTION_DAYS,
  SessionEventSchema,
  agentSessionKey,
  agentXError,
  redactText,
  sessionEventSk,
  type AgentSessionRecord,
  type OrgId,
  type SessionEvent,
  type SessionId,
} from "@agentx/contracts";
import { NOT_EXISTS, errorName, strip, type Item, type TableInput, type TransactItem } from "../agents/table-writes.js";

/** The part of a task record a session lookup reads. */
export interface SessionTaskRef {
  taskId: string;
  orgId?: OrgId | undefined;
  sessionId?: string | undefined;
  chain?: { chainRunId: string; stepId: string } | undefined;
}

/** What names a session when an item is written for it. */
export interface SessionRef {
  orgId: OrgId;
  sessionId: SessionId;
}

const SECONDS_PER_DAY = 86_400;

/**
 * Text kept in an event: redacted first (so the cut can't leave half a token), control characters other than line breaks replaced, and cut
 * to the event limit by characters.
 */
export function eventText(text: string): string {
  const clean = redactText(text).replace(/(?![\n\t\r])\p{Cc}/gu, " ");
  return [...clean].slice(0, SESSION_EVENT_TEXT_MAX).join("");
}

/**
 * The write of one event: `EVENT#<at>#<eventId>`, written only if absent. There is no counter, so it never conflicts with another writer, and an
 * event with the same id (a retry) is the same item. It expires `SESSION_RETENTION_DAYS` after `at`.
 */
export function sessionEventItem(table: Pick<TableInput, "tableName">, session: SessionRef, event: SessionEvent): TransactItem {
  const clean = SessionEventSchema.parse({ ...event, text: eventText(event.text) });
  return {
    Put: {
      TableName: table.tableName,
      Item: {
        ...agentSessionKey(session.orgId, session.sessionId, sessionEventSk(clean.at, clean.eventId)), entityType: "AGENT_SESSION_EVENT",
        orgId: session.orgId, sessionId: session.sessionId, ...clean,
        [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(clean.at) / 1000) + SESSION_RETENTION_DAYS * SECONDS_PER_DAY,
      },
      ConditionExpression: NOT_EXISTS,
    },
  };
}

export class AgentSessionStore {
  constructor(private readonly table: TableInput) {}

  /** A session of this org, or undefined. A record that doesn't parse is refused, never read as it is. */
  async get(orgId: OrgId, sessionId: SessionId): Promise<AgentSessionRecord | undefined> {
    const response = await this.table.documentClient.send(new GetCommand({ TableName: this.table.tableName, Key: agentSessionKey(orgId, sessionId, "META"), ConsistentRead: true })) as { Item?: Item };
    const item = response.Item;
    if (item === undefined || item["orgId"] !== orgId) return undefined;
    const record = AgentSessionRecordSchema.safeParse(strip(item));
    if (!record.success) throw agentXError("RUNTIME_UNAVAILABLE", "This session can't be read right now.");
    return record.data;
  }

  /**
   * The session a task belongs to: the one its record names, or, for a chain step's task, the chain run's own session. Undefined for a task
   * of another org, a task with no session, and a session whose subject isn't this task (or this task's chain run).
   */
  async getForTask(orgId: OrgId, task: SessionTaskRef): Promise<AgentSessionRecord | undefined> {
    if (task.orgId !== orgId) return undefined;
    if (task.sessionId !== undefined) {
      const session = await this.get(orgId, task.sessionId);
      return session?.subject.kind === "task" && session.subject.taskId === task.taskId ? session : undefined;
    }
    if (task.chain !== undefined) {
      const session = await this.get(orgId, task.chain.chainRunId);
      return session?.subject.kind === "chain" && session.subject.chainRunId === task.chain.chainRunId ? session : undefined;
    }
    return undefined;
  }

  /** `sessionEventItem` for this table. */
  sessionEventItem(session: SessionRef, event: SessionEvent): TransactItem {
    return sessionEventItem(this.table, session, event);
  }

  /** Writes one event on its own. An event that is already there is "exists", not an error. */
  async appendEvent(orgId: OrgId, sessionId: SessionId, event: SessionEvent): Promise<"appended" | "exists"> {
    try {
      await this.table.documentClient.send(new TransactWriteCommand({ TransactItems: [this.sessionEventItem({ orgId, sessionId }, event)] }));
      return "appended";
    } catch (error) {
      if (errorName(error) === "TransactionCanceledException" || errorName(error) === "ConditionalCheckFailedException") {
        const reasons = (error as { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
        if (reasons === undefined || reasons.every((reason) => reason?.Code === "ConditionalCheckFailed")) return "exists";
      }
      throw error;
    }
  }
}
