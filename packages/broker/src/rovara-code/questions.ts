// Rovara Code (Plan 6 Task 5): people answer Understand's questions. `POST /v1/app/sessions/{id}/answers` is the one app route: it needs "can use" on the session (read live, in the
// session's own org, by the session code: a viewer, a project viewer and a stranger cannot answer, and another org's session is not found), it takes the person from their sign-in and never
// from the body, and it writes the answers, the next Understand dispatch row, the request item and the timeline line in ONE transaction, conditional on the workflow still waiting at
// that revision. The answers are cleaned and bounded by the workflow's own move (`answerIntentQuestions`) and reach a prompt only inside the labelled answers block.
//
// The question card on Home is the other half: it is shown to the session's owner and to each person who can use it, from what is read now, and goes when the questions are answered.
import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  INTENT_NOT_WAITING_MESSAGE, INTENT_QUESTIONS_MAX, IntentAnswerRefusal, IntentAnswerSchema, UNDERSTAND_ROUNDS_MAX, agentXError, answerIntentQuestions, atLeast,
  memberGrantsPk, MEMBER_GRANT_SK_PREFIX, sharedSessionsKey, SessionIdSchema, SessionLevelSchema,
  type AgentPrincipal, type AgentSessionRecord, type SessionView, type WorkflowSnapshot,
} from "@agentx/contracts";
import { failedIndexes, type TransactItem } from "../agents/table-writes.js";
import { requireSessionLevel, type SessionAccess } from "../agent-sessions/access.js";
import { onlyTheEventCancelled } from "../agent-sessions/events.js";
import { fit, openSession, quoted, registerHomeCardSource, type HomeCardSource, type HomeSourceCard } from "../agent-sessions/home.js";
import { queryPartition } from "../agent-sessions/live.js";
import type { SessionReadCaller, SessionReadDependencies } from "../agent-sessions/read.js";
import {
  afterControl, answerOf, controlRequestItem, getItem, isEnded, isoOf, nameOrSomeone, readControlRequest, repeatOf, taskOfSession, type ControlCaller,
} from "../agent-sessions/stop.js";
import { taskOwnerKey } from "../developer/task-records.js";
import { taskAccessFence } from "../developer/task-people.js";
import { answeredEventItem, intentAnswerItems, openQuestions } from "./question-answers.js";

/** How long a request's record is kept: as long as the other session controls keep theirs. */
const KEEP_SECONDS = 30 * 86_400;

const AnswersBodySchema = z
  .object({
    requestId: z.string().uuid(),
    round: z.number().int().min(1).max(UNDERSTAND_ROUNDS_MAX),
    /** The workflow revision the person's page read (the web form sends it): answers to a workflow that has moved on since are `INTENT_NOT_WAITING`. Optional for the clients that name only the round. */
    revision: z.number().int().min(0).optional(),
    answers: z.array(IntentAnswerSchema).min(1).max(INTENT_QUESTIONS_MAX),
  })
  .strict();

function parseAnswersBody(body: unknown): z.infer<typeof AnswersBodySchema> {
  const parsed = AnswersBodySchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  // Field names only: the values are a person's words.
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

const notWaiting = () => agentXError("INTENT_NOT_WAITING", INTENT_NOT_WAITING_MESSAGE);
/** What an answer says, in a fixed order, for telling a repeat of a request from the same id with other answers. */
const digestOf = (body: z.infer<typeof AnswersBodySchema>): string =>
  createHash("sha256").update(JSON.stringify([body.round, body.answers.map((answer) => [answer.questionId, answer.optionId ?? null, answer.text ?? null])]), "utf8").digest("hex");

/** The task's People revision, for the fence every write of an action on the task keeps (a change of the task's people in between refuses the write). */
async function peopleRevisionOf(deps: SessionReadDependencies, taskId: string): Promise<number | undefined> {
  const item = await getItem(deps, { pk: `DEVTASK#${taskId}`, sk: "PEOPLE" });
  return typeof item?.["revision"] === "number" ? item["revision"] : undefined;
}

/** What an answer hears when the session runs on a Mac now. */
export const SESSION_ON_MAC_ANSWER_MESSAGE = "This session runs on a Mac now, so its questions can't be answered from here.";

/**
 * `POST /v1/app/sessions/{id}/answers` `{ requestId, round, answers }`. Answers the session as `GET` shows it. A repeat of the request writes nothing and answers the same; the same
 * id with other answers, or from another person, is `IDEMPOTENCY_CONFLICT`. A task that is not waiting for these answers (not waiting, already answered, another round) is
 * `INTENT_NOT_WAITING`.
 */
export async function answerIntentOnSession(deps: SessionReadDependencies, caller: ControlCaller, sessionId: string, body: unknown): Promise<{ session: SessionView }> {
  const input = parseAnswersBody(body);
  const access: SessionAccess = await requireSessionLevel(deps, caller, sessionId, "use", "answer its questions");
  const { session } = access;
  const bodyHash = digestOf(input);
  const replay = async (): Promise<{ session: SessionView } | undefined> => {
    const prior = await readControlRequest(deps, session, input.requestId);
    if (prior === undefined) return undefined;
    repeatOf(prior, "answer", caller.developerId);
    if (prior.bodyHash !== bodyHash) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for other answers on this session; use a new request_id");
    return answerOf(deps, caller, session.sessionId);
  };
  const repeated = await replay();
  if (repeated !== undefined) return repeated;
  // A session that now runs on a Mac is answered there; the cloud holds no Understand run for it (like stop, retry and take over, which look at where it runs).
  if (session.kind === "local" || session.where.kind !== "cloud") throw agentXError("SESSION_ON_MAC", SESSION_ON_MAC_ANSWER_MESSAGE);
  if (session.subject.kind !== "task" || isEnded(session)) throw notWaiting();
  const task = await taskOfSession(deps, session);
  if (task === undefined || task.closedAt !== undefined || task.workflow === undefined) throw notWaiting();

  const nowMs = deps.now();
  const at = isoOf(nowMs);
  const name = nameOrSomeone(caller.name);
  let next;
  try {
    next = answerIntentQuestions(task.workflow, {
      expectedRevision: input.revision ?? task.workflow.revision, round: input.round, source: "app", answers: input.answers, now: at,
      by: { actorId: taskOwnerKey(caller.developerId, task.taskId), name },
    });
  } catch (error) {
    if (error instanceof IntentAnswerRefusal) throw agentXError(error.code, error.message);
    throw error;
  }
  const people = await peopleRevisionOf(deps, task.taskId);
  const line = answeredEventItem(deps, session, { requestId: input.requestId, at, by: { developerId: caller.developerId, name }, source: "app" });
  const { update, dispatch } = intentAnswerItems(deps, { orgId: session.orgId, taskId: task.taskId, from: task.workflow, to: next, at });
  const items: TransactItem[] = [
    update, dispatch,
    controlRequestItem(deps, session, input.requestId, { action: "answer", by: caller.developerId, at, sessionId: session.sessionId, bodyHash }, Math.floor(nowMs / 1000) + KEEP_SECONDS),
    taskAccessFence(deps.tableName, task.taskId, people),
    // The last position, always: a cancellation there alone means the line is on the timeline already.
    ...(line === undefined ? [] : [line]),
  ];
  try {
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      // Only the timeline line was refused (it is there already): the answer is written without it.
      if (line === undefined || !onlyTheEventCancelled(error, items.length - 1)) throw error;
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items.slice(0, -1) }));
    }
  } catch (error) {
    const failed = failedIndexes(error);
    if (failed === undefined || failed.size === 0) throw error;
    // The same request was recorded by another call at the same moment: its answer is this one's.
    const recorded = await replay();
    if (recorded !== undefined) return recorded;
    // The task's people changed between the level check and the write: nothing is written, and the person tries again (their level is read again).
    if (failed.has(3) && !failed.has(0) && !failed.has(1)) throw agentXError("RUNTIME_UNAVAILABLE", "This task's people changed just now. Try again.");
    // Someone else answered first (or the task moved on): nothing is waiting for these answers any more.
    throw notWaiting();
  }
  await afterControl(deps, session, caller.developerId, access.effectiveOwner.developerId);
  // The answer's dispatch row is the guarantee; this only starts Understand without waiting for the sweep.
  try {
    await deps.control?.startUnderstanding?.(task, next.revision);
  } catch {
    // Left to the sweep.
  }
  return answerOf(deps, caller, session.sessionId);
}

// ---- Home's question card

const QUESTION_SHARES_MAX = 100;

/** The sessions shared with the caller (to them, to the company, to each project they hold a grant on) at "can use" or more: only candidates, judged one by one below. */
async function sharedUseCandidates(deps: SessionReadDependencies, caller: SessionReadCaller): Promise<string[]> {
  const grants = await queryPartition(deps, memberGrantsPk(caller.orgId, caller.developerId), { prefix: MEMBER_GRANT_SK_PREFIX, max: QUESTION_SHARES_MAX });
  const projects = grants.items.flatMap((item) => (typeof item["sk"] === "string" ? [item["sk"].slice(MEMBER_GRANT_SK_PREFIX.length)] : []));
  const principals: AgentPrincipal[] = [{ kind: "member", developerId: caller.developerId }, { kind: "org" }, ...projects.map((project) => ({ kind: "project" as const, project }))];
  const ids = new Set<string>();
  for (const principal of principals) {
    const { items } = await queryPartition(deps, sharedSessionsKey(caller.orgId, principal, "ses_00000000000000000000").pk, { max: QUESTION_SHARES_MAX });
    for (const item of items) {
      const id = SessionIdSchema.safeParse(item["sessionId"]);
      const level = SessionLevelSchema.safeParse(item["level"]);
      if (id.success && level.success && item["orgId"] === caller.orgId && atLeast(level.data, "use")) ids.add(id.data);
    }
  }
  return [...ids];
}

/** Whether the session is open, a task's, and says it needs a person (the only sessions that can be waiting for answers). */
const mayBeAsking = (session: AgentSessionRecord): boolean => session.kind === "task" && session.endedAt === undefined && session.summary.status === "needs_person";

const questionSource: HomeCardSource = {
  kind: "question",
  async list(deps, caller, context) {
    const own = await context.ownSessions();
    const ids = new Set<string>(own.map((entry) => entry.session.sessionId));
    for (const id of await sharedUseCandidates(deps, caller)) ids.add(id);
    const sessions = [...(await context.sessionsById([...ids])).values()].filter(mayBeAsking);
    const tasks = await context.tasksById(sessions.flatMap((session) => (session.subject.kind === "task" ? [session.subject.taskId] : [])));
    const cards: HomeSourceCard[] = [];
    for (const session of sessions) {
      if (session.subject.kind !== "task") continue;
      const workflow = tasks.get(session.subject.taskId)?.["workflow"] as WorkflowSnapshot | undefined;
      const asked = openQuestions(workflow);
      if (asked.length === 0) continue;
      // The same rule as answering: "can use" now. A project viewer who is not the owner is capped at "view" by the access rules themselves, however the session was shared.
      const access = await context.accessOf(session);
      if (access === undefined || !atLeast(access.level, "use")) continue;
      const words = `Rovara has ${asked.length === 1 ? "1 question" : `${String(asked.length)} questions`} about ${quoted(session.title)}`.replace(/[<>]/gu, " ");
      cards.push({
        cardId: `question:${session.sessionId}`, kind: "question", title: session.title, reason: fit(words, ""), sessionId: session.sessionId, at: session.updatedAt,
        buttons: [openSession(deps, session.sessionId, "Answer")],
      });
    }
    return cards;
  },
};

registerHomeCardSource(questionSource);
