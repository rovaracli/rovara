import { Button } from "../../../design/Button.js";
import { T } from "./lessons-text.js";
import "./lessons.css";

/** The request to go back to Standard, as the people who decide see it (the project's Lessons tab and the company page). The server has the last word on every tap; this only decides what is offered. */
export interface PresetProposalShown { changeId: string; mine: boolean; soleOwner: boolean }

/**
 * A request to go back to Standard that waits for a person. A different maintainer or admin (owner or admin for the company) can approve or cancel it; the person who asked can cancel it, and approve it only when
 * they are the only person who can (the server then asks for a short wait). Shown to people who decide and nobody else: `canDecide` is false for a reader and the box is not drawn at all.
 */
export function PresetProposalBox({ proposal, scope, canDecide, busy, onApprove, onCancel }: { proposal: PresetProposalShown; scope: "project" | "company"; canDecide: boolean; busy: boolean; onApprove: () => void; onCancel: () => void }) {
 if (!canDecide) return null;
 const company = scope === "company";
 const words = !proposal.mine ? (company ? T.PRESET_PENDING_THEIRS_COMPANY : T.PRESET_PENDING_THEIRS) : proposal.soleOwner ? T.PRESET_PENDING_SOLE : (company ? T.PRESET_PENDING_MINE_COMPANY : T.PRESET_PENDING_MINE);
 return <section aria-label={T.PRESET_PENDING_TITLE} className="rv-lessons-preset-pending">
  <h3>{T.PRESET_PENDING_TITLE}</h3>
  <p>{words}</p>
  <div className="rv-lessons-preset-actions">
   {(!proposal.mine || proposal.soleOwner) && <Button variant="primary" busy={busy} onClick={onApprove}>{T.PRESET_APPROVE}</Button>}
   <Button variant="quiet" busy={busy} onClick={onCancel}>{T.PRESET_CANCEL}</Button>
  </div>
 </section>;
}
