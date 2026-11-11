// srv/automations: the one switch for automations (chains and their triggers) on the app's routes. Leaf module (no broker imports), so the route dispatcher and the tests read it.
// It is the `chains` name in the broker's packed WEB_FEATURES setting (`wf`), the list the web app's navigation already reads for `features.chains`
// (app-nav/nav.ts). The CDK sets WEB_FEATURES to "admin" today, so automations are off on every install until the control-plane stack adds "chains".
// Off, every `/v1/app/chains*` and `/v1/app/chain-runs*` path and the project's automations list answer the same 404 as any unknown path, except the safety
// paths (`automationsAccess`): the trigger engine (dispatch, schedules) is not behind the switch, so a trigger that is on keeps starting runs, and the people
// allowed to stop it must still be able to. Turning a chain's trigger off, deleting it and archiving its chain stay reachable, under the same live-role rules;
// the routes themselves refuse anything else on those paths while the switch is off (a turn-on, a change of what the trigger is, a create). A chain run's
// session view is not behind the switch either: a run already started can still be read and stopped from its session.
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

/** The paths that stop automations, open while the switch is off: a chain trigger's PUT (a turn-off only) and DELETE, and archiving a chain. */
const SAFETY_PATHS: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "PUT", path: /^\/v1\/app\/chains\/[^/]+\/triggers\/[^/]+$/ },
  { method: "DELETE", path: /^\/v1\/app\/chains\/[^/]+\/triggers\/[^/]+$/ },
  { method: "POST", path: /^\/v1\/app\/chains\/[^/]+\/archive$/ },
];

/**
 * How far an automations request may go: `on` while the switch is on; `safety_only` for a safety path while it is off (the routes then allow only what stops
 * an automation); anything else while it is off is the 404 of an unknown path.
 */
export function automationsAccess(method: string, pathname: string, env: NodeJS.ProcessEnv = process.env): "on" | "safety_only" {
  if (automationsEnabled(env)) return "on";
  if (SAFETY_PATHS.some((safety) => safety.method === method && safety.path.test(pathname))) return "safety_only";
  throw agentXError("NOT_FOUND", "route not found");
}
