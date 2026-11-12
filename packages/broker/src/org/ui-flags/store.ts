// Runtime per-company UI flags (lane U5, requirement P-52): the store, the install operator's override and the answers built from them.
//
// ONE ROW per company: `ORG#<org>` / `UI_FLAGS` (orgUiFlagsKey), a map of known flag names to on/off, the permission for device previews, and a `revision` that fences every write. Absent until the company first
// changes something: every flag takes its catalog default (decision 116: a finished screen is on, an unfinished one off) and previews are not allowed. A name is stored only when an owner or admin pressed its switch,
// so a stored value (true or false, from any version) is the company's deliberate choice and wins over the default; the row keeps only those pressed values, never the defaults, so a later default change (or a
// rollback to a broker that read an absent name as off) still applies to every name nobody pressed. A flag name outside the closed list (contracts/ui-flags.ts) is never stored and never sent; a stored name that is
// no longer known is ignored when read and dropped by the next write. That includes the eight finished screens' former names (decision 125, REMOVED_UI_FLAG_NAMES): a choice stored for one of them before decision 125
// changes nothing now (the screen has no old version left), and an older broker reading a row this one wrote finds the name absent, which it reads as its default.
// "Turn back to the default" is a write of `null` for a name (the PUT body): the name is removed from the stored map, so the company follows the catalog default again, including a later change of that default.
//
// THE OPERATOR'S OVERRIDE is the install's stack parameter UiFlagsForceOff, packed broker setting `uo`, read as UI_FLAGS_FORCE_OFF (`all`, or names joined by `-`). It forces flags off for every company, wins over the
// company's switch and over previews, and fails closed on a value it cannot read (contracts `uiFlagsForcedOff`).
//
// A READ THAT FAILS gives every flag off with no preview (the old screens, which always work), never an error that takes the navigation down and never a screen left on by a guess: the read could not tell whether
// the company chose the old screen. A row that is there but cannot be read (its revision, or one flag's value) counts as off for what it cannot read, for the same reason.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { UI_FLAG_CATALOG, UI_FLAG_NAMES, UI_FLAGS_FORCE_OFF_VARIABLE, orgUiFlagsKey, uiFlagEnabled, uiFlagState, uiFlagsForcedOff, type AuditEventInput, type UiFlagName, type UiFlagsAdminAnswer, type UiFlagsMap } from "@agentx/cloud-contracts";
import { agentXError, type OrgId } from "@rovara-code/contracts";
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

/** What a company has stored. `revision` is 0 while there is no usable record. `flags` holds only the stored (pressed) values; a name that is absent takes its default (`uiFlagEnabled`). */
export interface UiFlagsSettings {
  flags: Readonly<Partial<Record<UiFlagName, boolean>>>;
  previews: boolean;
  revision: number;
  changedAt?: string;
  /** Set only when a row exists whose `revision` is present but not a whole number of 1 or more: what is stored there, so the next write can replace exactly that row (see `writeUiFlags`). */
  unreadableRevision?: { value: unknown };
  /** True when the row is there but its flags cannot be read: every flag reads as off. The next change starts from nothing stored (the defaults), so a corrupt row never pins a company to the old screens. */
  unreadable?: true;
  /** Known names whose stored value is not a boolean: each reads as off (fail closed) but is not carried into the next write, which stores only real choices (the name then takes its default unless that write sets it). */
  malformed?: readonly UiFlagName[];
}

const KNOWN = new Set<string>(UI_FLAG_NAMES);
const isCancellation = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");
const send = <T>(deps: UiFlagsDeps, command: unknown): Promise<T> => deps.documentClient.send(command as never) as Promise<T>;

/** Every known flag stored off: what an unreadable row reads as (it may hold a company's choice of the old screens, and that cannot be told apart). */
const allStoredOff = (): Partial<Record<UiFlagName, boolean>> => Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, false]));

/**
 * The company's settings from its stored item (or none). No item: nothing stored, so every flag takes its default. A known name whose value does not read counts as stored off (fail closed: it may have been a
 * choice of the old screen). A row whose revision does not read (or has none) is UNREADABLE as a whole: every flag reads as stored off and previews are not allowed (a flag value is trusted only beside a revision
 * the fence can hold), at revision 0, and `unreadableRevision` says what is stored so an admin's next change replaces the row instead of being locked out (`unreadable`: that change starts from the defaults).
 */
export function settingsFromItem(item: Item | undefined): UiFlagsSettings {
  if (item === undefined) return { flags: {}, previews: false, revision: 0 };
  if (!(typeof item.revision === "number" && Number.isInteger(item.revision) && item.revision >= 1)) {
    return { flags: allStoredOff(), previews: false, revision: 0, unreadable: true, ...(item.revision === undefined ? {} : { unreadableRevision: { value: item.revision } }) };
  }
  const readable = typeof item.flags === "object" && item.flags !== null && !Array.isArray(item.flags);
  // A `flags` field that is there but not a map cannot say which screens the company sent back: all off. A row with no `flags` field at all stored nothing.
  if (!readable && item.flags !== undefined) return { flags: allStoredOff(), previews: item.previews === true, revision: item.revision, unreadable: true, ...(typeof item.changedAt === "string" ? { changedAt: item.changedAt } : {}) };
  const stored = readable ? item.flags as Record<string, unknown> : {};
  const flags: Partial<Record<UiFlagName, boolean>> = {}, malformed: UiFlagName[] = [];
  for (const [name, value] of Object.entries(stored)) {
    if (!KNOWN.has(name)) continue;
    flags[name as UiFlagName] = value === true;
    if (typeof value !== "boolean") malformed.push(name as UiFlagName);
  }
  return { flags, previews: item.previews === true, revision: item.revision, ...(typeof item.changedAt === "string" ? { changedAt: item.changedAt } : {}), ...(malformed.length > 0 ? { malformed } : {}) };
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
  return Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, uiFlagState({ enabled: uiFlagEnabled(name, settings.flags[name]), previews: settings.previews, forcedOff: forced.has(name) })])) as Required<UiFlagsMap>;
}

/** Every flag off, no preview: what a failed read gives (the old screens). A company that never changed anything gets the defaults instead (`uiFlagsMapOf` with nothing stored). */
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
      const enabled = uiFlagEnabled(entry.name, settings.flags[entry.name]), forcedOff = forced.has(entry.name);
      return { name: entry.name, label: entry.label, summary: entry.summary, wired: entry.wired, enabled, forcedOff, state: uiFlagState({ enabled, previews: settings.previews, forcedOff }) };
    }),
    ...(settings.changedAt === undefined ? {} : { changedAt: settings.changedAt }),
  };
}

/** `flags`: true or false stores the company's choice for that name; null removes its stored choice (back to the catalog default); absent leaves it as it is. */
export interface UiFlagsChange { flags?: Readonly<Partial<Record<UiFlagName, boolean | null | undefined>>> | undefined; previews?: boolean | undefined }

/**
 * Writes a change. `expectedRevision` is what the caller read (0 while there is no record): the write is conditioned on it, so a stale one is CHANGE_STALE. The audit event goes in the SAME transaction; with no ledger the change is
 * refused (AUDIT_UNAVAILABLE). Writing the value already in force still moves the revision, so a double click is never a change the audit cannot see.
 */
export async function writeUiFlags(deps: UiFlagsDeps, input: { orgId: OrgId; developerId: string; expectedRevision: number; change: UiFlagsChange }): Promise<UiFlagsSettings> {
  const current = await readUiFlags(deps, input.orgId);
  if (current.revision !== input.expectedRevision) throw agentXError("CHANGE_STALE", "Someone else changed this. Reload and try again.");
  // Only pressed values are stored (never a default); a row that could not be read is replaced from nothing stored, and a stored value that is not a boolean is not carried (it read as off; the name now takes its default).
  const flags: Partial<Record<UiFlagName, boolean>> = current.unreadable === true ? {} : { ...current.flags };
  for (const name of current.malformed ?? []) delete flags[name];
  for (const name of UI_FLAG_NAMES) {
    const wanted = input.change.flags?.[name];
    if (wanted === null) delete flags[name];
    else if (wanted !== undefined) flags[name] = wanted;
  }
  // Against what was in force for the company before and after (its choice, else the default), so the audit says what changed for people.
  const turnedOn = UI_FLAG_NAMES.filter((name) => !uiFlagEnabled(name, current.flags[name]) && uiFlagEnabled(name, flags[name]));
  const turnedOff = UI_FLAG_NAMES.filter((name) => uiFlagEnabled(name, current.flags[name]) && !uiFlagEnabled(name, flags[name]));
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

