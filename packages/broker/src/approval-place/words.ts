// Approval place (U4): the fixed sentences a refused approval says. One module for the server (decide.ts) and for Slack (`slack-refusals.ts`, which only repeats a sentence it recognises), so they cannot drift. Fixed words and our own
// address only: never a person's text.
import type { ApprovalPlaceReason } from "@agentx/cloud-contracts";

const at = (link: string | undefined): string => (link === undefined ? "." : `: ${link}`);

/** Medium risk, from Slack or a comment, by a linked person whose last Rovara sign-in is missing or older than the company's window. */
export const signInAgainWords = (link: string | undefined): string =>
  `This plan is medium risk. You can approve it here after you sign in to Rovara again (by email code or your company sign-in)${link === undefined ? "." : `. Open it in Rovara: ${link}`}`;
/** A rejection (owner decision 99), from Slack or a comment, by a linked person whose last Rovara sign-in is missing or older than the company's window. The same terms as a medium approval, in the rejection's own words. */
export const signInAgainToRejectWords = (link: string | undefined): string =>
  `You can reject this plan here after you sign in to Rovara again (by email code or your company sign-in)${link === undefined ? "." : `. Open it in Rovara: ${link}`}`;
/** Asking for changes (owner decision 99), from Slack or a comment: the same terms, in its own words. */
export const signInAgainToChangeWords = (link: string | undefined): string =>
  `You can ask for changes here after you sign in to Rovara again (by email code or your company sign-in)${link === undefined ? "." : `. Open it in Rovara: ${link}`}`;
/** An outside account that is not linked to a Rovara person of this company. */
export const linkAccountWords = (link: string | undefined): string => `Link your account to Rovara first, then try again${at(link)}`;
/** The person is not the owner or a maintainer of the task's project. */
export const notAnApproverWords = "Only the task owner or a project maintainer can approve this plan.";
/** A maintainer deciding someone else's plan cannot set its run limit: the owner decides money. */
export const RUN_LIMIT_OWNER_DECIDES_WORDS = "A plan's run limit is the task owner's to decide. Ask the owner to approve this plan.";
/** A rejection from an AI tool, the CLI or an API token: those get the plan's card (owner decision 99: Slack and comments by a recently signed-in person may reject; a tool may not). */
export const rejectInAppWords = (link: string | undefined): string => `Rejecting a plan is done in Rovara, signed in${at(link)}`;
/** Asking for changes from an AI tool, the CLI or an API token: the card, as for a rejection. */
export const changesInAppWords = (link: string | undefined): string => `Asking for changes to a plan is done in Rovara, signed in${at(link)}`;
/** The place could not be judged (an unreadable setting, input the policy could not read). */
export const placeUnknownWords = (link: string | undefined): string => `Rovara could not check where this plan can be approved. Open it in Rovara${at(link)}`;
/** The sign-in time or the window could not be read just now. */
export const placeUnavailableWords = "Rovara could not check where this plan can be approved just now; try again in a moment.";

const URL_TAIL = String.raw`(?:\.|: https?:\/\/[^\s<>|]{1,500})`;
const PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`^This plan is medium risk\. You can approve it here after you sign in to Rovara again \(by email code or your company sign-in\)(?:\.|\. Open it in Rovara: https?:\/\/[^\s<>|]{1,500})$`, "u"),
  new RegExp(String.raw`^You can reject this plan here after you sign in to Rovara again \(by email code or your company sign-in\)(?:\.|\. Open it in Rovara: https?:\/\/[^\s<>|]{1,500})$`, "u"),
  new RegExp(String.raw`^You can ask for changes here after you sign in to Rovara again \(by email code or your company sign-in\)(?:\.|\. Open it in Rovara: https?:\/\/[^\s<>|]{1,500})$`, "u"),
  new RegExp(String.raw`^Asking for changes to a plan is done in Rovara, signed in${URL_TAIL}$`, "u"),
  new RegExp(String.raw`^Link your account to Rovara first, then try again${URL_TAIL}$`, "u"),
  new RegExp(String.raw`^Rejecting a plan is done in Rovara, signed in${URL_TAIL}$`, "u"),
  new RegExp(String.raw`^Rovara could not check where this plan can be approved\. Open it in Rovara${URL_TAIL}$`, "u"),
];
const FIXED: ReadonlySet<string> = new Set([notAnApproverWords, placeUnavailableWords, RUN_LIMIT_OWNER_DECIDES_WORDS]);

/** Whether a refusal's text is one of these sentences (so Slack may say it to the presser). */
export const isApprovalPlaceWords = (text: string): boolean => FIXED.has(text) || PATTERNS.some((pattern) => pattern.test(text));

/** Which sentence a reason calls for, when it is not the high/medium risk wording decide.ts already has. */
export function placeWordsFor(reason: ApprovalPlaceReason, link: string | undefined, answer?: "approve" | "request_changes" | "reject"): string | undefined {
  switch (reason) {
    case "sign_in_too_old": case "no_sign_in_time": case "sign_in_in_future": return answer === "reject" ? signInAgainToRejectWords(link) : answer === "request_changes" ? signInAgainToChangeWords(link) : signInAgainWords(link);
    case "not_linked": return linkAccountWords(link);
    case "role_not_allowed": case "collaborator_approvals_off": return notAnApproverWords;
    case "tool_needs_app": return answer === "request_changes" ? changesInAppWords(link) : rejectInAppWords(link);
    case "invalid_setting": case "invalid_input": return placeUnknownWords(link);
    default: return undefined;
  }
}
