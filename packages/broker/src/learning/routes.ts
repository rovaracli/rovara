import { writeLearningSettings, decideLearningSettings, skippedPrCommentCount, type LearningSettingsDeps } from "./settings.js";
// v1.2 learning loop: the React routes under `/v1/app/projects/{p}/learning` (design 6.2). B3 owns Remember and Forget; B6 and B8 add the rest to `routeLearning`, which answers
// `undefined` for a path or method it does not own, so the caller falls through to its own "not found".
//
// Bodies are strict: standing, author and stage are never read from a request (I3). The person is the signed-in caller. The project is found through `projectFor`, so another company's
// project and one the caller cannot see answer the same way.
import { LearningForgetBodySchema, LearningReopenBodySchema, LearningRememberBodySchema, agentXError, type LearningViewAnswer, type ProjectRole } from "@agentx/contracts";
import type { ZodType } from "zod";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { StatusReply } from "../aws/status-reply.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { forgetCorrectionById, rememberTaskComment, type ForgetAnswer, type RememberAnswer } from "./capture-comment.js";
import { acceptSuggestion, dismissSuggestion, removeRule, reopenDismissed, type AcceptAnswer, type RemoveAnswer } from "./decide.js";
import type { LearningDecideDeps } from "./settle.js";
import { viewLearning } from "./view.js";

/** Everything under a project's `learning` path; the project name is group 1 and the rest (without a leading slash) group 2. */
export const LEARNING_PATH = /^\/v1\/app\/projects\/([^/]+)\/learning(?:\/(.+))?$/;
const FORGET_PATH = /^corrections\/([A-Za-z0-9_-]{1,100})\/forget$/;
const ACCEPT_PATH = /^suggestions\/([A-Za-z0-9_-]{1,100})\/accept$/;
const DISMISS_PATH = /^suggestions\/([A-Za-z0-9_-]{1,100})\/dismiss$/;
const REOPEN_PATH = /^dismissed\/([A-Za-z0-9_-]{1,100})\/reopen$/;
const REMOVE_PATH = /^rules\/([A-Za-z0-9_-]{1,100})\/remove$/;

export interface LearningRouteDependencies {
  settings?: LearningSettingsDeps;
  /** The task route dependencies for the caller (task access is checked by the task's own rules, then standing on top of it). */
  task: DeveloperTaskRouteDependencies;
  /** The caller's role in the project: its name, or the one `PROJECT_NOT_FOUND` for no access, no such project and another company's. */
  projectFor(caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: ProjectRole }>;
  /** What deciding needs (B6): the process layer, the agent store and the approvals. Absent where agents are not set up: the deciding routes then answer "not found". */
  decide?: LearningDecideDeps;
  /** The Audit Ledger of the install, when there is one: Remember and Forget write their events with it. */
  audit?: LearningDecideDeps["audit"];
}

export type LearningAnswer = Awaited<ReturnType<typeof writeLearningSettings>> | Awaited<ReturnType<typeof decideLearningSettings>> | RememberAnswer | ForgetAnswer | AcceptAnswer | RemoveAnswer | StatusReply | { suggestion: { id: string; status: "dismissed" } } | { reopened: true } | LearningViewAnswer;

/**
 * A publish that waits for a person answers the way a hand publish does: `202 { status: "NEEDS_CONFIRMATION", confirmUrl, changes }`. The `outcome` the screens read stays in the body, so a reader
 * of either shape works.
 */
function answered(answer: AcceptAnswer | RemoveAnswer): AcceptAnswer | RemoveAnswer | StatusReply {
  return answer.outcome === "awaiting_approval" ? new StatusReply(202, { status: "NEEDS_CONFIRMATION", ...answer }) : answer;
}

function strictBody<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  // Field names only: the values are the caller's.
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

export async function routeLearning(deps: LearningRouteDependencies, caller: DeveloperCaller, method: string, url: URL, body: () => unknown): Promise<LearningAnswer | undefined> {
  const matched = LEARNING_PATH.exec(url.pathname);
  // `GET …/learning`: the screen's one read. Anyone who can see the project; what they get depends on their live standing (view.ts). It needs only the table, so it is answered even where agents are not set up.
  if (method === "GET" && matched !== null && matched[2] === undefined) {
    const learning = { documentClient: deps.task.documentClient, tableName: deps.task.tableName, now: () => deps.task.now() };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const page = async () => {
      const answer = await viewLearning({ ...learning, projectFor: (who, rawName) => deps.projectFor(who, rawName) }, caller, matched[1]!);
      if (answer.settings.prComments !== "on") return answer;
      return { ...answer, skippedUnlinked: await skippedPrCommentCount(learning, caller.orgId, decodeURIComponent(matched[1]!)) };
    };
    try { return await Promise.race([page(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(agentXError("RUNTIME_UNAVAILABLE", "Learning took too long to load. Try again.")), 4000); })]); }
    finally { clearTimeout(timer); }
  }
  if (matched === null || matched[2] === undefined) return undefined;
  const rest = matched[2];
  const settingDecision = /^settings\/proposals\/([A-Za-z0-9_-]{1,100})\/decide$/.exec(rest);
  if ((method === "PUT" && rest === "settings") || (method === "POST" && settingDecision !== null)) {
    if (caller.browserSession !== true) throw agentXError("FORBIDDEN", "Use a live browser session for learning settings.");
    if (deps.settings === undefined) throw agentXError("NOT_FOUND", "Learning settings are not available.");
    const { name } = await deps.projectFor(caller, matched[1]!);
    return settingDecision === null ? writeLearningSettings(deps.settings, caller, name, body()) : decideLearningSettings(deps.settings, caller, name, settingDecision[1]!, body());
  }

  if (method === "POST" && rest === "remember") {
    const { name } = await deps.projectFor(caller, matched[1]!);
    const input = strictBody(LearningRememberBodySchema, body());
    return rememberTaskComment(deps.task, caller, input.taskId, input.commentId, { project: name, audit: deps.audit });
  }
  const forgetting = FORGET_PATH.exec(rest);
  if (method === "POST" && forgetting !== null) {
    const { name } = await deps.projectFor(caller, matched[1]!);
    strictBody(LearningForgetBodySchema, body());
    return forgetCorrectionById(deps.task, caller, name, forgetting[1]!, { audit: deps.audit });
  }
  const deciding = (match: RegExpExecArray | null): { id: string; decide: LearningDecideDeps } | undefined => {
    if (method !== "POST" || match === null) return undefined;
    if (deps.decide === undefined) throw agentXError("NOT_FOUND", "agents are not set up in this deployment");
    return { id: match[1]!, decide: deps.decide };
  };
  const accepting = deciding(ACCEPT_PATH.exec(rest));
  if (accepting !== undefined) return answered(await acceptSuggestion(accepting.decide, caller, matched[1]!, accepting.id, body()));
  const dismissing = deciding(DISMISS_PATH.exec(rest));
  if (dismissing !== undefined) return dismissSuggestion(dismissing.decide, caller, matched[1]!, dismissing.id, body());
  const reopening = deciding(REOPEN_PATH.exec(rest));
  if (reopening !== undefined) {
    strictBody(LearningReopenBodySchema, body());
    return reopenDismissed(reopening.decide, caller, matched[1]!, reopening.id);
  }
  const removing = deciding(REMOVE_PATH.exec(rest));
  if (removing !== undefined) return answered(await removeRule(removing.decide, caller, matched[1]!, removing.id, body()));
  return undefined;
}
