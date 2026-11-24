import type { ReactNode } from "react";
import type { ReadPlan } from "../../api/work.js";
import { DecisionFrame } from "../../design/DecisionFrame.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { SpecStep } from "./SpecStep.js";
import "../work/work.css";

/** "not-written": Code said the task has no plan yet (a quiet status, never an error, and never a decision: it is not in `mayShowDecision`). */
export type PlanDecisionState = "read-required" | "ready" | "outdated" | "failed" | "not-written" | "submitting";

/** The quiet line for a task whose plan Rovara has not written yet. */
export const PLAN_NOT_YET_LINE = "Rovara will show the plan here when it's ready.";

/** The line for a task that has ended (cancelled, answered, rejected, failed) with no plan document: past tense, because no plan is coming (rule #14: never promise what will not happen). */
export const PLAN_NONE_WRITTEN_LINE = "No plan was written for this task.";

/** The line while Rovara is actually writing the plan (the planning step is running and no plan exists yet). */
export const PLAN_WRITING_LINE = "Rovara is writing the plan.";

export interface PlanDecisionViewProps {
 /** The words for state "not-written"; the quiet default unless the task is at the planning step. */
 notWrittenLine?: string | undefined;
 /** The task has ended with no plan: the card's title says so in the past tense instead of "not written yet". */
 ended?: boolean | undefined;
 taskTitle: string;
 plan: ReadPlan | undefined;
 state: PlanDecisionState;
 decisionSlot?: ReactNode | undefined;
 onRetry?: (() => void) | undefined;
 /** The route's exact Slack return destination, when its owning composition has one. */
 slackReturnTo?: string | undefined;
}

/** Cloud's plan approval view. Decision handlers and evidence digest policy remain in the caller-owned action slot. */
export function PlanDecisionView({ taskTitle, plan, state, decisionSlot, onRetry, slackReturnTo, ended = false, notWrittenLine = PLAN_NOT_YET_LINE }: PlanDecisionViewProps) {
 const mayShowDecision = state === "read-required" || state === "ready";
 return <article className="rv-task-plan-view" aria-label="Plan decision">
  <header className="rv-pane-head">
   <p className="rv-eyebrow">{slackReturnTo !== undefined && <><a href={slackReturnTo}>Back to Slack</a> · </>}Plan decision</p>
   <h2><VisibleText text={taskTitle} /></h2>
   <div className="rv-section-head"><h3>{state === "failed" || state === "not-written" ? "Plan" : "Plan v" + String(plan?.version ?? "?")}</h3>{state !== "failed" && state !== "not-written" && <span>Current revision</span>}</div>
  </header>
  <DecisionFrame title={state === "failed" ? "Plan unavailable" : state === "not-written" ? (ended ? "No plan" : "Plan not written yet") : "Review this plan"} actions={null} className="rv-task-primary">
   <section className="rv-pane-main" aria-label="Current plan">
  {state === "failed" && <div className="rv-plan-decision-state" role="alert">
      <p>The latest plan couldn't be read. Try again before deciding.</p>
   {onRetry !== undefined && <Button onClick={onRetry}>Read the plan again</Button>}
  </div>}
  {state === "not-written" && <p className="rv-muted rv-plan-decision-state" role="status" data-testid="plan-not-yet">{notWrittenLine}</p>}
  {state === "outdated" && <div className="rv-plan-decision-state" role="status">
   <h3>This plan was replaced</h3>
   <p>A newer plan is available. Review this revision before deciding.</p>
  </div>}
  {state === "submitting" && <p className="rv-plan-decision-state" role="status">Submitting your decision…</p>}
  {state === "read-required" && <p className="rv-plan-decision-state" role="status">Read the required evidence before approving this plan.</p>}
  {state === "ready" && <p className="rv-plan-decision-state" role="status">Required evidence read for this revision. It has not been approved yet.</p>}
  {state !== "failed" && state !== "not-written" && plan !== undefined && <>
   <h3>Current plan</h3>
   <SpecStep plan={plan} comments={[]} />
  </>}
   </section>
   {mayShowDecision && decisionSlot !== undefined && <div aria-label="Your decision">{decisionSlot}</div>}
  </DecisionFrame>
 </article>;
}
