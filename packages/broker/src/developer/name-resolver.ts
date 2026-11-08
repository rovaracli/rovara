// ERASE-NAME-1 / ERASE-NAME-2: the ONE read-time rule for a stored copy of a person's name. A task, a comment, a suggestion, a session or a notice keeps the name its person had when it was written
// (often the name they chose), so a surface that shows it asks here, by the stored person's id, and gets back the name that REPLACES the stored copy, or nothing (the copy stands):
//   - an erased person reads "A former member". Erased means any of: the tombstone in the name item (State table), or the audit ledger's tombstone for the person (keys table, written by every erase
//     request, also those from before the name item had a tombstone), so no backfill is needed;
//   - a person removed from the company (the removal marker in the name item, and not a member again) reads as their sign-in record's name, or the placeholder: never the name they chose.
// One BatchGetItem for the name items, one read per person for the rest, results kept briefly (an erase is permanent, so a "yes" is kept; a "no" for half a minute). A read that fails leaves the copy as stored,
// like every other best-effort name overlay.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { orgMemberKey, type OrgId } from "@agentx/contracts";
import { FORMER_MEMBER_NAME, eraseChosenName, readNameItems, type ChosenNameClient, type ChosenNameItem } from "./chosen-name.js";
import { placeholderDisplayName, safeDisplayName } from "./person-name.js";

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
  // A person erased before the name item had a tombstone: leave it now, so the readers that cannot ask the ledger (member lists) read it too. Best effort; repeatable.
  try { await eraseChosenName(deps.documentClient, deps.tableName, developerId, erasedAt); } catch { erasedSeen.delete(cacheKey); /* the next read asks the ledger again and tries again */ }
  return true;
}

/**
 * developerId to the name that replaces a stored copy of it, for the people among `developerIds` who need one (erased, or removed). Everyone else is absent: their stored copy stands.
 * Never throws; a lookup that fails leaves that person (or all of them) out.
 */
export async function replacementNames(deps: NameResolverDependencies, developerIds: Iterable<string>, now: () => number = Date.now): Promise<Map<string, string>> {
  const unique = [...new Set(developerIds)].filter((id): id is string => typeof id === "string" && SUBJECT_ID.test(id)).slice(0, MOST_IDS);
  if (unique.length === 0) return new Map();
  try {
    return await replacementNamesFrom(deps, unique, await readNameItems(deps.documentClient, deps.tableName, unique), now);
  } catch {
    return new Map(); // the copies stand as stored
  }
}

/** `replacementNames` for a caller that has already read the name items of `unique` (one BatchGetItem for both uses). */
export async function replacementNamesFrom(deps: NameResolverDependencies, unique: readonly string[], items: ReadonlyMap<string, ChosenNameItem>, now: () => number = Date.now): Promise<Map<string, string>> {
  const replaced = new Map<string, string>();
  try {
    const others: string[] = [];
    const removed: string[] = [];
    for (const id of unique) {
      const item = items.get(id);
      if (item?.erased === true) replaced.set(id, FORMER_MEMBER_NAME);
      else { others.push(id); if (item?.removed === true) removed.push(id); }
    }
    const keysTable = deps.keysTable ?? process.env["AUDIT_KEYS_TABLE_NAME"];
    if (keysTable !== undefined && keysTable !== "" && deps.orgId !== undefined) {
      const orgId = deps.orgId;
      await inChunks(others, async (id) => {
        try { if (await erasedByAudit(deps, keysTable, orgId, id, now())) replaced.set(id, FORMER_MEMBER_NAME); } catch { /* this person stays as stored */ }
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
      } catch { /* this person stays as stored */ }
    });
  } catch {
    // the copies stand as stored
  }
  return replaced;
}

/** The name to show for a stored copy: the replacement when the person has one, else the copy. */
export function shownNameOf(stored: string, developerId: string, replacements: ReadonlyMap<string, string>): string {
  return replacements.get(developerId) ?? stored;
}

/** The resolver's dependencies from any dependency bag that has the State table's client and name (and, optionally, the sign-in table's name), for one company. */
export function nameResolverOf(deps: { documentClient: ChosenNameClient; tableName: string; developer?: { signInTableName?: string | undefined } | undefined }, orgId?: string): NameResolverDependencies {
  return { documentClient: deps.documentClient, tableName: deps.tableName, orgId, signInTable: deps.developer?.signInTableName };
}

/** `replacementNames` for one stored copy of one person's name: the name to show. */
export async function resolveStoredName(deps: NameResolverDependencies, developerId: string, stored: string): Promise<string> {
  return shownNameOf(stored, developerId, await replacementNames(deps, [developerId]));
}
