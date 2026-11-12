// Convergence lane A9: the Jira Tracker adapter for Cloud, on Code's Tracker port. Registered under conformance only; no traffic reaches it yet (the switch is S0's composition root).
// It reads through the company's OWN Jira connection (`connections/store.ts`) and writes through the existing ticket-updates writer (`ticket-updates/trackers.ts`, not edited):
//   - `comment`          the writer's comment: one per key (the marker property and the connection's own account), internal for a task only its owner sees, a read connection is "needs write access";
//   - `setStatusByName`  the writer's transition to the status the project names ("In Review");
//   - `readItem`         the issue as Jira has it now (summary, description, status category, assignee, labels), through any connection of the ticket's site.
// Left out rather than invented: a neutral `setStatus` (Cloud maps a moment to the project's own status name, so it moves by name), `link`, `askedFor` (Cloud's poll keeps its own Jira search,
// `triggers/intake-searches.ts`) and `events` (Cloud's Jira webhook is the `jira` trigger source, `triggers/providers/jira.ts`). The capabilities say so.
// Which site: the ticket's own link names it (`https://<site>.atlassian.net/browse/KEY`); a ref with no link is read through the company's only Jira site, and several sites with no link is a refusal.
// Every key goes only to the connection's own Atlassian site, no redirect is followed, an answer is read to a cap, and no error carries the key or the text.
import {
  agentXError, HostScopeSchema, TrackerItemSchema, TrackerWriteRefusedError,
  type HostScope, type NeutralStatus, type OrgId, type Tracker, type TrackerCapabilities, type TrackerCommentOptions, type TrackerItem, type TrackerItemRef, type UntrustedText,
} from "@rovara-code/contracts";
import { OrgConnectionStore, readConnection, readConnectionSecret, type OrgConnectionDeps, type OrgConnectionRecord } from "../../../connections/store.js";
import { adfText } from "../../../triggers/intake-searches.js";
import { ticketTrackersOf, type TicketRef, type TicketTrackerPort } from "../../../ticket-updates/trackers.js";

export const JIRA_TRACKER_KIND = "jira";
export const JIRA_TRACKER_CAPABILITIES: TrackerCapabilities = { startTasks: false, comment: true, status: false, link: false, events: "none" };
export const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,30}-[1-9][0-9]{0,9}$/u;
export const JIRA_NO_ORG_MESSAGE = "The Jira call has no organization to act for.";
export const JIRA_NO_SITE_MESSAGE = "No single Jira connection of the company serves this ticket's site.";

const ATLASSIAN_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/u;
const TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 2_000_000;
const COMMENT_MAX_CHARS = 10_000;
const NEUTRAL_OF_CATEGORY: Readonly<Record<string, NeutralStatus>> = { new: "open", indeterminate: "in_progress", done: "done" };

type Connection = OrgConnectionRecord & { siteUrl?: string; identity?: "service" | "personal" };

export interface CloudJiraTrackerOptions {
  /** The company connection store (the State table and the company secrets). */
  connections: OrgConnectionDeps;
  fetch?: typeof fetch | undefined;
  /** The organization a private install's system scope speaks for. Absent: a system scope has no organization, and nothing is read or written for it. */
  installOrg?: (() => OrgId | undefined) | undefined;
  /** The writer to use; default the ticket-updates writer over `connections` (a test may stand in). */
  writer?: Pick<TicketTrackerPort, "comment" | "setStatus"> | undefined;
}

const rec = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const cut = (text: string, max: number): string => [...text].slice(0, max).join("");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Jira could not be reached just now.");
const noSuchItem = () => agentXError("RUNTIME_UNAVAILABLE", "the tracker has no such item");

/** The site of a Jira link as an origin, or undefined for anything that is not an https Atlassian site with no sign-in data or port. */
export function jiraSiteOf(address: string | undefined): string | undefined {
  if (address === undefined || address === "") return undefined;
  try {
    const url = new URL(address);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && ATLASSIAN_HOST.test(host) ? `https://${host}` : undefined;
  } catch {
    return undefined;
  }
}

function keyOf(ref: TrackerItemRef): string {
  if (ref.tracker !== JIRA_TRACKER_KIND) throw agentXError("CONFIG_INVALID", "the item belongs to another tracker");
  if (!JIRA_KEY.test(ref.id)) throw agentXError("CONFIG_INVALID", "the item id is not a Jira issue key");
  return ref.id;
}

export function cloudJiraTracker(options: CloudJiraTrackerOptions): Tracker {
  const fetchImpl = options.fetch ?? fetch;
  const writer = options.writer ?? ticketTrackersOf({ connections: options.connections, fetch: fetchImpl }).jira;

  const orgOf = (scope: HostScope): OrgId => {
    const parsed = HostScopeSchema.safeParse(scope);
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "the plug-in call has no valid scope");
    const orgId = "orgId" in parsed.data ? parsed.data.orgId : options.installOrg?.();
    if (orgId === undefined) throw agentXError("CONFIG_INVALID", JIRA_NO_ORG_MESSAGE);
    return orgId;
  };

  /** The company's Jira connections that hold a key, read whole (the site is kept back from the list). */
  const jiraConnections = async (orgId: OrgId): Promise<Connection[]> => {
    const found: Connection[] = [];
    for (const entry of await new OrgConnectionStore({ ...options.connections }).list(orgId)) {
      if (entry.type !== "jira" || entry.hasSecret !== true) continue;
      const record = await readConnection(options.connections, orgId, entry.connectionId) as Connection | undefined;
      if (record !== undefined && record.orgId === orgId && record.type === "jira" && record.hasSecret === true && jiraSiteOf(record.siteUrl) !== undefined) found.push(record);
    }
    return found;
  };

  /** The ticket as the writer reads it: its key and its link on its site. A ref with no link takes the company's only Jira site. */
  const ticketOf = async (orgId: OrgId, ref: TrackerItemRef): Promise<TicketRef> => {
    const key = keyOf(ref);
    let site = jiraSiteOf(ref.url);
    if (ref.url !== undefined && ref.url !== "" && site === undefined) throw agentXError("CONFIG_INVALID", "the item's link is not a Jira site");
    if (site === undefined) {
      const sites = [...new Set((await jiraConnections(orgId)).map((record) => jiraSiteOf(record.siteUrl)!))];
      if (sites.length !== 1) throw agentXError("CONFIG_INVALID", JIRA_NO_SITE_MESSAGE);
      site = sites[0]!;
    }
    return { tracker: "jira", id: key, url: `${site}/browse/${key}` };
  };

  const read = async (orgId: OrgId, site: string, path: string): Promise<{ status: number; body: unknown }> => {
    // A connection made for automation reads: one of the site, with read access (read or read and write), that is not a person's own (a `personal` connection is that person's key and
    // speaks for them, so an automated read never borrows it). A service connection first, then by id, so the choice is the same every time.
    const chosen = (await jiraConnections(orgId)).filter((record) => jiraSiteOf(record.siteUrl) === site && record.identity !== "personal" && (record.access === "read" || record.access === "read_write"))
      .sort((left, right) => Number(right.identity === "service") - Number(left.identity === "service") || left.connectionId.localeCompare(right.connectionId))[0];
    if (chosen === undefined) throw agentXError("CONFIG_INVALID", JIRA_NO_SITE_MESSAGE);
    const secret = await readConnectionSecret(options.connections, orgId, chosen).catch(() => undefined);
    if (secret === undefined || !("apiToken" in secret) || !("email" in secret)) throw agentXError("CONFIG_INVALID", JIRA_NO_SITE_MESSAGE);
    let response: Response;
    try {
      response = await fetchImpl(`${site}${path}`, {
        headers: { authorization: `Basic ${Buffer.from(`${secret.email}:${secret.apiToken}`).toString("base64")}`, accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw unavailable();
    }
    if (response.status === 429) throw agentXError("TOO_MANY_REQUESTS", "Jira asked Rovara to slow down.");
    if (response.status >= 500) throw unavailable();
    const text = await response.text().catch(() => { throw unavailable(); });
    if (Buffer.byteLength(text, "utf8") > RESPONSE_MAX_BYTES) throw unavailable();
    let body: unknown;
    try { body = text === "" ? undefined : JSON.parse(text); } catch { body = undefined; }
    return { status: response.status, body };
  };

  return {
    kind: JIRA_TRACKER_KIND,
    capabilities: JIRA_TRACKER_CAPABILITIES,

    async readItem(ref: TrackerItemRef, scope: HostScope): Promise<TrackerItem> {
      const orgId = orgOf(scope);
      const ticket = await ticketOf(orgId, ref);
      const site = new URL(ticket.url).origin;
      const answer = await read(orgId, site, `/rest/api/3/issue/${encodeURIComponent(ticket.id)}?fields=summary,description,status,assignee,labels,updated`);
      if (answer.status === 404 || answer.status === 401 || answer.status === 403) throw noSuchItem();
      if (answer.status !== 200) throw unavailable();
      const issue = rec(answer.body);
      // An answer for another issue than the one asked about is no answer.
      if (str(issue["key"]) !== ticket.id) throw noSuchItem();
      const fields = rec(issue["fields"]);
      const category = str(rec(rec(fields["status"])["statusCategory"])["key"]);
      const assignee = str(rec(fields["assignee"])["displayName"]);
      const updated = str(fields["updated"]);
      return TrackerItemSchema.parse({
        ref: { tracker: JIRA_TRACKER_KIND, id: ticket.id, url: ticket.url },
        title: cut(str(fields["summary"]) ?? ticket.id, 1_000),
        // A block's line break is the document format's, not the writer's: the last one is dropped so the text is what was written.
        body: cut(adfText(fields["description"]).replace(/\n+$/u, ""), 65_536),
        status: (category === undefined ? undefined : NEUTRAL_OF_CATEGORY[category]) ?? "open",
        ...(assignee === undefined ? {} : { assignee: cut(assignee, 200) }),
        labels: arr(fields["labels"]).filter((label): label is string => typeof label === "string" && label !== "").slice(0, 100).map((label) => cut(label, 200)),
        ...(updated === undefined || Number.isNaN(Date.parse(updated)) ? {} : { updatedAt: new Date(updated).toISOString() }),
      });
    },

    async comment(ref: TrackerItemRef, body: UntrustedText, scope: HostScope, commentOptions?: TrackerCommentOptions): Promise<void> {
      const orgId = orgOf(scope);
      const ticket = await ticketOf(orgId, ref);
      if (body.length === 0 || body.length > COMMENT_MAX_CHARS) throw agentXError("CONFIG_INVALID", "the comment is empty or too long");
      const outcome = await writer.comment({ orgId, ticket, text: body, key: commentOptions?.key ?? `once:${ticket.id}:${body}`, requirePrivate: commentOptions?.requirePrivate === true });
      // Jira never answers "public" (that is the GitHub writer's): it is refused like a write the tracker would not take.
      if (outcome === "posted") return;
      throw new TrackerWriteRefusedError(outcome === "public" ? "needs_write_access" : outcome);
    },

    async setStatusByName(ref: TrackerItemRef, name: string, scope: HostScope): Promise<"moved" | "no_such_status"> {
      const orgId = orgOf(scope);
      const ticket = await ticketOf(orgId, ref);
      if (name.trim() === "" || name.length > 200) throw agentXError("CONFIG_INVALID", "the status name is empty or too long");
      const outcome = await writer.setStatus({ orgId, ticket, status: name });
      if (outcome === "moved" || outcome === "no_such_status") return outcome;
      throw new TrackerWriteRefusedError(outcome);
    },
  };
}
