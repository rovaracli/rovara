// Slice 5 "Outside tools": the searches of the watched (polled) intake sources for Jira and Linear, so a source a maintainer adds is read and never fails silently. Each reads through the company's
// OWN connection (`connections/store.ts`): the one the source names (by id or label), or the only connection of that tracker; none, or several with none named, is a failure with a fixed code the
// maintainer is shown. The key goes only to the tracker's own address (the connection's Atlassian site, Linear's fixed GraphQL address), no redirect is followed and an answer is read to a cap.
//
// Who asked: the tracker's own history says who put the label on (or assigned the ticket to Rovara's account). That account id is the act's actor; the intake engine then decides, through the
// company's links, whether it is a member who may start. A ticket whose history does not say is handed over with no actor, so it waits (fail closed). Nothing else from the ticket is trusted.
import { INTAKE_TITLE_MAX, type OrgId } from "@agentx/contracts";
import { LINEAR_GRAPHQL, OrgConnectionStore, readConnection, readConnectionSecret, type OrgConnectionDeps, type OrgConnectionRecord } from "../connections/store.js";
import type { IntakeCandidate } from "../intake/engine.js";
import { outsideEventWindow } from "./ingress.js";
import { IntakeSearchError, intakeSearchFor, type IntakeSearch, type IntakeSearchItem } from "./poll-intake.js";

const RESPONSE_MAX_BYTES = 2_000_000;
const BODY_MAX_CHARS = 8_000;

type Connection = OrgConnectionRecord & { actorId?: string; secretVersion?: string };

/** The connection a source reads through: the one it names (id or label), else the only one of its type that holds a key. */
export function sourceConnectionCandidates<T extends Pick<OrgConnectionRecord, "type" | "hasSecret" | "connectionId" | "label">>(connections: readonly T[], type: "jira" | "linear", named: string | undefined): T[] {
  const listed = connections.filter((entry) => entry.type === type && entry.hasSecret === true);
  return named === undefined ? listed : listed.filter((entry) => entry.connectionId === named || entry.label === named);
}

export async function connectionForSource(deps: OrgConnectionDeps, orgId: OrgId, type: "jira" | "linear", named: string | undefined): Promise<Connection> {
  const chosen = sourceConnectionCandidates(await new OrgConnectionStore({ ...deps }).list(orgId), type, named);
  if (chosen.length === 0) throw new IntakeSearchError("CONNECTION_MISSING");
  if (chosen.length > 1) throw new IntakeSearchError("CONNECTION_AMBIGUOUS");
  const record = await readConnection(deps, orgId, chosen[0]!.connectionId) as Connection | undefined;
  if (record === undefined || record.orgId !== orgId || record.type !== type || record.hasSecret !== true) throw new IntakeSearchError("CONNECTION_MISSING");
  return record;
}

async function readCapped(response: Response): Promise<unknown> {
  if (response.status === 401 || response.status === 403) throw new IntakeSearchError("CONNECTION_REFUSED");
  if (response.status === 429) throw new IntakeSearchError("RATE_LIMITED");
  if (response.status < 200 || response.status >= 300) throw new IntakeSearchError("SEARCH_FAILED");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > RESPONSE_MAX_BYTES) throw new IntakeSearchError("SEARCH_FAILED");
  try { return JSON.parse(text); } catch { throw new IntakeSearchError("SEARCH_FAILED"); }
}

const rec = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const cut = (text: string, max: number): string => [...text].slice(0, max).join("");

/** The plain text of a Jira description (Atlassian Document Format): its text nodes, a line per block, cut. */
export function adfText(node: unknown, depth = 0): string {
  if (depth > 20) return "";
  const value = rec(node);
  if (value["type"] === "text" && typeof value["text"] === "string") return value["text"];
  const inner = arr(value["content"]).map((child) => adfText(child, depth + 1)).join("");
  return value["type"] === "paragraph" || value["type"] === "heading" || value["type"] === "listItem" ? `${inner}\n` : inner;
}

/** Jira's change-log field for the new value (read by a variable key: the literal would read as Object's own method). */
const TO_STRING: string = "toString";
const JIRA_LABEL = /^[^"\\\p{Cc}]{1,100}$/u;

/** The label words of a change's old or new text (Jira writes labels as words with spaces between). */
const labelWords = (text: unknown): string[] => (str(text) ?? "").split(" ").filter((word) => word !== "");

/**
 * Who made the act, from a COMPLETE Jira change log: the change that LAST touched the label (or the assignee), whatever order the answer came in (changes are ordered by their own time). It is credited
 * only when that last change put the label on, or set the assignee to `act.value` (or to Rovara's own account `me`, for a source watching assignment): a later removal, a tie, or a change whose time
 * cannot be read means the label that is on the issue now was put there by something not seen, so nobody is credited and the ticket waits for the owner. (A log not read to its end is not given here:
 * `jiraFullHistory` gives none, and the search then credits nobody.) Only an `atlassian` account is a person, the same as the webhook; an `app` is a bot; a service-desk `customer` or an account type
 * Jira does not say is nobody (no actor, so the ticket waits). Rovara's own account is `rovara`.
 */
export function jiraActorOf(histories: readonly unknown[], act: { kind: "label" | "assignee"; value: string } | undefined, me?: string): IntakeSearchItem["actor"] {
  return jiraActOf(histories, act, me).actor;
}

/** `jiraActorOf`, and with it the id of the change entry that made the act (the tracker's own id for it), when it names one. */
export function jiraActOf(histories: readonly unknown[], act: { kind: "label" | "assignee"; value: string } | undefined, me?: string): { actor?: IntakeSearchItem["actor"]; changeId?: string } {
  const touches: Array<{ at: number; add: boolean; entry: Record<string, unknown> }> = [];
  for (const raw of histories) {
    const entry = rec(raw);
    let touched = false;
    let add = false;
    for (const change of arr(entry["items"])) {
      const c = rec(change);
      if (act?.kind === "label" && c["field"] === "labels") {
        const before = labelWords(c["fromString"]).includes(act.value);
        const after = labelWords(c[TO_STRING]).includes(act.value);
        if (before === after) continue;
        touched = true;
        add = after;
      } else if (c["field"] === "assignee") {
        const target = act?.kind === "assignee" ? act.value : me;
        if (target === undefined || (c["to"] !== target && c["from"] !== target)) continue;
        touched = true;
        add = c["to"] === target;
      }
    }
    if (!touched) continue;
    const at = Date.parse(str(entry["created"]) ?? "");
    // A change whose time cannot be read cannot be put in order: nothing is proved.
    if (!Number.isFinite(at)) return {};
    touches.push({ at, add, entry });
  }
  if (touches.length === 0) return {};
  const latest = Math.max(...touches.map((touch) => touch.at));
  const last = touches.filter((touch) => touch.at === latest);
  // Two changes at the same moment, one of them not an add: nothing is proved.
  if (last.length !== 1 || !last[0]!.add) return {};
  const entry = last[0]!.entry;
  const author = rec(entry["author"]);
  const accountId = str(author["accountId"]);
  if (author["accountType"] === "app") return { actor: { kind: "bot" } };
  if (author["accountType"] !== "atlassian" || accountId === undefined) return {};
  const id = typeof entry["id"] === "string" || typeof entry["id"] === "number" ? String(entry["id"]) : undefined;
  return { actor: { kind: accountId === me ? "rovara" : "person", accountId }, ...(id === undefined ? {} : { changeId: id }) };
}

/** How far a change's own time may be from the event's time and still be that event's change. */
export const JIRA_CONFIRM_SKEW_MS = 5 * 60_000;
/** The most change-log pages (100 entries each) read to find the event's change. */
export const JIRA_CHANGELOG_PAGES_MAX = 10;

/**
 * The issue's whole change log, or undefined when it cannot be shown to be whole. The log that came with the search is used only when it says how many changes there are (`total`), starts at the first and holds
 * that many; any other answer is read again, a page at a time, from the change log's own address, until its last page (at most `JIRA_CHANGELOG_PAGES_MAX`). A refused key or a rate limit is the search's own
 * failure and is thrown; any other failed read, or a log longer than the pages allow, is undefined (nobody is credited).
 */
export async function jiraFullHistory(issue: Record<string, unknown>, key: string, get: (path: string) => Promise<unknown>): Promise<unknown[] | undefined> {
  const embedded = rec(issue["changelog"]);
  const histories = arr(embedded["histories"]);
  if (typeof embedded["total"] === "number" && embedded["startAt"] === 0 && histories.length >= embedded["total"]) return histories;
  const all: unknown[] = [];
  for (let page = 0, startAt = 0; page < JIRA_CHANGELOG_PAGES_MAX; page += 1) {
    let body: Record<string, unknown>;
    try { body = rec(await get(`/rest/api/3/issue/${encodeURIComponent(key)}/changelog?startAt=${String(startAt)}&maxResults=100`)); } catch (error) {
      if (error instanceof IntakeSearchError && (error.code === "CONNECTION_REFUSED" || error.code === "RATE_LIMITED")) throw error;
      return undefined;
    }
    const values = arr(body["values"]);
    all.push(...values);
    if (body["isLast"] === true) return all;
    if (values.length === 0) return undefined;
    startAt += values.length;
  }
  return undefined;
}

/**
 * Slice 5 review I1 and I1-R: the tracker's own word on who made a Jira webhook's act. A webhook body is signed only with the hook's secret, which the people who made the hook have seen, so its
 * `user` is not believed alone. Through the company's OWN Jira connection for the ticket's site, the confirmer checks, all of:
 *   - the event is inside the age window (`outsideEventWindow`), and its change id (the last part of the event's key) names a change in the issue's paginated change log (bounded pages);
 *   - that change made the act (added the label, or set that assignee), was made by that same `atlassian` account, and happened within `JIRA_CONFIRM_SKEW_MS` of the event's time;
 *   - the label is on the issue NOW (or the issue is assigned to that account now).
 * So a replay of an old, real label-add (a fresh timestamp on an old change) is `unverified`. No connection, a failed read or any mismatch: `unverified` (the ticket waits).
 */
export function jiraActorConfirmer(input: { deps: OrgConnectionDeps | undefined; fetch?: typeof fetch; now?: () => number }) {
  const fetchImpl = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  return async (candidate: Pick<IntakeCandidate, "orgId" | "externalRef" | "actor" | "act" | "eventId" | "occurredAt">): Promise<"person" | "rovara" | "unverified"> => {
    const accountId = candidate.actor?.accountId;
    const act = candidate.act;
    if (input.deps === undefined || candidate.actor?.kind !== "person" || accountId === undefined || act === undefined) return "unverified";
    const changeId = candidate.eventId?.split(":").at(-1);
    const eventAt = Date.parse(candidate.occurredAt ?? "");
    if (changeId === undefined || !/^[1-9][0-9]{0,18}$/u.test(changeId) || !Number.isFinite(eventAt) || outsideEventWindow(new Date(eventAt).toISOString(), now()) !== undefined) return "unverified";
    let site: string;
    try { const url = new URL(candidate.externalRef.url); if (url.protocol !== "https:" || !/\.atlassian\.net$/u.test(url.hostname)) return "unverified"; site = `https://${url.hostname}`; } catch { return "unverified"; }
    const key = candidate.externalRef.id;
    if (!/^[A-Z][A-Z0-9_]{0,30}-[1-9][0-9]{0,9}$/u.test(key)) return "unverified";
    try {
      const connections = (await new OrgConnectionStore({ ...input.deps }).list(candidate.orgId)).filter((entry) => entry.type === "jira" && entry.hasSecret === true);
      for (const entry of connections) {
        const record = await readConnection(input.deps, candidate.orgId, entry.connectionId) as Connection | undefined;
        if (record === undefined || record.orgId !== candidate.orgId || (record as { siteUrl?: string }).siteUrl !== site) continue;
        const secret = await readConnectionSecret(input.deps, candidate.orgId, record).catch(() => undefined);
        if (secret === undefined || !("apiToken" in secret) || !("email" in secret)) continue;
        const get = async (path: string): Promise<Record<string, unknown>> => rec(await readCapped(await fetchImpl(`${site}${path}`, {
          headers: { authorization: `Basic ${Buffer.from(`${secret.email}:${secret.apiToken}`).toString("base64")}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000),
        })));
        const issue = encodeURIComponent(key);
        // The event's own change, from the paginated change log (bounded).
        let change: Record<string, unknown> | undefined;
        for (let page = 0, startAt = 0; page < JIRA_CHANGELOG_PAGES_MAX && change === undefined; page += 1) {
          const answer = await get(`/rest/api/3/issue/${issue}/changelog?startAt=${String(startAt)}&maxResults=100`);
          const values = arr(answer["values"]).map(rec);
          change = values.find((value) => (typeof value["id"] === "string" || typeof value["id"] === "number" ? String(value["id"]) : "") === changeId);
          if (answer["isLast"] === true || values.length === 0) break;
          startAt += values.length;
        }
        if (change === undefined) return "unverified";
        const actor = jiraActorOf([change], act);
        const createdAt = Date.parse(str(change["created"]) ?? "");
        if (actor?.kind !== "person" || actor.accountId !== accountId || !Number.isFinite(createdAt) || Math.abs(createdAt - eventAt) > JIRA_CONFIRM_SKEW_MS) return "unverified";
        // The act still stands now: the label is on the issue, or the issue is assigned to that account.
        const fields = rec((await get(`/rest/api/3/issue/${issue}?fields=labels,assignee`))["fields"]);
        const stands = act.kind === "label" ? arr(fields["labels"]).includes(act.value) : str(rec(fields["assignee"])["accountId"]) === act.value;
        return stands ? "person" : "unverified";
      }
      return "unverified";
    } catch {
      return "unverified";
    }
  };
}

/** The Jira search: open issues with the label (or assigned to the connection's own account), with the change log that says who did it. */
export function jiraIntakeSearch(input: { deps: OrgConnectionDeps; fetch?: typeof fetch }): IntakeSearch {
  const fetchImpl = input.fetch ?? fetch;
  return async ({ orgId, source, signal, limit }) => {
    const connection = await connectionForSource(input.deps, orgId, "jira", source.ref.connection);
    const site = (connection as { siteUrl?: string }).siteUrl;
    const secret = await readConnectionSecret(input.deps, orgId, connection).catch(() => undefined);
    if (site === undefined || secret === undefined || !("apiToken" in secret) || !("email" in secret)) throw new IntakeSearchError("CONNECTION_MISSING");
    const headers = { authorization: `Basic ${Buffer.from(`${secret.email}:${secret.apiToken}`).toString("base64")}`, accept: "application/json" };
    const get = async (path: string): Promise<unknown> => readCapped(await fetchImpl(`${site}${path}`, { headers, redirect: "error", signal }));
    const label = source.ref.when.label;
    let me: string | undefined;
    const clauses: string[] = [];
    if (label !== undefined) {
      if (!JIRA_LABEL.test(label)) throw new IntakeSearchError("SEARCH_FAILED");
      clauses.push(`labels = "${label}"`);
    }
    if (source.ref.when.assignedToRovara === true) {
      me = str(rec(await get("/rest/api/3/myself"))["accountId"]);
      clauses.push("assignee = currentUser()");
    }
    const jql = `(${clauses.join(" OR ")}) AND statusCategory != Done ORDER BY updated DESC`;
    const query = new URLSearchParams({ jql, maxResults: String(Math.min(limit, 50)), fields: "summary,description,labels,assignee,reporter", expand: "changelog" });
    const answer = rec(await get(`/rest/api/3/search/jql?${query.toString()}`));
    const items: IntakeSearchItem[] = [];
    for (const raw of arr(answer["issues"]).slice(0, limit)) {
      const issue = rec(raw);
      const key = str(issue["key"]);
      const fields = rec(issue["fields"]);
      if (key === undefined || !/^[A-Z][A-Z0-9_]{0,30}-[1-9][0-9]{0,9}$/u.test(key)) continue;
      // Who did it: the change that LAST touched the label (or the assignment to Rovara's own account), from the whole change log; credited only when it is an add.
      const histories = await jiraFullHistory(issue, key, get);
      const found = histories === undefined ? {} : jiraActOf(histories, label === undefined ? undefined : { kind: "label", value: label }, me);
      const actor = found.actor;
      items.push({
        externalRef: { system: "jira", id: key, url: `${site}/browse/${key}` },
        title: cut(str(fields["summary"]) ?? key, INTAKE_TITLE_MAX),
        body: cut(adfText(fields["description"]), BODY_MAX_CHARS),
        reporter: { display: str(rec(fields["reporter"])["displayName"]) },
        ...(actor === undefined ? {} : { actor }),
        // The change that made the label-add, as Jira's own change log says: claimed once per company by the engine, so a project watching the same label does not start it a second time as the person.
        ...(label === undefined || found.changeId === undefined ? {} : { change: { id: found.changeId, act: { kind: "label" as const, value: label } } }),
        ...(str(issue["id"]) === undefined ? {} : { alternateIds: [str(issue["id"])!] }),
      });
    }
    return items;
  };
}

const LINEAR_HISTORY_FIELDS = "pageInfo { hasNextPage endCursor } nodes { createdAt actor { id } botActor { id } addedLabelIds removedLabelIds toAssigneeId fromAssigneeId }";
const LINEAR_QUERY = `query($filter: IssueFilter!, $first: Int!) { viewer { id } issues(first: $first, filter: $filter) { nodes { id identifier title description url creator { displayName }
 labels { nodes { id name } } history(first: 25) { ${LINEAR_HISTORY_FIELDS} } } } }`;
const LINEAR_HISTORY_PAGE_QUERY = `query($id: String!, $after: String) { issue(id: $id) { history(first: 100, after: $after) { ${LINEAR_HISTORY_FIELDS} } } }`;
/** The most further pages of one issue's history read to see all of it (100 entries each). An issue with more is not read to the end, so nobody is credited for it. */
export const LINEAR_HISTORY_PAGES_MAX = 5;

/**
 * Who made the act that asks, from an issue's WHOLE history: the entry that last changed the label (or the assignee), whatever order the answer came in (entries are ordered by their own `createdAt`).
 * It is credited only when that last change is an ADD of the label (or the assignment to Rovara's account): a later removal, a tie, or an entry whose time cannot be read means the label that is on the
 * issue now was put there by something not seen, so nobody is credited and the ticket waits for the owner. `hasMore` (the history was not read to its end) is the same.
 */
export function linearActOf(entries: readonly unknown[], hasMore: boolean, act: { labelIds: ReadonlySet<string>; assignedTo?: string | undefined }): { kind: "bot" } | { kind: "account"; accountId: string } | undefined {
  if (hasMore) return undefined;
  const touches: Array<{ at: number; add: boolean; entry: Record<string, unknown> }> = [];
  for (const raw of entries) {
    const entry = rec(raw);
    const added = arr(entry["addedLabelIds"]).some((id) => act.labelIds.has(str(id) ?? ""));
    const removed = arr(entry["removedLabelIds"]).some((id) => act.labelIds.has(str(id) ?? ""));
    const assigned = act.assignedTo !== undefined && entry["toAssigneeId"] === act.assignedTo;
    const unassigned = act.assignedTo !== undefined && entry["fromAssigneeId"] === act.assignedTo && entry["toAssigneeId"] !== act.assignedTo;
    if (!added && !removed && !assigned && !unassigned) continue;
    const at = Date.parse(str(entry["createdAt"]) ?? "");
    // A change whose time cannot be read cannot be put in order: nothing is proved.
    if (!Number.isFinite(at)) return undefined;
    touches.push({ at, add: (added || assigned) && !removed && !unassigned, entry });
  }
  if (touches.length === 0) return undefined;
  const latest = Math.max(...touches.map((touch) => touch.at));
  const last = touches.filter((touch) => touch.at === latest);
  // Two changes at the same moment, one of them not an add: nothing is proved.
  if (last.length !== 1 || !last[0]!.add) return undefined;
  const entry = last[0]!.entry;
  if (str(rec(entry["botActor"])["id"]) !== undefined) return { kind: "bot" };
  const accountId = str(rec(entry["actor"])["id"]);
  return accountId === undefined ? undefined : { kind: "account", accountId };
}

/** The Linear search: open issues with the label (or assigned to the connection's own account), with the history that says who did it. */
export function linearIntakeSearch(input: { deps: OrgConnectionDeps; fetch?: typeof fetch }): IntakeSearch {
  const fetchImpl = input.fetch ?? fetch;
  return async ({ orgId, source, signal, limit }) => {
    const connection = await connectionForSource(input.deps, orgId, "linear", source.ref.connection);
    const secret = await readConnectionSecret(input.deps, orgId, connection).catch(() => undefined);
    if (secret === undefined || !("apiKey" in secret)) throw new IntakeSearchError("CONNECTION_MISSING");
    const label = source.ref.when.label;
    const open = { state: { type: { nin: ["completed", "canceled"] } } };
    const asks: unknown[] = [];
    if (label !== undefined) asks.push({ labels: { name: { eqIgnoreCase: label } } });
    if (source.ref.when.assignedToRovara === true && connection.actorId !== undefined) asks.push({ assignee: { id: { eq: connection.actorId } } });
    if (asks.length === 0) return [];
    const call = async (query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const response = await fetchImpl(LINEAR_GRAPHQL, { method: "POST", headers: { authorization: secret.apiKey, "content-type": "application/json" }, redirect: "error", signal, body: JSON.stringify({ query, variables }) });
      const envelope = rec(await readCapped(response));
      if (arr(envelope["errors"]).some((entry) => rec(rec(entry)["extensions"])["code"] === "RATELIMITED")) throw new IntakeSearchError("RATE_LIMITED");
      if (arr(envelope["errors"]).length > 0) throw new IntakeSearchError("SEARCH_FAILED");
      return rec(envelope["data"]);
    };
    const data = await call(LINEAR_QUERY, { first: Math.min(limit, 50), filter: { ...open, or: asks } });
    const viewer = str(rec(data["viewer"])["id"]);
    const items: IntakeSearchItem[] = [];
    for (const raw of arr(rec(data["issues"])["nodes"]).slice(0, limit)) {
      const issue = rec(raw);
      const identifier = str(issue["identifier"]);
      const url = str(issue["url"]);
      if (identifier === undefined || url === undefined || !/^[A-Za-z][A-Za-z0-9]{0,9}-[1-9][0-9]{0,8}$/u.test(identifier)) continue;
      const labelIds = new Set(arr(rec(issue["labels"])["nodes"]).filter((node) => label !== undefined && str(rec(node)["name"])?.toLowerCase() === label.toLowerCase()).flatMap((node) => str(rec(node)["id"]) ?? []));
      // Who did it: the entry that LAST changed the label (or the assignment), from the issue's whole history (further pages are read, up to a cap). A history cut short, a newer removal or a tie credits nobody.
      let entries = arr(rec(issue["history"])["nodes"]);
      let more = rec(rec(issue["history"])["pageInfo"])["hasNextPage"] !== false;
      let after = str(rec(rec(issue["history"])["pageInfo"])["endCursor"]);
      for (let page = 0; more && page < LINEAR_HISTORY_PAGES_MAX; page += 1) {
        let history: Record<string, unknown>;
        try { history = rec(rec((await call(LINEAR_HISTORY_PAGE_QUERY, { id: str(issue["id"]) ?? identifier, after: after ?? null }))["issue"])["history"]); } catch (error) {
          if (error instanceof IntakeSearchError && (error.code === "CONNECTION_REFUSED" || error.code === "RATE_LIMITED")) throw error;
          break;
        }
        // An answer with no `hasNextPage: false` is not the end of the history.
        if (rec(history["pageInfo"])["hasNextPage"] === undefined) break;
        entries = [...entries, ...arr(history["nodes"])];
        more = rec(history["pageInfo"])["hasNextPage"] === true;
        after = str(rec(history["pageInfo"])["endCursor"]);
      }
      const found = linearActOf(entries, more, { labelIds, ...(source.ref.when.assignedToRovara === true && viewer !== undefined ? { assignedTo: viewer } : {}) });
      const actor: IntakeSearchItem["actor"] = found === undefined ? undefined : found.kind === "bot" ? { kind: "bot" } : { kind: found.accountId === viewer ? "rovara" : "person", accountId: found.accountId };
      items.push({
        externalRef: { system: "linear", id: identifier, url },
        title: cut(str(issue["title"]) ?? identifier, INTAKE_TITLE_MAX),
        body: cut(str(issue["description"]) ?? "", BODY_MAX_CHARS),
        reporter: { display: str(rec(issue["creator"])["displayName"]) },
        ...(actor === undefined ? {} : { actor }),
      });
    }
    return items;
  };
}

/** The search of a system: Jira and Linear through the company's connections, then anything an adapter registered (`registerIntakeSearch`). */
export function intakeSearchesOf(input: { deps: OrgConnectionDeps | undefined; fetch?: typeof fetch }): (system: string) => IntakeSearch | undefined {
  const built: Record<string, IntakeSearch> = input.deps === undefined ? {} : {
    jira: jiraIntakeSearch({ deps: input.deps, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) }),
    linear: linearIntakeSearch({ deps: input.deps, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) }),
  };
  return (system) => (Object.hasOwn(built, system) ? built[system] : intakeSearchFor(system));
}
