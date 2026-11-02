// Linking tracker people automatically (lane team-record-links). When a company has connected Linear or Jira through the app, Rovara reads the tool's user list (the tool's id, the name it shows, the email it holds,
// and whether the account is a guest and company-controlled) through that connection: when the connection is saved (marked due, read by the next scheduled run) and once a day after. Everyone is LISTED for an admin
// to map by hand (the name and the tool's id; the email is never stored). Only when the company has turned the opt-in switch ON (`tracker-autolink.ts`) is anyone LINKED by themselves, and only when all three of its
// conditions hold. No connection, no read: a company that has not connected a tool is never asked about it. Reads are bounded (pages, people, time) and a run can be repeated: it changes nothing already right.
import { z } from "zod";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk, type OrgId } from "@agentx/contracts";
import { isErasedActor } from "./erased.js";
import { AUTOLINK_LINKED_WHY, autoLinkRefusal, type AutoLinkReason, type CompanyControl, type VerifiedDomainsPort } from "./tracker-autolink.js";
import { clearUnmatchedTrackerUser, developerOfTrackerAuthor, isAutoLinkSuppressed, noteUnmatchedTrackerUser, pruneUnmatchedTrackerUsers, shownName } from "./identity-links.js";
import type { RecordLog, TeamRecordTable } from "./types.js";

/**
 * One person in a tool's user list. `control` says whether the account is company-controlled (a Jira account the company manages, or a Linear workspace that enforces the company's SAML): `unavailable` when the tool
 * cannot be asked with the connection Rovara has. Never a guess.
 */
export interface TrackerUser { sourceId: string; displayName: string; email?: string | undefined; guest?: boolean | undefined; control: CompanyControl }
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
 * Linear workspace "enforces SAML" only when it is plain that it does: SAML sign-in is on, SAML is the ONLY allowed sign-in service, and no bypass is set. `authSettings` is untyped JSON on Linear's side, so
 * anything that is not exactly that shape counts as NOT enforced (fail closed).
 */
export function linearEnforcesSaml(organization: { samlEnabled?: unknown; authSettings?: unknown } | null | undefined): boolean {
  if (organization?.samlEnabled !== true) return false;
  const settings = organization.authSettings;
  if (settings === null || typeof settings !== "object") return false;
  const record = settings as Record<string, unknown>;
  const services = record.allowedAuthServices;
  if (!Array.isArray(services) || services.length !== 1 || services[0] !== "saml") return false;
  return !Object.entries(record).some(([name, value]) => /bypass/iu.test(name) && value !== false && value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0) && !(typeof value === "object" && Object.keys(value).length === 0));
}

const PageBody = z.object({ data: z.object({ users: z.object({
  nodes: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().max(500).nullish(), displayName: z.string().max(500).nullish(), email: z.string().max(500).nullish(), active: z.boolean().nullish(), app: z.boolean().nullish(), guest: z.boolean().nullish() }).passthrough()).max(250),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().max(500).nullish() }).passthrough(),
}).passthrough(), organization: z.object({ samlEnabled: z.boolean().nullish(), authSettings: z.unknown().optional() }).passthrough().nullish() }).passthrough() }).passthrough();
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
      body: JSON.stringify({ query: "query($first:Int!,$after:String){ organization{ samlEnabled authSettings } users(first:$first, after:$after){ nodes{ id name displayName email active app guest } pageInfo{ hasNextPage endCursor } } }", variables: { first: Math.min(limit, 250), ...(after === undefined ? {} : { after }) } }),
    });
    if (!response.ok) throw new Error("linear refused the read");
    const text = await cappedText(response);
    const parsed = text === undefined ? undefined : PageBody.safeParse(JSON.parse(text));
    if (parsed === undefined || !parsed.success) throw new Error("linear answered with something unreadable");
    const { nodes, pageInfo } = parsed.data.data.users;
    const enforced = linearEnforcesSaml(parsed.data.data.organization);
    const users: TrackerUser[] = nodes.filter((node) => node.app !== true && node.active !== false).map((node) => {
      const email = typeof node.email === "string" && node.email !== "" ? node.email : undefined;
      return { sourceId: node.id, displayName: shownName(node.displayName || node.name || undefined, node.id), ...(email === undefined ? {} : { email }), guest: node.guest === true, control: enforced ? "yes" as const : "no" as const };
    });
    return { users, ...(pageInfo.hasNextPage && typeof pageInfo.endCursor === "string" && pageInfo.endCursor !== "" ? { next: pageInfo.endCursor } : {}) };
  };
}

/**
 * The accounts the company MANAGES, from the Atlassian organization admin API (public docs: `GET https://api.atlassian.com/admin/v1/orgs/{orgId}/users`, "Returns a list of managed accounts in an
 * organization", `Authorization: Bearer <API key>`, scope `read:accounts:admin`, paged with `links.next`). `ids` holds the `account_id` of every ACTIVE `atlassian` account listed; `complete` is false when the
 * list was cut short (a page cap or the time cap), so an account missing from it is then "cannot tell", never "not managed". `undefined`: the key was refused or the answer unreadable (nothing is guessed).
 * The key goes to that one host and nowhere else: no redirect is followed, and a next link to another host or organization ends the read.
 */
export type ManagedAccounts = { ids: ReadonlySet<string>; complete: boolean };
export const ATLASSIAN_ADMIN_ORIGIN = "https://api.atlassian.com";
export const MANAGED_PAGES_MAX = 100;
export const MANAGED_READ_MS = 20_000;
const ManagedPage = z.object({
  data: z.array(z.object({ account_id: z.string().min(1).max(200), account_type: z.string().max(40).nullish(), account_status: z.string().max(40).nullish() }).passthrough()).max(5_000),
  links: z.object({ next: z.string().max(2_000).nullish() }).passthrough().nullish(),
}).passthrough();

export function atlassianManagedAccountsReader(input: { fetch: typeof fetch; atlassianOrgId: string; apiKey: string; now?: () => number }): () => Promise<ManagedAccounts | undefined> {
  const now = input.now ?? Date.now;
  const path = `/admin/v1/orgs/${encodeURIComponent(input.atlassianOrgId)}/users`;
  return async () => {
    const started = now();
    const ids = new Set<string>();
    let url: string | undefined = `${ATLASSIAN_ADMIN_ORIGIN}${path}`;
    for (let pages = 0; url !== undefined; pages += 1) {
      if (pages >= MANAGED_PAGES_MAX || now() - started >= MANAGED_READ_MS) return { ids, complete: false };
      let page: z.infer<typeof ManagedPage>;
      try {
        const response = await input.fetch(url, { method: "GET", headers: { authorization: `Bearer ${input.apiKey}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
        if (!response.ok) return undefined;
        const text = await cappedText(response);
        const parsed = text === undefined ? undefined : ManagedPage.safeParse(JSON.parse(text));
        if (parsed === undefined || !parsed.success) return undefined;
        page = parsed.data;
      } catch { return undefined; }
      for (const account of page.data) if (account.account_type === "atlassian" && account.account_status === "active") ids.add(account.account_id);
      const next: string | null | undefined = page.links?.next;
      if (typeof next !== "string" || next === "") break;
      // Only this organization's own user list, on this host, is ever followed.
      let target: URL;
      try { target = new URL(next, ATLASSIAN_ADMIN_ORIGIN); } catch { return { ids, complete: false }; }
      if (target.origin !== ATLASSIAN_ADMIN_ORIGIN || target.pathname !== path || target.username !== "" || target.password !== "") return { ids, complete: false };
      url = target.href;
    }
    return { ids, complete: true };
  };
}

/** Jira Cloud: the site's people through the connection's account email and API token. Only real people (`atlassian` accounts, not apps or customers) who are active; a hidden email is no email. */
export function jiraUsersReader(input: { fetch: typeof fetch; siteUrl: string; email: string; apiToken: string; /** Which accounts the company manages (the organization admin API); absent: company control is `unavailable` for everyone. */ managed?: () => Promise<ManagedAccounts | undefined> }): ConnectedTracker["readUsers"] {
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
    // Whether an account is MANAGED by the company is in the Atlassian organization admin API, which a site's API token cannot reach: only a company that supplied a read-only organization admin key has an answer.
    // Without one, or when the answer is unreadable, or the account is not in a list that was cut short, control is `unavailable`: no Jira person links by themselves.
    const managed = input.managed === undefined || !parsed.data.some((user) => user.accountType === "atlassian" && user.active !== false) ? undefined : await input.managed().catch(() => undefined);
    const controlOf = (accountId: string): CompanyControl => (managed === undefined ? "unavailable" : managed.ids.has(accountId) ? "yes" : managed.complete ? "no" : "unavailable");
    const users: TrackerUser[] = parsed.data.filter((user) => user.accountType === "atlassian" && user.active !== false).map((user) => {
      const email = typeof user.emailAddress === "string" && user.emailAddress !== "" ? user.emailAddress : undefined;
      return { sourceId: user.accountId, displayName: shownName(user.displayName || undefined, user.accountId), ...(email === undefined ? {} : { email }), control: controlOf(user.accountId) };
    });
    // Jira pages by position, over everyone it lists (apps included), so a full page means there may be more.
    return { users, ...(parsed.data.length >= size ? { next: String(startAt + parsed.data.length) } : {}) };
  };
}

export interface SyncDependencies {
  table: TeamRecordTable;
  now: () => number;
  /** `runtime.links.linkByVerifiedEmail`: links only when the person is a member of this org whose verified sign-in email is the one given. */
  linkByVerifiedEmail(orgId: OrgId, input: { system: string; sourceId: string; email: string; emailVerified: boolean | undefined; displayName?: string; via?: "auto"; why?: string }): Promise<boolean>;
  /** Whether the company turned automatic linking on, and the domains it has verified for its sign-in. Absent: automatic linking is off and nobody is linked by themselves. */
  autoLink?: { enabled(orgId: OrgId): Promise<boolean>; domains: VerifiedDomainsPort };
  log?: RecordLog;
}

export interface SyncResult { read: number; linked: number; alreadyLinked: number; unmatched: number; complete: boolean; failed?: true }

const stampKey = (orgId: OrgId, connectionId: string): { pk: string; sk: string } => ({ pk: teamRecordPk(orgId), sk: `TRSYNC#${connectionId}` });
interface Stamp { at?: string; complete?: boolean; failedRuns?: number; resume?: { after: string; startedAt: string } }
/** S5: a saved cursor that has failed this many runs in a row, or is older than a day, is dropped and the read starts again from the beginning (a cursor can expire at the tool). */
export const RESUME_FAILED_RUNS_MAX = 2;
export const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
async function readStamp(table: TeamRecordTable, orgId: OrgId, connectionId: string): Promise<Stamp> {
  const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: stampKey(orgId, connectionId), ConsistentRead: true }))) as { Item?: { at?: unknown; complete?: unknown; failedRuns?: unknown; resume?: { after?: unknown; startedAt?: unknown } } }).Item;
  return {
    ...(typeof item?.at === "string" ? { at: item.at } : {}), ...(typeof item?.complete === "boolean" ? { complete: item.complete } : {}), ...(typeof item?.failedRuns === "number" ? { failedRuns: item.failedRuns } : {}),
    ...(typeof item?.resume?.after === "string" && typeof item.resume.startedAt === "string" ? { resume: { after: item.resume.after, startedAt: item.resume.startedAt } } : {}),
  };
}

/** Marks a connection's users as due: the scheduled job reads them at its next run. A save does this instead of reading, so saving a connection never waits on the tool. */
export async function markSyncDue(table: TeamRecordTable, orgId: OrgId, connectionId: string, nowMs: number): Promise<void> {
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...stampKey(orgId, connectionId), entityType: "TEAM_RECORD_TRACKER_SYNC", orgId, at: new Date(nowMs).toISOString(), complete: false } }));
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
  const resumable = stamp.complete === false && stamp.resume !== undefined && (stamp.failedRuns ?? 0) < RESUME_FAILED_RUNS_MAX && started - Date.parse(stamp.resume.startedAt) < RESUME_MAX_AGE_MS;
  const runStart = resumable ? stamp.resume!.startedAt : new Date(started).toISOString();
  let after = resumable ? stamp.resume!.after : undefined;
  if (stamp.resume !== undefined && !resumable) deps.log?.("record.tracker_cursor_dropped", { kind: tracker.kind });
  const result: SyncResult = { read: 0, linked: 0, alreadyLinked: 0, unmatched: 0, complete: false };
  // The switch and the company's verified domains are read once per run (not once per person): a run is a few seconds, and a change made during it applies from the next.
  let autoLinkRead: { enabled: boolean; domains: ReadonlySet<string> | undefined } | undefined;
  const autoLinkState = async () => {
    if (autoLinkRead !== undefined) return autoLinkRead;
    const enabled = deps.autoLink === undefined ? false : await deps.autoLink.enabled(orgId).catch(() => false);
    const domains = enabled && deps.autoLink !== undefined ? await deps.autoLink.domains.domainsOf(orgId).catch(() => undefined) : undefined;
    autoLinkRead = { enabled, domains };
    return autoLinkRead;
  };
  try {
    for (;;) {
      const page = await tracker.readUsers({ ...(after === undefined ? {} : { after }), limit: USERS_PER_PAGE });
      for (const user of page.users) {
        result.read += 1;
        const link = { system: tracker.system, sourceId: user.sourceId };
        if (await isErasedActor(deps.table, orgId, tracker.system, { sourceId: user.sourceId })) { await clearUnmatchedTrackerUser(deps.table, orgId, link); continue; }
        if (await developerOfTrackerAuthor(deps.table, orgId, link) !== undefined) { result.alreadyLinked += 1; await clearUnmatchedTrackerUser(deps.table, orgId, link); continue; }
        // Opt-in automatic linking: the switch, then the three conditions (the third is the exact match of a member's verified sign-in email, made by `linkByVerifiedEmail`). The first that fails is the person's reason.
        const { enabled, domains } = await autoLinkState();
        let reason: AutoLinkReason | undefined = autoLinkRefusal({ enabled, email: user.email, domains, guest: user.guest === true, control: user.control, suppressed: enabled && await isAutoLinkSuppressed(deps.table, orgId, link) });
        let linked = false;
        if (reason === undefined && user.email !== undefined) {
          try { linked = await deps.linkByVerifiedEmail(orgId, { ...link, email: user.email, emailVerified: true, displayName: user.displayName, via: "auto", why: AUTOLINK_LINKED_WHY }); } catch { linked = false; }
          if (!linked) reason = "no_matching_member";
        }
        if (linked) { result.linked += 1; await clearUnmatchedTrackerUser(deps.table, orgId, link); } else { result.unmatched += 1; await noteUnmatchedTrackerUser(deps.table, orgId, { ...link, displayName: user.displayName, at: new Date(deps.now()).toISOString(), ...(reason === undefined ? {} : { reason }) }); }
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
      failedRuns: result.failed === true ? (resumable ? (stamp.failedRuns ?? 0) : 0) + 1 : 0,
      ...(!result.complete && after !== undefined ? { resume: { after, startedAt: runStart } } : {}) },
  }));
  return result;
}
