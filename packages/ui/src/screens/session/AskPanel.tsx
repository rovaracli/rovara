import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ASK_ANSWER_LABEL, ASK_QUESTION_MAX_CHARS } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createSessionAskApi } from "../../api/session-ask.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";

/**
 * "Ask about this task": a question box and the answer. Mounted only when the session view says Ask is on for this reader (`you.live.ask`). The answer is the model's and is untrusted: it is shown as plain
 * text, never as markup. Every refusal is the server's own sentence.
 */
export function AskPanel({ id }: { id: string }) {
 const host = useAppHost(), api = useMemo(() => createSessionAskApi(host), [host]);
 const [question, setQuestion] = useState(""), [askId, setAskId] = useState<string>(), [sending, setSending] = useState(false), [error, setError] = useState<string>();
 const request = useRef<{ question: string; requestId: string }>(undefined);
 const status = useQuery({
  queryKey: ["session", id, "ask", askId], enabled: askId !== undefined, retry: false, refetchOnWindowFocus: false,
  queryFn: () => api.status(id, askId!), refetchInterval: current => (current.state.data?.state === "queued" || current.state.data === undefined ? 2000 : false),
 });
 async function submit() {
  const text = question.trim();
  if (text === "" || sending) return;
  // The same question again is the same Ask (same request id); a changed question is a new one.
  if (request.current?.question !== text) request.current = { question: text, requestId: crypto.randomUUID() };
  setSending(true);setError(undefined);setAskId(undefined);
  try { setAskId((await api.ask(id, { requestId: request.current.requestId, question: text })).askId); }
  catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't ask that just now. Try again."); }
  finally { setSending(false); }
 }
 const state = askId === undefined ? undefined : status.data?.state, waiting = askId !== undefined && !status.isError && (state === undefined || state === "queued");
 return <details className="rv-ask"><summary>Ask about this task</summary>
  <form onSubmit={event => { event.preventDefault();void submit(); }}>
   <TextArea label="Your question" maxLength={ASK_QUESTION_MAX_CHARS} value={question} onChange={event => { setQuestion(event.target.value); }} />
   <Button type="submit" variant="primary" busy={sending || waiting} disabled={question.trim() === ""}>Ask</Button>
  </form>
  {error && <p role="alert"><VisibleText text={error} /></p>}
  {waiting && <p className="rv-muted" role="status">Working on an answer</p>}
  {askId !== undefined && status.isError && <p role="alert">{status.error instanceof ApiError ? <VisibleText text={status.error.message} /> : "Couldn't read the answer. Try again."}</p>}
  {state === "failed" && <p role="alert">Couldn't answer that just now.</p>}
  {state === "answered" && <div role="status">{status.data?.answer !== undefined && <p className="rv-ask-answer" style={{ whiteSpace: "pre-wrap" }}><VisibleText text={status.data.answer} /></p>}<p className="rv-muted"><VisibleText text={ASK_ANSWER_LABEL} /></p></div>}
 </details>;
}
