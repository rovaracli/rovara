import { useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { asksOnItsPage, openRoundOf, useWorkApi, type ReadTask } from "../../api/work.js";
import { paths } from "../../paths.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useAnnounce } from "../../design/Announcer.js";
import { AnswerForm, SENT_WORDS, STALE_WORDS } from "../session/UnderstandQuestions.js";

const countWords = (count: number): string => count === 1 ? "1 question" : String(count) + " questions";
/** The task's own page: its Cloud session's address when it has one, else its task id (the Work page's "Open the full page"). */
export const taskPage = (task: Pick<ReadTask, "sessionId" | "taskId">): string => paths.session(task.sessionId ?? task.taskId);

/**
 * Understand's questions answered where the task is listed (the Work list and Home), from the round Code #1057 puts on the list row: the questions this round's answers do not cover yet, an
 * option button for each choice (the recommended one marked) and the person's own words. The answers go to `POST /v1/app/tasks/{taskId}/answers` with the round and the workflow revision the
 * row read (the session page's form and body); after Code takes them the list (and Home) is read again, so the row moves on, and the page announces it (the row's own note goes with the row). Code decides who may answer; its refusal is shown as Code worded
 * it, and "the questions moved on" says they were already answered. A row with no round while Understand waits (an older Code) sends the person to the task's page instead.
 */
export function InlineQuestions({ task }: { task: ReadTask }) {
 const api = useWorkApi(), query = useQueryClient(), announce = useAnnounce(), [notice, setNotice] = useState<{ round: number; text: string }>();
 const open = openRoundOf(task);
 const refresh = async () => { await Promise.all([query.invalidateQueries({ queryKey: ["work"] }), query.invalidateQueries({ queryKey: ["home"] })]); };
 const shown = notice !== undefined && (open === undefined || notice.round === open.round) ? notice : undefined;
 const note = shown && <p role="status" className="rv-answer-note"><VisibleText text={shown.text} /></p>;
 if (open === undefined) {
  if (note) return <div className="rv-inline-questions" data-testid="inline-questions">{note}</div>;
  if (!asksOnItsPage(task)) return null;
  return <p className="rv-inline-questions rv-muted" data-testid="questions-on-page">Rovara has questions about this task. <Link to={taskPage(task)}>Answer them on the task's page</Link></p>;
 }
 const waiting = open.questions.filter(question => !question.answered);
 return <section aria-label={"Questions from Rovara: " + task.title} className="rv-questions rv-inline-questions" data-testid="inline-questions">
  <h3>Rovara has {countWords(waiting.length)} before it plans this</h3>
  {note}
  <AnswerForm key={String(open.round) + ":" + String(open.revision)} idPrefix={"t-" + task.taskId + "-"} open={{ round: open.round, revision: open.revision, questions: waiting }}
   send={async body => { const result = await api.answerRound(task.taskId, body);if (result.kind !== "done") throw new ApiError(409, "PENDING", "Your answers are waiting for confirmation. Refresh to check their status."); }}
   onSent={async () => { setNotice({ round: open.round, text: SENT_WORDS });announce(task.title + ": " + SENT_WORDS);await refresh(); }}
   onStale={async () => { setNotice({ round: open.round, text: STALE_WORDS });announce(task.title + ": " + STALE_WORDS);await refresh().catch(() => undefined); }} />
 </section>;
}
