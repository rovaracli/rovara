import { useRef, useState, type ReactNode, type TouchEvent } from "react";
import { Link } from "react-router";
import { DECISION_REJECT_REASONS, type DecisionRejectReason, type DecisionTabId } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { ApiError } from "../api/errors.js";
import { decisionOpenTarget, mayApproveHere, type DecisionResult, type ReadDecision } from "../api/decisions.js";
import { Button } from "./Button.js";
import { Tabs } from "./Tabs.js";
import { VisibleText } from "./VisibleText.js";

const RISK_WORDS: Record<string, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };
const STATE_WORDS: Record<string, string> = { good: "", warning: " (check this)", bad: " (problem)", unknown: "" };
const REASON_WORDS: Record<DecisionRejectReason, string> = { wrong_problem: "Wrong problem", wrong_approach: "Wrong approach", too_big: "Too big", missing_test: "Missing test", not_now: "Not now", other: "Other" };
/** A swipe right this far (and mostly sideways) approves a LOW card on a phone. The buttons always work; the swipe is a shortcut and never exists above low. */
export const SWIPE_APPROVE_PX = 120;

export interface DecisionCardActions {
 /** Records on the server that the evidence of what was SHOWN (the decision's digest) was opened; resolves when it is recorded. */
 onOpenEvidence(tab?: DecisionTabId): Promise<void>;
 onApprove(tab?: DecisionTabId): Promise<DecisionResult>;
 onReject(reason: DecisionRejectReason): Promise<DecisionResult>;
 /** The server said what was shown is out of date: load the cards again. */
 onStale(): void;
}

function Chips({ chips }: { chips: ReadDecision["card"]["evidence"] }) {
 return <dl className="rv-decision-evidence">{chips.map((chip, index) => <div key={index} data-state={chip.state}><dt><VisibleText text={chip.label} /></dt><dd><VisibleText text={chip.value + (STATE_WORDS[chip.state] ?? "")} /></dd></div>)}</dl>;
}

/**
 * One decision, with its evidence on the front. Friction follows the card's own flags, which the SERVER also enforces:
 * low: Approve is one tap (or a swipe on a phone); medium: Approve stays disabled until the evidence panel (the detail the front does not carry) was opened and the server recorded it for THIS digest;
 * high: no Approve at all, only "Open to decide" (the confirmation page).
 * What was opened is remembered by digest, so a changed card must be opened again; a stale answer from the server clears it and loads the cards again.
 * Nothing here approves several cards: a card has one approve button (one per tab on a Full pair, each a separate approval).
 */
export function DecisionCard({ decision, actions }: { decision: ReadDecision; actions: DecisionCardActions }) {
 const { card, tabs, details, digest } = decision, host = useAppHost();
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [opened, setOpened] = useState<Record<string, string>>({}), [tab, setTab] = useState<DecisionTabId>("requirements");
 const [note, setNote] = useState<ReactNode>(null);
 const touch = useRef<{ x: number; y: number } | undefined>(undefined);
 const target = decisionOpenTarget(card, host.origin);
 const canApprove = mayApproveHere(card);
 const canReject = card.actions.some(action => action.kind === "reject") && card.risk !== "high";
 const needsEvidence = card.friction.expandEvidenceFirst && card.risk === "medium";
 const activeTab = tabs === undefined ? undefined : tab;
 // The requirements are approved before the design: the design tab's Approve waits for them.
 const designBlocked = (which: DecisionTabId | undefined) => which === "design" && tabs?.some(item => item.id === "requirements" && !item.approved) === true;
 const isOpened = (which: DecisionTabId | undefined) => opened[which ?? "card"] === digest;
 async function run(work: () => Promise<void>) {
  if (busy) return;
  setBusy(true);setError(undefined);setNote(null);
  try { await work(); } catch (failure) {
   if (failure instanceof ApiError && failure.code === "CHANGE_STALE") { setOpened({});actions.onStale();setError(failure.message); }
   else setError(failure instanceof Error && failure.message !== "" ? failure.message : "Couldn't complete this. Try again.");
  } finally { setBusy(false); }
 }
 const settle = (result: DecisionResult) => {
  if (result.kind === "decided") return;
  if (result.confirmUrl !== undefined) { const url = result.confirmUrl;setNote(<p role="status">Nothing is decided yet. <Button variant="quiet" onClick={() => host.openExternal(url)}>Confirm on the next page</Button></p>); }
  else setNote(<p role="status">Nothing is decided yet. Open the decision to confirm it.</p>);
 };
 const open = (which: DecisionTabId | undefined) => run(async () => { await actions.onOpenEvidence(which);setOpened(current => ({ ...current, [which ?? "card"]: digest })); });
 const approve = (which: DecisionTabId | undefined) => run(async () => { settle(await actions.onApprove(which)); });
 const link: ReactNode = target === undefined ? null : target.kind === "internal" ? <Link className="rv-decision-open" to={target.to}>{card.risk === "high" ? "Open to decide" : "Open the details"}</Link> : <Button variant="quiet" onClick={() => host.openExternal(target.href)}>{card.risk === "high" ? "Open to decide" : "Open the details"}</Button>;
 const swipe = card.risk === "low" && canApprove && tabs === undefined ? {
  onTouchStart: (event: TouchEvent) => { const point = event.touches[0];touch.current = point === undefined || event.touches.length !== 1 ? undefined : { x: point.clientX, y: point.clientY }; },
  onTouchEnd: (event: TouchEvent) => {
   const start = touch.current, end = event.changedTouches[0];touch.current = undefined;
   if (start !== undefined && end !== undefined && end.clientX - start.x >= SWIPE_APPROVE_PX && Math.abs(end.clientY - start.y) < (end.clientX - start.x) / 2) void approve(undefined);
  },
 } : {};
 const evidencePanel = (which: DecisionTabId | undefined) => {
  const groups = details.filter(group => group.tab === which);
  return <details className="rv-decision-panel" onToggle={event => { if ((event.currentTarget).open && needsEvidence && !isOpened(which)) void open(which); }}>
   <summary>{needsEvidence ? "Open the evidence to approve" : "More evidence"}</summary>
   {groups.map((group, index) => <section key={index} aria-label={group.title}><h3>{group.title}</h3><ul>{group.lines.map((line, at) => <li key={at}><VisibleText text={line} /></li>)}</ul></section>)}
   {link}
  </details>;
 };
 const approveButton = (which: DecisionTabId | undefined) => canApprove && <Button variant="primary" busy={busy} disabled={(needsEvidence && !isOpened(which)) || designBlocked(which)} onClick={() => { void approve(which); }}>{which === undefined ? "Approve" : "Approve " + (which === "requirements" ? "requirements" : "design")}</Button>;
 const confirmPage = target?.kind === "external";
 return <article className="rv-decision" data-risk={card.risk} aria-label={card.title} {...swipe}>
  <header><h2><VisibleText text={card.title} /></h2><p className="rv-decision-risk">{RISK_WORDS[card.risk] ?? "Risk unknown"}</p></header>
  <p className="rv-decision-question"><VisibleText text={card.question} /></p>
  <p className="rv-decision-recommended">Recommended: <VisibleText text={card.recommended.action + ". " + card.recommended.why} /></p>
  <p className="rv-decision-next">Next: <VisibleText text={card.next.text} /></p>
  {tabs === undefined ? <Chips chips={card.evidence} /> : <Tabs label={"Documents to approve for " + card.title} value={tab} onValueChange={value => { if (value === "requirements" || value === "design") setTab(value); }} items={tabs.map(item => ({ value: item.id, label: item.title + (item.approved ? " (approved)" : ""), content: <><Chips chips={item.evidence} />{needsEvidence && evidencePanel(item.id)}</> }))} />}
  {tabs === undefined && needsEvidence && evidencePanel(undefined)}
  {card.risk === "high" && <p className="rv-decision-high">{confirmPage ? "This decision is made on its own page, after you sign in again." : "This decision is made on its own page."}</p>}
  <div className="rv-decision-actions">
   {card.risk === "high" ? link : <>{approveButton(activeTab)}{canReject && <details className="rv-decision-reject"><summary>Not now</summary><ul>{DECISION_REJECT_REASONS.filter(reason => card.rejectReasons.includes(reason)).map(reason => <li key={reason}><Button variant="quiet" busy={busy} onClick={() => { void run(async () => { settle(await actions.onReject(reason)); }); }}>{REASON_WORDS[reason]}</Button></li>)}</ul></details>}{needsEvidence ? null : link}</>}
  </div>
  {note}
  {error && <p role="alert"><VisibleText text={error} /></p>}
 </article>;
}
