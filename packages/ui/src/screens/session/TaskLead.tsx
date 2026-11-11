import { useDecisions } from "../../api/decisions.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";
import { cardsFor, leadStatus, taskLead, type Lead } from "./task-plain-state.js";
import { workspaceTask, type ReadTask } from "./workspace-types.js";

/** Scrolls to an existing control or card of the page and puts focus on it (the pattern of Merge's "Go to the card"). The control keeps its own logic. */
export function goTo(targetId: string): void {
 const target = document.getElementById(targetId);
 if (target === null) return;
 // A target inside a closed disclosure (the phone order keeps the work behind one) is opened first, or scrolling and focus would do nothing.
 for (let parent = target.parentElement; parent !== null; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement && !parent.open) parent.open = true;
 target.scrollIntoView?.({ block: "center" });target.setAttribute("tabindex", "-1");target.focus();
}

/** The block itself: the plain state, then next step, who and why, with the one existing control that does the next step. Rows with no data are left out. */
export function TaskLeadView({ lead }: { lead: Lead }) {
 return <section className="rv-lead" aria-label="Where this task stands" data-tone={lead.state.tone}>
  {lead.approve !== undefined && <p className="rv-lead-approve"><VisibleText text={lead.approve} /></p>}
  <p className="rv-lead-state"><span className="rv-lead-pill" data-tone={lead.state.tone}>{lead.state.label}</span></p>
  <div className="rv-lead-next">
   <p className="rv-lead-eyebrow">Next step</p>
   <p className="rv-lead-title"><VisibleText text={lead.next} /></p>
   {(lead.who !== undefined || lead.why !== undefined) && <dl className="rv-lead-facts">
    {lead.who !== undefined && <div><dt>Who</dt><dd><VisibleText text={lead.who} /></dd></div>}
    {lead.why !== undefined && <div><dt>Why</dt><dd><VisibleText text={lead.why} /></dd></div>}
   </dl>}
   {lead.action !== undefined && <p className="rv-lead-action"><Button variant="primary" onClick={() => goTo(lead.action!.targetId)}>{lead.action.label}</Button></p>}
  </div>
 </section>;
}

/** The task page's header block, from data the page already has: the session's status, the task view and the viewer's pending decision cards (the same read the cards below use). */
export function TaskLead({ session }: { session: ReadSession }) {
 const decisions = useDecisions(), task: ReadTask | undefined = workspaceTask(session);
 const cards = cardsFor(decisions.data, task?.taskId);
 return <TaskLeadView lead={taskLead({ session, task, status: leadStatus(session), cards })} />;
}
