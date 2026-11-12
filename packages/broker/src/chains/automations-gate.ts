// srv/automations: the one switch for automations (chains and their triggers) on the app's routes. Leaf module (no broker imports), so the route dispatcher and the tests read it.
// It is the `chains` name in the broker's packed WEB_FEATURES setting (`wf`), the list the web app's navigation already reads for `features.chains`
// (app-nav/nav.ts). The CDK sets WEB_FEATURES to "admin" today, so automations are off on every install until the control-plane stack adds "chains".
// Off, every `/v1/app/chains*` and `/v1/app/chain-runs*` path and the project's automations list answer the same 404 as any unknown path, except the safety
// paths (`automationsAccess`): the people allowed to stop an automation must still be able to. Turning a chain's trigger off, deleting it and archiving its chain stay
// reachable, under the same live-role rules; the routes themselves refuse anything else on those paths while the switch is off (a turn-on, a change of what the trigger
// is, a create). A chain run's session view is not behind the switch either: a run already started can still be read and stopped from its session.
//
// Owner decision 143(c) (convergence S0): the switch is also the engine's. Off, nothing starts on its own (a trigger's event or schedule, a chain's next step, an agent
// trigger's task: `AUTOMATIONS_OFF_MESSAGE`), and the runs already started are cancelled at a safe point (`automationStopSafe`: never between a pull request being
// opened and its being recorded, never mid-merge; a run that waits for a person is safe) by the sweep. This replaces "the trigger engine is not behind the switch".
// The engine reads the switch through the `automations` dependency (chains/runner.ts `ChainRunnerDependencies`), which the broker's wiring fills from this module.
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

/** What a person is told when automation work is refused because automations are off. The same words on the core (`NOT_AVAILABLE_HERE`) and here. */
export const AUTOMATIONS_OFF_MESSAGE = "Automations are turned off, so nothing starts on its own.";

/** The engine's view of the switch: read on every use, so turning it off (a new deploy of WEB_FEATURES) takes effect at the next start and the next sweep. */
export interface AutomationsSwitch { enabled(): boolean }

/** The engine's switch from the broker's environment. */
export const automationsSwitchOf = (env: NodeJS.ProcessEnv = process.env): AutomationsSwitch => ({ enabled: () => automationsEnabled(env) });

/**
 * Whether a task of an automation may be stopped now without leaving work half done. The unsafe moments are the ones that write outside Rovara: a pull request being
 * opened or updated and not yet recorded (stage `PULL_REQUEST`, running or about to run), and a merge of the base into the branch (`SYNC`). Everything else is safe:
 * a step that has not started, a task that waits for a person (plan review, a decision, the wait for a merge), the planning and coding steps (nothing leaves the worker
 * until it is published), and a task with no workflow (an agent that only reports). A merge itself is never an automation's: a person presses it.
 */
export function automationStopSafe(workflow: { stage?: unknown; state?: unknown } | undefined): boolean {
  if (workflow === undefined) return true;
  const running = workflow.state === "RUNNING" || workflow.state === "READY";
  if (workflow.stage === "PULL_REQUEST" && running) return false;
  if (workflow.stage === "SYNC" && running) return false;
  return true;
}
