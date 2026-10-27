// The records that bind one outside surface (a Slack thread, a Linear issue) to one session. Task 2 writes `bindingItems` for a task shared to a
// Slack thread at its start; Task 20 adds the later binding (`bindSessionSurface`, the notifier's items), the lookup by surface and the checks.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  SessionBindingSchema,
  SessionIdSchema,
  SlackThreadSchema,
  agentSessionKey,
  agentXError,
  sessionBindingKey,
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
 * The two items of one binding: the session's own `BINDING#<kind>` item (in its own partition, `sessionBindingKey`, so a role that may write bindings has no reach into the session's partition) and the reverse `sessionSurfaceKey` item that says which session a
 * surface follows. Each is written only if absent, so a surface follows one session and a session has one binding of each kind.
 */
export function bindingItems(table: Pick<TableInput, "tableName">, orgId: OrgId, sessionId: SessionId, binding: SessionBinding, at: string): TransactItem[] {
  const clean = SessionBindingSchema.parse(binding);
  const writer = table as TableInput;
  return [
    putNew(writer, sessionBindingKey(orgId, sessionId, clean.kind), "AGENT_SESSION_BINDING", { orgId, sessionId, binding: clean, at }),
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
    getItem(table, sessionBindingKey(orgId, sessionId, binding.kind)),
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
 *
 * It takes no actor and does not check that the binding's Slack team or Linear workspace belongs to `orgId`. The caller must have (a) checked that the actor holds edit on the
 * session, and (b) resolved `orgId` from the team or workspace the binding names. A binding is a routing hint, never authority: whatever arrives through it (a Slack reply, a
 * Linear event) must still be checked against the acting person's own session level before it steers the agent.
 */
export async function bindSessionSurface(
  table: TableInput,
  input: { orgId: OrgId; sessionId: SessionId; binding: SessionBinding; /** Items that commit with the binding or not at all (the timeline line and the audit item of a person's link); none are written for a repeat. */ extraItems?: TransactItem[] },
): Promise<"bound" | "already_bound"> {
  const parsedBinding = SessionBindingSchema.safeParse(input.binding);
  const parsedId = SessionIdSchema.safeParse(input.sessionId);
  if (!parsedBinding.success || !parsedId.success) throw agentXError("CONFIG_INVALID", "This link can't be bound to a session.");
  const binding = parsedBinding.data;
  const sessionId = parsedId.data;
  // Refuse foreign/missing ids before this helper attempts a write; keep its transaction check for races.
  // Production notifier calls bindingItemsForOpenSession directly, using the task's checked org; it does not run this precheck.
  const meta = await getItem(table, agentSessionKey(input.orgId, sessionId, "META"));
  if (meta === undefined || meta["orgId"] !== input.orgId) throw agentXError("NOT_FOUND", "session not found");
  for (let attempt = 1; ; attempt += 1) {
    const at = new Date(table.now()).toISOString();
    try {
      await table.documentClient.send(new TransactWriteCommand({ TransactItems: [...bindingItemsForOpenSession(table, input.orgId, sessionId, binding, at), ...(input.extraItems ?? [])] }));
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
 * binding). A read that fails is thrown, never read as "unbound". The record it returns is a routing hint, not authority: the caller must check the acting person's own session
 * level (Plan 9: a Slack or Linear event before it steers) and must not show the session to someone who cannot view it.
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
  const own = await getItem(table, sessionBindingKey(orgId, id.data, parsed.data.kind));
  return own !== undefined && own["orgId"] === orgId && surfaceOf(orgId, own["binding"]) === surface.sk ? session : undefined;
}

/**
 * Lets go of a session's binding of one kind (Plan 6 Task 20: unlinking a Linear issue): the session's own `BINDING#<kind>` item and the reverse surface item are deleted in one transaction, behind a
 * check that the session is in this org and that the binding is still the one that was read (a binding replaced meanwhile is not undone). The surface item goes only if it names this session. `extraItems`
 * commit with it. "unbound" when it deleted them, "not_bound" when the session follows nothing of that kind (nothing is written). The binding that was read is answered, for the caller's timeline and audit line.
 */
export async function unbindSessionSurface(
  table: TableInput,
  input: { orgId: OrgId; sessionId: SessionId; kind: SessionBinding["kind"]; /** Built from the binding that was read, so the line names what was let go. */ extraItems?: (binding: SessionBinding) => Promise<TransactItem[]> },
): Promise<{ result: "unbound"; binding: SessionBinding } | { result: "not_bound" }> {
  const parsedId = SessionIdSchema.safeParse(input.sessionId);
  if (!parsedId.success) throw agentXError("CONFIG_INVALID", "This link can't be removed from a session.");
  const sessionId = parsedId.data;
  for (let attempt = 1; ; attempt += 1) {
    const own = await getItem(table, sessionBindingKey(input.orgId, sessionId, input.kind));
    if (own === undefined || own["orgId"] !== input.orgId) return { result: "not_bound" };
    const parsed = SessionBindingSchema.safeParse(own["binding"]);
    if (!parsed.success || parsed.data.kind !== input.kind) throw agentXError("RUNTIME_UNAVAILABLE", "This link can't be read right now.");
    const binding = parsed.data;
    const surface = sessionSurfaceKey(input.orgId, binding);
    const items: TransactItem[] = [
      { ConditionCheck: { TableName: table.tableName, Key: agentSessionKey(input.orgId, sessionId, "META"), ConditionExpression: "attribute_exists(pk) AND orgId = :orgId", ExpressionAttributeValues: { ":orgId": input.orgId } } },
      { Delete: { TableName: table.tableName, Key: sessionBindingKey(input.orgId, sessionId, input.kind), ConditionExpression: "attribute_exists(pk) AND orgId = :orgId AND #at = :at", ExpressionAttributeNames: { "#at": "at" }, ExpressionAttributeValues: { ":orgId": input.orgId, ":at": own["at"] } } },
      { Delete: { TableName: table.tableName, Key: surface, ConditionExpression: "attribute_not_exists(pk) OR (orgId = :orgId AND sessionId = :sessionId)", ExpressionAttributeValues: { ":orgId": input.orgId, ":sessionId": sessionId } } },
      ...(await input.extraItems?.(binding) ?? []),
    ];
    try {
      await table.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
      return { result: "unbound", binding };
    } catch (error) {
      if (isTransactionConflict(error)) throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
      if (failedIndexes(error) === undefined) throw error;
      // Something moved between the read and the write. A binding that is gone was let go by another call; one that is another binding now is not undone, because it is not the one the
      // person asked about; anything else is read again.
      const now = await getItem(table, sessionBindingKey(input.orgId, sessionId, input.kind));
      if (now === undefined) return { result: "not_bound" };
      if (now["at"] !== own["at"] || now["orgId"] !== input.orgId) throw agentXError("CONFIG_INVALID", "This session's link changed just now. Check it and try again.");
      if (attempt >= ATTEMPTS) throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
    }
  }
}

/**
 * Replaces a session's binding of one kind with another surface in ONE transaction (Plan 6 Task 20: replacing a Linear issue): the session's own `BINDING#<kind>` item is overwritten behind a check
 * that it is still the one that was read, the old reverse surface item is deleted (only if it names this session), the new one is put only if absent (an issue that follows another session is
 * refused as `bindSessionSurface` refuses it), and `extraItems` (built from the binding that is let go) commit with it. A refusal leaves everything as it was. "not_bound" when the session follows
 * nothing of that kind now (nothing is written; the caller says so).
 */
export async function replaceSessionSurface(
  table: TableInput,
  input: { orgId: OrgId; sessionId: SessionId; binding: SessionBinding; extraItems?: (previous: SessionBinding) => Promise<TransactItem[]> },
): Promise<{ result: "replaced"; previous: SessionBinding } | { result: "not_bound" }> {
  const parsedBinding = SessionBindingSchema.safeParse(input.binding);
  const parsedId = SessionIdSchema.safeParse(input.sessionId);
  if (!parsedBinding.success || !parsedId.success) throw agentXError("CONFIG_INVALID", "This link can't be bound to a session.");
  const binding = parsedBinding.data;
  const sessionId = parsedId.data;
  const ownKey = sessionBindingKey(input.orgId, sessionId, binding.kind);
  const newSurface = sessionSurfaceKey(input.orgId, binding);
  for (let attempt = 1; ; attempt += 1) {
    const own = await getItem(table, ownKey);
    if (own === undefined || own["orgId"] !== input.orgId) return { result: "not_bound" };
    const old = SessionBindingSchema.safeParse(own["binding"]);
    if (!old.success || old.data.kind !== binding.kind) throw agentXError("RUNTIME_UNAVAILABLE", "This link can't be read right now.");
    const taken = await getItem(table, newSurface);
    if (taken !== undefined && taken["orgId"] === input.orgId && taken["sessionId"] !== sessionId) throw agentXError("CONFIG_INVALID", `This ${NOUN[binding.kind]} already follows another session.`);
    const at = new Date(table.now()).toISOString();
    const items: TransactItem[] = [
      { ConditionCheck: { TableName: table.tableName, Key: agentSessionKey(input.orgId, sessionId, "META"), ConditionExpression: "attribute_exists(pk) AND orgId = :orgId AND attribute_not_exists(endedAt)", ExpressionAttributeValues: { ":orgId": input.orgId } } },
      { Put: { TableName: table.tableName, Item: { ...ownKey, entityType: "AGENT_SESSION_BINDING", orgId: input.orgId, sessionId, binding, at }, ConditionExpression: "attribute_exists(pk) AND orgId = :orgId AND #at = :at", ExpressionAttributeNames: { "#at": "at" }, ExpressionAttributeValues: { ":orgId": input.orgId, ":at": own["at"] } } },
      { Delete: { TableName: table.tableName, Key: sessionSurfaceKey(input.orgId, old.data), ConditionExpression: "attribute_not_exists(pk) OR (orgId = :orgId AND sessionId = :sessionId)", ExpressionAttributeValues: { ":orgId": input.orgId, ":sessionId": sessionId } } },
      putNew(table, newSurface, "SESSION_SURFACE", { orgId: input.orgId, sessionId, kind: binding.kind, at }),
      ...(await input.extraItems?.(old.data) ?? []),
    ];
    try {
      await table.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
      return { result: "replaced", previous: old.data };
    } catch (error) {
      if (isTransactionConflict(error)) throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
      if (failedIndexes(error) === undefined) throw error;
      // Something moved between the read and the write: read again. A binding that changed meanwhile is not replaced, because it is not the one the person asked about.
      const now = await getItem(table, ownKey);
      if (now === undefined || now["at"] !== own["at"] || now["orgId"] !== input.orgId) throw agentXError("CONFIG_INVALID", "This session's link changed just now. Check it and try again.");
      const claimed = await getItem(table, newSurface);
      if (claimed !== undefined && claimed["orgId"] === input.orgId && claimed["sessionId"] !== sessionId) throw agentXError("CONFIG_INVALID", `This ${NOUN[binding.kind]} already follows another session.`);
      const meta = await getItem(table, agentSessionKey(input.orgId, sessionId, "META"));
      if (meta !== undefined && meta["endedAt"] !== undefined) throw agentXError("SESSION_ENDED", "This session has ended.");
      if (attempt >= ATTEMPTS) throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
    }
  }
}
