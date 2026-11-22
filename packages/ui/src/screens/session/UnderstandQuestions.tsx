import { runTaskAction } from "../../api/task-action.js";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ANSWER_EVERY_QUESTION_MESSAGE, INTENT_ANSWER_MAX_CHARS } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createSessionActions } from "../../api/session-actions.js";
import { acceptSessionRead, createTaskSessionApi } from "../../api/sessions.js";
import { useSessionIdentity, useSessionRequest, sessionScope, readSessionIdentity, assertSessionIdentity, isSessionCsrf } from "../../api/session-safety.js";
import { ClarificationResponseStatusView } from "./ClarificationResponseStatusView.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";
import type { ReadTask } from "./workspace-types.js";
import "./answer-form.css";

/** A question as the view carries it (a model's words: bounded and cleaned by the server, shown here only through the safe text component). */
interface Question { id: string; text: string; options?: ReadonlyArray<{ id: string; label: string }> | undefined; recommended?: string | undefined }
export interface Open { round: number; revision: number; questions: readonly Question[] }
type Notice = { round: number; text: string };
export const STALE_WORDS = "These questions were already answered.", SENT_WORDS = "Answers sent. Rovara is working on your request.";

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

/** What an answer form sends: the session page's body, the same on the Work list and Home (`POST …/answers`). */
export interface AnswersSendBody { requestId: string; round: number; revision: number; answers: Array<{ questionId: string; optionId?: string; text?: string }> }

function QuestionForm({ session, open, onNotice }: { session: ReadSession; open: Open; onNotice: (text: string) => void }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]);
 const key = ["session", session.sessionId], identity = useSessionIdentity(host), saved = useSessionRequest(host, identity.data, session.sessionId + ":answers:" + open.round);
 const [failed, setFailed] = useState(false);
 async function check() {
  try { const current = await createTaskSessionApi(host).read(session.sessionId);query.setQueryData(key, current);setFailed(false); }
  catch { setFailed(true); }
 }
 return <>
 {saved.request !== undefined && identity.data !== undefined && <ClarificationResponseStatusView status={failed ? "failed" : "pending"} round={open.round} identity={identity.data} retained={{ ...identity.data, round: open.round, answers: (saved.request.body.answers as AnswersSendBody["answers"]).map(answer => answer.text ?? answer.optionId ?? "") }} onCheck={() => { void check(); }} />}
 <AnswerForm open={open} locked={identity.data === undefined || saved.request !== undefined || saved.storageError !== undefined}
  send={async body => {
   if (identity.data === undefined || saved.scope === undefined || saved.request !== undefined) throw new ApiError(409, "PENDING", "Check this question round before submitting again.");
   await readSessionIdentity(host);assertSessionIdentity(host, identity.data);
   const latest = await createTaskSessionApi(host).read(session.sessionId), current = latest.body.kind === "task" ? openQuestionsOf(latest.body.task) : undefined;
   if (!["use", "edit"].includes(latest.you.level) || current?.round !== body.round || current.revision !== body.revision) throw new ApiError(409, "INTENT_NOT_WAITING", "These questions were already answered.");
   try {
    const result = await runTaskAction(host, saved.scope, "answers", { ...body }, async request => {
     assertSessionIdentity(host, identity.data!);const answer = await api.answer(session.sessionId, request.body as unknown as AnswersSendBody);
     if (answer.kind !== "done") throw new ApiError(202, "PENDING", "Your answers are waiting for confirmation.");
     assertSessionIdentity(host, identity.data!);return answer;
    }, sessionScope(identity.data, session.sessionId));
    if (result.kind !== "done") throw new ApiError(0, "PENDING", "Your answers are waiting for confirmation.");
    assertSessionIdentity(host, identity.data);
    query.setQueryData<ReadSession>(key, old => acceptSessionRead(old, result.value.session));
   } catch (failure) {
    setFailed(!(failure instanceof ApiError && failure.status === 202));
    if (isSessionCsrf(failure)) { await readSessionIdentity(host).catch(() => undefined);throw new ApiError(403, "CSRF_INVALID", "Couldn't change that. Nothing was sent. Your answers are kept."); }
    throw failure;
   }
  }}
  onSent={async () => { onNotice(SENT_WORDS);await query.invalidateQueries({ queryKey: key }); }}
  onStale={async () => { onNotice(STALE_WORDS);await query.invalidateQueries({ queryKey: key }).catch(() => undefined); }} />
 </>;
}

/**
 * The answer form for one round of Understand's questions: an option (the recommended one marked) or the person's own words for each, sent in one go with the round and the revision
 * the page read. The session page, the Work list and Home all use it; each says where it sends (`send`) and what it reads again after. The same answers sent again keep their request id.
 * Code's "the questions moved on" (INTENT_NOT_WAITING) is `onStale`; any other refusal is shown as Code worded it. `idPrefix` keeps the field ids apart where several forms share a page.
 */
export function AnswerForm({ open, send, onSent, onStale, idPrefix = "", locked = false }: { locked?: boolean; open: Open; send: (body: AnswersSendBody) => Promise<void>; onSent: () => Promise<void>; onStale: () => Promise<void>; idPrefix?: string }) {
 const [picks, setPicks] = useState<Record<string, string>>({}), [texts, setTexts] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 const sending = useRef(false), request = useRef<{ key: string; id: string }>(undefined), formRef = useRef<HTMLFormElement>(null);
 const answerOf = (question: Question) => { const optionId = picks[question.id], text = (texts[question.id] ?? "").trim(); return optionId === undefined && text === "" ? undefined : { questionId: question.id, ...(optionId === undefined ? {} : { optionId }), ...(text === "" ? {} : { text }) }; };
 async function submit(event: FormEvent) {
  event.preventDefault();
  if (sending.current || locked) return;
  const missing = open.questions.find(question => answerOf(question) === undefined);
  if (missing) { setError(ANSWER_EVERY_QUESTION_MESSAGE);formRef.current?.querySelector<HTMLElement>(`input[name="${idPrefix}question-${missing.id}"], textarea#${idPrefix}answer-${missing.id}`)?.focus();return; }
  const answers = open.questions.map(question => answerOf(question)!), body = JSON.stringify([open.round, open.revision, answers]);
  // The same answers sent again (after a dropped connection) keep their request id, so the server counts them once; other answers get a new one.
  if (request.current?.key !== body) request.current = { key: body, id: crypto.randomUUID() };
  sending.current = true;setBusy(true);setError(undefined);
  try {
   await send({ requestId: request.current.id, round: open.round, revision: open.revision, answers });
   await onSent();
  } catch (failure) {
   if (failure instanceof ApiError && failure.code === "INTENT_NOT_WAITING") await onStale();
   else setError(failure instanceof ApiError ? failure.message : "Couldn't send your answers. Try again.");
  } finally { sending.current = false;setBusy(false); }
 }
 return <form ref={formRef} onSubmit={event => { void submit(event); }} noValidate>
  <p className="rv-muted">Answer each one, or say "your call" for the ones you don't mind.</p>
  {open.questions.map((question, index) => question.options === undefined
   ? <TextArea key={question.id} id={idPrefix + "answer-" + question.id} label={visibleText(question.text)} className="rv-answer-text" rows={2} maxLength={INTENT_ANSWER_MAX_CHARS} value={texts[question.id] ?? ""} onChange={event => setTexts(old => ({ ...old, [question.id]: event.target.value }))} />
   : <fieldset key={question.id} className="rv-question"><legend>{visibleText(question.text)}</legend>
    {question.options.map(option => <label key={option.id} className="rv-option"><input type="radio" name={idPrefix + "question-" + question.id} value={option.id} checked={picks[question.id] === option.id} onChange={() => setPicks(old => ({ ...old, [question.id]: option.id }))} /><span><VisibleText text={option.label} />{question.recommended === option.id && <span className="rv-muted"> Recommended</span>}</span></label>)}
    <TextArea id={idPrefix + "answer-" + question.id} label={"Or answer question " + String(index + 1) + " in your own words"} className="rv-answer-text" rows={2} maxLength={INTENT_ANSWER_MAX_CHARS} value={texts[question.id] ?? ""} onChange={event => setTexts(old => ({ ...old, [question.id]: event.target.value }))} />
   </fieldset>)}
  {error && <p role="alert"><VisibleText text={error} /></p>}
  <div className="rv-actions"><Button type="submit" variant="primary" busy={busy} disabled={locked}>Send answers</Button></div>
 </form>;
}
