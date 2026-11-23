// The page's facts, read from the served view (Code's `GET /v1/app/projects/{p}/browser-testing`). Pure: nothing here asks Code, and nothing here guesses a fact the view does not serve.
import type { BrowserTestingFault, BrowserTestingFound, BrowserTestingProof, BrowserTestingSummary, BrowserTestingView } from "@agentx/contracts/web";
import { viewerTime } from "../../../design/viewer-time.js";
import { BT } from "./browser-testing-text.js";

export type Chip = { label: string; kind: "plain" | "ok" | "bad" | "attn" };

/** A recorded instant in the viewer's own locale and zone (never a fixed zone). */
export const whenOf = (iso: string | null | undefined): string => (iso === null || iso === undefined ? "" : viewerTime(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
export const minutesLabel = (ms: number): string => { const minutes = Math.round(ms / 60_000); return `${minutes} minute${minutes === 1 ? "" : "s"}`; };

export const hasFault = (view: BrowserTestingView, fault: BrowserTestingFault): boolean => view.faults.includes(fault);
/** A real fault the person can read: the sandbox cannot start, the test accounts could not be refreshed, or the approved setup cannot be read. Never an "off for this company" state. */
export const faulty = (view: BrowserTestingView): boolean => view.faults.length > 0;

/** The setup a person is looking at in the cards: the checked candidate's stored summary, else the approved one, else the draft. */
export function shownSummary(view: BrowserTestingView): BrowserTestingSummary | null {
  if (view.candidate !== null && view.candidate.summary !== null) return view.candidate.summary;
  if (view.approved !== null) return view.approved.summary;
  return view.draft === null ? null : { found: view.draft.found, proof: view.draft.proof, runTimeoutMs: view.draft.runTimeoutMs };
}
export const firstApplication = (found: BrowserTestingFound) => found.applications[0];
export const signInsDeclared = (found: BrowserTestingFound): boolean => found.applications.some((app) => app.signInDeclared && app.userKinds.length > 0);
export const kindNames = (found: BrowserTestingFound): string[] => found.applications.flatMap((app) => app.userKinds.map((kind) => kind.profileId));
export const proofText = (proof: BrowserTestingProof): string => (proof.screenshotMode === "all" ? BT.shotsAll : BT.shotsFailed) + (proof.video ? BT.withVideo : "");

/** The page's chip: a fault is "Needs attention"; else the served state. */
export function chipOf(view: BrowserTestingView): Chip {
  if (faulty(view)) return { label: BT.chipFault, kind: "bad" };
  if (view.state === "on") return { label: BT.chipOn, kind: "ok" };
  switch (view.state) {
    case "paused": return { label: BT.chipPaused, kind: "plain" };
    case "waiting": return { label: BT.chipWaiting, kind: "attn" };
    case "checking": return { label: BT.chipChecking, kind: "plain" };
    case "check-failed": return { label: BT.chipFailed, kind: "bad" };
    case "draft": return { label: BT.chipDraft, kind: "plain" };
    default: return { label: BT.chipNone, kind: "plain" };
  }
}

/** Whether a change that is waiting beside the approved setup is only a choices change (Discard is for that kind only: a repo change is found again by the next read). */
export const choicesChangeOnly = (view: BrowserTestingView): boolean => view.newerChange !== null && view.newerChange.kind === "choices";

/**
 * What is true about the approved setup while a repo change waits: for a new kind of user alone, checks keep using the approved version; if how the app starts, or a kind of user that was already there, changed, a check may
 * not run until it is approved (the account check refuses a changed definition until then).
 */
export function newerSentence(view: BrowserTestingView): string {
  const approved = view.approved?.summary?.found, newer = view.newerChange;
  if (approved === undefined || newer === null) return BT.newerKeeps;
  const same = (left: BrowserTestingFound, right: BrowserTestingFound) => JSON.stringify(left.applications.map((app) => ({ ...app, userKinds: app.userKinds.filter((kind) => !newer.newUserKinds.includes(kind.profileId)) }))) === JSON.stringify(right.applications);
  return same(newer.found, approved) && newer.removedUserKinds.length === 0 ? BT.newerKeeps : BT.newerMaySkip;
}
/** One line naming the change: "a new kind of user, editor". */
export function newerWhat(view: BrowserTestingView): string {
  const newer = view.newerChange;
  if (newer === null) return "";
  if (newer.kind === "choices") return BT.changeFoundChoices;
  const parts = [newer.newUserKinds.length > 0 ? BT.newKinds(newer.newUserKinds) : "", newer.removedUserKinds.length > 0 ? BT.removedKinds(newer.removedUserKinds) : ""].filter((part) => part !== "");
  return parts.length === 0 ? `${BT.changeFoundRepo}` : `${BT.changeFoundRepo}: ${parts.join("; ")}`;
}

/** Why "Read the repo again" is off, when it is: Code takes no new reading while a check runs, a failed check is kept, or another setup change waits. */
export function refreshBlock(view: BrowserTestingView): string | undefined {
  if (view.candidate !== null) return view.candidate.status === "checking" ? BT.refreshWhileChecking : BT.refreshAfterClear;
  if (view.setupWaiting) return BT.refreshWhileSetupWaiting;
  return view.draft?.locked === true ? BT.refreshAfterClear : undefined;
}
