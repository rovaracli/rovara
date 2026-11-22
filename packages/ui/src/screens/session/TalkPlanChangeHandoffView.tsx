import { Button } from "../../design/Button.js";
import { Link } from "react-router";
import type { SessionAnchorRef } from "@agentx/contracts/web";
import type { ReadDecision } from "../../api/decisions.js";
import { decisionOpenTarget } from "../../api/decisions.js";
import type { ReadMessage } from "../../api/sessions.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";
import { HeldState } from "../../design/HeldState.js";
import { createPortal } from "react-dom";
import { useTaskPlanNoteSlot } from "./task-slots.js";
import { StatusChip } from "../../design/StatusChip.js";
import type { PlanChangeFrameFacts } from "./PlanChangeFrame.js";

/** A read-only link from Talk to the exact plan decision page offered by the current decision card. */
export function TalkPlanChangeHandoffView({ session, instruction, decision, origin, anchor, read = "current", onReload, onPage = false, sheet, onNavigate, part = "both", hideNote = false }: {
 /** The Talk sheet splits the card (in the conversation) from the Review plan bar (pinned with the composer). */
 part?: "card" | "bar" | "both"; hideNote?: boolean;
 /** The Talk sheet draws the plan-change card for a delivered instruction, with the sticky Review plan bar. */
 sheet?: PlanChangeFrameFacts | undefined; onNavigate?: (() => void) | undefined;
 /** The page already shows this decision card: the handoff is one quiet line above it, not a second card. */
 onPage?: boolean; session: ReadSession; instruction?: ReadMessage; decision?: ReadDecision | undefined; origin: string; anchor?: { ref: SessionAnchorRef; href: string; label: string }; read?: "current" | "unavailable"; onReload?: () => void }) {
 const noteSlot = useTaskPlanNoteSlot();
 if (read === "unavailable") return <section role="alert" aria-label="Plan change handoff"><p>Couldn't recheck the plan. Reload it before opening a review.</p>{onReload && <Button onClick={onReload}>Reload plan</Button>}</section>;
 if (decision === undefined) return null;
 if (decision.card.status !== "pending") return instruction === undefined && decision.card.kind === "approve_plan" ? <p role="status">This plan proposal is no longer pending.</p> : null;
 const sameSessionAnchor = anchor === undefined || session.anchors?.some(item => item.target === anchor.ref.target && item.targetId === anchor.ref.targetId && item.revision === anchor.ref.revision) === true;
 const taskId = session.body.kind === "task" ? session.body.task.taskId : undefined;
 const acknowledgedInstruction = instruction !== undefined && instruction.sessionId === session.sessionId && instruction.kind === "steer" && instruction.delivery?.state === "delivered";
 const target = taskId !== undefined && decision.card.taskId === taskId && decision.card.kind === "approve_plan" && decision.card.status === "pending" && sameSessionAnchor && (instruction === undefined || acknowledgedInstruction)
  ? decisionOpenTarget(decision.card, origin)
  : undefined;
 if (target === undefined) return null;
 if (onPage && instruction === undefined) {
  const note = <p className="rv-plan-handoff-note" role="status" data-testid="talk-plan-change-handoff"><strong>Plan awaiting review.</strong> <span>A reply in Talk or Slack does not approve a plan.</span> <span className="rv-plan-handoff-link">Linked instruction <HeldState /></span></p>;
  if (hideNote) return null;
  return noteSlot === null ? note : createPortal(note, noteSlot);
 }

 if (sheet !== undefined && instruction !== undefined) {
  const named = "plan" + (sheet.version === undefined ? "" : " v" + String(sheet.version));
  const review = target.kind === "internal"
   ? <Link className="rv-button rv-button-primary" to={target.to} onClick={onNavigate}>Review {named}</Link>
   : <a className="rv-button rv-button-primary" href={target.href}>Review {named}</a>;
  const bar = <div className="rv-plan-change-bar">{review}<p>Replying &quot;yes&quot; here or in Slack does not approve a plan.</p></div>;
  const card = <div className="rv-plan-change-sheet-card">
    <header><StatusChip state="needs_you" /><h3>Plan change needs approval</h3></header>
    <dl>
     <div><dt>Earlier plan</dt><dd><HeldState /></dd></div>
     <div><dt>{"Plan" + (sheet.version === undefined ? "" : " v" + String(sheet.version))}</dt><dd>{sheet.headline === undefined ? <HeldState /> : <strong><VisibleText text={sheet.headline} /></strong>}</dd></div>
     {sheet.checks.length > 0 && <div><dt>Checks</dt><dd><VisibleText text={sheet.checks.join(". ")} /></dd></div>}
     {sheet.estimate !== undefined && <div><dt>Estimate</dt><dd><VisibleText text={sheet.estimate} /></dd></div>}
     <div><dt>Who</dt><dd>You or another owner. People who can only comment can&apos;t approve.</dd></div>
    </dl>
   </div>;
  if (part === "bar") return <div className="rv-plan-change-bar-wrap" data-testid="talk-plan-change-handoff" aria-label="Plan change handoff" role="group">{bar}</div>;
  return <section className="rv-plan-change-sheet" aria-label="Plan change handoff" data-testid={part === "card" ? undefined : "talk-plan-change-handoff"}>{card}{part === "both" && bar}</section>;
 }

 return <section className="rv-decision-pane" aria-label="Plan change handoff" data-testid="talk-plan-change-handoff">
  <h3>{instruction === undefined ? "Plan awaiting review" : "Plan change needs approval"}</h3>
  {instruction !== undefined && <p>The instruction was delivered. That does not mean its change was applied.</p>}
  {instruction === undefined && <p>This is the current pending plan. Rovara has not linked it to an instruction in this conversation.</p>}
  <p>A reply in Talk or Slack does not approve a plan.</p>
  {anchor !== undefined && <p><Link to={anchor.href}>Back to <VisibleText text={anchor.label} /></Link></p>}
  {target.kind === "internal"
   ? <Link className="rv-button rv-button-primary" to={target.to}>Review plan</Link>
   : <a className="rv-button rv-button-primary" href={target.href}>Review plan</a>}
 </section>;
}
