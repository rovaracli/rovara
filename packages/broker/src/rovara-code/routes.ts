// Rovara Code (Plan 6 Task 3): `POST /v1/app/projects/{project}/code`, the app's way to start work. The body says only what the person asked for; the source is always "app"
// and nothing in it can name a payer, an assigner, a binding or an offer. The access decision is `startCodeIntent`'s (that is, `startTask`'s): this route finds the project
// the person can see, so another org's project and one they have no role in answer the same 404 as a missing one.
import { CodeIntentBodySchema, agentXError } from "@rovara-code/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { StatusReply } from "../aws/status-reply.js";
import { designFirstWebStart } from "../design-review/design-first.js";
import type { ProjectPlaybookReader } from "../playbook/project-playbook-store.js";
import { startCodeIntent, type CodeIntentDependencies } from "./intent.js";
import { taskResponseForClient } from "./task-view-compat.js";

/** The path this module owns under `/v1/app/projects/`. */
export const CODE_INTENT_PATH = /^\/v1\/app\/projects\/([^/]+)\/code$/;

export interface CodeIntentRouteDependencies extends CodeIntentDependencies {
  /** The name of a project the caller can see in their org, or the same `PROJECT_NOT_FOUND` for no access, no such project and another org's project. */
  visibleProject(caller: DeveloperCaller, rawName: string): Promise<string>;
  /** The table, for "Design first" (DR-UX-3): the company's design review rules are read from it and the task is marked in it. Absent: Design first is unavailable (fail closed). */
  table?: ProjectPlaybookReader | undefined;
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
  env: NodeJS.ProcessEnv = process.env,
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
  // "Design first" (DR-UX-3): the ticked option or a leading `design first:`, the same ask as Slack and Linear, read only while design review is available for the company. The prefix is not part of the request.
  const first = await designFirstWebStart(deps.table, caller.orgId, { text: input.text, asked: parsed.data.designFirst === true }, env);
  const asked = first.designFirst ? { ...input, text: first.text } : input;
  // The ask goes into the start itself: the task row is created with it (no later mark that can fail or lose a race with Understand), and it is part of the request's fingerprint, so the same request id with another value is IDEMPOTENCY_CONFLICT.
  const started = await startCodeIntent(deps, caller, { requestId, project, input: asked, source: "app", ...(path === undefined ? {} : { path }), ...(first.designFirst ? { designFirst: true as const } : {}) });
  return new StatusReply(202, taskResponseForClient(started, headers));
}
