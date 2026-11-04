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
 // Polls only while the server says the Ask is queued. Any error (a 404, a steady 5xx) or a state this page does not know stops it; "Try again" reads once more.
 const status = useQuery({
  queryKey: ["session", id, "ask", askId], enabled: askId !== undefined, retry: false, refetchOnWindowFocus: false,
  queryFn: () => api.status(id, askId!), refetchInterval: current => (current.state.status !== "error" && current.state.data?.state === "queued" ? 2000 : false),
 });
 async function submit() {
  const text = question.trim();
  if (text === "" || sending) return;
  // The same question again is the same Ask (same request id) unless the last one failed: a failed Ask is replayed by the server, so a retry needs a new id. A new question is a new Ask.
  if (request.current?.question !== text || status.data?.state === "failed") request.current = { question: text, requestId: crypto.randomUUID() };
  setSending(true);setError(undefined);setAskId(undefined);
  try { setAskId((await api.ask(id, { requestId: request.current.requestId, question: text })).askId); }
  catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't ask that just now. Try again."); }
  finally { setSending(false); }
 }
 const state = askId === undefined || status.isError ? undefined : status.data?.state, waiting = askId !== undefined && !status.isError && (status.data === undefined || state === "queued");
 const unreadable = askId !== undefined && !status.isError && status.data !== undefined && state !== "queued" && state !== "answered" && state !== "failed";
 return <details className="rv-ask"><summary>Ask about this task</summary>
  <form onSubmit={event => { event.preventDefault();void submit(); }}>
   <TextArea label="Your question" maxLength={ASK_QUESTION_MAX_CHARS} value={question} onChange={event => { setQuestion(event.target.value); }} />
   <Button type="submit" variant="primary" busy={sending || waiting} disabled={question.trim() === ""}>Ask</Button>
  </form>
  {error && <p role="alert"><VisibleText text={error} /></p>}
  {waiting && <p className="rv-muted" role="status">Working on an answer</p>}
  {askId !== undefined && (status.isError || unreadable) && <p role="alert">{status.error instanceof ApiError ? <VisibleText text={status.error.message} /> : "Couldn't read the answer."} <Button variant="quiet" onClick={() => { void status.refetch(); }}>Try again</Button></p>}
  {state === "failed" && <p role="alert">Couldn't answer that just now.</p>}
  {state === "answered" && <div role="status">{status.data?.answer !== undefined && <p className="rv-ask-answer" style={{ whiteSpace: "pre-wrap" }}><VisibleText text={status.data.answer} /></p>}<p className="rv-muted"><VisibleText text={ASK_ANSWER_LABEL} /></p></div>}
 </details>;
}
