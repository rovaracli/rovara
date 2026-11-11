// UX2 slice 2 item 5 (OWNER DECISION 4): every event that needs a person reaches them, whether the task was started in Slack or on the web, and followers hear when it is done.
//
//   queue    When a session's summary commits a change into a state that asks someone to act (Needs you, Paused: needs more budget, Ready to merge, Failed) or is over (Merged, Closed),
//            `queueAttention` writes one pending row per person to tell: the owner, the people the summary names as needed (an approver, whoever can raise a paused budget), and the
//            session's followers for a failure or the end. A later change of the same kind for the same person and session replaces the row, so nothing piles up.
//   deliver  The broker's five-minute session sweep calls `deliverAttention`. Each person gets at most one message per channel every `NOTIFY_BATCH_MINUTES`: everything pending is batched into
//            it. Before anything is sent, each row is checked again: the session still exists, it still stands in the state the row was written for, and the person may still READ it
//            (the live session access check). Rows that fail any check are dropped silently.
//
// Channels: Slack direct message (a TASK_ATTENTION_DM row the Slack notifier posts) and/or email, as the person chose on their account page (default Slack when linked, else email). Email goes
// ONLY through the install's existing sign-in notice sender (the same SES identity and grant as the identity notices; `email` absent = no sender, and the email choice reads as unavailable).
// Security: a message holds the task's title, its status sentence (fixed words) and a link to the task's page on the configured https origin. Never task content beyond that, never a
// secret, never an address other than the recipient's own. Logs carry fixed codes and counts only.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { INDEX_EXPIRY_ATTRIBUTE, NOTIFY_BATCH_MINUTES, NOTIFY_CHANNELS, NOTIFY_ITEMS_MAX, NOTIFY_SETTINGS_PATH, agentSessionKey, defaultNotifyChannel, effectiveNotify, hideEmailAddresses, sessionTaskStatus, taskStatusText, type AgentSessionRecord, type NotifyChannel, type OrgId, type SessionSummary } from "@rovara-code/contracts";
import { plainHttpsOrigin, sessionPageUrl } from "../decisions/open-path.js";
import { AgentSessionStore } from "../agent-sessions/store.js";
import type { SessionChange } from "../agent-sessions/notice-sink.js";

type Item = Record<string, unknown>;
interface Table { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

/** What a person is told about. */
export type AttentionKind = "needs_you" | "paused" | "ready" | "failed" | "done";

const PENDING_PK = "NOTIFY_PENDING";
export const ATTENTION_DM_PK = "NOTIFY_DM";
const PENDING_KEEP_SECONDS = 3 * 86_400;
const DM_KEEP_SECONDS = 2 * 86_400;
/** The most people one message names (the owner, the people needed, the followers); more are not told by message (Home still lists it for them). */
const RECIPIENTS_MAX = 50;
/** The most people one sweep messages (chosen among those due now, oldest waiting first). */
const PEOPLE_PER_SWEEP_MAX = 40;
const TITLE_MAX = 100;
export const ATTENTION_SEND_TIMEOUT_MS = 2500;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,20}$/u;

export const prefsKey = (orgId: string, developerId: string) => ({ pk: `NOTIFY_PREFS#${orgId}`, sk: `DEV#${developerId}` });
const sentKey = (orgId: string, developerId: string) => ({ pk: `NOTIFY_SENT#${orgId}`, sk: `DEV#${developerId}` });
const pendingKey = (orgId: string, developerId: string, sessionId: string, kind: AttentionKind) => ({ pk: PENDING_PK, sk: `${orgId}#${developerId}#${sessionId}#${kind}` });

/** The kind of message a status calls for, or undefined for a status nobody is told about. */
export function attentionKindOf(summary: Pick<SessionSummary, "status" | "lastRunFailed"> & { display?: unknown }): AttentionKind | undefined {
  switch (sessionTaskStatus(summary).state) {
    case "needs_you": return "needs_you";
    case "paused_budget": return "paused";
    case "ready_to_merge": return "ready";
    case "failed": return "failed";
    case "merged": case "closed": return "done";
    default: return undefined;
  }
}

// ---- queue

async function followersOf(deps: Table, session: AgentSessionRecord): Promise<string[]> {
  const key = agentSessionKey(session.orgId, session.sessionId, "FOLLOWER#");
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": key.pk, ":prefix": "FOLLOWER#" }, Limit: RECIPIENTS_MAX,
  })) as { Items?: Item[] };
  return (page.Items ?? []).flatMap((item) => (typeof item["sk"] === "string" && /^FOLLOWER#[a-f0-9]{64}$/u.test(item["sk"]) ? [item["sk"].slice("FOLLOWER#".length)] : []));
}

/** Who is told about a change of this kind: the owner and the people the summary names as needed; followers for a failure and for the end (a closed task tells only its followers). */
export async function attentionRecipients(deps: Table, session: AgentSessionRecord, summary: SessionSummary, kind: AttentionKind): Promise<string[]> {
  const owner = session.owner.developerId;
  const named = summary.needsPeople.filter((id) => /^[a-f0-9]{64}$/u.test(id));
  const followers = kind === "failed" || kind === "done" ? await followersOf(deps, session) : [];
  const ownerToo = kind !== "done" || sessionTaskStatus(summary).state === "merged";
  const people = [...(ownerToo ? [owner] : []), ...(kind === "needs_you" || kind === "paused" ? named : []), ...followers];
  return [...new Set(people)].slice(0, RECIPIENTS_MAX);
}

/**
 * After a refresh committed (`summary.ts`): when the session moved into a state someone is told about, one pending row per person. Only task sessions. Never throws: a notification is never a
 * reason for a refresh to fail (a failure is logged with its name).
 */
export async function queueAttention(deps: Table & { log?: ((entry: Record<string, unknown>) => void) | undefined }, change: SessionChange, nowMs: number): Promise<number> {
  try {
    if (change.session.subject.kind !== "task") return 0;
    const kind = attentionKindOf(change.summary);
    if (kind === undefined) return 0;
    // Review I3: a summary written before the status model has no `display`; its first refresh after the deploy counts as unchanged, so nobody is told again about work already waiting.
    if ((change.previous as { display?: unknown }).display === undefined) return 0;
    // Review I5: an ended session is only ever told as done or failed (Home and Live list no ended session as needing anyone).
    if (change.session.endedAt !== undefined && kind !== "done" && kind !== "failed") return 0;
    const before = sessionTaskStatus(change.previous), after = sessionTaskStatus(change.summary);
    if (before.state === after.state && before.reason === after.reason) return 0;
    const people = await attentionRecipients(deps, change.session, change.summary, kind);
    for (const developerId of people) {
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName,
        Item: {
          ...pendingKey(change.orgId, developerId, change.sessionId, kind), entityType: "NOTIFY_PENDING", orgId: change.orgId, developerId, sessionId: change.sessionId, kind, at: change.at,
          [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + PENDING_KEEP_SECONDS,
        },
      }));
    }
    return people.length;
  } catch (error) {
    (deps.log ?? ((entry) => console.log(JSON.stringify({ component: "broker", ...entry }))))({ event: "attention.queue_failed", sessionId: change.sessionId, error: error instanceof Error ? error.name : "unknown" });
    return 0;
  }
}

// ---- preferences

export interface StoredPrefs { channel?: NotifyChannel; emailUnsubscribed?: true }

export async function readPrefs(deps: Table, orgId: OrgId, developerId: string): Promise<StoredPrefs> {
  const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: prefsKey(orgId, developerId), ConsistentRead: true })) as { Item?: Item }).Item;
  if (item === undefined || item["orgId"] !== orgId) return {};
  const channel = (NOTIFY_CHANNELS as readonly string[]).includes(String(item["channel"])) ? item["channel"] as NotifyChannel : undefined;
  return { ...(channel === undefined ? {} : { channel }), ...(item["emailUnsubscribed"] === true ? { emailUnsubscribed: true as const } : {}) };
}

export async function writePrefs(deps: Table & { now: () => number }, orgId: OrgId, developerId: string, prefs: StoredPrefs): Promise<void> {
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: { ...prefsKey(orgId, developerId), entityType: "NOTIFY_PREFS", orgId, developerId, ...prefs, updatedAt: new Date(deps.now()).toISOString() },
  }));
}

// ---- deliver

/** A person as delivery needs them: their address and their linked Slack user, both their own (read from their sign-in record). */
export interface AttentionPerson { email?: string | undefined; slackUserId?: string | undefined }

export interface AttentionDeliveryDependencies extends Table {
  now: () => number;
  /** The web app's origin: links are built only on it, and only when it is a plain https origin. */
  origin: string | undefined;
  /** The person's own address and Slack user, or undefined when they can't be read. */
  person(developerId: string): Promise<AttentionPerson | undefined>;
  /** Whether the person may READ the session now (the live session access check), and whether they own it (an owner reads the title as written; anyone else without an address in it). */
  access(orgId: OrgId, developerId: string, session: AgentSessionRecord): Promise<{ owner: boolean } | undefined>;
  /** The install's sign-in notice sender (`DEVELOPER_NOTICE_EMAIL_FROM`): absent where none is configured, and then no email is sent. */
  email?: { ses: Pick<SESv2Client, "send">; from: string } | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

interface Line { title: string; status: string; link: string }

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
};
const slackEscape = (text: string): string => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** The email's subject and plain text: the tasks (title, status sentence, link), then how to change the setting and how to stop these emails. Nothing else. */
export function attentionEmail(lines: readonly Line[], more: number, origin: string): { subject: string; text: string } {
  const count = lines.length + more;
  const subject = `Rovara: ${String(count)} ${count === 1 ? "task needs" : "tasks need"} your attention`;
  const body = [
    count === 1 ? "A task needs your attention in Rovara:" : "These tasks need your attention in Rovara:",
    "",
    ...lines.flatMap((line) => [`- ${line.title}: ${line.status}`, `  ${line.link}`]),
    ...(more > 0 ? [`- and ${String(more)} more on your Home page: ${origin}/app`] : []),
    "",
    `Change how you're notified: ${origin}${NOTIFY_SETTINGS_PATH}`,
    `Stop these emails: ${origin}/app/account?notify=unsubscribe#notifications`,
  ];
  return { subject, text: body.join("\n") };
}

/** The Slack direct message: the same lines, escaped for Slack. */
export function attentionSlackText(lines: readonly Line[], more: number, origin: string): string {
  return [
    lines.length + more === 1 ? "A task needs your attention:" : "These tasks need your attention:",
    ...lines.map((line) => `• <${line.link}|${slackEscape(line.title)}>: ${slackEscape(line.status)}`),
    ...(more > 0 ? [`• and ${String(more)} more on your <${origin}/app|Home page>`] : []),
    `<${origin}${NOTIFY_SETTINGS_PATH}|Change how you're notified>`,
  ].join("\n");
}

/** The channels a message goes by. */
type Channel = "email" | "slack";
/** Review I1: how often one channel is tried for one person before it gives up on what is pending, and the wait after the first failure (doubled each time: 5, 10, 20, 40 minutes). */
export const ATTENTION_CHANNEL_TRIES_MAX = 5;
export const ATTENTION_RETRY_BASE_MS = 5 * 60_000;
/** Review I2: the queue is read in pages, at most this many rows a sweep. */
const PENDING_PAGE = 100;
export const ATTENTION_READ_MAX = 2000;

interface PendingRow { key: { pk: string; sk: string }; orgId: OrgId; developerId: string; sessionId: string; kind: AttentionKind; at: string; done: Partial<Record<Channel, true>> }

function pendingRowOf(item: Item, nowSeconds: number): PendingRow | undefined {
  const { orgId, developerId, sessionId, kind, at, sk } = item;
  if (typeof orgId !== "string" || typeof developerId !== "string" || typeof sessionId !== "string" || typeof at !== "string" || typeof sk !== "string") return undefined;
  if (!["needs_you", "paused", "ready", "failed", "done"].includes(String(kind)) || sk !== `${orgId}#${developerId}#${sessionId}#${String(kind)}`) return undefined;
  // A row past its expiry is not delivered (the table deletes expired items late).
  const expires = item[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires <= nowSeconds) return undefined;
  // Review N2: a channel claimed for a send counts as sent (at most once): the claim is written before the send, so a lost mark after an accepted send never sends it again.
  const sentBy = (c: Channel) => item[`${c}Sent`] === true || typeof item[`${c}Claimed`] === "number";
  const done: Partial<Record<Channel, true>> = { ...(sentBy("email") ? { email: true as const } : {}), ...(sentBy("slack") ? { slack: true as const } : {}) };
  return { key: { pk: PENDING_PK, sk }, orgId: orgId, developerId, sessionId, kind: kind as AttentionKind, at, done };
}

/** One person's channel state: when it last sent anything, and per channel how many tries failed in a row and when it may try again. */
interface SentMarker { lastAt: number; failures: Partial<Record<Channel, number>>; retryAt: Partial<Record<Channel, number>>; /** Review N1: every channel owed to this person waits for a retry until then; they take no place before it. */ waitUntil?: number | undefined }
function markerOf(item: Item | undefined): SentMarker {
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const failures: Partial<Record<Channel, number>> = {}, retryAt: Partial<Record<Channel, number>> = {};
  for (const channel of ["email", "slack"] as const) {
    const f = number(item?.[`${channel}Failures`]), r = number(item?.[`${channel}RetryAt`]);
    if (f !== undefined) failures[channel] = f;
    if (r !== undefined) retryAt[channel] = r;
  }
  const waitUntil = number(item?.["waitUntil"]);
  return { lastAt: number(item?.["lastAt"]) ?? 0, failures, retryAt, ...(waitUntil === undefined ? {} : { waitUntil }) };
}

/** A marker's per-channel failure counts and retry times, as the row's attributes. */
function channelFieldsOf(marker: SentMarker): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const c of ["email", "slack"] as const) {
    const failures = marker.failures[c], retryAt = marker.retryAt[c];
    if (failures !== undefined) fields[`${c}Failures`] = failures;
    if (retryAt !== undefined) fields[`${c}RetryAt`] = retryAt;
  }
  return fields;
}

/** The time budget the session sweep gives delivery; past it, no new person is started (the next sweep goes on). */
export interface AttentionBudget { deadlineMs?: number | undefined }

/**
 * The sweep's delivery. The queue is read in pages (at most `ATTENTION_READ_MAX` rows; rows past their expiry are left out). People still inside their batching window are set aside BEFORE the
 * `PEOPLE_PER_SWEEP_MAX` people of this sweep are chosen, and those are taken oldest-waiting first, so nobody's rows are starved by others'. For each person, one message per chosen channel lists
 * what is still current and still theirs to read. Each channel is sent on its own (review I1): a failing email never holds back the Slack message; what one channel sent is marked on the rows,
 * so it is never sent again; a failing channel is tried again after a growing wait and gives up after `ATTENTION_CHANNEL_TRIES_MAX` tries. Rows go once every chosen channel has them. Never past
 * `deadlineMs`. Answers counts only.
 */
export async function deliverAttention(deps: AttentionDeliveryDependencies, budget: AttentionBudget = {}): Promise<{ people: number; emails: number; slack: number; dropped: number; failed: number; gaveUp: number }> {
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
  const outcome = { people: 0, emails: 0, slack: 0, dropped: 0, failed: 0, gaveUp: 0 };
  const origin = plainHttpsOrigin(deps.origin);
  const nowMs = deps.now();
  const late = () => budget.deadlineMs !== undefined && deps.now() >= budget.deadlineMs;
  const byPerson = new Map<string, PendingRow[]>();
  let start: Record<string, unknown> | undefined, read = 0;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": PENDING_PK }, ConsistentRead: true, Limit: PENDING_PAGE, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      read += 1;
      const row = pendingRowOf(item, Math.floor(nowMs / 1000));
      if (row === undefined) continue;
      const key = `${row.orgId}#${row.developerId}`;
      byPerson.set(key, [...(byPerson.get(key) ?? []), row]);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined && read < ATTENTION_READ_MAX && !late());
  if (start !== undefined) log({ event: "attention.queue_truncated", read });
  // Who is due now (outside their window), oldest-waiting first: only they take this sweep's places.
  const due: Array<{ rows: PendingRow[]; marker: SentMarker }> = [];
  for (const rows of byPerson.values()) {
    if (late()) break;
    const { orgId, developerId } = rows[0]!;
    const marker = markerOf((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: sentKey(orgId, developerId), ConsistentRead: true })) as { Item?: Item }).Item);
    if (nowMs - marker.lastAt < NOTIFY_BATCH_MINUTES * 60_000) continue;
    // Review N1: someone whose every owed channel is waiting for a retry is not due either, so they never take a place from someone who can be told now.
    if ((marker.waitUntil ?? 0) > nowMs) continue;
    due.push({ rows: [...rows].sort((a, b) => a.at.localeCompare(b.at)), marker });
  }
  due.sort((a, b) => a.rows[0]!.at.localeCompare(b.rows[0]!.at));
  const store = new AgentSessionStore({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now });
  // A person takes one of the sweep's places only when there is something to send them; rows that turn out stale (a gone session, a moved-on state) cost a read and no place. The time budget bounds the rest.
  let taken = 0;
  for (const { rows, marker } of due) {
    if (late() || taken >= PEOPLE_PER_SWEEP_MAX) break;
    const { orgId, developerId } = rows[0]!;
    const current: Array<{ row: PendingRow; line: Line }> = [];
    const stale: PendingRow[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.sessionId)) { current.push({ row, line: current.find((entry) => entry.row.sessionId === row.sessionId)!.line });continue; }
      const session = await store.get(orgId, row.sessionId);
      const link = session === undefined ? undefined : sessionPageUrl(deps.origin, session.sessionId);
      const access = session === undefined || link === undefined ? undefined : await deps.access(orgId, developerId, session).catch(() => undefined);
      const kind = session === undefined ? undefined : attentionKindOf(session.summary);
      // Still current (a later change of state supersedes the row), never "needs you" for an ended session, and still theirs to read: anything else is dropped without a word.
      if (session === undefined || link === undefined || access === undefined || kind !== row.kind || (session.endedAt !== undefined && kind !== "done" && kind !== "failed")) { stale.push(row); continue; }
      seen.add(row.sessionId);
      current.push({ row, line: { title: oneLine(access.owner ? session.title : hideEmailAddresses(session.title), TITLE_MAX) || "A task", status: oneLine(taskStatusText(sessionTaskStatus(session.summary)), 200), link } });
    }
    for (const row of stale) { await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: row.key })); outcome.dropped += 1; }
    if (current.length === 0 || origin === undefined) { for (const { row } of current) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: row.key }));continue; }
    taken += 1;
    const person = await deps.person(developerId);
    const prefs = await readPrefs(deps, orgId, developerId);
    const slackUserId = person?.slackUserId !== undefined && SLACK_USER_ID.test(person.slackUserId) ? person.slackUserId : undefined;
    const address = typeof person?.email === "string" && /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/u.test(person.email) ? person.email : undefined;
    const emailAvailable = deps.email !== undefined && address !== undefined;
    const channel = prefs.channel ?? defaultNotifyChannel(slackUserId !== undefined);
    const goes = effectiveNotify({ channel, slackLinked: slackUserId !== undefined, emailAvailable, emailUnsubscribed: prefs.emailUnsubscribed === true });
    const chosen = (["email", "slack"] as const).filter((c) => goes[c]);
    let sentSomething = false, attempted = false;
    const nextMarker: SentMarker = { lastAt: marker.lastAt, failures: { ...marker.failures }, retryAt: { ...marker.retryAt } };
    const setOn = async (rows: ReadonlyArray<{ row: PendingRow }>, expression: string, values: Record<string, unknown>) => {
      for (const { row } of rows) {
        await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: row.key, UpdateExpression: expression, ConditionExpression: "attribute_exists(pk) AND #at = :at", ExpressionAttributeNames: { "#at": "at" }, ExpressionAttributeValues: { ":at": row.at, ...values } }))
          .catch((error: unknown) => { if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error; });
      }
    };
    for (const c of chosen) {
      const owed = current.filter(({ row }) => row.done[c] !== true);
      if (owed.length === 0) continue;
      if ((nextMarker.retryAt[c] ?? 0) > nowMs) continue;
      attempted = true;
      // Review N2: claim before the send. A claim that cannot be written sends nothing (this channel is tried again later).
      try { await setOn(owed, `SET ${c}Claimed = :now`, { ":now": nowMs }); }
      catch (error) { log({ event: "attention.claim_failed", channel: c, error: error instanceof Error ? error.name : "unknown" });continue; }
      const lines = [...new Map(owed.map(({ row, line }) => [row.sessionId, line])).values()];
      const shown = lines.slice(0, NOTIFY_ITEMS_MAX), more = lines.length - shown.length;
      let ok = false;
      try {
        if (c === "email" && deps.email !== undefined && address !== undefined) {
          const mail = attentionEmail(shown, more, origin);
          await deps.email.ses.send(new SendEmailCommand({
            FromEmailAddress: deps.email.from, Destination: { ToAddresses: [address] },
            Content: { Simple: {
              Subject: { Data: mail.subject, Charset: "UTF-8" }, Body: { Text: { Data: mail.text, Charset: "UTF-8" } },
              // Review M5: mail clients offer their own unsubscribe; it opens the account page's stop link (signed in, asks once).
              Headers: [{ Name: "List-Unsubscribe", Value: `<${origin}/app/account?notify=unsubscribe#notifications>` }],
            } },
          }), { abortSignal: AbortSignal.timeout(ATTENTION_SEND_TIMEOUT_MS) });
          outcome.emails += 1;
        } else if (c === "slack" && slackUserId !== undefined) {
          const at = new Date(nowMs).toISOString();
          await deps.documentClient.send(new PutCommand({
            TableName: deps.tableName,
            Item: { pk: ATTENTION_DM_PK, sk: `${orgId}#${developerId}#${at}`, entityType: "TASK_ATTENTION_DM", status: "PENDING", orgId, slackUserId, text: attentionSlackText(shown, more, origin), at,
              [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + DM_KEEP_SECONDS },
            ConditionExpression: "attribute_not_exists(pk)",
          }));
          outcome.slack += 1;
        }
        ok = true;
      } catch (error) {
        log({ event: "attention.send_failed", channel: c, error: error instanceof Error ? error.name : "unknown" });
      }
      const failures = ok ? 0 : (nextMarker.failures[c] ?? 0) + 1;
      const gaveUp = !ok && failures >= ATTENTION_CHANNEL_TRIES_MAX;
      if (ok || gaveUp) {
        // What this channel sent (or gave up on) is marked on each row. The claim already keeps it from being sent again, so a mark that fails is only logged.
        await setOn(owed, `SET ${c}Sent = :yes`, { ":yes": true }).catch((error: unknown) => log({ event: "attention.mark_failed", channel: c, error: error instanceof Error ? error.name : "unknown" }));
        for (const { row } of owed) row.done[c] = true;
      } else {
        // Not sent: the claim is given back, so the retry sends it. If even that fails, it is never sent twice: at most once, logged.
        await setOn(owed, `REMOVE ${c}Claimed`, {}).catch((error: unknown) => log({ event: "attention.unclaim_failed", channel: c, error: error instanceof Error ? error.name : "unknown" }));
      }
      if (ok) { sentSomething = true;delete nextMarker.failures[c];delete nextMarker.retryAt[c]; }
      else if (gaveUp) { outcome.gaveUp += 1;delete nextMarker.failures[c];delete nextMarker.retryAt[c];log({ event: "attention.channel_gave_up", channel: c }); }
      else { outcome.failed += 1;nextMarker.failures[c] = failures;nextMarker.retryAt[c] = nowMs + ATTENTION_RETRY_BASE_MS * 2 ** (failures - 1); }
    }
    if (sentSomething) { outcome.people += 1;nextMarker.lastAt = nowMs; }
    // Review N1: when every channel still owed waits for a retry, the person is not due again before the first of them.
    const waiting = chosen.filter((c) => current.some(({ row }) => row.done[c] !== true)).map((c) => nextMarker.retryAt[c]);
    if (!sentSomething && waiting.length > 0 && waiting.every((at) => at !== undefined && at > nowMs)) nextMarker.waitUntil = Math.min(...(waiting as number[]));
    if (!attempted) taken -= 1;
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: {
      ...sentKey(orgId, developerId), entityType: "NOTIFY_SENT", orgId, developerId, lastAt: nextMarker.lastAt,
      ...channelFieldsOf(nextMarker), ...(nextMarker.waitUntil === undefined ? {} : { waitUntil: nextMarker.waitUntil }),
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + 86_400,
    } }));
    // A row goes once every chosen channel has it (with no channel that can reach the person, Home still lists it and the row goes).
    for (const { row } of current) if (chosen.every((c) => row.done[c] === true)) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: row.key })).catch(() => undefined);
  }
  if (outcome.people > 0 || outcome.dropped > 0 || outcome.failed > 0) log({ event: "attention.delivered", ...outcome });
  return outcome;
}
