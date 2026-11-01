// v1.2 learning loop: what the task page needs to show "Remember this" or "Remembered" on a comment. Both answers are for a person with standing in the project only, so nothing about what
// the project remembers reaches a viewer, a commenter, a channel-only person or an outsider.
//
// `canRemember` is true when Remember would not refuse the caller for who they are: the SAME standing the Remember route reads (`readStanding`, live), an active project (`learningScopeChecked`),
// and a task role that may comment (not a session level). `learning` per comment comes from one BatchGet of the comments' SOURCE items (at most 100 keys a call), under a time limit. A read
// that fails, times out, or leaves keys unprocessed leaves `learning` absent: the page is served, and an unknown answer is never shown as "not remembered".
import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { projectLearningKey, type TaskCommentLearning } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { can, type TaskAccess } from "../developer/task-access.js";
import { commentSourceKey } from "./capture-comment.js";
import { visibility } from "./retention.js";
import { learningScopeChecked, readStanding, type StandingDeps } from "./standing.js";
import { sourceSk, type LearningScope } from "./store.js";

/** The whole job (standing, project and the BatchGets) must finish in this long, or the page goes without the flags it has not got yet. */
export const COMMENT_FLAGS_TIMEOUT_MS = 1_500;
/** BatchGetItem takes 100 keys at most. */
export const COMMENT_FLAGS_BATCH_KEYS = 100;
const UNPROCESSED_RETRIES = 3;

type Row = Record<string, unknown>;
export interface CommentFlagsDeps extends StandingDeps { now: () => number }
export interface CommentFlagsReader { caller: DeveloperCaller; access: Pick<TaskAccess, "task" | "role" | "source"> }
export interface CommentFlags {
  /** Always true when there are flags at all: absent means no standing, or nothing could be worked out. */
  canRemember: true;
  /** By comment ID. Absent when the read failed or ran out of time. */
  learning?: ReadonlyMap<string, TaskCommentLearning>;
}

const TIMED_OUT = Symbol("timed out");

/** The promise's value, TIMED_OUT when it takes longer than `ms`. A rejection is the caller's to catch; the timer never outlives the call. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms)); });
  work.catch(() => undefined); // a read that fails after the limit is not an unhandled rejection
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The SOURCE items of the keys, by sort key; undefined when any could not be read (an error, or keys still unprocessed after a few tries). */
async function readSources(deps: CommentFlagsDeps, scope: LearningScope, sks: readonly string[]): Promise<Map<string, Row> | undefined> {
  const found = new Map<string, Row>();
  const pages: string[][] = [];
  for (let start = 0; start < sks.length; start += COMMENT_FLAGS_BATCH_KEYS) pages.push(sks.slice(start, start + COMMENT_FLAGS_BATCH_KEYS));
  const results = await Promise.all(pages.map(async (page) => {
    let keys: Array<{ pk: string; sk: string }> | undefined = page.map((sk) => projectLearningKey(scope.orgId, scope.project, sk));
    for (let attempt = 0; keys !== undefined && keys.length > 0; attempt += 1) {
      if (attempt > UNPROCESSED_RETRIES) return false;
      const response = await deps.documentClient.send(new BatchGetCommand({ RequestItems: { [deps.tableName]: { Keys: keys, ConsistentRead: true } } })) as {
        Responses?: Record<string, Row[] | undefined>; UnprocessedKeys?: Record<string, { Keys?: Array<{ pk: string; sk: string }> } | undefined>;
      };
      for (const item of response.Responses?.[deps.tableName] ?? []) if (typeof item["sk"] === "string") found.set(item["sk"], item);
      keys = response.UnprocessedKeys?.[deps.tableName]?.Keys;
    }
    return true;
  }));
  return results.every(Boolean) ? found : undefined;
}

/**
 * The flags for the task page's comments, or undefined when the reader has no standing (or the project is not learning, or standing could not be read in time). `commentIds` are the comments
 * to look up (the page passes people's comments; an empty list reads nothing and answers `canRemember` alone).
 */
export async function commentLearningFlags(deps: CommentFlagsDeps, reader: CommentFlagsReader, taskId: string, commentIds: readonly string[], options: { timeoutMs?: number } = {}): Promise<CommentFlags | undefined> {
  const { caller, access } = reader;
  // Remember's own first check: a reader who may not comment, or holds the task only through a session level, would be refused.
  if (access.source === "session" || !can(access.role, "comment")) return undefined;
  const project = access.task.project;
  const limit = options.timeoutMs ?? COMMENT_FLAGS_TIMEOUT_MS;
  const started = Date.now();
  const left = () => limit - (Date.now() - started);

  let scope: LearningScope | undefined;
  try {
    const decided = await within((async () => {
      if (await readStanding(deps, caller.orgId, caller.developerId, project) !== "member") return undefined;
      return (await learningScopeChecked(deps, caller.orgId, project))?.scope;
    })(), left());
    if (decided === TIMED_OUT || decided === undefined) return undefined;
    scope = decided;
  } catch {
    return undefined;
  }
  if (commentIds.length === 0) return { canRemember: true };

  try {
    const sks = new Map(commentIds.map((id) => [id, sourceSk(scope.projectCreatedAt, commentSourceKey(taskId, id))] as const));
    const sources = await within(readSources(deps, scope, [...sks.values()]), left());
    if (sources === TIMED_OUT || sources === undefined) return { canRemember: true };
    const nowMs = deps.now();
    const learning = new Map<string, TaskCommentLearning>();
    for (const [id, sk] of sks) {
      const item = sources.get(sk);
      // Visible as Forget reads it: not expired, this project instance's, and pointing at a correction.
      const remembered = item !== undefined && visibility(item, { nowMs, projectCreatedAt: scope.projectCreatedAt }) === "visible" && typeof item["correctionSk"] === "string";
      const correctionId = remembered && typeof item["correctionId"] === "string" && item["correctionId"].length > 0 && item["correctionId"].length <= 100 ? item["correctionId"] : undefined;
      learning.set(id, { remembered, ...(correctionId === undefined ? {} : { correctionId }) });
    }
    return { canRemember: true, learning };
  } catch {
    return { canRemember: true };
  }
}
