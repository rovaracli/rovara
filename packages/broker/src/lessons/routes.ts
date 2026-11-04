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
import { resolveLearning } from "./policy.js";
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
  /**
   * One take from a per-person rate row (the existing `takeRateAt` rows): `bucket` names the row, `limit` is what a person may do in `LESSON_RATE_WINDOW_MS`. True when the take was
   * allowed. A refusal is 429, and a rate row that cannot be read or written refuses the request (fail closed).
   */
  rate(caller: DeveloperCaller, bucket: string, limit: number, windowMs: number): Promise<boolean>;
}

/** What a person may do per minute: any decision (approve, reject, remove), edits (each also counts as a decision), a rollback, Helpful / Wrong here marks, and the heavier reads (the weekly digest and a lesson's history). */
export const LESSON_RATES = { decision: 30, edit: 10, rollback: 5, mark: 60, read: 60 } as const;
export const LESSON_RATE_WINDOW_MS = 60_000;
export const LESSON_RATE_BUCKETS = { decision: "LESSON_DECISIONS", edit: "LESSON_EDITS", rollback: "LESSON_ROLLBACKS", mark: "LESSON_MARKS", read: "LESSON_READS" } as const;

async function takeBudget(deps: LessonRouteDependencies, caller: DeveloperCaller, kind: keyof typeof LESSON_RATES): Promise<void> {
  let allowed: boolean;
  try { allowed = await deps.rate(caller, LESSON_RATE_BUCKETS[kind], LESSON_RATES[kind], LESSON_RATE_WINDOW_MS); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "The request budget for lessons could not be checked."); }
  if (!allowed) throw agentXError("TOO_MANY_REQUESTS", "Too many lesson requests. Try again in a minute.");
}

/** Lessons answer only where learning is on for the project: with the project's mode Off (or no setting that reads), every lesson route answers "not found", as it did before lessons existed. */
async function requireLearningOn(deps: LessonRouteDependencies, caller: DeveloperCaller, project: string, sources = false): Promise<void> {
  const resolved = await resolveLearning(deps.lessons.settings, caller.orgId, project);
  // The Sources read says so in its own fixed code (still a 404): the page can tell "learning is off" from "the team record is not set up here" (that one has no lessons routes at all). The other routes are unchanged.
  if (resolved.mode === "Off") throw sources ? agentXError("LEARNING_OFF", "Learning is off for this project.") : agentXError("NOT_FOUND", "Lessons are not available for this project.");
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

  // The project, and whether learning is on for it, come first for every path: a path that is not a lessons read or write answers `undefined` only after that.
  if (method === "GET") {
    const known = id === undefined || (action === undefined && (id === "digest" || id === "sources")) || action === "history";
    if (!known) return undefined;
    const { name } = await deps.projectFor(caller, rawProject!);
    await requireLearningOn(deps, caller, name, action === undefined && id === "sources");
    if (id === undefined) return buildLessonsView(deps.lessons, who, name);
    await takeBudget(deps, caller, "read");
    if (action === undefined && id === "digest") return buildLessonsDigest(deps.lessons, who, name);
    if (action === undefined && id === "sources") return buildLessonSources(deps.lessons, who, name);
    return buildLessonHistory(deps.lessons, who, name, id);
  }
  if (method !== "POST") return undefined;

  if (id === "rollback" && action === undefined) {
    requireWrite(caller);
    const { name } = await deps.projectFor(caller, rawProject!);
    await requireLearningOn(deps, caller, name);
    await takeBudget(deps, caller, "rollback");
    const input = strictBody(LessonRollbackBodySchema, body());
    const key: ScopeKey = { workspaceId: caller.orgId, project: name };
    // The person saw one version of the set; a set that moved since is not rolled back under them. Only a version the store lists can be the target.
    if ((await deps.lessons.store.setVersion(key)) !== input.expectedSetVersion) refuse("conflict");
    const known = (await deps.lessons.store.snapshots(key)).slice(-SNAPSHOTS_MAX);
    if (!known.some((s) => s.setVersion === input.targetSetVersion) || input.targetSetVersion === input.expectedSetVersion) throw agentXError("NOT_FOUND", "That earlier version isn't available.");
    const result = await rollbackLessonSetSettled(deps.lessons, { workspaceId: caller.orgId, project: name, targetSetVersion: input.targetSetVersion, actorId: caller.developerId, expectedSetVersion: input.expectedSetVersion });
    if (!result.ok) return refuse(result.code);
    return { setVersion: result.setVersion, restored: result.restored.length };
  }
  if (id === undefined || action === undefined || action === "history") return undefined;

  requireWrite(caller);
  const { name } = await deps.projectFor(caller, rawProject!);
  await requireLearningOn(deps, caller, name);
  await takeBudget(deps, caller, "decision");
  const common = { workspaceId: caller.orgId, project: name, lessonId: id };
  if (action === "approve") {
    const input = strictBody(LessonApproveBodySchema, body());
    if (input.edit !== undefined) await takeBudget(deps, caller, "edit");
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
    await requireLearningOn(deps, caller, project);
    return buildLoadedLessons(deps.lessons, who, project, taskId);
  }
  if (method !== "POST" || lessonId === undefined) return undefined;
  requireWrite(caller);
  const { project } = await deps.taskFor(caller, taskId);
  await requireLearningOn(deps, caller, project);
  await takeBudget(deps, caller, "mark");
  const input = strictBody(LessonFeedbackBodySchema, body());
  const viewer = await deps.lessons.directory.identity(caller.orgId, caller.developerId);
  const result = await recordFeedback(deps.lessons, { workspaceId: caller.orgId, project, taskId, lessonId, userId: caller.developerId, viewer, kind: input.kind });
  if (!result.ok) {
    if (result.code === "repeat") throw agentXError("CHANGE_STALE", "You already marked this lesson for this task.");
    throw agentXError("NOT_FOUND", "This lesson isn't available.");
  }
  return { done: true as const };
}
