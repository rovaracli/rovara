// v1.2 learning loop: the React routes under `/v1/app/projects/{p}/learning` (design 6.2). B3 owns Remember and Forget; B6 and B8 add the rest to `routeLearning`, which answers
// `undefined` for a path or method it does not own, so the caller falls through to its own "not found".
//
// Bodies are strict: standing, author and stage are never read from a request (I3). The person is the signed-in caller. The project is found through `projectFor`, so another company's
// project and one the caller cannot see answer the same way.
import { LearningForgetBodySchema, LearningRememberBodySchema, agentXError, type ProjectRole } from "@agentx/contracts";
import type { ZodType } from "zod";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { forgetCorrectionById, rememberTaskComment, type ForgetAnswer, type RememberAnswer } from "./capture-comment.js";

/** Everything under a project's `learning` path; the project name is group 1 and the rest (without a leading slash) group 2. */
export const LEARNING_PATH = /^\/v1\/app\/projects\/([^/]+)\/learning(?:\/(.+))?$/;
const FORGET_PATH = /^corrections\/([A-Za-z0-9_-]{1,100})\/forget$/;

export interface LearningRouteDependencies {
  /** The task route dependencies for the caller (task access is checked by the task's own rules, then standing on top of it). */
  task: DeveloperTaskRouteDependencies;
  /** The caller's role in the project: its name, or the one `PROJECT_NOT_FOUND` for no access, no such project and another company's. */
  projectFor(caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: ProjectRole }>;
}

function strictBody<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  // Field names only: the values are the caller's.
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

export async function routeLearning(deps: LearningRouteDependencies, caller: DeveloperCaller, method: string, url: URL, body: () => unknown): Promise<RememberAnswer | ForgetAnswer | undefined> {
  const matched = LEARNING_PATH.exec(url.pathname);
  if (matched === null || matched[2] === undefined) return undefined;
  const rest = matched[2];
  if (method === "POST" && rest === "remember") {
    const { name } = await deps.projectFor(caller, matched[1]!);
    const input = strictBody(LearningRememberBodySchema, body());
    return rememberTaskComment(deps.task, caller, input.taskId, input.commentId, { project: name });
  }
  const forgetting = FORGET_PATH.exec(rest);
  if (method === "POST" && forgetting !== null) {
    const { name } = await deps.projectFor(caller, matched[1]!);
    strictBody(LearningForgetBodySchema, body());
    return forgetCorrectionById(deps.task, caller, name, forgetting[1]!);
  }
  return undefined;
}
