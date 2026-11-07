import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { DECISION_APPROVE_TAKES, DECISION_LABELS, DECISION_REJECT_REASONS, decisionTaskSessionOf, type DecisionRejectReason, type DecisionTabId } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { ApiError } from "../api/errors.js";
import { HIGH_ON_CARD_KINDS, decisionOpenTarget, mayApproveHere, runLimitRaise, type DecisionResult, type PlanDecisionFields, type ReadDecision } from "../api/decisions.js";
import { usePlanChoices } from "./PlanChoices.js";
import { spendChoiceOf, type DesignApprovalRead } from "../api/design-review.js";
import { APPROVE_REASON_HINT, cleanApproveReason, openBlockersOnCard } from "./design-review-card.js";
import { Button } from "./Button.js";
import { Tabs } from "./Tabs.js";
import { Money } from "./Money.js";
import { VisibleText } from "./VisibleText.js";
import { PlanPanelSlot, usePanelDocument } from "../screens/session/plan-panel-host.js";
import { PANEL_DOCUMENT_WORDS, panelDocumentOfCard } from "../screens/session/panel-docs.js";

type Confirming = { url: string; merging: ReadonlyArray<{ repositoryId: string; number: number; baseBranch: string }> };
/** "Merge #7 into main?"; with several pull requests each is named by its repository: "Merge payments #7 into main and billing #8 into develop?". */
export function mergeQuestion(merging: Confirming["merging"]): string {
 const parts = merging.map(pull => (merging.length > 1 ? pull.repositoryId + " " : "") + "#" + String(pull.number) + " into " + pull.baseBranch);
 return "Merge " + (parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1]! : parts[0]!) + "? This can't be undone from Rovara.";
}
const RISK_WORDS: Record<string, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };
const STATE_WORDS: Record<string, string> = { good: "", warning: " (check this)", bad: " (problem)", unknown: "" };
const REASON_WORDS: Record<DecisionRejectReason, string> = { wrong_problem: "Wrong problem", wrong_approach: "Wrong approach", too_big: "Too big", missing_test: "Missing test", not_now: DECISION_LABELS.notNow, other: "Other" };
/** The session a page of the app shows (`/app/sessions/<id>` or `/s/<id>`), to tell a card's link to the page it is already on. */
const sessionOfPage = (pathname: string): string | undefined => /^\/(?:app\/sessions|s)\/(ses_[0-9a-z]{20})$/u.exec(pathname)?.[1];
/** A swipe right this far (and mostly sideways) approves a LOW card on a phone. The buttons always work; the swipe is a shortcut and never exists above low. */
export const SWIPE_APPROVE_PX = 120;

export interface DecisionCardActions {
 /** Records on the server that the evidence of what was SHOWN (the decision's digest) was opened; resolves when it is recorded. */
 onOpenEvidence(tab?: DecisionTabId): Promise<void>;
 /** `reason` is the one plain line an approve_design card with an open blocker asks for (owner Q8); it is sent only there. `acknowledgedRunLimitUsd` is a coding plan's ticked run limit (slice 2). */
 onApprove(tab?: DecisionTabId, reason?: string, acknowledgedRunLimitUsd?: number, /** OWNER DECISION 7: a requirements or coding plan card's answers, checks, comments and note. */ plan?: PlanDecisionFields): Promise<DecisionResult>;
 /** Slice 2: send the document back with the person's reason (requirements, a coding plan, a design). Absent: the card offers no Request changes. OWNER DECISION 7: with the open comments the person kept ticked. */
 onRequestChanges?(reason: string, includedCommentIds?: string[]): Promise<DecisionResult>;
 /** Slice 2: the design questions, answered on their card (the answer_question card on the task page), and Keep waiting for a parked review. */
 questions?: { items: ReadonlyArray<{ id: string; unclear: string; why: string; recommended: string; options: ReadonlyArray<{ id: string; label: string; consequence: string }> }>; parked: boolean; submit(answers: ReadonlyArray<{ questionId: string; optionId?: string; text?: string }>): Promise<void>; resume?(): Promise<void> };
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
 highRisk?: { read(): Promise<DesignApprovalRead>; approve(shownDigest: string, reason?: string, acknowledgedRunLimitUsd?: number, plan?: PlanDecisionFields): Promise<void | DecisionResult> };
 /** Slice 3b: Decline an outside approval on its card (with the same recent sign-in). */
 decline?(): Promise<void>;
}

const HIGH_RISK_NOTE = "High risk: approving needs a recent sign-in.";
const NO_CHOICES = { questions: [], optionalChecks: [], openComments: [] };
const CHANGED_WORDS = "This changed while you were looking. The card has the latest; check it and approve again.";
/** One plain line of at most `max` characters: what a reason field sends (the broker refuses control characters). */
const plainReason = (text: string, max = 500): string => text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
/** The Workspace tab where each document reads in full. */
const DOCUMENT_TAB: Record<string, { hash: string; words: string }> = { approve_plan: { hash: "#plan", words: "Read the plan" }, approve_requirements: { hash: "#plan", words: "Read the requirements" }, approve_design: { hash: "#design", words: "Read the design" } };
/** The element id of a decision card on a page (the card id has a colon). */
export const decisionElementId = (cardId: string): string => "decision-" + cardId.replace(/[^A-Za-z0-9_-]/gu, "-");

function Chips({ chips }: { chips: ReadDecision["card"]["evidence"] }) {
 return <dl className="rv-decision-evidence">{chips.map((chip, index) => <div key={index} data-state={chip.state}><dt><VisibleText text={chip.label} /></dt><dd><VisibleText text={chip.value + (STATE_WORDS[chip.state] ?? "")} /></dd></div>)}</dl>;
}

/**
 * One decision, with its evidence on the front. Friction follows the card's own flags, which the SERVER also enforces:
 * low: Approve is one tap (or a swipe on a phone); medium: Approve stays disabled until the evidence panel (the detail the front does not carry) was opened and the server recorded it for THIS digest;
 * high: no Approve at all, only "Open" (the card on its task page, or the confirmation page); on its task page a high design card is approved inline.
 * What was opened is remembered by digest, so a changed card must be opened again; a stale answer from the server clears it and loads the cards again.
 * Nothing here approves several cards: a card has one approve button (one per tab on a Full pair, each a separate approval).
 */
export function DecisionCard({ decision, actions, focused = false }: { decision: ReadDecision; actions: DecisionCardActions; /** The link that brought the person here named this card: it scrolls into view and is marked. */ focused?: boolean }) {
 const { card, tabs, details, digest } = decision, host = useAppHost(), location = useLocation();
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [opened, setOpened] = useState<Record<string, string>>({}), [tab, setTab] = useState<DecisionTabId>("requirements");
 const [note, setNote] = useState<ReactNode>(null), [confirming, setConfirming] = useState<Confirming>(), [reason, setReason] = useState("");
 const touch = useRef<{ x: number; y: number } | undefined>(undefined), article = useRef<HTMLElement>(null), [signIn, setSignIn] = useState<false | { url?: string }>(false);
 const [ticked, setTicked] = useState(false), [changes, setChanges] = useState(""), [answers, setAnswers] = useState<Record<string, { optionId?: string; text: string }>>({});
 useEffect(() => { if (focused) article.current?.scrollIntoView?.({ block: "center" }); }, [focused]);
 // OWNER DECISION 7: a requirements or coding plan card carries the document's questions, optional checks, open comments and a note (the old review page's dialog), shown where the card is decided.
 const planKind = card.kind === "approve_plan" || card.kind === "approve_requirements" || (card.kind === "approve_design" && decision.choices !== undefined);
 const plan = usePlanChoices(String(card.id), planKind ? decision.choices ?? NO_CHOICES : undefined);
 const inline = (card.kind === "approve_design" || HIGH_ON_CARD_KINDS.includes(card.kind)) && card.risk === "high" && actions.highRisk !== undefined;
 // A coding plan's run limit: shown on the card, and a raise is ticked here before Approve (the broker refuses a raise without it).
 const limit = runLimitRaise(card), limitBlocked = limit?.raises === true && !ticked, ack = limit?.proposedUsd;
 const eligibility = useQuery({ queryKey: ["design-approval", card.id, digest], queryFn: () => actions.highRisk!.read(), enabled: inline, retry: false, refetchOnWindowFocus: false });
 const target = decisionOpenTarget(card, host.origin);
 const canApprove = mayApproveHere(card);
 const canReject = card.actions.some(action => action.kind === "reject") && card.risk !== "high";
 // An outside approval's evidence is opened first where it is decided (security review: what its kind records as its page having been read), as a medium card's is.
 // A HIGH design cost card is decided on its task page (its choices behind the evidence, each under the decide-grade sign-in); elsewhere (Home) it is "Open".
 const highSpendHere = card.kind === "approve_spend" && card.risk === "high" && actions.onChoose !== undefined && target?.kind === "internal" && decisionTaskSessionOf(target.to) !== undefined && decisionTaskSessionOf(target.to) === sessionOfPage(location.pathname);
 const needsEvidence = (card.friction.expandEvidenceFirst && card.risk === "medium") || (card.kind === "approve_request" && actions.highRisk !== undefined) || highSpendHere;
 const activeTab = tabs === undefined ? undefined : tab;
 // The requirements are approved before the design: the design tab's Approve waits for them.
 const designBlocked = (which: DecisionTabId | undefined) => which === "design" && tabs?.some(item => item.id === "requirements" && !item.approved) === true;
 const isOpened = (which: DecisionTabId | undefined) => opened[which ?? "card"] === digest;
 async function run(work: () => Promise<void>) {
  if (busy) return;
  setBusy(true);setError(undefined);setNote(null);setConfirming(undefined);setSignIn(false);
  try { await work(); } catch (failure) {
   if (failure instanceof ApiError && failure.code === "CHANGE_STALE") { setOpened({});actions.onStale();setError(failure.message); }
   // A sign-in that is not recent enough is said on this card, with a way to sign in again and come back to it (never a separate page).
   // A high card with no approval of its own (a design, a requirements or coding plan) gets the decide sign-in made for it (`signInUrl`), which comes back to this card on the task page.
   else if (failure instanceof ApiError && failure.code === "REAUTH_REQUIRED") { setSignIn(failure.signInUrl === undefined ? {} : { url: failure.signInUrl });setError(failure.message); }
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
 const planFields = (): PlanDecisionFields | undefined => (planShown ? plan.fields() : undefined);
 const approve = (which: DecisionTabId | undefined) => run(async () => { const result = await actions.onApprove(which, reasonOf(which), ack, planFields());if (result.kind === "decided") plan.reset();settle(result); });
 /** The inline Approve of a high-risk design: read what the server shows now, stop if it is not what this person was shown, then press with that digest. A missing recent sign-in is said on the card, with a way to sign in again. */
 const approveInline = () => run(async () => {
  const high = actions.highRisk!;
  const now = await high.read();
  if (now.digest !== digest) { setOpened({});actions.onStale();setError(CHANGED_WORDS);return; }
  const result = await high.approve(digest, reasonOf(undefined), ack, planFields());
  // A high merge goes on as its approval card, decided there with the decide-grade sign-in.
  if (result !== undefined && result.kind === "needs_confirmation") { settle(result);return; }
  setNote(<p role="status">Approved. Rovara goes on from here.</p>);
 });
 // Whether this card is on its own task page. There everything is decided on the card: its link to the same page is left out (a high card that is not decided inline keeps it).
 const onItsPage = target?.kind === "internal" && decisionTaskSessionOf(target.to) !== undefined && decisionTaskSessionOf(target.to) === sessionOfPage(location.pathname);
 const here = onItsPage && (card.risk !== "high" || highSpendHere);
 // The choices are made where the card is decided: on its task page (a low card on Home approves with AgentX's answers and the open comments, as Slack's Approve does).
 const planShown = planKind && onItsPage && card.status === "pending";
 // Owner decision (a), slice 3: a medium card is decided on its own page (the task page's card), never where it is merely shown (Home): there it is the card's front and "Open", nothing to press.
 const openOnly = card.risk === "medium" && !onItsPage && target !== undefined;
 const link: ReactNode = target === undefined || here ? null : target.kind === "internal" ? <Link className="rv-decision-open" to={target.to}>{DECISION_LABELS.open}</Link> : <Button variant="quiet" onClick={() => host.openExternal(target.href)}>{DECISION_LABELS.open}</Button>;
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
   <summary>{needsEvidence ? DECISION_LABELS.showEvidence : DECISION_LABELS.moreEvidence}</summary>
   {groups.map((group, index) => <section key={index} aria-label={group.title}><h3>{group.title}</h3><ul>{group.lines.map((line, at) => <li key={at}><VisibleText text={line} /></li>)}</ul></section>)}
   {link}
  </details>;
 };
 const reasonField = (which: DecisionTabId | undefined) => (canApprove || (inline && eligibility.data?.mayApprove === true)) && blockers(which) > 0 && <div className="rv-decision-reason"><label htmlFor={"reason-" + card.id}>Why approve with an open blocker?</label><input id={"reason-" + card.id} type="text" maxLength={200} value={reason} onChange={event => setReason(event.target.value)} aria-describedby={"reason-hint-" + card.id} /><p id={"reason-hint-" + card.id} className="rv-muted">{APPROVE_REASON_HINT}</p></div>;
 const approveButton = (which: DecisionTabId | undefined) => canApprove && <>{reasonField(which)}<Button variant="primary" busy={busy} disabled={(needsEvidence && !isOpened(which)) || designBlocked(which) || (blockers(which) > 0 && reasonOf(which) === undefined) || limitBlocked} onClick={() => { void approve(which); }}>{which === undefined ? (blockers(which) > 0 ? DECISION_LABELS.approveWithReason : card.kind === "merge" ? DECISION_LABELS.merge : DECISION_LABELS.approve) : DECISION_LABELS.approve + " " + (which === "requirements" ? "requirements" : "design")}</Button></>;
 const choices = card.kind === "approve_spend" && (card.risk !== "high" || highSpendHere) && actions.onChoose !== undefined ? card.actions.filter(action => spendChoiceOf(card, action) !== undefined) : [];
 const choiceButtons = choices.map(action => <Button key={action.href} variant={action.kind === card.recommended.action ? "primary" : "secondary"} busy={busy} disabled={needsEvidence && !isOpened(undefined)} onClick={() => { void run(async () => { await actions.onChoose!(action);setNote(<p role="status">Done. Rovara goes on from here.</p>); }); }}><VisibleText text={action.label} /></Button>);
 const design = card.kind === "approve_plan" ? actions.design : undefined;
 const designBox = design !== undefined && <div className="rv-decision-design">{design.hint && <p className="rv-design-hint" role="status">This may need design review.</p>}<Button busy={busy} onClick={() => { void run(async () => { await design.onDesignFirst();setNote(<p role="status">Asked for design review first. Rovara reviews the design before it builds.</p>); }); }}>Design first</Button></div>;
 const confirmPage = target?.kind === "external";
 /** What a high-risk design card offers in place of the link to itself: Approve for the person who may, who can for everyone else. */
 const inlineActions = !inline ? null : eligibility.isPending ? <p className="rv-muted" role="status">Checking who can approve this design.</p>
  : eligibility.data === undefined ? <p role="alert">Couldn't check who can approve this design. <Button variant="quiet" onClick={() => { void eligibility.refetch(); }}>Try again</Button></p>
  : eligibility.data.mayApprove ? <>{reasonField(undefined)}<Button variant="primary" busy={busy} disabled={(blockers(undefined) > 0 && reasonOf(undefined) === undefined) || limitBlocked || (needsEvidence && !isOpened(undefined))} onClick={() => { void approveInline(); }}>{blockers(undefined) > 0 ? DECISION_LABELS.approveWithReason : DECISION_LABELS.approve}</Button>{actions.decline !== undefined && <Button busy={busy} onClick={() => { void run(async () => { await actions.decline!();setNote(<p role="status">Declined.</p>); }); }}>Decline</Button>}</>
  : <p className="rv-muted">{eligibility.data.approverName === undefined ? "Someone else has to approve this design." : <><VisibleText text={eligibility.data.approverName} /> can approve this design.</>}</p>;
 const limitBox = limit !== undefined && <div className="rv-decision-limit" role="group" aria-label="Run limit">
  <p>{limit.currentUsd === undefined ? <>No run limit yet → proposed limit <Money usd={limit.proposedUsd} /></> : <>Current limit <Money usd={limit.currentUsd} /> → proposed limit <Money usd={limit.proposedUsd} /></>}</p>
  {limit.raises && <p><input type="checkbox" id={"limit-" + card.id} checked={ticked} onChange={event => setTicked(event.target.checked)} /> <label htmlFor={"limit-" + card.id}>I agree to raise this task's run limit to <Money usd={limit.proposedUsd} /></label></p>}
 </div>;
 // Request changes (slice 2): a reason, then the press. Low risk wherever the card is shown; medium and high on the card's own task page.
 const changesShown = actions.onRequestChanges !== undefined && card.actions.some(action => action.kind === "request_changes") && (card.risk === "low" || onItsPage);
 const changesReason = plainReason(changes);
 const changesBox = changesShown && <details className="rv-decision-changes"><summary>{DECISION_LABELS.requestChanges}</summary>
  <label htmlFor={"changes-" + card.id}>What should change?</label><textarea id={"changes-" + card.id} maxLength={500} value={changes} onChange={event => setChanges(event.target.value)} />
  <Button busy={busy} disabled={changesReason === ""} onClick={() => { void run(async () => { const result = await actions.onRequestChanges!(changesReason, planShown ? plan.commentIds() : undefined);if (result.kind === "decided") { setChanges("");plan.reset();setNote(<p role="status">Sent back with your reason. Rovara revises it.</p>); } else settle(result); }); }}>{DECISION_LABELS.requestChanges}</Button>
 </details>;
 // OWNER DECISION 18: on its task page the card opens its document in full in the plan panel ("Read the full plan"); its Approve and Request changes then sit pinned at the panel's foot.
 const panelDocument = panelDocumentOfCard(card.kind, activeTab), panel = usePanelDocument();
 const panelHere = onItsPage && card.status === "pending" && panelDocument !== undefined && panel.open !== undefined && (panel.open === panelDocument || (tabs !== undefined && (panel.open === "requirements" || panel.open === "design")));
 useEffect(() => { if (panelHere && tabs !== undefined && (panel.open === "requirements" || panel.open === "design") && panel.open !== tab) setTab(panel.open); }, [panelHere, tabs, panel.open, tab]);
 // A medium card's evidence is the document: opening it in full records that it was opened, as the evidence panel does (the server records it for this digest).
 useEffect(() => { if (panelHere && needsEvidence && !isOpened(activeTab)) void open(activeTab); }, [panelHere]); // eslint-disable-line react-hooks/exhaustive-deps -- once, when the panel opens
 const documentTab = onItsPage && panelDocument === undefined ? DOCUMENT_TAB[card.kind] : undefined;
 const readLink = onItsPage && panelDocument !== undefined ? <Button className="rv-decision-read" onClick={() => panel.show(panelDocument)}>{PANEL_DOCUMENT_WORDS[panelDocument].read}</Button>
  : documentTab !== undefined && <Link className="rv-decision-read" to={{ search: location.search, hash: documentTab.hash }}>{documentTab.words}</Link>;
 // OWNER DECISION 18 (a): the key facts the server worked out from the document itself, the risk and why, the cost and time, and how many comments are open.
 const summary = decision.choices?.summary, openCount = decision.choices?.openCommentCount;
 const facts = (summary !== undefined || card.riskReasons.length > 0 || card.next.costUsd !== undefined || openCount !== undefined) && <div className="rv-decision-facts">
  {summary !== undefined && <><p className="rv-decision-needed"><strong>Needed:</strong> <VisibleText text={summary.needed} /></p><p className="rv-decision-summary-title">What Rovara will do:</p><ul className="rv-decision-summary">{summary.lines.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul></>}
  {(card.riskReasons.length > 0 || summary !== undefined) && <p className="rv-decision-why-risk">{card.riskReasons.length > 0 ? <><strong>{(RISK_WORDS[card.risk] ?? "Risk unknown") + " because:"}</strong> <VisibleText text={card.riskReasons.join("; ")} /></> : <><strong>{(RISK_WORDS[card.risk] ?? "Risk unknown") + ":"}</strong> nothing in it raises the risk.</>}</p>}
  {(card.next.costUsd !== undefined || card.next.minutes !== undefined) && <p className="rv-decision-cost"><strong>Cost and time:</strong> {card.next.costUsd !== undefined && <>about <Money usd={card.next.costUsd} /></>}{card.next.costUsd !== undefined && card.next.minutes !== undefined && ", "}{card.next.minutes !== undefined && "about " + String(card.next.minutes) + " minutes"}</p>}
  {openCount !== undefined && <p className="rv-decision-open-comments">{openCount === 1 ? "1 open comment" : String(openCount) + " open comments"}</p>}
 </div>;
 // The design questions, answered here (slice 2): an option or words for each, then Answer; a parked review can also be kept waiting.
 const asked = card.kind === "answer_question" ? actions.questions : undefined;
 const answered = asked === undefined ? [] : asked.items.flatMap(question => { const given = answers[question.id], text = plainReason(given?.text ?? "");return given?.optionId === undefined && text === "" ? [] : [{ questionId: question.id, ...(given?.optionId === undefined ? {} : { optionId: given.optionId }), ...(text === "" ? {} : { text }) }]; });
 const questionsBox = asked !== undefined && <form className="rv-decision-questions" aria-label="Answer the design questions" onSubmit={event => { event.preventDefault();void run(async () => { await asked.submit(answered);setAnswers({});setNote(<p role="status">Answered. The planner takes your answers from here.</p>); }); }}>
  <ol>{asked.items.map(question => <li key={question.id}><fieldset><legend><VisibleText text={question.unclear} /></legend>
   {question.options.map(option => <p key={option.id}><input type="radio" name={"q-" + card.id + "-" + question.id} id={"q-" + card.id + "-" + question.id + "-" + option.id} checked={answers[question.id]?.optionId === option.id} onChange={() => setAnswers(current => ({ ...current, [question.id]: { text: current[question.id]?.text ?? "", optionId: option.id } }))} /> <label htmlFor={"q-" + card.id + "-" + question.id + "-" + option.id}><VisibleText text={option.label + ": " + option.consequence + (option.id === question.recommended ? " (Rovara recommends this)" : "")} /></label></p>)}
   <label htmlFor={"q-" + card.id + "-" + question.id + "-text"}>Or say it in your words</label><input type="text" id={"q-" + card.id + "-" + question.id + "-text"} maxLength={500} value={answers[question.id]?.text ?? ""} onChange={event => { const text = event.target.value;setAnswers(current => ({ ...current, [question.id]: { ...current[question.id], text } })); }} />
  </fieldset></li>)}</ol>
  <div className="rv-actions"><Button type="submit" variant="primary" busy={busy} disabled={answered.length !== asked.items.length}>{DECISION_LABELS.answer}</Button>{asked.parked && asked.resume !== undefined && <Button busy={busy} onClick={() => { void run(async () => { await asked.resume!();setNote(<p role="status">Still waiting for answers. The 7 days start again.</p>); }); }}>Keep waiting</Button>}</div>
 </form>;
 const deciding = <>{!openOnly && limitBox}{planShown && plan.element}{(card.kind === "approve_plan" || card.kind === "approve_requirements") && card.status === "pending"  && <p className="rv-muted rv-decision-takes">{DECISION_APPROVE_TAKES}</p>}</>;
 /** What decides the card: in the card, or pinned at the foot of its open document (never both, so every control has one id). */
 const actionsBlock = <>{card.risk === "high" && <p className="rv-decision-high">{inline ? HIGH_RISK_NOTE : confirmPage ? "This decision is made on its own page, after you sign in again." : "This decision is made on its own page."}</p>}
  <div className="rv-decision-actions">
   {card.risk === "high" ? <>{inline ? inlineActions : highSpendHere ? choiceButtons : link}{designBox}</> : openOnly ? <><p className="rv-muted">Decided on its card in the task, after a look at the evidence.</p>{link}</> : <>{approveButton(activeTab)}{choiceButtons}{designBox}{canReject && <details className="rv-decision-reject"><summary>{DECISION_LABELS.notNow}</summary><ul>{DECISION_REJECT_REASONS.filter(reason => card.rejectReasons.includes(reason)).map(reason => <li key={reason}><Button variant="quiet" busy={busy} onClick={() => { void run(async () => { settle(await actions.onReject(reason)); }); }}>{REASON_WORDS[reason]}</Button></li>)}</ul></details>}{needsEvidence ? null : link}</>}
   {!openOnly && changesBox}
  </div>
  {confirming && <div role="group" aria-label="Confirm merge" className="rv-decision-confirm"><p><VisibleText text={mergeQuestion(confirming.merging)} /></p>
   <div className="rv-actions"><Button variant="primary" onClick={() => { const url = confirming.url;setConfirming(undefined);setNote(<p role="status">Nothing is merged until you confirm on the next page.</p>);host.openExternal(url); }}>Confirm</Button><Button onClick={() => { setConfirming(undefined);setNote(<p role="status">Nothing was merged.</p>); }}>Cancel</Button></div></div>}
  {note}
  {error && <p role="alert"><VisibleText text={error} /></p>}
  {signIn && (signIn.url !== undefined
   ? <a className="rv-button rv-button-secondary" href={signIn.url}>{DECISION_LABELS.signInAgain}</a>
   : card.kind === "approve_request"
   // An outside approval needs the decide-grade sign-in (an email code from a clean sign-in): its own flow, which comes back to this approval's card.
   ? <a className="rv-button rv-button-secondary" href={"/v1/auth/decide/identify?return=" + encodeURIComponent("/v1/app/approve/" + String(card.id).slice("approve_request:".length))}>{DECISION_LABELS.signInAgain}</a>
   : <Button onClick={() => host.signIn(host.currentPath())}>{DECISION_LABELS.signInAgain}</Button>)}
 </>;
 return <article ref={article} id={decisionElementId(card.id)} className="rv-decision" data-risk={card.risk} data-focused={focused ? "true" : undefined} aria-label={card.title} {...swipe}>
  <header><h2><VisibleText text={card.title} /></h2><p className="rv-decision-risk">{RISK_WORDS[card.risk] ?? "Risk unknown"}</p></header>
  <p className="rv-decision-question"><VisibleText text={card.question} /></p>
  <p className="rv-decision-recommended">Recommended: <VisibleText text={card.recommended.action + ". " + card.recommended.why} /></p>
  <p className="rv-decision-next">Next: <VisibleText text={card.next.text} /></p>
  {tabs === undefined ? <Chips chips={card.evidence} /> : <Tabs label={"Documents to approve for " + card.title} value={tab} onValueChange={value => { if (value === "requirements" || value === "design") setTab(value); }} items={tabs.map(item => ({ value: item.id, label: item.title + (item.approved ? " (approved)" : ""), content: <><Chips chips={item.evidence} />{needsEvidence && !openOnly && evidencePanel(item.id)}</> }))} />}
  {tabs === undefined && needsEvidence && !openOnly && evidencePanel(undefined)}
  {facts}
  {!panelHere && deciding}
  {questionsBox}
  {readLink}
  {panelHere ? <p className="rv-muted" role="status">{"Deciding in the open " + PANEL_DOCUMENT_WORDS[panel.open ?? panelDocument ?? "plan"].name.toLowerCase() + "."}</p> : actionsBlock}
  {panelHere && <PlanPanelSlot taskId={card.taskId ?? ""} document={panel.open ?? panelDocument ?? "plan"} onClose={panel.close} footer={<>{deciding}{actionsBlock}</>} />}
 </article>;
}
