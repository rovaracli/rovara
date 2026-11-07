// Slice 5 "Outside tools" (owner decision 6): how Rovara writes one comment, or one status change, to a Linear issue, a Jira issue or a GitHub issue, through the company's EXISTING connection with
// the access it already has. Nothing here asks for more:
//   - Linear: a connection with `access: read_write`, a saved key and a checked account (`linear-write.ts`'s rule, so every comment can later be edited or deleted). Only read connections:
//     `needs_write_access`. No Linear connection: `not_connected`.
//   - Jira: the connection of the ticket's own Atlassian site. `access: read`, or Jira answering 401/403: `needs_write_access`.
//   - GitHub: the GitHub App's token for `issues: write` on the one repository; an App that may not write issues there: `needs_write_access`.
// Every key goes only to the tracker's own address, no redirect is followed, an answer is read to a cap, and no error carries the key or the text. A rate limit or a fault that may pass THROWS
// (the milestone delivery tries again, a bounded number of times); every other answer is a value, so a ticket that cannot be written never fails the task.
import { createHash } from "node:crypto";
import { agentXError, type OrgId, type TicketTracker } from "@agentx/contracts";
import { LINEAR_GRAPHQL, OrgConnectionStore, readConnection, readConnectionSecret, type OrgConnectionDeps, type OrgConnectionRecord } from "../connections/store.js";
import type { GitHubTokenScope } from "../github-app.js";
import type { LinearReplyPort } from "../rovara-code/linear-comments.js";
import { workspaceOfIssueUrl } from "../rovara-code/linear-write.js";

/** The ticket a task started from, as intake recorded it (system, id and link checked by the intake schema). */
export interface TicketRef { tracker: TicketTracker; id: string; url: string }

export type CommentOutcome = "posted" | "needs_write_access" | "not_connected" | "not_found" | "public";
export type StatusOutcome = "moved" | "needs_write_access" | "not_connected" | "not_found" | "no_such_status";

export interface TicketTrackerPort {
  comment(input: { orgId: OrgId; ticket: TicketRef; text: string; key: string; requirePrivate: boolean }): Promise<CommentOutcome>;
  setStatus(input: { orgId: OrgId; ticket: TicketRef; status: string }): Promise<StatusOutcome>;
}

const TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 1_000_000;
type Connection = OrgConnectionRecord & { actorId?: string; secretVersion?: string; siteUrl?: string; workspaceKey?: string; identity?: "service" | "personal" };

const unavailable = (what: string) => agentXError("RUNTIME_UNAVAILABLE", `${what} could not be reached just now.`);
const rateLimited = (what: string) => agentXError("TOO_MANY_REQUESTS", `${what} asked Rovara to slow down.`);
const rec = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const lower = (value: unknown): string => (typeof value === "string" ? value.toLowerCase() : "");

async function connectionsOf(deps: OrgConnectionDeps, orgId: OrgId, type: "linear" | "jira"): Promise<Connection[]> {
  const found: Connection[] = [];
  for (const entry of await new OrgConnectionStore({ ...deps }).list(orgId)) {
    if (entry.type !== type || entry.hasSecret !== true) continue;
    const record = await readConnection(deps, orgId, entry.connectionId) as Connection | undefined;
    if (record !== undefined && record.orgId === orgId && record.type === type && record.hasSecret === true) found.push(record);
  }
  return found.sort((left, right) => Number(right.identity === "service") - Number(left.identity === "service") || left.connectionId.localeCompare(right.connectionId));
}

async function readText(response: Response, what: string): Promise<string> {
  const text = await response.text().catch(() => { throw unavailable(what); });
  if (Buffer.byteLength(text, "utf8") > RESPONSE_MAX_BYTES) throw unavailable(what);
  return text;
}

// ---- Linear

async function linearCall(fetchImpl: typeof fetch, apiKey: string, query: string, variables: Record<string, unknown>): Promise<{ data: Record<string, unknown>; errors: unknown[] }> {
  let response: Response;
  try {
    response = await fetchImpl(LINEAR_GRAPHQL, { method: "POST", headers: { authorization: apiKey, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify({ query, variables }) });
  } catch {
    throw unavailable("Linear");
  }
  const text = await readText(response, "Linear");
  let envelope: Record<string, unknown>;
  try { envelope = rec(JSON.parse(text)); } catch { throw unavailable("Linear"); }
  const errors = arr(envelope["errors"]);
  if (response.status === 429 || errors.some((entry) => rec(rec(entry)["extensions"])["code"] === "RATELIMITED")) throw rateLimited("Linear");
  if (response.status < 200 || response.status >= 300) throw unavailable("Linear");
  return { data: rec(envelope["data"]), errors };
}

function linearPort(deps: OrgConnectionDeps, reply: LinearReplyPort | undefined, fetchImpl: typeof fetch): Pick<TicketTrackerPort, "comment" | "setStatus"> {
  /**
   * The connection that may write to the ticket's OWN workspace (review I2: identifiers like ENG-12 repeat across workspaces), or why there is none. The workspace is the url key of the ticket's
   * stored link (`linear.app/<workspace>/issue/...`); a link that names none, or no connection checked in that workspace, writes nothing.
   */
  async function writer(orgId: OrgId, ticket: TicketRef): Promise<{ connection: Connection; workspace: string } | "needs_write_access" | "not_connected"> {
    const workspace = workspaceOfIssueUrl(ticket.url);
    if (workspace === undefined) return "not_connected";
    const inWorkspace = (await connectionsOf(deps, orgId, "linear")).filter((record) => record.workspaceKey === workspace);
    if (inWorkspace.length === 0) return "not_connected";
    const connection = inWorkspace.find((record) => record.access === "read_write" && typeof record.actorId === "string" && record.actorId !== "");
    return connection === undefined ? "needs_write_access" : { connection, workspace };
  }
  return {
    async comment({ orgId, ticket, text, key }) {
      const chosen = await writer(orgId, ticket);
      if (typeof chosen === "string") return chosen;
      if (reply === undefined) return "not_connected";
      // The comment's id is made from the org and the key (`linearCommentIdFor`): the same update again is the same comment, never a second one. The workspace makes the writer check (AL-1)
      // that the issue it finds is in the ticket's own workspace.
      await reply.reply({ orgId, issueKey: ticket.id, text, commentKey: key, workspace: chosen.workspace });
      return "posted";
    },
    async setStatus({ orgId, ticket, status }) {
      const chosen = await writer(orgId, ticket);
      if (typeof chosen === "string") return chosen;
      const secret = await readConnectionSecret(deps, orgId, chosen.connection).catch(() => undefined);
      if (secret === undefined || !("apiKey" in secret)) return "not_connected";
      const read = await linearCall(fetchImpl, secret.apiKey, "query($id: String!) { issue(id: $id) { id url state { name } team { states(first: 100) { nodes { id name } } } } }", { id: ticket.id });
      const issue = rec(read.data["issue"]);
      // The issue the key found must be in the ticket's own workspace, or nothing is moved.
      if (typeof issue["id"] !== "string" || typeof issue["url"] !== "string" || workspaceOfIssueUrl(issue["url"]) !== chosen.workspace) return "not_found";
      if (lower(rec(issue["state"])["name"]) === status.toLowerCase()) return "moved";
      const state = arr(rec(rec(issue["team"])["states"])["nodes"]).map(rec).find((node) => typeof node["name"] === "string" && node["name"].toLowerCase() === status.toLowerCase());
      if (state === undefined || typeof state["id"] !== "string") return "no_such_status";
      const written = await linearCall(fetchImpl, secret.apiKey, "mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }", { id: issue["id"], state: state["id"] });
      if (rec(written.data["issueUpdate"])["success"] === true) return "moved";
      // A permission answer is Linear refusing the write; anything else may pass.
      if (written.errors.some((entry) => /forbidden|permission/iu.test(lower(rec(rec(entry)["extensions"])["code"])))) return "needs_write_access";
      throw unavailable("Linear");
    },
  };
}

// ---- Jira

const siteOf = (url: string): string | undefined => {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && /\.atlassian\.net$/u.test(parsed.hostname) ? `https://${parsed.hostname}` : undefined; } catch { return undefined; }
};
const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,30}-[1-9][0-9]{0,9}$/u;
/** The comment property that marks Rovara's update (its value is a hash of the update's key, nothing else). */
export const MARKER_PROPERTY = "rovara.ticket-update";

function jiraPort(deps: OrgConnectionDeps, fetchImpl: typeof fetch): Pick<TicketTrackerPort, "comment" | "setStatus"> {
  /** The connection of the ticket's own site, and its basic auth; or why there is none. */
  async function connectionFor(orgId: OrgId, ticket: TicketRef): Promise<{ site: string; auth: string } | "needs_write_access" | "not_connected"> {
    const site = siteOf(ticket.url);
    if (site === undefined || !JIRA_KEY.test(ticket.id)) return "not_connected";
    const sameSite = (await connectionsOf(deps, orgId, "jira")).filter((record) => record.siteUrl === site);
    if (sameSite.length === 0) return "not_connected";
    const chosen = sameSite.find((record) => record.access === "read_write");
    if (chosen === undefined) return "needs_write_access";
    const secret = await readConnectionSecret(deps, orgId, chosen).catch(() => undefined);
    if (secret === undefined || !("apiToken" in secret) || !("email" in secret)) return "not_connected";
    return { site, auth: `Basic ${Buffer.from(`${secret.email}:${secret.apiToken}`).toString("base64")}` };
  }
  async function call(site: string, auth: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetchImpl(`${site}${path}`, {
        method: init.method ?? "GET", headers: { authorization: auth, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw unavailable("Jira");
    }
    if (response.status === 429) throw rateLimited("Jira");
    if (response.status >= 500) throw unavailable("Jira");
    const text = await readText(response, "Jira");
    let body: unknown;
    try { body = text === "" ? undefined : JSON.parse(text); } catch { body = undefined; }
    return { status: response.status, body };
  }
  const refused = (status: number): boolean => status === 401 || status === 403;
  return {
    async comment({ orgId, ticket, text, key, requirePrivate }) {
      const chosen = await connectionFor(orgId, ticket);
      if (typeof chosen === "string") return chosen;
      const path = `/rest/api/3/issue/${encodeURIComponent(ticket.id)}/comment`;
      // Review M4: each update carries a marker (a property holding a hash of its key). Before posting, the newest comments are read; one with the marker means an earlier try was posted (its
      // answer was lost), so it is not posted again.
      const marker = createHash("sha256").update(key).digest("hex").slice(0, 32);
      const recent = await call(chosen.site, chosen.auth, `${path}?orderBy=-created&maxResults=50&expand=properties`);
      if (refused(recent.status)) return "needs_write_access";
      if (recent.status === 404) return "not_found";
      if (recent.status !== 200) throw unavailable("Jira");
      const already = arr(rec(recent.body)["comments"]).some((comment) => arr(rec(comment)["properties"]).some((property) => rec(property)["key"] === MARKER_PROPERTY && rec(rec(property)["value"])["id"] === marker));
      if (already) return "posted";
      const paragraphs = text.split("\n").filter((line) => line !== "").map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));
      // Review M5: for a task only its owner can see, the comment is internal, so a Jira Service Management customer never sees it (a plain Jira project ignores the property).
      const properties = [{ key: MARKER_PROPERTY, value: { id: marker } }, ...(requirePrivate ? [{ key: "sd.public.comment", value: { internal: true } }] : [])];
      const answer = await call(chosen.site, chosen.auth, path, { method: "POST", body: { body: { type: "doc", version: 1, content: paragraphs }, properties } });
      if (refused(answer.status)) return "needs_write_access";
      if (answer.status === 404) return "not_found";
      if (answer.status !== 201 && answer.status !== 200) throw unavailable("Jira");
      return "posted";
    },
    async setStatus({ orgId, ticket, status }) {
      const chosen = await connectionFor(orgId, ticket);
      if (typeof chosen === "string") return chosen;
      const path = `/rest/api/3/issue/${encodeURIComponent(ticket.id)}/transitions`;
      const listed = await call(chosen.site, chosen.auth, path);
      if (refused(listed.status)) return "needs_write_access";
      if (listed.status === 404) return "not_found";
      if (listed.status !== 200) throw unavailable("Jira");
      const wanted = status.toLowerCase();
      const transition = arr(rec(listed.body)["transitions"]).map(rec).find((entry) => lower(rec(entry["to"])["name"]) === wanted || lower(entry["name"]) === wanted);
      if (transition === undefined || typeof transition["id"] !== "string") return "no_such_status";
      const moved = await call(chosen.site, chosen.auth, path, { method: "POST", body: { transition: { id: transition["id"] } } });
      if (refused(moved.status)) return "needs_write_access";
      if (moved.status === 404) return "not_found";
      if (moved.status !== 204 && moved.status !== 200) throw unavailable("Jira");
      return "moved";
    },
  };
}

// ---- GitHub

const GITHUB_ISSUE_ID = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/([1-9][0-9]{0,9})$/u;

function githubPort(github: GitHubIssueWriter | undefined): Pick<TicketTrackerPort, "comment" | "setStatus"> {
  return {
    async comment({ orgId, ticket, text, requirePrivate }) {
      const parts = GITHUB_ISSUE_ID.exec(ticket.id);
      if (github === undefined || parts === null) return "not_connected";
      try {
        const done = await github.commentOnIssue(`https://github.com/${parts[1]!}/${parts[2]!}`, Number(parts[3]), text, { orgId }, { requirePrivate });
        return done === "posted" ? "posted" : done;
      } catch (error) {
        if (error instanceof Error && (error as { code?: unknown }).code === "GITHUB_NOT_CONNECTED") return "needs_write_access";
        throw error;
      }
    },
    // A GitHub issue has no workflow statuses; its pull request's "Fixes" closes it.
    async setStatus() { return "no_such_status"; },
  };
}

export interface GitHubIssueWriter {
  commentOnIssue(repositoryUrl: string, number: number, body: string, scope: GitHubTokenScope, options: { requirePrivate: boolean }): Promise<"posted" | "public" | "not_found">;
}

/** The writer of each tracker, over the company's connections. A tracker whose dependency is absent answers `not_connected`. */
export function ticketTrackersOf(input: { connections?: OrgConnectionDeps | undefined; linearReply?: LinearReplyPort | undefined; github?: GitHubIssueWriter | undefined; fetch?: typeof fetch }): Record<TicketTracker, TicketTrackerPort> {
  const fetchImpl = input.fetch ?? fetch;
  const none: TicketTrackerPort = { comment: async () => "not_connected", setStatus: async () => "not_connected" };
  return {
    linear: input.connections === undefined ? none : linearPort(input.connections, input.linearReply, fetchImpl),
    jira: input.connections === undefined ? none : jiraPort(input.connections, fetchImpl),
    github: githubPort(input.github),
  };
}
