// Convergence A6 (`cloud/people`): the names Cloud's Approvers and IdentityProvider adapters use on Code's ports (lane P3, item A3: the plug-in that knows its methods names them).
// Each approval method is one of the places Cloud's approval-place rule already knows (`approval-place/evaluate.ts`), so the adapter adds no place and drops none:
//   browser-session  a live signed-in browser session (the web boundary's cookie, `authenticateDeveloperSessionId`)                          -> place `browser`
//   browser-step-up  the same session plus the decide-grade sign-in (an email code in the last 10 minutes, `isDecideGradeSession`)       -> place `browser`, fresh sign-in
//   chat-slack       a decision card press in Slack by the linked, signed-in person behind it (`resolveSlackDecisionCaller`)               -> place `chat`
//   api-token        a developer token (the CLI, an AI tool, the API: `authenticateDeveloper`)                                              -> place `tool`
// `chat-slack` starts with Code's `chat-` prefix, so Code's core treats it as a comment-like method that never approves high risk and never rejects (core/decisions/strong-methods.ts). Since owner decision 99 Cloud
// lets Slack reject inside the company's window, so the adapter names it among the reject methods and core's drop is owed upstream (gaps.ts G7).
// The comment places (`tracker-comment`, `code-host-comment`) have no feed in Cloud yet (approval-place/comment-decision.ts), so the adapter offers no comment method.
import type { ApprovalPlace } from "@agentx/cloud-contracts";

export const BROWSER_SESSION_METHOD = "browser-session";
export const BROWSER_STEP_UP_METHOD = "browser-step-up";
export const CHAT_SLACK_METHOD = "chat-slack";
export const API_TOKEN_METHOD = "api-token";

/** Every approval method, in the order a surface offers them. */
export const CLOUD_APPROVAL_METHODS = [BROWSER_SESSION_METHOD, BROWSER_STEP_UP_METHOD, CHAT_SLACK_METHOD, API_TOKEN_METHOD] as const;
export type CloudApprovalMethod = (typeof CLOUD_APPROVAL_METHODS)[number];

/** The only method strong enough for a high-risk approval (the card in a signed-in browser under the decide-grade sign-in). */
export const CLOUD_STRONG_METHODS: readonly CloudApprovalMethod[] = [BROWSER_STEP_UP_METHOD];
/** The methods that may reject or ask for changes (owner decision 99: like a medium approval, so a signed-in browser or Slack inside the company's window; never a tool, which gets the card's link). */
export const CLOUD_REJECT_METHODS: readonly CloudApprovalMethod[] = [BROWSER_SESSION_METHOD, BROWSER_STEP_UP_METHOD, CHAT_SLACK_METHOD];

/** The approval-place `place` of each method. */
export const PLACE_OF_METHOD: Readonly<Record<CloudApprovalMethod, ApprovalPlace>> = {
  [BROWSER_SESSION_METHOD]: "browser",
  [BROWSER_STEP_UP_METHOD]: "browser",
  [CHAT_SLACK_METHOD]: "chat",
  [API_TOKEN_METHOD]: "tool",
};

export const isCloudApprovalMethod = (method: string): method is CloudApprovalMethod => (CLOUD_APPROVAL_METHODS as readonly string[]).includes(method);

/** Credential schemes the identity adapter reads: a developer token (`Authorization: Bearer`) and the browser's opaque review session id (the session cookie's value). */
export const BEARER_SCHEME = "bearer";
export const BROWSER_SESSION_SCHEME = "browser-session";

/** The outside account provider id for a Slack user (`ExternalAccountRef.provider`). */
export const SLACK_ACCOUNT_PROVIDER = "slack";
