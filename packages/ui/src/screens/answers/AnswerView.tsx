import { sessionWriteHost } from "../../api/session-safety.js";
import { createApiClient } from "../../api/client.js";
import { useAppHost } from "../../host.js";
import { useTaskAction } from "../../api/task-action.js";
import { TaskActionNotice } from "../session/TaskActionNotice.js";
import { Fragment, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ANSWER_WORDS, NOT_RIGHT_WORDS, type AnswerCitation, type AnswerResponse } from "@agentx/contracts/web";
import { createAnswersApi } from "../../api/answers.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { hostLink } from "../project/wiki/wiki-model.js";
import { A, breakAfterSeparators, headline, pieces } from "./answer-text.js";
import "../../design/parts/chips-buttons.css";
import "./answers.css";

/** A source from the task's own recorded state looks different from a line of code (both stay plain text, never a guess). */
/** Where a code source's place may wrap: after a separator only. A task-state quote is plain words and wraps as text. */
function Place({ cite }: { cite: AnswerCitation }) {
  const text = label(cite);
  if ("kind" in cite) return <VisibleText text={text} />;
  return <>{breakAfterSeparators(text).map((part, index) => <Fragment key={index}>{index > 0 && <wbr />}<VisibleText text={part} /></Fragment>)}</>;
}
/** The 4e dashed idle chip (as "Not run") worded for an answer that says it does not know. */
function NoAnswerChip() {
  return <p className="rv-answer-chip-row"><span className="rv-status-chip" role="img" aria-label={A.NO_ANSWER} data-state="not_run" data-hue="idle"><svg className="rv-status-chip-icon" aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 8h6" /></svg>{A.NO_ANSWER}</span></p>;
}
const kindClass = (cite: AnswerCitation): string => "kind" in cite ? "rv-source-task" : "rv-source-code";
const label = (cite: AnswerCitation): string => "kind" in cite ? `Task state: ${cite.quote}` : `${cite.repo}/${cite.path}:${String(cite.line)}${cite.lineEnd === undefined || cite.lineEnd === cite.line ? "" : "-" + String(cite.lineEnd)}`;

/**
 * "Not right" (lead 4 J5): the one small control on an answer. Pressed once per answer (a retry never sends twice); it says only fixed words afterwards. Drawn only for an answer Code recorded (it has an id) and
 * never for "not set up". Code decides that only the asker's press counts; anyone else reads Code's refusal as the failed words.
 */
function NotRight({ project, answerId }: { project: string; answerId: string }) {
  const host = useAppHost(), api = createAnswersApi(sessionWriteHost(host)), action = useTaskAction(host, "answer-feedback:" + project + ":" + answerId);
  const [state, setState] = useState<"idle" | "busy" | "queued" | "noted" | "failed">("idle");
  const sending = useRef(false);
  async function press() {
    if (action.locked || sending.current) return;
    sending.current = true;setState("busy");
    try { const done = await action.run("not-right", { requestId: crypto.randomUUID(), answerId }, () => api.notRight(project, answerId)); setState(done.state === "queued" ? "queued" : "noted"); }
    catch { setState("failed"); }
    finally { sending.current = false; }
  }
  if (state === "queued" || state === "noted") return <p className="rv-muted" role="status" data-testid="not-right-done">{state === "queued" ? NOT_RIGHT_WORDS.queued : NOT_RIGHT_WORDS.noted}</p>;
  return <p className="rv-answer-feedback">
    <Button variant="quiet" busy={state === "busy"} disabled={action.locked} onClick={() => { void press(); }} data-testid="answer-not-right">{NOT_RIGHT_WORDS.button}</Button>
    <TaskActionNotice key={action.pendingKey} pending={action.pending} recovery={action.recovery} taskHref={host.currentPath()} check={() => createApiClient(host).get("/v1/app/projects/" + encodeURIComponent(project) + "/overview", { parse: (value: unknown) => value }, undefined, { retry: "never" })} />
    {state === "failed" && <span role="alert" className="rv-muted" data-testid="not-right-error"> {NOT_RIGHT_WORDS.failed}</span>}
  </p>;
}

/**
 * One answer, the same words as everywhere else (answer first, proof one click away, no machinery): 2 to 5 sentences with small numbered source marks, one honesty line, up to four sources and one wiki page link,
 * a fold with all of them, and at most one fixed button. "Not set up" says so in fixed words and offers nothing to press. No cost, no confidence, no model name. The text is plain text, never markup.
 */
export function AnswerView({ project, answer, repositories, onStart, starting, noAnswerChip = false }: {
  project: string; answer: AnswerResponse; repositories: ReadonlyArray<{ name?: string | undefined; fullName: string }>;
  /** Present only when this person may start work: the one "Start a Quick task" button. Absent: no button at all (never a dead one). */
  onStart?: (() => void) | undefined; starting?: boolean;
  /** A retained answer whose text is the fixed "I don't know": the same chip a fresh not_found answer gets. */
  noAnswerChip?: boolean;
}) {
  const sourcePrefix = useId() + "-answer-source-";
  const said = headline(answer), sources = answer.sources, shown = sources.slice(0, 4), page = answer.wikiPages[0];
  const link = (cite: AnswerCitation) => "kind" in cite ? undefined : hostLink(repositories, { repo: cite.repo, path: cite.path, commit: cite.commit, line: cite.line, ...(cite.lineEnd === undefined ? {} : { lineEnd: cite.lineEnd }) });
  const text = useMemo<ReactNode>(() => pieces(answer.text, sources.length).map((piece, index) => piece.kind === "text"
   ? <VisibleText key={index} text={piece.text} />
   : <sup key={index}><a href={"#" + sourcePrefix + (piece.n <= 4 ? "" : "all-") + String(piece.n)} aria-label={"Source " + String(piece.n)}>[{piece.n}]</a></sup>), [answer.text, sources.length, sourcePrefix]);
  const wikiLink = (id: string, title: string) => <Link to={`/app/projects/${encodeURIComponent(project)}?tab=wiki&page=${encodeURIComponent(id)}`}><VisibleText text={title} /></Link>;
  const source = (cite: AnswerCitation) => { const href = link(cite); return <li key={cite.n} id={sourcePrefix + "all-" + String(cite.n)}>[{cite.n}] {href === undefined ? <code className={kindClass(cite)}><Place cite={cite} /></code> : <a href={href} target="_blank" rel="noopener noreferrer"><code className={kindClass(cite)}><Place cite={cite} /></code></a>}</li>; };
  const hasMore = sources.length > shown.length || answer.wikiPages.length > 1 || answer.unconfirmed.length > 0;
  return (
    <div className="rv-answer" data-testid="answer" data-outcome={answer.outcome} role="status">
      {(answer.outcome === "not_found" || noAnswerChip) && <NoAnswerChip />}
      {said !== undefined ? <p className="rv-answer-text"><VisibleText text={said} /></p> : <p className="rv-answer-text" data-testid="answer-text">{text}</p>}
      {answer.honesty !== undefined && said === undefined && <p className="rv-muted" data-testid="answer-honesty"><VisibleText text={answer.honesty} /></p>}
      {(shown.length > 0 || page !== undefined) && <p className="rv-answer-sources" data-testid="answer-sources"><span className="rv-muted">{A.SOURCES}: </span>
        {shown.map((cite) => <span key={cite.n} id={sourcePrefix + String(cite.n)} className={"rv-source " + kindClass(cite)}>[{cite.n}] {(() => { const href = link(cite); return href === undefined ? <code className={kindClass(cite)}><Place cite={cite} /></code> : <a href={href} target="_blank" rel="noopener noreferrer"><code className={kindClass(cite)}><Place cite={cite} /></code></a>; })()}{" "}</span>)}
        {page !== undefined && <span><span className="rv-muted">{A.WIKI}: </span>{wikiLink(page.pageId, page.title)}</span>}</p>}
      {hasMore && <details className="rv-answer-more"><summary>{A.MORE}</summary>
        {sources.length > 0 && <ol className="rv-answer-list" style={{ listStyle: "none", paddingLeft: 0 }}>{sources.map(source)}</ol>}
        {answer.wikiPages.length > 0 && <p>{A.WIKI}: {answer.wikiPages.map((one, index) => <span key={one.pageId}>{index > 0 && ", "}{wikiLink(one.pageId, one.title)}</span>)}</p>}
        {answer.unconfirmed.length > 0 && <div><p className="rv-muted">{A.NOT_CONFIRMED_NOTE}</p><ul>{answer.unconfirmed.map((one, index) => <li key={index}><VisibleText text={one} /></li>)}</ul></div>}
      </details>}
      {onStart !== undefined && answer.action !== undefined && answer.outcome !== "not_set_up" && <Button variant="primary" busy={starting === true} disabled={starting === true} onClick={onStart} data-testid="answer-start-task">{ANSWER_WORDS.taskButton}</Button>}
      {answer.answerId !== undefined && answer.outcome !== "not_set_up" && <NotRight key={answer.answerId} project={project} answerId={answer.answerId} />}
    </div>
  );
}
