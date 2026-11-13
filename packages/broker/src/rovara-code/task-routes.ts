// S3 item 7 (rest): Cloud's task routes for a task the core engine runs (decision 130, the combined switch). The stamp of the task decides, never the switch: a core-stamped task is always served by the
// core, with the switch on or off, and Cloud's own decide / close / cancel logic (which reads workflow rows the core does not write) never touches it. This file is only the seam: the routes ask
// `owns` and, when the core owns the task, hand the request to it. It holds no engine code, so the route files import nothing heavy. One hook per container, installed by the broker's handler
// where the Cloud root is built (the same way the settings-proof settler is); absent, every route is exactly what it was.
import type { DeveloperCloseResponse, DeveloperTaskView } from "@agentx/cloud-contracts";
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
  /** The task as the client reads it (Cloud's own reader answers for a core task: the core writes the same task rows). */
  view: () => Promise<DeveloperTaskView>;
}

export interface CoreCloseInput {
  caller: DeveloperCaller;
  taskId: string;
  value: unknown;
  view: () => Promise<DeveloperTaskView>;
}

export interface CoreTaskRoutes {
  /** Whether the core runs this task for the caller's company: the task's engine stamp says `core` and the row is the caller's company's. A task that is not found, or is another company's, is not the core's (Cloud's reader answers). Throws `RUNTIME_UNAVAILABLE` when it cannot be read. */
  owns(caller: DeveloperCaller, taskId: string): Promise<boolean>;
  decide(input: CoreDecideInput): Promise<{ task: DeveloperTaskView }>;
  close(input: CoreCloseInput): Promise<DeveloperCloseResponse>;
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
 * have, and is refused for it, in the words below, rather than run over rows it was not written for. Decide and close are the core's to answer; cancel is refused (below).
 */
export const CORE_TASK_CLOUD_ACTIONS: ReadonlySet<string> = new Set(["people/role", "people/take-ownership", "share"]);
export const CORE_TASK_ANSWERED_ACTIONS: ReadonlySet<string> = new Set(["workflow/decision", "close"]);

export const CORE_ACTION_NOT_AVAILABLE_WORDS = "This task runs on Rovara's new engine, and that action is not available on it yet. Decide its plan from the task page or its Slack card, or close the task.";
export const CORE_CANCEL_NOT_AVAILABLE_WORDS = "Stopping a run on its own is not available on this task yet; close the task to stop it.";
