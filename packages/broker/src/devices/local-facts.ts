// What a local session's Mac last said (Plan 5 Task 18): one `LOCAL` item in the session's partition, written only by `local-sessions.ts` and read here for the session's
// summary. Kept apart from the writer so the summary (which the writer calls) can read it without the two importing each other. Everything read is checked: the item must
// be this session's, in this org, and name the session's own device, or it is read as "nothing to say" and the summary stays as it was.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ENDED_SESSION_STATUSES, SessionStatusSchema, agentSessionKey, type AgentSessionRecord } from "@rovara-code/contracts";
import type { Item, TableInput } from "../agents/table-writes.js";
import type { LocalFacts, LocalSessionSource } from "../agent-sessions/summary.js";
import { readDevice, type DeviceDependencies } from "./store.js";

/** What a stop says when the session's Mac can't be given a command. */
export const MAC_NOT_AVAILABLE_MESSAGE = "This session's Mac isn't available right now.";

/** The statuses that end a session. */
export const isEndedStatus = (status: unknown): boolean => typeof status === "string" && (ENDED_SESSION_STATUSES as readonly string[]).includes(status);

/** The session's `LOCAL` item, or undefined. */
export async function readLocalState(table: Pick<TableInput, "documentClient" | "tableName">, session: Pick<AgentSessionRecord, "orgId" | "sessionId">): Promise<Item | undefined> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: agentSessionKey(session.orgId, session.sessionId, "LOCAL"), ConsistentRead: true })) as { Item?: Item };
  const item = response.Item;
  return item !== undefined && item["orgId"] === session.orgId && item["sessionId"] === session.sessionId ? item : undefined;
}

/** The summary's source for a session on a Mac: the facts in the session's `LOCAL` item, for the device the session names. */
export function localSessionSource(table: Pick<TableInput, "documentClient" | "tableName">): LocalSessionSource {
  return {
    async read(session: AgentSessionRecord): Promise<LocalFacts | undefined> {
      if (session.subject.kind !== "local") return undefined;
      const item = await readLocalState(table, session);
      if (item === undefined || item["deviceId"] !== session.subject.deviceId) return undefined;
      const status = SessionStatusSchema.safeParse(item["status"]);
      const updatedAt = item["updatedAt"];
      if (!status.success || typeof updatedAt !== "string") return undefined;
      const endedAt = item["endedAt"];
      return {
        orgId: session.orgId, status: status.data, costUsd: 0, updatedAt,
        ...(typeof item["step"] === "string" ? { step: item["step"] } : {}),
        ...(typeof item["peek"] === "string" ? { peek: item["peek"] } : {}),
        ...(item["lastRunFailed"] === true ? { lastRunFailed: true as const } : {}),
        ...(typeof endedAt === "string" ? { endedAt } : {}),
      };
    },
  };
}

/**
 * The device of a local session, when it can be given a command: the device is this org's, belongs to the session's owner and is not removed. `undefined` otherwise (the session's Mac
 * is gone or isn't the owner's), which a steer reads as "not delivered" and a stop as "not available".
 */
export async function commandableDevice(deps: DeviceDependencies, session: AgentSessionRecord): Promise<{ deviceId: string; label: string } | undefined> {
  if (session.subject.kind !== "local") return undefined;
  const record = await readDevice(deps, session.orgId, session.subject.deviceId);
  if (record === undefined || record.revokedAt !== undefined || record.developerId !== session.owner.developerId) return undefined;
  return { deviceId: record.deviceId, label: record.label };
}
