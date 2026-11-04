// Design review (DR-FU4): the company's design review policy item (DESIGNREVIEW#LOCK) in a test table. A project runs design review only when `dr` is on AND the company allows it AND the project's own mode is not Off
// (a project with no setting is Off), so a test that wants the stage to run for a project seeds the company once (`allowed`) and the project's playbook (`project`, mode Auto unless said).
import { DESIGN_REVIEW_DEFAULT_SETTING, orgMetaKey, projectPlaybookKey } from "../../packages/contracts/src/index.js";
import { DESIGN_REVIEW_LOCK_SK, type DesignReviewLock } from "../../packages/broker/src/design-review/lock.js";

export interface CompanyPolicySeed {
  allowed?: boolean;
  lock?: DesignReviewLock;
  revision?: number;
  /** A project of this company that has chosen its own mode (default Auto, with the owner's defaults for the rest). */
  project?: string | { name: string; mode?: "never" | "auto" | "always" };
}

/** Writes (replaces) the company's design review item, and the project's playbook when `project` is named. Returns the revision written. */
export function seedDesignReviewCompany(db: { set(item: Record<string, unknown>): void }, orgId: string, seed: CompanyPolicySeed = {}): number {
  const revision = seed.revision ?? 1;
  db.set({
    pk: orgMetaKey(orgId).pk, sk: DESIGN_REVIEW_LOCK_SK, entityType: "DESIGN_REVIEW_COMPANY", orgId, revision,
    lock: seed.lock ?? {}, policy: { allowed: seed.allowed ?? true },
  });
  if (seed.project !== undefined) {
    const project = typeof seed.project === "string" ? { name: seed.project, mode: "auto" as const } : { name: seed.project.name, mode: seed.project.mode ?? "auto" };
    db.set({
      ...projectPlaybookKey(orgId, project.name), entityType: "PROJECT_PLAYBOOK", orgId, revision: 1, defaultProcess: { kind: "builtin" },
      designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: project.mode, highRiskApprover: { ...DESIGN_REVIEW_DEFAULT_SETTING.highRiskApprover } }, updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: "test",
    });
  }
  return revision;
}
