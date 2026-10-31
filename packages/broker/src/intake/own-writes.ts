// Wire lane D (MF-4): telling what Rovara itself wrote to a ticket from what a member did.
//
// The intake loop guard used to trust the event's actor. But Rovara writes through connections, and a connection made with a member's own key (or an app acting as that member) comes back from the
// tracker as that member: a label Rovara put on a ticket would count as the member's act and start work, over and over. So Rovara keeps a note of what it writes, BEFORE it sends it (so that the
// tracker's event can't arrive first):
//   - `label` / `assignee` notes: this value on this ticket. An event for that label or assignee, from the time of the write on, is Rovara's own (`own`) and starts nothing.
//   - a `touch` note: Rovara changed the ticket in some way (a comment, a status change, a change we can't read). An event on that ticket shortly after is not told apart: it is not taken for a
//     member's act (`touched`), so it waits for a member to say "Start".
// A note is never used up: a vendor that delivers the same event twice gets the same answer twice. A note is keyed by org, so one org's writes never mark another's tickets.
//
// What a tool call writes is read by an extractor per connector type (`registerOwnWriteExtractor`): the built-in ones know GitHub, Jira and Linear, and a tracker plug-in registers its own.
// The call path (`callConnector`) asks `recordOwnWriteOfCall`; a note that cannot be written stops the call (fail closed).
import { DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, intakeItemIdOf, intakeOwnWriteKey, type IntakeOwnWriteKind, type OrgId } from "@agentx/contracts";
import type { IntakeTable } from "./store.js";

/** An event may carry a time a little before the write that caused it (the vendor's clock, not ours). */
export const OWN_WRITE_SKEW_MS = 60_000;
/** How long after Rovara's write an event for that label or assignee is taken for its echo. Long enough for a vendor's retries; the note is not used up. */
export const OWN_WRITE_LABEL_WINDOW_MS = 6 * 60 * 60_000;
/** How long after Rovara's change to a ticket a label or assignment on it is not taken for a member's act. */
export const OWN_WRITE_TOUCH_WINDOW_MS = 10 * 60_000;
/** The longest repeated wide notes can keep one hold going: this long after the first, the hold ends even if writes continue (a quiet gap of one window starts a new one). */
export const OWN_WRITE_WIDE_CAP_MS = 60 * 60_000;
const VALUES_MAX = 50;
const VALUE_MAX = 200;

/** What one write of Rovara's changed. `ticket` is the ticket's id as its tracker's events spell it (any case); `scope` names where a NEW ticket was made (a repository). */
export interface OwnWriteNote {
  system: string;
  ticket?: string | undefined;
  scope?: string | undefined;
  labels?: string[] | undefined;
  assignees?: string[] | undefined;
  /** Some change was made to the ticket (even if its labels and assignee are not known). */
  touch?: boolean | undefined;
  /**
   * A change that cannot be tied to one ticket (a write with no ticket id, or through a connector type nobody can read): every label or assignment in `system` (or in every system, when `system` is
   * `*`) shortly after it is not taken for a member's act.
   */
  wide?: true | undefined;
  /** With `wide`: the project the write came from. Only that project's events are held; absent (a write from nowhere in particular) holds the org. */
  project?: string | undefined;
}

const ticketItemId = (system: string, ticket: string): string => intakeItemIdOf(system, ticket.normalize("NFC").trim().toLowerCase());
const wideItemId = (system: string, project: string | undefined): string => intakeItemIdOf(system, `*wide*${project ?? "*"}`);
const scopeItemId = (system: string, scope: string): string => intakeItemIdOf(system, `scope:${scope.normalize("NFC").trim().toLowerCase()}`);
/** The scope a ticket id is in, when its id says (`owner/repo/7` is in `owner/repo`). */
const scopeOfTicket = (ticket: string): string | undefined => (ticket.includes("/") ? ticket.slice(0, ticket.lastIndexOf("/")) : undefined);
const clean = (values: readonly string[] | undefined): string[] => [...new Set((values ?? []).map((value) => value.normalize("NFC").trim()).filter((value) => value !== "" && value.length <= VALUE_MAX))].slice(0, VALUES_MAX);

async function putNote(table: IntakeTable, orgId: OrgId, itemId: string, kind: IntakeOwnWriteKind, value: string, window: number): Promise<void> {
  const now = table.now();
  await table.documentClient.send(new UpdateCommand({
    TableName: table.tableName,
    Key: intakeOwnWriteKey(orgId, itemId, kind, value),
    UpdateExpression: "SET #type = :type, #org = :org, #first = if_not_exists(#first, :now), #last = :now, #expires = :expires",
    ExpressionAttributeNames: { "#type": "entityType", "#org": "orgId", "#first": "firstAtMs", "#last": "lastAtMs", "#expires": INDEX_EXPIRY_ATTRIBUTE },
    ExpressionAttributeValues: { ":type": "INTAKE_OWN_WRITE", ":org": orgId, ":now": now, ":expires": Math.floor((now + window) / 1000) + 3600 },
  }));
}

/**
 * A wide note: held for the project the write came from, one window after the last write, but never past `OWN_WRITE_WIDE_CAP_MS` after the first (writes that keep coming do not keep a
 * project waiting for ever). Past the cap a write does not extend the hold (and says so in the log); after a quiet gap of one window the next write starts a new hold.
 */
async function putWideNote(table: IntakeTable, orgId: OrgId, note: OwnWriteNote, log?: (event: string, fields: Record<string, unknown>) => void): Promise<void> {
  const itemId = wideItemId(note.system, note.project);
  const now = table.now();
  const existing = await readNote(table, orgId, itemId, "touch", "");
  if (existing !== undefined && now >= existing.first + OWN_WRITE_WIDE_CAP_MS) {
    if (Math.max(existing.last, existing.seen ?? 0) + OWN_WRITE_TOUCH_WINDOW_MS > now) {
      // Writes keep coming: the hold is not extended (it ends at the cap), but the write is seen, so the project is not held afresh until they stop for a window.
      log?.("intake.own_write_wide_cap", { orgId, system: note.system, ...(note.project === undefined ? {} : { project: note.project }) });
      await table.documentClient.send(new UpdateCommand({ TableName: table.tableName, Key: intakeOwnWriteKey(orgId, itemId, "touch", ""), UpdateExpression: "SET #seen = :now", ExpressionAttributeNames: { "#seen": "seenAtMs" }, ExpressionAttributeValues: { ":now": now } }));
      return;
    }
    // The hold has lapsed and writes begin again: a fresh hold.
    await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: intakeOwnWriteKey(orgId, itemId, "touch", "") }));
  }
  await putNote(table, orgId, itemId, "touch", "", OWN_WRITE_TOUCH_WINDOW_MS + OWN_WRITE_WIDE_CAP_MS);
}

/** Notes what Rovara is about to write. Throws when it can't (the write must not be made then). */
export async function noteOwnWrite(table: IntakeTable, orgId: OrgId, note: OwnWriteNote, log?: (event: string, fields: Record<string, unknown>) => void): Promise<void> {
  const labels = clean(note.labels);
  const assignees = clean(note.assignees);
  if (note.wide === true) await putWideNote(table, orgId, note, log);
  const ids: string[] = [];
  if (note.ticket !== undefined && note.ticket.trim() !== "") ids.push(ticketItemId(note.system, note.ticket));
  else if (note.scope !== undefined && note.scope.trim() !== "") ids.push(scopeItemId(note.system, note.scope));
  for (const itemId of ids) {
    for (const label of labels) await putNote(table, orgId, itemId, "label", label, OWN_WRITE_LABEL_WINDOW_MS);
    for (const assignee of assignees) await putNote(table, orgId, itemId, "assignee", assignee, OWN_WRITE_LABEL_WINDOW_MS);
  }
  // A change to a known ticket is a touch of it. (A new ticket has no events to confuse yet but its own labels, noted above for its scope.)
  if (note.touch === true && note.ticket !== undefined && note.ticket.trim() !== "") await putNote(table, orgId, ticketItemId(note.system, note.ticket), "touch", "", OWN_WRITE_TOUCH_WINDOW_MS);
}

export type OwnWriteVerdict = "own" | "touched" | "none";

/** What an event is, as intake sees it: the ticket, and the label or assignee the act is about. */
export interface OwnWriteQuestion {
  orgId: OrgId;
  /** The project the event is for: a wide note holds only its own project. */
  project?: string | undefined;
  externalRef: { system: string; id: string };
  /** Other spellings of the same ticket (a Jira issue has a key and a numeric id): a note under any of them is the ticket's. */
  alternateIds?: readonly string[] | undefined;
  act?: { kind: "label" | "assignee"; value: string } | undefined;
  occurredAt?: string | undefined;
}

async function readNote(table: IntakeTable, orgId: OrgId, itemId: string, kind: IntakeOwnWriteKind, value: string): Promise<{ first: number; last: number; seen?: number } | undefined> {
  const found = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: intakeOwnWriteKey(orgId, itemId, kind, value), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = found.Item;
  if (item === undefined || item["entityType"] !== "INTAKE_OWN_WRITE" || item["orgId"] !== orgId) return undefined;
  const first = item["firstAtMs"];
  const last = item["lastAtMs"];
  const seen = item["seenAtMs"];
  return typeof first === "number" && typeof last === "number" && Number.isFinite(first) && Number.isFinite(last) ? { first, last, ...(typeof seen === "number" && Number.isFinite(seen) ? { seen } : {}) } : undefined;
}

/** How long after Rovara's write an event may be RECEIVED and still be taken for its echo, whatever time the vendor stamped on it (a vendor clock behind ours). */
export const OWN_WRITE_DELIVERY_LAG_MS = 5 * 60_000;

/**
 * Whether an event belongs to a note: the time the vendor stamped on it falls in the note's window, or the time WE received it does (within the delivery lag of the note's last write), so a vendor
 * clock running behind ours cannot turn Rovara's echo into a member's act.
 */
const covers = (note: { first: number; last: number }, stamped: number, received: number, window: number): boolean =>
  (stamped >= note.first - OWN_WRITE_SKEW_MS && stamped <= note.last + window) || (received >= note.first && received <= note.last + Math.min(window, OWN_WRITE_DELIVERY_LAG_MS));

/**
 * Whether an event on a ticket is the echo of something Rovara wrote (`own`), happened right after Rovara changed the ticket, its repository or the tracker some other way (`touched`: not told
 * apart, so it waits for a member), or neither. Only a note on the TICKET ITSELF gives `own`: a note for a whole repository (a ticket Rovara was about to make) can only give `touched`, because it
 * cannot say which ticket the label was for, and a member's label on another issue must not be lost. A read that fails throws: nothing is decided on a guess, and the delivery is made again.
 */
export async function ownWriteVerdictOf(table: IntakeTable, question: OwnWriteQuestion): Promise<OwnWriteVerdict> {
  const { orgId, externalRef, act } = question;
  const parsed = question.occurredAt === undefined ? Number.NaN : Date.parse(question.occurredAt);
  const received = table.now();
  const stamped = Number.isFinite(parsed) ? parsed : received;
  const forms = [...new Set([externalRef.id, ...(question.alternateIds ?? [])])];
  let touched = false;
  for (const form of forms) {
    const ticket = ticketItemId(externalRef.system, form);
    if (act !== undefined && act.value.trim() !== "") {
      const note = await readNote(table, orgId, ticket, act.kind, act.value);
      if (note !== undefined && covers(note, stamped, received, OWN_WRITE_LABEL_WINDOW_MS)) return "own";
      const scope = scopeOfTicket(form);
      if (scope !== undefined) {
        const wide = await readNote(table, orgId, scopeItemId(externalRef.system, scope), act.kind, act.value);
        if (wide !== undefined && covers(wide, stamped, received, OWN_WRITE_LABEL_WINDOW_MS)) touched = true;
      }
    }
    const touch = await readNote(table, orgId, ticket, "touch", "");
    if (touch !== undefined && covers(touch, stamped, received, OWN_WRITE_TOUCH_WINDOW_MS)) touched = true;
  }
  for (const system of new Set([externalRef.system, "*"])) {
    for (const project of new Set([question.project, undefined])) {
      const wide = await readNote(table, orgId, wideItemId(system, project), "touch", "");
      // The hold ends one window after the last write, and never later than the cap after the first.
      if (wide !== undefined && covers({ first: wide.first, last: Math.min(wide.last, wide.first + OWN_WRITE_WIDE_CAP_MS - OWN_WRITE_TOUCH_WINDOW_MS) }, stamped, received, OWN_WRITE_TOUCH_WINDOW_MS)) touched = true;
    }
  }
  return touched ? "touched" : "none";
}

// ---- reading a connector call

export interface OwnWriteCall {
  tool: string;
  args: Record<string, unknown>;
}
export type OwnWriteExtractor = (call: OwnWriteCall) => OwnWriteNote | undefined;

/** The verbs of a tool that only reads (`getJiraIssue`, `list_issues`, `search_issues`, `query_logs`): the verb, then the end of the name or a new word. Nothing else is taken for a read. */
const READ_TOOL = /^(?:[Gg]et|[Ll]ist|[Ss]earch|[Rr]ead|[Ff]etch|[Qq]uery)(?:$|[A-Z_.-])/u;
/** A tool that changes something: every tool that is not clearly named for a read (fail closed). */
const isWriteTool = (tool: string): boolean => !READ_TOOL.test(tool);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined);

/** Names in a list that may be strings, `{ name }`, `{ accountId }` or `{ add }` objects, or one comma-separated string. */
function namesOf(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value.slice(0, VALUES_MAX)) {
    if (typeof entry === "string") names.push(entry);
    else if (isRecord(entry)) {
      for (const key of ["name", "add", "accountId", "id", "login", "value"]) {
        const found = text(own(entry, key));
        if (found !== undefined) { names.push(found); break; }
      }
    }
  }
  return names;
}
const firstText = (record: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const found = text(own(record, key));
    if (found !== undefined) return found;
  }
  return undefined;
};

function githubNote(call: OwnWriteCall): OwnWriteNote | undefined {
  if (!isWriteTool(call.tool)) return undefined;
  const { args } = call;
  const owner = text(own(args, "owner"));
  const repo = text(own(args, "repo"));
  // A write that names no repository cannot be tied to a ticket: every GitHub label or assignment shortly after it waits for a member.
  if (owner === undefined || repo === undefined) return { system: "github", wide: true };
  const number = firstText(args, ["issue_number", "issueNumber", "number"]);
  const labels = [...namesOf(own(args, "labels")), ...namesOf(own(args, "label"))];
  const assignees = [...namesOf(own(args, "assignees")), ...namesOf(own(args, "assignee"))];
  const base: OwnWriteNote = number === undefined ? { system: "github", scope: `${owner}/${repo}`, touch: true } : { system: "github", ticket: `${owner}/${repo}/${number}`, touch: true };
  return { ...base, ...(labels.length === 0 ? {} : { labels }), ...(assignees.length === 0 ? {} : { assignees }) };
}

function jiraNote(call: OwnWriteCall): OwnWriteNote | undefined {
  if (!isWriteTool(call.tool)) return undefined;
  const { args } = call;
  const ticket = firstText(args, ["issueIdOrKey", "issueKey", "issue_key", "issue_id_or_key", "key"]);
  if (ticket === undefined) return { system: "jira", wide: true };
  const fields = isRecord(own(args, "fields")) ? (own(args, "fields") as Record<string, unknown>) : {};
  const update = isRecord(own(args, "update")) ? (own(args, "update") as Record<string, unknown>) : {};
  const labels = [...namesOf(own(args, "labels")), ...namesOf(own(fields, "labels")), ...namesOf(own(update, "labels"))];
  const assigneeField = own(fields, "assignee");
  const assignees = [
    ...(firstText(args, ["assignee_account_id", "assigneeAccountId", "accountId"]) === undefined ? [] : [firstText(args, ["assignee_account_id", "assigneeAccountId", "accountId"])!]),
    ...namesOf(assigneeField === undefined ? [] : [assigneeField]),
    ...namesOf(own(update, "assignee")),
  ];
  return { system: "jira", ticket, touch: true, ...(labels.length === 0 ? {} : { labels }), ...(assignees.length === 0 ? {} : { assignees }) };
}

function linearNote(call: OwnWriteCall): OwnWriteNote | undefined {
  if (!isWriteTool(call.tool)) return undefined;
  const { args } = call;
  const ticket = firstText(args, ["id", "identifier", "issueId", "issue_id"]);
  if (ticket === undefined) return { system: "linear", wide: true };
  const labels = [...namesOf(own(args, "labels")), ...namesOf(own(args, "addLabels"))];
  const assignees = namesOf(own(args, "assignee") === undefined ? [] : [own(args, "assignee")]);
  return { system: "linear", ticket, touch: true, ...(labels.length === 0 ? {} : { labels }), ...(assignees.length === 0 ? {} : { assignees }) };
}

/** Connector types that only read (the native connectors offer no write tool): a call through one writes nothing, whatever its tool is named. */
const readOnlyTypes = ["sentry", "datadog", "cloudwatch", "github-actions", "grafana", "vercel", "pagerduty"] as const;
const extractors = new Map<string, OwnWriteExtractor>([["github", githubNote], ["jira", jiraNote], ["linear", linearNote], ...readOnlyTypes.map((type) => [type, () => undefined] as const)]);

/** Registers (or replaces) how a connector type's tool calls are read for what they write. A tracker plug-in registers its own. */
export function registerOwnWriteExtractor(connectorType: string, extractor: OwnWriteExtractor): void {
  extractors.set(connectorType, extractor);
}
/** Removes a registered reader (for tests); the built-in ones stay. */
export function unregisterOwnWriteExtractor(connectorType: string): void {
  if (connectorType !== "github" && connectorType !== "jira" && connectorType !== "linear" && !(readOnlyTypes as readonly string[]).includes(connectorType)) extractors.delete(connectorType);
}

/**
 * What a connector call writes, or undefined for a read. Fails closed: a connector type with no reader (a generic MCP server that may be pointed at a tracker) that is used for anything but a read
 * makes a WIDE note, so that every label or assignment in the org shortly after it waits for a member (`unverified`) instead of being taken for a member's act. (A write cannot be refused
 * for want of a key: no tracker is named by a generic connector, so the note is org-wide.)
 */
export function ownWriteNoteOf(connectorType: string, tool: string, args: Record<string, unknown>): OwnWriteNote | undefined {
  const extractor = extractors.get(connectorType);
  if (extractor === undefined) return isWriteTool(tool) ? { system: "*", wide: true } : undefined;
  const note = extractor({ tool, args: isRecord(args) ? args : {} });
  if (note === undefined) return undefined;
  const hasTarget = note.wide === true || (note.ticket !== undefined && note.ticket !== "") || (note.scope !== undefined && note.scope !== "");
  return hasTarget ? note : { system: note.system, wide: true };
}

// ---- the call path

/** Writes the note for a call about to be made. The broker registers it over its own table; until it does, calls are not noted. */
export type OwnWriteRecorder = (orgId: OrgId, note: OwnWriteNote) => Promise<void>;
let recorder: OwnWriteRecorder | undefined;
export function registerOwnWriteRecorder(next: OwnWriteRecorder | undefined): void {
  recorder = next;
}

/**
 * Called by the connector call path before a call is sent. A read does nothing. A write is noted first; a note that can't be written throws, and so does a write when no recorder is
 * registered (fail closed: a deployment that cannot note its writes does not make them).
 */
export async function recordOwnWriteOfCall(input: { orgId: OrgId; project?: string | undefined; connectorType: string; tool: string; args: Record<string, unknown> }): Promise<void> {
  const made = ownWriteNoteOf(input.connectorType, input.tool, input.args);
  if (made === undefined) return;
  const note = made.wide === true && input.project !== undefined ? { ...made, project: input.project } : made;
  if (recorder === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "writes to trackers can't be recorded in this deployment, so this call was not made");
  await recorder(input.orgId, note);
}
