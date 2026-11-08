// v1.2 learning loop: "Remember this" and "Forget" on a task-page comment (design 2.1, 2.4, 5.1).
//
// Remember writes one correction from a person's comment, idempotent per comment. Two standings are worked out here, live, from the company and project records (standing.ts):
//   - the REMEMBERER's must be member. An owner who took a task over as a viewer, a commenter or with no grant can reach this code through the task's own rules (review Critical 1),
//     so the task role is never enough;
//   - the comment AUTHOR's is stored on the correction. An outsider's comment is kept, so a maintainer can see it, but it never joins a group.
// Nothing the request says about standing, author or stage is read: the routes take an empty body (or ids only).
//
// Forget asks whether the caller may (the person who remembered it, the comment's author or a correction's own author, and a project maintainer read live) and hands the deletion to
// B5's `forgetCorrection`, which also deletes a comment's source record so it can be remembered again. It is refused once the correction belongs to a rule that is accepted or being accepted.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  LearningCorrectionSchema, OrgIdSchema, TaskCommentSchema, agentXError,
  type AgentXErrorCode, type LearningCorrection, type LearningStanding
} from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { commentKey, withoutKeys } from "../developer/page-comments.js";
import { can, resolveTaskAccess } from "../developer/task-access.js";
import { announceRemembered } from "../lessons/record-events.js";
import { flushLearningEvents, learningEvents, memberActor, rememberedEvent } from "./audit.js";
import { forgetCorrection } from "./grouping.js";
import { visibility } from "./retention.js";
import { learningScopeChecked, learningScopeOf, learningSalt, readProjectRole, readStanding, readStandingChecked } from "./standing.js";
import { signatureOf } from "./similarity.js";
import { captureCorrection, getLearningItem, readLearningPartition, sourceSk, type LearningDeps, type LearningScope } from "./store.js";
import { prepareCorrection } from "./text.js";

export type CaptureCommentDeps = DeveloperTaskRouteDependencies;
type ForgetDeps = Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName" | "now">;
/** `audit`: the Audit Ledger of the install, when there is one (the task route dependencies do not carry it). */
interface AuditOption { audit?: LearningDeps["audit"] | undefined }
/** `origin`: "slack" when the note came from a Slack thread; it follows the words into the Team record (the Slack rule). */
interface OriginOption { origin?: "slack" | undefined }

/** A comment is made on the requirements, design or plan of a task, so a correction from one is about the plan step. Accept lets a person choose another stage. */
export const COMMENT_STAGE = "plan";

export interface RememberAnswer { correction: { id: string; standing: LearningStanding; stage: string } }
export interface ForgetAnswer { forgotten: true }

/** A refusal the task page answers in its own words (`pageReason`, see task-web-api.ts `refusalResponse`). */
function refusal(code: AgentXErrorCode, pageReason: string, message: string): Error {
  return Object.assign(agentXError(code, message), { pageReason });
}
const notAllowed = (message: string) => refusal("FORBIDDEN", "not_allowed", message);
const gone = () => refusal("IDEMPOTENCY_CONFLICT", "gone", "That comment is gone.");
const notHere = () => refusal("IDEMPOTENCY_CONFLICT", "not_here", "Rovara isn't learning from this project right now.");

/** The source key of a comment: one correction per task comment. */
export const commentSourceKey = (taskId: string, commentId: string): string => `comment#${taskId}#${commentId}`;
export const correctionIdOf = (sourceKey: string): string => createHash("sha256").update(`learning-correction\0${sourceKey}`, "utf8").digest("hex").slice(0, 32);

const learningDepsOf = (deps: ForgetDeps, audit?: LearningDeps["audit"]): LearningDeps => ({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(audit === undefined ? {} : { audit }) });

function parseCorrection(item: Record<string, unknown> | undefined): LearningCorrection | undefined {
  if (item === undefined) return undefined;
  const { pk: _pk, sk: _sk, entityType: _entityType, orgId: _orgId, ...rest } = item; // eslint-disable-line @typescript-eslint/no-unused-vars
  const parsed = LearningCorrectionSchema.safeParse(rest);
  return parsed.success ? parsed.data : undefined;
}

const view = (correction: LearningCorrection): RememberAnswer => ({ correction: { id: correction.id, standing: correction.standing, stage: correction.stage } });

// ---- Remember

/**
 * Remembers one comment of a task. The caller is the signed-in person; `options.project` (the React route) must be the task's own project. Refuses, storing nothing, when the person
 * may not comment on the task, is not a member of its project, or the comment is not a correction.
 */
export async function rememberTaskComment(deps: CaptureCommentDeps, caller: DeveloperCaller, taskId: string, commentId: string, options: { project?: string } & AuditOption & OriginOption = {}): Promise<RememberAnswer> {
  const access = await resolveTaskAccess(deps, caller, taskId);
  if (access.source === "session" || !can(access.role, "comment")) throw notAllowed("You can read this task but not comment on it.");
  const project = access.task.project;
  if (options.project !== undefined && options.project !== project) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  // The task role is not enough: the person's own standing in the project, read now.
  const rememberer = await readStandingChecked(deps, caller.orgId, caller.developerId, project);
  if (rememberer.standing !== "member") throw notAllowed("Only members of this project can use Remember.");
  const checkedScope = await learningScopeChecked(deps, caller.orgId, project);
  if (checkedScope === undefined) throw notHere();
  const { scope } = checkedScope;

  const stored = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: commentKey(taskId, commentId), ConsistentRead: true }))) as { Item?: Record<string, unknown> };
  const parsed = stored.Item === undefined ? undefined : TaskCommentSchema.safeParse(withoutKeys(stored.Item));
  if (parsed === undefined || !parsed.success || parsed.data.taskId !== taskId || parsed.data.deletedAt !== undefined) throw gone();
  const comment = parsed.data;
  if (comment.author.kind !== "person") throw refusal("CONFIG_INVALID", "refused", "Only a person's comment can be remembered.");
  const authorId = comment.author.developerId;
  const authorStanding = authorId === caller.developerId ? "member" as const : await readStanding(deps, caller.orgId, authorId, project);

  const prepared = prepareCorrection(comment.text);
  if (!prepared.ok) {
    throw refusal("CONFIG_INVALID", "refused", prepared.reason === "generic" ? "That comment doesn't say anything specific enough to remember." : "That comment is too short to remember.");
  }

  const sourceKey = commentSourceKey(taskId, commentId);
  const learning = learningDepsOf(deps, options.audit);
  const correctionId = correctionIdOf(sourceKey);
  // The event goes into the capture's own transaction (a repeat of the same comment writes nothing, so it records nothing).
  const audited = await learningEvents(learning, () => [rememberedEvent(learning, scope, memberActor(caller.developerId), { correctionId, stage: COMMENT_STAGE, standing: authorStanding, op: "remember" })]);
  const result = await captureCorrection(learning, scope, {
    id: correctionId, stage: COMMENT_STAGE, source: "comment", sourceKey, sourceRef: { taskId, commentId }, taskId, text: prepared.text,
    signature: [...signatureOf(prepared.text, learningSalt(scope))], author: authorId, standing: authorStanding, rememberedBy: caller.developerId, limit: "remember", actor: caller.developerId,
  }, { conditions: [...rememberer.checks, ...checkedScope.checks, ...audited.items] });
  if (result.ok) {
    if (result.created) {
      await flushLearningEvents(learning, audited.events);
      // The Team record (where it is on): the words are their author's. Bounded and never failing: see lessons/record-events.ts.
      await announceRemembered({ ...access.task, orgId: caller.orgId }, { noteId: correctionId, text: prepared.text, actorDeveloperId: authorId, at: new Date(deps.now()).toISOString(), origin: options.origin }, { log: (event, fields) => deps.log?.({ event, ...fields }) });
      return view(result.correction);
    }
    const existing = parseCorrection(await getLearningItem(learning, scope, result.correctionSk));
    if (existing === undefined) throw refusal("IDEMPOTENCY_CONFLICT", "changed", "This task changed. Refresh the page and try again.");
    return view(existing);
  }
  switch (result.reason) {
    case "rate_limited": throw refusal("TASK_BUSY", "slow_down", "You've remembered a lot in the last 10 minutes. Try again in a few minutes.");
    case "store_full": throw refusal("CONFIG_INVALID", "refused", "This project has reached its limit of remembered corrections for now.");
    case "stale": throw refusal("IDEMPOTENCY_CONFLICT", "changed", "This project changed. Refresh the page and try again.");
    default: throw refusal("CONFIG_INVALID", "refused", "That couldn't be remembered right now.");
  }
}

// ---- What lessons may read

/**
 * The notes of a task's comments that are LIVE corrections now, by note id (the correction's id): a comment that was remembered and not forgotten. The Team record keeps a `rovara.remembered` row for
 * every remember, and Forget does not remove it, so lessons take their notes from here and never from the comments themselves. A comment never remembered, or forgotten (its source record and correction are
 * gone), is not listed. THROWS when the store cannot be read (the caller does not treat a failed read as "nothing remembered").
 */
export async function liveRememberedNoteIds(deps: ForgetDeps, orgId: string, project: string, taskId: string, commentIds: readonly string[]): Promise<string[]> {
  const org = OrgIdSchema.safeParse(orgId);
  if (!org.success) return [];
  const scope = await learningScopeOf(deps, org.data, project);
  if (scope === undefined) return [];
  const learning = learningDepsOf(deps);
  const live: string[] = [];
  for (const commentId of commentIds) {
    const sourceKey = commentSourceKey(taskId, commentId);
    const source = await getLearningItem(learning, scope, sourceSk(scope.projectCreatedAt, sourceKey));
    if (source === undefined || visibility(source, { nowMs: deps.now(), projectCreatedAt: scope.projectCreatedAt }) !== "visible" || typeof source["correctionSk"] !== "string") continue;
    if (await getLearningItem(learning, scope, source["correctionSk"]) === undefined) continue;
    live.push(correctionIdOf(sourceKey));
  }
  return live;
}

// ---- Forget

/** Forget a task comment's correction. Whoever can read the task may ask; the rights check is on the correction. */
export async function forgetTaskComment(deps: CaptureCommentDeps, caller: DeveloperCaller, taskId: string, commentId: string, options: { project?: string } & AuditOption = {}): Promise<ForgetAnswer> {
  const access = await resolveTaskAccess(deps, caller, taskId);
  const project = access.task.project;
  if (options.project !== undefined && options.project !== project) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  const scope = await learningScopeOf(deps, caller.orgId, project);
  if (scope === undefined) return { forgotten: true };
  const source = await getLearningItem(learningDepsOf(deps, options.audit), scope, sourceSk(scope.projectCreatedAt, commentSourceKey(taskId, commentId)));
  if (source === undefined || typeof source["correctionSk"] !== "string") return { forgotten: true };
  return forgetAt(deps, caller, scope, source["correctionSk"], options.audit);
}

/** Forget a correction by its id (the React route). The partition is read within the project's cap of 2,000 corrections. */
export async function forgetCorrectionById(deps: ForgetDeps, caller: DeveloperCaller, project: string, correctionId: string, options: AuditOption = {}): Promise<ForgetAnswer> {
  const scope = await learningScopeOf(deps, caller.orgId, project);
  if (scope === undefined) return { forgotten: true };
  let cursor: string | undefined;
  for (let pages = 0; pages < 25; pages += 1) {
    const page = await readLearningPartition(learningDepsOf(deps, options.audit), scope, { prefix: "CORRECTION#", ...(cursor === undefined ? {} : { cursor }), maxItems: 100, maxPages: 1, pageSize: 100 });
    const found = page.items.find((item) => item["id"] === correctionId);
    if (found !== undefined && typeof found["sk"] === "string") return forgetAt(deps, caller, scope, found["sk"], options.audit);
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  return { forgotten: true };
}

async function mayForget(deps: ForgetDeps, caller: DeveloperCaller, scope: LearningScope, correction: LearningCorrection): Promise<boolean> {
  if (correction.rememberedBy === caller.developerId || correction.author === caller.developerId) return true;
  return await readProjectRole(deps, caller.orgId, caller.developerId, scope.project) === "maintainer";
}

/** Forgets one correction. B5's `forgetCorrection` does the work (the counters, the metric, the suggestion, the source record); this route only asks whether the caller may. */
async function forgetAt(deps: ForgetDeps, caller: DeveloperCaller, scope: LearningScope, sk: string, audit?: LearningDeps["audit"]): Promise<ForgetAnswer> {
  const learning = learningDepsOf(deps, audit);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const correction = parseCorrection(await getLearningItem(learning, scope, sk));
    if (correction === undefined) return { forgotten: true };
    if (!await mayForget(deps, caller, scope, correction)) throw notAllowed("Only the person who remembered this, the person who wrote it, or a project maintainer can forget it.");
    // A comment can be remembered again, so its source record goes too; an automatic capture keeps its source record, so a retry of the same decision does not bring a forgotten correction back.
    const sourceKey = correction.source === "comment" && correction.sourceRef.taskId !== undefined && correction.sourceRef.commentId !== undefined
      ? commentSourceKey(correction.sourceRef.taskId, correction.sourceRef.commentId) : undefined;
    let result;
    try {
      result = await forgetCorrection(learning, scope, { correctionSk: sk, actor: caller.developerId, ...(sourceKey === undefined ? {} : { sourceKey }) });
    } catch (error) {
      // The correction changed under the write (judged or grouped meanwhile): look again.
      if (attempt < 2 && (error as { code?: string }).code === "RUNTIME_UNAVAILABLE") continue;
      throw error;
    }
    if (result.ok || result.reason === "missing") return { forgotten: true };
    // Part of an accepted rule, or of a suggestion that is being accepted.
    if (result.reason === "suggestion_changed") throw refusal("IDEMPOTENCY_CONFLICT", "changed", "This item changed. Refresh the page and try again.");
    throw refusal("CONFIG_INVALID", "refused", result.reason === "in_accepted_rule"
      ? "This is part of a rule that was accepted. Remove the rule instead."
      : "This is part of a rule that is being accepted. Try again once it is decided.");
  }
  throw refusal("IDEMPOTENCY_CONFLICT", "changed", "This item changed. Refresh the page and try again.");
}
