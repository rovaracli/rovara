// Design review (DR-FU4): the company's design review policy item (DESIGNREVIEW#LOCK) in a test table. A project runs design review only when `dr` is on AND the company allows it AND the project's mode is not Off,
// so a test that wants the stage to run seeds this once for its company. `defaultMode` is what a project with no setting of its own runs; the default here is `auto` (the mode the older tests assumed).
import { orgMetaKey } from "../../packages/contracts/src/index.js";
import { DESIGN_REVIEW_LOCK_SK, type DesignReviewLock } from "../../packages/broker/src/design-review/lock.js";

export interface CompanyPolicySeed { allowed?: boolean; defaultMode?: "never" | "auto" | "always"; lock?: DesignReviewLock; revision?: number }

/** Writes (replaces) the company's design review item. Returns the revision written. */
export function seedDesignReviewCompany(db: { set(item: Record<string, unknown>): void }, orgId: string, seed: CompanyPolicySeed = {}): number {
  const revision = seed.revision ?? 1;
  db.set({
    pk: orgMetaKey(orgId).pk, sk: DESIGN_REVIEW_LOCK_SK, entityType: "DESIGN_REVIEW_COMPANY", orgId, revision,
    lock: seed.lock ?? {}, policy: { allowed: seed.allowed ?? true, defaultMode: seed.defaultMode ?? "auto" },
  });
  return revision;
}
