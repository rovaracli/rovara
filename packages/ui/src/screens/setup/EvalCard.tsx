import { useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EvalCardSuite, EvalCardView } from "@agentx/contracts/web";
import { evalCardKey, useEvalCardApi } from "../../api/eval-card.js";
import { setupChecklistKey } from "../../api/setup-checklist.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useNav } from "../account/use-nav.js";
import { confirmedReturn, forgetConfirmed, startStepUpNonce, useJustConfirmed } from "../admin/parts.js";
import "./approval-card.css";

/** What the card itself says (everything else it shows is Code's own sentence, in dollars). No counts, no technical units: only dollars and plain words. */
export const EVAL_CARD_WORDS = {
  heading: "Approve the cost of running your evals",
  noOne: "A company owner, admin or this project's maintainer approves this cost.",
  stepUp: "Approving asks you to confirm it's you first.",
  stepUpDone: "You confirmed it's you. This stays open for a few minutes.",
  stepUpOld: "Your last confirmation is too old. Confirm it's you again, then choose.",
  waiting: "Your eval cost is waiting for approval.",
  renew: "The person who approved your eval cost can no longer approve it. A company owner, admin or maintainer needs to approve it again.",
  rejected: "The eval cost was not approved, so Rovara does not run your evals on each AI change.",
  approvedLine: (perPr: string, monthly: string) => `Rovara runs your evals on each AI change: about ${perPr} per PR, at most ${monthly} a month.`,
  carried: "Your eval cases changed and stayed inside what you approved.",
  queued: "Your eval check is queued",
  ran: "Your eval check ran",
  readError: "Your evals couldn't be read just now. Try again.",
  sendError: "Couldn't send that. Try again.",
} as const;

const cases = (n: number) => `${String(n)} eval ${n === 1 ? "case" : "cases"}`;
type Problem = { message: string; moved: boolean };

/**
 * The setup flow's ONE eval card (L4-EVC, DEC 254zzz20 D5, D6, D8). Eval spending is approved once, on one card, in plain dollars. The server decides everything (who may approve, the dollars held
 * against its own figures); this card only asks. An approval needs a fresh sign-in, as the setup approval does: the first press sends the person to confirm it's them, the next one decides. The `seen` dollars
 * are copied from the read, never worked out here. The health check is OPT-IN: it is only ever sent from a click, never on load, and only for a person who may approve.
 * `fallback` is shown when Code has no eval card yet or there is nothing to approve.
 */
export function EvalCard({ project, fallback }: { project: string; fallback: ReactNode }) {
  const api = useEvalCardApi(), host = useAppHost(), query = useQueryClient();
  const who = useNav()?.me.developerId;
  const confirmed = useJustConfirmed(who);
  const read = useQuery({ queryKey: evalCardKey(project), queryFn: () => api.read(project), retry: false });
  const [stale, setStale] = useState(false), [busy, setBusy] = useState<string>(), [problem, setProblem] = useState<Problem>(), [done, setDone] = useState(false);
  const sending = useRef(false);
  const fresh = confirmed && !stale;
  if (read.isPending) return <Skeleton label="Loading your evals" />;
  if (read.isError) {
    if (read.error instanceof ApiError && (read.error.code === "NOT_ON_CODE_YET" || read.error.status === 404)) return <>{fallback}</>;
    return <div data-testid="eval-card-read-error"><p role="status">{EVAL_CARD_WORDS.readError}</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div>;
  }
  const data: EvalCardView = read.data;
  if (data.unavailable !== undefined) return <p role="status" data-testid="eval-card-unavailable"><VisibleText text={data.unavailable} /></p>;
  if (data.state === "none") return <>{fallback}</>;

  const reread = () => { void query.invalidateQueries({ queryKey: evalCardKey(project) }); void query.invalidateQueries({ queryKey: setupChecklistKey(project) }); };
  const refresh = () => { setDone(false); reread(); };
  function confirmItsYou() { host.signIn(confirmedReturn(host.currentPath(), startStepUpNonce(host.storage)), { stepUp: true }); }
  /** One act: the latch keeps a second press from sending a second one; a sign-in the server finds too old asks again. */
  async function act(name: string, run: () => Promise<unknown>, finished: "reload" | "stay") {
    if (sending.current) return;
    sending.current = true; setBusy(name); setProblem(undefined);
    try { await run(); if (finished === "reload") setDone(true); reread(); }
    catch (caught) {
      if (caught instanceof ApiError && caught.code === "REAUTH_REQUIRED") { if (who !== undefined) forgetConfirmed(host.storage, who); setStale(true); }
      else if (caught instanceof ApiError) setProblem({ message: caught.message, moved: caught.code === "CHANGE_STALE" || caught.code === "IDEMPOTENCY_CONFLICT" });
      else setProblem({ message: EVAL_CARD_WORDS.sendError, moved: false });
    } finally { sending.current = false; setBusy(undefined); }
  }
  const approve = (suite: EvalCardSuite) => {
    const report = data.report;
    if (report === undefined || done) return;
    if (!fresh) { confirmItsYou(); return; }
    // The dollars are the ones this suite showed, passed back exactly as the read sent them.
    void act(`approve:${suite.selection}`, () => api.approve(project, { taskId: report.taskId, reportDigest: report.reportDigest, selection: suite.selection, paths: [...suite.files], approve: true, seen: { perCheckHighMicros: suite.seen.perCheckHighMicros, monthlyCapMicros: suite.seen.monthlyCapMicros } }), "reload");
  };
  const offer = data.spend?.approval;
  const decide = (outcome: "approve" | "reject") => {
    if (offer === undefined || done) return;
    if (!fresh) { confirmItsYou(); return; }
    void act(outcome, () => api.decide(project, { requestId: offer.requestId, outcome, seen: { revision: offer.revision, artifactDigest: offer.artifactDigest } }), "reload");
  };
  const askStepUp = data.canApprove && ((data.state === "propose" && data.suites.length > 0) || ((data.state === "waiting" || data.state === "renew") && offer !== undefined));
  const spend = data.spend;
  const health = data.health;

  return <section aria-label={EVAL_CARD_WORDS.heading} className="rv-approval" data-testid="eval-card" data-state={data.state}>
    <h4>{EVAL_CARD_WORDS.heading}</h4>
    {data.state === "propose" && data.suites.map(suite => <div key={suite.selection} data-testid="eval-suite">
      <p><strong><VisibleText text={suite.selection} /></strong>: {cases(suite.cases)}</p>
      <p data-testid="eval-sentence"><VisibleText text={suite.sentence} /></p>
      {suite.versusApproved !== undefined && <p className="rv-muted" data-testid="eval-versus" data-within={String(suite.versusApproved.within)}><VisibleText text={suite.versusApproved.words} /></p>}
      {data.canApprove && <div className="rv-connect-actions rv-approval-actions"><Button variant="primary" busy={busy === `approve:${suite.selection}`} disabled={busy !== undefined || done} data-testid="eval-approve" onClick={() => { approve(suite); }}>Approve</Button></div>}
    </div>)}
    {data.state === "propose" && data.suites.length === 0 && <p>{EVAL_CARD_WORDS.waiting}</p>}
    {(data.state === "waiting" || data.state === "renew") && <div data-testid="eval-waiting">
      {spend?.needsApproval !== undefined ? <p data-testid="eval-needs-approval"><VisibleText text={spend.needsApproval} /></p> : <p>{data.state === "renew" ? EVAL_CARD_WORDS.renew : EVAL_CARD_WORDS.waiting}</p>}
      {spend?.perPr !== undefined && spend.monthly !== undefined && <p data-testid="eval-spend-line">About <VisibleText text={spend.perPr} /> per PR, at most <VisibleText text={spend.monthly} /> a month.</p>}
      {data.canApprove && offer !== undefined && <div className="rv-connect-actions rv-approval-actions">
        <Button variant="primary" busy={busy === "approve"} disabled={busy !== undefined || done} data-testid="eval-decide-approve" onClick={() => { decide("approve"); }}>Approve</Button>
        <Button busy={busy === "reject"} disabled={busy !== undefined || done} data-testid="eval-decide-reject" onClick={() => { decide("reject"); }}>Not now</Button>
      </div>}
    </div>}
    {data.state === "approved" && spend?.perPr !== undefined && spend.monthly !== undefined && <div data-testid="eval-approved">
      <p><VisibleText text={EVAL_CARD_WORDS.approvedLine(spend.perPr, spend.monthly)} /></p>
      {spend.carried === true && <p className="rv-muted" data-testid="eval-carried">{EVAL_CARD_WORDS.carried}</p>}
    </div>}
    {data.state === "rejected" && <p data-testid="eval-rejected">{EVAL_CARD_WORDS.rejected}</p>}
    {health !== undefined && data.state === "approved" && data.canApprove && (health.state === "none"
      ? <div className="rv-connect-actions rv-approval-actions"><Button busy={busy === "health"} disabled={busy !== undefined} data-testid="eval-health" onClick={() => { void act("health", () => api.health(project, { requestId: crypto.randomUUID(), seenCostMicros: health.seenCostMicros }), "stay"); }}><VisibleText text={health.label} /></Button></div>
      : <p role="status" data-testid="eval-health-state">{health.state === "requested" ? EVAL_CARD_WORDS.queued : EVAL_CARD_WORDS.ran}</p>)}
    {health !== undefined && data.state === "approved" && !data.canApprove && health.state !== "none" && <p role="status" data-testid="eval-health-state">{health.state === "requested" ? EVAL_CARD_WORDS.queued : EVAL_CARD_WORDS.ran}</p>}
    {!data.canApprove && (data.state === "propose" || data.state === "waiting" || data.state === "renew") && <p className="rv-muted" data-testid="eval-who">{EVAL_CARD_WORDS.noOne}</p>}
    {askStepUp && !done && <p className="rv-muted" data-testid="eval-fresh" role="status">{stale ? EVAL_CARD_WORDS.stepUpOld : fresh ? EVAL_CARD_WORDS.stepUpDone : EVAL_CARD_WORDS.stepUp}</p>}
    {problem !== undefined && <div role="alert" data-testid="eval-problem"><p><VisibleText text={problem.message} /></p>{problem.moved && <Button data-testid="eval-refresh" onClick={refresh}>Refresh</Button>}</div>}
  </section>;
}
