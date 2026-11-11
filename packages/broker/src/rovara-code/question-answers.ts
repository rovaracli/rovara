// Rovara Code (Plan 6 Task 5): the writes that put Understand's questions to people and take their answers, kept apart from the routes so the Slack reply path (in the task layer) and the
// session route (in `questions.ts`) build the same items. A leaf module on purpose: it imports no route and no task code, so the task layer can use it without a cycle.
//
// The questions are a model's words (bounded, redacted and made single lines when they were read); the answers are a person's, cleaned again by `answerIntentQuestions`. Neither is
// ever put in a log line, an event or a milestone: the milestone and the timeline say only how many questions, and by whom.
import { INTENT_ANSWER_MAX_CHARS, QUESTIONS_MESSAGE_HEADER, sessionEventId, type CodeMilestone, type IntentAnswer, type IntentQuestion, type OrgId } from "@rovara-code/contracts";
import { type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { type TransactItem } from "../agents/table-writes.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, workflowDispatchItem } from "../aws/broker-shared.js";
import { taskKey } from "../developer/task-records.js";
import { sessionEventItem } from "../agent-sessions/store.js";
import { codeMilestoneItems } from "./milestones.js";

/** What the milestone and the timeline say when Understand asks: how many questions, and nothing the model wrote. */
export const questionsMilestoneText = (count: number): string => `${QUESTIONS_MESSAGE_HEADER} ${count === 1 ? "1 question" : `${String(count)} questions`}.`;

/** The questions a workflow now waits on, or none when it is not at UNDERSTAND/WAITING with a round of them. */
export function openQuestions(workflow: WorkflowSnapshot | undefined): readonly IntentQuestion[] {
  const asked = workflow?.intent?.assessment;
  return workflow?.definitionVersion === "1.1.0" && workflow.stage === "UNDERSTAND" && workflow.state === "WAITING" && asked?.kind === "questions" && Array.isArray(asked.questions) ? asked.questions : [];
}

/**
 * The items that record Understand's questions, for the transaction of the result that asked them: the `questions` milestone (one per round) and its line on the session's
 * timeline. Nothing for a workflow that is not waiting on a round of questions, so a result that asked nothing writes nothing.
 */
export function questionsMilestoneItems(
  table: { tableName: string }, task: { taskId: string; orgId: OrgId; sessionId?: string | undefined }, next: WorkflowSnapshot, at: string,
): TransactItem[] {
  const questions = openQuestions(next);
  if (questions.length === 0 || next.intent === undefined) return [];
  const milestone: CodeMilestone = {
    kind: "questions", orgId: task.orgId, taskId: task.taskId, at, text: questionsMilestoneText(questions.length),
    ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
  };
  return codeMilestoneItems(table, milestone, next.intent.rounds, { definitionVersion: next.definitionVersion });
}

/**
 * The two writes that move a task from waiting for answers to understanding again: the workflow (conditional on the revision, the stage, the state, the task being open and being this
 * org's, so a lost race writes nothing) and the dispatch row for the next Understand run, in the same transaction. `countNote` adds a thread note to the task's count (a Slack reply is
 * saved as a note too, so a repeat of the same Slack message is told apart from a new one).
 */
export function intentAnswerItems(
  table: { tableName: string }, input: { orgId: OrgId; taskId: string; from: WorkflowSnapshot; to: WorkflowSnapshot; at: string; countNote?: boolean },
): { update: TransactItem; dispatch: TransactItem } {
  return {
    update: {
      Update: {
        TableName: table.tableName, Key: taskKey(input.taskId),
        UpdateExpression: `SET workflow = :workflow, updatedAt = :now${input.countNote === true ? " ADD threadNoteCount :one" : ""}`,
        ConditionExpression: "orgId = :org AND workflow.revision = :revision AND workflow.#stage = :understand AND workflow.#state = :waiting AND attribute_not_exists(closedAt)",
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
        ExpressionAttributeValues: {
          ":workflow": input.to, ":now": input.at, ":org": input.orgId, ":revision": input.from.revision, ":understand": "UNDERSTAND", ":waiting": "WAITING",
          ...(input.countNote === true ? { ":one": 1 } : {}),
        },
      },
    },
    dispatch: workflowDispatchItem(table.tableName, input.taskId, input.to.revision, "UNDERSTAND", WORKFLOW_NO_CANDIDATE_DIGEST, input.at),
  };
}

/**
 * The line on the session's timeline for an answer: who, and nothing they wrote. Undefined when no event can be built (a person's id the timeline does not take): an answer is never
 * refused over its line.
 */
export function answeredEventItem(
  table: { tableName: string }, session: { orgId: OrgId; sessionId: string }, input: { requestId: string; at: string; by: { developerId: string; name: string }; source: "app" | "slack" },
): TransactItem | undefined {
  const base = { eventId: sessionEventId("status", `answered\n${input.requestId}`), at: input.at, type: "status" as const, source: input.source, text: `${input.by.name} answered Rovara's questions.` };
  for (const event of [{ ...base, actor: { kind: "member" as const, developerId: input.by.developerId, name: input.by.name } }, base]) {
    try {
      return sessionEventItem(table, { orgId: session.orgId, sessionId: session.sessionId }, event);
    } catch {
      // Not an event this schema takes: try the one without the person.
    }
  }
  return undefined;
}

/**
 * A Slack reply as the answer to every open question: its whole text is each question's answer (the reply says what it says; "your call" is an answer). A reply past the answer limit
 * is not an answer, and is refused whole, never cut.
 */
export function answersFromReply(text: string, questions: readonly IntentQuestion[]): IntentAnswer[] | undefined {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > INTENT_ANSWER_MAX_CHARS) return undefined;
  return questions.map((question) => ({ questionId: question.id, text: trimmed }));
}
