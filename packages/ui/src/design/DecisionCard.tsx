import { useRef, useState, type ReactNode, type TouchEvent } from "react";
import { Link } from "react-router";
import { DECISION_REJECT_REASONS, type DecisionRejectReason, type DecisionTabId } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { decisionOpenTarget, type ReadDecision } from "../api/decisions.js";
import { Button } from "./Button.js";
import { Tabs } from "./Tabs.js";
import { VisibleText } from "./VisibleText.js";

const RISK_WORDS: Record<string, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };
const STATE_WORDS: Record<string, string> = { good: "", warning: " (check this)", bad: " (problem)", unknown: "" };
const REASON_WORDS: Record<DecisionRejectReason, string> = { wrong_problem: "Wrong problem", wrong_approach: "Wrong approach", too_big: "Too big", missing_test: "Missing test", not_now: "Not now", other: "Other" };
/** A swipe right this far (and mostly sideways) approves a LOW card on a phone. The buttons always work; the swipe is a shortcut and never exists above low. */
export const SWIPE_APPROVE_PX = 120;

export interface DecisionCardActions {
 /** Records on the server that the evidence of this card (or tab) was opened; resolves when it is recorded. */
 onOpenEvidence(tab?: DecisionTabId): Promise<void>;
 onApprove(tab?: DecisionTabId): Promise<void>;
 onReject(reason: DecisionRejectReason): Promise<void>;
}

function Chips({ chips }: { chips: ReadDecision["card"]["evidence"] }) {
 return <dl className="rv-decision-evidence">{chips.map((chip, index) => <div key={index} data-state={chip.state}><dt><VisibleText text={chip.label} /></dt><dd><VisibleText text={chip.value + (STATE_WORDS[chip.state] ?? "")} /></dd></div>)}</dl>;
}

/**
 * One decision, with its evidence on the front. Friction follows the card's own flags, which the SERVER also enforces:
 * low: Approve is one tap (or a swipe on a phone); medium: Approve stays disabled until the evidence panel was opened and the server recorded it; high: no Approve at all, only "Open to decide".
 * Nothing here approves several cards: a card has one approve button (one per tab on a Full pair, each a separate approval).
 */
export function DecisionCard({ decision, actions }: { decision: ReadDecision; actions: DecisionCardActions }) {
 const { card, tabs } = decision, host = useAppHost();
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [opened, setOpened] = useState<Record<string, boolean>>({}), [tab, setTab] = useState<DecisionTabId>("requirements");
 const touch = useRef<{ x: number; y: number } | undefined>(undefined);
 const target = decisionOpenTarget(card, host.origin);
 const canApprove = card.actions.some(action => action.kind === "approve") && card.risk !== "high";
 const canReject = card.actions.some(action => action.kind === "reject") && card.risk !== "high";
 const needsEvidence = card.friction.expandEvidenceFirst && card.risk === "medium";
 const activeTab = tabs === undefined ? undefined : tab;
 async function run(work: () => Promise<void>) {
  if (busy) return;
  setBusy(true);setError(undefined);
  try { await work(); } catch (failure) { setError(failure instanceof Error && failure.message !== "" ? failure.message : "Couldn't complete this. Try again."); } finally { setBusy(false); }
 }
 const open = (which: DecisionTabId | undefined) => run(async () => { await actions.onOpenEvidence(which);setOpened(current => ({ ...current, [which ?? "card"]: true })); });
 const approve = (which: DecisionTabId | undefined) => run(() => actions.onApprove(which));
 const link: ReactNode = target === undefined ? null : target.kind === "internal" ? <Link className="rv-decision-open" to={target.to}>{card.risk === "high" ? "Open to decide" : "Open the details"}</Link> : <Button variant="quiet" onClick={() => host.openExternal(target.href)}>{card.risk === "high" ? "Open to decide" : "Open the details"}</Button>;
 const swipe = card.risk === "low" && canApprove && tabs === undefined ? {
  onTouchStart: (event: TouchEvent) => { const point = event.touches[0];touch.current = point === undefined || event.touches.length !== 1 ? undefined : { x: point.clientX, y: point.clientY }; },
  onTouchEnd: (event: TouchEvent) => {
   const start = touch.current, end = event.changedTouches[0];touch.current = undefined;
   if (start !== undefined && end !== undefined && end.clientX - start.x >= SWIPE_APPROVE_PX && Math.abs(end.clientY - start.y) < (end.clientX - start.x) / 2) void approve(undefined);
  },
 } : {};
 const evidencePanel = (which: DecisionTabId | undefined, summary: string) => <details className="rv-decision-panel" onToggle={event => { if ((event.currentTarget as HTMLDetailsElement).open && needsEvidence && opened[which ?? "card"] !== true) void open(which); }}>
  <summary>{needsEvidence ? "Open the evidence to approve" : "More evidence"}</summary>
  <p><VisibleText text={summary} /></p>
  {card.riskReasons.length > 0 && <ul>{card.riskReasons.map((reason, index) => <li key={index}><VisibleText text={reason} /></li>)}</ul>}
  {link}
 </details>;
 const approveButton = (which: DecisionTabId | undefined) => canApprove && <Button variant="primary" busy={busy} disabled={needsEvidence && opened[which ?? "card"] !== true} onClick={() => { void approve(which); }}>{which === undefined ? "Approve" : "Approve " + (which === "requirements" ? "requirements" : "design")}</Button>;
 return <article className="rv-decision" data-risk={card.risk} aria-label={card.title} {...swipe}>
  <header><h2><VisibleText text={card.title} /></h2><p className="rv-decision-risk">{RISK_WORDS[card.risk] ?? "Risk unknown"}</p></header>
  <p className="rv-decision-question"><VisibleText text={card.question} /></p>
  <p className="rv-decision-recommended">Recommended: <VisibleText text={card.recommended.action + ". " + card.recommended.why} /></p>
  <p className="rv-decision-next">Next: <VisibleText text={card.next.text} /></p>
  {tabs === undefined ? <Chips chips={card.evidence} /> : <Tabs label={"Documents to approve for " + card.title} value={tab} onValueChange={value => { if (value === "requirements" || value === "design") setTab(value); }} items={tabs.map(item => ({ value: item.id, label: item.title + (item.approved ? " (approved)" : ""), content: <><Chips chips={item.evidence} />{needsEvidence && evidencePanel(item.id, item.summary)}</> }))} />}
  {tabs === undefined && needsEvidence && evidencePanel(undefined, card.question)}
  {card.risk === "high" && <p className="rv-decision-high">This decision is made on its own page, after you sign in again.</p>}
  <div className="rv-decision-actions">
   {card.risk === "high" ? link : <>{approveButton(activeTab)}{canReject && <details className="rv-decision-reject"><summary>Not now</summary><ul>{DECISION_REJECT_REASONS.filter(reason => card.rejectReasons.includes(reason)).map(reason => <li key={reason}><Button variant="quiet" busy={busy} onClick={() => { void run(() => actions.onReject(reason)); }}>{REASON_WORDS[reason]}</Button></li>)}</ul></details>}{needsEvidence ? null : link}</>}
  </div>
  {error && <p role="alert"><VisibleText text={error} /></p>}
 </article>;
}
