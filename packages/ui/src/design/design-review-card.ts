// Design review (DR11): the small rules a decision card follows for a design under review. Pure.
import { DECISION_APPROVE_REASON_MAX } from "@agentx/contracts/web";

/** The approve card's open blockers, read from the card's own "Open blockers" evidence chip (the broker's count, never a model's). Zero when the card has no such chip. */
export function openBlockersOnCard(chips: ReadonlyArray<{ label: string; value: string }>): number {
 const chip = chips.find(candidate => candidate.label === "Open blockers");
 const count = chip === undefined ? 0 : Number.parseInt(chip.value, 10);
 return Number.isInteger(count) && count > 0 ? count : 0;
}

export const APPROVE_REASON_HINT = "One plain line. It is shown on the pull request's Proof line, so write it for the people who read the pull request.";

/**
 * The reason as it is sent: one line, with control and hidden characters (bidirectional marks too) turned into spaces, runs of space made one, and nothing left over at either end. Undefined when nothing is left,
 * so the Approve button stays off until the person has said why. It is cut at the contract's limit; the broker cleans it again where it is used.
 */
export function cleanApproveReason(text: string): string | undefined {
 const line = Array.from(text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, DECISION_APPROVE_REASON_MAX).join("").trim();
 return line === "" ? undefined : line;
}
