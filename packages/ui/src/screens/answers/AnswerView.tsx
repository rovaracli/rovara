import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import { ANSWER_WORDS, type AnswerCitation, type AnswerResponse } from "@agentx/contracts/web";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { hostLink } from "../project/wiki/wiki-model.js";
import { A, headline, pieces } from "./answer-text.js";
import "./answers.css";

const label = (cite: AnswerCitation): string => `${cite.repo}/${cite.path}:${String(cite.line)}${cite.lineEnd === undefined || cite.lineEnd === cite.line ? "" : "-" + String(cite.lineEnd)}`;

/**
 * One answer, the same words as everywhere else (answer first, proof one click away, no machinery): 2 to 5 sentences with small numbered source marks, one honesty line, up to four sources and one wiki page link,
 * a fold with all of them, and at most one fixed button. "Not set up" says so in fixed words and offers nothing to press. No cost, no confidence, no model name. The text is plain text, never markup.
 */
export function AnswerView({ project, answer, repositories, onStart, starting }: {
  project: string; answer: AnswerResponse; repositories: ReadonlyArray<{ name?: string | undefined; fullName: string }>;
  /** Present only when this person may start work: the one "Start a Quick task" button. Absent: no button at all (never a dead one). */
  onStart?: (() => void) | undefined; starting?: boolean;
}) {
  const said = headline(answer), sources = answer.sources, shown = sources.slice(0, 4), page = answer.wikiPages[0];
  const link = (cite: AnswerCitation) => hostLink(repositories, { repo: cite.repo, path: cite.path, commit: cite.commit, line: cite.line, ...(cite.lineEnd === undefined ? {} : { lineEnd: cite.lineEnd }) });
  const text = useMemo<ReactNode>(() => pieces(answer.text, sources.length).map((piece, index) => piece.kind === "text"
   ? <VisibleText key={index} text={piece.text} />
   : <sup key={index}><a href={"#answer-source-" + String(piece.n)} aria-label={"Source " + String(piece.n)}>[{piece.n}]</a></sup>), [answer.text, sources.length]);
  const wikiLink = (id: string, title: string) => <Link to={`/app/projects/${encodeURIComponent(project)}?tab=wiki&page=${encodeURIComponent(id)}`}><VisibleText text={title} /></Link>;
  const source = (cite: AnswerCitation) => { const href = link(cite); return <li key={cite.n} id={"answer-source-" + String(cite.n)}>[{cite.n}] {href === undefined ? <code><VisibleText text={label(cite)} /></code> : <a href={href} target="_blank" rel="noopener noreferrer"><code><VisibleText text={label(cite)} /></code></a>}</li>; };
  const hasMore = sources.length > shown.length || answer.wikiPages.length > 1 || answer.unconfirmed.length > 0;
  return (
    <div className="rv-answer" data-testid="answer" data-outcome={answer.outcome} role="status">
      {said !== undefined ? <p className="rv-answer-text"><VisibleText text={said} /></p> : <p className="rv-answer-text" data-testid="answer-text">{text}</p>}
      {answer.honesty !== undefined && said === undefined && <p className="rv-muted" data-testid="answer-honesty"><VisibleText text={answer.honesty} /></p>}
      {(shown.length > 0 || page !== undefined) && <p className="rv-answer-sources" data-testid="answer-sources"><span className="rv-muted">{A.SOURCES}: </span>
        {shown.map((cite) => <span key={cite.n}>[{cite.n}] {(() => { const href = link(cite); return href === undefined ? <code><VisibleText text={label(cite)} /></code> : <a href={href} target="_blank" rel="noopener noreferrer"><code><VisibleText text={label(cite)} /></code></a>; })()}{" "}</span>)}
        {page !== undefined && <span><span className="rv-muted">{A.WIKI}: </span>{wikiLink(page.pageId, page.title)}</span>}</p>}
      {hasMore && <details className="rv-answer-more"><summary>{A.MORE}</summary>
        {sources.length > 0 && <ol className="rv-answer-list" style={{ listStyle: "none", paddingLeft: 0 }}>{sources.map(source)}</ol>}
        {answer.wikiPages.length > 0 && <p>{A.WIKI}: {answer.wikiPages.map((one, index) => <span key={one.pageId}>{index > 0 && ", "}{wikiLink(one.pageId, one.title)}</span>)}</p>}
        {answer.unconfirmed.length > 0 && <div><p className="rv-muted">{A.NOT_CONFIRMED_NOTE}</p><ul>{answer.unconfirmed.map((one, index) => <li key={index}><VisibleText text={one} /></li>)}</ul></div>}
      </details>}
      {onStart !== undefined && answer.action !== undefined && answer.outcome !== "not_set_up" && <Button variant="primary" busy={starting === true} onClick={onStart} data-testid="answer-start-task">{ANSWER_WORDS.taskButton}</Button>}
    </div>
  );
}
