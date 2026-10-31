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
import { UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, intakeItemIdOf, intakeOwnWriteKey, type IntakeOwnWriteKind, type OrgId } from "@agentx/contracts";
import type { IntakeTable } from "./store.js";

/** An event may carry a time a little before the write that caused it (the vendor's clock, not ours). */
export const OWN_WRITE_SKEW_MS = 60_000;
/** How long after Rovara's write an event for that label or assignee is taken for its echo. Long enough for a vendor's retries; the note is not used up. */
export const OWN_WRITE_LABEL_WINDOW_MS = 6 * 60 * 60_000;
/** How long after Rovara's change to a ticket a label or assignment on it is not taken for a member's act. */
export const OWN_WRITE_TOUCH_WINDOW_MS = 10 * 60_000;
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
}

const ticketItemId = (system: string, ticket: string): string => intakeItemIdOf(system, ticket.normalize("NFC").trim().toLowerCase());
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

/** Notes what Rovara is about to write. Throws when it can't (the write must not be made then). */
export async function noteOwnWrite(table: IntakeTable, orgId: OrgId, note: OwnWriteNote): Promise<void> {
  const labels = clean(note.labels);
  const assignees = clean(note.assignees);
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
  externalRef: { system: string; id: string };
  act?: { kind: "label" | "assignee"; value: string } | undefined;
  occurredAt?: string | undefined;
}

async function readNote(table: IntakeTable, orgId: OrgId, itemId: string, kind: IntakeOwnWriteKind, value: string): Promise<{ first: number; last: number } | undefined> {
  const found = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: intakeOwnWriteKey(orgId, itemId, kind, value), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = found.Item;
  if (item === undefined || item["entityType"] !== "INTAKE_OWN_WRITE" || item["orgId"] !== orgId) return undefined;
  const first = item["firstAtMs"];
  const last = item["lastAtMs"];
  return typeof first === "number" && typeof last === "number" && Number.isFinite(first) && Number.isFinite(last) ? { first, last } : undefined;
}

const covers = (note: { first: number; last: number }, at: number, window: number): boolean => at >= note.first - OWN_WRITE_SKEW_MS && at <= note.last + window;

/**
 * Whether an event on a ticket is the echo of something Rovara wrote (`own`), happened right after Rovara changed the ticket some other way (`touched`: not told apart), or neither.
 * A read that fails throws: nothing is decided on a guess, and the delivery is made again.
 */
export async function ownWriteVerdictOf(table: IntakeTable, question: OwnWriteQuestion): Promise<OwnWriteVerdict> {
  const { orgId, externalRef, act } = question;
  const parsed = question.occurredAt === undefined ? Number.NaN : Date.parse(question.occurredAt);
  const at = Number.isFinite(parsed) ? parsed : table.now();
  const ticket = ticketItemId(externalRef.system, externalRef.id);
  const scope = scopeOfTicket(externalRef.id);
  const scopeId = scope === undefined ? undefined : scopeItemId(externalRef.system, scope);
  if (act !== undefined && act.value.trim() !== "") {
    for (const itemId of scopeId === undefined ? [ticket] : [ticket, scopeId]) {
      const note = await readNote(table, orgId, itemId, act.kind, act.value);
      if (note !== undefined && covers(note, at, OWN_WRITE_LABEL_WINDOW_MS)) return "own";
    }
  }
  const touch = await readNote(table, orgId, ticket, "touch", "");
  return touch !== undefined && covers(touch, at, OWN_WRITE_TOUCH_WINDOW_MS) ? "touched" : "none";
}

// ---- reading a connector call

export interface OwnWriteCall {
  tool: string;
  args: Record<string, unknown>;
}
export type OwnWriteExtractor = (call: OwnWriteCall) => OwnWriteNote | undefined;

const READ_TOOL = /^(get|list|search|read|fetch|find|lookup|query|describe|view)/iu;
const WRITE_TOOL = /(create|update|edit|add|set|assign|label|transition|write|save|comment|delete|remove|close|reopen|move|merge)/iu;
/** A tool that changes something: not named for a read, and named for a change. */
const isWriteTool = (tool: string): boolean => !READ_TOOL.test(tool) && WRITE_TOOL.test(tool);

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
  if (owner === undefined || repo === undefined) return undefined;
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
  if (ticket === undefined) return undefined;
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
  if (ticket === undefined) return undefined;
  const labels = [...namesOf(own(args, "labels")), ...namesOf(own(args, "addLabels"))];
  const assignees = namesOf(own(args, "assignee") === undefined ? [] : [own(args, "assignee")]);
  return { system: "linear", ticket, touch: true, ...(labels.length === 0 ? {} : { labels }), ...(assignees.length === 0 ? {} : { assignees }) };
}

const extractors = new Map<string, OwnWriteExtractor>([["github", githubNote], ["jira", jiraNote], ["linear", linearNote]]);

/** Registers (or replaces) how a connector type's tool calls are read for what they write. A tracker plug-in registers its own. */
export function registerOwnWriteExtractor(connectorType: string, extractor: OwnWriteExtractor): void {
  extractors.set(connectorType, extractor);
}
/** Removes a registered reader (for tests); the built-in ones stay. */
export function unregisterOwnWriteExtractor(connectorType: string): void {
  if (connectorType !== "github" && connectorType !== "jira" && connectorType !== "linear") extractors.delete(connectorType);
}

/** What a connector call writes, or undefined for a call that changes nothing Rovara can tell (a read, an unknown connector type). */
export function ownWriteNoteOf(connectorType: string, tool: string, args: Record<string, unknown>): OwnWriteNote | undefined {
  const extractor = extractors.get(connectorType);
  if (extractor === undefined || !isRecord(args)) return undefined;
  const note = extractor({ tool, args });
  if (note === undefined) return undefined;
  const hasTarget = (note.ticket !== undefined && note.ticket !== "") || (note.scope !== undefined && note.scope !== "");
  return hasTarget ? note : undefined;
}

// ---- the call path

/** Writes the note for a call about to be made. The broker registers it over its own table; until it does, calls are not noted. */
export type OwnWriteRecorder = (orgId: OrgId, note: OwnWriteNote) => Promise<void>;
let recorder: OwnWriteRecorder | undefined;
export function registerOwnWriteRecorder(next: OwnWriteRecorder | undefined): void {
  recorder = next;
}

/** Called by the connector call path before a call is sent. A call that writes nothing Rovara can tell does nothing. A note that can't be written throws, and the call is not sent. */
export async function recordOwnWriteOfCall(input: { orgId: OrgId; connectorType: string; tool: string; args: Record<string, unknown> }): Promise<void> {
  if (recorder === undefined) return;
  const note = ownWriteNoteOf(input.connectorType, input.tool, input.args);
  if (note !== undefined) await recorder(input.orgId, note);
}
