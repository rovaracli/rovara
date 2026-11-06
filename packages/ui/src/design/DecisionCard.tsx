import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { DECISION_REJECT_REASONS, type DecisionRejectReason, type DecisionTabId } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { ApiError } from "../api/errors.js";
import { decisionOpenTarget, mayApproveHere, type DecisionResult, type ReadDecision } from "../api/decisions.js";
import { spendChoiceOf, type DesignApprovalRead } from "../api/design-review.js";
import { APPROVE_REASON_HINT, cleanApproveReason, openBlockersOnCard } from "./design-review-card.js";
import { Button } from "./Button.js";
import { Tabs } from "./Tabs.js";
import { VisibleText } from "./VisibleText.js";

type Confirming = { url: string; merging: ReadonlyArray<{ repositoryId: string; number: number; baseBranch: string }> };
/** "Merge #7 into main?"; with several pull requests each is named by its repository: "Merge payments #7 into main and billing #8 into develop?". */
export function mergeQuestion(merging: Confirming["merging"]): string {
 const parts = merging.map(pull => (merging.length > 1 ? pull.repositoryId + " " : "") + "#" + String(pull.number) + " into " + pull.baseBranch);
 return "Merge " + (parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1]! : parts[0]!) + "? This can't be undone from Rovara.";
}
const RISK_WORDS: Record<string, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };
const STATE_WORDS: Record<string, string> = { good: "", warning: " (check this)", bad: " (problem)", unknown: "" };
const REASON_WORDS: Record<DecisionRejectReason, string> = { wrong_problem: "Wrong problem", wrong_approach: "Wrong approach", too_big: "Too big", missing_test: "Missing test", not_now: "Not now", other: "Other" };
/** A swipe right this far (and mostly sideways) approves a LOW card on a phone. The buttons always work; the swipe is a shortcut and never exists above low. */
export const SWIPE_APPROVE_PX = 120;

export interface DecisionCardActions {
 /** Records on the server that the evidence of what was SHOWN (the decision's digest) was opened; resolves when it is recorded. */
 onOpenEvidence(tab?: DecisionTabId): Promise<void>;
 /** `reason` is the one plain line an approve_design card with an open blocker asks for (owner Q8); it is sent only there. */
 onApprove(tab?: DecisionTabId, reason?: string): Promise<DecisionResult>;
 onReject(reason: DecisionRejectReason): Promise<DecisionResult>;
 /** The server said what was shown is out of date: load the cards again. */
 onStale(): void;
 /** A choice on a design review's cost card (raise the limit, run a lower tier, run it unpriced, skip): the card's own action. */
 onChoose?(action: ReadDecision["card"]["actions"][number]): Promise<void>;
 /** On an approve_plan card: the Design first action and whether the task's plan may need design (a hint, never automatic: owner Q4). */
 design?: { hint: boolean; onDesignFirst(): Promise<void> };
 /**
  * On the task page, a HIGH-risk approve_design card is decided on the card itself (the inline Approve), not on another page: `read` asks the server whether this person may and what the card's digest is now,
  * `approve` presses it with the digest that was shown. Absent where the card only links to the task (Home): the link goes to this card on the task page.
  */
 highRisk?: { read(): Promise<DesignApprovalRead>; approve(shownDigest: string, reason?: string): Promise<void> };
}

const HIGH_RISK_NOTE = "High risk: approving needs a recent sign-in.";
const CHANGED_WORDS = "This changed while you were looking. The card has the latest; check it and approve again.";
/** The element id of a decision card on a page (the card id has a colon). */
export const decisionElementId = (cardId: string): string => "decision-" + cardId.replace(/[^A-Za-z0-9_-]/gu, "-");

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
export function DecisionCard({ decision, actions, focused = false }: { decision: ReadDecision; actions: DecisionCardActions; /** The link that brought the person here named this card: it scrolls into view and is marked. */ focused?: boolean }) {
 const { card, tabs, details, digest } = decision, host = useAppHost();
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [opened, setOpened] = useState<Record<string, string>>({}), [tab, setTab] = useState<DecisionTabId>("requirements");
 const [note, setNote] = useState<ReactNode>(null), [confirming, setConfirming] = useState<Confirming>(), [reason, setReason] = useState("");
 const touch = useRef<{ x: number; y: number } | undefined>(undefined), article = useRef<HTMLElement>(null), [signIn, setSignIn] = useState(false);
 useEffect(() => { if (focused) article.current?.scrollIntoView?.({ block: "center" }); }, [focused]);
 const inline = card.kind === "approve_design" && card.risk === "high" && actions.highRisk !== undefined;
 const eligibility = useQuery({ queryKey: ["design-approval", card.id, digest], queryFn: () => actions.highRisk!.read(), enabled: inline, retry: false, refetchOnWindowFocus: false });
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
  setBusy(true);setError(undefined);setNote(null);setConfirming(undefined);
  try { await work(); } catch (failure) {
   if (failure instanceof ApiError && failure.code === "CHANGE_STALE") { setOpened({});actions.onStale();setError(failure.message); }
   else setError(failure instanceof Error && failure.message !== "" ? failure.message : "Couldn't complete this. Try again.");
  } finally { setBusy(false); }
 }
 const settle = (result: DecisionResult) => {
  if (result.kind === "decided") return;
  // A merge always asks once more, naming what it merges and where (WEB-1); only Confirm goes on to the confirmation page.
  if (result.confirmUrl !== undefined && result.merging !== undefined && result.merging.length > 0) { setConfirming({ url: result.confirmUrl, merging: result.merging });return; }
  if (result.confirmUrl !== undefined) { const url = result.confirmUrl;setNote(<p role="status">Nothing is decided yet. <Button variant="quiet" onClick={() => host.openExternal(url)}>Confirm on the next page</Button></p>); }
  else setNote(<p role="status">Nothing is decided yet. Open the decision to confirm it.</p>);
 };
 const open = (which: DecisionTabId | undefined) => run(async () => { await actions.onOpenEvidence(which);setOpened(current => ({ ...current, [which ?? "card"]: digest })); });
 /** An approve_design card with an open blocker asks for one plain line before it approves (owner Q8). On a card with tabs the line belongs to the design tab. */
 const blockers = (which: DecisionTabId | undefined) => card.kind === "approve_design" || which === "design" ? openBlockersOnCard(which === undefined ? card.evidence : tabs?.find(item => item.id === which)?.evidence ?? card.evidence) : 0;
 const reasonOf = (which: DecisionTabId | undefined) => blockers(which) > 0 ? cleanApproveReason(reason) : undefined;
 const approve = (which: DecisionTabId | undefined) => run(async () => { settle(await actions.onApprove(which, reasonOf(which))); });
 /** The inline Approve of a high-risk design: read what the server shows now, stop if it is not what this person was shown, then press with that digest. A missing recent sign-in is said on the card, with a way to sign in again. */
 const approveInline = () => run(async () => {
  const high = actions.highRisk!;
  setSignIn(false);
  const now = await high.read();
  if (now.digest !== digest) { setOpened({});actions.onStale();setError(CHANGED_WORDS);return; }
  try { await high.approve(digest, reasonOf(undefined));setNote(<p role="status">Approved. Rovara goes on from here.</p>); }
  catch (failure) {
   if (failure instanceof ApiError && failure.code === "REAUTH_REQUIRED") { setSignIn(true);setError(failure.message);return; }
   throw failure;
  }
 });
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
 const reasonField = (which: DecisionTabId | undefined) => (canApprove || (inline && eligibility.data?.mayApprove === true)) && blockers(which) > 0 && <div className="rv-decision-reason"><label htmlFor={"reason-" + card.id}>Why approve with an open blocker?</label><input id={"reason-" + card.id} type="text" maxLength={200} value={reason} onChange={event => setReason(event.target.value)} aria-describedby={"reason-hint-" + card.id} /><p id={"reason-hint-" + card.id} className="rv-muted">{APPROVE_REASON_HINT}</p></div>;
 const approveButton = (which: DecisionTabId | undefined) => canApprove && <>{reasonField(which)}<Button variant="primary" busy={busy} disabled={(needsEvidence && !isOpened(which)) || designBlocked(which) || (blockers(which) > 0 && reasonOf(which) === undefined)} onClick={() => { void approve(which); }}>{which === undefined ? (blockers(which) > 0 ? "Approve with a reason" : "Approve") : "Approve " + (which === "requirements" ? "requirements" : "design")}</Button></>;
 const choices = card.kind === "approve_spend" && card.risk !== "high" && actions.onChoose !== undefined ? card.actions.filter(action => spendChoiceOf(card, action) !== undefined) : [];
 const choiceButtons = choices.map(action => <Button key={action.href} variant={action.kind === card.recommended.action ? "primary" : "secondary"} busy={busy} disabled={needsEvidence && !isOpened(undefined)} onClick={() => { void run(async () => { await actions.onChoose!(action);setNote(<p role="status">Done. Rovara goes on from here.</p>); }); }}><VisibleText text={action.label} /></Button>);
 const design = card.kind === "approve_plan" ? actions.design : undefined;
 const designBox = design !== undefined && <div className="rv-decision-design">{design.hint && <p className="rv-design-hint" role="status">This may need design review.</p>}<Button busy={busy} onClick={() => { void run(async () => { await design.onDesignFirst();setNote(<p role="status">Asked for design review first. Rovara reviews the design before it builds.</p>); }); }}>Design first</Button></div>;
 const confirmPage = target?.kind === "external";
 /** What a high-risk design card offers in place of the link to itself: Approve for the person who may, who can for everyone else. */
 const inlineActions = !inline ? null : eligibility.isPending ? <p className="rv-muted" role="status">Checking who can approve this design.</p>
  : eligibility.data === undefined ? <p role="alert">Couldn't check who can approve this design. <Button variant="quiet" onClick={() => { void eligibility.refetch(); }}>Try again</Button></p>
  : eligibility.data.mayApprove ? <>{reasonField(undefined)}<Button variant="primary" busy={busy} disabled={blockers(undefined) > 0 && reasonOf(undefined) === undefined} onClick={() => { void approveInline(); }}>{blockers(undefined) > 0 ? "Approve design with a reason" : "Approve design"}</Button>{signIn && <Button onClick={() => host.signIn(host.currentPath())}>Sign in again to approve</Button>}</>
  : <p className="rv-muted">{eligibility.data.approverName === undefined ? "Someone else has to approve this design." : <><VisibleText text={eligibility.data.approverName} /> can approve this design.</>}</p>;
 return <article ref={article} id={decisionElementId(card.id)} className="rv-decision" data-risk={card.risk} data-focused={focused ? "true" : undefined} aria-label={card.title} {...swipe}>
  <header><h2><VisibleText text={card.title} /></h2><p className="rv-decision-risk">{RISK_WORDS[card.risk] ?? "Risk unknown"}</p></header>
  <p className="rv-decision-question"><VisibleText text={card.question} /></p>
  <p className="rv-decision-recommended">Recommended: <VisibleText text={card.recommended.action + ". " + card.recommended.why} /></p>
  <p className="rv-decision-next">Next: <VisibleText text={card.next.text} /></p>
  {tabs === undefined ? <Chips chips={card.evidence} /> : <Tabs label={"Documents to approve for " + card.title} value={tab} onValueChange={value => { if (value === "requirements" || value === "design") setTab(value); }} items={tabs.map(item => ({ value: item.id, label: item.title + (item.approved ? " (approved)" : ""), content: <><Chips chips={item.evidence} />{needsEvidence && evidencePanel(item.id)}</> }))} />}
  {tabs === undefined && needsEvidence && evidencePanel(undefined)}
  {card.risk === "high" && <p className="rv-decision-high">{inline ? HIGH_RISK_NOTE : confirmPage ? "This decision is made on its own page, after you sign in again." : "This decision is made on its own page."}</p>}
  <div className="rv-decision-actions">
   {card.risk === "high" ? <>{inline ? inlineActions : link}{designBox}</> : <>{approveButton(activeTab)}{choiceButtons}{designBox}{canReject && <details className="rv-decision-reject"><summary>Not now</summary><ul>{DECISION_REJECT_REASONS.filter(reason => card.rejectReasons.includes(reason)).map(reason => <li key={reason}><Button variant="quiet" busy={busy} onClick={() => { void run(async () => { settle(await actions.onReject(reason)); }); }}>{REASON_WORDS[reason]}</Button></li>)}</ul></details>}{needsEvidence ? null : link}</>}
  </div>
  {confirming && <div role="group" aria-label="Confirm merge" className="rv-decision-confirm"><p><VisibleText text={mergeQuestion(confirming.merging)} /></p>
   <div className="rv-actions"><Button variant="primary" onClick={() => { const url = confirming.url;setConfirming(undefined);setNote(<p role="status">Nothing is merged until you confirm on the next page.</p>);host.openExternal(url); }}>Confirm</Button><Button onClick={() => { setConfirming(undefined);setNote(<p role="status">Nothing was merged.</p>); }}>Cancel</Button></div></div>}
  {note}
  {error && <p role="alert"><VisibleText text={error} /></p>}
 </article>;
}
