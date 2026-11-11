// The one proposal that waits: who proposed it, why, how it differs from the current rules, and what this person may do about it. The buttons follow what the server says (`viewer`, `approval`); the server decides again on every press.
import { useState } from "react";
import { useCompanyRulesApi } from "../../../api/company-rules.js";
import { Button } from "../../../design/Button.js";
import { Checkbox } from "../../../design/Checkbox.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { SOURCE_WORDS, T } from "./company-rules-text.js";
import { formatDay, formatWhen, Person } from "./format.js";
import { DiffView, RulesList } from "./parts.js";
import { toDiff, toRules } from "./rules-logic.js";
import type { Proposal, State } from "./types.js";
import { useRulesWrite } from "./use-rules-write.js";

export function PendingProposal({ state, proposal, onStatus }: { state: State; proposal: Proposal; onStatus: (text: string) => void }) {
 const api = useCompanyRulesApi(), write = useRulesWrite(onStatus), [acknowledged, setAcknowledged] = useState(false);
 const { approval } = proposal, mine = proposal.proposedByYou, fromRepo = proposal.source === "repo";
 const soleOwner = mine ? approval.soleOwner : null;
 const canDecide = state.viewer.canDecide && !mine;
 const blockedWhy = approval.reason === "stale" ? T.STALE : approval.reason === "expired" ? T.EXPIRED : undefined;
 return <section aria-labelledby="cr-pending" className="rv-cr-card" aria-busy={write.busy}><h2 id="cr-pending">{T.PENDING_HEADING}</h2>
  <p role="status"><strong>{mine ? T.WAITING_SECOND_ADMIN : fromRepo ? "A change from the repository file is waiting for an admin" : "A change is waiting for your decision"}</strong></p>
  <dl className="rv-cr-facts">
   <div><dt>Proposed by</dt><dd><Person person={proposal.proposedBy} />{mine ? " (you)" : ""}</dd></div>
   <div><dt>From</dt><dd>{SOURCE_WORDS[proposal.source] ?? "Rovara"}</dd></div>
   <div><dt>Proposed</dt><dd>{formatWhen(proposal.proposedAt)}</dd></div>
   <div><dt>Expires</dt><dd>{formatDay(proposal.expiresAt)}</dd></div>
   <div><dt>Written against</dt><dd>{proposal.baseVersion === 0 ? "no version yet" : `version ${String(proposal.baseVersion)}`}</dd></div>
   {proposal.note !== null && <div><dt>{fromRepo ? "Commit message" : "Note"}</dt><dd><VisibleText text={proposal.note} /></dd></div>}
  </dl>
  {blockedWhy !== undefined && <p role="note" className="rv-cr-alert">{blockedWhy}</p>}
  <h3>{T.DIFF_PENDING}</h3>
  <DiffView diff={toDiff(proposal.diff)} label="The proposal against the current rules" />
  <details><summary>Show the proposed rules in full</summary><RulesList rules={toRules(proposal.rules)} label="Proposed rules" /></details>
  {mine && <p>{T.YOU_PROPOSED}</p>}
  {canDecide && approval.freshSignInNeeded && <p className="rv-muted">{T.FRESH_SIGN_IN}</p>}
  {canDecide && fromRepo && <p className="rv-muted">{T.REPO_REJECT}</p>}
  {mine && soleOwner !== null && <div className="rv-cr-sole"><h3>{T.SOLE_OWNER_HEADING}</h3>
   <p>{soleOwner.available ? T.SOLE_OWNER_AVAILABLE : (T.SOLE_OWNER_REASON[soleOwner.reasonCode] ?? T.SOLE_OWNER_REASON.SECOND_PERSON_REQUIRED!)}{!soleOwner.available && soleOwner.availableAt !== null && soleOwner.reasonCode === "SOLE_OWNER_COOL_OFF" ? ` From ${formatWhen(soleOwner.availableAt)}.` : ""}</p>
   {soleOwner.available && <><Checkbox label={T.SOLE_OWNER_ACK} checked={acknowledged} onCheckedChange={value => { setAcknowledged(value === true); }} />
    <div><Button variant="primary" busy={write.busy} disabled={!acknowledged} onClick={() => { void write.run(() => api.approve(proposal.proposalId, proposal.digest, true), T.APPROVED); }}>{T.SOLE_OWNER_APPROVE}</Button></div></>}
  </div>}
  <div className="rv-cr-actions">
   {canDecide && <Button variant="primary" busy={write.busy} disabled={!approval.canApprove} onClick={() => { void write.run(() => api.approve(proposal.proposalId, proposal.digest), T.APPROVED); }}>{T.APPROVE}</Button>}
   {canDecide && <Button busy={write.busy} onClick={() => { void write.run(() => api.reject(proposal.proposalId, proposal.digest), T.REJECTED); }}>{T.REJECT}</Button>}
   {mine && <Button busy={write.busy} onClick={() => { void write.run(() => api.cancel(proposal.proposalId), T.CANCELLED); }}>{T.CANCEL}</Button>}
  </div>
  {write.view}
 </section>;
}
