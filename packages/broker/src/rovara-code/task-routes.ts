// S3 item 7 (rest): Cloud's task routes for a task the core engine runs (decision 130, the combined switch). The stamp of the task decides, never the switch: a core-stamped task is always served by the
// core, with the switch on or off, and Cloud's own decide / close / cancel logic (which reads workflow rows the core does not write) never touches it. This file is only the seam: the routes ask
// `owns` and, when the core owns the task, hand the request to it. It holds no engine code, so the route files import nothing heavy. One hook per container, installed by the broker's handler
// where the Cloud root is built (the same way the settings-proof settler is); absent, every route is exactly what it was.
import type { DeveloperCloseResponse, DeveloperTaskView } from "@agentx/cloud-contracts";
import { agentXError } from "@rovara-code/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";

/** What a route gives the core to answer a decision on a task it owns. */
export interface CoreDecideInput {
  caller: DeveloperCaller;
  taskId: string;
  /** The request body as the route received it (the core parses it with Cloud's own schema). */
  value: unknown;
  /** `PAGE` when the task page sent it. */
  via?: "PAGE" | undefined;
  /** The caller's own developer token (the route's `Authorization` header, without `Bearer `), when it came with one. Never logged, never stored. */
  bearer?: string | undefined;
  /** The decide-grade cookie of a HIGH plan card's press (the card's own handler hands it over): the credential is then the `browser-step-up` method, `<session id>:<cookie>`. */
  stepUpCookie?: string | undefined;
  /** The task as the client reads it (Cloud's own reader answers for a core task: the core writes the same task rows). */
  view: () => Promise<DeveloperTaskView>;
}

export interface CoreCloseInput {
  caller: DeveloperCaller;
  taskId: string;
  value: unknown;
  view: () => Promise<DeveloperTaskView>;
}

/**
 * What a route gives the core for a task action Code's session actions run (retry, cancel, revise the plan). Code's actions check no access of their own (the host authorizes first, as Code's local session
 * routes do), so `authorize` is Cloud's own check for the action, exactly the one the Cloud route makes (its role, the person's project role, an archived project), and the core calls it before it reads or
 * does anything for the action. It throws Cloud's refusal.
 */
export interface CoreActionInput {
  caller: DeveloperCaller;
  taskId: string;
  value: unknown;
  authorize: () => Promise<void>;
  view: () => Promise<DeveloperTaskView>;
}

export interface CoreTaskRoutes {
  /** Whether the core runs this task for the caller's company: the task's engine stamp says `core` and the row is the caller's company's. A task that is not found, or is another company's, is not the core's (Cloud's reader answers). Throws `RUNTIME_UNAVAILABLE` when it cannot be read. */
  owns(caller: Pick<DeveloperCaller, "orgId">, taskId: string): Promise<boolean>;
  decide(input: CoreDecideInput): Promise<{ task: DeveloperTaskView }>;
  close(input: CoreCloseInput): Promise<DeveloperCloseResponse>;
  /** Retries the step the task is blocked at (Code's `retryBlockedStep`, at the revision the person saw when the request names one). */
  retry(input: CoreActionInput): Promise<{ task: DeveloperTaskView }>;
  /** Stops the task's running step (Code's `cancelTask`): the step waits for a Retry. `nothingRunning` when there was nothing to stop. */
  cancel(input: CoreActionInput): Promise<{ task: DeveloperTaskView; nothingRunning: boolean; message?: string }>;
  /** The owner's "Revise the plan with this change" after their live message stopped coding (Code's `revisePlanWithLiveMessage`). Only the task's effective owner. */
  revisePlan(input: CoreActionInput): Promise<{ task: DeveloperTaskView }>;
}

let installed: CoreTaskRoutes | undefined;

/** Installs the core's task routes for this container (the broker's handler, where the Cloud root is built). `undefined` removes them. */
export function installCoreTaskRoutes(routes: CoreTaskRoutes | undefined): void {
  installed = routes;
}

export function coreTaskRoutes(): CoreTaskRoutes | undefined {
  return installed;
}

/**
 * The POST actions under `/v1/dev/tasks/{id}/` that stay Cloud's for a core task: a People change and sharing write the task's own People rows and share record, which both engines read the same way.
 * Every other one is a Cloud workflow action (retry, send back, revise the plan, review, publish, feedback, a pull request, the canvas close-out, the E2E context) over workflow rows a core task does not
 * have, and is refused for it, in the words below, rather than run over rows it was not written for. Decide, close, retry, cancel and revising the plan are the core's to answer.
 */
export const CORE_TASK_CLOUD_ACTIONS: ReadonlySet<string> = new Set(["people/role", "people/take-ownership", "share"]);
/** The actions the core answers in their own functions (decide, close, and Code's session actions: retry, cancel, revise the plan; DEFERRED S3-RETRY-CANCEL-REVISE-WIRING, wired at the 0.5.19 pin). */
export const CORE_TASK_ANSWERED_ACTIONS: ReadonlySet<string> = new Set(["workflow/decision", "close", "workflow/retry", "cancel", "workflow/revise-plan"]);

/** How every refusal below begins, so a person always reads the same plain first words. */
export const CORE_NOT_AVAILABLE_PREFIX = "Not available on this task yet.";
const MORE_CHANGES = "To make more changes, close this task and start a new one with the extra instructions.";

/**
 * What a person is told for each Cloud action a core task cannot do yet (owner decision 198: refused in plain words, never a generic error), by the action's route name. Each says what to do instead:
 * mostly, close the task and start a new one with the extra instructions. Retry, cancel and revising the plan are answered by the core (`CORE_TASK_ANSWERED_ACTIONS`), so they have no row.
 */
export const CORE_ACTION_WORDS: Readonly<Record<string, string>> = {
  "workflow/send-back": `${CORE_NOT_AVAILABLE_PREFIX} ${MORE_CHANGES}`,
  "continue": `${CORE_NOT_AVAILABLE_PREFIX} To continue the work, close this task and start a new one with the extra instructions.`,
  "workflow/review-findings": `${CORE_NOT_AVAILABLE_PREFIX} To act on these review findings, close this task and start a new one that says what to fix.`,
  "workflow/review": `${CORE_NOT_AVAILABLE_PREFIX} The reviews run on their own as part of the task; to get another look at the code, close this task and start a new one.`,
  "pull-requests": `${CORE_NOT_AVAILABLE_PREFIX} The pull request opens by itself when the checks and reviews pass; if it did not, close this task and start a new one with the same instructions.`,
  "workflow/keep-pull-requests": `${CORE_NOT_AVAILABLE_PREFIX} The pull requests stay on GitHub exactly as they are when you close the task.`,
  "workflow/publish-retry": `${CORE_NOT_AVAILABLE_PREFIX} To try opening the pull request again, close this task and start a new one with the same instructions.`,
  "workflow/feedback-decision": `${CORE_NOT_AVAILABLE_PREFIX} To act on this feedback, close this task and start a new one that says what to change.`,
  "workflow/feedback-retry": `${CORE_NOT_AVAILABLE_PREFIX} To act on this feedback, close this task and start a new one that says what to change.`,
  "canvas-closeout/retry": `${CORE_NOT_AVAILABLE_PREFIX} The canvas close-out is not run for tasks on the new engine.`,
  "e2e-publication-context": `${CORE_NOT_AVAILABLE_PREFIX} End-to-end presentation checks are not run for tasks on the new engine.`,
};

/** What a person is told for Stop & redirect on a task the core engine runs: the core has no redirect (its Stop, Retry and "Revise the plan" are the session actions), so the redirect stops and restarts nothing. */
export const CORE_REDIRECT_NOT_AVAILABLE_WORDS = `${CORE_NOT_AVAILABLE_PREFIX} To change what the task is doing, stop it, then close this task and start a new one with the extra instructions.`;

/**
 * Stop & redirect (phase 1's route and phase 2's restarts) never runs over a task the core engine owns: its restarts read workflow rows the core does not write, and phase 1 would record the instruction and
 * stop the step before any restart could say no. Refuses in plain words (CONFIG_INVALID) before anything is read for the redirect or written. A Cloud task, no hook at all, and a company the core does not
 * serve all pass through. A task that cannot be read fails closed (`owns` throws RUNTIME_UNAVAILABLE).
 */
export async function refuseRedirectOnCoreTask(caller: Pick<DeveloperCaller, "orgId">, taskId: string): Promise<void> {
  const core = installed;
  if (core !== undefined && await core.owns(caller, taskId)) throw agentXError("CONFIG_INVALID", CORE_REDIRECT_NOT_AVAILABLE_WORDS);
}

/** The words for an action: its own sentence, or (for an action no row names) the same plain first words and the close-and-start-again advice. Never a generic error. */
export const coreActionWords = (action: string): string => CORE_ACTION_WORDS[action] ?? `${CORE_NOT_AVAILABLE_PREFIX} ${MORE_CHANGES}`;
