// Linking tracker people automatically (lane team-record-links, owner 2026-11-02). When a company has connected Linear or Jira through the app, Rovara reads the tool's user list (the tool's id and
// the email it holds) through that connection: when the connection is saved, and once a day after. A tool user is LINKED to a Rovara person only when
//   - the tool reports the email as verified (a tool that gives no such signal has its emails treated as unverified: see `LINEAR_EMAIL_VERIFIED` and `JIRA_EMAIL_VERIFIED`), and
//   - it equals, normalised and case-insensitive, the verified sign-in email of a person of the SAME org (`linkTrackerByVerifiedEmail`; never across orgs).
// Everyone else is recorded as UNMATCHED, with the name the tool showed and the tool's id and nothing else (the email is never stored), for an admin to map by hand.
// No connection, no read: a company that has not connected a tool is never asked about it. Reads are bounded (pages, people, time) and a run can be repeated: it changes nothing that is already right.
import { z } from "zod";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk, type OrgId } from "@agentx/contracts";
import { isErasedActor } from "./erased.js";
import { clearUnmatchedTrackerUser, developerOfTrackerAuthor, isAutoLinkSuppressed, noteUnmatchedTrackerUser, pruneUnmatchedTrackerUsers, shownName } from "./identity-links.js";
import type { RecordLog, TeamRecordTable } from "./types.js";

/** One person in a tool's user list. `emailVerified` is the tool's own claim about `email`, never a guess. */
export interface TrackerUser { sourceId: string; displayName: string; email?: string | undefined; emailVerified: boolean }
export interface TrackerUserPage { users: TrackerUser[]; /** An opaque cursor for the next page; absent on the last. */ next?: string | undefined }

/** A Linear or Jira connection of the org, with a saved secret, as the sync sees it. */
export interface ConnectedTracker {
  connectionId: string;
  /** The `sourceRef.system` its people write under: `linear`, or `jira:<site host>`. */
  system: string;
  kind: "linear" | "jira";
  readUsers(input: { after?: string | undefined; limit: number }): Promise<TrackerUserPage>;
}

/** The org's connected trackers. A connection that is not Linear or Jira, or has no saved secret, is not offered. */
export interface ConnectedTrackersPort {
  list(orgId: OrgId): Promise<ConnectedTracker[]>;
  get(orgId: OrgId, connectionId: string): Promise<ConnectedTracker | undefined>;
}

export const USERS_PER_PAGE = 100;
export const USERS_PER_RUN_MAX = 2_000;
/** A connection is read again after this long. */
export const SYNC_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Linear's `User` has an `email` and no field that says it was verified (checked against the published GraphQL schema). Linear signs people in by a code sent to the address, a Google or SSO account, but the API
 * does not report it, so by the owner's rule ("an email the tool reports as verified") every Linear email is UNVERIFIED here, and Linear people are matched by an admin. The day Linear reports it, this is the one place.
 */
export const LINEAR_EMAIL_VERIFIED = (): boolean => false;
/**
 * Jira Cloud's user search returns `accountId`, `accountType`, `emailAddress` (often hidden by the person's privacy setting), `displayName` and `active`; none says an address is verified. Treated as UNVERIFIED, and a
 * hidden email is no email at all. Jira people are matched by an admin.
 */
export const JIRA_EMAIL_VERIFIED = (): boolean => false;

const PageBody = z.object({ data: z.object({ users: z.object({
  nodes: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().max(500).nullish(), displayName: z.string().max(500).nullish(), email: z.string().max(500).nullish(), active: z.boolean().nullish(), app: z.boolean().nullish() }).passthrough()).max(250),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().max(500).nullish() }).passthrough(),
}).passthrough() }).passthrough() }).passthrough();
const JiraUsers = z.array(z.object({ accountId: z.string().min(1).max(200), accountType: z.string().max(40).nullish(), active: z.boolean().nullish(), displayName: z.string().max(500).nullish(), emailAddress: z.string().max(500).nullish() }).passthrough()).max(1_000);

const READ_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 2_000_000;

async function cappedText(response: Response): Promise<string | undefined> {
  const text = await response.text();
  return Buffer.byteLength(text, "utf8") > RESPONSE_MAX_BYTES ? undefined : text;
}

/** Linear: the workspace's people, a page at a time, through the connection's API key. Apps (bots) and deactivated people are not listed. */
export function linearUsersReader(input: { fetch: typeof fetch; graphqlUrl: string; apiKey: string }): ConnectedTracker["readUsers"] {
  return async ({ after, limit }) => {
    const response = await input.fetch(input.graphqlUrl, {
      method: "POST", headers: { authorization: input.apiKey, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      body: JSON.stringify({ query: "query($first:Int!,$after:String){ users(first:$first, after:$after){ nodes{ id name displayName email active app } pageInfo{ hasNextPage endCursor } } }", variables: { first: Math.min(limit, 250), ...(after === undefined ? {} : { after }) } }),
    });
    if (!response.ok) throw new Error("linear refused the read");
    const text = await cappedText(response);
    const parsed = text === undefined ? undefined : PageBody.safeParse(JSON.parse(text));
    if (parsed === undefined || !parsed.success) throw new Error("linear answered with something unreadable");
    const { nodes, pageInfo } = parsed.data.data.users;
    const users: TrackerUser[] = nodes.filter((node) => node.app !== true && node.active !== false).map((node) => {
      const email = typeof node.email === "string" && node.email !== "" ? node.email : undefined;
      return { sourceId: node.id, displayName: shownName(node.displayName || node.name || undefined, node.id), ...(email === undefined ? {} : { email }), emailVerified: email !== undefined && LINEAR_EMAIL_VERIFIED() };
    });
    return { users, ...(pageInfo.hasNextPage && typeof pageInfo.endCursor === "string" && pageInfo.endCursor !== "" ? { next: pageInfo.endCursor } : {}) };
  };
}

/** Jira Cloud: the site's people through the connection's account email and API token. Only real people (`atlassian` accounts, not apps or customers) who are active; a hidden email is no email. */
export function jiraUsersReader(input: { fetch: typeof fetch; siteUrl: string; email: string; apiToken: string }): ConnectedTracker["readUsers"] {
  return async ({ after, limit }) => {
    const startAt = after === undefined ? 0 : Number.parseInt(after, 10);
    if (!Number.isInteger(startAt) || startAt < 0 || startAt > 100_000) throw new Error("bad cursor");
    const size = Math.min(limit, 100);
    const response = await input.fetch(`${input.siteUrl}/rest/api/3/users/search?startAt=${String(startAt)}&maxResults=${String(size)}`, {
      method: "GET", headers: { authorization: `Basic ${Buffer.from(`${input.email}:${input.apiToken}`).toString("base64")}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("jira refused the read");
    const text = await cappedText(response);
    const parsed = text === undefined ? undefined : JiraUsers.safeParse(JSON.parse(text));
    if (parsed === undefined || !parsed.success) throw new Error("jira answered with something unreadable");
    const users: TrackerUser[] = parsed.data.filter((user) => user.accountType === "atlassian" && user.active !== false).map((user) => {
      const email = typeof user.emailAddress === "string" && user.emailAddress !== "" ? user.emailAddress : undefined;
      return { sourceId: user.accountId, displayName: shownName(user.displayName || undefined, user.accountId), ...(email === undefined ? {} : { email }), emailVerified: email !== undefined && JIRA_EMAIL_VERIFIED() };
    });
    // Jira pages by position, over everyone it lists (apps included), so a full page means there may be more.
    return { users, ...(parsed.data.length >= size ? { next: String(startAt + parsed.data.length) } : {}) };
  };
}

export interface SyncDependencies {
  table: TeamRecordTable;
  now: () => number;
  /** `runtime.links.linkByVerifiedEmail`: links only when the tool said the email is verified and the person is a member of this org. */
  linkByVerifiedEmail(orgId: OrgId, input: { system: string; sourceId: string; email: string; emailVerified: boolean | undefined; displayName?: string }): Promise<boolean>;
  log?: RecordLog;
}

export interface SyncResult { read: number; linked: number; alreadyLinked: number; unmatched: number; complete: boolean; failed?: true }

const stampKey = (orgId: OrgId, connectionId: string): { pk: string; sk: string } => ({ pk: teamRecordPk(orgId), sk: `TRSYNC#${connectionId}` });
interface Stamp { at?: string; complete?: boolean; resume?: { after: string; startedAt: string } }
async function readStamp(table: TeamRecordTable, orgId: OrgId, connectionId: string): Promise<Stamp> {
  const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: stampKey(orgId, connectionId), ConsistentRead: true }))) as { Item?: { at?: unknown; complete?: unknown; resume?: { after?: unknown; startedAt?: unknown } } }).Item;
  return {
    ...(typeof item?.at === "string" ? { at: item.at } : {}), ...(typeof item?.complete === "boolean" ? { complete: item.complete } : {}),
    ...(typeof item?.resume?.after === "string" && typeof item.resume.startedAt === "string" ? { resume: { after: item.resume.after, startedAt: item.resume.startedAt } } : {}),
  };
}

/** Whether a connection's users are due to be read: never read, or last read more than a day ago, or a run that did not finish. */
export async function syncIsDue(table: TeamRecordTable, orgId: OrgId, connectionId: string, nowMs: number): Promise<boolean> {
  const stamp = await readStamp(table, orgId, connectionId);
  return stamp.at === undefined || stamp.complete !== true || nowMs - Date.parse(stamp.at) >= SYNC_EVERY_MS;
}

/**
 * Reads one connection's users within `maxMs` and links or lists them. Safe to repeat: a person already linked is left as they are (an admin's mapping is never replaced), a person an admin unmapped is not linked
 * again, an erased person's tool id is skipped, and a run that ran out of time is resumed from its cursor by the next one. A complete run drops from the unmatched list whoever the tool no longer lists.
 */
export async function syncTrackerUsers(deps: SyncDependencies, orgId: OrgId, tracker: ConnectedTracker, options: { maxMs: number }): Promise<SyncResult> {
  const started = deps.now();
  const stamp = await readStamp(deps.table, orgId, tracker.connectionId);
  const runStart = stamp.complete === false && stamp.resume !== undefined ? stamp.resume.startedAt : new Date(started).toISOString();
  let after = stamp.complete === false ? stamp.resume?.after : undefined;
  const result: SyncResult = { read: 0, linked: 0, alreadyLinked: 0, unmatched: 0, complete: false };
  try {
    for (;;) {
      const page = await tracker.readUsers({ ...(after === undefined ? {} : { after }), limit: USERS_PER_PAGE });
      for (const user of page.users) {
        result.read += 1;
        const link = { system: tracker.system, sourceId: user.sourceId };
        if (await isErasedActor(deps.table, orgId, tracker.system, { sourceId: user.sourceId })) { await clearUnmatchedTrackerUser(deps.table, orgId, link); continue; }
        if (await developerOfTrackerAuthor(deps.table, orgId, link) !== undefined) { result.alreadyLinked += 1; await clearUnmatchedTrackerUser(deps.table, orgId, link); continue; }
        let linked = false;
        if (user.emailVerified && user.email !== undefined && !await isAutoLinkSuppressed(deps.table, orgId, link)) {
          try { linked = await deps.linkByVerifiedEmail(orgId, { ...link, email: user.email, emailVerified: true, displayName: user.displayName }); } catch { linked = false; }
        }
        if (linked) { result.linked += 1; await clearUnmatchedTrackerUser(deps.table, orgId, link); } else { result.unmatched += 1; await noteUnmatchedTrackerUser(deps.table, orgId, { ...link, displayName: user.displayName, at: new Date(deps.now()).toISOString() }); }
      }
      after = page.next;
      if (after === undefined) { result.complete = true; break; }
      if (result.read >= USERS_PER_RUN_MAX || deps.now() - started >= options.maxMs) break;
    }
  } catch {
    // A read that failed (a refused key, a timeout) changes nothing already right; the next run tries again.
    deps.log?.("record.tracker_sync_failed", { kind: tracker.kind });
    result.failed = true;
  }
  if (result.complete) await pruneUnmatchedTrackerUsers(deps.table, orgId, tracker.system, runStart);
  await deps.table.documentClient.send(new PutCommand({
    TableName: deps.table.tableName,
    Item: { ...stampKey(orgId, tracker.connectionId), entityType: "TEAM_RECORD_TRACKER_SYNC", orgId, at: new Date(deps.now()).toISOString(), complete: result.complete, read: result.read, linked: result.linked, unmatched: result.unmatched,
      ...(!result.complete && after !== undefined ? { resume: { after, startedAt: runStart } } : {}) },
  }));
  return result;
}
