// Design review stage, DR10 (3.7): WHO is told when a design review waits on people. PURE: the caller reads the setting, the directory and the edition fresh and passes them in. A reminder grants nobody any authority (what
// a person may do is still decided by the handlers when they act), so this only chooses whom to tell, and fails toward telling the requester alone.
//   - 24 hours: the people asked. For a question card, the requester (and the high-risk approver when the review is about a high-risk area); for the design card, the requester, or the high-risk approver on a high design;
//     for the cost hold, the requester.
//   - 72 hours, the park and the close: the same people and the project's maintainers ("waiting on Priya for 3 days").
//   - THE APPROVER LEFT: the configured high-risk approver is no longer an eligible member (a named person who left, a group or a maintainer set that is now empty). The remaining eligible approvers are asked; when the
//     configured set is gone altogether, the project's maintainers are asked instead (3.7: they are asked to name one). When nobody is eligible, the requester and the company's owners are told so.
import { type DesignReason, type DesignReviewSetting } from "@rovara-code/contracts";
import { type EditionPolicy } from "@agentx/cloud-contracts";
import { highRiskApprovers, type DesignApproverDirectory } from "./approval.js";
import type { DesignWaitNoticeStep } from "./wait-clock.js";
import { isHighRiskCodes } from "./risk.js";

export type WaitAudienceCode = "normal" | "approver_left" | "nobody_eligible" | "unreadable";

export interface WaitAudience {
  /** The people the wait is on (who can act now). */
  asked: string[];
  /** The project's maintainers, who are also told from 72 hours. */
  maintainers: string[];
  /** Told that nobody can act (code `nobody_eligible`): the company's owners. */
  escalate: string[];
  code: WaitAudienceCode;
}

const same = (left: string, right: string): boolean => left.normalize("NFC").trim().toLowerCase() === right.normalize("NFC").trim().toLowerCase();
const has = (list: readonly string[], id: string): boolean => list.some((entry) => same(entry, id));
const unique = (ids: readonly string[]): string[] => ids.filter((id, index) => ids.findIndex((other) => same(other, id)) === index);
/** The most people one reminder goes to. */
export const WAIT_RECIPIENTS_MAX = 8;

export interface WaitAudienceInput {
  kind: "answers" | "cost" | "decision";
  requesterId: string;
  /** Understand's reasons stored on the review: they can only raise the tier. */
  reasons: readonly DesignReason[];
  setting: Pick<DesignReviewSetting, "highRiskApprover">;
  /** Undefined: the directory could not be read. Nobody is guessed. */
  directory: DesignApproverDirectory | undefined;
  edition: EditionPolicy | undefined;
}

export function waitAudienceOf(input: WaitAudienceInput): WaitAudience {
  const { requesterId, directory } = input;
  if (directory === undefined || !directory.people.complete) return { asked: [requesterId], maintainers: [], escalate: [], code: "unreadable" };
  const maintainers = unique(directory.people.eligibleIds.filter((id) => !has(directory.notApproverIds, id) && !same(id, requesterId))).slice(0, WAIT_RECIPIENTS_MAX);
  const about = input.kind !== "cost" && isHighRiskCodes(input.reasons);
  if (!about) return { asked: [requesterId], maintainers, escalate: [], code: "normal" };
  const approvers = highRiskApprovers(input.setting, directory, input.edition);
  if (approvers.ok) {
    const configured = input.setting.highRiskApprover;
    const lost = configured.kind === "people" && configured.memberIds.some((id) => !has(approvers.ids, id));
    // The requester is still told on a question card (they are always asked); on a design card they cannot approve a high design, but they should know it waits.
    return { asked: unique([...approvers.ids, requesterId]).slice(0, WAIT_RECIPIENTS_MAX), maintainers: maintainers.filter((id) => !has(approvers.ids, id)), escalate: [], code: lost ? "approver_left" : "normal" };
  }
  if (approvers.code === "no_high_risk_approver") {
    if (maintainers.length > 0) return { asked: unique([...maintainers, requesterId]).slice(0, WAIT_RECIPIENTS_MAX), maintainers: [], escalate: [], code: "approver_left" };
    return { asked: [requesterId], maintainers: [], escalate: unique(directory.people.ownerIds.filter((id) => !same(id, requesterId))).slice(0, WAIT_RECIPIENTS_MAX), code: "nobody_eligible" };
  }
  return { asked: [requesterId], maintainers, escalate: [], code: "unreadable" };
}

/** Who gets the notice for a step. Always the requester, so the person who asked always knows. */
export function waitRecipients(audience: WaitAudience, step: DesignWaitNoticeStep, requesterId: string): string[] {
  const base = step === "24h" ? audience.asked : [...audience.asked, ...audience.maintainers];
  return unique([requesterId, ...base, ...audience.escalate]).slice(0, WAIT_RECIPIENTS_MAX);
}
