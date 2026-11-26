import type { SetupApplyView } from "@agentx/contracts/web";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { APPROVAL_WORDS as T } from "../setup/words.js";
import { changeLines, riskReason } from "../setup/SetupApprovalCard.js";
import "../setup/approval-card.css";
import type { DecisionState } from "./use-decision.js";
import { APPROVE } from "./setup-tab-text.js";

const SHOWN_CHANGES = 5;

/**
 * "Approve this setup?" (3.9, card 2): how the check on a second machine went, the risk in one line, what changed, and who may approve when this person may not. The buttons (Approve this setup, Don't use it) live in the
 * status card, the page's one primary place; this card keeps the facts and, while the check has not passed, the way to discard the setup.
 */
export function ApproveCard({ apply, canManage, decision, newer = false }: { apply: SetupApplyView; canManage: boolean; decision: DecisionState; /** A newer setup beside the one in use: the status card's button only brings the person here, so the answer is given in this card (secondary buttons). */ newer?: boolean }) {
  const lines = changeLines(apply), more = lines.length - SHOWN_CHANGES;
  const unmatched = new Set(apply.usedWithoutMatch ?? []);
  const ready = apply.check.status === "ready", failed = apply.check.status === "failed";
  const mayDecide = ready && apply.approval !== undefined && (apply.canApprove || apply.canReject);
  return <section id="setup-approve" className="rv-setup-card rv-setup-card-quiet" aria-labelledby="rv-setup-approve-title" data-testid="setup-approval" data-risk={apply.risk} data-check={apply.check.status}>
    <h3 id="rv-setup-approve-title">{newer ? APPROVE.headingNewer : ready ? APPROVE.heading : failed ? APPROVE.headingFailed : APPROVE.headingStale}</h3>
    <p data-testid="setup-approval-check">
      {apply.check.status === "checking" && <span role="status">{APPROVE.checking}</span>}
      {ready && <span role="status">{APPROVE.passed}</span>}
      {failed && <span role="alert">{APPROVE.failed(apply.check.failedStep)}{apply.check.failedStep !== undefined && <> <code><VisibleText text={apply.check.failedStep} /></code>. {APPROVE.failedTail}</>}</span>}
      {(apply.check.status === "unchecked" || apply.check.status === "outdated") && <span role="status">{APPROVE.stale}</span>}
    </p>
    {!failed && <p className="rv-approval-risk" data-testid="setup-approval-risk"><strong className={`rv-approval-chip rv-approval-${apply.risk}`}>{T.risk[apply.risk]}</strong> <span>{riskReason(apply)}</span></p>}
    {ready && !mayDecide && <p className="rv-muted" data-testid="setup-approval-who">{T.who[apply.approver]}</p>}
    {unmatched.size > 0 && <p className="rv-muted" data-testid="setup-approval-unmatched-note">{T.withoutMatch.summary(unmatched.size)}</p>}
    <details className="rv-approval-details">
      <summary>{APPROVE.details}</summary>
      <p className="rv-muted">{APPROVE.whatChanged}</p>
      <ul aria-label="What changed">{lines.slice(0, SHOWN_CHANGES).map((text, index) => <li key={index}><VisibleText text={text} /></li>)}</ul>
      {more > 0 && <ul aria-label="More changes">{lines.slice(SHOWN_CHANGES).map((text, index) => <li key={index}><VisibleText text={text} /></li>)}</ul>}
      <p className="rv-muted">Setup commands</p>
      {apply.setup.length === 0 ? <p>None.</p> : <ul aria-label="Setup commands">{apply.setup.map((command, index) => <li key={index}><code><VisibleText text={command} /></code>{unmatched.has(command) && <> <span className="rv-muted" data-testid="setup-approval-unmatched">{T.withoutMatch.tag}</span></>}</li>)}</ul>}
      <p className="rv-muted">Test commands</p>
      {apply.readiness.length === 0 ? <p>None.</p> : <ul aria-label="Test commands">{apply.readiness.map((command, index) => <li key={index}><code><VisibleText text={command} /></code>{unmatched.has(command) && <> <span className="rv-muted" data-testid="setup-approval-unmatched">{T.withoutMatch.tag}</span></>}</li>)}</ul>}
    </details>
    {newer && ready && apply.approval !== undefined && (apply.canApprove || apply.canReject) && <div className="rv-setup-card-actions" data-testid="newer-actions">
      {apply.canApprove && <Button disabled={decision.busy !== undefined || decision.done} busy={decision.busy === "approve"} data-testid="setup-approve" onClick={() => { void decision.decide("approve"); }}>{APPROVE.approveNewer}</Button>}
      {apply.canReject && <Button disabled={decision.busy !== undefined || decision.done} busy={decision.busy === "reject"} data-testid="setup-reject" onClick={() => { void decision.decide("reject"); }}>{"Don't use it"}</Button>}
    </div>}
    {canManage && !ready && <div className="rv-setup-card-actions"><Button busy={decision.busy === "discard"} disabled={decision.busy !== undefined || decision.done} data-testid="setup-discard" onClick={() => { void decision.discard(); }}>{APPROVE.discard}</Button></div>}
  </section>;
}
