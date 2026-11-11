// Approval place (U4): the server side of the one policy. `approvalPlaceDecision` (contracts) is a pure function; this reads what it needs (who the person is outside the app, when they last signed in to Rovara, the company's window)
// and runs it. Nothing here decides a rule: every rule is in the function, so the app, a chat and a comment cannot disagree.
//   * "Linked": a chat press is linked when the Slack user's verified Slack sign-in belongs to the very developer pressing (`developerOfSlackUser`). The stand-in identity of a Slack user who never signed in is not.
//   * "Recent": the person's last INTERACTIVE sign-in by email code or company sign-in (OIDC, SAML). A Slack or GitHub sign-in is not a Rovara sign-in (owner answer Q3), and a refresh is not a sign-in.
//   * The window is read only when a medium approval comes from outside the app (the one case that needs it); a window that cannot be read refuses the approval, it is never guessed.
import { type ApprovalDeciderRole, type ApprovalDecisionKind, type ApprovalPlace, type ApprovalPlaceAnswer, type ApprovalPlaceRisk, type ApprovalPlaceVerdict, type DeveloperSignInMethod } from "@agentx/cloud-contracts";
import { approvalPlaceDecision, isOutsideApprovalPlace } from "@agentx/cloud-contracts";
import { DeveloperSignInStore } from "../developer/store.js";
import { SLACK_WORKFLOW_SESSION_ID } from "../developer/task-records.js";
import { readApprovalWindow } from "./window-setting.js";

/** The session id of a caller built for a Slack decision card press (`aws/broker/decision-press.ts`): the Slack user was resolved to their real, linked Rovara person. */
export const SLACK_DECISION_SESSION_ID = "slack-decision";
/**
 * Whether a caller reached the server through a chat press. Only the two callers the Slack code builds are: a card press (a real linked person) and the legacy workflow button (a stand-in for a Slack user). A person who signed in WITH Slack
 * and calls the API with their token is not in a chat: their token is a tool's (`amr` says how they signed in, not where they are).
 */
export const isChatCaller = (caller: { sessionId: string }): boolean => caller.sessionId === SLACK_DECISION_SESSION_ID || caller.sessionId === SLACK_WORKFLOW_SESSION_ID;

/** The sign-in methods that are a Rovara sign-in for this rule: the email code ("cloud") and the company's own sign-in. Never Slack or GitHub (Q3). */
export const RECENT_SIGN_IN_METHODS: readonly DeveloperSignInMethod[] = ["cloud", "oidc", "saml"];

export interface PlaceDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Absent on an install with no sign-in table: nobody is then linked or recent for an outside place, so only the app (and a tool, for low risk) can approve. */
  signInTableName?: string | undefined;
  now(): number;
}

export interface PlaceCaller { developerId: string; sessionId: string; slackUserId?: string | undefined }

export interface PlaceQuestion {
  orgId: string;
  caller: PlaceCaller;
  kind: ApprovalDecisionKind;
  risk: ApprovalPlaceRisk;
  answer: ApprovalPlaceAnswer;
  place: ApprovalPlace;
  role: ApprovalDeciderRole;
  /** The company's fresh sign-in step was satisfied for this decision (the decide-grade email code on the card). */
  freshSignIn: boolean;
  /** A comment feed (a tracker, a code host) resolved the comment's author to this very person through a verified link before calling. Only server code sets it. Chat is checked here instead. */
  commentAuthorLinked?: true | undefined;
}

export interface PlaceAnswer {
  verdict: ApprovalPlaceVerdict;
  /** For the audit record of an approval from outside the app: the window and how old the sign-in was, in whole seconds. */
  windowSeconds?: number;
  signInAgeSeconds?: number;
}

/**
 * Runs the policy for one decision. Throws only when something it must read cannot be read (the sign-in store, the window): the caller refuses and says to try again, it never approves on a guess.
 * The legacy carve-out (owner decision U2/Q5 is a separate switch): a task started in Slack by someone who never signed in has the Slack stand-in as its owner; that owner keeps approving their own LOW plan from Slack
 * until the implicit-member path is removed, so this change widens nothing and breaks nothing. They are never linked for a medium plan (no sign-in time), and a high plan is not approved from chat at all.
 */
export async function evaluateApprovalPlace(deps: PlaceDependencies, question: PlaceQuestion): Promise<PlaceAnswer> {
  const outside = isOutsideApprovalPlace(question.place);
  const needsRecent = outside && question.answer === "approve" && question.risk === "medium";
  const store = deps.signInTableName === undefined ? undefined : new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.signInTableName, nameTableName: deps.tableName, now: () => deps.now() });
  let linked = true;
  if (outside) {
    if (question.place === "chat") {
      const slackUserId = question.caller.slackUserId;
      linked = store !== undefined && slackUserId !== undefined && (await store.developerOfSlackUser(slackUserId)) === question.caller.developerId;
      if (!linked && question.caller.sessionId === SLACK_WORKFLOW_SESSION_ID && question.role === "owner" && question.risk === "low" && question.answer === "approve") linked = true;
    } else {
      linked = question.commentAuthorLinked === true;
    }
  }
  const authTime = needsRecent && linked && store !== undefined ? await store.lastInteractiveSignInAt(question.caller.developerId, RECENT_SIGN_IN_METHODS) : undefined;
  const window = needsRecent ? await readApprovalWindow(deps, question.orgId) : undefined;
  const nowMs = deps.now();
  const verdict = approvalPlaceDecision({
    kind: question.kind, risk: question.risk, answer: question.answer, place: question.place,
    decider: { role: question.role, linked, authTime },
    // An unreadable stored window is enforced as its 1-hour minimum (`readApprovalWindow`). Plan decisions never have a collaborator seat (the seat is the owner or a maintainer), so the project switch is
    // not read here; product decisions read it live (`product-decisions/store.ts`).
    settings: { recentSignIn: { seconds: window?.seconds ?? 86_400 }, collaboratorApprovals: true },
    freshSignIn: question.freshSignIn, nowMs,
  });
  const age = authTime === undefined ? undefined : Math.max(0, Math.floor((nowMs - Date.parse(authTime)) / 1000));
  return { verdict, ...(window === undefined ? {} : { windowSeconds: window.seconds }), ...(age === undefined ? {} : { signInAgeSeconds: age }) };
}
