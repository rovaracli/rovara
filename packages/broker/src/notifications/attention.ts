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
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import {
  INDEX_EXPIRY_ATTRIBUTE, NOTIFY_BATCH_MINUTES, NOTIFY_CHANNELS, NOTIFY_ITEMS_MAX, NOTIFY_SETTINGS_PATH, agentSessionKey, defaultNotifyChannel, effectiveNotify, hideEmailAddresses,
  sessionTaskStatus, taskStatusText, type AgentSessionRecord, type NotifyChannel, type OrgId, type SessionSummary,
} from "@agentx/contracts";
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
/** The most pending rows one sweep reads, and the most people it messages. */
const PENDING_READ_MAX = 300;
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

interface PendingRow { key: { pk: string; sk: string }; orgId: OrgId; developerId: string; sessionId: string; kind: AttentionKind; at: string }

function pendingRowOf(item: Item): PendingRow | undefined {
  const { orgId, developerId, sessionId, kind, at, sk } = item;
  if (typeof orgId !== "string" || typeof developerId !== "string" || typeof sessionId !== "string" || typeof at !== "string" || typeof sk !== "string") return undefined;
  if (!["needs_you", "paused", "ready", "failed", "done"].includes(String(kind)) || sk !== `${orgId}#${developerId}#${sessionId}#${String(kind)}`) return undefined;
  return { key: { pk: PENDING_PK, sk }, orgId: orgId, developerId, sessionId, kind: kind as AttentionKind, at };
}

/**
 * The sweep's delivery: for each person with pending rows whose last message is older than the batching window, one message per chosen channel listing what is still current and still theirs to
 * read, then the rows are removed. A person whose message could not be sent keeps their rows for the next sweep (each row expires after three days). Answers counts only.
 */
export async function deliverAttention(deps: AttentionDeliveryDependencies): Promise<{ people: number; emails: number; slack: number; dropped: number }> {
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
  const outcome = { people: 0, emails: 0, slack: 0, dropped: 0 };
  const origin = plainHttpsOrigin(deps.origin);
  const page = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": PENDING_PK }, ConsistentRead: true, Limit: PENDING_READ_MAX })) as { Items?: Item[] };
  const byPerson = new Map<string, PendingRow[]>();
  for (const item of page.Items ?? []) {
    const row = pendingRowOf(item);
    if (row === undefined) continue;
    const key = `${row.orgId}#${row.developerId}`;
    byPerson.set(key, [...(byPerson.get(key) ?? []), row]);
  }
  const nowMs = deps.now();
  const store = new AgentSessionStore({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now });
  for (const rows of [...byPerson.values()].slice(0, PEOPLE_PER_SWEEP_MAX)) {
    const { orgId, developerId } = rows[0]!;
    const sent = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: sentKey(orgId, developerId), ConsistentRead: true })) as { Item?: Item }).Item;
    const last = typeof sent?.["lastAt"] === "number" ? sent["lastAt"] : 0;
    if (nowMs - last < NOTIFY_BATCH_MINUTES * 60_000) continue;
    const lines: Line[] = [];
    const seen = new Set<string>();
    for (const row of [...rows].sort((a, b) => a.at.localeCompare(b.at))) {
      if (seen.has(row.sessionId)) continue;
      const session = await store.get(orgId, row.sessionId);
      const link = session === undefined ? undefined : sessionPageUrl(deps.origin, session.sessionId);
      const access = session === undefined || link === undefined ? undefined : await deps.access(orgId, developerId, session).catch(() => undefined);
      // Still current (a later change of state supersedes the row) and still theirs to read: anything else is dropped without a word.
      if (session === undefined || link === undefined || access === undefined || attentionKindOf(session.summary) !== row.kind) { outcome.dropped += 1; continue; }
      seen.add(row.sessionId);
      lines.push({ title: oneLine(access.owner ? session.title : hideEmailAddresses(session.title), TITLE_MAX) || "A task", status: oneLine(taskStatusText(sessionTaskStatus(session.summary)), 200), link });
    }
    const remove = async () => { for (const row of rows) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: row.key })); };
    if (lines.length === 0 || origin === undefined) { await remove(); continue; }
    const person = await deps.person(developerId);
    const prefs = await readPrefs(deps, orgId, developerId);
    const slackUserId = person?.slackUserId !== undefined && SLACK_USER_ID.test(person.slackUserId) ? person.slackUserId : undefined;
    const address = typeof person?.email === "string" && /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/u.test(person.email) ? person.email : undefined;
    const emailAvailable = deps.email !== undefined && address !== undefined;
    const channel = prefs.channel ?? defaultNotifyChannel(slackUserId !== undefined);
    const goes = effectiveNotify({ channel, slackLinked: slackUserId !== undefined, emailAvailable, emailUnsubscribed: prefs.emailUnsubscribed === true });
    const shown = lines.slice(0, NOTIFY_ITEMS_MAX), more = lines.length - shown.length;
    try {
      if (goes.email && deps.email !== undefined && address !== undefined) {
        const mail = attentionEmail(shown, more, origin);
        await deps.email.ses.send(new SendEmailCommand({
          FromEmailAddress: deps.email.from, Destination: { ToAddresses: [address] },
          Content: { Simple: { Subject: { Data: mail.subject, Charset: "UTF-8" }, Body: { Text: { Data: mail.text, Charset: "UTF-8" } } } },
        }), { abortSignal: AbortSignal.timeout(ATTENTION_SEND_TIMEOUT_MS) });
        outcome.emails += 1;
      }
      if (goes.slack && slackUserId !== undefined) {
        const at = new Date(nowMs).toISOString();
        await deps.documentClient.send(new PutCommand({
          TableName: deps.tableName,
          Item: { pk: ATTENTION_DM_PK, sk: `${orgId}#${developerId}#${at}`, entityType: "TASK_ATTENTION_DM", status: "PENDING", orgId, slackUserId, text: attentionSlackText(shown, more, origin), at,
            [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + DM_KEEP_SECONDS },
          ConditionExpression: "attribute_not_exists(pk)",
        }));
        outcome.slack += 1;
      }
    } catch (error) {
      log({ event: "attention.send_failed", error: error instanceof Error ? error.name : "unknown" });
      continue;
    }
    if (goes.email || goes.slack) {
      outcome.people += 1;
      await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...sentKey(orgId, developerId), entityType: "NOTIFY_SENT", orgId, developerId, lastAt: nowMs, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + 86_400 } }));
    }
    await remove();
  }
  if (outcome.people > 0 || outcome.dropped > 0) log({ event: "attention.delivered", ...outcome });
  return outcome;
}
