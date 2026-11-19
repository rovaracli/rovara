import type { ReactNode } from "react";
import { DECISION_APPROVE_TAKES, DECISION_PLAN_NOTE_MAX, DECISION_OPTIONAL_CHECK_KINDS } from "@agentx/contracts/web";
import type { ReadDecision } from "../api/decisions.js";
import { answerShown, cleanNote, commentsAreAllListed, runLimitOf, type PlanPick } from "../api/plan-pick.js";
import { VisibleText } from "./VisibleText.js";

const dollars = (amount: number): string => "$" + amount.toFixed(2);

/**
 * What a plan, requirements or design card offers beside Approve (OWNER DECISION 7, from Code's card): the key facts, the document's questions with Rovara's recommendation, the optional checks (coding
 * plan only), the open comments, a note, and the run limit a coding plan sets (a raise needs a tick). Every word that came from the server is drawn as visible text. A card with none of these draws nothing.
 * The choices are what the server showed with this card's digest; Approve sends only what the person changed (`approveExtras`).
 */
export function PlanChoices({ decision, pick, onPick, disabled }: { decision: ReadDecision; pick: PlanPick; onPick: (next: PlanPick) => void; disabled: boolean }) {
 const { card, choices } = decision, limit = runLimitOf(card), id = card.id.replace(/[^A-Za-z0-9_-]/gu, "_");
 if (choices === undefined && limit === undefined && !decision.choicesUnreadable) return null;
 const parts: ReactNode[] = [];
 if (decision.choicesUnreadable) parts.push(<p key="unreadable" className="rv-muted" data-testid="plan-choices-unreadable">Some details of this decision could not be shown. Open the details to see them.</p>);
 if (choices?.summary !== undefined) {
  parts.push(<section key="summary" className="rv-plan-summary" aria-label="Key facts"><p><VisibleText text={choices.summary.needed} /></p><ul>{choices.summary.lines.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul></section>);
 }
 for (const question of choices?.questions ?? []) {
  const shown = answerShown(question, pick);
  parts.push(<fieldset key={"q-" + question.id} className="rv-plan-question" disabled={disabled}>
   <legend><VisibleText text={question.question} /></legend>
   {question.options.map(option => <label key={option.id}><input type="radio" name={"answer-" + id + "-" + question.id} checked={shown === option.id} onChange={() => onPick({ ...pick, answers: { ...pick.answers, [question.id]: option.id } })} /> <VisibleText text={option.label} />{option.id === question.recommended ? <span className="rv-muted"> (Rovara recommends this)</span> : null}</label>)}
   {(question.suggested ?? []).map((suggestion, index) => <p key={index} className="rv-muted">Suggested by <VisibleText text={suggestion.name} />: <VisibleText text={question.options.find(option => option.id === suggestion.optionId)?.label ?? "another answer"} /></p>)}
  </fieldset>);
 }
 if (choices !== undefined && DECISION_OPTIONAL_CHECK_KINDS.includes(card.kind) && choices.optionalChecks.length > 0) {
  parts.push(<fieldset key="checks" className="rv-plan-checks" disabled={disabled}>
   <legend>Optional checks</legend>
   {choices.optionalChecks.map(check => <label key={check.id}><input type="checkbox" checked={pick.checks.has(check.id)} onChange={event => { const next = new Set(pick.checks);if (event.target.checked) next.add(check.id);else next.delete(check.id);onPick({ ...pick, checks: next }); }} /> <VisibleText text={check.label} /></label>)}
  </fieldset>);
 }
 if (choices !== undefined && choices.openComments.length > 0) {
  const all = commentsAreAllListed(choices);
  parts.push(<fieldset key="comments" className="rv-plan-comments" disabled={disabled}>
   <legend>Open comments that go with your decision</legend>
   {choices.openComments.map(comment => <label key={comment.id}>{all ? <input type="checkbox" checked={pick.comments.has(comment.id)} onChange={event => { const next = new Set(pick.comments);if (event.target.checked) next.add(comment.id);else next.delete(comment.id);onPick({ ...pick, comments: next }); }} /> : null}{all ? " " : ""}<VisibleText text={comment.excerpt} /></label>)}
   {all ? null : <p className="rv-muted">{String(choices.openCommentCount)} comments are open; Approve takes all of them.</p>}
  </fieldset>);
 } else if (choices?.openCommentCount !== undefined && choices.openCommentCount > 0) {
  parts.push(<p key="comment-count" className="rv-muted">{String(choices.openCommentCount)} open comments go with your decision.</p>);
 }
 if (choices !== undefined) {
  const noteId = "note-" + id;
  parts.push(<div key="note" className="rv-plan-note"><label htmlFor={noteId}>Note for Rovara (optional)</label><textarea id={noteId} rows={2} maxLength={DECISION_PLAN_NOTE_MAX} value={pick.note} disabled={disabled} onChange={event => onPick({ ...pick, note: event.target.value })} />{pick.note.trim() !== "" && cleanNote(pick.note) === undefined ? <p className="rv-muted">Only plain text goes with your decision.</p> : null}</div>);
 }
 if (limit !== undefined) {
  parts.push(<div key="limit" className="rv-plan-limit"><p>{"Task limit: " + (limit.currentUsd === undefined ? "none yet" : dollars(limit.currentUsd) + " now") + ", " + dollars(limit.proposedUsd) + " once you approve."}</p>
   {limit.raises ? <label><input type="checkbox" checked={pick.limitAgreed} disabled={disabled} onChange={event => onPick({ ...pick, limitAgreed: event.target.checked })} /> {"I agree Rovara may spend up to " + dollars(limit.proposedUsd) + " on this task."}</label> : null}{limit.raises && !pick.limitAgreed ? <p id={"limit-hint-" + id} className="rv-muted">Tick the box above to approve.</p> : null}</div>);
 }
 if (choices !== undefined) parts.push(<p key="takes" className="rv-muted rv-plan-takes">{DECISION_APPROVE_TAKES}</p>);
 return <div className="rv-decision-plan" data-testid="plan-choices">{parts}</div>;
}
