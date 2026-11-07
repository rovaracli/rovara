// Slice 5 "Outside tools" (owner decision 6): a project's ticket updates settings and each tracker's write access as last seen. The settings are one item per project; an item that is missing or
// does not parse reads as the defaults (comments on, status changes OFF, private sessions never written to a public tracker). A save is conditional on the revision the maintainer read, so two
// saves at once give a clear conflict, never a silent overwrite; the same request id again answers the stored settings and writes nothing.
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_TICKET_UPDATES, TICKET_TRACKERS, TicketUpdatesSettingsSchema, agentXError, orgScoped, ticketUpdatesSettingsKey, ticketWriteAccessKey,
  type OrgId, type TicketTracker, type TicketUpdatesSettings, type TicketWriteAccessView,
} from "@agentx/contracts";

export interface TicketUpdatesTable {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

const isConditional = (error: unknown): boolean => error instanceof Error && error.name === "ConditionalCheckFailedException";

/** The project's settings and the revision they were read at (0: never saved, the defaults). */
export async function readTicketUpdates(table: TicketUpdatesTable, orgId: OrgId, project: string): Promise<{ settings: TicketUpdatesSettings; revision: number; requestId?: string }> {
  const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: ticketUpdatesSettingsKey(orgId, project), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (item === undefined || item["orgId"] !== orgId || item["project"] !== project) return { settings: { ...DEFAULT_TICKET_UPDATES, statuses: { ...DEFAULT_TICKET_UPDATES.statuses } }, revision: 0 };
  // Settings saved before review I3 may carry `privateSessions`: it is dropped (it never overrides the owner rule), and the rest is read as saved.
  const stored = item["settings"] !== null && typeof item["settings"] === "object" ? { ...(item["settings"] as Record<string, unknown>) } : item["settings"];
  if (stored !== null && typeof stored === "object") delete (stored as Record<string, unknown>)["privateSessions"];
  const parsed = TicketUpdatesSettingsSchema.safeParse(stored);
  const revision = typeof item["revision"] === "number" ? item["revision"] : 0;
  // A stored item that no longer parses is read as the safe defaults (status changes off), never as "on".
  return { settings: parsed.success ? parsed.data : { ...DEFAULT_TICKET_UPDATES, statuses: { ...DEFAULT_TICKET_UPDATES.statuses } }, revision, ...(typeof item["requestId"] === "string" ? { requestId: item["requestId"] } : {}) };
}

/** Saves the project's settings, conditional on the revision read. The same request id again (already saved) answers what is stored. */
export async function saveTicketUpdates(table: TicketUpdatesTable, input: { orgId: OrgId; project: string; settings: TicketUpdatesSettings; requestId: string; by: string }): Promise<TicketUpdatesSettings> {
  const current = await readTicketUpdates(table, input.orgId, input.project);
  if (current.requestId === input.requestId) {
    if (JSON.stringify(current.settings) !== JSON.stringify(input.settings)) throw agentXError("CONFIG_INVALID", "requestId: this request id was used for other settings");
    return current.settings;
  }
  const key = ticketUpdatesSettingsKey(input.orgId, input.project);
  try {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName,
      Item: { ...key, entityType: "TICKET_UPDATES", orgId: input.orgId, project: input.project, settings: input.settings, revision: current.revision + 1, requestId: input.requestId, by: input.by, at: new Date(table.now()).toISOString() },
      ConditionExpression: current.revision === 0 ? "attribute_not_exists(pk)" : "#revision = :revision",
      ...(current.revision === 0 ? {} : { ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": current.revision } }),
    }));
  } catch (error) {
    if (isConditional(error)) throw agentXError("CHANGE_STALE", "Someone else changed these settings just now. Reload and try again.");
    throw error;
  }
  return input.settings;
}

/** Notes that a write to a tracker was skipped because the company's connection may not write (or the tracker refused it). Best effort: a failure to note is not the task's. */
export async function noteWriteAccessMissing(table: TicketUpdatesTable, orgId: OrgId, tracker: TicketTracker): Promise<void> {
  await table.documentClient.send(new PutCommand({
    TableName: table.tableName,
    Item: { ...ticketWriteAccessKey(orgId, tracker), entityType: "TICKET_WRITE_ACCESS", orgId, tracker, state: "needs_write_access", at: new Date(table.now()).toISOString() },
  }));
}

/** A write to the tracker worked: whatever was noted is cleared (a cheap conditional write that changes nothing when nothing was noted). */
export async function noteWriteAccessOk(table: TicketUpdatesTable, orgId: OrgId, tracker: TicketTracker): Promise<void> {
  try {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName,
      Item: { ...ticketWriteAccessKey(orgId, tracker), entityType: "TICKET_WRITE_ACCESS", orgId, tracker, state: "ok", at: new Date(table.now()).toISOString() },
      ConditionExpression: "attribute_exists(pk) AND #state <> :ok",
      ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":ok": "ok" },
    }));
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
}

/** Each tracker's write access as last seen (one query of the org's small partition). A tracker never written to reads `ok`. */
export async function readWriteAccess(table: TicketUpdatesTable, orgId: OrgId): Promise<TicketWriteAccessView[]> {
  const page = (await table.documentClient.send(new QueryCommand({
    TableName: table.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": orgScoped(orgId, "TICKET_WRITE_ACCESS") }, ConsistentRead: true, Limit: 10,
  }))) as { Items?: Array<Record<string, unknown>> };
  const found = new Map<string, Record<string, unknown>>();
  for (const item of page.Items ?? []) if (item["orgId"] === orgId && typeof item["tracker"] === "string") found.set(item["tracker"], item);
  return TICKET_TRACKERS.map((tracker) => {
    const item = found.get(tracker);
    return item?.["state"] === "needs_write_access" && typeof item["at"] === "string" ? { tracker, state: "needs_write_access" as const, at: item["at"] } : { tracker, state: "ok" as const };
  });
}
