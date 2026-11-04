// Design review stage (DR8): the setting a task runs with, read in one place. The project's How we work value (the playbook's `designReview`, or the company's default mode with the owner's defaults when it has none) held to the
// company's lock. Consumers (mode resolution, the cost gate, approval by risk) call this and never read the playbook or the lock themselves. A lock that cannot be read gives the strictest posture; a read that fails is
// the caller's to handle (a task is not started on a guessed setting).
import type { OrgId } from "@agentx/contracts";
import { readProjectPlaybook, type ProjectPlaybookReader } from "../playbook/project-playbook-store.js";
import type { EffectiveDesignReviewSetting } from "./effective-setting.js";
import { effectiveDesignReviewSetting, lockedFields, readDesignReviewCompany, type DesignReviewCompanyRead, type LockViolation } from "./lock.js";

export interface EffectiveDesignReview {
  /** Held to the company's lock. The only value mode resolution, the cost gate, approval and skip accept (the type is branded). */
  setting: EffectiveDesignReviewSetting;
  /** The fields the company's lock holds fixed, so the page can show them as locked. */
  locked: LockViolation[];
  lockUnreadable: boolean;
  /** Whether the company allows design review at all (DR-FU4). False when the policy is not set or cannot be read. */
  allowed: boolean;
}

const effectiveOf = (playbook: Awaited<ReturnType<typeof readProjectPlaybook>>, company: DesignReviewCompanyRead): EffectiveDesignReview => ({
  setting: effectiveDesignReviewSetting(playbook, company.lock, company.policy.defaultMode),
  locked: company.lock.kind === "lock" ? lockedFields(company.lock.lock) : [], lockUnreadable: company.lock.kind === "unreadable", allowed: company.policy.allowed,
});

export async function readEffectiveDesignReview(deps: ProjectPlaybookReader, orgId: OrgId, project: string): Promise<EffectiveDesignReview> {
  const [playbook, company] = await Promise.all([readProjectPlaybook(deps, orgId, project, { lenient: true }), readDesignReviewCompany(deps, orgId)]);
  return effectiveOf(playbook, company);
}

/**
 * The same, but the project's playbook is read only when design review is AVAILABLE: `undefined` for a company that has not allowed it, and for one whose lock cannot be read (fail closed to OFF, M2: "strictest" for a lock
 * is a different thing from "on" for spend, and an unreadable item must not turn design review on in every project). Nothing about the project is read then.
 */
export async function readEffectiveWhenAllowed(deps: ProjectPlaybookReader, orgId: OrgId, project: string): Promise<EffectiveDesignReview | undefined> {
  const company = await readDesignReviewCompany(deps, orgId);
  if (!company.policy.allowed || company.lock.kind === "unreadable") return undefined;
  return effectiveOf(await readProjectPlaybook(deps, orgId, project, { lenient: true }), company);
}
