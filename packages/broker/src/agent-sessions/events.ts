// The session event log (Plan 5 Task 6). An event is `EVENT#<at>#<eventId>` with a deterministic id and no counter: a retry is the same item and two
// writers never conflict. The log is ordered by time, then id, and is not gapless; retention means the first readable event may come after `started`.
//
// Cancellation-position contract, for a caller that puts an event in its own transaction: the event is always the LAST item, and a cancellation at that
// position alone (`onlyTheEventCancelled`) means "already recorded": the caller treats it as success and retries the rest without it. An event is never a
// reason for the caller's own work to fail: build it with the helpers here, which answer undefined rather than throw.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SESSION_EVENTS_PAGE_MAX, SESSION_EVENT_TEXT_MAX, SessionEventSchema, agentSessionKey, agentXError, cleanSessionName, hideEmailAddresses, redactText, sessionEventId, type OrgId, type SessionEvent, type SessionEventPage, type SessionId } from "@rovara-code/contracts";
import { failedIndexes, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { followMerges } from "../agents/access.js";
import type { DeveloperSignInStore } from "../developer/store.js";
import { requireSessionLevel, type SessionAccessDependencies, type SessionCaller } from "./access.js";
import { isPlaceholderDisplayName, safeDisplayName } from "../developer/person-name.js";
import { erasedNamesOnPage, scrubErasedNames, shownNameOf } from "../developer/name-resolver.js";
import { ownerNameOverlay } from "./owner-names.js";
import { AgentSessionStore, sessionEventItem, type SessionRef, type SessionTaskRef } from "./store.js";

type Item = Record<string, unknown>;

/** Writes one event: a single conditional put. An event with the same key is already recorded: that is success ("exists"), not an error. */
export async function appendSessionEvent(table: TableInput, orgId: OrgId, sessionId: SessionId, event: SessionEvent): Promise<"appended" | "exists"> {
  return new AgentSessionStore(table).appendEvent(orgId, sessionId, event);
}

/** Whether a failed transaction was cancelled at `position` and nowhere else: for an event put last, "this event already exists". */
export function onlyTheEventCancelled(error: unknown, position: number): boolean {
  const failed = failedIndexes(error);
  return failed !== undefined && failed.size === 1 && failed.has(position);
}

// ---- the Slack thread reply

/** How much of a reply the event keeps. */
const REPLY_PREVIEW_CHARS = 200;

/** The session of a task, as the event needs it: undefined for a task with none, one of another org, a session that isn't this task's, or any read that fails. */
export async function sessionRefOfTask(table: TableInput, task: SessionTaskRef): Promise<SessionRef | undefined> {
  if (task.orgId === undefined || task.sessionId === undefined) return undefined;
  try {
    const session = await new AgentSessionStore(table).getForTask(task.orgId, task);
    return session === undefined ? undefined : { orgId: session.orgId, sessionId: session.sessionId };
  } catch {
    return undefined;
  }
}

/**
 * The `steer` event of a Slack thread reply, ready to be the last item of the note's own transaction. Its id comes from the Slack event and its time is
 * the note's `receivedAt`, so a retry writes the same key. Undefined when it can't be built (a note is never refused over its event).
 */
export function slackReplyEventItem(
  table: Pick<TableInput, "tableName">,
  session: SessionRef,
  reply: { slackEventId: string; receivedAt: string; text: string; actor?: { developerId: string; name: string } | undefined },
): TransactItem | undefined {
  const name = cleanSessionName(reply.actor?.name ?? "") ?? "Someone";
  const base = {
    eventId: sessionEventId("steer", reply.slackEventId), at: reply.receivedAt, type: "steer" as const, source: "slack" as const,
    // Redacted before the cut, so a token the cut would have halved is still seen whole.
    text: `${name} in Slack: ${[...redactText(reply.text)].slice(0, REPLY_PREVIEW_CHARS).join("")}`,
  };
  const candidates: SessionEvent[] = reply.actor === undefined ? [base] : [{ ...base, actor: { kind: "member", developerId: reply.actor.developerId, name } }, base];
  for (const candidate of candidates) {
    try {
      return sessionEventItem(table, session, candidate);
    } catch {
      // Not an event this schema takes (a person's id that isn't a developer id, say): try the one without the person.
    }
  }
  return undefined;
}

/**
 * Who wrote a reply in a task's thread, for the session's timeline. The id is the Slack caller's live seat (0.5.18x: never taken from the task's Slack user id),
 * followed through any member merge. The name is their developer record's display name (read through the sign-in table, not the state table), else the name
 * the task's Task People list holds for their Slack id, else (the owner) the name the task keeps, else what the Slack caller is called. Never throws: the
 * name is for the timeline only.
 */
export async function slackReplyAuthor(
  table: Pick<TableInput, "documentClient" | "tableName">,
  signInStore: Pick<DeveloperSignInStore, "getDeveloper">,
  task: { taskId: string; developerId: string; developerName: string; slackUserId?: string | undefined },
  slackUserId: string,
  caller: { developerId: string; name: string },
): Promise<{ developerId: string; name: string }> {
  // 0.5.18x (review M-1): the id is the caller's LIVE seat, never the task's owner because the task record carries this Slack user id (an unlinked Slack account keeps that on the record).
  const owner = task.slackUserId === slackUserId && caller.developerId === task.developerId;
  let developerId = caller.developerId;
  const known = (value: unknown): value is string => typeof value === "string" && value !== "";
  try {
    developerId = await followMerges(signInStore, developerId);
    const record = await signInStore.getDeveloper(developerId);
    if (known(record?.displayName)) return { developerId, name: record.displayName };
    const people = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" }, ConsistentRead: true }))) as { Item?: Item }).Item?.["people"];
    const listed = Array.isArray(people) ? (people as Array<{ slackUserId?: unknown; name?: unknown } | null>).find((person) => person?.slackUserId === slackUserId) : undefined;
    if (known(listed?.name)) return { developerId, name: listed.name };
  } catch {
    // The name is for the timeline only: what the task or the caller is called will do.
  }
  return { developerId, name: owner && known(task.developerName) ? task.developerName : caller.name };
}

// ---- reading

/** Events are read again from this long before the cursor, so one written late with an earlier time is still seen. */
const REREAD_MS = 5_000;
/** At most this many re-read events go in a page; the rest of the page is new events, so a page always moves forward. */
const REREAD_MAX = 100;
/** Rows looked at (expired ones included) before a page gives up and hands back a cursor. */
const SCAN_MAX = 1_000;
const SK_PREFIX = "EVENT#";
const SK_LAST = `${SK_PREFIX}9999-12-31T23:59:59.999Z#evt_ffffffffffffffffffffffff`;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#(evt_[0-9a-f]{24})$/;
const HOUSEKEEPING = new Set(["pk", "sk", "entityType", "orgId", "sessionId", "indexExpiresAt"]);

export type SessionEventsDependencies = SessionAccessDependencies;

function parseCursor(after: string | undefined): { at: string; sk: string } | undefined {
  if (after === undefined) return undefined;
  const bad = () => agentXError("CONFIG_INVALID", "after: is not a cursor this log gave");
  const match = CURSOR.exec(after);
  if (match === null) throw bad();
  const ms = Date.parse(match[1]!);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== match[1]) throw bad();
  return { at: match[1], sk: `${SK_PREFIX}${after}` };
}

type Queried = { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };

function eventOf(item: Item, orgId: OrgId, sessionId: string, nowSeconds: number): SessionEvent | undefined {
  if (item["orgId"] !== orgId || item["sessionId"] !== sessionId) return undefined;
  const expires = item["indexExpiresAt"];
  if (typeof expires === "number" && expires <= nowSeconds) return undefined; // the table hasn't deleted it yet
  const parsed = SessionEventSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !HOUSEKEEPING.has(key))));
  if (!parsed.success) return undefined;
  // Release 0.4.16: an entry written while a person's name was their email reads without it.
  const event = parsed.data;
  const actor = event.actor?.kind === "member" ? { ...event.actor, name: safeDisplayName(event.actor.name, event.actor.developerId) } : event.actor;
  return { ...event, ...(actor === undefined ? {} : { actor }), text: hideEmailAddresses(event.text) };
}

/**
 * `GET /v1/app/sessions/{id}/events?after=<cursor>` [view]: `{ events, next? }`, oldest first (by time, then id). With a cursor (`<at>#<eventId>`, the last
 * event of the previous page) it re-reads the five seconds before it (at most `REREAD_MAX` events, never the cursor's own) and then goes on; readers
 * de-duplicate by `eventId`. An event whose expiry has passed is not returned. `NOT_FOUND` for a session the caller can't view.
 */
export async function readSessionEvents(deps: SessionEventsDependencies, caller: SessionCaller, sessionId: string, query: { after?: string | undefined }): Promise<SessionEventPage> {
  const cursor = parseCursor(query.after);
  const { session } = await requireSessionLevel(deps, caller, sessionId, "view", "view it");
  const { orgId } = session;
  const pk = agentSessionKey(orgId, session.sessionId, "META").pk;
  const nowSeconds = Math.floor(deps.now() / 1000);
  const query1 = async (input: Record<string, unknown>) => await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, ConsistentRead: true, ...input })) as Queried;

  const events = new Map<string, SessionEvent>();
  if (cursor !== undefined) {
    const low = `${SK_PREFIX}${new Date(Date.parse(cursor.at) - REREAD_MS).toISOString()}#`;
    const behind = await query1({
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high", ExpressionAttributeValues: { ":pk": pk, ":low": low, ":high": cursor.sk },
      ScanIndexForward: false, Limit: REREAD_MAX + 1,
    });
    const reread: SessionEvent[] = [];
    for (const item of behind.Items ?? []) {
      if (item["sk"] === cursor.sk) continue;
      const event = eventOf(item, orgId, session.sessionId, nowSeconds);
      if (event !== undefined && reread.length < REREAD_MAX) reread.push(event);
    }
    for (const event of reread.reverse()) events.set(event.eventId, event);
  }

  const room = SESSION_EVENTS_PAGE_MAX - events.size;
  let start: Record<string, unknown> | undefined = cursor === undefined ? undefined : { pk, sk: cursor.sk };
  let kept = 0;
  let scanned = 0;
  let lastSk: string | undefined;
  scan: for (;;) {
    const page = await query1({
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high", ExpressionAttributeValues: { ":pk": pk, ":low": cursor?.sk ?? SK_PREFIX, ":high": SK_LAST },
      Limit: SESSION_EVENTS_PAGE_MAX, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    });
    for (const item of page.Items ?? []) {
      if (kept >= room || scanned >= SCAN_MAX) break scan;
      scanned += 1;
      if (typeof item["sk"] === "string") lastSk = item["sk"];
      const event = eventOf(item, orgId, session.sessionId, nowSeconds);
      if (event === undefined) continue;
      events.set(event.eventId, event);
      kept += 1;
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) break;
  }

  const next = lastSk !== undefined ? lastSk.slice(SK_PREFIX.length) : query.after;
  return { events: await withChosenActorNames(deps, [...events.values()], session.orgId, [{ ...session.owner, writtenAt: session.createdAt }]), ...(next === undefined ? {} : { next }) };
}

/**
 * QA6-11: an event keeps the name its person had when it was written, which for work begun before they chose a name is the "Member xxxxxxxx" placeholder, while the header already shows the
 * name chosen now. A member actor is shown by the chosen name (read by the actor's id, as the owner's is), and the same placeholder in the event's words reads the same. A person who chose none
 * reads as stored, and so does every event if the read fails.
 *
 * ERASE-NAME-1: an actor who was erased reads "A former member", whatever name the event stored (the real name of a person who never chose one included), and the stored name in the event's
 * words reads the same. If the state cannot be read, the event reads as stored (the same best effort as the chosen name).
 */
async function withChosenActorNames(deps: SessionEventsDependencies, events: SessionEvent[], orgId: string, alsoOnPage: ReadonlyArray<{ developerId: string; name: string; writtenAt?: string }> = []): Promise<SessionEvent[]> {
  const copies = [...events.flatMap((event) => (event.actor?.kind === "member" ? [{ developerId: event.actor.developerId, name: event.actor.name, writtenAt: event.at }] : [])), ...alsoOnPage];
  const { chosen, replaced } = await ownerNameOverlay(deps, copies.map((copy) => copy.developerId), orgId);
  if (chosen.size === 0 && replaced.size === 0) return events;
  // ERASE-NAME-2 (partial): words other people wrote name the erased person by the name stored then ("X took over from Y"). The stored names of the erased people who are on this page (actors, the owner) are
  // blanked out of every event's text, exact and whole-word. A person who is not on the page, or named some other way, is not covered (DEFERRED-CHECKS).
  // ERASED-REJOIN-NAME: a person who was erased and came back is blanked out only in what was written before the new membership began (an event's own time); the new name they chose is kept whole.
  const erasedNames = erasedNamesOnPage(copies, replaced);
  const newNames = [...replaced.rejoinedAt.keys()].flatMap((developerId) => { const name = chosen.get(developerId); return name === undefined ? [] : [name]; });
  return events.map((event) => {
    const actor = event.actor;
    const scrubbed = erasedNames.length === 0 ? event : { ...event, text: [...scrubErasedNames(event.text, erasedNames, newNames)].slice(0, SESSION_EVENT_TEXT_MAX).join("") };
    if (actor?.kind !== "member") return scrubbed;
    const name = (replaced.has(actor.developerId) ? shownNameOf(actor.name, actor.developerId, replaced, event.at) : undefined) ?? (isPlaceholderDisplayName(actor.name) ? chosen.get(actor.developerId) : undefined);
    return name === undefined ? scrubbed : { ...scrubbed, actor: { ...actor, name }, text: [...(actor.name === "" ? scrubbed.text : scrubbed.text.split(actor.name).join(name))].slice(0, SESSION_EVENT_TEXT_MAX).join("") };
  });
}
