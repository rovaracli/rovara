// Rovara Code (Plan 6 Task 6): "Make a change anyway" on a task that ended Answered. `POST /v1/app/sessions/{id}/change-anyway { requestId }` starts a NEW task through the one entry point
// (`startCodeIntent`) with the old task's request and path, Rovara's earlier answer as information in its context, and `retryOf` naming the answered task. Who may: the session's
// owner, or a person with "can use" on it (read live, as every session action is); the new task is the caller's: they pay (m11), `start_tasks` and `requireNewWorkAllowed` are
// `startTask`'s own checks, so a person without the project role is refused there (`PROJECT_ACCESS_DENIED`). Nothing here reads a payer or a path from the request body.
import { z } from "zod";
import { RUN_INPUT_TEXT_MAX_BYTES, agentXError, answeredMessage, type CodeIntentResult } from "@rovara-code/contracts";
import { workflowAnswer, type DeveloperTaskView } from "@agentx/cloud-contracts";
import { requireSessionLevel } from "../agent-sessions/access.js";
import type { SessionReadDependencies } from "../agent-sessions/read.js";
import { taskOfSession, type ControlCaller } from "../agent-sessions/stop.js";

const BodySchema = z.object({ requestId: z.string().uuid() }).strict();

export const NOT_ANSWERED_MESSAGE = "This task didn't end with an answer, so there is no answer to ask for a change after.";
export const CHANGE_ANYWAY_UNAVAILABLE = "Starting the change isn't available right now.";
/** What a follow-up start hears when the task it names is not one it may follow: missing, another org's, not visible, or not ended Answered. One message for all, so nothing is learned from which. */
export const FOLLOW_UP_UNAVAILABLE_MESSAGE = "That task can't be followed up.";

/** What a follow-up hears when the session runs on a Mac now. */
export const SESSION_ON_MAC_FOLLOW_UP_MESSAGE = "This session runs on a Mac now, so a follow-up can't be started from here.";

/** The first `max` bytes of `text`, never in the middle of a character. */
function cutToBytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength <= max ? text : new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, max)).replace(/�+$/u, "");
}

/** What the new task starts with: the answered task's request, Rovara's earlier answer (information only: it is a model's words, kept out of the request text), the old path, and the link. */
export async function changeAnywayOnSession(deps: SessionReadDependencies, caller: ControlCaller, sessionId: string, body: unknown): Promise<CodeIntentResult<DeveloperTaskView>> {
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "body"}: ${parsed.error.issues[0]?.code === "unrecognized_keys" ? "has a field this route does not take" : "is not valid"}`);
  const { session } = await requireSessionLevel(deps, caller, sessionId, "use", "ask for the change");
  if (session.kind === "local" || session.where.kind !== "cloud") throw agentXError("SESSION_ON_MAC", SESSION_ON_MAC_FOLLOW_UP_MESSAGE);
  const task = await taskOfSession(deps, session);
  const workflow = task?.workflow;
  const answer = workflow === undefined ? undefined : workflowAnswer(workflow);
  if (task === undefined || workflow === undefined || answer === undefined || task.requestText === undefined) throw agentXError("CONFIG_INVALID", NOT_ANSWERED_MESSAGE);
  if (deps.control?.startCodeIntent === undefined) throw agentXError("RUNTIME_UNAVAILABLE", CHANGE_ANYWAY_UNAVAILABLE);
  return deps.control.startCodeIntent({
    // The path is the person's only when the first request named it; otherwise Understand chooses again, as for any new intent (the answered task's own path was never chosen).
    requestId: parsed.data.requestId, project: task.project, source: "app", ...(workflow.intent?.pathFrom === "request" ? { path: workflow.path } : {}), retryOf: task.taskId,
    input: {
      text: cutToBytes(task.requestText, RUN_INPUT_TEXT_MAX_BYTES),
      context: [{ kind: "report", ref: `task:${task.taskId}`, title: "Rovara's earlier answer", body: cutToBytes(answeredMessage(answer), 16_000) }],
    },
  });
}
