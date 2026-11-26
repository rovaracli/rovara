import { useRef, useState } from "react";
import type { SetupApplyView, SetupDecideReply } from "@agentx/contracts/web";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { APPROVAL_WORDS as T } from "./words.js";
import "./approval-card.css";

/** The most change lines the card shows at first; the rest are one click away. */
const SHOWN_CHANGES = 5;
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Why the risk is what it is, in plain words (from the changed areas the server read; never from model text). */
export function riskReason(apply: Pick<SetupApplyView, "risk" | "changes">): string {
  if (apply.risk === "low") return T.why.low;
  if (apply.risk === "medium") return T.why.medium;
  const high = apply.changes.filter(change => change.risk === "high").map(change => T.area[change.area]);
  return high.length === 0 ? T.why.highUnknown : `It changes ${high.join(", ")}.`;
}

export function changeLines(apply: SetupApplyView): string[] {
  return apply.changes.map(change => {
    if (change.area === "setup_commands") return `Setup commands: ${String(apply.setup.length)} to run`;
    if (change.area === "test_commands") return `Test commands: ${String(apply.readiness.length)} to run`;
    if (change.area === "prompt_locations" && apply.promptLocations !== undefined) return `Where the AI prompts live: ${apply.promptLocations.join("; ")}`;
    return `${sentence(T.area[change.area])} changed`;
  });
}

/**
 * "Use this setup" approval (L4-D2, DEC 254z b): the candidate Rovara made, its risk in plain words, what changed, who may approve, and how its check on a fresh workspace went. Approve and Reject show only for a person Code says
 * may give that answer (no dead buttons); anyone else reads one line about who approves. One press decides (owner DEC 254zzz73 removed the step-up), bound to exactly the
 * revision and digest the read offered (never shown). A candidate that moved shows Cloud's fixed refusal and a Refresh. The server decides everything; this card only asks.
 */
export function SetupApprovalCard({ project, apply, canManage, onDecided, onRefresh }: { project: string; apply: SetupApplyView; canManage: boolean; onDecided: (reply: SetupDecideReply | "discarded") => void; onRefresh: () => void }) {
  const api = useSetupAgentApi();
  const [done, setDone] = useState(false), [busy, setBusy] = useState<"approve" | "reject" | "discard">(), [problem, setProblem] = useState<{ message: string; moved: boolean }>();
  const sending = useRef(false);
  const lines = changeLines(apply), more = lines.length - SHOWN_CHANGES;
  const unmatched = new Set(apply.usedWithoutMatch ?? []);
  const ready = apply.check.status === "ready", failed = apply.check.status === "failed";
  const approval = apply.approval;

  async function decide(outcome: "approve" | "reject") {
    if (approval === undefined || sending.current) return;
    sending.current = true; setBusy(outcome); setProblem(undefined);
    try {
      const reply = await api.decide(project, { requestId: approval.requestId, outcome, seen: { revision: approval.revision, artifactDigest: approval.artifactDigest } });
      // Decided: nothing more can be pressed while the page reads the project again.
      setDone(true); onDecided(reply);
    } catch (caught) {
      if (caught instanceof ApiError) setProblem({ message: caught.message, moved: caught.code === "CHANGE_STALE" || caught.code === "IDEMPOTENCY_CONFLICT" || caught.code === "PROJECT_REVISION_MISMATCH" });
      else setProblem({ message: "Couldn't send that. Try again.", moved: false });
    } finally { sending.current = false; setBusy(undefined); }
  }
  async function discard() {
    if (sending.current) return;
    sending.current = true; setBusy("discard"); setProblem(undefined);
    try { await api.discard(project, crypto.randomUUID()); setDone(true); onDecided("discarded"); }
    catch (caught) { setProblem({ message: caught instanceof ApiError ? caught.message : "Couldn't discard it. Try again.", moved: caught instanceof ApiError && caught.code === "CHANGE_STALE" }); }
    finally { sending.current = false; setBusy(undefined); }
  }
  const allowed = ready && approval !== undefined && (apply.canApprove || apply.canReject);

  return <section aria-label={T.heading} className="rv-approval" data-testid="setup-approval" data-risk={apply.risk} data-check={apply.check.status}>
    <h4>{T.heading}</h4>
    <p className="rv-approval-risk" data-testid="setup-approval-risk"><strong className={`rv-approval-chip rv-approval-${apply.risk}`}>{T.risk[apply.risk]}</strong> <span>{riskReason(apply)}</span></p>
    <h5>What changed</h5>
    <ul aria-label="What changed" className="rv-approval-changes">
      {lines.slice(0, SHOWN_CHANGES).map((text, index) => <li key={index}><VisibleText text={text} /></li>)}
    </ul>
    <p className="rv-approval-check" data-testid="setup-approval-check">
      {apply.check.status === "checking" && <span role="status">{T.check.checking}</span>}
      {ready && <span role="status">{T.check.ready}</span>}
      {failed && <span role="alert">{T.check.failed}{apply.check.failedStep !== undefined && <> Failed at <code><VisibleText text={apply.check.failedStep} /></code>.</>}</span>}
      {(apply.check.status === "unchecked" || apply.check.status === "outdated") && <span role="status">{T.check.stale}</span>}
    </p>
    <p className="rv-muted" data-testid="setup-approval-who">{T.who[apply.approver]}</p>
    {unmatched.size > 0 && <p className="rv-proposal-meta" data-testid="setup-approval-unmatched-note">{T.withoutMatch.summary(unmatched.size)}</p>}
    <details className="rv-approval-details">
      <summary>Details</summary>
      {more > 0 && <ul aria-label="More changes">{lines.slice(SHOWN_CHANGES).map((text, index) => <li key={index}><VisibleText text={text} /></li>)}</ul>}
      <p className="rv-proposal-meta">Setup commands</p>
      {apply.setup.length === 0 ? <p>None.</p> : <ul aria-label="Setup commands">{apply.setup.map((command, index) => <li key={index}><code><VisibleText text={command} /></code>{unmatched.has(command) && <> <span className="rv-proposal-meta" data-testid="setup-approval-unmatched">{T.withoutMatch.tag}</span></>}</li>)}</ul>}
      <p className="rv-proposal-meta">Test commands</p>
      {apply.readiness.length === 0 ? <p>None.</p> : <ul aria-label="Test commands">{apply.readiness.map((command, index) => <li key={index}><code><VisibleText text={command} /></code>{unmatched.has(command) && <> <span className="rv-proposal-meta" data-testid="setup-approval-unmatched">{T.withoutMatch.tag}</span></>}</li>)}</ul>}
    </details>
    <div className="rv-connect-actions rv-approval-actions">
      {allowed && apply.canApprove && <Button variant="primary" busy={busy === "approve"} disabled={busy !== undefined || done} data-testid="setup-approve" onClick={() => { void decide("approve"); }}>Approve</Button>}
      {allowed && apply.canReject && <Button variant="danger" busy={busy === "reject"} disabled={busy !== undefined || done} data-testid="setup-reject" onClick={() => { void decide("reject"); }}>Reject</Button>}
      {canManage && !ready && <Button busy={busy === "discard"} disabled={busy !== undefined || done} data-testid="setup-discard" onClick={() => { void discard(); }}>Discard this setup</Button>}
    </div>
    {problem !== undefined && <div role="alert" data-testid="setup-approval-problem"><p><VisibleText text={problem.message} /></p>{problem.moved && <Button data-testid="setup-approval-refresh" onClick={onRefresh}>Refresh</Button>}</div>}
  </section>;
}
