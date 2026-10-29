import { useMemo, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ANSWER_EVERY_QUESTION_MESSAGE, INTENT_ANSWER_MAX_CHARS } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createSessionActions } from "../../api/session-actions.js";
import { acceptSessionRead } from "../../api/sessions.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";
import type { ReadTask } from "./workspace-types.js";

/** A question as the view carries it (a model's words: bounded and cleaned by the server, shown here only through the safe text component). */
interface Question { id: string; text: string; options?: ReadonlyArray<{ id: string; label: string }> | undefined; recommended?: string | undefined }
interface Open { round: number; revision: number; questions: readonly Question[] }
type Notice = { round: number; text: string };
const STALE_WORDS = "These questions were already answered.", SENT_WORDS = "Answers sent. Rovara is working on your request.";

/** The round of questions the workflow now waits on, with the revision this page read; undefined when it waits on none. */
export function openQuestionsOf(task: ReadTask | undefined): Open | undefined {
 const workflow = task?.workflow, asked = workflow?.intent?.assessment;
 if (workflow === undefined || workflow.definitionVersion !== "1.1.0" || workflow.stage !== "UNDERSTAND" || workflow.state !== "WAITING" || asked?.kind !== "questions" || workflow.intent === undefined) return undefined;
 return { round: workflow.intent.rounds, revision: workflow.revision, questions: asked.questions };
}
const countWords = (count: number): string => count === 1 ? "1 question" : String(count) + " questions";

/**
 * Understand's questions on the session page (playbook S3). A person who may use the session answers here, in one go; everyone else reads the questions and who they wait for. The questions are
 * a model's words and are shown only through the safe text component. Sending posts once with the round and the workflow revision this page read; a server that says the questions moved on
 * is shown as "already answered" and the session is read again. The component stays mounted when the questions go, so that sentence (or "Answers sent") is still there to read.
 */
export function UnderstandQuestions({ session, task }: { session: ReadSession; task: ReadTask | undefined }) {
 const [notice, setNotice] = useState<Notice>(), open = openQuestionsOf(task);
 const shown = notice !== undefined && (open === undefined || notice.round === open.round) ? notice : undefined;
 const note = shown && <p role="status" className="rv-answer-note"><VisibleText text={shown.text} /></p>;
 if (open === undefined) return note ?? null;
 const onMac = session.where.kind !== "cloud", mayAnswer = (session.you.level === "use" || session.you.level === "edit") && !onMac;
 return <section aria-label="Questions from Rovara" className="rv-questions">
  <h3>Rovara has {countWords(open.questions.length)} before it plans this</h3>
  {note}
  {mayAnswer ? <QuestionForm key={open.round + ":" + open.revision} session={session} open={open} onNotice={text => setNotice({ round: open.round, text })} /> : <>
   <ol className="rv-question-list">{open.questions.map(question => <li key={question.id}><span><VisibleText text={question.text} /></span>{question.options && <ul>{question.options.map(option => <li key={option.id}><VisibleText text={option.label} />{question.recommended === option.id && <span className="rv-muted"> Recommended</span>}</li>)}</ul>}</li>)}</ol>
   <p className="rv-muted">{onMac ? "This session runs on a Mac now, so its questions can't be answered from here." : <>Waiting for <VisibleText text={session.owner.name} /> to answer</>}</p>
  </>}
 </section>;
}

function QuestionForm({ session, open, onNotice }: { session: ReadSession; open: Open; onNotice: (text: string) => void }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]);
 const [picks, setPicks] = useState<Record<string, string>>({}), [texts, setTexts] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 const sending = useRef(false), request = useRef<{ key: string; id: string }>(undefined), formRef = useRef<HTMLFormElement>(null);
 const key = ["session", session.sessionId];
 const answerOf = (question: Question) => { const optionId = picks[question.id], text = (texts[question.id] ?? "").trim(); return optionId === undefined && text === "" ? undefined : { questionId: question.id, ...(optionId === undefined ? {} : { optionId }), ...(text === "" ? {} : { text }) }; };
 async function submit(event: FormEvent) {
  event.preventDefault();
  if (sending.current) return;
  const missing = open.questions.find(question => answerOf(question) === undefined);
  if (missing) { setError(ANSWER_EVERY_QUESTION_MESSAGE);formRef.current?.querySelector<HTMLElement>(`input[name="question-${missing.id}"], textarea#answer-${missing.id}`)?.focus();return; }
  const answers = open.questions.map(question => answerOf(question)!), body = JSON.stringify([open.round, open.revision, answers]);
  // The same answers sent again (after a dropped connection) keep their request id, so the server counts them once; other answers get a new one.
  if (request.current?.key !== body) request.current = { key: body, id: crypto.randomUUID() };
  sending.current = true;setBusy(true);setError(undefined);
  try {
   const result = await api.answer(session.sessionId, { requestId: request.current.id, round: open.round, revision: open.revision, answers });
   if (result.kind !== "done") throw new ApiError(409, "PENDING", "Your answers are waiting for confirmation. Refresh to check their status.");
   query.setQueryData<ReadSession>(key, old => acceptSessionRead(old, result.value.session));
   onNotice(SENT_WORDS);
   await query.invalidateQueries({ queryKey: key });
  } catch (failure) {
   if (failure instanceof ApiError && failure.code === "INTENT_NOT_WAITING") { onNotice(STALE_WORDS);await query.invalidateQueries({ queryKey: key }).catch(() => undefined); }
   else setError(failure instanceof ApiError ? failure.message : "Couldn't send your answers. Try again.");
  } finally { sending.current = false;setBusy(false); }
 }
 return <form ref={formRef} onSubmit={event => { void submit(event); }} noValidate>
  <p className="rv-muted">Answer each one, or say "your call" for the ones you don't mind.</p>
  {open.questions.map((question, index) => question.options === undefined
   ? <TextArea key={question.id} id={"answer-" + question.id} label={visibleText(question.text)} className="rv-answer-text" rows={2} maxLength={INTENT_ANSWER_MAX_CHARS} value={texts[question.id] ?? ""} onChange={event => setTexts(old => ({ ...old, [question.id]: event.target.value }))} />
   : <fieldset key={question.id} className="rv-question"><legend>{visibleText(question.text)}</legend>
    {question.options.map(option => <label key={option.id} className="rv-option"><input type="radio" name={"question-" + question.id} value={option.id} checked={picks[question.id] === option.id} onChange={() => setPicks(old => ({ ...old, [question.id]: option.id }))} /><span><VisibleText text={option.label} />{question.recommended === option.id && <span className="rv-muted"> Recommended</span>}</span></label>)}
    <TextArea id={"answer-" + question.id} label={"Or answer question " + String(index + 1) + " in your own words"} className="rv-answer-text" rows={2} maxLength={INTENT_ANSWER_MAX_CHARS} value={texts[question.id] ?? ""} onChange={event => setTexts(old => ({ ...old, [question.id]: event.target.value }))} />
   </fieldset>)}
  {error && <p role="alert"><VisibleText text={error} /></p>}
  <div className="rv-actions"><Button type="submit" variant="primary" busy={busy}>Send answers</Button></div>
 </form>;
}
