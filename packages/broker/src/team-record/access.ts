// The access record of a place (fix round 8): ONE item per place holding who may read what was recorded there. Reads check it for every hit, before anything is returned;
// the audience on each row is only a coarse pre-filter now (it can be stale, and the catch-up rewrite brings it back in line). So a removed person cannot be given access
// back by a stale row, a replayed queue item, a crash in the middle of a rewrite, or a message built from a cached member list.
//
// Per person the record keeps one string, `<iso time>|<0 or 1>` (0 = a member, 1 = removed), and an event replaces it only if its own string is GREATER: a newer event always
// wins, an older one never overrides, and at the same time a removal beats an add (1 sorts after 0). Each event is one conditional write per person.
// Who feeds the record: member and audience events (Slack: the event's own `event_ts`) once any has arrived, until then the snapshots on the rows themselves (sources with no
// change feed, such as a code host, where a newer snapshot replaces an older one). After the first event a row's snapshot never changes the record again.
import { BatchGetCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ACL_PRINCIPALS_MAX, scopeAndAncestors, recordAccessKey, type AclSnapshot, type Audience, type OrgId } from "@agentx/contracts";
import { Aliases, errorName, type Item } from "../agents/table-writes.js";
import type { TeamRecordTable } from "./types.js";

/** The most person entries a record keeps. Past it the oldest removals are dropped first (a removal that old has no older add left to guard against). */
const MEMBERS_MAX = 4_000;
const REV_RETRIES = 4;
const BATCH_KEYS = 100;
const UNPROCESSED_RETRIES = 3;
/** The most distinct places one request looks up; past it the rest read as unreadable (fail closed). */
export const ACCESS_SCOPES_PER_REQUEST_MAX = 1_000;

export interface AccessRecord {
  scope: string;
  source: string;
  /** `restricted`: only the members (and groups) below; `open`: this place no longer limits who reads its rows. */
  mode: "restricted" | "open";
  groups: string[];
  liveCheck: "none" | "on_read";
  /** person id to `<iso>|0` (member) or `<iso>|1` (removed). */
  members: Record<string, string>;
  modeTs: string;
  fed: "snapshot" | "events";
  snapshotTs?: string;
  rev: number;
}

export type AccessLookup = AccessRecord | "absent" | "unreadable";

/** What a snapshot taken from a row counts as: older than any event, so the first member or audience event always applies over it. */
const EPOCH = "1970-01-01T00:00:00.000Z";

const isoOf = (at: string): string => {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) throw new Error("team-record: an access change needs a valid time");
  return parsed.toISOString();
};
const memberValue = (iso: string, removed: boolean): string => `${iso}|${removed ? "1" : "0"}`;
const isMember = (value: string): boolean => value.endsWith("|0");

/** The place's source ("slack:T1/C9" is "slack"). */
export const sourceOfScope = (scope: string): string => scope.split(":", 1)[0] ?? scope;

/** The current members as a permission snapshot: what a read checks a caller against. At most 500 members; the rest are denied (the safe side). */
export function aclOfAccess(record: AccessRecord): AclSnapshot {
  const principals = Object.entries(record.members).filter(([, value]) => isMember(value)).map(([id]) => id).sort().slice(0, ACL_PRINCIPALS_MAX);
  return {
    source: record.source, scope: record.scope, ...(principals.length === 0 ? {} : { principals }), ...(record.groups.length === 0 ? {} : { groups: record.groups }),
    capturedAt: record.modeTs, liveCheck: record.liveCheck,
  };
}

function parseRecord(item: Item | undefined): AccessRecord | undefined {
  if (item === undefined || item.entityType !== "TEAM_RECORD_ACCESS") return undefined;
  const members = item.members;
  if (typeof item.scope !== "string" || typeof item.source !== "string" || (item.mode !== "restricted" && item.mode !== "open") || typeof item.modeTs !== "string") throw new Error("malformed access record");
  if (members === null || typeof members !== "object" || Array.isArray(members)) throw new Error("malformed access record");
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(members as Record<string, unknown>)) {
    if (typeof value !== "string" || !/\|[01]$/.test(value)) throw new Error("malformed access record");
    out[id] = value;
  }
  const groups = Array.isArray(item.groups) ? item.groups.filter((group): group is string => typeof group === "string") : [];
  return {
    scope: item.scope, source: item.source, mode: item.mode, groups, liveCheck: item.liveCheck === "on_read" ? "on_read" : "none", members: out, modeTs: item.modeTs,
    fed: item.fed === "snapshot" ? "snapshot" : "events", ...(typeof item.snapshotTs === "string" ? { snapshotTs: item.snapshotTs } : {}), rev: typeof item.rev === "number" ? item.rev : 0,
  };
}

const itemOf = (orgId: OrgId, record: AccessRecord): Item => ({ ...recordAccessKey(orgId, record.scope), entityType: "TEAM_RECORD_ACCESS", ...record });

/** Keeps the newest entries when a record outgrows its bound: removals go first, oldest first. */
function trimmed(members: Record<string, string>): Record<string, string> {
  const entries = Object.entries(members);
  if (entries.length <= MEMBERS_MAX) return members;
  const removed = entries.filter(([, value]) => !isMember(value)).sort((left, right) => left[1].localeCompare(right[1]));
  const drop = new Set(removed.slice(0, entries.length - MEMBERS_MAX).map(([id]) => id));
  return Object.fromEntries(entries.filter(([id]) => !drop.has(id)));
}

async function getRecord(table: TeamRecordTable, orgId: OrgId, scope: string): Promise<AccessRecord | undefined> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: recordAccessKey(orgId, scope), ConsistentRead: true })) as { Item?: Item };
  return parseRecord(response.Item);
}

// ---- writes

/**
 * People joined or left a place: ONE conditional write per person, carrying the event's own time. An older event for the same person never overrides a newer one, and a
 * removal beats an add of the same time. Removals are written first. Returns how many writes changed the record.
 */
export async function applyMemberEvents(table: TeamRecordTable, orgId: OrgId, input: { scope: string; add?: readonly string[]; remove?: readonly string[]; at: string }): Promise<number> {
  const iso = isoOf(input.at);
  const people = [...(input.remove ?? []).map((id) => ({ id, removed: true })), ...(input.add ?? []).map((id) => ({ id, removed: false }))];
  if (people.length === 0) return 0;
  await ensureRecord(table, orgId, input.scope, iso);
  let changed = 0;
  for (const person of people) {
    const aliases = new Aliases();
    const who = aliases.name(person.id);
    const value = aliases.value(memberValue(iso, person.removed));
    try {
      await table.documentClient.send(new UpdateCommand({
        TableName: table.tableName,
        Key: recordAccessKey(orgId, input.scope),
        UpdateExpression: `SET ${aliases.name("members")}.${who} = ${value}, ${aliases.name("fed")} = ${aliases.value("events")}, ${aliases.name("rev")} = ${aliases.name("rev")} + ${aliases.value(1)}`,
        ConditionExpression: `attribute_exists(${aliases.name("pk")}) AND (attribute_not_exists(${aliases.name("members")}.${who}) OR ${aliases.name("members")}.${who} < ${value})`,
        ExpressionAttributeNames: aliases.names,
        ExpressionAttributeValues: aliases.values,
      }));
      changed += 1;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
  }
  return changed;
}

/** A person event on a place with no record yet makes one: restricted, nobody in it, to be filled by the events. */
async function ensureRecord(table: TeamRecordTable, orgId: OrgId, scope: string, iso: string): Promise<void> {
  const record: AccessRecord = { scope, source: sourceOfScope(scope), mode: "restricted", groups: [], liveCheck: "none", members: {}, modeTs: iso, fed: "events", rev: 0 };
  try {
    await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: itemOf(orgId, record), ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") throw error;
  }
}

/**
 * A place turned private or public, or its audience was replaced: the new list is merged person by person under the same rule (an entry newer than the event stays, a
 * removal wins a tie), and the mode and groups change only if the event is not older than the last one. Optimistic: retried when another write got in between.
 */
export async function applyAudienceEvent(table: TeamRecordTable, orgId: OrgId, input: { scope: string; audience: Audience; at: string }): Promise<void> {
  const iso = isoOf(input.at);
  for (let attempt = 0; attempt < REV_RETRIES; attempt += 1) {
    const existing = await getRecord(table, orgId, input.scope);
    const base: AccessRecord = existing ?? { scope: input.scope, source: sourceOfScope(input.scope), mode: "open", groups: [], liveCheck: "none", members: {}, modeTs: "", fed: "events", rev: 0 };
    const members = { ...base.members };
    // The mode of a place fed by snapshots so far is not an event time: the first event is current, whatever time the snapshot carried.
    const current = base.fed === "snapshot" || base.modeTs <= iso;
    let next: AccessRecord;
    if (input.audience.kind === "restricted") {
      const principals = new Set(input.audience.acl.principals ?? []);
      for (const id of principals) {
        const value = memberValue(iso, false);
        if (members[id] === undefined || members[id] < value) members[id] = value;
      }
      for (const [id, value] of Object.entries(members)) {
        if (!principals.has(id) && isMember(value)) {
          const gone = memberValue(iso, true);
          if (value < gone) members[id] = gone;
        }
      }
      next = { ...base, members: trimmed(members), fed: "events", ...(current ? { mode: "restricted" as const, groups: [...(input.audience.acl.groups ?? [])], liveCheck: input.audience.acl.liveCheck, source: input.audience.acl.source, modeTs: iso } : {}), rev: base.rev + 1 };
    } else {
      next = { ...base, fed: "events", ...(current ? { mode: "open" as const, modeTs: iso } : {}), rev: base.rev + 1 };
    }
    try {
      const aliases = new Aliases();
      await table.documentClient.send(new PutCommand({
        TableName: table.tableName,
        Item: itemOf(orgId, next),
        ConditionExpression: existing === undefined ? `attribute_not_exists(${aliases.name("pk")})` : `${aliases.name("rev")} = ${aliases.value(base.rev)}`,
        ExpressionAttributeNames: aliases.names,
        ...(existing === undefined ? {} : { ExpressionAttributeValues: aliases.values }),
      }));
      return;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
  }
  throw new Error("team-record: the access record of a place is busy; try again");
}

/**
 * A stored restricted row brings its snapshot to the record. The first row of a place creates the record. After that the snapshot of a NEWER row replaces the list, but only
 * while no member or audience event has reached the record (a place with a change feed is fed by it alone: a snapshot built from a cached list must never grant again).
 */
export async function observeRowAccess(table: TeamRecordTable, orgId: OrgId, acl: AclSnapshot): Promise<void> {
  const iso = isoOf(acl.capturedAt);
  const principals = [...new Set(acl.principals ?? [])];
  const fresh = (): AccessRecord => ({
    scope: acl.scope, source: acl.source, mode: "restricted", groups: [...(acl.groups ?? [])], liveCheck: acl.liveCheck, members: Object.fromEntries(principals.map((id) => [id, memberValue(EPOCH, false)])),
    modeTs: EPOCH, fed: "snapshot", snapshotTs: iso, rev: 0,
  });
  for (let attempt = 0; attempt < REV_RETRIES; attempt += 1) {
    const existing = await getRecord(table, orgId, acl.scope);
    if (existing === undefined) {
      try {
        await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: itemOf(orgId, fresh()), ConditionExpression: "attribute_not_exists(pk)" }));
        return;
      } catch (error) {
        if (errorName(error) !== "ConditionalCheckFailedException") throw error;
        continue;
      }
    }
    if (existing.fed !== "snapshot" || (existing.snapshotTs !== undefined && existing.snapshotTs >= iso)) return;
    const same = existing.mode === "restricted" && existing.groups.join("\u0000") === (acl.groups ?? []).join("\u0000")
      && principals.length === Object.values(existing.members).filter(isMember).length && principals.every((id) => existing.members[id] !== undefined && isMember(existing.members[id]));
    const members: Record<string, string> = { ...existing.members };
    for (const id of principals) members[id] = memberValue(EPOCH, false);
    for (const [id, value] of Object.entries(members)) if (!principals.includes(id) && isMember(value)) members[id] = memberValue(EPOCH, true);
    if (same) return; // nothing to change; a newer row with the same list leaves the record as it is
    const next: AccessRecord = { ...existing, mode: "restricted", groups: [...(acl.groups ?? [])], liveCheck: acl.liveCheck, members: trimmed(members), modeTs: EPOCH, snapshotTs: iso, rev: existing.rev + 1 };
    try {
      const aliases = new Aliases();
      await table.documentClient.send(new PutCommand({
        TableName: table.tableName, Item: itemOf(orgId, next),
        ConditionExpression: `${aliases.name("rev")} = ${aliases.value(existing.rev)} AND ${aliases.name("fed")} = ${aliases.value("snapshot")}`,
        ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
      }));
      return;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
  }
  throw new Error("team-record: the access record of a place is busy; try again");
}

// ---- reads

/**
 * Looks places up for ONE request: the records are fetched in batches (consistent reads, at most 100 keys a call) and kept for the rest of the request. A place whose record
 * cannot be read reads as `unreadable`, and the caller drops what depends on it.
 */
export interface AccessReader {
  load(scopes: Iterable<string>): Promise<void>;
  get(scope: string): AccessLookup;
}

export function createAccessReader(table: TeamRecordTable, orgId: OrgId): AccessReader {
  const known = new Map<string, AccessLookup>();
  return {
    async load(scopes) {
      const wanted = [...new Set(scopes)].filter((scope) => !known.has(scope));
      const take = wanted.slice(0, ACCESS_SCOPES_PER_REQUEST_MAX);
      for (const scope of wanted.slice(ACCESS_SCOPES_PER_REQUEST_MAX)) known.set(scope, "unreadable");
      for (let at = 0; at < take.length; at += BATCH_KEYS) {
        const chunk = take.slice(at, at + BATCH_KEYS);
        try {
          await fetchChunk(table, orgId, chunk, known);
        } catch {
          for (const scope of chunk) if (!known.has(scope)) known.set(scope, "unreadable");
        }
      }
    },
    get: (scope) => known.get(scope) ?? "unreadable",
  };
}

async function fetchChunk(table: TeamRecordTable, orgId: OrgId, chunk: string[], known: Map<string, AccessLookup>): Promise<void> {
  const keyed = new Map(chunk.map((scope) => [recordAccessKey(orgId, scope).sk, scope] as const));
  let keys = chunk.map((scope) => recordAccessKey(orgId, scope));
  for (let attempt = 0; keys.length > 0; attempt += 1) {
    if (attempt > UNPROCESSED_RETRIES) throw new Error("access records unavailable");
    const response = await table.documentClient.send(new BatchGetCommand({ RequestItems: { [table.tableName]: { Keys: keys, ConsistentRead: true } } })) as { Responses?: Record<string, Item[]>; UnprocessedKeys?: Record<string, { Keys: Array<{ pk: string; sk: string }> }> };
    for (const item of response.Responses?.[table.tableName] ?? []) {
      const scope = typeof item.sk === "string" ? keyed.get(item.sk) : undefined;
      if (scope === undefined) continue;
      try {
        const record = parseRecord(item);
        known.set(scope, record === undefined || record.scope !== scope ? "unreadable" : record);
      } catch {
        known.set(scope, "unreadable");
      }
    }
    keys = response.UnprocessedKeys?.[table.tableName]?.Keys ?? [];
  }
  for (const scope of chunk) if (!known.has(scope)) known.set(scope, "absent");
}

/** The places a row depends on: its own, the ones a note was distilled from, the restricted snapshot's, and every place above each. */
export function accessScopesOf(row: { scope?: string | undefined; scopes?: readonly string[] | undefined; audience: Audience }): { all: string[]; own: string | undefined } {
  const own = row.audience.kind === "restricted" ? row.audience.acl.scope : undefined;
  const direct = [own, row.scope, ...(row.scopes ?? [])].filter((scope): scope is string => scope !== undefined);
  return { all: [...new Set(direct.flatMap((scope) => scopeAndAncestors(scope)))], own };
}
