// Design review stage, DR7: the switch. Two packed broker settings (AGENTX_SETTINGS) decide it, both off by default:
//   `dr`  (BROKER_SETTINGS.designReview, variable DESIGN_REVIEW_ENABLED)   the stage exists in this environment only when the value is exactly "1";
//   `dp`  (BROKER_SETTINGS.designReviewProjects, variable DESIGN_REVIEW_PROJECTS)   the project names the stage runs for, joined by ":" (a project name is lower case letters, digits and hyphens, so the colon is free).
// Fail closed: `dr` on with no `dp` (or an empty one) runs NO project. A project that is not named in `dp`, a value that is not plain text and a name that is not a project name all give OFF, and OFF is the whole of today's
// behaviour: nothing reads the project's setting, `resolveDesignMode` is never called, and no task ever carries a `designReview`. The stack parameters are DesignReviewEnabled and DesignReviewProjects (control plane).
// The switch is read at every step, not only when a task enters the stage (B2-m3): `dr` at 0, or the project taken out of `dp`, ends a review under way at its next round or planner run, as not run (`switched_off`). A run already
// working finishes; nothing is approved for anyone.
import { AGENTX_NAME_PATTERN, BROKER_SETTINGS, BROKER_SETTING_VALUE, liveInteractionFlagOn } from "@agentx/contracts";

/** Whether the design review stage exists in this environment at all. Anything but exactly "1" is off. It says nothing about any project: use `designReviewEnabledFor`. */
export const designReviewEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.designReview.variable]);

/** The project names `dp` lists. A value that is not plain text, or a name that is not a project name, makes the whole list empty (fail closed). */
export function designReviewProjects(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env[BROKER_SETTINGS.designReviewProjects.variable];
  if (raw === undefined || raw === "" || !BROKER_SETTING_VALUE.test(raw)) return [];
  const names = raw.split(":");
  return names.every((name) => AGENTX_NAME_PATTERN.test(name)) ? names : [];
}

/** Whether the design review runs for this project: the switch is on AND the project is named in the allowlist. */
export const designReviewEnabledFor = (project: string, env: NodeJS.ProcessEnv = process.env): boolean => designReviewEnabled(env) && designReviewProjects(env).includes(project);
