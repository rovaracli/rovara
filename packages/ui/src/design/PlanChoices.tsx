import { useState } from "react";
import type { DecisionPlanChoices } from "@agentx/cloud-contracts/web";
import { VisibleText } from "./VisibleText.js";

/** What a requirements or coding plan card sends with Approve (OWNER DECISION 7): only the fields the person set; the broker checks every one against the document. */
export interface PlanFields {
 answers?: Array<{ decisionId: string; optionId: string; opened: boolean }>;
 selectedOptionalCheckIds?: string[];
 includedCommentIds?: string[];
 note?: string;
}

/** The note keeps its line breaks; other control and hidden characters are dropped (the broker refuses them). */
const cleanNote = (text: string): string => text.replace(/(?:(?!\n)[\p{Cc}\p{Cf}])+/gu, " ").trim().slice(0, 500);

/**
 * The document's choices on its card, as the old review page offered them: each question with AgentX's answer chosen until the person picks another (and the names of who suggested what), the coding
 * plan's optional checks, the open comments to send with the decision, and a note for AgentX. `fields()` is what Approve sends; `commentIds()` what Request changes sends.
 */
export function usePlanChoices(cardId: string, choices: DecisionPlanChoices | undefined) {
 const [picked, setPicked] = useState<Record<string, string>>({}), [checks, setChecks] = useState<Record<string, boolean>>({}), [left, setLeft] = useState<Record<string, true>>({}), [note, setNote] = useState("");
 const idOf = (...parts: string[]) => ["plan", cardId, ...parts].join("-").replace(/[^A-Za-z0-9_-]/gu, "-");
 const commentIds = (): string[] | undefined => choices === undefined || choices.openComments.length === 0 ? undefined : choices.openComments.filter(comment => left[comment.id] !== true).map(comment => comment.id);
 function fields(): PlanFields | undefined {
  if (choices === undefined) return undefined;
  const answers = choices.questions.flatMap(question => { const chosen = picked[question.id];return chosen === undefined || chosen === question.recommended ? [] : [{ decisionId: question.id, optionId: chosen, opened: true }]; });
  const changedChecks = choices.optionalChecks.some(check => checks[check.id] !== undefined && checks[check.id] !== check.selected);
  const selected = choices.optionalChecks.filter(check => checks[check.id] ?? check.selected).map(check => check.id);
  const comments = commentIds(), written = cleanNote(note);
  const out: PlanFields = { ...(answers.length === 0 ? {} : { answers }), ...(changedChecks ? { selectedOptionalCheckIds: selected } : {}), ...(comments === undefined ? {} : { includedCommentIds: comments }), ...(written === "" ? {} : { note: written }) };
  return Object.keys(out).length === 0 ? undefined : out;
 }
 const reset = () => { setPicked({});setChecks({});setLeft({});setNote(""); };
 const element = choices === undefined ? null : <div className="rv-decision-plan-choices">
  {choices.questions.length > 0 && <fieldset className="rv-decision-plan-questions"><legend>Questions in this document</legend><ol>{choices.questions.map(question => <li key={question.id}><fieldset><legend><VisibleText text={question.question} /></legend>
   {question.options.map(option => { const id = idOf("q", question.id, option.id), suggested = (question.suggested ?? []).filter(entry => entry.optionId === option.id).map(entry => entry.name);
    return <p key={option.id}><input type="radio" id={id} name={idOf("q", question.id)} checked={(picked[question.id] ?? question.recommended) === option.id} onChange={() => setPicked(current => ({ ...current, [question.id]: option.id }))} /> <label htmlFor={id}><VisibleText text={option.label + (option.id === question.recommended ? " (Rovara recommends this)" : "") + (suggested.length === 0 ? "" : " · suggested by " + suggested.join(", "))} /></label></p>; })}
  </fieldset></li>)}</ol></fieldset>}
  {choices.optionalChecks.length > 0 && <fieldset className="rv-decision-plan-checks"><legend>Optional checks to run</legend>{choices.optionalChecks.map(check => { const id = idOf("check", check.id);return <p key={check.id}><input type="checkbox" id={id} checked={checks[check.id] ?? check.selected} onChange={event => { const on = event.target.checked;setChecks(current => ({ ...current, [check.id]: on })); }} /> <label htmlFor={id}><VisibleText text={check.label} /></label></p>; })}</fieldset>}
  {choices.openComments.length > 0 && <fieldset className="rv-decision-plan-comments"><legend>Comments to send with your decision</legend>{choices.openComments.map(comment => { const id = idOf("comment", comment.id);return <p key={comment.id}><input type="checkbox" id={id} checked={left[comment.id] !== true} onChange={event => { const on = event.target.checked;setLeft(current => { const next = { ...current };if (on) delete next[comment.id];else next[comment.id] = true;return next; }); }} /> <label htmlFor={id}><VisibleText text={comment.excerpt} /></label></p>; })}<p className="rv-muted">A comment you leave out stays open for the next version.</p></fieldset>}
  <div className="rv-decision-plan-note"><label htmlFor={idOf("note")}>Note for Rovara (optional)</label><textarea id={idOf("note")} maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></div>
 </div>;
 return { element, fields, commentIds, reset };
}
