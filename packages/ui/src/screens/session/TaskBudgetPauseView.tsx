import { Card } from "../../design/Card.js";
import { VisibleText } from "../../design/VisibleText.js";

export type TaskBudgetPauseEvidence =
 | {
  kind: "monthly_limit_refusal";
  scope?: string;
  step?: string;
  stepDetail?: string;
  observedAt?: string;
  cost?: string;
  allowance?: string;
  reset?: string;
  persistedWork?: string;
 }
 | { kind: "generic_pause"; detail?: string }
 | { kind: "test_cap" }
 | { kind: "budget_unavailable" };

export function TaskBudgetPauseView({ read, evidence, moneyHref }: {
 read: "current" | "unavailable";
 evidence: TaskBudgetPauseEvidence;
 moneyHref?: string;
}) {
 if (read === "unavailable") return <Card className="rv-session-banners" aria-label="Task budget details">
  <h2>Task budget details are unavailable</h2>
  <p>Rovara couldn't confirm the task's budget details on its latest read. Older details are hidden.</p>
 </Card>;

 if (evidence.kind === "monthly_limit_refusal") {
  const scope = evidence.scope;
  const step = evidence.step;
  const heading = scope !== undefined && step !== undefined
   ? `Paused in the middle of ${step}: ${scope}'s monthly limit was reached`
   : scope !== undefined
    ? `A monthly limit for ${scope} refused the next AI call`
    : step !== undefined
     ? `A monthly limit refused the next AI call during ${step}`
     : "A monthly limit refused the next AI call";
  const detail = step === undefined ? undefined : evidence.stepDetail ?? step;
  return <Card className="rv-session-banners" aria-label="Task budget pause">
   <h2><VisibleText text={heading} /></h2>
   <dl className="rv-kv-list">
    <div className="rv-kv"><dt>What happened</dt><dd>
    {evidence.observedAt !== undefined ? <>At <VisibleText text={evidence.observedAt} /> </> : null}
     the next AI call{detail === undefined ? " was refused." : <> for <VisibleText text={detail} /> was refused{scope === undefined ? "." : <> because <VisibleText text={scope} />'s monthly limit was reached.</>}</>}
    </dd></div>
    {evidence.cost !== undefined && <div className="rv-kv"><dt>Cost</dt><dd><VisibleText text={evidence.cost} /></dd></div>}
    {evidence.allowance !== undefined && <div className="rv-kv"><dt>Allowance</dt><dd><VisibleText text={evidence.allowance} /></dd></div>}
    {evidence.reset !== undefined && <div className="rv-kv"><dt>Reset</dt><dd><VisibleText text={evidence.reset} /></dd></div>}
    {evidence.persistedWork !== undefined && <div className="rv-kv"><dt>What is safe</dt><dd><VisibleText text={evidence.persistedWork} /></dd></div>}
   </dl>
   {moneyHref !== undefined && <p><a className="rv-button rv-button-primary" href={moneyHref}>Raise the limit in Money</a></p>}
  </Card>;
 }

 const state = {
  generic_pause: { heading: "Task paused", message: evidence.kind === "generic_pause" ? evidence.detail ?? "The task is paused. Its reason is not available." : "The task is paused." },
  test_cap: { heading: "This test run reached its own limit", message: "This task's test limit is separate from the company's monthly limit." },
  budget_unavailable: { heading: "Task budget details are unavailable", message: "Rovara couldn't read the budget details. This does not show whether a limit was reached." },
 }[evidence.kind];
 return <Card className="rv-session-banners" aria-label="Task pause">
  <h2>{state.heading}</h2>
  <p>{state.message}</p>
 </Card>;
}
