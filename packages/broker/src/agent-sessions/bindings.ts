// The records that bind one outside surface (a Slack thread, a Linear issue) to one session. Task 2 writes `bindingItems` for a task shared to a
// Slack thread at its start; Task 20 adds the later binding (`bindSessionSurface`, the notifier's items), the lookup by surface and the checks.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  SessionBindingSchema,
  SessionIdSchema,
  SlackThreadSchema,
  agentSessionKey,
  agentXError,
  sessionSurfaceKey,
  type AgentSessionRecord,
  type OrgId,
  type SessionBinding,
  type SessionId,
} from "@agentx/contracts";
import { failedIndexes, isTransactionConflict, putNew, type Item, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { AgentSessionStore } from "./store.js";

const NOUN = { slack_thread: "thread", linear_issue: "issue" } as const;
const BUSY = "This can't be saved right now. Try again.";
const ATTEMPTS = 3;

/**
 * The two items of one binding: the session's own `BINDING#<kind>` item and the reverse `sessionSurfaceKey` item that says which session a
 * surface follows. Each is written only if absent, so a surface follows one session and a session has one binding of each kind.
 */
export function bindingItems(table: Pick<TableInput, "tableName">, orgId: OrgId, sessionId: SessionId, binding: SessionBinding, at: string): TransactItem[] {
  const clean = SessionBindingSchema.parse(binding);
  const writer = table as TableInput;
  return [
    putNew(writer, agentSessionKey(orgId, sessionId, `BINDING#${clean.kind}`), "AGENT_SESSION_BINDING", { orgId, sessionId, binding: clean, at }),
    putNew(writer, sessionSurfaceKey(orgId, clean), "SESSION_SURFACE", { orgId, sessionId, kind: clean.kind, at }),
  ];
}

/** The binding items of the Slack thread a task is shared to, for a session created in the same transaction. None when the share has no thread yet (or isn't a valid one). */
export function threadBindingItems(
  table: Pick<TableInput, "tableName">,
  orgId: OrgId,
  sessionId: SessionId,
  share: { teamId: string; channelId: string; threadTs?: string | undefined } | undefined,
  at: string,
): TransactItem[] {
  if (share?.threadTs === undefined) return [];
  const thread = SlackThreadSchema.safeParse({ teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs });
  return thread.success ? bindingItems(table, orgId, sessionId, { kind: "slack_thread", ...thread.data }, at) : [];
}

/**
 * The same two items for a session that already exists, behind a check that it is still in this org and still open, so a session that ended (or is gone)
 * refuses the binding in the same transaction. The check comes first; the binding's own items are the last two, so a caller that adds them to a bigger
 * transaction can tell which of its items refused.
 */
export function bindingItemsForOpenSession(table: Pick<TableInput, "tableName">, orgId: OrgId, sessionId: SessionId, binding: SessionBinding, at: string): TransactItem[] {
  return [
    {
      ConditionCheck: {
        TableName: table.tableName,
        Key: agentSessionKey(orgId, sessionId, "META"),
        ConditionExpression: "attribute_exists(pk) AND orgId = :orgId AND attribute_not_exists(endedAt)",
        ExpressionAttributeValues: { ":orgId": orgId },
      },
    },
    ...bindingItems(table, orgId, sessionId, binding, at),
  ];
}

const getItem = async (table: TableInput, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

/** The surface a stored binding names, or undefined when it doesn't parse. Two bindings are the same surface when their surface items are the same item. */
function surfaceOf(orgId: OrgId, stored: unknown): string | undefined {
  const parsed = SessionBindingSchema.safeParse(stored);
  return parsed.success ? sessionSurfaceKey(orgId, parsed.data).sk : undefined;
}

type Diagnosis = "already_bound" | "retry" | Error;

/** What the three items say after a refused binding. Read again, because a cancelled transaction can also mean that another writer got there first with the same answer. */
async function diagnose(table: TableInput, orgId: OrgId, sessionId: SessionId, binding: SessionBinding): Promise<Diagnosis> {
  const surface = sessionSurfaceKey(orgId, binding);
  const [meta, own, reverse] = await Promise.all([
    getItem(table, agentSessionKey(orgId, sessionId, "META")),
    getItem(table, agentSessionKey(orgId, sessionId, `BINDING#${binding.kind}`)),
    getItem(table, surface),
  ]);
  if (meta === undefined || meta["orgId"] !== orgId) return agentXError("NOT_FOUND", "session not found");
  const ownIsThis = own !== undefined && own["orgId"] === orgId && surfaceOf(orgId, own["binding"]) === surface.sk;
  const reverseIsThis = reverse !== undefined && reverse["orgId"] === orgId && reverse["sessionId"] === sessionId;
  if (ownIsThis && reverseIsThis) return "already_bound";
  if (reverse !== undefined && !reverseIsThis) return agentXError("CONFIG_INVALID", `This ${NOUN[binding.kind]} already follows another session.`);
  if (own !== undefined && !ownIsThis) return agentXError("CONFIG_INVALID", `This session already follows another ${NOUN[binding.kind]}.`);
  if (meta["endedAt"] !== undefined) return agentXError("SESSION_ENDED", "This session has ended.");
  return "retry";
}

/**
 * Binds a Slack thread or a Linear issue to a session after the fact. One transaction writes the session's `BINDING#<kind>` and the reverse surface item, each only if
 * absent, behind a check that the session is in this org and still open. "bound" when it wrote them, "already_bound" for a repeat of the same binding (nothing written). A
 * surface that follows another session, or a second binding of one kind on the session, is `CONFIG_INVALID`; a session of another org or a missing one is `NOT_FOUND`
 * (the same answer for both); an ended one is `SESSION_ENDED`. A conflict with another writer is a retryable `RUNTIME_UNAVAILABLE`, never taken for a lost race.
 */
export async function bindSessionSurface(
  table: TableInput,
  input: { orgId: OrgId; sessionId: SessionId; binding: SessionBinding },
): Promise<"bound" | "already_bound"> {
  const parsedBinding = SessionBindingSchema.safeParse(input.binding);
  const parsedId = SessionIdSchema.safeParse(input.sessionId);
  if (!parsedBinding.success || !parsedId.success) throw agentXError("CONFIG_INVALID", "This link can't be bound to a session.");
  const binding = parsedBinding.data;
  const sessionId = parsedId.data;
  for (let attempt = 1; ; attempt += 1) {
    const at = new Date(table.now()).toISOString();
    try {
      await table.documentClient.send(new TransactWriteCommand({ TransactItems: bindingItemsForOpenSession(table, input.orgId, sessionId, binding, at) }));
      return "bound";
    } catch (error) {
      if (isTransactionConflict(error)) throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
      if (failedIndexes(error) === undefined) throw error;
    }
    const outcome = await diagnose(table, input.orgId, sessionId, binding);
    if (outcome === "already_bound") return outcome;
    if (outcome !== "retry") throw outcome;
    if (attempt >= ATTEMPTS) throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
  }
}

/**
 * The session a surface follows in this org, or undefined (nothing bound, a session that is gone, or two items that disagree). The surface item names the session and the
 * session's own binding must name the surface back, so a stale or tampered item reads as unbound. The caller resolves the org first (from its own team or workspace
 * binding). A read that fails is thrown, never read as "unbound".
 */
export async function sessionForSurface(table: TableInput, orgId: OrgId, binding: SessionBinding): Promise<AgentSessionRecord | undefined> {
  const parsed = SessionBindingSchema.safeParse(binding);
  if (!parsed.success) return undefined;
  const surface = sessionSurfaceKey(orgId, parsed.data);
  const reverse = await getItem(table, surface);
  if (reverse === undefined || reverse["orgId"] !== orgId) return undefined;
  const id = SessionIdSchema.safeParse(reverse["sessionId"]);
  if (!id.success) return undefined;
  const session = await new AgentSessionStore(table).get(orgId, id.data);
  if (session === undefined) return undefined;
  const own = await getItem(table, agentSessionKey(orgId, id.data, `BINDING#${parsed.data.kind}`));
  return own !== undefined && own["orgId"] === orgId && surfaceOf(orgId, own["binding"]) === surface.sk ? session : undefined;
}
