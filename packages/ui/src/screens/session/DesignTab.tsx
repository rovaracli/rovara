import { useContext, useMemo, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createDesignReviewApi } from "../../api/design-review.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { isGithubUrl, safeExternalUrl } from "../../text/links.js";
import { designTabModel, readDesignActions, readDesignReview, type CitationLine, type CodeLinkBase, type DesignTabModel, type FindingLine, type QuestionLine, type RoundLine } from "./design-review-view.js";
import type { ReadTask } from "./workspace-types.js";

// The Design tab (DR11). Every word a model wrote is shown through VisibleText: text, never markup, never a link. The one exception is a code citation, which links only through `codeLinkBase`, a base
// built from the task's own pull request records, and only to github.com over https.

/** A repository's web address, taken from a pull request of the task that is in that repository (the broker's record), never from a reviewer's words. */
export function codeLinkBaseOf(task: ReadTask): CodeLinkBase {
 return repo => {
  const pull = task.pullRequests?.find(candidate => candidate.repository === repo && isGithubUrl(candidate.url));
  if (pull === undefined) return undefined;
  const safe = safeExternalUrl(pull.url);
  return safe === undefined ? undefined : new URL(safe).origin + "/" + repo;
 };
}

function Citation({ line }: { line: CitationLine }) {
 const href = line.href !== undefined && isGithubUrl(line.href) ? safeExternalUrl(line.href) : undefined;
 return <li data-unchecked={line.unchecked ? "true" : undefined}>{href === undefined ? <VisibleText text={line.text} /> : <a href={href} target="_blank" rel="noopener noreferrer"><VisibleText text={line.text} /></a>}</li>;
}
function Citations({ label, lines }: { label: string; lines: readonly CitationLine[] }) {
 return lines.length === 0 ? null : <><p className="rv-muted">{label}</p><ul className="rv-design-citations">{lines.map((line, index) => <Citation key={index} line={line} />)}</ul></>;
}

function Finding({ finding }: { finding: FindingLine }) {
 const resolution = finding.resolution;
 return <li className="rv-design-finding" data-severity={finding.severity}>
  <p><strong>{finding.severityWords}</strong>{finding.raisedAgain ? " (raised again)" : ""}{finding.addedByRovara ? " (added by Rovara, no model)" : ""}{finding.sourceOnly === undefined ? "" : ` (${finding.sourceOnly})`}: <VisibleText text={finding.text} /></p>
  {finding.reviewers.length > 0 && <p className="rv-muted">Raised by <VisibleText text={finding.reviewers.join(", ")} /></p>}
  <Citations label="Cited" lines={finding.citations} />
  {finding.raw.length > 1 && <details><summary>The reviewers' own words ({finding.raw.length})</summary><ul>{finding.raw.map((entry, index) => <li key={index}><VisibleText text={entry.role + " (" + entry.severity + "): " + entry.text} /></li>)}</ul></details>}
  {resolution === undefined ? <p className="rv-muted">Not answered yet.</p> : <div className="rv-design-resolution">
   <p>{resolution.words}{resolution.settled ? " Settled." : " Not settled."}{resolution.question === undefined ? "" : " Question " + resolution.question + "."}</p>
   {resolution.note !== "" && <p><span className="rv-muted">The planner's words: </span><VisibleText text={resolution.note} /></p>}
   <Citations label="Evidence the planner gave" lines={resolution.evidence} />
  </div>}
 </li>;
}

function Round({ round }: { round: RoundLine }) {
 const id = "design-round-" + String(round.round);
 return <section className="rv-design-round" aria-labelledby={id}>
  <h3 id={id}>{"Round " + String(round.round) + " of 2"}</h3>
  <p className="rv-muted">{"Design version " + round.designVersion + ". " + String(round.verifiedCount) + " of " + String(round.reviewers.length) + " reviewers verified."}</p>
  {round.reviewers.length > 0 && <ul className="rv-design-reviewers" aria-label={"Reviewers in round " + String(round.round)}>{round.reviewers.map((reviewer, index) => <li key={index} data-verified={reviewer.verified ? "true" : "false"}>
   <p><strong><VisibleText text={reviewer.role} /></strong> <span className="rv-muted"><VisibleText text={"(" + reviewer.model + ")"} /></span></p>
   <p><VisibleText text={reviewer.proof} /></p>
   <p className="rv-muted"><VisibleText text={reviewer.cost + ", " + reviewer.tokens} /></p>
   {reviewer.filesRead.files.length > 0 && <details><summary>{reviewer.filesRead.label + ": " + String(reviewer.filesRead.files.length)}</summary><ul>{reviewer.filesRead.files.map((file, at) => <li key={at}><VisibleText text={file} /></li>)}</ul></details>}
  </li>)}</ul>}
  {round.groups.length === 0 ? <p>{round.reviewers.some(reviewer => reviewer.verified) ? "The reviewers found nothing to raise." : "No finding counts: no reviewer was verified."}</p> : round.groups.map(group => <section key={group.section} aria-label={"Findings in design " + group.section}>
   <h4>{"Design " + group.section}</h4>
   <ul className="rv-design-findings">{group.findings.map(finding => <Finding key={finding.id} finding={finding} />)}</ul>
  </section>)}
 </section>;
}

function Question({ question }: { question: QuestionLine }) {
 return <li className="rv-design-question">
  <p><span className="rv-muted">Unclear because: </span><VisibleText text={question.unclear} /></p>
  <Citations label="Evidence" lines={question.evidence} />
  <ul aria-label="Options">{question.options.map(option => <li key={option.id}><VisibleText text={option.id + ") " + option.label + ": " + option.consequence} />{option.recommended ? " (Rovara recommends this)" : ""}{option.chosen ? " (chosen)" : ""}</li>)}</ul>
  <p><span className="rv-muted">Rovara recommends {question.recommended}. Why: </span><VisibleText text={question.why} /></p>
  {question.answerText !== undefined && <p><span className="rv-muted">The answer given: </span><VisibleText text={question.answerText} /></p>}
 </li>;
}

/** "Retry review" (DR-KEY-1 D): asks the broker, which applies the rule again; a refusal is shown in its words. */
export function RetryReview({ left, onRetry }: { left: string; onRetry: () => Promise<void> }) {
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 async function press() {
  if (busy) return;
  setBusy(true);setError(undefined);
  try { await onRetry(); } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't retry the review. Try again."); }
  finally { setBusy(false); }
 }
 return <div className="rv-actions" role="group" aria-label="Retry design review">
  <Button busy={busy} onClick={() => { void press(); }}>Retry review</Button>
  <span className="rv-muted">{left}</span>
  {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
 </div>;
}

/** The tab's content from its model (separate from the task, so the tests and the page share it). */
export function DesignTabView({ model, onRetry }: { model: DesignTabModel; onRetry?: (() => Promise<void>) | undefined }) {
 return <section aria-label="Design review" className="rv-design">
  <p className="rv-design-line"><VisibleText text={model.classification} /></p>
  {model.reading !== undefined && <p><span className="rv-muted">Rovara's reading of the request: </span><VisibleText text={model.reading} /></p>}
  <dl className="rv-design-facts">
   <div><dt>Status</dt><dd>{model.statusWords}</dd></div>
   <div><dt>Tier</dt><dd>{model.tierWords}</dd></div>
   <div><dt>Estimated cost</dt><dd>{model.cost.estimate}</dd></div>
   <div><dt>Spent so far</dt><dd>{model.cost.spent}</dd></div>
   <div><dt>Limit for this task</dt><dd>{model.cost.limit}</dd></div>
  </dl>
  {model.progress !== undefined && <p role="status">{model.progress}</p>}
  {model.notRun !== undefined && <p role="status" className="rv-design-notrun">{model.notRun}</p>}
  {model.retry !== undefined && onRetry !== undefined && <RetryReview left={model.retry.left} onRetry={onRetry} />}
  {model.waiting !== undefined && <p role="status">{model.waiting}</p>}
  {model.decisions.length > 0 && <ul aria-label="Money decisions">{model.decisions.map((line, index) => <li key={index}>{line}</li>)}</ul>}
  {model.earlier !== undefined && <p className="rv-muted">{model.earlier}</p>}
  {model.paraphrase !== undefined && <section aria-label="What the reviewer says this proposes"><h3>What this proposes</h3><p className="rv-muted">{model.paraphrase.by}</p><blockquote className="rv-design-paraphrase"><VisibleText text={model.paraphrase.text} /></blockquote></section>}
  {model.disagreements.length > 0 && <section aria-label="Disagreements"><h3>Disagreements</h3><ul className="rv-design-disagreements">{model.disagreements.map(item => <li key={item.round + ":" + item.findingId}>
   <p><strong>{item.severity}</strong>{item.raisedAgain ? " (raised again)" : ""}. {item.kindWords}</p>
   <div className="rv-design-sides">
    <div><h4>The reviewers say</h4><p><VisibleText text={item.reviewerSide.text} /></p><Citations label="Cited" lines={item.reviewerSide.citations} /></div>
    <div><h4>The planner says</h4>{item.plannerSide === undefined ? <p>No answer.</p> : <><p>{item.plannerSide.words}</p>{item.plannerSide.note !== "" && <p><VisibleText text={item.plannerSide.note} /></p>}<Citations label="Evidence" lines={item.plannerSide.evidence} /></>}</div>
   </div>
  </li>)}</ul></section>}
  {model.questions !== undefined && <section aria-label="Design questions"><h3>{"Design questions (" + String(model.questions.questions.length) + ")"}</h3><ol>{model.questions.questions.map(question => <Question key={question.id} question={question} />)}</ol></section>}
  {model.rounds.map(round => <Round key={round.round} round={round} />)}
  {model.rounds.length === 0 && model.notRun === undefined && model.progress === undefined && <p className="rv-muted">No reviewer has read the design yet.</p>}
 </section>;
}

export function DesignTab({ task, sessionKey }: { task: ReadTask; sessionKey?: readonly unknown[] | undefined }) {
 const base = useMemo(() => codeLinkBaseOf(task), [task]), review = useMemo(() => readDesignReview(task.workflow?.designReview), [task]);
 if (review === undefined) return null;
 if (review === "unreadable") return <section aria-label="Design review" className="rv-design"><p role="status">This design review can't be shown by this version of the app. Reload the page; if it stays like this, the app needs an update.</p></section>;
 const model = designTabModel(review, { note: review.note, codeLinkBase: base, designWritten: (task.workflow?.artifacts ?? []).some(artifact => artifact.type === "design"), retry: readDesignActions(task.designActions)?.retry });
 return model.retry === undefined ? <DesignTabView model={model} /> : <DesignTabWithRetry model={model} taskId={task.taskId} sessionKey={sessionKey} />;
}

/** The tab when the broker offered "Retry review": the press goes to the broker, then the task is read again (through the page's query cache, when it has one). */
function DesignTabWithRetry({ model, taskId, sessionKey }: { model: DesignTabModel; taskId: string; sessionKey?: readonly unknown[] | undefined }) {
 const host = useAppHost(), query = useContext(QueryClientContext), api = useMemo(() => createDesignReviewApi(host), [host]);
 const onRetry = async (): Promise<void> => {
  const result = await api.retry(taskId, crypto.randomUUID());
  if (result.kind !== "done") throw new ApiError(409, "PENDING", "This is waiting for confirmation. Open the task to continue.");
  if (sessionKey !== undefined && query !== undefined) await query.invalidateQueries({ queryKey: [...sessionKey] });
 };
 return <DesignTabView model={model} onRetry={onRetry} />;
}
