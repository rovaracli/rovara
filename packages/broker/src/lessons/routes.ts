// Learning v2 L3b: the app routes of the Lessons tab, the Sources tab and the task page's lessons list.
//   GET  /v1/app/projects/{p}/lessons                      the tab's one read
//   GET  /v1/app/projects/{p}/lessons/digest               the weekly digest (people who decide)
//   GET  /v1/app/projects/{p}/lessons/sources              the sources that feed the record
//   GET  /v1/app/projects/{p}/lessons/{id}/history         versions and who approved each (people who decide)
//   POST /v1/app/projects/{p}/lessons/{id}/approve         one-tap approval, or edit and approve
//   POST /v1/app/projects/{p}/lessons/{id}/reject
//   POST /v1/app/projects/{p}/lessons/{id}/retire
//   POST /v1/app/projects/{p}/lessons/rollback
//   GET  /v1/app/tasks/{task}/lessons                      the lessons the agent loaded
//   POST /v1/app/tasks/{task}/lessons/{id}/feedback        "Helpful" / "Wrong here"
//
// The module answers `undefined` for a path it does not own, as `routeLearning` does. Authority: the project is found through `projectFor` (another company's project and one the caller
// cannot see answer the same way); who may decide is the lesson library's own check (`ApproverDirectory`, the second-person rule, the access records); a write needs a live browser
// session and a writer role (the Auditor is refused); a refusal is a fixed sentence, never text from a lesson, a row or an error.
import {
  LessonApproveBodySchema, LessonFeedbackBodySchema, LessonRejectBodySchema, LessonRetireBodySchema, LessonRollbackBodySchema, agentXError,
  type AgentXErrorCode, type ProjectRole,
} from "@agentx/contracts";
import type { ZodType } from "zod";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { requireWriterCaller } from "../org/auditor.js";
import { approveLesson, rejectLesson, retireByPerson, type ApprovalFailure, type ApproveDeps } from "./approve.js";
import { recordFeedback, type CounterDeps } from "./counters.js";
import { rollbackLessonSetSettled } from "./rollback.js";
import type { ProcessDeps } from "./process.js";
import { buildLessonHistory, buildLessonSources, buildLessonsDigest, buildLessonsView, buildLoadedLessons, SNAPSHOTS_MAX, type LessonViewDeps } from "./view.js";
import type { ScopeKey } from "./store.js";

export const LESSONS_PATH = /^\/v1\/app\/projects\/([^/]+)\/lessons(?:\/([A-Za-z0-9_-]{1,64})(?:\/(approve|reject|retire|history))?)?$/u;
export const TASK_LESSONS_PATH = /^\/v1\/app\/tasks\/([0-9a-f-]{36})\/lessons(?:\/([A-Za-z0-9_-]{4,64})\/feedback)?$/u;

export interface LessonRouteDependencies {
  /** The lesson library's dependencies for the project: store, directory, settings, access port, audit, citations and code facts (rollback settles each restored lesson), the judge (feedback). */
  lessons: LessonViewDeps & ApproveDeps & ProcessDeps & CounterDeps;
  /** The caller's role in the project: its name, or the one `PROJECT_NOT_FOUND` for no access, no such project and another company's. */
  projectFor(caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: ProjectRole }>;
  /** The project of a task the caller may read (the task page's own access check), or a throw. */
  taskFor(caller: DeveloperCaller, taskId: string): Promise<{ project: string }>;
}

function strictBody<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  // Field names only: the values are the caller's.
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

/** A refusal in fixed words. A lesson the person may not see answers exactly as one that is not there. */
const REFUSALS: Record<ApprovalFailure, readonly [AgentXErrorCode, string]> = {
  not_found: ["NOT_FOUND", "This lesson isn't available."],
  not_permitted: ["NOT_FOUND", "This lesson isn't available."],
  not_pending: ["CHANGE_STALE", "This lesson was already decided. Reload the list."],
  mode_off: ["LEARNING_SUGGESTIONS_OFF", "Learning is switched off for this project."],
  not_eligible: ["FORBIDDEN", "Only a maintainer of this project, or an admin, can decide lessons."],
  already_approved: ["CHANGE_STALE", "You already approved this lesson. A second maintainer or admin has to give the other approval."],
  author_cannot_approve_alone: ["FORBIDDEN", "You helped write this lesson, so another maintainer or admin has to approve it."],
  second_person_required: ["FORBIDDEN", "A different maintainer or admin has to give the second approval."],
  sole_owner_cool_off: ["CHANGE_STALE", "You are the only person who can approve this, and it needs a short wait first. Try again later."],
  eligibility_unavailable: ["RUNTIME_UNAVAILABLE", "Rovara can't check who may approve right now. Try again."],
  capability_request: ["CONFIG_INVALID", "That wording asks Rovara to change tools, checks, approvals or limits, which a lesson can't do."],
  tier_never: ["CONFIG_INVALID", "A lesson can't say that."],
  conflict: ["CHANGE_STALE", "This lesson changed while you were looking at it. Reload and check it again."],
  audit_unavailable: ["RUNTIME_UNAVAILABLE", "That couldn't be recorded, so nothing changed. Try again."],
};
const refuse = (code: ApprovalFailure): never => { const [errorCode, message] = REFUSALS[code]; throw agentXError(errorCode, message); };

/** A write: a live browser session (CSRF-protected) and a role that can write. The Auditor reads nothing here and writes nothing anywhere. */
function requireWrite(caller: DeveloperCaller): DeveloperCaller {
  requireWriterCaller(caller);
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", "Use a live browser session to decide lessons.");
  return caller;
}

export async function routeLessons(deps: LessonRouteDependencies, caller: DeveloperCaller, method: string, url: URL, body: () => unknown): Promise<object | undefined> {
  const task = TASK_LESSONS_PATH.exec(url.pathname);
  if (task !== null) return routeTaskLessons(deps, caller, method, task[1]!, task[2], body);
  const matched = LESSONS_PATH.exec(url.pathname);
  if (matched === null) return undefined;
  const [, rawProject, id, action] = matched;
  const who = { orgId: caller.orgId, developerId: caller.developerId };

  if (method === "GET") {
    if (id === undefined) return buildLessonsView(deps.lessons, who, (await deps.projectFor(caller, rawProject!)).name);
    if (action === undefined && id === "digest") return buildLessonsDigest(deps.lessons, who, (await deps.projectFor(caller, rawProject!)).name);
    if (action === undefined && id === "sources") return buildLessonSources(deps.lessons, who, (await deps.projectFor(caller, rawProject!)).name);
    if (action === "history") return buildLessonHistory(deps.lessons, who, (await deps.projectFor(caller, rawProject!)).name, id);
    return undefined;
  }
  if (method !== "POST") return undefined;

  if (id === "rollback" && action === undefined) {
    requireWrite(caller);
    const { name } = await deps.projectFor(caller, rawProject!);
    const input = strictBody(LessonRollbackBodySchema, body());
    const key: ScopeKey = { workspaceId: caller.orgId, project: name };
    // The person saw one version of the set; a set that moved since is not rolled back under them. Only a version the store lists can be the target.
    if ((await deps.lessons.store.setVersion(key)) !== input.expectedSetVersion) refuse("conflict");
    const known = (await deps.lessons.store.snapshots(key)).slice(-SNAPSHOTS_MAX);
    if (!known.some((s) => s.setVersion === input.targetSetVersion) || input.targetSetVersion === input.expectedSetVersion) throw agentXError("NOT_FOUND", "That earlier version isn't available.");
    const result = await rollbackLessonSetSettled(deps.lessons, { workspaceId: caller.orgId, project: name, targetSetVersion: input.targetSetVersion, actorId: caller.developerId });
    if (!result.ok) return refuse(result.code);
    return { setVersion: result.setVersion, restored: result.restored.length };
  }
  if (id === undefined || action === undefined || action === "history") return undefined;

  requireWrite(caller);
  const { name } = await deps.projectFor(caller, rawProject!);
  const common = { workspaceId: caller.orgId, project: name, lessonId: id };
  if (action === "approve") {
    const input = strictBody(LessonApproveBodySchema, body());
    const result = await approveLesson(deps.lessons, { ...common, approverId: caller.developerId, expectedVersion: input.expectedVersion, ...(input.edit === undefined ? {} : { edit: input.edit }) });
    if (!result.ok) return refuse(result.code);
    return { status: result.status, needs: result.needs };
  }
  if (action === "reject") {
    const input = strictBody(LessonRejectBodySchema, body());
    const result = await rejectLesson(deps.lessons, { ...common, approverId: caller.developerId, reason: input.reason, expectedVersion: input.expectedVersion });
    if (!result.ok) return refuse(result.code);
    return { done: true as const };
  }
  const input = strictBody(LessonRetireBodySchema, body());
  const result = await retireByPerson(deps.lessons, { ...common, actorId: caller.developerId, reason: input.reason ?? "Removed by a maintainer" });
  if (!result.ok) return refuse(result.code);
  return { done: true as const };
}

async function routeTaskLessons(deps: LessonRouteDependencies, caller: DeveloperCaller, method: string, taskId: string, lessonId: string | undefined, body: () => unknown): Promise<object | undefined> {
  const who = { orgId: caller.orgId, developerId: caller.developerId };
  if (method === "GET" && lessonId === undefined) {
    const { project } = await deps.taskFor(caller, taskId);
    return buildLoadedLessons(deps.lessons, who, project, taskId);
  }
  if (method !== "POST" || lessonId === undefined) return undefined;
  requireWrite(caller);
  const { project } = await deps.taskFor(caller, taskId);
  const input = strictBody(LessonFeedbackBodySchema, body());
  const viewer = await deps.lessons.directory.identity(caller.orgId, caller.developerId);
  const result = await recordFeedback(deps.lessons, { workspaceId: caller.orgId, project, taskId, lessonId, userId: caller.developerId, viewer, kind: input.kind });
  if (!result.ok) {
    if (result.code === "repeat") throw agentXError("CHANGE_STALE", "You already marked this lesson for this task.");
    throw agentXError("NOT_FOUND", "This lesson isn't available.");
  }
  return { done: true as const };
}
