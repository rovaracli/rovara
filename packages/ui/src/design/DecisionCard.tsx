import { useTaskPagePolicy } from "../screens/session/task-page-policy.js";
import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { Link } from "react-router";
import { DECISION_CHANGES_REASON_MAX, DECISION_LABELS, DECISION_REJECT_REASONS, type DecisionRejectReason, type DecisionTabId } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { ApiError } from "../api/errors.js";
import { decisionOpenTarget, mayApproveHere, mayRequestChangesHere, type DecisionResult, type ReadDecision } from "../api/decisions.js";
import { approveExtras, approveWaitsForLimit, cleanChangesReason, initialPick, requestChangesCommentIds, runLimitOf, type ApproveExtras, type PlanPick } from "../api/plan-pick.js";
import { PlanChoices } from "./PlanChoices.js";
import { APPROVE_REASON_HINT, cleanApproveReason, openBlockersOnCard } from "./design-review-card.js";
import { Button } from "./Button.js";
import { DecisionFrame } from "./DecisionFrame.js";
import { Tabs } from "./Tabs.js";
import { EvalResult, type EvalResultProps } from "./EvalResult.js";
import { VisibleText } from "./VisibleText.js";
import { PlanFeatureLine } from "./PlanFeatureLine.js";
import { HeldState } from "./HeldState.js";
import { TaskMark } from "../screens/session/task-marks.js";
import { useRegisterTaskPlanNoteSlot, useRegisterTaskChip } from "../screens/session/task-slots.js";
import { TalkLadder } from "../screens/session/TalkParts.js";
import { clockTime } from "../screens/session/task-time.js";
import { PlanChangeTable, type PlanChangeFrameFacts } from "../screens/session/PlanChangeFrame.js";
import { useBelowTheFold } from "../screens/session/below-the-fold.js";

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
 onApprove(tab?: DecisionTabId, reason?: string, extras?: ApproveExtras): Promise<DecisionResult>;
 /** Checks a previously unknown approval with a later read and never sends another write. */
 onCheckApproval?(): Promise<"resolved" | "same_pending" | "changed_pending" | "unknown">;
 onHasUnknownApproval?(): Promise<boolean>;
 /** The current identity read was refused; write controls stay hidden across card remounts. */
 onAuthorityRefused?(): boolean;
 onApprovalStorageChange?(key: string): Promise<boolean | undefined>;
 /** Request changes on a plan, requirements or design card: the reason and the open comments sent back (absent where the page cannot send it). */
 onRequestChanges?(reason: string, includedCommentIds?: readonly string[]): Promise<DecisionResult>;
 onReject(reason: DecisionRejectReason): Promise<DecisionResult>;
 /** The server said what was shown is out of date: load the cards again. */
 onStale(): void;
 /** A choice on a design review's cost card (raise the limit, run a lower tier, run it unpriced, skip): the card's own action. */
 onChoose?(action: ReadDecision["card"]["actions"][number]): Promise<void>;
 /** On an approve_plan card: the Design first action and whether the task's plan may need design (a hint, never automatic: owner Q4). */
 design?: { hint: boolean; onDesignFirst(): Promise<void> };
}

/**
 * What the Work page's task pane adds to a card (Hybrid 1): with it the card is drawn as "Your decision" (a summary, the facts as label and value lines, the card's own
 * action words), never as a Home card. `answers` are the options of the question the card asks (answered by `onAnswer`); `evalResult` is the failed eval of a
 * check that failed twice; `quickChange` shows the "Merge by itself" box, which waits for a route on Code and so is shown off.
 */
export interface DecisionPane {
 answers?: { options: ReadonlyArray<{ id: string; label: string }>; onAnswer(optionId: string): Promise<void> } | undefined;
 evalResult?: EvalResultProps | undefined;
 quickChange?: boolean | undefined;
 /** The plan's own one-line outcome (the task page draws it as the plan decision's lead). */
 outcome?: string | undefined;
 /** A plan card beside a delivered instruction: the page draws the plan-change frame (what changed is held; only served facts are shown). */
 planChange?: PlanChangeFrameFacts | undefined;
}
const PANE_HEADINGS: Record<string, string> = { answer_question: "Question for you", choose_checks: "A check failed twice", approve_spend: "Spend request" };

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
export function DecisionCard({ decision, actions, pane }: { decision: ReadDecision; actions: DecisionCardActions; pane?: DecisionPane | undefined }) {
 const page = useTaskPagePolicy();
 const { card, tabs, details, digest } = decision, host = useAppHost(), actionsRef = useRef(actions);
 useEffect(() => { actionsRef.current = actions; }, [actions]);
 const registerPlanNote = useRegisterTaskPlanNoteSlot();
 const [actionRow, setActionRow] = useState<HTMLElement | null>(null);
 const rowBelowFold = useBelowTheFold(actionRow);
 const registerChip = useRegisterTaskChip();
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [approvalUnknown, setApprovalUnknown] = useState(false), [authorityRefused, setAuthorityRefused] = useState(() => actions.onAuthorityRefused?.() === true), [opened, setOpened] = useState<Record<string, string>>({}), [tab, setTab] = useState<DecisionTabId>("requirements");
 const [note, setNote] = useState<ReactNode>(null), [confirming, setConfirming] = useState<Confirming>(), [reason, setReason] = useState(""), [changes, setChanges] = useState("");
 useEffect(() => {
  let active = true;
  void actionsRef.current.onHasUnknownApproval?.().then(value => { if (active) { setApprovalUnknown(value);setError(value ? "Rovara didn't confirm this yet. Check this decision before trying again." : undefined); } }).catch(() => undefined);
  const onStorage = (event: StorageEvent) => {
   if (event.key === null || !event.key.startsWith("rv:decision-approval:")) return;
   void actionsRef.current.onApprovalStorageChange?.(event.key).then(value => {
    if (!active || value === undefined) return;
    setApprovalUnknown(value);
    setError(value ? "Rovara didn't confirm this yet. Check this decision before trying again." : undefined);
   }).catch(() => undefined);
  };
  const onTaskAction = () => { void actionsRef.current.onHasUnknownApproval?.().then(value => { if (active) setApprovalUnknown(value); }).catch(() => undefined); };
  window.addEventListener("rovara-task-action", onTaskAction);
  const onAuthorityRefused = () => { if (actionsRef.current.onAuthorityRefused?.() === true) setAuthorityRefused(true); };
  window.addEventListener("storage", onStorage);
  window.addEventListener("rovara:decision-authority-refused", onAuthorityRefused);
  return () => { active = false;window.removeEventListener("rovara-task-action", onTaskAction);window.removeEventListener("storage", onStorage);window.removeEventListener("rovara:decision-authority-refused", onAuthorityRefused); };
 }, [card.id]);
 // What the person picked on a plan card belongs to the digest it was picked on: a changed card starts again from Rovara's recommendations.
 const [picked, setPicked] = useState<{ digest: string; pick: PlanPick }>(() => ({ digest, pick: initialPick(decision.choices) }));
 const pick = picked.digest === digest ? picked.pick : initialPick(decision.choices);
 const setPick = (next: PlanPick) => setPicked({ digest, pick: next });
 const sentUnconfirmed = approvalUnknown && card.kind === "approve_plan" && page !== undefined;
 // A plan approval that was sent but not confirmed is not "Needs you" any more: the page header says Checking while the card is the receipt.
 useEffect(() => { if (!sentUnconfirmed || registerChip === undefined) return;registerChip("checking");return () => { registerChip(undefined); }; }, [sentUnconfirmed, registerChip]);
 const touch = useRef<{ x: number; y: number } | undefined>(undefined);
 const target = decisionOpenTarget(card, host.origin);
 const canApprove = mayApproveHere(card);
 const planExtras = decision.choices !== undefined || runLimitOf(card) !== undefined;
 const canRequestChanges = mayRequestChangesHere(card) && actions.onRequestChanges !== undefined;
 const canReject = card.actions.some(action => action.kind === "reject") && card.risk !== "high" && (page === undefined || card.kind === "fix_setup");
 const needsEvidence = card.friction.expandEvidenceFirst && card.risk === "medium" && !decision.detailsUnreadable;
 const evidenceError = decision.detailsUnreadable && <p role="alert">The exact test evidence could not be read. Refresh before marking tests as already failing.</p>;
 const activeTab = tabs === undefined ? undefined : tab;
 // The requirements are approved before the design: the design tab's Approve waits for them.
 const designBlocked = (which: DecisionTabId | undefined) => which === "design" && tabs?.some(item => item.id === "requirements" && !item.approved) === true;
 const isOpened = (which: DecisionTabId | undefined) => opened[which ?? "card"] === digest;
 async function run(work: () => Promise<void>) {
  if (busy) return;
  setBusy(true);setError(undefined);setNote(null);setConfirming(undefined);
  try { await work(); } catch (failure) {
  if (failure instanceof ApiError && failure.code === "APPROVAL_UNKNOWN") { setApprovalUnknown(true);setError(failure.message); }
  else if (failure instanceof ApiError && failure.code === "IDENTITY_UNREAD") { setAuthorityRefused(true);setError(failure.message); }
   else if (failure instanceof ApiError && failure.code === "CHANGE_STALE") { setOpened({});actions.onStale();setError(failure.message); }
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
 const approve = (which: DecisionTabId | undefined) => run(async () => {
  // The plan fields go only when there are some (so a plain card's approve is exactly what it was).
  const extras = planExtras ? approveExtras(card, decision.choices, pick) : {};
  settle(Object.keys(extras).length === 0 ? await actions.onApprove(which, reasonOf(which)) : await actions.onApprove(which, reasonOf(which), extras));
 });
 const checkApproval = () => run(async () => {
  if (actions.onCheckApproval === undefined) throw new ApiError(409, "APPROVAL_UNKNOWN", "The earlier approval remains locked. Try Check again.");
  const result = await actions.onCheckApproval();
  if (result === "same_pending") throw new ApiError(409, "APPROVAL_UNKNOWN", "This decision still reads as pending. The earlier approval remains locked.");
  if (result === "changed_pending") throw new ApiError(409, "APPROVAL_UNKNOWN", "The decision changed and still reads as pending. The earlier approval remains locked.");
  if (result === "unknown") throw new ApiError(409, "APPROVAL_UNKNOWN", "Rovara couldn't confirm the earlier approval. It remains locked.");
  setApprovalUnknown(false);setNote(<p role="status">Rovara's latest read shows this decision is no longer pending.</p>);
 });
 const sendBack = () => run(async () => {
  const reasonText = cleanChangesReason(changes);
  if (reasonText === undefined || actions.onRequestChanges === undefined) return;
  const ids = requestChangesCommentIds(decision.choices, pick, card);
  const result = await (ids === undefined ? actions.onRequestChanges(reasonText) : actions.onRequestChanges(reasonText, ids));
  if (result.kind === "decided") { setChanges("");setNote(<p role="status">Sent back for changes. Rovara goes on from here.</p>); } else settle(result);
 });
 const rejectControl = canReject && !authorityRefused && <details className="rv-decision-reject"><summary>Not now</summary><ul>{DECISION_REJECT_REASONS.filter(reason => card.rejectReasons.includes(reason)).map(reason => <li key={reason}><Button variant="quiet" busy={busy} disabled={approvalUnknown} onClick={() => { void run(async () => { settle(await actions.onReject(reason)); }); }}>{REASON_WORDS[reason]}</Button></li>)}</ul></details>;
 const changesBox = !authorityRefused && canRequestChanges && <details className="rv-decision-changes"><summary>{DECISION_LABELS.requestChanges}</summary>
  <label htmlFor={"changes-" + card.id}>What should change?</label><textarea id={"changes-" + card.id} rows={3} maxLength={DECISION_CHANGES_REASON_MAX} value={changes} onChange={event => setChanges(event.target.value)} />
  <Button busy={busy} disabled={approvalUnknown || cleanChangesReason(changes) === undefined} onClick={() => { void sendBack(); }}>Send back for changes</Button></details>;
 const link: ReactNode = target === undefined ? null : target.kind === "internal" ? <Link className="rv-decision-open" to={target.to}>{card.risk === "high" ? "Open to decide" : "Open the details"}</Link> : <Button variant="quiet" onClick={() => host.openExternal(target.href)}>{card.risk === "high" ? "Open to decide" : "Open the details"}</Button>;
 const swipe = card.risk === "low" && canApprove && tabs === undefined && !planExtras && !decision.choicesUnreadable ? {
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
 const reasonField = (which: DecisionTabId | undefined) => canApprove && blockers(which) > 0 && <div className="rv-decision-reason"><label htmlFor={"reason-" + card.id}>Why approve with an open blocker?</label><input id={"reason-" + card.id} type="text" maxLength={200} value={reason} onChange={event => setReason(event.target.value)} aria-describedby={"reason-hint-" + card.id} /><p id={"reason-hint-" + card.id} className="rv-muted">{APPROVE_REASON_HINT}</p></div>;
 const approvalLockReason = (which: DecisionTabId | undefined) => needsEvidence && !isOpened(which) ? "Open the evidence for this version before approving."
  : designBlocked(which) ? "Approve the requirements before approving the design."
  : approveWaitsForLimit(card, pick) ? "Agree to the shown run limit before approving."
  : blockers(which) > 0 && reasonOf(which) === undefined ? "Give a reason before approving with an open blocker." : undefined;
 // The Approve control exists in two places on the task page: in the action row (after the choices) and in a bar pinned to the bottom of the page on a desktop, while the row is out of view.
 // Both are drawn by approveControl from ONE guard and ONE handler, so what they say, whether they are locked and what they do can never differ.
 const approveGuard = (which: DecisionTabId | undefined): { disabled: boolean; lockedReason?: string } => {
  const lockedReason = approvalLockReason(which);
  return { disabled: (needsEvidence && !isOpened(which)) || designBlocked(which) || approveWaitsForLimit(card, pick) || (blockers(which) > 0 && reasonOf(which) === undefined), ...(lockedReason === undefined ? {} : { lockedReason }) };
 };
 const approveWords = (which: DecisionTabId | undefined) => which === undefined ? (blockers(which) > 0 ? "Approve with a reason" : pane !== undefined ? card.actions.find(action => action.kind === "approve")?.label ?? "Approve" : "Approve") : "Approve " + (which === "requirements" ? "requirements" : "design");
 const approveControl = (which: DecisionTabId | undefined, pinned: boolean) => {
  const guard = approveGuard(which);
  return <Button variant="primary" busy={busy} {...(pinned ? { "data-approve-pinned": "true" } : {})} {...(guard.lockedReason === undefined ? {} : { lockedReason: guard.lockedReason })} aria-describedby={approveWaitsForLimit(card, pick) ? "limit-hint-" + card.id.replace(/[^A-Za-z0-9_-]/gu, "_") : undefined} disabled={guard.disabled} onClick={() => { void approve(which); }}>{approveWords(which)}</Button>;
 };
 const approveButton = (which: DecisionTabId | undefined) => canApprove && !approvalUnknown && !authorityRefused && <>{reasonField(which)}{approveControl(which, false)}</>;
 const pinnedApprove = page !== undefined && pane !== undefined && card.kind === "approve_plan" && card.risk !== "high" && canApprove && !approvalUnknown && !authorityRefused && rowBelowFold ? <div className="rv-approve-pinned" role="group" aria-label="Approve, pinned to the bottom of the page" data-testid="approve-pinned">{approveControl(activeTab, true)}</div> : null;
 // Design-spend choices have no Cloud route; never offer a sender, even when a card advertises one.
 const design = card.kind === "approve_plan" ? actions.design : undefined;
 const designBox = page === undefined && !authorityRefused && design !== undefined && <div className="rv-decision-design">{design.hint && <p className="rv-design-hint" role="status">This may need design review.</p>}<Button busy={busy} disabled={approvalUnknown} onClick={() => { void run(async () => { await design.onDesignFirst();setNote(<p role="status">Asked for design review first. Rovara reviews the design before it builds.</p>); }); }}>Design first</Button></div>;
 if (pane !== undefined) {
  const heading = card.kind === "approve_plan" ? (card.actions.find(action => action.kind === "approve")?.label ?? "Approve plan") + "?" : PANE_HEADINGS[card.kind] ?? "Your decision", facts = [...card.evidence.map(chip => [chip.label, chip.value + (STATE_WORDS[chip.state] ?? "")] as const), ["Risk", (RISK_WORDS[card.risk] ?? "Risk unknown") + (card.riskReasons.length > 0 ? " · " + card.riskReasons.join(", ") : "")] as const, ["Next", card.next.text] as const];
  const taskPlan = page !== undefined && card.kind === "approve_plan";
  const answers = pane.answers, bad = card.kind === "choose_checks" || card.kind === "approve_spend" ? "bad" : undefined;
  const answerButtons = answers !== undefined && answers.options.map(option => <Button key={option.id} busy={busy} disabled={approvalUnknown} onClick={() => { void run(async () => { await answers.onAnswer(option.id);setNote(<p role="status">Answer saved. Rovara goes on from here.</p>); }); }}>{option.label}</Button>);
  if (taskPlan && approvalUnknown && tabs === undefined && !authorityRefused) {
   const named = heading.replace(/^Approve /u, "").replace(/\?$/u, "");
   return <DecisionFrame as="section" headingLevel={3} title={named.charAt(0).toUpperCase() + named.slice(1) + " approval sent"} aria-label="Your decision" aria-labelledby={undefined} actions={null} className="rv-decision rv-decision-pane rv-decision-scene-plan rv-ds-plan-frame rv-approval-receipt" data-risk={card.risk} data-kind={card.kind}>
    <div className="rv-plan-note-slot" ref={registerPlanNote} />
    {error !== undefined && <p role="alert" data-testid="decision-error" className="rv-approval-receipt-lead"><VisibleText text={error} /></p>}
    <TalkLadder steps={[{ state: "ok", label: "Approval sent", detail: "from this browser" }, { state: "pending", label: "Recorded by Rovara", unknown: true }, { state: "pending", label: "Build starting", unknown: true }]} />
    <div className="rv-decision-actions-above"><div className="rv-decision-actions"><Button variant="primary" busy={busy} onClick={() => { void checkApproval(); }}>Check</Button></div></div>
    {note}
   </DecisionFrame>;
  }
  if (taskPlan && pane.planChange !== undefined && tabs === undefined && !approvalUnknown) {
   const change = pane.planChange;
   return <DecisionFrame as="section" headingLevel={3} title="Plan change needs approval" aria-label="Your decision" aria-labelledby={undefined} actions={null} className="rv-decision rv-decision-pane rv-decision-scene-plan rv-plan-change" data-risk={card.risk} data-kind={card.kind} {...swipe}>
    <div className="rv-plan-note-slot" ref={registerPlanNote} />
    {change.instruction !== undefined && <p className="rv-plan-change-source"><VisibleText text={change.instruction.name + "'s instruction" + (clockTime(change.instruction.at) === undefined ? "" : " at " + clockTime(change.instruction.at)!) + ": \u201c" + change.instruction.text + "\u201d was delivered."} /></p>}
    <div className="rv-plan-change-callout"><TaskMark kind="pause" /><p><strong>Rovara is waiting for your decision.</strong> Nothing in the proposed plan starts until it is approved.</p></div>
    <PlanChangeTable facts={change} />
    {card.risk === "high" ? <div className="rv-decision-actions">{link}{designBox}</div> : <div className="rv-decision-actions">
     {approveButton(activeTab)}
     {!authorityRefused && <><Button disabled title="Not available yet">Keep the earlier plan</Button></>}
     {changesBox}{needsEvidence ? null : link}{designBox}
    </div>}
    {card.risk !== "high" && <PlanChoices decision={decision} pick={pick} onPick={setPick} disabled={busy} />}
    <p className="rv-plan-change-foot">Only people who can approve plans on this task can decide. Replying "yes" in Talk or in Slack does not approve a plan.</p>
    {confirming && <div role="group" aria-label="Confirm merge" className="rv-decision-confirm"><p><VisibleText text={mergeQuestion(confirming.merging)} /></p>
     <div className="rv-actions"><Button variant="primary" onClick={() => { const url = confirming.url;setConfirming(undefined);setNote(<p role="status">Nothing is merged until you confirm on the next page.</p>);host.openExternal(url); }}>Confirm</Button><Button onClick={() => { setConfirming(undefined);setNote(<p role="status">Nothing was merged.</p>); }}>Cancel</Button></div></div>}
    {evidenceError}
    {note}
    {error && <p role="alert" data-testid="decision-error"><VisibleText text={error} /></p>}
   </DecisionFrame>;
  }
  return <DecisionFrame as="section" headingLevel={3} title={heading} aria-label={PANE_HEADINGS[card.kind] ?? "Your decision"} aria-labelledby={undefined} actions={null} className={"rv-decision rv-decision-pane" + (taskPlan ? " rv-decision-scene-plan rv-ds-plan-frame" : "")} data-risk={card.risk} data-kind={card.kind} data-tone={bad} {...swipe}>
   {taskPlan ? <>
    <div className="rv-plan-note-slot" ref={registerPlanNote} />
    {pane.outcome !== undefined && <p className="rv-ds-lead rv-decision-outcome"><strong>Outcome:</strong> <VisibleText text={pane.outcome} /></p>}
   </> : <p className="rv-decision-summary"><VisibleText text={card.question} /></p>}
   {taskPlan && card.riskReasons.length > 0 && <><h4>Risks to know before you decide</h4><ul className="rv-ds-risks">{card.riskReasons.map((reason, index) => <li key={index}><TaskMark kind="attention" /><span><VisibleText text={reason} /></span></li>)}</ul></>}
   {card.kind === "approve_plan" && card.planFeature !== undefined && <PlanFeatureLine card={card} />}
   {pane.evalResult !== undefined && <EvalResult {...pane.evalResult} failed />}
   {taskPlan && tabs === undefined && <div className="rv-ds-plan-step"><span className="rv-ds-step-number">1</span><strong>Review the plan</strong><span className="rv-muted rv-plan-risk">{RISK_WORDS[card.risk] ?? "Risk unknown"}</span><span className="rv-ds-meta rv-plan-read">Read by you <HeldState /></span></div>}
   {tabs === undefined ? taskPlan ? <ul className="rv-ds-evidence rv-decision-facts">{facts.filter(([label]) => label !== "Risk").map(([label, value], index) => <li key={index}><span>{label}</span><span className="rv-ds-meta"><VisibleText text={value} /></span></li>)}</ul> : <dl className="rv-kv-list">{facts.map(([label, value], index) => <div key={index} className="rv-kv"><dt><VisibleText text={label} /></dt><dd><VisibleText text={value} /></dd></div>)}</dl>
    : <Tabs label={"Documents to approve for " + card.title} value={tab} onValueChange={value => { if (value === "requirements" || value === "design") setTab(value); }} items={tabs.map(item => ({ value: item.id, label: item.title + (item.approved ? " (approved)" : ""), content: <><Chips chips={item.evidence} />{needsEvidence && evidencePanel(item.id)}</> }))} />}
   {tabs === undefined && needsEvidence && evidencePanel(undefined)}
   {taskPlan && tabs === undefined && <div className="rv-ds-plan-step"><span className="rv-ds-step-number">2</span><strong>{heading.replace(/\?$/u, "")}</strong>{approvalLockReason(undefined) !== undefined && <span className="rv-ds-meta rv-ds-plan-lock"><TaskMark kind="lock" />{approvalLockReason(undefined)}</span>}</div>}
   {card.risk !== "high" && <PlanChoices decision={decision} pick={pick} onPick={setPick} disabled={busy} />}
   {taskPlan && <div className="rv-decision-actions-above" ref={setActionRow}>
   <div className="rv-decision-actions">
    {card.risk === "high" ? <>{link}{designBox}</> : <>{approvalUnknown && <Button variant="primary" busy={busy} onClick={() => { void checkApproval(); }}>Check</Button>}{!authorityRefused && answerButtons}{approveButton(activeTab)}{needsEvidence ? null : link}{changesBox}{designBox}{rejectControl}</>}
   </div>
   </div>}
   {pane.quickChange === true && canApprove && <label className="rv-merge-when-ready"><input type="checkbox" disabled aria-describedby={"merge-self-" + card.id} /><span id={"merge-self-" + card.id}>Merge by itself once the proof passes and a reviewer approves (not connected yet)</span></label>}
   {card.risk === "high" && <p className="rv-decision-high">This decision is made on its own page.</p>}
   {approvalUnknown && !taskPlan && <Button variant="secondary" busy={busy} onClick={() => { void checkApproval(); }}>Check</Button>}
   {!taskPlan && (<>
   <div className="rv-decision-actions">
    {card.risk === "high" ? <>{link}{designBox}</> : <>{!authorityRefused && answerButtons}{approveButton(activeTab)}{needsEvidence ? null : link}{changesBox}{designBox}{rejectControl}</>}
   </div>
   </>)}
   {confirming && <div role="group" aria-label="Confirm merge" className="rv-decision-confirm"><p><VisibleText text={mergeQuestion(confirming.merging)} /></p>
    <div className="rv-actions"><Button variant="primary" onClick={() => { const url = confirming.url;setConfirming(undefined);setNote(<p role="status">Nothing is merged until you confirm on the next page.</p>);host.openExternal(url); }}>Confirm</Button><Button onClick={() => { setConfirming(undefined);setNote(<p role="status">Nothing was merged.</p>); }}>Cancel</Button></div></div>}
   {evidenceError}
   {note}
   {error && <p role="alert" data-testid="decision-error"><VisibleText text={error} /></p>}
   {taskPlan && pinnedApprove}
  </DecisionFrame>;
 }
 return <DecisionFrame title={card.title} meta={RISK_WORDS[card.risk] ?? "Risk unknown"} actions={null} className="rv-decision" data-risk={card.risk} {...swipe}>
  <p className="rv-decision-question"><VisibleText text={card.question} /></p>
  <p className="rv-decision-recommended">Recommended: <VisibleText text={card.recommended.action + ". " + card.recommended.why} /></p>
  <p className="rv-decision-next">Next: <VisibleText text={card.next.text} /></p>
  {card.kind === "approve_plan" && card.planFeature !== undefined && <PlanFeatureLine card={card} />}
  {tabs === undefined ? <Chips chips={card.evidence} /> : <Tabs label={"Documents to approve for " + card.title} value={tab} onValueChange={value => { if (value === "requirements" || value === "design") setTab(value); }} items={tabs.map(item => ({ value: item.id, label: item.title + (item.approved ? " (approved)" : ""), content: <><Chips chips={item.evidence} />{needsEvidence && evidencePanel(item.id)}</> }))} />}
  {tabs === undefined && needsEvidence && evidencePanel(undefined)}
  {card.risk !== "high" && <PlanChoices decision={decision} pick={pick} onPick={setPick} disabled={busy} />}
  {card.risk === "high" && <p className="rv-decision-high">This decision is made on its own page.</p>}
  {approvalUnknown && <Button variant="secondary" busy={busy} onClick={() => { void checkApproval(); }}>Check</Button>}
  <div className="rv-decision-actions">
   {card.risk === "high" ? <>{link}{designBox}</> : <>{approveButton(activeTab)}{changesBox}{designBox}{rejectControl}{needsEvidence ? null : link}</>}
  </div>
  {confirming && <div role="group" aria-label="Confirm merge" className="rv-decision-confirm"><p><VisibleText text={mergeQuestion(confirming.merging)} /></p>
   <div className="rv-actions"><Button variant="primary" onClick={() => { const url = confirming.url;setConfirming(undefined);setNote(<p role="status">Nothing is merged until you confirm on the next page.</p>);host.openExternal(url); }}>Confirm</Button><Button onClick={() => { setConfirming(undefined);setNote(<p role="status">Nothing was merged.</p>); }}>Cancel</Button></div></div>}
  {evidenceError}
  {note}
  {error && <p role="alert"><VisibleText text={error} /></p>}
 </DecisionFrame>;
}
