// Learning v2 L3b: the app routes of the Lessons tab, the Sources tab and the task page's lessons list.
//   GET  /v1/app/projects/{p}/lessons                      the tab's one read
//   GET  /v1/app/projects/{p}/lessons/digest               the weekly digest (people who decide)
//   GET  /v1/app/projects/{p}/lessons/sources              the sources that feed the record
//   GET  /v1/app/projects/{p}/lessons/{id}/history         versions and who approved each (people who decide)
//   POST /v1/app/projects/{p}/lessons/{id}/approve         one-tap approval, or edit and approve
//   POST /v1/app/projects/{p}/lessons/{id}/reject
//   POST /v1/app/projects/{p}/lessons/{id}/retire
//   POST /v1/app/projects/{p}/lessons/preset               a maintainer sets the preset: Regulated at once; Standard opens a proposal a different person approves (.../preset/approve, .../preset/cancel)
//   POST /v1/app/org/lessons/preset                        a company owner or admin sets the company's preset the same way (a floor for every project)
//   POST /v1/app/projects/{p}/lessons/rollback
//   POST /v1/app/projects/{p}/lessons/sources/resume       a maintainer resumes a paused source (UX-4b; `resumeAndResettle`)
//   GET  /v1/app/tasks/{task}/lessons                      the lessons the agent loaded
//   POST /v1/app/tasks/{task}/lessons/{id}/feedback        "Helpful" / "Wrong here" / thumbs-down
//
// The module answers `undefined` for a path it does not own, as `routeLearning` does. Authority: the project is found through `projectFor` (another company's project and one the caller
// cannot see answer the same way); who may decide is the lesson library's own check (`ApproverDirectory`, the second-person rule, the access records); a write needs a live browser
// session and a writer role (the Auditor is refused); a refusal is a fixed sentence, never text from a lesson, a row or an error.
import {
  LessonApproveBodySchema, LessonFeedbackBodySchema, LessonPresetBodySchema, LessonPresetChangeBodySchema, LessonResumeSourceBodySchema, LessonRejectBodySchema, LessonRetireBodySchema, LessonRollbackBodySchema, agentXError,
  type AgentXErrorCode, type ProjectRole,
} from "@agentx/contracts";
import type { ZodType } from "zod";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { requireWriterCaller } from "../org/auditor.js";
import { approveLesson, rejectLesson, retireByPerson, type ApprovalFailure, type ApproveDeps } from "./approve.js";
import { recordFeedback, type CounterDeps } from "./counters.js";
import { resolveLearning, whyLearningOff } from "./policy.js";
import { approvePresetChange, cancelPresetChange, setLearningPreset, type PresetDeps, type PresetFailure, type PresetResult, type PresetScope } from "./preset-setting.js";
import { rollbackLessonSetSettled } from "./rollback.js";
import { resumeAndResettle, type ProcessDeps } from "./process.js";
import { buildLessonHistory, pauseMatches, buildLessonSources, buildLessonsDigest, buildLessonsView, buildLoadedLessons, SNAPSHOTS_MAX, type LessonViewDeps } from "./view.js";
import type { ScopeKey } from "./store.js";

export const LESSONS_PATH = /^\/v1\/app\/projects\/([^/]+)\/lessons(?:\/([A-Za-z0-9_-]{1,64})(?:\/(approve|reject|retire|history|resume|cancel))?)?$/u;
/** The company's preset (an owner or admin): `POST` sets it, `POST .../approve` and `.../cancel` decide a proposal to loosen it. */
export const COMPANY_PRESET_PATH = /^\/v1\/app\/org\/lessons\/preset(?:\/(approve|cancel))?$/u;
export const TASK_LESSONS_PATH = /^\/v1\/app\/tasks\/([0-9a-f-]{36})\/lessons(?:\/([A-Za-z0-9_-]{4,64})\/feedback)?$/u;

export interface LessonRouteDependencies {
  /** The lesson library's dependencies for the project: store, directory, settings, access port, audit, citations and code facts (rollback settles each restored lesson), the judge (feedback). */
  lessons: LessonViewDeps & ApproveDeps & ProcessDeps & CounterDeps & { /** Where a maintainer makes the project stricter (Regulated). Absent: the preset route is not there. */ presets?: PresetDeps };
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
  if (resolved.mode !== "Off") return;
  if (!sources) throw agentXError("NOT_FOUND", "Lessons are not available for this project.");
  // The Sources read tells the person why, each in a fixed code: the project's own Off (404 LEARNING_OFF), the company's lock (404 LEARNING_LOCKED), or a setting that could not be read (503, so the page asks to retry).
  // The other routes are unchanged, and the team record's switch off never reaches here (no lessons routes at all).
  const why = await whyLearningOff(deps.lessons.settings, caller.orgId, project);
  if (why === "locked") throw agentXError("LEARNING_LOCKED", "Learning is off for this project because of a company setting.");
  if (why === "unreadable") throw agentXError("RUNTIME_UNAVAILABLE", "The learning setting for this project could not be read.");
  throw agentXError("LEARNING_OFF", "Learning is off for this project.");
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

const PRESET_REFUSALS: Partial<Record<PresetFailure, readonly [AgentXErrorCode, string]>> = {
  eligibility_unavailable: ["RUNTIME_UNAVAILABLE", "Rovara can't check who may change this right now. Try again."],
  second_person_required: ["FORBIDDEN", "A different maintainer or admin has to approve going back to Standard."],
  sole_owner_cool_off: ["CHANGE_STALE", "You are the only person who can approve this, and it needs a short wait first. Try again later."],
  audit_unavailable: ["RUNTIME_UNAVAILABLE", "That couldn't be recorded, so nothing changed. Try again."],
  already_open: ["CHANGE_STALE", "A change to Standard is already waiting for a different person to approve it."],
  expired: ["CHANGE_STALE", "That proposal expired. Ask again."],
  not_found: ["NOT_FOUND", "No such proposal."],
  not_pending: ["CHANGE_STALE", "That proposal was already decided."],
  below_company_floor: ["FORBIDDEN", "Your company requires a person for every lesson, so a project can't go back to Standard."],
  membership_changed_retry: ["CHANGE_STALE", "Someone joined or left meanwhile. Check and approve again."],
  invalid_value: ["CONFIG_INVALID", "That setting can't be changed here."],
};
function refusePreset(code: PresetFailure, notEligible: string): never {
  if (code === "not_eligible") throw agentXError("FORBIDDEN", notEligible);
  const [errorCode, message] = PRESET_REFUSALS[code] ?? ["CHANGE_STALE", "This setting changed. Reload and try again."];
  throw agentXError(errorCode, message);
}

/** Sets, approves or cancels a change of the preset of one scope (a project or the company). The library decides who may; the answer is fixed words and ids. */
async function routePreset(deps: LessonRouteDependencies, caller: DeveloperCaller, scope: PresetScope, action: string | undefined, body: () => unknown, notEligible: string): Promise<object> {
  const presets = deps.lessons.presets;
  if (presets === undefined) throw agentXError("NOT_FOUND", "Lessons are not available for this project.");
  await takeBudget(deps, caller, "decision");
  if (action === undefined) {
    const input = strictBody(LessonPresetBodySchema, body());
    const result: PresetResult = await setLearningPreset(presets, { scope, value: input.preset, requestedBy: caller.developerId });
    if (!result.ok) return refusePreset(result.code, notEligible);
    // A proposal leaves the value in force as it is: the answer says which one that is.
    if (result.status === "needs_approval") return { preset: result.value, changed: false, needsApproval: true, changeId: result.changeId };
    return { preset: result.value, changed: result.changed };
  }
  const input = strictBody(LessonPresetChangeBodySchema, body());
  if (action === "cancel") {
    const result = await cancelPresetChange(presets, { scope, changeId: input.changeId, actorId: caller.developerId });
    if (!result.ok) return refusePreset(result.code, notEligible);
    return { done: true as const };
  }
  const result = await approvePresetChange(presets, { scope, changeId: input.changeId, approverId: caller.developerId });
  if (!result.ok) return refusePreset(result.code, notEligible);
  return { preset: result.value, changed: true };
}

export async function routeLessons(deps: LessonRouteDependencies, caller: DeveloperCaller, method: string, url: URL, body: () => unknown): Promise<object | undefined> {
  const company = COMPANY_PRESET_PATH.exec(url.pathname);
  if (company !== null) {
    if (method !== "POST") return undefined;
    requireWrite(caller);
    // The company's preset is a floor for every project, so only an owner or admin sets it (the library then checks the live roster and the fence).
    if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "Only a company owner or admin can change this.");
    return routePreset(deps, caller, { kind: "company", workspaceId: caller.orgId }, company[1], body, "Only a company owner or admin can change this.");
  }
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
    // UX-4b: the tab's own read says why too (LEARNING_OFF / LEARNING_LOCKED), so the Lessons tab explains it and offers to turn learning on instead of "not set up".
    await requireLearningOn(deps, caller, name, id === undefined || (action === undefined && id === "sources"));
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
  if (id === "sources" && action === "resume") {
    requireWrite(caller);
    const { name, role } = await deps.projectFor(caller, rawProject!);
    await requireLearningOn(deps, caller, name);
    // The pause says "a maintainer has to resume it": the project's maintainers (company admins count as maintainers there), nobody else.
    if (role !== "maintainer") throw agentXError("FORBIDDEN", "Only a maintainer of this project can resume a source.");
    const input = strictBody(LessonResumeSourceBodySchema, body());
    const key: ScopeKey = { workspaceId: caller.orgId, project: name };
    const paused = Object.keys((await deps.lessons.store.flags(key)).pausedSources ?? {}).filter((pauseKey) => pauseMatches(pauseKey, input.source, input.scope));
    // Review fix 6 (and its re-check): only a source this person can see in the Sources tab (named, and this project's own) is resumed or even answered about, checked before any budget is taken; any
    // other answers as one that is not there. A company owner or admin may also resume a paused key that no source row holds any more (the tab's "other paused sources"), and only that.
    const listed = (await buildLessonSources(deps.lessons, who, name)).sources;
    const visible = listed.some((row) => row.kind === input.source && "scope" in row && row.scope === input.scope);
    const orphan = (caller.orgRole === "owner" || caller.orgRole === "admin") && paused.length > 0 && !listed.some((row) => row.kind === input.source && (!("scope" in row) || row.scope === input.scope));
    if (!visible && !orphan) throw agentXError("NOT_FOUND", "No such source.");
    await takeBudget(deps, caller, "decision");
    let settled = 0, resumed = false;
    for (const pauseKey of paused) {
      const result = await resumeAndResettle(deps.lessons, key, pauseKey, caller.developerId);
      resumed ||= result.resumed;
      settled += result.settled.length;
    }
    return { resumed, settled };
  }
  if (id === "preset" && (action === undefined || action === "approve" || action === "cancel")) {
    requireWrite(caller);
    // Making a setting stricter is always allowed, so this does not wait for learning to be on: a project with learning Off can still be set to Regulated.
    const { name } = await deps.projectFor(caller, rawProject!);
    return routePreset(deps, caller, { kind: "project", workspaceId: caller.orgId, project: name }, action, body, "Only a maintainer of this project, or an admin, can change how lessons are approved.");
  }
  if (id === undefined || action === undefined || action === "history" || action === "resume" || action === "cancel") return undefined;

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
    // The one-tap thumbs-down is offered only to someone it will work for: a writer with a role in the task's project.
    const canThumbsDown = await deps.projectFor(caller, project).then(() => { try { requireWriterCaller(caller); return caller.browserSession === true; } catch { return false; } }, () => false);
    return { ...(await buildLoadedLessons(deps.lessons, who, project, taskId)), canThumbsDown };
  }
  if (method !== "POST" || lessonId === undefined) return undefined;
  requireWrite(caller);
  const { project } = await deps.taskFor(caller, taskId);
  await requireLearningOn(deps, caller, project);
  await takeBudget(deps, caller, "mark");
  const input = strictBody(LessonFeedbackBodySchema, body());
  const viewer = await deps.lessons.directory.identity(caller.orgId, caller.developerId);
  // A thumbs-down retires a lesson on trial, so it needs a role in the project (`projectFor` answers the one PROJECT_NOT_FOUND for none); the other marks are open to whoever can read the task.
  if (input.kind === "thumbs_down") await deps.projectFor(caller, project);
  const result = await recordFeedback(deps.lessons, { workspaceId: caller.orgId, project, taskId, lessonId, userId: caller.developerId, viewer, kind: input.kind, ...(input.kind === "thumbs_down" ? { projectMember: true } : {}) });
  if (!result.ok) {
    if (result.code === "repeat") throw agentXError("CHANGE_STALE", "You already marked this lesson for this task.");
    throw agentXError("NOT_FOUND", "This lesson isn't available.");
  }
  return { done: true as const };
}
