// ERASE-NAME-1 / ERASE-NAME-2: the ONE read-time rule for a stored copy of a person's name. A task, a comment, a suggestion, a session or a notice keeps the name its person had when it was written
// (often the name they chose), so a surface that shows it asks here, by the stored person's id, and gets back the name that REPLACES the stored copy, or nothing (the copy stands):
//   - an erased person reads "A former member". Erased means any of: the tombstone in the name item (State table), or the audit ledger's tombstone for the person (keys table, written by every erase
//     request, also those from before the name item had a tombstone), so no backfill is needed;
//   - a person removed from the company (the removal marker in the name item, and not a member again) reads as their sign-in record's name, or the placeholder: never the name they chose.
// ERASED-REJOIN-NAME: an erased person who came back and chose a new name keeps the tombstone in the name item (same developer id), and the item also holds the new name and when it was chosen. A stored copy
// of the name is replaced by "A former member" unless the surface can say when the copy was written (`writtenAt`) and that is on or after the day the new name was chosen: the copy then belongs to the new
// membership and stands. A surface with no time for its copy gets "A former member" (the safe side).
// One BatchGetItem for the name items, one read per person for the rest, results kept briefly (an erase is permanent, so a "yes" is kept; a "no" for half a minute). The resolver only READS: it never writes the
// ledger's answer into the name item. (A write here could destroy the chosen name in the gap between the ledger's tombstone and the Asks step that hashes the name; the erase's `names` step writes the tombstone,
// after the hashes are kept.) A read that FAILS shows `UNAVAILABLE_NAME` ("A member") for the people it could not settle, never the stored copy: for an erased person that copy is the name to hide. The failure is logged (a count and
// the error's name, never a name).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { FORMER_MEMBER_NAME, readNameItems, rejoinedOf, type ChosenNameClient, type ChosenNameItem } from "./chosen-name.js";
import { isPlaceholderDisplayName, placeholderDisplayName, safeDisplayName } from "./person-name.js";

export interface NameResolverDependencies {
  documentClient: ChosenNameClient;
  /** The State table. */
  tableName: string;
  /** The company the surface is about: the audit tombstone and the membership are looked up in it. Without it only the name item decides. */
  orgId?: string | undefined;
  /** The sign-in table, for the name a removed person shows as. Without it a removed person shows as the placeholder. */
  signInTable?: string | undefined;
  /** The audit ledger's keys table. Default: the environment's `AUDIT_KEYS_TABLE_NAME` (the broker's), when it has one. */
  keysTable?: string | undefined;
}

/**
 * The replacements for a set of people: developerId to the name that replaces a stored copy. For a person who was erased and chose a new name afterwards, `rejoinedAt` says when (the new name's time):
 * their replacement is still "A former member", which `shownNameOf` lifts only for a copy written at or after that time.
 */
export class NameReplacements extends Map<string, string> {
  readonly rejoinedAt = new Map<string, string>();
  /** developerId to the name they chose for the new membership: what anything from the new membership reads as. */
  readonly rejoinedAs = new Map<string, string>();
  /**
   * For a list of the people who are here NOW (members, project members): a person who was erased and came back is shown by the name they chose for the new membership, which the record already carries,
   * so they are left out. Nothing else changes.
   */
  currentOnly(): NameReplacements {
    const current = new NameReplacements();
    for (const [id, name] of this) if (!this.rejoinedAt.has(id)) current.set(id, name);
    return current;
  }
}

/** What a stored copy reads when the lookup that decides it fails: neither the stored name nor a claim about the person. */
export const UNAVAILABLE_NAME = "A member";

export function logNameLookupFailure(where: string, error: unknown, people: number): void {
  console.log(JSON.stringify({ event: "name_resolver_unavailable", level: "error", where, people, error: error instanceof Error ? error.name : "unknown" }));
}

const SUBJECT_ID = /^[A-Za-z0-9_.-]{1,100}$/u;
const MOST_IDS = 500;
const LOOKUPS_AT_ONCE = 16;
const NEGATIVE_MS = 30_000;
const CACHE_MAX = 5_000;
const erasedSeen = new Set<string>();
const notErasedUntil = new Map<string, number>();

/** Forgets what was kept (for tests). */
export function forgetResolvedNames(): void {
  erasedSeen.clear();
  notErasedUntil.clear();
}

async function inChunks<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += LOOKUPS_AT_ONCE) await Promise.all(items.slice(start, start + LOOKUPS_AT_ONCE).map(run));
}

async function erasedByAudit(deps: NameResolverDependencies, keysTable: string, orgId: string, developerId: string, now: number): Promise<boolean> {
  const cacheKey = `${keysTable}|${orgId}|${developerId}`;
  if (erasedSeen.has(cacheKey)) return true;
  if ((notErasedUntil.get(cacheKey) ?? 0) > now) return false;
  const response = await deps.documentClient.send(new GetCommand({ TableName: keysTable, Key: { pk: `ORG#${orgId}`, sk: `SUBJECT#${developerId}` }, ConsistentRead: true })) as { Item?: { erasedAt?: unknown } };
  const erasedAt = typeof response.Item?.erasedAt === "string" ? response.Item.erasedAt : undefined;
  if (erasedSeen.size + notErasedUntil.size > CACHE_MAX) forgetResolvedNames();
  if (erasedAt === undefined) { notErasedUntil.set(cacheKey, now + NEGATIVE_MS); return false; }
  erasedSeen.add(cacheKey);
  return true;
}

/**
 * developerId to the name that replaces a stored copy of it, for the people among `developerIds` who need one (erased, or removed). Everyone else is absent: their stored copy stands.
 * Never throws. A person whose lookup fails (or all of them, when the name items cannot be read) gets `UNAVAILABLE_NAME`, and so does everyone past the first `MOST_IDS`; the failure is logged.
 */
export async function replacementNames(deps: NameResolverDependencies, developerIds: Iterable<string>, now: () => number = Date.now): Promise<NameReplacements> {
  const valid = [...new Set(developerIds)].filter((id): id is string => typeof id === "string" && SUBJECT_ID.test(id));
  const unique = valid.slice(0, MOST_IDS);
  if (unique.length === 0) return new NameReplacements();
  let replaced: NameReplacements;
  try {
    replaced = await replacementNamesFrom(deps, unique, await readNameItems(deps.documentClient, deps.tableName, unique), now);
  } catch (error) {
    logNameLookupFailure("name_items", error, unique.length);
    replaced = new NameReplacements(unique.map((id) => [id, UNAVAILABLE_NAME]));
  }
  if (valid.length > MOST_IDS) {
    logNameLookupFailure("too_many_people", undefined, valid.length);
    for (const id of valid.slice(MOST_IDS)) replaced.set(id, UNAVAILABLE_NAME);
  }
  return replaced;
}

/** `replacementNames` for a caller that has already read the name items of `unique` (one BatchGetItem for both uses). */
export async function replacementNamesFrom(deps: NameResolverDependencies, unique: readonly string[], items: ReadonlyMap<string, ChosenNameItem>, now: () => number = Date.now): Promise<NameReplacements> {
  const replaced = new NameReplacements();
  const unsettled: unknown[] = [];
  try {
    const others: string[] = [];
    const removed: string[] = [];
    for (const id of unique) {
      const item = items.get(id);
      if (item?.erased === true) {
        replaced.set(id, FORMER_MEMBER_NAME);
        const rejoined = rejoinedOf(item, id);
        if (rejoined !== undefined) { replaced.rejoinedAt.set(id, rejoined.at); replaced.rejoinedAs.set(id, rejoined.name); }
      } else { others.push(id); if (item?.removed === true) removed.push(id); }
    }
    const keysTable = deps.keysTable ?? process.env["AUDIT_KEYS_TABLE_NAME"];
    if (keysTable !== undefined && keysTable !== "" && deps.orgId !== undefined) {
      const orgId = deps.orgId;
      await inChunks(others, async (id) => {
        try { if (await erasedByAudit(deps, keysTable, orgId, id, now())) replaced.set(id, FORMER_MEMBER_NAME); } catch (error) { unsettled.push(error); replaced.set(id, UNAVAILABLE_NAME); }
      });
    }
    await inChunks(removed.filter((id) => !replaced.has(id)), async (id) => {
      try {
        if (deps.orgId !== undefined) {
          const member = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(deps.orgId, id), ConsistentRead: true }))) as { Item?: unknown };
          if (member.Item !== undefined) return; // came back: the marker is old
        }
        let name = placeholderDisplayName(id);
        if (deps.signInTable !== undefined) {
          const record = (await deps.documentClient.send(new GetCommand({ TableName: deps.signInTable, Key: { pk: `DEVELOPER#${id}`, sk: "META" } }))) as { Item?: { displayName?: unknown } };
          if (typeof record.Item?.displayName === "string" && record.Item.displayName !== "") name = safeDisplayName(record.Item.displayName, id);
        }
        replaced.set(id, name);
      } catch (error) { unsettled.push(error); replaced.set(id, UNAVAILABLE_NAME); }
    });
  } catch (error) {
    unsettled.push(error);
    for (const id of unique) if (!replaced.has(id)) replaced.set(id, UNAVAILABLE_NAME);
  }
  if (unsettled.length > 0) logNameLookupFailure("lookup", unsettled[0], unsettled.length);
  return replaced;
}

/** A time as epoch milliseconds: an ISO string, or milliseconds already. NaN when it can't be read. */
function millisOf(time: string | number): number {
  return typeof time === "number" ? time : Date.parse(time);
}

/**
 * ERASED-REJOIN-NAME: whether a copy of the person's name written at `writtenAt` belongs to the new membership of a person who was erased and came back (it was written on or after the day they chose the
 * name of the new membership). False when the person has not come back, when no time is known, and when the time can't be read: the copy is then treated as an old one.
 */
export function writtenInNewMembership(replacements: ReadonlyMap<string, string>, developerId: string, writtenAt: string | number | undefined): boolean {
  if (writtenAt === undefined || !(replacements instanceof NameReplacements)) return false;
  const since = replacements.rejoinedAt.get(developerId);
  if (since === undefined) return false;
  const written = millisOf(writtenAt);
  return Number.isFinite(written) && written >= Date.parse(since);
}

/**
 * The name to show for a stored copy: the replacement when the person has one, else the copy. `writtenAt` is when the copy was written, or the thing it names happened (the record's own time); with it, what
 * is from the new membership of an erased person who came back reads as the name they chose for it, and everything older reads "A former member". Without it a person who was ever erased reads "A former member".
 */
export function shownNameOf(stored: string, developerId: string, replacements: ReadonlyMap<string, string>, writtenAt?: string | number): string {
  const replacement = replacements.get(developerId);
  if (replacement === undefined) return stored;
  // Anything from the new membership reads as the name chosen for it (never the stored copy, which a surface may have kept from the old membership).
  return writtenInNewMembership(replacements, developerId, writtenAt) ? ((replacements as NameReplacements).rejoinedAs.get(developerId) ?? replacement) : replacement;
}

/** The resolver's dependencies from any dependency bag that has the State table's client and name (and, optionally, the sign-in table's name), for one company. */
export function nameResolverOf(deps: { documentClient: ChosenNameClient; tableName: string; developer?: { signInTableName?: string | undefined } | undefined }, orgId?: string): NameResolverDependencies {
  return { documentClient: deps.documentClient, tableName: deps.tableName, orgId, signInTable: deps.developer?.signInTableName };
}

/** `replacementNames` for one stored copy of one person's name: the name to show. */
export async function resolveStoredName(deps: NameResolverDependencies, developerId: string, stored: string, writtenAt?: string | number): Promise<string> {
  return shownNameOf(stored, developerId, await replacementNames(deps, [developerId]), writtenAt);
}

// ---- ERASE-NAME-2, the partial cover for words other people wrote

/** Words that stand for nobody in particular: never scrubbed (they would hit unrelated text). */
const GENERIC_NAMES = new Set(["someone", "a member", "a teammate", "a former member", "unknown", "member", "teammate", "you"].map((word) => word.toLowerCase()));
const SCRUB_NAMES_MAX = 20;
const SCRUB_NAME_MIN_CHARS = 3;
const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * The names stored with the work of people who are erased, from a page's actors (`copies`: the person's id and the name stored for them there): the exact words to blank out of OTHER people's text on the
 * same page. Bounded (20 names), at least 3 characters, and never a generic word or a placeholder. Only people the resolver replaced with "A former member" count; a removed person's chosen name is
 * not a name to blank out of a sentence (the sign-in name is a name as well, and it is theirs to show). `writtenAt` is when the copy was written (an event's time); a copy written in the new membership of an
 * erased person who came back is left out.
 */
export function erasedNamesOnPage(copies: Iterable<{ developerId: string; name: string; writtenAt?: string | number | undefined }>, replacements: ReadonlyMap<string, string>): string[] {
  const names = new Set<string>();
  for (const { developerId, name, writtenAt } of copies) {
    const trimmed = name.trim();
    // A copy from the new membership of a person who came back holds their new name: that one is not blanked out.
    if (replacements.get(developerId) !== FORMER_MEMBER_NAME || writtenInNewMembership(replacements, developerId, writtenAt) || trimmed.length < SCRUB_NAME_MIN_CHARS || GENERIC_NAMES.has(trimmed.toLowerCase()) || isPlaceholderDisplayName(trimmed)) continue;
    names.add(trimmed);
    if (names.size >= SCRUB_NAMES_MAX) break;
  }
  return [...names].sort((left, right) => right.length - left.length);
}

/**
 * `text` with each exact (case-sensitive, whole-word) occurrence of one of `names` replaced by "A former member". A name inside a longer word is left alone. `keep` are names that must survive whole (the new
 * names of people who came back): an occurrence of one is set aside while the rest is blanked, so an old name that is also a word of a new name ("Priya" in "Priya Rao") does not cut the new name up.
 */
export function scrubErasedNames(text: string, names: readonly string[], keep: readonly string[] = []): string {
  const kept: string[] = [];
  let scrubbed = text;
  for (const name of [...keep].sort((left, right) => right.length - left.length)) {
    if (name === "" || !scrubbed.includes(name) || !names.some((erased) => name.includes(erased))) continue;
    scrubbed = scrubbed.split(name).join(`\uE000${kept.push(name) - 1}\uE001`);
  }
  for (const name of names) {
    if (!scrubbed.includes(name)) continue;
    scrubbed = scrubbed.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeForPattern(name)}(?![\\p{L}\\p{N}])`, "gu"), FORMER_MEMBER_NAME);
  }
  return kept.length === 0 ? scrubbed : scrubbed.replace(/\uE000(\d+)\uE001/gu, (_whole, index: string) => kept[Number(index)] ?? "");
}
