import type { ReactElement } from "react";
import { VisibleText } from "../../design/VisibleText.js";
import "./answer-receipt.css";

/** One place the answer was read, as the owning adapter supplies it: the line is already plain text (`repository/path:line`), the note is optional. */
export interface AnswerReceiptSource {
 readonly line: string;
 readonly note?: string | undefined;
}

/** A labelled fact the owner serves for this answer (for example "Read" or "Cost"). Nothing is shown for a fact that is not served. */
export interface AnswerReceiptDetail {
 readonly label: string;
 readonly value: string;
}

/**
 * Everything the receipt shows. The Session owner (AnsweredSection) derives it from the task, keeps the Answered predicate, sanitizes the model's words (plainAnswerText, answerSourceLine),
 * limits the sources and decides whether the follow-up guidance applies to this viewer. This view only lays those facts out.
 */
export interface AnswerReceiptFacts {
 /** The fixed heading, for example "Rovara answered this. No code was changed.". */
 readonly heading: string;
 /** The answer as plain text. A line break stays a line. */
 readonly answer: string;
 /** Where in the code it was read, in order. Empty shows the "without sources" state. */
 readonly sources: readonly AnswerReceiptSource[];
 /** The question as Rovara restated it, when it is served. */
 readonly question?: string | undefined;
 /** The existing follow-up guidance in its fixed words. Absent for a person who may not ask (a viewer, a session on a Mac): the receipt then only reads. */
 readonly followUp?: string | undefined;
 /** Further served facts shown after the fixed result line, in this order. */
 readonly details?: readonly AnswerReceiptDetail[] | undefined;
}

/** The fixed result line. A receipt only exists for an answer-only task, so these words are true whenever the view is shown. */
export const ANSWER_RESULT_WORDS = "An answer. No code was changed and there is nothing to merge.";
export const ANSWER_SOURCES_HEADING = "Based on";
export const ANSWER_NO_SOURCES_WORDS = "Rovara did not name where in the code it read this.";

/**
 * The answer-only result (board AnswerOnly / AnswerOnlyPhone). Read-only on purpose: there is no button here that starts a task, asks a follow-up or changes anything. The only guidance is
 * the existing sentence the adapter passes in. Text goes in as React text children, so none of it can become markup.
 */
export function AnswerReceiptView({ facts, headingLevel = 3 }: { facts: AnswerReceiptFacts; headingLevel?: 2 | 3 }): ReactElement | null {
 if (facts.answer.trim() === "") return null;
 const Heading = headingLevel === 2 ? "h2" : "h3", Sub = headingLevel === 2 ? "h3" : "h4";
 const details = facts.details ?? [];
 return <section aria-label="Rovara's answer" className="rv-answer-receipt">
  {facts.question !== undefined && facts.question.trim() !== "" && <p className="rv-answer-receipt-question"><span className="rv-answer-receipt-tag">Question</span><span className="rv-answer-receipt-quote"><VisibleText text={facts.question} /></span></p>}
  <Heading className="rv-answer-receipt-heading"><VisibleText text={facts.heading} /></Heading>
  <p className="rv-answer-receipt-text" data-testid="answer-receipt-text"><VisibleText text={facts.answer} /></p>
  <div className="rv-answer-receipt-block">
   <Sub className="rv-answer-receipt-sub">{ANSWER_SOURCES_HEADING}</Sub>
   {facts.sources.length > 0
    ? <ul className="rv-answer-receipt-sources">{facts.sources.map((source, index) => <li key={String(index)}><code><VisibleText text={source.line} /></code>{source.note !== undefined && source.note !== "" && <span className="rv-answer-receipt-note"><VisibleText text={source.note} /></span>}</li>)}</ul>
    : <p className="rv-muted rv-answer-receipt-none">{ANSWER_NO_SOURCES_WORDS}</p>}
  </div>
  <dl className="rv-answer-receipt-facts">
   <div className="rv-answer-receipt-fact"><dt>Result</dt><dd>{ANSWER_RESULT_WORDS}</dd></div>
   {details.map((detail, index) => <div className="rv-answer-receipt-fact" key={String(index) + detail.label}><dt><VisibleText text={detail.label} /></dt><dd><VisibleText text={detail.value} /></dd></div>)}
  </dl>
  {facts.followUp !== undefined && facts.followUp !== "" && <p className="rv-muted rv-answer-receipt-follow"><VisibleText text={facts.followUp} /></p>}
 </section>;
}
