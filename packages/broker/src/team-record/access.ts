// The access records of the Team record. Access is a READ-TIME check against these, never against the audience stored on a row (that is only a coarse pre-filter and can
// be stale). The unit of a record is the source's own ACL unit: a Slack channel, a repository, one issue or one MCP item that carries its own list. A row names the units
// that apply to it (its own unit, its place, and every place above), and a unit's record never replaces another unit's.
//
// Layout (workspace partition): one small HEADER per unit (`ACCESS#<unit>`: visibility, groups, whether it was seeded from a full list, who feeds it) and one item per
// person per unit (`ACCESS#<unit>#M#<person>`, the raw id never in a key), plus an index item per person (`ACCESSP#<person>#<unit>`) so an erase finds every unit a person is
// in. No item grows with the member count, so there is no size limit, and a leave is one conditional write.
//
// A person's entry is one string `<tier>|<iso time>|<bit>` (bit 0 = member, 1 = removed). A write replaces an entry only if its string sorts HIGHER: a newer event beats an
// older one, a removal beats an add of the same time (1 sorts after 0), and an event (tier 1) beats any snapshot taken from a row (tier 0, ordered among snapshots by the
// time the list was READ: `capturedAt` of a snapshot must be that time, not the time of the content).
//
// Seeded or not: a unit is SEEDED when its full member list has been written (from a row's snapshot, a full audience event, or the source's own list). Until then, a member
// event (the app's own invite, before any message) writes only that person's entry and the unit is an overlay: a read is allowed iff the row's own snapshot allows it AND no
// removal entry for the reader is newer than that snapshot. After seeding the record is authoritative.
import { createHash } from "node:crypto";
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  MAINTAINERS_GROUP, recordAccessErasedKey, recordAccessKey, recordAccessMemberKey, recordAccessMemberPrefix, recordAccessPersonKey, recordAccessPersonPrefix, scopeAndAncestors,
  type AclSnapshot, type Audience, type OrgId,
} from "@agentx/contracts";
import { Aliases, errorName, type Item } from "../agents/table-writes.js";
import { queryPrefix } from "./store.js";
import type { RecordCaller, TeamRecordTable } from "./types.js";

const BATCH_KEYS = 100;
const UNPROCESSED_RETRIES = 5;
const BACKOFF_MS = 20;
/** The most distinct units one request looks up; past it the rest read as unavailable (never as visible). */
export const ACCESS_SCOPES_PER_REQUEST_MAX = 1_000;
/** The most person entries one audience event walks; more than this fails the event (the source retries) rather than leaving a half-merged list. */
const ENTRIES_PER_EVENT_MAX = 50_000;
const WRITE_PARALLEL = 20;

export interface AccessHeader {
  scope: string;
  source: string;
  /** `restricted`: only members and groups; `open`: this unit no longer limits who reads its rows. */
  mode: "restricted" | "open";
  groups: string[];
  liveCheck: "none" | "on_read";
  /** When mode and groups last changed by an event (the time of the event). */
  modeTs: string;
  /** True once the full member list is written; false while only some people's events are known (an overlay). */
  seeded: boolean;
  /** `snapshot`: the snapshots of newer rows still refresh the list; `events`: only member and audience events do. */
  fed: "snapshot" | "events";
  snapshotTs?: string;
  /** A hash of the list and groups the snapshot last wrote, so an unchanged snapshot costs no write. */
  snapshotHash?: string;
  /** A hash of a list that was NOT applied (the unit is fed by events) but whose people were indexed, so an erase finds this place for each of them. */
  indexedHash?: string;
}

export const sourceOfScope = (scope: string): string => scope.split(":", 1)[0] ?? scope;

const isoOf = (at: string): string => {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) throw new Error("team-record: an access change needs a valid time");
  return parsed.toISOString();
};
const entryValue = (tier: "0" | "1", iso: string, removed: boolean): string => `${tier}|${iso}|${removed ? "1" : "0"}`;
const snapshotValue = (iso: string, removed: boolean): string => entryValue("0", iso, removed);
const eventValue = (iso: string, removed: boolean): string => entryValue("1", iso, removed);
export const isMemberValue = (value: string): boolean => value.endsWith("|0");
/** The time inside an entry value. */
const timeOfValue = (value: string): string => value.split("|")[1] ?? "";

function parseHeader(item: Item | undefined): AccessHeader | undefined {
  if (item === undefined || item.entityType !== "TEAM_RECORD_ACCESS") return undefined;
  if (typeof item.scope !== "string" || typeof item.source !== "string" || (item.mode !== "restricted" && item.mode !== "open") || typeof item.modeTs !== "string" || typeof item.seeded !== "boolean") {
    throw new Error("malformed access record");
  }
  return {
    scope: item.scope, source: item.source, mode: item.mode, groups: Array.isArray(item.groups) ? item.groups.filter((group): group is string => typeof group === "string") : [],
    liveCheck: item.liveCheck === "on_read" ? "on_read" : "none", modeTs: item.modeTs, seeded: item.seeded, fed: item.fed === "snapshot" ? "snapshot" : "events",
    ...(typeof item.snapshotTs === "string" ? { snapshotTs: item.snapshotTs } : {}), ...(typeof item.snapshotHash === "string" ? { snapshotHash: item.snapshotHash } : {}),
    ...(typeof item.indexedHash === "string" ? { indexedHash: item.indexedHash } : {}),
  };
}

const headerItem = (orgId: OrgId, header: AccessHeader): Item => ({ ...recordAccessKey(orgId, header.scope), entityType: "TEAM_RECORD_ACCESS", ...header });
const listHash = (principals: readonly string[], groups: readonly string[], mode: string): string => createHash("sha256").update(JSON.stringify([[...new Set(principals)].sort(), [...new Set(groups)].sort(), mode])).digest("hex");

async function getHeader(table: TeamRecordTable, orgId: OrgId, scope: string): Promise<AccessHeader | undefined> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: recordAccessKey(orgId, scope), ConsistentRead: true })) as { Item?: Item };
  return parseHeader(response.Item);
}

const conditional = (error: unknown): boolean => errorName(error) === "ConditionalCheckFailedException";

async function inChunks<T>(list: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  for (let at = 0; at < list.length; at += size) await Promise.all(list.slice(at, at + size).map(work));
}

// ---- erased people

/** Ids that were erased: no event or snapshot writes them into a record again. */
export async function erasedAccessIds(table: TeamRecordTable, orgId: OrgId, ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const wanted = [...new Set(ids)];
  for (let at = 0; at < wanted.length; at += BATCH_KEYS) {
    const chunk = wanted.slice(at, at + BATCH_KEYS);
    const keys = chunk.map((id) => recordAccessErasedKey(orgId, id));
    const found = await batchGetAll(table, keys, sleepFor());
    for (const [index, key] of keys.entries()) if (found.has(key.sk)) out.add(chunk[index] as string);
  }
  return out;
}

// ---- writes

/** One person's entry: the index item first (so an erase can always find the entry), then the entry itself, conditional on the stored string sorting lower. */
async function putEntry(table: TeamRecordTable, orgId: OrgId, scope: string, person: string, value: string): Promise<"applied" | "same" | "lost"> {
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...recordAccessPersonKey(orgId, person, scope), entityType: "TEAM_RECORD_ACCESS_INDEX" } }));
  const key = recordAccessMemberKey(orgId, scope, person);
  const aliases = new Aliases();
  try {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName,
      Item: { ...key, entityType: "TEAM_RECORD_ACCESS_MEMBER", v: value },
      ConditionExpression: `attribute_not_exists(${aliases.name("pk")}) OR ${aliases.name("v")} < ${aliases.value(value)}`,
      ExpressionAttributeNames: aliases.names,
      ExpressionAttributeValues: aliases.values,
    }));
    return "applied";
  } catch (error) {
    if (!conditional(error)) throw error;
    const stored = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
    return stored.Item?.v === value ? "same" : "lost";
  }
}

async function ensureHeader(table: TeamRecordTable, orgId: OrgId, header: AccessHeader): Promise<void> {
  try {
    await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: headerItem(orgId, header), ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (error) {
    if (!conditional(error)) throw error;
  }
}

/** Whether a unit's record already holds exactly this snapshot's list and groups (a comment that inherits its issue's list shares the issue's unit). */
export async function unitHasList(table: TeamRecordTable, orgId: OrgId, scope: string, acl: AclSnapshot): Promise<boolean> {
  const header = await getHeader(table, orgId, scope);
  return header !== undefined && header.seeded && header.mode === "restricted" && header.snapshotHash === listHash(acl.principals ?? [], acl.groups ?? [], "restricted");
}

/** Whether the unit's full list was ever written (an unseeded unit is only an overlay of events). */
export async function accessIsSeeded(table: TeamRecordTable, orgId: OrgId, scope: string): Promise<boolean> {
  return (await getHeader(table, orgId, scope))?.seeded === true;
}

export interface MemberEventResult {
  /** The people whose event is now what the record says (written now, or already there): the rewrite of the rows follows these. A person whose event lost to a newer one is not here. */
  applied: { add: string[]; remove: string[] };
}

/**
 * People joined or left a unit: ONE conditional write per person, carrying the event's own time. An older event for the same person never overrides a newer one, and a removal
 * beats an add of the same time. An erased id is skipped. A unit with no record yet gets an unseeded one (only these people's entries).
 */
export async function applyMemberEvents(table: TeamRecordTable, orgId: OrgId, input: { scope: string; add?: readonly string[]; remove?: readonly string[]; at: string }): Promise<MemberEventResult> {
  const iso = isoOf(input.at);
  const erased = await erasedAccessIds(table, orgId, [...(input.add ?? []), ...(input.remove ?? [])]);
  const result: MemberEventResult = { applied: { add: [], remove: [] } };
  const people = [...(input.remove ?? []).filter((id) => !erased.has(id)).map((id) => ({ id, removed: true })), ...(input.add ?? []).filter((id) => !erased.has(id)).map((id) => ({ id, removed: false }))];
  if (people.length === 0) return result;
  await ensureHeader(table, orgId, { scope: input.scope, source: sourceOfScope(input.scope), mode: "restricted", groups: [], liveCheck: "none", modeTs: iso, seeded: false, fed: "events" });
  for (const person of people) {
    const outcome = await putEntry(table, orgId, input.scope, person.id, eventValue(iso, person.removed));
    if (outcome !== "lost") (person.removed ? result.applied.remove : result.applied.add).push(person.id);
  }
  // From the first event on, snapshots from rows no longer change who is in (a list built from a cache must never grant again).
  const aliases = new Aliases();
  await table.documentClient.send(new UpdateCommand({
    TableName: table.tableName, Key: recordAccessKey(orgId, input.scope), UpdateExpression: `SET ${aliases.name("fed")} = ${aliases.value("events")}`,
    ConditionExpression: `attribute_exists(${aliases.name("pk")})`, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
  }));
  return result;
}

/** The person entries of a unit (hashes in the keys, values as stored). */
async function entriesOf(table: TeamRecordTable, orgId: OrgId, scope: string): Promise<Array<{ key: { pk: string; sk: string }; value: string }>> {
  const found = await queryPrefix(table, orgId, undefined, recordAccessMemberPrefix(orgId, scope), ENTRIES_PER_EVENT_MAX);
  if (found.truncated) throw new Error("team-record: the access record of a place is too large to merge in one pass");
  return found.items.flatMap((item) => (typeof item.pk === "string" && typeof item.sk === "string" && typeof item.v === "string" ? [{ key: { pk: item.pk, sk: item.sk }, value: item.v }] : []));
}

/** Deletes a unit's person entries and their index items, keeping the header. */
async function clearEntries(table: TeamRecordTable, orgId: OrgId, scope: string): Promise<void> {
  const unitHash = recordAccessKey(orgId, scope).sk.slice("ACCESS#".length);
  for (;;) {
    const found = await queryPrefix(table, orgId, undefined, recordAccessMemberPrefix(orgId, scope), 500);
    await inChunks(found.items, WRITE_PARALLEL, async (item) => {
      if (typeof item.pk !== "string" || typeof item.sk !== "string") return;
      await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk: item.pk, sk: item.sk } }));
      await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk: item.pk, sk: `ACCESSP#${personHashOfEntry(item.sk)}#${unitHash}` } }));
    });
    if (!found.truncated) return;
  }
}

const personHashOfEntry = (sk: string): string => sk.slice(sk.lastIndexOf("#M#") + 3);

/**
 * A place turned private or public, or its audience was replaced (a full list): each person in the new list gets an event entry, each present member who is not in it gets a
 * removal, under the same per-person rule; then the mode and groups change if the event is not older than the last one, and the unit is marked seeded. Entries first, header
 * last, so a reader never sees a seeded unit with half a list.
 */
export async function applyAudienceEvent(table: TeamRecordTable, orgId: OrgId, input: { scope: string; audience: Audience; at: string }): Promise<void> {
  const iso = isoOf(input.at);
  const existing = await getHeader(table, orgId, input.scope);
  const current = existing === undefined || existing.fed === "snapshot" || existing.modeTs <= iso;
  if (input.audience.kind === "restricted" && (input.audience.acl.principals ?? []).length === 0 && (input.audience.acl.groups ?? []).length === 0) {
    // The list could not be read (a conversion to private whose member list was unavailable, or a channel everyone left): nothing says who is in. The unit is cleared and left
    // UNSEEDED, restricted, so the next full list (a row's snapshot, the tap's seed) seeds it. Writing "everyone removed" as events would lock the channel for good.
    if (existing !== undefined && !current) return;
    await clearEntries(table, orgId, input.scope);
    await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: headerItem(orgId, { scope: input.scope, source: input.audience.acl.source, mode: "restricted", groups: [], liveCheck: input.audience.acl.liveCheck, modeTs: iso, seeded: false, fed: "events" }) }));
    return;
  }
  if (input.audience.kind === "restricted") {
    const erased = await erasedAccessIds(table, orgId, input.audience.acl.principals ?? []);
    const principals = [...new Set(input.audience.acl.principals ?? [])].filter((id) => !erased.has(id));
    const wanted = new Set(principals.map((id) => recordAccessMemberKey(orgId, input.scope, id).sk));
    await inChunks(principals, WRITE_PARALLEL, async (id) => { await putEntry(table, orgId, input.scope, id, eventValue(iso, false)); });
    // Present members the list leaves out are removed (the unit's entries are listed by the unit's own prefix).
    const present = (await entriesOf(table, orgId, input.scope)).filter((entry) => isMemberValue(entry.value) && !wanted.has(entry.key.sk));
    await inChunks(present, WRITE_PARALLEL, async (entry) => {
      const aliases = new Aliases();
      try {
        await table.documentClient.send(new PutCommand({
          TableName: table.tableName, Item: { ...entry.key, entityType: "TEAM_RECORD_ACCESS_MEMBER", v: eventValue(iso, true) },
          ConditionExpression: `attribute_not_exists(${aliases.name("pk")}) OR ${aliases.name("v")} < ${aliases.value(eventValue(iso, true))}`,
          ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
        }));
      } catch (error) {
        if (!conditional(error)) throw error;
      }
    });
  }
  const next: AccessHeader = {
    scope: input.scope, source: input.audience.kind === "restricted" ? input.audience.acl.source : existing?.source ?? sourceOfScope(input.scope),
    mode: input.audience.kind === "restricted" ? "restricted" : "open", groups: input.audience.kind === "restricted" ? [...(input.audience.acl.groups ?? [])] : existing?.groups ?? [],
    liveCheck: input.audience.kind === "restricted" ? input.audience.acl.liveCheck : existing?.liveCheck ?? "none", modeTs: iso, seeded: true, fed: "events",
  };
  if (existing === undefined || current) {
    await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: headerItem(orgId, { ...next, ...(existing?.snapshotTs === undefined ? {} : { snapshotTs: existing.snapshotTs }) }) }));
    return;
  }
  // An older audience event: the entries above followed the per-person rule; the mode and groups stay as the newer event left them. It still marks the unit seeded.
  const aliases = new Aliases();
  await table.documentClient.send(new UpdateCommand({
    TableName: table.tableName, Key: recordAccessKey(orgId, input.scope), UpdateExpression: `SET ${aliases.name("seeded")} = ${aliases.value(true)}, ${aliases.name("fed")} = ${aliases.value("events")}`,
    ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
  }));
}

/**
 * Seeds or refreshes a unit from the snapshot on a stored restricted row. The first row creates the record; a record that only has event entries (the app's own invite came
 * first) is seeded from the row, the events keeping their say; a record fed by snapshots follows a NEWER snapshot. Once any event has arrived, rows never change who is in.
 */
export async function observeRowAccess(table: TeamRecordTable, orgId: OrgId, acl: AclSnapshot): Promise<void> {
  const iso = isoOf(acl.capturedAt);
  const principals = [...new Set(acl.principals ?? [])];
  const groups = [...(acl.groups ?? [])];
  const hash = listHash(principals, groups, "restricted");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const header = await getHeader(table, orgId, acl.scope);
    if (header !== undefined && header.seeded && (header.fed !== "snapshot" || (header.snapshotTs !== undefined && header.snapshotTs >= iso) || header.snapshotHash === hash)) {
      // The snapshot is not applied (events feed this unit, or it is not newer), but the people it names are INDEXED once per distinct list: an erase finds this place for each of
      // them even if their join event was lost. The index grants nothing; only an entry does.
      if (header.snapshotHash !== hash && header.indexedHash !== hash && principals.length > 0) {
        const erasedIds = await erasedAccessIds(table, orgId, principals);
        const named = principals.filter((id) => !erasedIds.has(id));
        await inChunks(named, WRITE_PARALLEL, async (id) => { await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...recordAccessPersonKey(orgId, id, acl.scope), entityType: "TEAM_RECORD_ACCESS_INDEX" } })); });
        const aliases = new Aliases();
        await table.documentClient.send(new UpdateCommand({ TableName: table.tableName, Key: recordAccessKey(orgId, acl.scope), UpdateExpression: `SET ${aliases.name("indexedHash")} = ${aliases.value(hash)}`, ConditionExpression: `attribute_exists(${aliases.name("pk")})`, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values })).catch((error: unknown) => { if (!conditional(error)) throw error; });
      }
      return;
    }
    const erased = await erasedAccessIds(table, orgId, principals);
    const listed = principals.filter((id) => !erased.has(id));
    await inChunks(listed, WRITE_PARALLEL, async (id) => { await putEntry(table, orgId, acl.scope, id, snapshotValue(iso, false)); });
    if (header === undefined) {
      try {
        await table.documentClient.send(new PutCommand({
          TableName: table.tableName, ConditionExpression: "attribute_not_exists(pk)",
          Item: headerItem(orgId, { scope: acl.scope, source: acl.source, mode: "restricted", groups, liveCheck: acl.liveCheck, modeTs: iso, seeded: true, fed: "snapshot", snapshotTs: iso, snapshotHash: hash }),
        }));
        return;
      } catch (error) {
        if (!conditional(error)) throw error;
        continue;
      }
    }
    if (header.seeded) {
      // A newer snapshot of a snapshot-fed unit: present snapshot members the new list leaves out are removed (as snapshot entries, which an event still outranks).
      const wanted = new Set(listed.map((id) => recordAccessMemberKey(orgId, acl.scope, id).sk));
      const gone = (await entriesOf(table, orgId, acl.scope)).filter((entry) => isMemberValue(entry.value) && !wanted.has(entry.key.sk));
      await inChunks(gone, WRITE_PARALLEL, async (entry) => {
        const aliases = new Aliases();
        try {
          await table.documentClient.send(new PutCommand({
            TableName: table.tableName, Item: { ...entry.key, entityType: "TEAM_RECORD_ACCESS_MEMBER", v: snapshotValue(iso, true) },
            ConditionExpression: `attribute_not_exists(${aliases.name("pk")}) OR ${aliases.name("v")} < ${aliases.value(snapshotValue(iso, true))}`,
            ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
          }));
        } catch (error) {
          if (!conditional(error)) throw error;
        }
      });
    }
    const aliases = new Aliases();
    try {
      await table.documentClient.send(new UpdateCommand({
        TableName: table.tableName, Key: recordAccessKey(orgId, acl.scope),
        UpdateExpression: `SET ${aliases.name("seeded")} = ${aliases.value(true)}, ${aliases.name("mode")} = ${aliases.value("restricted")}, ${aliases.name("groups")} = ${aliases.value(groups)}, ${aliases.name("liveCheck")} = ${aliases.value(acl.liveCheck)}, ${aliases.name("snapshotTs")} = ${aliases.value(iso)}, ${aliases.name("snapshotHash")} = ${aliases.value(hash)}`,
        ConditionExpression: header.seeded ? `${aliases.name("fed")} = ${aliases.value("snapshot")}` : `${aliases.name("seeded")} = ${aliases.value(false)}`,
        ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
      }));
      return;
    } catch (error) {
      if (!conditional(error)) throw error;
    }
  }
  throw new Error("team-record: the access record of a place is busy; try again");
}

/**
 * A stored PROJECT row of a unit whose record is fed by snapshots and says restricted (a repository that turned public): a newer open row switches the record to open, as a
 * newer restricted snapshot is already trusted. A unit fed by events is never changed by a row.
 */
export async function observeOpenRow(table: TeamRecordTable, orgId: OrgId, scope: string, at: string): Promise<void> {
  const iso = isoOf(at);
  const header = await getHeader(table, orgId, scope);
  if (header === undefined || header.mode !== "restricted" || header.fed !== "snapshot" || (header.snapshotTs !== undefined && header.snapshotTs >= iso)) return;
  const aliases = new Aliases();
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName, Key: recordAccessKey(orgId, scope),
      UpdateExpression: `SET ${aliases.name("mode")} = ${aliases.value("open")}, ${aliases.name("snapshotTs")} = ${aliases.value(iso)}`,
      ConditionExpression: `${aliases.name("fed")} = ${aliases.value("snapshot")} AND ${aliases.name("mode")} = ${aliases.value("restricted")}`,
      ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
    }));
  } catch (error) {
    if (!conditional(error)) throw error;
  }
}

// ---- erasure and deletion

/** The erased marker for each id, written FIRST: from then on no event or snapshot puts the id back into any record. */
export async function markAccessErased(table: TeamRecordTable, orgId: OrgId, ids: readonly string[], at: string): Promise<void> {
  for (const id of new Set(ids)) await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...recordAccessErasedKey(orgId, id), entityType: "TEAM_RECORD_ERASED", at } }));
}

export interface PersonUnit {
  unitHash: string;
  /** The unit's scope as its header names it (absent if the header is gone). */
  scope: string | undefined;
}

/** The units a person has an entry in, through the person index, with each unit's scope. `truncated`: more remain (the erase runs again). */
export async function unitsOfPerson(table: TeamRecordTable, orgId: OrgId, id: string, max: number): Promise<{ units: PersonUnit[]; truncated: boolean }> {
  const prefix = recordAccessPersonPrefix(id);
  const found = await queryPrefix(table, orgId, undefined, prefix, Math.max(max, 1));
  const units = found.items.flatMap((item) => (typeof item.sk === "string" ? [{ unitHash: item.sk.slice(prefix.length), scope: undefined as string | undefined }] : []));
  for (let at = 0; at < units.length; at += BATCH_KEYS) {
    const chunk = units.slice(at, at + BATCH_KEYS);
    const keys = chunk.map((unit) => ({ pk: found.items[0]?.pk as string, sk: `ACCESS#${unit.unitHash}` }));
    const headers = await batchGetAll(table, keys, sleepFor());
    for (const [index, unit] of chunk.entries()) { const scope = headers.get((keys[index] as { sk: string }).sk)?.scope; unit.scope = typeof scope === "string" ? scope : undefined; }
  }
  return { units, truncated: found.truncated };
}

/** Removes one person's entry and index item from one unit. */
export async function removePersonFromUnit(table: TeamRecordTable, orgId: OrgId, id: string, unitHash: string): Promise<void> {
  const prefix = recordAccessPersonPrefix(id);
  const personHash = prefix.slice("ACCESSP#".length, -1);
  const pk = recordAccessMemberKey(orgId, "x", id).pk;
  await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk, sk: `ACCESS#${unitHash}#M#${personHash}` } }));
  await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk, sk: `${prefix}${unitHash}` } }));
}

/** The place a unit's rows keep as their `scope`: an item unit (`<place>/item:<hash>[/c:<hash>]`) belongs to its place. */
export const placeOfUnit = (scope: string): string => { const at = scope.indexOf("/item:"); return at < 0 ? scope : scope.slice(0, at); };

/** Deletes a unit's record (header, person entries and their index items), at most `maxItems` entries a call. True when nothing is left. */
export async function purgeAccessOfScope(table: TeamRecordTable, orgId: OrgId, scope: string, maxItems: number): Promise<boolean> {
  const found = await queryPrefix(table, orgId, undefined, recordAccessMemberPrefix(orgId, scope), maxItems);
  const unitHash = recordAccessKey(orgId, scope).sk.slice("ACCESS#".length);
  await inChunks(found.items, WRITE_PARALLEL, async (item) => {
    if (typeof item.pk !== "string" || typeof item.sk !== "string") return;
    await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk: item.pk, sk: item.sk } }));
    await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk: item.pk, sk: `ACCESSP#${personHashOfEntry(item.sk)}#${unitHash}` } }));
  });
  if (found.truncated) return false;
  await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: recordAccessKey(orgId, scope) }));
  return true;
}

// ---- reads

/** Who is asking, as the check needs it: the ids and groups the viewer has in each source, and whether they maintain the project. */
export interface AccessViewer {
  ids(source: string): readonly string[];
  groups(source: string): readonly string[];
  maintainer: boolean;
}

export const viewerOfCaller = (caller: RecordCaller): AccessViewer => ({
  ids: (source) => caller.identities.ids[source] ?? [], groups: (source) => caller.identities.groups[source] ?? [], maintainer: caller.projectRole === "maintainer",
});

/** A viewer given as flat lists (the learning lane keeps identities without a source): every id and group counts in every source. */
export const viewerOfLists = (viewer: { principals: readonly string[]; groups: readonly string[] }): AccessViewer => ({
  ids: () => viewer.principals, groups: () => viewer.groups, maintainer: viewer.groups.includes(MAINTAINERS_GROUP),
});

export type AccessState = { kind: "absent" } | { kind: "unavailable" } | { kind: "ok"; header: AccessHeader; entries: ReadonlyMap<string, string> };

export interface AccessReader {
  /** Fetches (once per request) the headers of the units and the viewer's own entries in them. A fetch that fails marks those units unavailable. */
  load(scopes: Iterable<string>, viewer: AccessViewer | undefined): Promise<void>;
  get(scope: string): AccessState;
}

const sleepFor = (): ((ms: number) => Promise<void>) => (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** BatchGet of any number of keys: 100 a call, unprocessed keys retried with exponential backoff, a failure after the last retry throws. */
async function batchGetAll(table: TeamRecordTable, keys: ReadonlyArray<{ pk: string; sk: string }>, sleep: (ms: number) => Promise<void>): Promise<Map<string, Item>> {
  const found = new Map<string, Item>();
  for (let at = 0; at < keys.length; at += BATCH_KEYS) {
    let pending = keys.slice(at, at + BATCH_KEYS);
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      if (attempt > UNPROCESSED_RETRIES) throw new Error("access records unavailable");
      if (attempt > 0) await sleep(BACKOFF_MS * 2 ** (attempt - 1));
      const response = await table.documentClient.send(new BatchGetCommand({ RequestItems: { [table.tableName]: { Keys: pending, ConsistentRead: true } } })) as { Responses?: Record<string, Item[]>; UnprocessedKeys?: Record<string, { Keys: Array<{ pk: string; sk: string }> }> };
      for (const item of response.Responses?.[table.tableName] ?? []) if (typeof item.sk === "string") found.set(item.sk, item);
      pending = response.UnprocessedKeys?.[table.tableName]?.Keys ?? [];
    }
  }
  return found;
}

export function createAccessReader(table: TeamRecordTable, orgId: OrgId, options: { sleep?: (ms: number) => Promise<void> } = {}): AccessReader {
  const sleep = options.sleep ?? sleepFor();
  const states = new Map<string, AccessState>();
  const entries = new Map<string, Map<string, string | null>>();
  const entryFor = (scope: string): Map<string, string | null> => {
    let known = entries.get(scope);
    if (known === undefined) { known = new Map(); entries.set(scope, known); }
    return known;
  };
  return {
    async load(scopes, viewer) {
      const wanted = [...new Set(scopes)].filter((scope) => !states.has(scope));
      for (const scope of wanted.slice(ACCESS_SCOPES_PER_REQUEST_MAX)) states.set(scope, { kind: "unavailable" });
      const take = wanted.slice(0, ACCESS_SCOPES_PER_REQUEST_MAX);
      const headers = new Map<string, AccessHeader>();
      if (take.length > 0) {
        try {
          const keys = take.map((scope) => recordAccessKey(orgId, scope));
          const found = await batchGetAll(table, keys, sleep);
          for (const [index, key] of keys.entries()) {
            const scope = take[index] as string;
            const item = found.get(key.sk);
            if (item === undefined) { states.set(scope, { kind: "absent" }); continue; }
            try {
              const header = parseHeader(item);
              if (header === undefined || header.scope !== scope) states.set(scope, { kind: "unavailable" });
              else headers.set(scope, header);
            } catch {
              states.set(scope, { kind: "unavailable" });
            }
          }
        } catch {
          for (const scope of take) if (!states.has(scope)) states.set(scope, { kind: "unavailable" });
        }
      }
      // The viewer's own entries in each unit that has a header (a few hundred bytes each).
      const need: Array<{ scope: string; id: string; key: { pk: string; sk: string } }> = [];
      for (const [scope, header] of headers) {
        for (const id of new Set(viewer?.ids(header.source) ?? [])) if (!entryFor(scope).has(id)) need.push({ scope, id, key: recordAccessMemberKey(orgId, scope, id) });
      }
      let found: Map<string, Item> | undefined;
      if (need.length > 0) {
        try { found = await batchGetAll(table, need.map((entry) => entry.key), sleep); } catch { found = undefined; }
      }
      for (const [scope, header] of headers) {
        const mine = need.filter((entry) => entry.scope === scope);
        if (found === undefined && mine.length > 0) { states.set(scope, { kind: "unavailable" }); continue; }
        for (const entry of mine) {
          const item = found?.get(entry.key.sk);
          entryFor(scope).set(entry.id, typeof item?.v === "string" ? item.v : null);
        }
        const values = new Map<string, string>();
        for (const [id, value] of entryFor(scope)) if (value !== null) values.set(id, value);
        states.set(scope, { kind: "ok", header, entries: values });
      }
    },
    get: (scope) => states.get(scope) ?? { kind: "unavailable" },
  };
}

export type AccessVerdict = "allow" | "deny" | "unavailable";

/** The units a row depends on: its own restricted unit(s), the places it came from, and every place above each. `own` units must have a record (a missing one denies). */
export function accessScopesOf(row: { scope?: string | undefined; scopes?: readonly string[] | undefined; audience: Audience; restrictedScopes?: readonly string[] | undefined }): { all: string[]; own: readonly string[]; capturedAt: string | undefined } {
  const own = row.restrictedScopes ?? (row.audience.kind === "restricted" ? [row.audience.acl.scope] : []);
  const direct = [...own, ...(row.scope === undefined ? [] : [row.scope]), ...(row.scopes ?? [])];
  return { all: [...new Set(direct.flatMap((scope) => scopeAndAncestors(scope)))], own, capturedAt: row.audience.kind === "restricted" ? row.audience.acl.capturedAt : undefined };
}

/**
 * The verdict of the read-time check for the units a row depends on. A restricted unit needs the viewer among its members (or groups); a unit never seeded is an overlay (the
 * row's own snapshot, already checked by the caller, decides, unless a removal newer than that snapshot names the viewer); a missing record denies an `own` unit and is skipped
 * for a place above; a record that could not be read is "unavailable", never allowed.
 */
export function judgeAccess(reader: AccessReader, viewer: AccessViewer | undefined, units: { all: readonly string[]; own: readonly string[]; capturedAt: string | undefined }): AccessVerdict {
  let unavailable = false;
  for (const scope of units.all) {
    const state = reader.get(scope);
    if (state.kind === "unavailable") { unavailable = true; continue; }
    if (state.kind === "absent") {
      if (units.own.includes(scope)) return "deny";
      continue;
    }
    const { header, entries } = state;
    if (header.mode !== "restricted") continue;
    if (viewer === undefined) {
      if (header.seeded) return "deny";
      continue;
    }
    const ids = viewer.ids(header.source);
    if (!header.seeded) {
      // Overlay: only removals count, and only those newer than the snapshot the row carries.
      for (const id of ids) {
        const value = entries.get(id);
        if (value !== undefined && !isMemberValue(value) && (units.capturedAt === undefined || timeOfValue(value) >= units.capturedAt)) return "deny"; // a removal at the same time as the snapshot beats it, as everywhere else
      }
      continue;
    }
    if (ids.some((id) => { const value = entries.get(id); return value !== undefined && isMemberValue(value); })) continue;
    const callerGroups = viewer.groups(header.source);
    if (header.groups.some((group) => (group === MAINTAINERS_GROUP ? viewer.maintainer : callerGroups.includes(group)))) continue;
    return "deny";
  }
  return unavailable ? "unavailable" : "allow";
}
