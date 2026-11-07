// Slice 5 "Outside tools": the searches of the watched (polled) intake sources for Jira and Linear, so a source a maintainer adds is read and never fails silently. Each reads through the company's
// OWN connection (`connections/store.ts`): the one the source names (by id or label), or the only connection of that tracker; none, or several with none named, is a failure with a fixed code the
// maintainer is shown. The key goes only to the tracker's own address (the connection's Atlassian site, Linear's fixed GraphQL address), no redirect is followed and an answer is read to a cap.
//
// Who asked: the tracker's own history says who put the label on (or assigned the ticket to Rovara's account). That account id is the act's actor; the intake engine then decides, through the
// company's links, whether it is a member who may start. A ticket whose history does not say is handed over with no actor, so it waits (fail closed). Nothing else from the ticket is trusted.
import { INTAKE_TITLE_MAX, type OrgId } from "@agentx/contracts";
import { LINEAR_GRAPHQL, OrgConnectionStore, readConnection, readConnectionSecret, type OrgConnectionDeps, type OrgConnectionRecord } from "../connections/store.js";
import { IntakeSearchError, intakeSearchFor, type IntakeSearch, type IntakeSearchItem } from "./poll-intake.js";

const RESPONSE_MAX_BYTES = 2_000_000;
const BODY_MAX_CHARS = 8_000;

type Connection = OrgConnectionRecord & { actorId?: string; secretVersion?: string };

/** The connection a source reads through: the one it names (id or label), else the only one of its type that holds a key. */
export async function connectionForSource(deps: OrgConnectionDeps, orgId: OrgId, type: "jira" | "linear", named: string | undefined): Promise<Connection> {
  const listed = (await new OrgConnectionStore({ ...deps }).list(orgId)).filter((entry) => entry.type === type && entry.hasSecret === true);
  const chosen = named === undefined ? listed : listed.filter((entry) => entry.connectionId === named || entry.label === named);
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
      // Who did it: the newest change that ADDED the label, or that assigned the issue to Rovara's own account.
      let actor: IntakeSearchItem["actor"];
      for (const history of [...arr(rec(issue["changelog"])["histories"])].reverse()) {
        const entry = rec(history);
        const author = rec(entry["author"]);
        const asked = arr(entry["items"]).some((change) => {
          const c = rec(change);
          if (label !== undefined && c["field"] === "labels") return ` ${str(c[TO_STRING]) ?? ""} `.includes(` ${label} `) && !` ${str(c["fromString"]) ?? ""} `.includes(` ${label} `);
          return me !== undefined && c["field"] === "assignee" && c["to"] === me;
        });
        if (!asked) continue;
        const accountId = str(author["accountId"]);
        actor = author["accountType"] === "app" ? { kind: "bot" } : accountId === undefined ? undefined : { kind: accountId === me ? "rovara" : "person", accountId };
        break;
      }
      items.push({
        externalRef: { system: "jira", id: key, url: `${site}/browse/${key}` },
        title: cut(str(fields["summary"]) ?? key, INTAKE_TITLE_MAX),
        body: cut(adfText(fields["description"]), BODY_MAX_CHARS),
        reporter: { display: str(rec(fields["reporter"])["displayName"]) },
        ...(actor === undefined ? {} : { actor }),
        ...(str(issue["id"]) === undefined ? {} : { alternateIds: [str(issue["id"])!] }),
      });
    }
    return items;
  };
}

const LINEAR_QUERY = `query($filter: IssueFilter!, $first: Int!) { viewer { id } issues(first: $first, filter: $filter) { nodes { id identifier title description url creator { displayName }
 labels { nodes { id name } } history(first: 25) { nodes { actor { id } botActor { id } addedLabelIds toAssigneeId } } } } }`;

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
    const response = await fetchImpl(LINEAR_GRAPHQL, {
      method: "POST", headers: { authorization: secret.apiKey, "content-type": "application/json" }, redirect: "error", signal,
      body: JSON.stringify({ query: LINEAR_QUERY, variables: { first: Math.min(limit, 50), filter: { ...open, or: asks } } }),
    });
    const envelope = rec(await readCapped(response));
    if (arr(envelope["errors"]).some((entry) => rec(rec(entry)["extensions"])["code"] === "RATELIMITED")) throw new IntakeSearchError("RATE_LIMITED");
    if (arr(envelope["errors"]).length > 0) throw new IntakeSearchError("SEARCH_FAILED");
    const data = rec(envelope["data"]);
    const viewer = str(rec(data["viewer"])["id"]);
    const items: IntakeSearchItem[] = [];
    for (const raw of arr(rec(data["issues"])["nodes"]).slice(0, limit)) {
      const issue = rec(raw);
      const identifier = str(issue["identifier"]);
      const url = str(issue["url"]);
      if (identifier === undefined || url === undefined || !/^[A-Za-z][A-Za-z0-9]{0,9}-[1-9][0-9]{0,8}$/u.test(identifier)) continue;
      const labelIds = new Set(arr(rec(issue["labels"])["nodes"]).filter((node) => label !== undefined && str(rec(node)["name"])?.toLowerCase() === label.toLowerCase()).map((node) => str(rec(node)["id"])));
      // Linear lists history newest first: the first entry that added the label (or assigned the issue to Rovara's account) says who did it.
      let actor: IntakeSearchItem["actor"];
      for (const node of arr(rec(issue["history"])["nodes"])) {
        const entry = rec(node);
        const asked = arr(entry["addedLabelIds"]).some((id) => labelIds.has(str(id))) || (viewer !== undefined && entry["toAssigneeId"] === viewer && source.ref.when.assignedToRovara === true);
        if (!asked) continue;
        const accountId = str(rec(entry["actor"])["id"]);
        actor = str(rec(entry["botActor"])["id"]) !== undefined ? { kind: "bot" } : accountId === undefined ? undefined : { kind: accountId === viewer ? "rovara" : "person", accountId };
        break;
      }
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
