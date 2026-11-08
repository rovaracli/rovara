// The permission filter of the Team record (design 4.4.2): a row is visible to a caller only if they are in the project, the row's audience allows them,
// the row is not tombstoned, and (for a restricted `on_read` source) the source still says yes. Everything here fails closed: an unmapped identity, an empty
// snapshot, a missing or failing live check and a row that does not parse all read as "not visible". The check runs in the broker on every hit; a vector or
// query filter upstream is only a coarse cut.
import { MAINTAINERS_GROUP, agentXError, type AclSnapshot, type Audience, type RecordTombstone } from "@agentx/contracts";
import { scopeAndAncestors, teamRecordSourceHash } from "@agentx/contracts";
import { accessScopesOf, judgeAccess, viewerOfCaller, type AccessReader, type AccessVerdict } from "./access.js";
import { rovaraTaskRefsOf, type LiveAudienceReader } from "./live-audience.js";
import type { LiveAclCheck, PendingHides, ReadAudience, RecordCaller } from "./types.js";

/** How long a live re-check answer is reused, per caller and scope (design 4.4.2). */
export const LIVE_CHECK_CACHE_MS = 15 * 60_000;
const LIVE_CHECK_CACHE_MAX = 2_000;

/** A row as the filter needs it. */
export interface Visible {
  audience: Audience;
  tombstone?: RecordTombstone | undefined;
  /** The place a row came from, or (for a fact) the places it was distilled from. */
  scope?: string | undefined;
  /** Source units that carry their own ACL (a lesson distilled from several): when given, they are the units the read-time check requires a record for. */
  restrictedScopes?: readonly string[] | undefined;
  scopes?: readonly string[] | undefined;
  /** The source item a row is (events), or the ones a fact was distilled from (`system:sourceId`). */
  sourceRef?: { system: string; id: string } | undefined;
  derivedFrom?: readonly string[] | undefined;
  /** For the live task check (`live-audience.ts`): a Rovara event names its task here or in its source id. */
  source?: string | undefined;
  structured?: Readonly<Record<string, string | number | boolean>> | undefined;
}

/** Whether a caller's identities satisfy a snapshot. No principals and no groups is an empty snapshot: nobody. */
export function satisfiesAcl(caller: RecordCaller, acl: AclSnapshot): boolean {
  const principals = acl.principals ?? [];
  const groups = acl.groups ?? [];
  if (principals.length === 0 && groups.length === 0) return false;
  const ids = caller.identities.ids[acl.source] ?? [];
  if (principals.length > 0 && ids.some((id) => principals.includes(id))) return true;
  const callerGroups = caller.identities.groups[acl.source] ?? [];
  for (const group of groups) {
    if (group === MAINTAINERS_GROUP) {
      if (caller.projectRole === "maintainer") return true;
      continue;
    }
    if (callerGroups.includes(group)) return true;
  }
  return false;
}

/** The part of the rule that needs no network: the project role, the tombstone and the snapshot. */
export function visibleWithoutLiveCheck(audience: ReadAudience, row: Visible): boolean {
  if (row.tombstone !== undefined) return false;
  if (audience.kind === "shared") return row.audience.kind === "project";
  const { caller } = audience;
  if (caller.projectRole === undefined) return false;
  if (row.audience.kind === "project") return true;
  return satisfiesAcl(caller, row.audience.acl);
}

export interface LiveCheckCache {
  get(key: string, now: number): boolean | undefined;
  set(key: string, value: boolean, now: number): void;
}

export function createLiveCheckCache(): LiveCheckCache {
  const entries = new Map<string, { value: boolean; at: number }>();
  return {
    get(key, now) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (now - entry.at >= LIVE_CHECK_CACHE_MS) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, now) {
      if (entries.size >= LIVE_CHECK_CACHE_MAX) entries.delete(entries.keys().next().value as string);
      entries.set(key, { value, at: now });
    },
  };
}

export interface FilterDependencies {
  /** Re-checks at the source. Without it, an `on_read` row is hidden (fail closed). */
  liveCheck?: LiveAclCheck;
  cache?: LiveCheckCache;
  now?: () => number;
  /** What queued work (a delete, a permission change) has not finished: those places and source items read as hidden from everyone. */
  pending?: PendingHides;
  /**
   * The access records of the units (one reader per request). Required: every hit is checked against the record of its own unit and of the places above it; the row's own
   * snapshot is a pre-filter, never the final word. A restricted row whose unit has no record is dropped; a record that cannot be read makes the call fail (unavailable).
   */
  access: AccessReader;
  /**
   * SRL-4: the live Plan 5 visibility of the tasks the rows are about (one reader per request). A row about a Rovara task is shown only if the task's visibility NOW also lets the reader in, on top of the
   * audience the row was recorded with. Absent, every row about a Rovara task is hidden (fail closed).
   */
  liveTasks?: LiveAudienceReader;
}

export interface FilterResult<T> {
  visible: T[];
  /** Rows the caller may not see. Tombstoned rows are not counted: they no longer exist for anyone. */
  withheld: number;
}

/** Whether queued, unfinished work hides the row: its place, one of its places, its source item, or a source item its fact was distilled from. */
export function hiddenByPending(row: Visible, pending: PendingHides | undefined): boolean {
  if (pending === undefined) return false;
  // A place that is being deleted or changed covers every place under it (`slack:T1` covers `slack:T1/C9`).
  const places = [row.scope, ...(row.scopes ?? []), ...(row.audience.kind === "restricted" ? [row.audience.acl.scope] : [])];
  if (places.some((place) => place !== undefined && scopeAndAncestors(place).some((above) => pending.scopes.has(above)))) return true;
  if (row.sourceRef !== undefined && pending.sourceHashes.has(teamRecordSourceHash(row.sourceRef.system, row.sourceRef.id))) return true;
  // A fact names its sources as `system:sourceId`, and a system may hold a colon (a host with a port, `mcp:x`), so every split point is tried: hiding too much is safe.
  for (const ref of row.derivedFrom ?? []) {
    for (let at = ref.indexOf(":"); at > 0; at = ref.indexOf(":", at + 1)) {
      if (at < ref.length - 1 && pending.sourceHashes.has(teamRecordSourceHash(ref.slice(0, at), ref.slice(at + 1)))) return true;
    }
  }
  return false;
}

/**
 * Splits rows into what this audience may see and a count of what it may not. A restricted row whose snapshot says `on_read` also needs a live check that passes
 * (cached 15 minutes per caller and scope), whether the audience is a person or a private task's owner. A shared task never sees a restricted row at all.
 */
export async function filterVisible<T extends Visible>(rows: readonly T[], audience: ReadAudience, dependencies: FilterDependencies): Promise<FilterResult<T>> {
  const now = dependencies.now ?? Date.now;
  const viewer = audience.kind === "caller" ? viewerOfCaller(audience.caller) : undefined;
  const candidates = rows.filter((row) => row.tombstone === undefined && visibleWithoutLiveCheck(audience, row));
  await dependencies.access.load(candidates.flatMap((row) => accessScopesOf(row).all), viewer);
  // SRL-4: the tasks the remaining rows are about, asked in one batch (and remembered for the rest of the request).
  const taskRefs = new Map<T, ReturnType<typeof rovaraTaskRefsOf>>();
  for (const row of candidates) {
    if (hiddenByPending(row, dependencies.pending)) continue;
    const refs = rovaraTaskRefsOf(row);
    if (refs !== undefined) taskRefs.set(row, refs);
  }
  await dependencies.liveTasks?.load([...taskRefs.values()].flatMap((refs) => (refs?.unreadable === true ? [] : refs?.taskIds ?? [])));
  let unavailable = false;
  const visible: T[] = [];
  let withheld = 0;
  const checked = new Map<string, boolean>();
  for (const row of rows) {
    if (row.tombstone !== undefined) continue;
    if (hiddenByPending(row, dependencies.pending)) continue;
    if (!visibleWithoutLiveCheck(audience, row)) {
      withheld += 1;
      continue;
    }
    const refs = taskRefs.get(row);
    if (refs !== undefined) {
      // A row about a Rovara task: a task whose visibility cannot be read hides its rows from everyone (not counted as hidden from this reader); a task that does not let this reader in counts as withheld.
      const live = refs.unreadable || dependencies.liveTasks === undefined ? "unreadable" : dependencies.liveTasks.verdictOf(audience, refs.taskIds);
      if (live === "unreadable") continue;
      if (live === "deny") {
        withheld += 1;
        continue;
      }
    }
    const verdict: AccessVerdict = judgeAccess(dependencies.access, viewer, accessScopesOf(row));
    if (verdict === "unavailable") { unavailable = true; continue; }
    if (verdict === "deny") {
      withheld += 1;
      continue;
    }
    if (audience.kind === "caller" && row.audience.kind === "restricted" && row.audience.acl.liveCheck === "on_read") {
      const key = `${audience.caller.orgId}|${audience.caller.developerId}|${row.audience.acl.source}|${row.audience.acl.scope}`;
      let answer = checked.get(key);
      if (answer === undefined) {
        answer = await liveAnswer(audience.caller, row.audience.acl, key, dependencies, now);
        checked.set(key, answer);
      }
      if (!answer) {
        withheld += 1;
        continue;
      }
    }
    visible.push(row);
  }
  // A record that could not be read is not "hidden" and never "visible": the whole call fails, so the person is told the record is unavailable.
  if (unavailable) throw agentXError("RUNTIME_UNAVAILABLE", "The team record can't be read right now.");
  return { visible, withheld };
}

async function liveAnswer(caller: RecordCaller, acl: AclSnapshot, key: string, dependencies: FilterDependencies, now: () => number): Promise<boolean> {
  const cached = dependencies.cache?.get(key, now());
  if (cached !== undefined) return cached;
  if (dependencies.liveCheck === undefined) return false;
  let answer: boolean;
  try {
    answer = (await dependencies.liveCheck({ caller, acl })) === true;
  } catch {
    // A source that cannot be reached is not an answer: the row stays hidden, and nothing is cached so the next read asks again.
    return false;
  }
  dependencies.cache?.set(key, answer, now());
  return answer;
}
