// The words of the recent sign-in window screen (lane exp/approval-window). Fixed text; what the server says (a refusal) is shown through VisibleText where it appears.
import { RECENT_SIGN_IN_MAX_SECONDS, RECENT_SIGN_IN_MIN_SECONDS } from "../../../api/approval-window.js";

export const T = {
 TITLE: "Recent sign-in window",
 INTRO: "How recently a person must have signed in to Rovara before they can approve medium-risk work from chat or comments.",
 UNAVAILABLE: "The recent sign-in window is not turned on for your company yet.",
 LOAD_FAILED: "Couldn't load the recent sign-in window.",
 RETRY: "Try again",
 FAILED: "That didn't work. Try again.",
 SIGN_IN_AGAIN: "Sign in again",
 // current
 CURRENT_HEADING: "The window now",
 UNREADABLE: "The company's saved window could not be read, so the default applies and nothing can be changed here until it can be read.",
 DEFAULT_LINE: "This is the default. Your company has not changed it.",
 SET_LINE: "Your company changed this from the default",
 AUDIT_LINK: "Who changed it and when is in the audit log",
 SLACK_GITHUB: "A Slack or GitHub sign-in does not count. Only a sign-in to Rovara by email code or your company sign-in does.",
 // change
 CHANGE_HEADING: "Change the window",
 CHOOSE: "Window length",
 READ_ONLY: "Only company owners and admins can change the window.",
 SAME: "This is the window now.",
 SHORTER: "Shorter: applies at once.",
 LONGER: "Longer: needs a second admin to approve. You will sign in again first if your last sign-in was more than 10 minutes ago.",
 SAVE: "Save window",
 SAVED_SHORTER: "Saved. The window is now",
 ASKED: "Waiting for a second admin. A different admin has to approve a window of",
 // pending
 PENDING_HEADING: "Waiting for a second admin",
 PENDING_MINE: "You asked to lengthen the window",
 PENDING_OTHER: "Another admin asked to lengthen the window",
 PENDING_HIDDEN: "A request to change the window is waiting.",
 ONE_AT_A_TIME: "Only one request can wait at a time. It expires after 7 days.",
 APPROVE: "Approve the longer window",
 CANCEL: "Cancel the request",
 APPROVE_HELP: "Approving needs a sign-in from the last 10 minutes.",
 APPROVED: "Approved. The window is now",
 CANCELLED: "The request was cancelled.",
 // policy
 POLICY_HEADING: "Where each risk level can be decided",
 POLICY_CAPTION: "Where work can be approved, by risk level, and what each place needs. Read only.",
 COL_PLACE: "Where",
 COL_LOW: "Low risk",
 COL_MEDIUM: "Medium risk",
 COL_HIGH: "High risk",
 POLICY_ALSO: "Other answers",
 REQUEST_CHANGES: "Asking for changes works anywhere a linked person can reach.",
 REJECT: "Rejecting is done in Rovara, signed in.",
 NOT_NOW: "\"Not now\" in chat is a dismissal. It decides nothing and the work stays waiting.",
 LINKED: "A linked person is someone whose Slack, GitHub or tracker account is linked to a Rovara person of this company.",
 // why
 WHY_HEADING: "Why this matters",
 WHY: "A longer window means fewer interruptions, because people can approve from chat without opening Rovara. It is also a weaker safeguard: someone who left a session or a chat account open could approve for longer. The longest window is 7 days. Making it longer needs a second admin.",
} as const;

/** "24 hours", "3 days", "1 hour", "90 minutes": the whole-day or whole-hour form when there is one. */
export function durationWords(seconds: number): string {
 const unit = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? "" : "s"}`;
 if (seconds === 86400) return "24 hours";
 if (seconds % 86400 === 0) return unit(seconds / 86400, "day");
 if (seconds % 3600 === 0) return unit(seconds / 3600, "hour");
 if (seconds % 60 === 0) return unit(seconds / 60, "minute");
 return unit(seconds, "second");
}
export const lastWords = (seconds: number): string => seconds === 3600 ? "the last hour" : "the last " + durationWords(seconds);
export const currentSentence = (seconds: number): string => `People can approve medium-risk work from chat or comments if they signed in to Rovara in ${lastWords(seconds)}.`;

const CHOICES = [3600, 14400, 43200, 86400, 259200, 604800] as const;
/** The durations offered: never below the server's minimum or above the server's maximum, and never above 7 days whatever the server says. The current value is kept so the picker can show it. */
export function windowChoices(current: number, minSeconds: number, maxSeconds: number): number[] {
 const high = Math.min(maxSeconds, RECENT_SIGN_IN_MAX_SECONDS), low = Math.max(minSeconds, RECENT_SIGN_IN_MIN_SECONDS);
 const list = CHOICES.filter(value => value >= low && value <= high) as number[];
 if (!list.includes(current)) list.push(current);
 return list.sort((a, b) => a - b);
}
/** "Set to 12 hours by Ada Admin on Nov 11, 2026": whichever of who and when the server sent; nothing when it sent neither. */
export function changedParts(seconds: number, changedBy: string | null | undefined, changedAt: string | null | undefined): { before: string; by?: string; after: string } | undefined {
 const date = changedAt === null || changedAt === undefined ? undefined : new Date(changedAt), day = date === undefined || Number.isNaN(date.getTime()) ? undefined : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
 const who = changedBy === null || changedBy === undefined || changedBy === "" ? undefined : changedBy;
 if (who === undefined && day === undefined) return undefined;
 return { before: `Set to ${durationWords(seconds)}`, ...(who === undefined ? {} : { by: who }), after: (day === undefined ? "" : ` on ${day}`) + "." };
}
export const expires = (iso: string): string => { const date = new Date(iso);return Number.isNaN(date.getTime()) ? "" : `Expires ${date.toLocaleDateString()}.`; };

export interface PolicyRow { place: string; low: string; medium: string; high: string }
/** The policy table of briefs/approval-place-api.md section 1, in words. `window` is the company's window, so the medium column says it. */
export function policyRows(window: number): PolicyRow[] {
 const recent = `Yes, with a linked account and a Rovara sign-in in ${lastWords(window)}.`;
 const noHere = (what: string) => `No. ${what}`;
 const openIn = "No. It gets a link to open in Rovara.";
 return [
  { place: "In Rovara (the app)", low: "Yes, signed in.", medium: "Yes, signed in.", high: "Yes, on the card only, after a sign-in with the email code." },
  { place: "Chat (Slack)", low: "Yes, with a linked account.", medium: recent, high: noHere("Open it in Rovara.") },
  { place: "Tracker comment", low: "Yes, with a linked account.", medium: recent, high: noHere("Open it in Rovara.") },
  { place: "Code host comment (pull request)", low: "Yes, with a linked account.", medium: recent, high: noHere("Open it in Rovara.") },
  { place: "AI tool, CLI or token", low: "Yes.", medium: openIn, high: openIn },
 ];
}
