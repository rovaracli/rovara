// The PR feedback card on the task page (CLOUD-HALF "Private app implementation", F1, F2; approved mock pr-feedback-screen round 2).
// Authority: only the latest successful reads (the full task read and the feedback read, ordered by issue), for the live owner or an explicitly authorized
// co-owner, bound to the exact revision, report and bundle set those reads agree on. Everything is checked again at the moment of the press against fresh
// reads. A press persists its frozen request before anything is sent (no storage: nothing is sent), and an unanswered press stays locked for this
// company, person and task, across tabs and reloads, until a read proves what happened; Check only reads and never sends again.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { taskMoneyValue } from "@agentx/contracts/web";
import type { ReadSession } from "./SessionHeader.js";
import { useAppHost } from "../../host.js";
import { ApiError } from "../../api/errors.js";
import { useTaskAction } from "../../api/task-action.js";
import { createTaskSessionApi } from "../../api/sessions.js";
import { createSessionActions } from "../../api/session-actions.js";
import { isCurrentSessionRead, isSessionCsrf, readSessionIdentity, useSessionIdentity } from "../../api/session-safety.js";
import { recordUnknownActionCheck, useUnknownActionExit } from "../../safe-action.js";
import {
 createPrFeedbackApi, decisionRecorded, feedbackLimitReached, feedbackReviewLimitReached, feedbackReviewNoteShown, FEEDBACK_REVIEW_ROUNDS_MAX, feedbackBindings, feedbackPhase, feedbackWorkflowOf, fixBody, fixRetryResolved, fixableFinding, isCompleteReview, keepBody,
 prFeedbackSubject, retryResolved, selectionProblem, type FeedbackFinding, type FeedbackReview, type FeedbackWorkflow,
} from "../../api/pr-feedback.js";
import { Button } from "../../design/Button.js";
import { Checkbox } from "../../design/Checkbox.js";
import { DecisionFrame } from "../../design/DecisionFrame.js";
import type { StatusChipProps } from "../../design/StatusChip.js";
import { TaskMoney } from "../../design/TaskMoney.js";
import { VisibleText } from "../../design/VisibleText.js";
import { TaskMark } from "./task-marks.js";
import { clockTime } from "./task-time.js";
import { useRegisterTaskFeedbackRefused, useRegisterTaskStopSlot } from "./task-slots.js";
import "./pr-feedback-card.css";

const PRIORITY = { MUST_FIX: "High priority", SHOULD_FIX: "Medium priority", OPTIONAL: "Low priority" } as const;
const ASSESSMENT = { ACTIONABLE: "Needs a change", ALREADY_ADDRESSED: "Already done", STALE: "Out of date: the code has moved on", TECHNICALLY_INCORRECT: "The comment looks mistaken", OUT_OF_SCOPE: "Outside this task", CONFLICTING: "Conflicts with another comment", NEEDS_OWNER_DECISION: "Your call" } as Record<string, string>;
const CONFIDENCE = { HIGH: "High", MEDIUM: "Medium", LOW: "Low", UNKNOWN: "Unknown" } as const;
/** Code's refusal when the feedback changed between the card and the press (core-host FEEDBACK_CHANGED_SINCE_CARD). */
const FEEDBACK_CHANGED = "The feedback changed since this card; a new review is starting.";
const STALE_WORDS = "The feedback or your permissions changed. Rovara is reading it again; nothing was sent.";
const usd = (micros: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(micros / 1_000_000);
const pullWords = (session: ReadSession): string => {
 const pulls = session.body.kind === "task" ? session.body.task.pullRequests ?? [] : [];
 return pulls.length === 1 && pulls[0]!.number !== undefined ? "pull request #" + String(pulls[0]!.number) : pulls.length > 1 ? String(pulls.length) + " pull requests" : "the pull request";
};

export interface PrFeedbackCardProps {
 sessionId: string;
 /** The latest successful full task read. */
 session: ReadSession;
 /** The latest full task read (or a refetch) failed: every control is removed. */
 readFailed: boolean;
 onCheck: () => void;
}

export function PrFeedbackCard({ sessionId, session, readFailed, onCheck }: PrFeedbackCardProps) {
 const host = useAppHost(), query = useQueryClient(), identity = useSessionIdentity(host);
 const api = useMemo(() => createPrFeedbackApi(host), [host]);
 const action = useTaskAction(host, prFeedbackSubject(sessionId));
 const workflow = feedbackWorkflowOf(session), phase = feedbackPhase(workflow);
 const ref = workflow?.feedbackReview?.reviewRef;
 const may = session.you.owner || session.you.coOwner === true;
 // Code serves the feedback read to the owner and an authorized co-owner only; nobody else is asked.
 const wantsReview = may && (phase === "pending" || phase === "failed");
 // Keyed by the person, the revision and the report: a different revision or report is a different read, never a cached one.
 const review = useQuery({
  queryKey: ["session", sessionId, "pr-feedback", identity.data?.companyId ?? "", identity.data?.personId ?? "", workflow?.revision ?? 0, ref?.sha256 ?? ""],
  enabled: wantsReview && identity.data !== undefined, retry: false, staleTime: 0, gcTime: 0,
  queryFn: () => api.readReview(sessionId),
 });
 const reviewFailed = review.isError || review.failureCount > 0;
 const current: FeedbackReview | undefined = reviewFailed ? undefined : review.data;
 const bindings = feedbackBindings(workflow, current);

 const [message, setMessage] = useState<string>(), [busy, setBusy] = useState(false), busyRef = useRef(false);
 const [refused, setRefused] = useState<{ digest: string; text: string }>();
 // A review the owner was choosing from that is replaced by a new round: "the comments changed while you were choosing". Adjusted while rendering
 // from the latest read (React's "adjust state when a prop changes"), never from an effect.
 const [seen, setSeen] = useState<{ pending?: string; changed: boolean }>({ changed: false });
 const pendingDigest = phase === "pending" ? ref?.sha256 : undefined, newRound = phase === "collecting" || phase === "reviewing";
 if (pendingDigest !== undefined && (seen.pending !== pendingDigest || seen.changed)) setSeen({ pending: pendingDigest, changed: false });
 else if (newRound && seen.pending !== undefined) setSeen({ changed: true });
 else if (!newRound && pendingDigest === undefined && seen.changed) setSeen({ changed: false });
 const changed = seen.changed;
 const setChanged = () => { setSeen({ changed: true }); };
 // A refusal stays only for the report it was about (R2c: a later read that disagrees retires it).
 const shownRefusal = refused !== undefined && phase === "pending" && ref?.sha256 === refused.digest ? refused.text : undefined;
 const setPageRefused = useRegisterTaskFeedbackRefused(), refusedShown = shownRefusal !== undefined;
 useEffect(() => { if (setPageRefused === undefined) return;setPageRefused(refusedShown);return () => { setPageRefused(false); }; }, [setPageRefused, refusedShown]);

 const authority = may && !readFailed && !reviewFailed && bindings !== undefined && !action.locked && identity.data !== undefined && !busy;
 const sessions = useMemo(() => createTaskSessionApi(host), [host]);
 const reread = () => { onCheck();void query.invalidateQueries({ queryKey: ["session", sessionId] }); };

 /** R6c: identity, the full task read and the feedback read, all fresh, must still bind exactly what the frozen body is bound to. */
 async function freshCheck(body: Record<string, unknown>, kind: "decision" | "retry" | "fix-retry") {
  const person = await readSessionIdentity(host), latest = await sessions.read(sessionId);
  if (!isCurrentSessionRead(host, person, sessionId, latest) || !(latest.you.owner || latest.you.coOwner === true)) throw new ApiError(409, "INTENT_NOT_WAITING", STALE_WORDS);
  const fresh = feedbackWorkflowOf(latest);
  if (kind === "fix-retry") { if (feedbackPhase(fresh) !== "fix_stopped" || fresh?.revision !== body["expectedRevision"]) throw new ApiError(409, "INTENT_NOT_WAITING", STALE_WORDS);return; }
  const freshReview = await api.readReview(sessionId), freshBindings = feedbackBindings(fresh, freshReview);
  if (freshBindings === undefined || freshBindings.reviewDigest !== body["reviewDigest"]) throw new ApiError(409, "INTENT_NOT_WAITING", STALE_WORDS);
  if (kind === "retry") { if (isCompleteReview(freshReview)) throw new ApiError(409, "INTENT_NOT_WAITING", STALE_WORDS);return; }
  if (freshBindings.expectedRevision !== body["expectedRevision"] || freshBindings.proposalDigest !== body["proposalDigest"] || JSON.stringify([...freshBindings.bundleDigests].sort()) !== JSON.stringify([...(body["bundleDigests"] as string[])].sort())) throw new ApiError(409, "INTENT_NOT_WAITING", STALE_WORDS);
  if (body["decision"] === "APPROVE" && selectionProblem(body["selectedFindingIds"] as string[], freshReview) !== undefined) throw new ApiError(409, "INTENT_NOT_WAITING", STALE_WORDS);
 }

 async function press(kind: "fix" | "keep" | "retry" | "fix-retry", selected: readonly string[] = []) {
  if (busyRef.current) return;
  busyRef.current = true;setBusy(true);setMessage(undefined);
  try {
   const requestId = crypto.randomUUID();
   if (kind === "fix-retry") {
    if (!may || readFailed || action.locked || workflow === undefined) return;
    const body = { requestId, expectedRevision: workflow.revision };
    await action.run("fix-retry", body, async sent => createSessionActions(host).retry(sessionId, sent.requestId, { expectedRevision: workflow.revision }), () => freshCheck(body, "fix-retry"));
   } else if (kind === "retry") {
    if (!authority || ref === undefined) return;
    // F2: no request id is sent; the local id only names this browser's claim.
    const body = { requestId, reviewDigest: ref.sha256 };
    await action.run("feedback-retry", body, async sent => api.retry(sessionId, sent["reviewDigest"] as string), () => freshCheck(body, "retry"));
   } else {
    if (!authority || current === undefined) return;
    const body = kind === "keep" ? keepBody(bindings, requestId) : fixBody(bindings, requestId, selected, current);
    await action.run("feedback-decision", body, async sent => api.decide(sessionId, sent as typeof body), () => freshCheck(body, "decision"));
   }
   reread();
  } catch (failure) {
   const error = failure instanceof ApiError ? failure : undefined;
   if (isSessionCsrf(failure)) { setMessage("Couldn't change that. Nothing was sent. Rovara is reading the page again.");void readSessionIdentity(host).catch(() => undefined);reread(); }
   else if (error?.code === "INTENT_NOT_WAITING" || error?.code === "READ_SUPERSEDED") { setMessage(STALE_WORDS);reread(); }
   else if (error?.message === FEEDBACK_CHANGED) { setChanged();reread(); }
   else if (error !== undefined && error.status >= 400 && error.status < 500 && !action.pending && kind === "fix" && ref !== undefined) { setRefused({ digest: ref.sha256, text: error.message });reread(); }
   else if (error !== undefined && !action.pending) setMessage(error.message);
  } finally { busyRef.current = false;setBusy(false); }
 }

 async function check() {
  const pending = action.request, entry = action.recovery.entry;
  if (pending === undefined || entry === undefined || identity.data === undefined) return;
  setMessage(undefined);
  try {
   const settled = await action.check(() => sessions.read(sessionId), (latest, request) => {
    const fresh = feedbackWorkflowOf(latest);
    if (request.action === "feedback-retry") return retryResolved(fresh, request.body["reviewDigest"]);
    if (request.action === "fix-retry") return fixRetryResolved(fresh, request.body["expectedRevision"]);
    // By the original request id and bindings, never by who acted: Code records a per-task owner key as the actor, not the person's id.
    return decisionRecorded(fresh, request.body);
   });
   if (settled) reread();
   else { setMessage("Rovara hasn't recorded it yet. Your choice stays kept here; check again in a moment.");recordUnknownActionCheck(action.recovery.fence, entry); }
  } catch { setMessage("Couldn't read the task just now. Your choice stays kept here; check again.");recordUnknownActionCheck(action.recovery.fence, entry); }
 }

 if (phase === undefined) return null;
 const ctx: CardContext = { session, workflow: workflow!, identityId: identity.data?.personId, may, pull: pullWords(session), message };

 if (action.pending && action.request !== undefined) return <NoReply ctx={ctx} request={action.request} recovery={action.recovery} taskHref={"/s/" + encodeURIComponent(sessionId)} onCheck={() => { void check(); }} />;
 if (changed && (phase === "collecting" || phase === "reviewing")) return <Changed ctx={ctx} />;
 if (phase === "collecting") return <Collecting ctx={ctx} />;
 if (phase === "reviewing") return <Reviewing ctx={ctx} />;
 if (phase === "kept") return <Kept ctx={ctx} />;
 if (phase === "fix_finished") return <FixFinished ctx={ctx} />;
 if (phase === "fixing") return <Fixing ctx={ctx} />;
 if (phase === "fix_stopped") return <FixStopped ctx={ctx} canRetry={may && !readFailed && !action.locked && !busy} onRetry={() => { void press("fix-retry"); }} />;
 if (!may) return <Viewer ctx={ctx} failed={phase === "failed"} />;
 // pending or failed: a failed or out-of-date read removes every control.
 if (readFailed || reviewFailed || (review.data !== undefined && bindings === undefined)) return <ReadFailed ctx={ctx} onRetry={() => { void review.refetch();reread(); }} stale={!reviewFailed && !readFailed} />;
 if (current === undefined) return <Loading ctx={ctx} />;
 if (phase === "failed") return <FailedReview ctx={ctx} canAct={authority} limit={feedbackReviewLimitReached(workflow)} onRetry={() => { void press("retry"); }} onKeep={() => { void press("keep"); }} reason={ref?.blockReason} />;
 if (shownRefusal !== undefined) return <FixRefused ctx={ctx} reason={shownRefusal} />;
 return <OwnerPending key={ref?.sha256} ctx={ctx} review={current} may={may} canAct={authority} onFix={selected => { void press("fix", selected); }} onKeep={() => { void press("keep"); }} />;
}

interface CardContext { session: ReadSession; workflow: FeedbackWorkflow; /** The viewer, only to mark the served payer "(you)". */ identityId: string | undefined; /** The owner or an authorized co-owner: the only people shown the money. */ may: boolean; pull: string; message: string | undefined }

// ---- Money: served facts only; the next run's cost is never known in advance ----
// Only the money Code served on the task read (task.money): never Cloud's own cost.payer, which names whoever started the task whatever Code says pays.
function payerOf(ctx: CardContext): { name: string; you: boolean } | undefined {
 const payer = ctx.session.money === undefined ? undefined : taskMoneyValue(ctx.session.money.payer);
 return payer === undefined ? undefined : { name: payer.name, you: payer.kind === "member" && payer.id === ctx.identityId };
}
const payerWords = (ctx: CardContext) => { const payer = payerOf(ctx);return payer === undefined ? "Unavailable" : payer.name + (payer.you ? " (you)" : ""); };
const paidBy = (ctx: CardContext) => payerOf(ctx) === undefined ? "charged to the task's payer" : "charged to " + payerWords(ctx);
function MoneyFacts({ ctx, next, compact = false }: { ctx: CardContext; next?: string | undefined; compact?: boolean }) {
 if (!ctx.may) return null;
 if (ctx.session.money === undefined) return <p className="rv-prf-money-none">Cost details aren't available here.</p>;
 const money = ctx.session.money, limit = money === undefined ? undefined : taskMoneyValue(money.stop.taskMaximumMicros), spent = money === undefined ? undefined : taskMoneyValue(money.spentMicros);
 return <dl className={"rv-prf-money" + (compact ? " compact" : "")} aria-label="Cost and limit">
  <div><dt>Who pays</dt><dd><VisibleText text={payerWords(ctx)} /></dd></div>
  <div><dt>Spent on this task</dt><dd><TaskMoney money={money} /></dd></div>
  <div><dt>Task limit</dt><dd className="rv-num">{limit === undefined ? "Unavailable" : usd(limit)}{limit !== undefined && spent !== undefined && <span className="rv-prf-left">{" · About " + usd(Math.max(0, limit - spent)) + " left"}</span>}</dd></div>
  {next !== undefined && <div><dt>{next}</dt><dd className="rv-prf-unknown">Not known until it finishes</dd></div>}
 </dl>;
}
const decideStrip = (ctx: CardContext, line: ReactNode, buttons: ReactNode, next?: string) => <div className="rv-prf-decide"><MoneyFacts ctx={ctx} next={next} compact /><p className="rv-prf-paid">{line}</p><div className="rv-prf-buttons">{buttons}</div></div>;
const Message = ({ ctx }: { ctx: CardContext }) => ctx.message === undefined ? null : <p role="alert" className="rv-prf-message"><VisibleText text={ctx.message} /></p>;

function Card({ title, chip, meta, actions, footer, children, testId }: { title: string; chip?: StatusChipProps; meta: string; actions?: ReactNode; footer?: ReactNode; children: ReactNode; testId: string }) {
 return <DecisionFrame as="section" className="rv-task-primary rv-prf-card" data-testid={testId} title={title} {...(chip === undefined ? {} : { status: chip })} meta={meta} actions={actions ?? null} footer={footer}>{children}</DecisionFrame>;
}
function StopRow({ note }: { note: string }) {
 const registerStop = useRegisterTaskStopSlot();
 return <div className="rv-task-stop-row"><span className="rv-task-stop-slot" ref={registerStop} /><span className="rv-muted rv-task-stop-note">{note}</span></div>;
}
const at = (value: string | undefined) => value === undefined ? undefined : clockTime(value);
const NOTIFY = "When there is something to choose, this task shows Needs you on Home and on this page, and Rovara posts in the task's Slack thread.";

function Collecting({ ctx }: { ctx: CardContext }) {
 return <Card testId="prf-collecting" title={"Reading new comments on " + ctx.pull} chip={{ state: "running" }} meta="Nothing needed from you yet">
  <p>People commented on the pull request. Rovara is collecting the comments. Then an AI review sorts them. The review is paid work on this task, within the task limit.</p>
  <p className="rv-muted">Nothing in the code changes until you decide. {NOTIFY}</p>
 </Card>;
}
function Reviewing({ ctx }: { ctx: CardContext }) {
 const comments = (ctx.workflow.feedbackReview?.bundleRefs ?? []).reduce((total, bundle) => total + (bundle.comments?.length ?? 0), 0);
 return <Card testId="prf-reviewing" title={(comments > 0 ? "Reviewing " + String(comments) + (comments === 1 ? " comment" : " comments") : "Reviewing the comments") + " on " + ctx.pull} chip={{ state: "running" }} meta="Nothing needed from you yet">
  <p>An AI review is sorting the comments: what needs a change, what is already done, and what is your call. It is advice: you choose what Rovara fixes.</p>
  <MoneyFacts ctx={ctx} next="Cost of this review" />
  <StopRow note="Stopping ends this review. The pull request and its comments are kept. Money already spent stays spent." />
 </Card>;
}
function Changed({ ctx }: { ctx: CardContext }) {
 return <Card testId="prf-changed" title="The comments changed while you were choosing" chip={{ state: "running" }} meta={ctx.pull}>
  <p>Rovara is reviewing them again. Your earlier ticks were not sent.</p>
  <p className="rv-muted">{NOTIFY}</p>
 </Card>;
}
function Kept({ ctx }: { ctx: CardContext }) {
 const decision = [...(ctx.workflow.feedbackDecisions ?? [])].reverse().find(entry => entry.decision === "DISMISS" && entry.reviewDigest === ctx.workflow.feedbackReview?.reviewRef?.sha256);
 const when = at(decision?.at);
 return <Card testId="prf-kept" title="You kept the pull request as it is" chip={{ state: "done" }} meta={when === undefined ? "Recorded" : "Recorded " + when}>
  <p>No fix runs and nothing is spent. Nothing is posted on GitHub.</p>
  <p>You can't reopen this choice. New comments start a new review.</p>
  <p className="rv-muted">Rovara keeps watching {ctx.pull}. Merging happens on GitHub, not here.</p>
 </Card>;
}
/**
 * Who chose is never guessed in the browser: Code records a per-task owner key as the actor, so the card never compares ids. It reads only Code's own
 * `decidedByYou` on the latest Fix decision in the full task read: true is "You chose this"; false or absent is "Chosen by the owner or a co-owner".
 */
function chosenWords(ctx: CardContext): string {
 const decision = [...(ctx.workflow.feedbackDecisions ?? [])].reverse().find(entry => entry.decision === "APPROVE");
 const when = at(decision?.at);
 return decision === undefined ? ctx.pull : (decision.decidedByYou === true ? "You chose this" : "Chosen by the owner or a co-owner") + (when === undefined ? "" : " at " + when) + " · " + ctx.pull;
}
const fixCount = (ctx: CardContext) => [...(ctx.workflow.feedbackDecisions ?? [])].reverse().find(entry => entry.decision === "APPROVE")?.selectedFindingIds.length;
const findingsWords = (count: number | undefined) => count === undefined ? "the chosen findings" : String(count) + (count === 1 ? " finding" : " findings");
const FIX_STEPS = [["IMPLEMENT", "Change the code"], ["VERIFY", "Run the checks"], ["REVIEW", "Code and security reviews"], ["PULL_REQUEST", "Push to the pull request"]] as const;
function Fixing({ ctx }: { ctx: CardContext }) {
 const at = Math.max(0, FIX_STEPS.findIndex(([stage]) => stage === ctx.workflow.stage));
 return <Card testId="prf-fixing" title={"Fixing " + findingsWords(fixCount(ctx)) + " from the pull request comments"} chip={{ state: "running" }} meta={chosenWords(ctx)}>
  <p className="rv-muted rv-prf-step">{"Step " + String(at + 1) + " of 4: " + FIX_STEPS[at]![1]}</p>
  <ol className="rv-task-checklist" aria-label="Steps">{FIX_STEPS.map(([stage, label], index) => { const state = index < at ? "done" : index === at ? "running" : "next";return <li key={stage} data-state={state} aria-current={state === "running" ? "step" : undefined}><TaskMark kind={state} /><span>{String(index + 1) + " · " + label}</span></li>; })}</ol>
  <p className="rv-muted">Nothing is pushed until the checks and reviews pass.</p>
  <MoneyFacts ctx={ctx} next="Cost of this fix" />
  <StopRow note="Stopping ends this fix after the current step. Nothing is pushed. Money already spent stays spent." />
 </Card>;
}
function FixStopped({ ctx, canRetry, onRetry }: { ctx: CardContext; canRetry: boolean; onRetry: () => void }) {
 const reason = ctx.workflow.blockReason;
 const limitHit = feedbackLimitReached(ctx.session);
 const count = findingsWords(fixCount(ctx));
 return <Card testId="prf-fix-stopped" title="The fix stopped before it finished" chip={{ state: "stopped" }} meta={chosenWords(ctx)}
  actions={decideStrip(ctx, limitHit ? <span id="prf-limit">The task limit is reached, so Retry fix can't start. Someone who can change the task limit has to raise it first.</span> : <>Retry fix is paid work, <VisibleText text={paidBy(ctx)} />, within the task limit.</>,
   <Button variant="primary" disabled={!canRetry || limitHit} aria-describedby={limitHit ? "prf-limit" : undefined} onClick={onRetry}>Retry fix</Button>, limitHit ? undefined : "Cost of a retry")}
  footer={limitHit ? undefined : <p>Retry fix starts the fix again with the same {count}. It is paid work, <VisibleText text={paidBy(ctx)} />, within the task limit. To end the task instead, use Close in Task actions.</p>}>
  <p><strong>Reason:</strong> <VisibleText text={reason ?? "Rovara didn't record a reason."} /></p>
  <p>Nothing was pushed. The pull request is as it was before the fix.</p>
  <Message ctx={ctx} />
 </Card>;
}
function FixFinished({ ctx }: { ctx: CardContext }) {
 return <Card testId="prf-fix-finished" title={"The fix is on " + ctx.pull} chip={{ state: "done" }} meta={chosenWords(ctx)}>
  <p>{findingsWords(fixCount(ctx)).replace(/^./u, letter => letter.toUpperCase())} fixed. The checks and reviews passed, then Rovara pushed. Rovara keeps watching the pull request until it is merged. Merging happens on GitHub.</p>
  <MoneyFacts ctx={ctx} />
 </Card>;
}
function FixRefused({ ctx, reason }: { ctx: CardContext; reason: string }) {
 return <Card testId="prf-fix-refused" title="The fix didn't start" chip={{ state: "didnt_finish" }} meta={ctx.pull}>
  <p><strong>Reason:</strong> <VisibleText text={reason} /></p>
  <p>Nothing was spent on this fix and nothing changed.</p>
  <MoneyFacts ctx={ctx} />
 </Card>;
}
type Recovery = { fence: Parameters<typeof recordUnknownActionCheck>[0]; entry: { requestId: string; startedAt: string } | undefined };
function NoReply({ ctx, request, recovery, taskHref, onCheck }: { ctx: CardContext; request: { action: string; body: Record<string, unknown>; startedAt: number }; recovery: Recovery; taskHref: string; onCheck: () => void }) {
 // DEC 254zzz285: after three Checks that prove nothing, or ten minutes from the press, point at the task. Presentation only: it never clears the lock, resends, or turns Check off.
 const exit = useUnknownActionExit(recovery.fence, recovery.entry, taskHref);
 const what = request.action === "feedback-retry" ? "Retry review" : request.action === "fix-retry" ? "Retry fix" : request.body["decision"] === "DISMISS" ? "Keep the pull request as it is" : "Fix selected findings";
 const selected = Array.isArray(request.body["selectedFindingIds"]) ? request.body["selectedFindingIds"].length : 0;
 const kept = request.action === "feedback-decision" ? (request.body["decision"] === "DISMISS" ? "keep the pull request as it is" : "fix " + findingsWords(selected)) : request.action === "feedback-retry" ? "retry the review" : "retry the fix";
 const when = clockTime(new Date(request.startedAt).toISOString());
 return <Card testId="prf-no-reply" title="Rovara didn't hear back about your choice" chip={{ state: "not_confirmed" }} meta={"You pressed " + what + (when === undefined ? "" : " at " + when) + " · " + ctx.pull}
  actions={<Button variant="primary" onClick={onCheck}>Check my choice</Button>}
  footer={<p>Check asks Rovara what was recorded. It never sends your choice a second time. The other buttons stay off until Rovara knows what happened.</p>}>
  <p>Your choice may or may not have been recorded. {request.action === "feedback-decision" && request.body["decision"] === "DISMISS" ? "If it was, nothing more is spent." : request.action === "feedback-retry" ? "If it was, the review has started and is spending." : "If it was, the fix has started and is spending."} Your choice is kept here: {kept}.</p>
  {exit !== undefined && <p role="status">We couldn't confirm this. <a href={exit.href}>Open the task to check</a></p>}
  <Message ctx={ctx} />
 </Card>;
}
function ReadFailed({ ctx, onRetry, stale }: { ctx: CardContext; onRetry: () => void; stale: boolean }) {
 return <Card testId="prf-read-failed" title={stale ? "The feedback changed" : "Couldn't read the feedback"} chip={{ state: "not_confirmed" }} meta={ctx.pull} actions={<Button onClick={onRetry}>Try again</Button>}>
  <p role="status">{stale ? "The feedback and the task disagree. Rovara needs a matching read before you choose; nothing was sent." : "Rovara couldn't read the pull request feedback just now. Nothing can be chosen until it reads again; nothing was sent."}</p>
  <Message ctx={ctx} />
 </Card>;
}
function Viewer({ ctx, failed }: { ctx: CardContext; failed: boolean }) {
 const owner = ctx.session.owner.name;
 return <Card testId="prf-viewer" title={failed ? "The review of the pull request comments didn't finish" : "Choosing which pull request comments to fix"} chip={{ state: "waiting_for", waitingFor: owner }} meta={ctx.pull}
  actions={<div className="rv-prf-decide"><p className="rv-prf-paid">Only the task owner can choose. Waiting for <VisibleText text={owner} />.</p></div>}>
  <p>{failed ? "The AI review of the new comments didn't finish. The task owner decides whether to retry it or keep the pull request as it is." : "An AI review sorted the new comments. The task owner decides which to fix; fixing is paid work, keeping costs nothing."}</p>
 </Card>;
}
function Loading({ ctx }: { ctx: CardContext }) {
 return <Card testId="prf-loading" title="Reading the pull request feedback" meta={ctx.pull}><p className="rv-muted" role="status">Loading the findings.</p></Card>;
}
function FailedReview({ ctx, canAct, limit, onRetry, onKeep, reason }: { ctx: CardContext; canAct: boolean; limit: boolean; onRetry: () => void; onKeep: () => void; reason: string | undefined }) {
 // The review limit (state l, DEC 254zzz398 (1)): the same two choices Code offers a review that did not finish, under the controller's words.
 const strip = decideStrip(ctx, <>Retry review is paid work, <VisibleText text={paidBy(ctx)} />. Keeping costs nothing more.</>, <><Button variant="primary" disabled={!canAct} onClick={onRetry}>Retry review</Button><Button disabled={!canAct} onClick={onKeep}>Keep the pull request as it is</Button></>, "Cost of a retry");
 const footer = <p>Retry review runs the AI review again on the same comments. It is paid work, <VisibleText text={paidBy(ctx)} />. Keeping records your choice: nothing changes in the code and nothing more is spent. You can't reopen it. New comments start a new review.</p>;
 if (limit) return <Card testId="prf-review-limit" title={"Rovara has reviewed this pull request's comments " + String(FEEDBACK_REVIEW_ROUNDS_MAX) + " times"} chip={{ state: "needs_you" }} meta={ctx.pull} actions={strip} footer={footer}>
  <p>{"Rovara has reviewed this pull request's comments " + String(FEEDBACK_REVIEW_ROUNDS_MAX) + " times, the limit for a task. New comments won't start another review. Choose Retry review to run it again (paid), or Keep the pull request as it is."}</p>
  <Message ctx={ctx} />
 </Card>;
 return <Card testId="prf-failed" title="The review of the pull request comments didn't finish" chip={{ state: "didnt_finish" }} meta={ctx.pull} actions={strip} footer={footer}>
  <p><strong>Reason:</strong> <VisibleText text={reason ?? "Rovara didn't record a reason."} /></p>
  <p>No fix was proposed and nothing in the code changed. Rovara keeps watching the pull request until it is merged.</p>
  <p>The review that didn't finish may still have cost money. Spent on this task includes what was recorded.</p>
  <Message ctx={ctx} />
 </Card>;
}

function OwnerPending({ ctx, review, may, canAct, onFix, onKeep }: { ctx: CardContext; review: FeedbackReview; may: boolean; canAct: boolean; onFix: (selected: string[]) => void; onKeep: () => void }) {
 const findings = isCompleteReview(review) ? review.findings : [];
 const [picked, setPicked] = useState<string[]>(() => findings.filter(finding => finding.recommended && fixableFinding(finding)).map(finding => finding.id));
 const problem = selectionProblem(picked, review), count = picked.length;
 const comments = findings.reduce((total, finding) => total + finding.comments.length, 0), recommended = findings.filter(finding => finding.recommended).length;
 const ownerName = ctx.session.owner.name;
 const lead = "An AI review grouped the " + String(comments) + (comments === 1 ? " new comment" : " new comments") + " into " + String(findings.length) + (findings.length === 1 ? " finding" : " findings") + ". It is advice: " + (may ? "you choose" : ownerName + " chooses") + ". Rovara recommends fixing " + String(recommended) + ". Fixing is paid work; keeping costs nothing.";
 const toggle = (id: string, on: boolean) => setPicked(list => on ? (list.includes(id) ? list : [...list, id]) : list.filter(item => item !== id));
 const selectionWords = problem === "empty" ? "Select at least one finding to fix." : problem === "too_many" ? "Select at most 128 findings to fix." : problem !== undefined ? "This selection can't be fixed. Select findings again." : String(count) + " selected. Fixing is paid work, " + paidBy(ctx) + ". Keeping costs nothing.";
 return <Card testId="prf-pending" title={may ? "Choose which pull request comments to fix" : "Choosing which pull request comments to fix"} chip={may ? { state: "needs_you" } : { state: "waiting_for", waitingFor: ownerName }}
  meta={ctx.pull + " · " + String(comments) + (comments === 1 ? " comment, " : " comments, ") + String(findings.length) + (findings.length === 1 ? " finding" : " findings") + (isCompleteReview(review) && review.candidates.length === 1 ? " · reviewed at commit " + review.candidates[0]!.headSha.slice(0, 7) : "")}
  actions={may ? decideStrip(ctx, <span id="prf-selection">{selectionWords}</span>, <><Button variant="primary" disabled={!canAct || problem !== undefined} aria-describedby="prf-selection" onClick={() => onFix(picked)}>Fix selected findings</Button><Button disabled={!canAct} onClick={onKeep}>Keep the pull request as it is</Button></>, "Cost of this fix")
   : <div className="rv-prf-decide"><p className="rv-prf-paid">Only the task owner can choose. Waiting for <VisibleText text={ownerName} />.</p></div>}
  footer={may ? <><p>Fixing is paid work, <VisibleText text={paidBy(ctx)} />. Rovara changes the code, runs the normal checks and reviews again, and pushes to the same pull request. It stops at the task limit.</p><p>Keeping it records your choice. Nothing changes in the code and nothing is spent. You can't reopen this choice. New comments start a new review.</p><p>Rovara also posted this in the task's Slack thread.</p></> : undefined}>
  <p className="rv-prf-lead">{lead}</p>
  {feedbackReviewNoteShown(ctx.workflow) && <p className="rv-muted rv-prf-limit-note" data-testid="prf-review-limit-note">New comments won't start another review (limit reached).</p>}
  <ol className="rv-prf-findings" aria-label="Findings">{findings.map((finding, index) => <FindingRow key={finding.id} finding={finding} n={index + 1} selected={picked.includes(finding.id)} open={index === 0} readOnly={!may || !canAct} onToggle={on => toggle(finding.id, on)} />)}</ol>
  <Message ctx={ctx} />
 </Card>;
}
function FindingRow({ finding, n, selected, open, readOnly, onToggle }: { finding: FeedbackFinding; n: number; selected: boolean; open: boolean; readOnly: boolean; onToggle: (on: boolean) => void }) {
 const fixable = fixableFinding(finding), noAdvice = fixable && !finding.recommended;
 const title = finding.fixProposal?.summary ?? finding.comments[0]!.body;
 return <li className="rv-prf-finding" data-priority={finding.priority} data-finding={finding.id}>
  <div className="rv-prf-finding-head">
   {fixable ? <Checkbox label={String(n) + " · " + title} checked={selected} disabled={readOnly} onCheckedChange={value => onToggle(value === true)} /> : <p className="rv-prf-finding-title"><TaskMark kind="done" /><span><VisibleText text={String(n) + " · " + title} /></span></p>}
   <p className="rv-prf-tags">{fixable && <span className="rv-prf-priority">{PRIORITY[finding.priority]}</span>}<span>{ASSESSMENT[finding.assessment] ?? "Your call"}</span>{finding.recommended && <span>Recommended</span>}</p>
   {noAdvice && <p className="rv-prf-noadvice">Rovara has no recommendation. Tick this only if you want the change below.</p>}
  </div>
  <div className="rv-prf-finding-body">
   {finding.comments.map((comment, index) => <blockquote key={index} className="rv-prf-comment"><p>“<VisibleText text={comment.body} />”</p><footer><VisibleText text={comment.author} />{comment.path !== undefined && <> on <code><VisibleText text={comment.path + (comment.line === undefined ? "" : ":" + String(comment.line))} /></code></>} · <a href={comment.url} target="_blank" rel="noreferrer">Open on GitHub</a></footer></blockquote>)}
   <p><strong>Why:</strong> <VisibleText text={finding.rationale} /> <span className="rv-muted">AI confidence: {CONFIDENCE[finding.confidence.level]}.</span></p>
   {finding.fixProposal !== undefined && <details className="rv-prf-plan" open={open || noAdvice || undefined}><summary><TaskMark kind="chevron" />What Rovara would change</summary>
    <ul>{finding.fixProposal.fileChanges.map((change, index) => <li key={"f" + String(index)}><code><VisibleText text={change.path} /></code> <span className="rv-muted">{change.operation === "ADD" ? "new file" : "edit"}</span>: <VisibleText text={change.change} /></li>)}
     {finding.fixProposal.tests.map((test, index) => <li key={"t" + String(index)}>Test <code><VisibleText text={test.path} /></code>: <VisibleText text={test.behavior} /></li>)}
     {finding.checkChanges.obsolete.map((label, index) => <li key={"o" + String(index)}>Drops the check “<VisibleText text={label} />”, which this fix makes wrong.</li>)}
     {finding.checkChanges.added.map((check, index) => <li key={"a" + String(index)}>Adds the check “<VisibleText text={check.label} />”: <code><VisibleText text={check.command} /></code></li>)}</ul>
   </details>}
  </div>
 </li>;
}
