// Runtime per-company UI flags (lane U5, requirement P-52): the store, the install operator's override and the answers built from them.
//
// ONE ROW per company: `ORG#<org>` / `UI_FLAGS` (orgUiFlagsKey), a map of known flag names to on/off, the permission for device previews, and a `revision` that fences every write. Absent until the company first
// changes something: every flag is off and previews are not allowed. A flag name outside the closed list (contracts/ui-flags.ts) is never stored and never sent; a stored name that is no longer known is ignored when read.
//
// THE OPERATOR'S OVERRIDE is the install's stack parameter UiFlagsForceOff, packed broker setting `uo`, read as UI_FLAGS_FORCE_OFF (`all`, or names joined by `-`). It forces flags off for every company, wins over the
// company's switch and over previews, and fails closed on a value it cannot read (contracts `uiFlagsForcedOff`).
//
// A READ THAT FAILS gives every flag off with no preview (today's screens), never an error that takes the navigation down and never a screen left on by a guess.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  UI_FLAG_CATALOG, UI_FLAG_NAMES, UI_FLAGS_FORCE_OFF_VARIABLE, agentXError, orgUiFlagsKey, uiFlagState, uiFlagsForcedOff,
  type AuditEventInput, type OrgId, type UiFlagName, type UiFlagsAdminAnswer, type UiFlagsMap,
} from "@agentx/contracts";
import { auditCompanyUiFlagsChanged, auditOccurrence } from "../../audit/events.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditPending, type AuditRuntime } from "../../audit/outbox.js";
import { auditActorOf } from "../../audit/plan3-hooks.js";
import { logDeveloperEvent } from "../../developer/log.js";

type Item = Record<string, unknown>;
export interface UiFlagsDeps {
  documentClient: { send(command: never): Promise<unknown> };
  tableName: string;
  now(): number;
  audit?: AuditRuntime | undefined;
}

/** What a company has stored. `revision` is 0 while there is no usable record. */
export interface UiFlagsSettings {
  flags: Readonly<Partial<Record<UiFlagName, boolean>>>;
  previews: boolean;
  revision: number;
  changedAt?: string;
  /** Set only when a row exists whose `revision` is present but not a whole number of 1 or more: what is stored there, so the next write can replace exactly that row (see `writeUiFlags`). */
  unreadableRevision?: { value: unknown };
}

const KNOWN = new Set<string>(UI_FLAG_NAMES);
const isCancellation = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");
const send = <T>(deps: UiFlagsDeps, command: unknown): Promise<T> => deps.documentClient.send(command as never) as Promise<T>;

/**
 * The company's settings from its stored item (or none). A value that does not read counts as off. A row whose revision does not read is UNREADABLE as a whole: every flag is off and previews are not allowed
 * (a flag value is trusted only beside a revision the fence can hold), at revision 0, and `unreadableRevision` says what is stored so an admin's next change replaces the row instead of being locked out.
 */
export function settingsFromItem(item: Item | undefined): UiFlagsSettings {
  if (item === undefined) return { flags: {}, previews: false, revision: 0 };
  if (!(typeof item.revision === "number" && Number.isInteger(item.revision) && item.revision >= 1)) {
    return { flags: {}, previews: false, revision: 0, ...(item.revision === undefined ? {} : { unreadableRevision: { value: item.revision } }) };
  }
  const stored = typeof item.flags === "object" && item.flags !== null && !Array.isArray(item.flags) ? item.flags as Record<string, unknown> : {};
  const flags: Partial<Record<UiFlagName, boolean>> = {};
  for (const [name, value] of Object.entries(stored)) if (KNOWN.has(name) && typeof value === "boolean") flags[name as UiFlagName] = value;
  return { flags, previews: item.previews === true, revision: item.revision, ...(typeof item.changedAt === "string" ? { changedAt: item.changedAt } : {}) };
}

export async function readUiFlags(deps: UiFlagsDeps, orgId: OrgId, options: { consistent: boolean } = { consistent: true }): Promise<UiFlagsSettings> {
  const found = await send<{ Item?: Item }>(deps, new GetCommand({ TableName: deps.tableName, Key: orgUiFlagsKey(orgId), ConsistentRead: options.consistent }));
  return settingsFromItem(found.Item);
}

/** The flags the operator forces off, read from the install's setting every time (a value that does not read forces everything off and is logged). */
export function operatorForcedOff(environment: Record<string, string | undefined> = process.env): ReadonlySet<UiFlagName> {
  const forced = uiFlagsForcedOff(environment[UI_FLAGS_FORCE_OFF_VARIABLE]);
  if (forced.unreadable) logDeveloperEvent({ event: "developer.ui_flags_override_unreadable" });
  return forced.names;
}

/** The state of each flag for the people of one company: `uiFlags` in the navigation answer. */
export function uiFlagsMapOf(settings: UiFlagsSettings, forced: ReadonlySet<UiFlagName>): Required<UiFlagsMap> {
  return Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, uiFlagState({ enabled: settings.flags[name] === true, previews: settings.previews, forcedOff: forced.has(name) })])) as Required<UiFlagsMap>;
}

/** Every flag off, no preview: what a company that never changed anything gets, and what a failed read gives. */
export const ALL_OFF: Required<UiFlagsMap> = Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, "off" as const])) as Required<UiFlagsMap>;

/** `uiFlags` for the navigation answer. Never throws: a read that fails gives every flag off (and a log line without the company's data). */
export async function navUiFlags(deps: UiFlagsDeps, orgId: OrgId, environment: Record<string, string | undefined> = process.env): Promise<Required<UiFlagsMap>> {
  try { return uiFlagsMapOf(await readUiFlags(deps, orgId, { consistent: false }), operatorForcedOff(environment)); }
  catch { logDeveloperEvent({ event: "developer.ui_flags_read_failed" }); return ALL_OFF; }
}

/** The answer of the admin route: every flag with the company's own switch, the operator's hold and what people get. */
export function adminAnswerOf(settings: UiFlagsSettings, forced: ReadonlySet<UiFlagName>): UiFlagsAdminAnswer {
  return {
    revision: settings.revision,
    previews: settings.previews,
    flags: UI_FLAG_CATALOG.map((entry) => {
      const enabled = settings.flags[entry.name] === true, forcedOff = forced.has(entry.name);
      return { name: entry.name, label: entry.label, summary: entry.summary, wired: entry.wired, enabled, forcedOff, state: uiFlagState({ enabled, previews: settings.previews, forcedOff }) };
    }),
    ...(settings.changedAt === undefined ? {} : { changedAt: settings.changedAt }),
  };
}

export interface UiFlagsChange { flags?: Readonly<Partial<Record<UiFlagName, boolean | undefined>>> | undefined; previews?: boolean | undefined }

/**
 * Writes a change. `expectedRevision` is what the caller read (0 while there is no record): the write is conditioned on it, so a stale one is CHANGE_STALE. The audit event goes in the SAME transaction; with no ledger the change is
 * refused (AUDIT_UNAVAILABLE). Writing the value already in force still moves the revision, so a double click is never a change the audit cannot see.
 */
export async function writeUiFlags(deps: UiFlagsDeps, input: { orgId: OrgId; developerId: string; expectedRevision: number; change: UiFlagsChange }): Promise<UiFlagsSettings> {
  const current = await readUiFlags(deps, input.orgId);
  if (current.revision !== input.expectedRevision) throw agentXError("CHANGE_STALE", "Someone else changed this. Reload and try again.");
  const flags: Partial<Record<UiFlagName, boolean>> = { ...current.flags };
  const turnedOn: string[] = [], turnedOff: string[] = [];
  for (const name of UI_FLAG_NAMES) {
    const wanted = input.change.flags?.[name];
    if (wanted === undefined) continue;
    const was = current.flags[name] === true;
    flags[name] = wanted;
    if (wanted && !was) turnedOn.push(name);
    if (!wanted && was) turnedOff.push(name);
  }
  const previews = input.change.previews ?? current.previews;
  const revision = current.revision + 1;
  const at = new Date(deps.now()).toISOString();
  const event: AuditEventInput = auditCompanyUiFlagsChanged({
    orgId: input.orgId, actor: auditActorOf(input.developerId), occurredAt: at, occurrence: auditOccurrence(input.orgId, String(revision)),
    revision, turnedOn, turnedOff, previews: input.change.previews === undefined || input.change.previews === current.previews ? "same" : input.change.previews ? "on" : "off",
  });
  const pending = deps.audit === undefined ? undefined : auditPending({ audit: deps.audit }, event)[0]?.Put;
  if (pending === undefined) throw agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
  const key = orgUiFlagsKey(input.orgId);
  const write = {
    Update: {
      TableName: deps.tableName, Key: key,
      // Update, not Put: a field a newer writer added stays.
      UpdateExpression: "SET entityType = :type, orgId = :org, #flags = :flags, previews = :previews, #revision = :next, changedAt = :at, changedBy = :by",
      // The fence holds the revision the caller read. Revision 0 is "no usable row": no row, a row with no revision, or a row whose stored revision is malformed, which is replaced only while that same raw value is still stored
      // (so a malformed row never locks the admin out, and two writers still cannot both replace it).
      ConditionExpression: input.expectedRevision !== 0 ? "#revision = :expected" : current.unreadableRevision === undefined ? "attribute_not_exists(pk) OR attribute_not_exists(#revision)" : "#revision = :raw",
      ExpressionAttributeNames: { "#flags": "flags", "#revision": "revision" },
      ExpressionAttributeValues: { ":type": "UI_FLAGS", ":org": input.orgId, ":flags": flags, ":previews": previews, ":next": revision, ":at": at, ":by": input.developerId, ...(input.expectedRevision !== 0 ? { ":expected": input.expectedRevision } : current.unreadableRevision === undefined ? {} : { ":raw": current.unreadableRevision.value }) },
    },
  };
  try { await send(deps, new TransactWriteCommand({ TransactItems: [write, { Put: pending }] })); }
  catch (error) {
    if (isCancellation(error)) throw agentXError("CHANGE_STALE", "Someone else changed this. Reload and try again.");
    throw error;
  }
  await flushAuditEvents(deps.audit === undefined ? {} : { audit: deps.audit }, [event]);
  return { flags, previews, revision, changedAt: at };
}

