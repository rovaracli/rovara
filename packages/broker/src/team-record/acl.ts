// The permission filter of the Team record (design 4.4.2): a row is visible to a caller only if they are in the project, the row's audience allows them,
// the row is not tombstoned, and (for a restricted `on_read` source) the source still says yes. Everything here fails closed: an unmapped identity, an empty
// snapshot, a missing or failing live check and a row that does not parse all read as "not visible". The check runs in the broker on every hit; a vector or
// query filter upstream is only a coarse cut.
import { MAINTAINERS_GROUP, type AclSnapshot, type Audience, type RecordTombstone } from "@agentx/contracts";
import type { LiveAclCheck, ReadAudience, RecordCaller } from "./types.js";

/** How long a live re-check answer is reused, per caller and scope (design 4.4.2). */
export const LIVE_CHECK_CACHE_MS = 15 * 60_000;
const LIVE_CHECK_CACHE_MAX = 2_000;

/** A row as the filter needs it. */
export interface Visible {
  audience: Audience;
  tombstone?: RecordTombstone | undefined;
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
  /** Scopes whose rows are hidden at once while their delete is still running (`system|scope` is not needed: a scope is already prefixed with its source). */
  hiddenScopes?: ReadonlySet<string>;
}

export interface FilterResult<T> {
  visible: T[];
  /** Rows the caller may not see. Tombstoned rows are not counted: they no longer exist for anyone. */
  withheld: number;
}

/** The scope a row's audience names, for the hidden-scope check. */
function scopeOf(row: Visible & { scope?: string | undefined }): string | undefined {
  return row.scope ?? (row.audience.kind === "restricted" ? row.audience.acl.scope : undefined);
}

/**
 * Splits rows into what this audience may see and a count of what it may not. A restricted row whose snapshot says `on_read` also needs a live check that passes
 * (cached 15 minutes per caller and scope), whether the audience is a person or a private task's owner. A shared task never sees a restricted row at all.
 */
export async function filterVisible<T extends Visible & { scope?: string | undefined }>(rows: readonly T[], audience: ReadAudience, dependencies: FilterDependencies = {}): Promise<FilterResult<T>> {
  const now = dependencies.now ?? Date.now;
  const visible: T[] = [];
  let withheld = 0;
  const checked = new Map<string, boolean>();
  for (const row of rows) {
    if (row.tombstone !== undefined) continue;
    const scope = scopeOf(row);
    if (scope !== undefined && dependencies.hiddenScopes?.has(scope) === true) continue;
    if (!visibleWithoutLiveCheck(audience, row)) {
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
