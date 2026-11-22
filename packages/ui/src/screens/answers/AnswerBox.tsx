import { sessionWriteHost } from "../../api/session-safety.js";
import { createApiClient } from "../../api/client.js";
import { useTaskAction } from "../../api/task-action.js";
import { TaskActionNotice } from "../session/TaskActionNotice.js";
import { csrfFailure } from "../session/talk-lifecycle.js";
import { TalkQuestionRecoveryView } from "../session/TalkQuestionRecoveryView.js";
import { useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { SessionIdSchema } from "@agentx/contracts/web";
import { ANSWER_QUESTION_MAX } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createAnswersApi, fixedAnswerWords, type AnswerResponse, type AnswerAskBody } from "../../api/answers.js";
import { createCodeApi } from "../../api/code.js";
import { ApiError } from "../../api/errors.js";
import type { SendResult } from "../../api/client.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";
import { AnswerView } from "./AnswerView.js";
import { A, taskTextFromAnswer } from "./answer-text.js";

/**
 * Starts a Quick task from an answer (the person's own press of the one fixed button): the question and the answer, framed as untrusted, are the task's instructions, through the same route and checks as the
 * start box. A retried press of the same answer reuses its request id, so a lost reply never starts the work twice. Returns what to draw.
 */
export function useStartFromAnswer(project: string) {
  const host = useAppHost(), code = useMemo(() => createCodeApi(host), [host]);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [accepted, setAccepted] = useState(false), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>();
  const action = useTaskAction(host, "answer-start:" + project);
  const sending = useRef(false), intent = useRef<{ text: string; requestId: string } | undefined>(undefined);
  async function start(text: string) {
    if (action.locked || sending.current || accepted) return;
    sending.current = true;setBusy(true);setError(undefined);
    if (intent.current?.text !== text) intent.current = { text, requestId: crypto.randomUUID() };
    try {
      const result = await action.run("start", { requestId: intent.current.requestId, text }, body => code.startCode(project, String(body["text"]), body.requestId, "quick"));
      if (result.kind !== "done") { setPending(result);return; }
      setAccepted(true);
      const session = SessionIdSchema.safeParse(result.value.sessionId);
      if (session.success) host.navigate("/s/" + session.data);
    } catch (failure) {
      setError(failure instanceof ApiError ? (failure.code === "WORKSPACE_LIMIT" ? "You have too many open tasks to start more work. Close one, then start again." : failure.message) : "Couldn't start this work. Try again.");
    } finally { sending.current = false;setBusy(false); }
  }
  return { start, busy, error, accepted, pending, project, action, check: () => createApiClient(host).get("/v1/app/sessions", { parse: (value: unknown) => value }, undefined, { retry: "never" }) };
}

export function StartedNotes({ started }: { started: ReturnType<typeof useStartFromAnswer> }) {
  const host = useAppHost();
  return <>
    <TaskActionNotice key={started.action.pendingKey} pending={started.action.pending} recovery={started.action.recovery} taskHref={host.currentPath()} check={started.check} />
    {started.error && <p role="alert" data-testid="answer-start-error"><VisibleText text={started.error} /></p>}
    {started.accepted && <p role="status">Work was accepted. <Link to="/app/live">Open Live</Link> to find its session.</p>}
    {started.pending && <ConfirmInBrowser result={started.pending} subjectKey={["project", started.project, "overview"]} isApplied={() => false} />}
  </>;
}

/**
 * The Ask box (wiki tab, project page, and "Ask about this task"): a question, then the answer under it with its sources and at most one fixed button. Mounted only where the deployment offers answers and the
 * person has a role on the project; whatever Code says (no role, no set-up, a limit) is shown in Cloud's fixed words. A follow-up continues the same thread. `canStart`: this person may start work; without it the
 * answer has no button at all. `context`: for "Ask about this task", the task's title (information for the answer, never an instruction).
 */
export function AnswerBox({ project, repositories, canStart, heading, context, presentation, submitQuestion, pending, authorityLost = false }: {
  project: string; repositories: ReadonlyArray<{ name?: string | undefined; fullName: string }>; canStart: boolean; heading?: string; context?: string | undefined; presentation?: "talk"; pending?: boolean | undefined; authorityLost?: boolean | undefined; submitQuestion?: ((body: AnswerAskBody) => Promise<AnswerResponse>) | undefined;
}) {
  const started = useStartFromAnswer(project), host = useAppHost();
  const questionAction = useTaskAction(host, "answer-question:" + project, submitQuestion === undefined);
  const [question, setQuestion] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [recovery, setRecovery] = useState<"unavailable" | "authority-lost">();
  const [shown, setShown] = useState<{ question: string; answer: AnswerResponse }>();
  const sending = useRef(false), request = useRef<{ question: string; requestId: string } | undefined>(undefined), failed = useRef(false);
  const fenced = authorityLost || pending === true || submitQuestion === undefined && questionAction.locked;
  async function ask() {
    const text = question.trim();
    if (text === "" || sending.current || fenced) return;
    sending.current = true;setBusy(true);setError(undefined);
    // The same question again is the same request (it spends nothing twice) unless the last one failed; a new question is a new request.
    if (request.current?.question !== text || failed.current) request.current = { question: text, requestId: crypto.randomUUID() };
    failed.current = false;
    try {
      const body = { requestId: request.current.requestId, question: text, ...(shown === undefined ? {} : { threadId: shown.answer.threadId }), ...(context === undefined ? {} : { context }) };
      const answer = await (submitQuestion === undefined ? questionAction.run("question", body, frozen => createAnswersApi(sessionWriteHost(host)).ask(project, frozen as unknown as AnswerAskBody)) : submitQuestion(body));
      setShown({ question: text, answer });setRecovery(undefined);
    } catch (failure) { failed.current = true;setShown(undefined);setRecovery(csrfFailure(failure) || failure instanceof ApiError && [401, 403].includes(failure.status) ? undefined : "unavailable");setError(csrfFailure(failure) ? "Couldn't change that. Your question is still here." : fixedAnswerWords(failure, A.FAILED)); }
    finally { sending.current = false;setBusy(false); }
  }
  const id = useId();
  return (
    <section className="rv-ask-box" aria-label={heading ?? A.ASK_LABEL} data-testid="ask-box">
      <form onSubmit={(event) => { event.preventDefault();void ask(); }}>
        <TextArea id={id} label={heading ?? A.ASK_LABEL} hint={A.ASK_HINT} maxLength={ANSWER_QUESTION_MAX} value={question} disabled={fenced} data-testid="ask-box-text" onChange={(event) => { setQuestion(event.target.value); }}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault();void ask(); } }} />
        <div className="rv-ask-box-bar"><Button type="submit" variant="primary" busy={busy} disabled={question.trim() === "" || fenced} data-testid="ask-box-submit">{A.ASK_BUTTON}</Button>{busy && <span className="rv-muted" role="status">{A.WORKING}</span>}</div>
      </form>
      {presentation === "talk" && !pending && (authorityLost || recovery !== undefined) && <TalkQuestionRecoveryView read={authorityLost ? "authority-lost" : recovery!} />}
      <TaskActionNotice key={questionAction.pendingKey} pending={submitQuestion === undefined && questionAction.pending} recovery={questionAction.recovery} taskHref={host.currentPath()} check={() => createApiClient(host).get("/v1/app/projects/" + encodeURIComponent(project) + "/overview", { parse: (value: unknown) => value }, undefined, { retry: "never" })} />
      {error && (presentation !== "talk" || recovery === undefined) && <p role="alert" data-testid="ask-box-error"><VisibleText text={error} /></p>}
      {shown !== undefined && <AnswerView project={project} answer={shown.answer} repositories={repositories}
        {...(canStart && shown.answer.action !== undefined ? { onStart: () => { void started.start(taskTextFromAnswer(shown.question, shown.answer)); }, starting: started.busy || started.action.locked } : {})} />}
      <StartedNotes started={started} />
    </section>
  );
}
