// An in-memory SavedEnvStore for tests: compare-and-set on the row's version, and the audit entries kept beside it.
import type { SavedEnvAuditEntry, SavedEnvState, SavedEnvStore } from "../../packages/broker/src/test-env/saved-env.js";

export interface MemorySavedEnvStore extends SavedEnvStore {
  rows: Map<string, SavedEnvState>;
  audit: SavedEnvAuditEntry[];
  /** Makes the next commit report that the row changed meanwhile. */
  failNextCommit(): void;
}

export function memorySavedEnvStore(): MemorySavedEnvStore {
  const rows = new Map<string, SavedEnvState>();
  const audit: SavedEnvAuditEntry[] = [];
  let failNext = false;
  const key = (orgId: string, projectId: string): string => `${orgId}#${projectId}`;
  return {
    rows, audit,
    failNextCommit() { failNext = true; },
    get: (orgId, projectId) => Promise.resolve(structuredClone(rows.get(key(orgId, projectId)))),
    commit(next, expectedVersion, entry) {
      if (failNext) { failNext = false; return Promise.resolve(false); }
      const current = rows.get(key(next.orgId, next.projectId));
      if ((current?.version ?? null) !== expectedVersion) return Promise.resolve(false);
      rows.set(key(next.orgId, next.projectId), structuredClone(next));
      audit.push(structuredClone(entry));
      return Promise.resolve(true);
    },
  };
}
