// Rovara Code (Plan 6 Task 3): `POST /v1/app/projects/{project}/code`, the app's way to start work. The body says only what the person asked for; the source is always "app"
// and nothing in it can name a payer, an assigner, a binding or an offer. The access decision is `startCodeIntent`'s (that is, `startTask`'s): this route finds the project
// the person can see, so another org's project and one they have no role in answer the same 404 as a missing one.
import { CodeIntentBodySchema, agentXError } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { StatusReply } from "../aws/status-reply.js";
import { startCodeIntent, type CodeIntentDependencies } from "./intent.js";
import { taskResponseForClient } from "./task-view-compat.js";

/** The path this module owns under `/v1/app/projects/`. */
export const CODE_INTENT_PATH = /^\/v1\/app\/projects\/([^/]+)\/code$/;

export interface CodeIntentRouteDependencies extends CodeIntentDependencies {
  /** The name of a project the caller can see in their org, or the same `PROJECT_NOT_FOUND` for no access, no such project and another org's project. */
  visibleProject(caller: DeveloperCaller, rawName: string): Promise<string>;
}

/**
 * Starts work for the person. A repeat of the same request id answers the first task and session (still 202); the same id with another body is `409 IDEMPOTENCY_CONFLICT`.
 * The task in the answer is the version 1 projection for a client that does not send `x-agentx-task-view: 2`.
 */
export async function routeCodeIntentStart(
  deps: CodeIntentRouteDependencies,
  caller: DeveloperCaller,
  rawProject: string,
  body: unknown,
  headers: Readonly<Record<string, string | undefined>>,
): Promise<StatusReply> {
  if (deps.starter === undefined) throw agentXError("NOT_FOUND", "starting work is not set up in this deployment");
  const project = await deps.visibleProject(caller, rawProject);
  const parsed = CodeIntentBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the person's text.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const { requestId, input, path } = parsed.data;
  const started = await startCodeIntent(deps, caller, { requestId, project, input, source: "app", ...(path === undefined ? {} : { path }) });
  return new StatusReply(202, taskResponseForClient(started, headers));
}
