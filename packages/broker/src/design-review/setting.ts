// Design review stage (DR8): the setting a task runs with, read in one place. The project's How we work value (the playbook's `designReview`, or the owner's defaults when it has none) held to the company's
// lock. Consumers (mode resolution, the cost gate, approval by risk) call this and never read the playbook or the lock themselves. A lock that cannot be read gives the strictest posture; a read that fails is
// the caller's to handle (a task is not started on a guessed setting).
import type { DesignReviewSetting, OrgId } from "@agentx/contracts";
import { readProjectPlaybook, type ProjectPlaybookReader } from "../playbook/project-playbook-store.js";
import { effectiveDesignReviewSetting, lockedFields, readDesignReviewLock, type LockViolation } from "./lock.js";

export interface EffectiveDesignReview {
  setting: DesignReviewSetting;
  /** The fields the company's lock holds fixed, so the page can show them as locked. */
  locked: LockViolation[];
  lockUnreadable: boolean;
}

export async function readEffectiveDesignReview(deps: ProjectPlaybookReader, orgId: OrgId, project: string): Promise<EffectiveDesignReview> {
  const [playbook, lock] = await Promise.all([readProjectPlaybook(deps, orgId, project, { lenient: true }), readDesignReviewLock(deps, orgId)]);
  return { setting: effectiveDesignReviewSetting(playbook, lock), locked: lock.kind === "lock" ? lockedFields(lock.lock) : [], lockUnreadable: lock.kind === "unreadable" };
}
