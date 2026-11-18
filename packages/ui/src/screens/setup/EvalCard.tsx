import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { EvalCardSuite, EvalCardView, EvalHealthResult, EvalWrapperCard } from "@agentx/contracts/web";
import { evalCardKey, useEvalCardApi } from "../../api/eval-card.js";
import { setupChecklistKey } from "../../api/setup-checklist.js";
import { ApiError } from "../../api/errors.js";
import { EvalWrapperCardView } from "./EvalWrapperCard.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import "./approval-card.css";

const cases = (n: number) => `${String(n)} eval ${n === 1 ? "case" : "cases"}`;

/** What the card itself says (everything else it shows is Code's own sentence, in dollars). No counts, no technical units: only dollars and plain words. */
export const EVAL_CARD_WORDS = {
  heading: "Approve the cost of running your evals",
  noOne: "A company owner, admin or this project's maintainer approves this cost.",
  waiting: "Your eval cost is waiting for approval.",
  renew: "The person who approved your eval cost can no longer approve it. A company owner, admin or maintainer needs to approve it again.",
  rejected: "The eval cost was not approved, so Rovara does not run your evals on each AI change.",
  approvedLine: (perPr: string, monthly: string) => `Rovara runs your evals on each AI change: about ${perPr} per PR, at most ${monthly} a month.`,
  carried: "Your eval cases changed and stayed inside what you approved.",
  queued: "Your eval check is queued",
  running: "Your eval check is running",
  ran: "Your eval check ran",
  notSaved: "Measured, but the result could not be saved as your baseline.",
  reused: "Rovara already had these results saved, so nothing was run.",
  casePassed: "Passed", caseFailed: "Failed",
  /** L4-T3 (G2, setup experience review 5.4): the AI the evals call, and whether the company's connection to it stands. The provider's name is Code's (what setup found), never made up here. */
  callsLine: (provider: string) => `Your evals call ${provider}. Rovara runs them on your own AI account, so the spend and the data stay with you.`,
  providerNotConnected: (provider: string) => `${provider} is not connected for this project. Connect it in Company settings, Product AI keys.`,
  providerConnected: (provider: string) => `${provider} is connected.`,
  connectLink: (provider: string) => `Connect ${provider}`,
  checkAgain: "Check again",
  checking: "Checking",
  approveAfterConnect: (provider: string) => `Connect ${provider} first. Then you can approve.`,
  approvedNotConnected: (provider: string) => `Approved. Evals start running when ${provider} is connected.`,
  readError: "Your evals couldn't be read just now. Try again.",
  sendError: "Couldn't send that. Try again.",
  wrapperHeading: "Rovara can't read your eval's results yet",
} as const;

/** What the health check's answer says: counts and plain words only, never an answer's text. */
export const EVAL_HEALTH_WORDS = {
  resultLine: (r: EvalHealthResult) => `Checked ${cases(r.questionCount)}: ${String(r.passedAnswers)} of ${String(r.totalAnswers)} answers passed.`,
  differing: (n: number) => `${cases(n)} gave different answers on different runs.`,
  caseMixed: (passes: number) => `Passed ${String(passes)} of 3 times`,
} as const;
/** How often the card reads again while a check waits or runs (milliseconds); never otherwise. */
export const EVAL_HEALTH_POLL_MS = 15_000;
export const evalHealthPollMs = (state: string | undefined): number | false => (state === "requested" || state === "running" ? EVAL_HEALTH_POLL_MS : false);
type Problem = { message: string; moved: boolean };

/**
 * The setup flow's ONE eval card (L4-EVC, DEC 254zzz20 D5, D6, D8). Eval spending is approved once, on one card, in plain dollars. The server decides everything (who may approve, the dollars held
 * against its own figures); this card only asks. One press decides (owner DEC 254zzz73 removed the step-up it once needed). The `seen` dollars
 * are copied from the read, never worked out here. The health check is OPT-IN: it is only ever sent from a click, never on load, and only for a person who may approve.
 * `fallback` is shown when Code has no eval card yet or there is nothing to approve. `secondary` is a quieter choice of the page's own shown right under the card (the checklist's
 * "This project has no evals", so it stays open while Code's card shows).
 */
export function EvalCard({ project, fallback, secondary }: { project: string; fallback: ReactNode; secondary?: ReactNode }) {
  const api = useEvalCardApi(), query = useQueryClient();
  // While a check waits or runs, the card reads again by itself (a person who pressed the button wants its answer); otherwise only when told to.
  const read = useQuery({ queryKey: evalCardKey(project), queryFn: () => api.read(project), retry: false,
    refetchInterval: (q) => evalHealthPollMs(q.state.data?.health?.state) });
  const [busy, setBusy] = useState<string>(), [problem, setProblem] = useState<Problem>(), [done, setDone] = useState(false);
  const sending = useRef(false);
  // One id per card view: Code keeps a health request once per id, so a press that failed and is pressed again is the same request, never a second one. Made on a click, never on a render.
  const healthId = useRef<string | undefined>(undefined);
  // A press that was answered keeps its id until Code's answer settles (a double press is the same request); once a check ran or did not run, the next press is a new request.
  const settled = read.data?.health?.state === "not_run" || read.data?.health?.state === "finished";
  useEffect(() => { if (settled) healthId.current = undefined; }, [settled]);
  if (read.isPending) return <Skeleton label="Loading your evals" />;
  if (read.isError && read.data === undefined) {
    if (read.error instanceof ApiError && (read.error.code === "NOT_ON_CODE_YET" || read.error.status === 404)) return <>{fallback}</>;
    return <div data-testid="eval-card-read-error"><p role="status">{EVAL_CARD_WORDS.readError}</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div>;
  }
  const data: EvalCardView = read.data;
  if (data.unavailable !== undefined) return <p role="status" data-testid="eval-card-unavailable"><VisibleText text={data.unavailable} /></p>;
  if (data.state === "none") return <>{fallback}</>;

  const reread = () => { void query.invalidateQueries({ queryKey: evalCardKey(project) }); void query.invalidateQueries({ queryKey: setupChecklistKey(project) }); };
  const refresh = () => { setDone(false); healthId.current = undefined; reread(); };
  /** One act: the latch keeps a second press from sending a second one. */
  async function act(name: string, run: () => Promise<unknown>, finished: "reload" | "stay") {
    if (sending.current) return;
    sending.current = true; setBusy(name); setProblem(undefined);
    try { await run(); if (finished === "reload") setDone(true); reread(); }
    catch (caught) {
      if (caught instanceof ApiError) setProblem({ message: caught.message, moved: caught.code === "CHANGE_STALE" || caught.code === "IDEMPOTENCY_CONFLICT" });
      else setProblem({ message: EVAL_CARD_WORDS.sendError, moved: false });
    } finally { sending.current = false; setBusy(undefined); }
  }
  const approve = (suite: EvalCardSuite) => {
    const report = data.report;
    if (report === undefined || done) return;
    // The dollars are the ones this suite showed, passed back exactly as the read sent them.
    void act(`approve:${suite.selection}`, () => api.approve(project, { taskId: report.taskId, reportDigest: report.reportDigest, selection: suite.selection, paths: [...suite.files], approve: true, seen: { perCheckHighMicros: suite.seen.perCheckHighMicros, monthlyCapMicros: suite.seen.monthlyCapMicros } }), "reload");
  };
  const offer = data.spend?.approval;
  const decide = (outcome: "approve" | "reject") => {
    if (offer === undefined || done) return;
    void act(outcome, () => api.decide(project, { requestId: offer.requestId, outcome, seen: { revision: offer.revision, artifactDigest: offer.artifactDigest } }), "reload");
  };
  // L4-T3: the provider line. `connected` is Code's own answer (the model gateway's key check); absent means Code cannot tell, and the card says neither. Approve waits for a connected provider.
  const provider = data.provider;
  const notConnected = provider !== undefined && data.connected === false;
  const spend = data.spend;
  const health = data.health;

  return <><section aria-label={EVAL_CARD_WORDS.heading} className="rv-approval" data-testid="eval-card" data-state={data.state}>
    <h4>{EVAL_CARD_WORDS.heading}</h4>
    {(data.wrappers ?? []).length > 0 && <div data-testid="eval-wrappers" aria-label={EVAL_CARD_WORDS.wrapperHeading}>
      {(data.wrappers ?? []).map((wrapper: EvalWrapperCard) => <EvalWrapperCardView key={`${wrapper.selection}:${wrapper.language}`} project={project} card={wrapper} canManage={data.canApprove} onChanged={reread} />)}
    </div>}
    {provider !== undefined && data.state !== "rejected" && <div data-testid="eval-provider" data-connected={data.connected === undefined ? "unknown" : String(data.connected)}>
      <p data-testid="eval-provider-calls"><VisibleText text={EVAL_CARD_WORDS.callsLine(provider)} /></p>
      {data.connected === true && <p data-testid="eval-provider-state" role="status"><VisibleText text={EVAL_CARD_WORDS.providerConnected(provider)} /></p>}
      {notConnected && <>
        <p data-testid="eval-provider-state" role="status"><VisibleText text={data.state === "approved" ? EVAL_CARD_WORDS.approvedNotConnected(provider) : EVAL_CARD_WORDS.providerNotConnected(provider)} /></p>
        <div className="rv-connect-actions rv-approval-actions">
          <Link to={`/app/admin/product-ai?project=${encodeURIComponent(project)}`} data-testid="eval-provider-connect"><VisibleText text={EVAL_CARD_WORDS.connectLink(provider)} /></Link>
          <Button busy={read.isFetching} disabled={read.isFetching} data-testid="eval-provider-check" onClick={() => { void read.refetch(); }}>{read.isFetching ? EVAL_CARD_WORDS.checking : EVAL_CARD_WORDS.checkAgain}</Button>
        </div>
      </>}
    </div>}
    {data.state === "propose" && data.suites.map(suite => <div key={suite.selection} data-testid="eval-suite">
      <p><strong><VisibleText text={suite.selection} /></strong>: {cases(suite.cases)}</p>
      {suite.readable === false ? <p data-testid="eval-needs-file"><VisibleText text={suite.needsFile ?? "Rovara can't read this eval's results yet."} /></p> : <p data-testid="eval-sentence"><VisibleText text={suite.sentence} /></p>}
      {suite.versusApproved !== undefined && <p className="rv-muted" data-testid="eval-versus" data-within={String(suite.versusApproved.within)}><VisibleText text={suite.versusApproved.words} /></p>}
      {data.canApprove && suite.readable !== false && <div className="rv-connect-actions rv-approval-actions"><Button variant="primary" busy={busy === `approve:${suite.selection}`} disabled={busy !== undefined || done || notConnected} data-testid="eval-approve" onClick={() => { approve(suite); }}>Approve</Button></div>}
    </div>)}
    {data.state === "propose" && data.suites.length === 0 && <p>{EVAL_CARD_WORDS.waiting}</p>}
    {(data.state === "waiting" || data.state === "renew") && <div data-testid="eval-waiting">
      {spend?.needsApproval !== undefined ? <p data-testid="eval-needs-approval"><VisibleText text={spend.needsApproval} /></p> : <p>{data.state === "renew" ? EVAL_CARD_WORDS.renew : EVAL_CARD_WORDS.waiting}</p>}
      {spend?.perPr !== undefined && spend.monthly !== undefined && <p data-testid="eval-spend-line">About <VisibleText text={spend.perPr} /> per PR, at most <VisibleText text={spend.monthly} /> a month.</p>}
      {data.canApprove && offer !== undefined && <div className="rv-connect-actions rv-approval-actions">
        <Button variant="primary" busy={busy === "approve"} disabled={busy !== undefined || done || notConnected} data-testid="eval-decide-approve" onClick={() => { decide("approve"); }}>Approve</Button>
        <Button busy={busy === "reject"} disabled={busy !== undefined || done} data-testid="eval-decide-reject" onClick={() => { decide("reject"); }}>Not now</Button>
      </div>}
    </div>}
    {data.state === "approved" && spend?.perPr !== undefined && spend.monthly !== undefined && <div data-testid="eval-approved">
      <p><VisibleText text={EVAL_CARD_WORDS.approvedLine(spend.perPr, spend.monthly)} /></p>
      {spend.carried === true && <p className="rv-muted" data-testid="eval-carried">{EVAL_CARD_WORDS.carried}</p>}
    </div>}
    {data.state === "rejected" && <p data-testid="eval-rejected">{EVAL_CARD_WORDS.rejected}</p>}
    {health !== undefined && data.state === "approved" && <HealthBlock health={health} canAsk={data.canApprove} busy={busy} onAsk={() => { void act("health", () => api.health(project, { requestId: (healthId.current ??= crypto.randomUUID()), seenCostMicros: health.seenCostMicros }), "stay"); }} />}
    {notConnected && data.canApprove && (data.state === "propose" || data.state === "waiting" || data.state === "renew") && <p className="rv-muted" data-testid="eval-approve-waits">{EVAL_CARD_WORDS.approveAfterConnect(provider)}</p>}
    {!data.canApprove && (data.state === "propose" || data.state === "waiting" || data.state === "renew") && <p className="rv-muted" data-testid="eval-who">{EVAL_CARD_WORDS.noOne}</p>}
    {problem !== undefined && <div role="alert" data-testid="eval-problem"><p><VisibleText text={problem.message} /></p>{problem.moved && <Button data-testid="eval-refresh" onClick={refresh}>Refresh</Button>}</div>}
  </section>{secondary}</>;
}

type Health = NonNullable<EvalCardView["health"]>;
const passWords = (passes: number) => (passes === 3 ? EVAL_CARD_WORDS.casePassed : passes === 0 ? EVAL_CARD_WORDS.caseFailed : EVAL_HEALTH_WORDS.caseMixed(passes));

/** The opt-in health check, as Code reports it: the button (never sent on load), a waiting or running line, why it did not run, or pass or fail per case. */
function HealthBlock({ health, canAsk, busy, onAsk }: { health: Health; canAsk: boolean; busy: string | undefined; onAsk: () => void }) {
  const button = canAsk && (health.state === "none" || health.state === "not_run")
    ? <div className="rv-connect-actions rv-approval-actions"><Button busy={busy === "health"} disabled={busy !== undefined} data-testid="eval-health" onClick={onAsk}><VisibleText text={health.label} /></Button></div>
    : undefined;
  if (health.state === "none") return button ?? null;
  if (health.state === "not_run") return <>{health.words !== undefined && <p role="status" data-testid="eval-health-words"><VisibleText text={health.words} /></p>}{button}</>;
  const line = health.state === "requested" ? EVAL_CARD_WORDS.queued : health.state === "running" ? EVAL_CARD_WORDS.running : EVAL_CARD_WORDS.ran;
  const result = health.state === "finished" ? health.result : undefined;
  return <>
    <p role="status" data-testid="eval-health-state">{line}</p>
    {result !== undefined && <div data-testid="eval-health-result">
      <p data-testid="eval-health-summary">{EVAL_HEALTH_WORDS.resultLine(result)}</p>
      {result.reused && <p className="rv-muted" data-testid="eval-health-reused">{EVAL_CARD_WORDS.reused}</p>}
      {result.differing > 0 && <p className="rv-muted" data-testid="eval-health-differing">{EVAL_HEALTH_WORDS.differing(result.differing)}</p>}
      {!result.saved && <p className="rv-muted" data-testid="eval-health-not-saved">{EVAL_CARD_WORDS.notSaved}</p>}
      <ul data-testid="eval-health-cases">{result.cases.map(c => <li key={c.id} data-passes={c.passes}><VisibleText text={c.id} />: {passWords(c.passes)}</li>)}</ul>
    </div>}
  </>;
}
