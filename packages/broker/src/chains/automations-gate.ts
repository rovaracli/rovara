// srv/automations: the one switch for automations (chains and their triggers) on the app's routes. Leaf module (no broker imports), so the route dispatcher and the tests read it.
// It is the `chains` name in the broker's packed WEB_FEATURES setting (`wf`), the list the web app's navigation already reads for `features.chains`
// (app-nav/nav.ts). The CDK sets WEB_FEATURES to "admin" today, so automations are off on every install until the control-plane stack adds "chains".
// Off, every `/v1/app/chains*` and `/v1/app/chain-runs*` path and the project's automations list answer the same 404 as any unknown path. The trigger engine
// (dispatch, schedules) and a chain run's session view are not behind it: a run already started can still be read and stopped from its session.
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import { agentXError } from "@rovara-code/contracts";

/** The name in WEB_FEATURES that turns automations on. */
export const AUTOMATIONS_WEB_FEATURE = "chains";

/** Whether automations are on: WEB_FEATURES (comma separated, spaces around a name ignored) names `chains` exactly. Missing or empty is off. */
export function automationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[BROKER_SETTINGS.webFeatures.variable];
  if (typeof raw !== "string" || raw.length === 0) return false;
  return raw.split(",").some((name) => name.trim() === AUTOMATIONS_WEB_FEATURE);
}

/** Refuses with the 404 of an unknown path while automations are off. */
export function requireAutomationsEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!automationsEnabled(env)) throw agentXError("NOT_FOUND", "route not found");
}
