// Design review stage, DR7 + DR-FU4: the switch. Three things decide whether a project runs design review, all off by default:
//   `dr`  (BROKER_SETTINGS.designReview, variable DESIGN_REVIEW_ENABLED)   the operator's environment-wide master switch; the stage exists in this environment only when the value is exactly "1";
//   the company's `allowed` (design-review/lock.ts, set by a company admin in How we work)   whether the company allows design review at all;
//   the project's effective mode (its How we work setting, or the company's default mode when it has none, held to the company's lock)   not Off (`never`).
// `dp` (BROKER_SETTINGS.designReviewProjects, stack parameter DesignReviewProjects) no longer gates anything: it stays one more release so an upgrade can move its projects into stored settings (dp-migration.ts), and is removed after.
// Fail closed: a value that is not "1" in `dr` is OFF with NO table read at all, so with `dr` off nothing else runs, `resolveDesignMode` is never called, and no task ever carries a `designReview`. A company item or a project
// setting that cannot be read gives OFF here (the caller of a read that must not guess uses `readEffectiveDesignReview`, which throws).
// The switch is read at every step, not only when a task enters the stage (B2-m3): `dr` at 0, the company no longer allowing it, or the project set to Off, ends a review under way at its next round or planner run, as not run
// (`switched_off`). A run already working finishes; nothing is approved for anyone. A review the PERSON asked for (design first) keeps going while the stage exists, whatever the project's mode (owner Q3): see `designReviewStillOn`.
import { liveInteractionFlagOn, BROKER_SETTINGS, type OrgId } from "@agentx/contracts";
import type { ProjectPlaybookReader } from "../playbook/project-playbook-store.js";
import { readDesignReviewCompany } from "./lock.js";
import { readEffectiveWhenAllowed } from "./setting.js";

/** Whether the design review stage exists in this environment at all. Anything but exactly "1" is off. It says nothing about any company or project: use `designReviewAvailableFor` or `designReviewEnabledFor`. */
export const designReviewEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.designReview.variable]);

/** Whether the stage exists for this company: `dr` on AND the company allows it. `dr` off reads nothing. A company item that cannot be read is OFF. */
export async function designReviewAvailableFor(deps: ProjectPlaybookReader, orgId: OrgId, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!designReviewEnabled(env)) return false;
  try { return (await readDesignReviewCompany(deps, orgId)).policy.allowed; } catch { return false; }
}

/** Whether design review runs for this project: `dr` on AND the company allows it AND the project's effective mode is not Off. `dr` off reads nothing. A read that fails is OFF. */
export async function designReviewEnabledFor(deps: ProjectPlaybookReader, orgId: OrgId, project: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!designReviewEnabled(env)) return false;
  try {
    const effective = await readEffectiveWhenAllowed(deps, orgId, project);
    return effective !== undefined && effective.setting.mode !== "never";
  } catch { return false; }
}

/**
 * B2-m3, for a review under way: whether it may take its next step. A review the person asked for (`decidedBy: "person"`) goes on while the stage exists for the company, even in a project that is Off (the person asked, owner Q3);
 * any other review needs the project to be on, as `designReviewEnabledFor`.
 */
export async function designReviewStillOn(deps: ProjectPlaybookReader, orgId: OrgId, project: string, decidedBy: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return decidedBy === "person" ? designReviewAvailableFor(deps, orgId, env) : designReviewEnabledFor(deps, orgId, project, env);
}
