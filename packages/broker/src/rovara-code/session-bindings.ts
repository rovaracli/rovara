// Rovara Code (Plan 6 Task 20): the outside places a session follows (its Slack thread and its Linear issue), read from the session's own `BINDING#<kind>` items. Every item is checked
// to belong to the org asked about and to parse as the kind its key names, so a tampered item, another org's, or one that does not read is left out, never trusted.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { SessionBindingSchema, SessionIdSchema, sessionBindingKey, type OrgId, type SessionBinding } from "@agentx/contracts";

/** The kinds a session can be bound to, in the order they are reported (a ticket of any tracker last). */
const BINDING_KINDS = ["slack_thread", "linear_issue", "tracker_item"] as const;

export interface SessionBindingReader {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

/**
 * The session's bindings in this org: its Slack thread, then its Linear issue, whichever it has. A session id that is not one, or no session, has none. A read that fails is thrown
 * (never read as "no binding"), so a caller that must not lose a binding (the merged milestone) stops instead of going on without it.
 */
export async function sessionBindingsOf(table: SessionBindingReader, orgId: OrgId, sessionId: string | undefined): Promise<SessionBinding[]> {
  const id = SessionIdSchema.safeParse(sessionId);
  if (!id.success) return [];
  const found: SessionBinding[] = [];
  for (const kind of BINDING_KINDS) {
    const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: sessionBindingKey(orgId, id.data, kind), ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const item = response.Item;
    if (item === undefined || item["orgId"] !== orgId) continue;
    const parsed = SessionBindingSchema.safeParse(item["binding"]);
    if (parsed.success && parsed.data.kind === kind) found.push(parsed.data);
  }
  return found;
}
