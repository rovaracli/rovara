// v1.2 learning loop: "Remember this" and "Forget" on a task-page comment (design 2.1, 2.4, 5.1).
//
// Remember writes one correction from a person's comment, idempotent per comment. Two standings are worked out here, live, from the company and project records (standing.ts):
//   - the REMEMBERER's must be member. An owner who took a task over as a viewer, a commenter or with no grant can reach this code through the task's own rules (review Critical 1),
//     so the task role is never enough;
//   - the comment AUTHOR's is stored on the correction. An outsider's comment is kept, so a maintainer can see it, but it never joins a group.
// Nothing the request says about standing, author or stage is read: the routes take an empty body (or ids only).
//
// Forget deletes the correction (and, for a comment, its source record, so the comment can be remembered again). It is allowed for the person who remembered it, the comment's author
// (or a correction's own author) and a project maintainer read live. It is refused once the correction belongs to a rule that is accepted or being accepted. A suggestion that loses a
// source is updated under its revision, or withdrawn when fewer than 2 sources remain.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  LearningCorrectionSchema, LearningSuggestionSchema, TaskCommentSchema, agentXError, projectLearningKey,
  type AgentXErrorCode, type LearningCorrection, type LearningStanding
} from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { commentKey, withoutKeys } from "../developer/page-comments.js";
import { can, resolveTaskAccess } from "../developer/task-access.js";
import { learningScopeOf, learningSalt, readProjectRole, readStanding } from "./standing.js";
import { signatureOf } from "./similarity.js";
import { captureCorrection, getLearningItem, readLearningPartition, sourceSk, suggestionSk, terminalSuggestionItems, type LearningDeps, type LearningScope } from "./store.js";
import { prepareCorrection } from "./text.js";

export type CaptureCommentDeps = DeveloperTaskRouteDependencies;
type ForgetDeps = Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName" | "now">;
type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

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
const correctionIdOf = (sourceKey: string): string => createHash("sha256").update(`learning-correction\0${sourceKey}`, "utf8").digest("hex").slice(0, 32);

const learningDepsOf = (deps: ForgetDeps): LearningDeps => ({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now });

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
export async function rememberTaskComment(deps: CaptureCommentDeps, caller: DeveloperCaller, taskId: string, commentId: string, options: { project?: string } = {}): Promise<RememberAnswer> {
  const access = await resolveTaskAccess(deps, caller, taskId);
  if (access.source === "session" || !can(access.role, "comment")) throw notAllowed("You can read this task but not comment on it.");
  const project = access.task.project;
  if (options.project !== undefined && options.project !== project) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  // The task role is not enough: the person's own standing in the project, read now.
  if (await readStanding(deps, caller.orgId, caller.developerId, project) !== "member") throw notAllowed("Only members of this project can use Remember.");
  const scope = await learningScopeOf(deps, caller.orgId, project);
  if (scope === undefined) throw notHere();

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
  const result = await captureCorrection(learningDepsOf(deps), scope, {
    id: correctionIdOf(sourceKey), stage: COMMENT_STAGE, source: "comment", sourceKey, sourceRef: { taskId, commentId }, taskId, text: prepared.text,
    signature: [...signatureOf(prepared.text, learningSalt(scope))], author: authorId, standing: authorStanding, rememberedBy: caller.developerId, limit: "remember", actor: caller.developerId,
  });
  if (result.ok) {
    if (result.created) return view(result.correction);
    const existing = parseCorrection(await getLearningItem(learningDepsOf(deps), scope, result.correctionSk));
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

// ---- Forget

/** Forget a task comment's correction. Whoever can read the task may ask; the rights check is on the correction. */
export async function forgetTaskComment(deps: CaptureCommentDeps, caller: DeveloperCaller, taskId: string, commentId: string, options: { project?: string } = {}): Promise<ForgetAnswer> {
  const access = await resolveTaskAccess(deps, caller, taskId);
  const project = access.task.project;
  if (options.project !== undefined && options.project !== project) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  const scope = await learningScopeOf(deps, caller.orgId, project);
  if (scope === undefined) return { forgotten: true };
  const source = await getLearningItem(learningDepsOf(deps), scope, sourceSk(commentSourceKey(taskId, commentId)));
  if (source === undefined || typeof source["correctionSk"] !== "string") return { forgotten: true };
  return forgetAt(deps, caller, scope, source["correctionSk"]);
}

/** Forget a correction by its id (the React route). The partition is read within the project's cap of 2,000 corrections. */
export async function forgetCorrectionById(deps: ForgetDeps, caller: DeveloperCaller, project: string, correctionId: string): Promise<ForgetAnswer> {
  const scope = await learningScopeOf(deps, caller.orgId, project);
  if (scope === undefined) return { forgotten: true };
  let cursor: string | undefined;
  for (let pages = 0; pages < 25; pages += 1) {
    const page = await readLearningPartition(learningDepsOf(deps), scope, { prefix: "CORRECTION#", ...(cursor === undefined ? {} : { cursor }), maxItems: 100, maxPages: 1, pageSize: 100 });
    const found = page.items.find((item) => item["id"] === correctionId);
    if (found !== undefined && typeof found["sk"] === "string") return forgetAt(deps, caller, scope, found["sk"]);
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  return { forgotten: true };
}

async function mayForget(deps: ForgetDeps, caller: DeveloperCaller, scope: LearningScope, correction: LearningCorrection): Promise<boolean> {
  if (correction.rememberedBy === caller.developerId || correction.author === caller.developerId) return true;
  return await readProjectRole(deps, caller.orgId, caller.developerId, scope.project) === "maintainer";
}

async function forgetAt(deps: ForgetDeps, caller: DeveloperCaller, scope: LearningScope, sk: string): Promise<ForgetAnswer> {
  const learning = learningDepsOf(deps);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const correction = parseCorrection(await getLearningItem(learning, scope, sk));
    if (correction === undefined) return { forgotten: true };
    if (!await mayForget(deps, caller, scope, correction)) throw notAllowed("Only the person who remembered this, the person who wrote it, or a project maintainer can forget it.");

    const items: TransactItem[] = [{ Delete: { TableName: deps.tableName, Key: projectLearningKey(scope.orgId, scope.project, sk), ConditionExpression: "attribute_exists(pk)" } }];
    // A comment can be remembered again; an automatic capture keeps its source record, so a retry of the same decision does not bring a forgotten correction back.
    if (correction.source === "comment" && correction.sourceRef.taskId !== undefined && correction.sourceRef.commentId !== undefined) {
      items.push({ Delete: { TableName: deps.tableName, Key: projectLearningKey(scope.orgId, scope.project, sourceSk(commentSourceKey(correction.sourceRef.taskId, correction.sourceRef.commentId))) } });
    }
    if (correction.suggestionId !== undefined) {
      const stored = await getLearningItem(learning, scope, suggestionSk(correction.suggestionId));
      // Judged by the stored status first, so an item that does not read as a suggestion never lets a forget through while a rule may be built from it.
      const status = stored?.["status"];
      if (status === "accepted" || status === "accepting" || status === "awaiting_approval") {
        throw refusal("CONFIG_INVALID", "refused", "This is part of a rule that was accepted. Remove the rule instead.");
      }
      if (status === "open") {
        const suggestion = LearningSuggestionSchema.safeParse(stored);
        if (!suggestion.success) throw refusal("IDEMPOTENCY_CONFLICT", "changed", "This changed while you were forgetting it. Try again.");
        const { correctionIds, revision, id } = suggestion.data;
        if (correctionIds.includes(correction.id)) {
          const remaining = correctionIds.filter((other) => other !== correction.id);
          if (remaining.length >= 2) {
            items.push({ Update: {
              TableName: deps.tableName, Key: projectLearningKey(scope.orgId, scope.project, suggestionSk(id)),
              UpdateExpression: "SET correctionIds = :ids, #revision = #revision + :one",
              ConditionExpression: "projectCreatedAt = :pc AND #status = :open AND #revision = :revision", ExpressionAttributeNames: { "#status": "status", "#revision": "revision" },
              ExpressionAttributeValues: { ":ids": remaining, ":one": 1, ":pc": scope.projectCreatedAt, ":open": "open", ":revision": revision },
            } });
          } else {
            items.push(...terminalSuggestionItems(learning, scope, { id, expectedRevision: revision, status: "withdrawn" }));
          }
        }
      }
    }
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionCanceledException") continue;
      throw error;
    }
    // The counter is a best-effort second write: if it is missed, the count runs high, which is the safe side (capture recounts at the cap).
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: projectLearningKey(scope.orgId, scope.project, "STATE"), UpdateExpression: "ADD liveCorrections :minus",
        ConditionExpression: "projectCreatedAt = :pc AND liveCorrections > :zero", ExpressionAttributeValues: { ":minus": -1, ":pc": scope.projectCreatedAt, ":zero": 0 },
      }));
    } catch (error) {
      if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
    }
    return { forgotten: true };
  }
  throw refusal("IDEMPOTENCY_CONFLICT", "changed", "This changed while you were forgetting it. Try again.");
}
