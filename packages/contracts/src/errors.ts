import { z } from "zod";

export const AgentXErrorCodeSchema = z.enum([
  "CONFIG_INVALID",
  "AUTH_REQUIRED",
  "REAUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "PROJECT_REVISION_MISMATCH",
  "WORKSPACE_NOT_READY",
  "WORKSPACE_BUSY",
  "IDEMPOTENCY_CONFLICT",
  "RUNTIME_UNAVAILABLE",
  "OPERATION_INTERRUPTED",
  "CONVERSATION_STATE_LOST",
  "CALLBACK_FORBIDDEN",
  "STALE_FENCE",
  "PROJECT_NOT_FOUND",
  "PROJECT_ACCESS_DENIED",
  "PROJECT_TASKS_DISABLED",
  "TASK_NOT_FOUND",
  "TASK_ACCESS_DENIED",
  "TASK_BUSY",
  "CHANNEL_REQUIRED",
  "WORKSPACE_LIMIT",
  "SLACK_UNAVAILABLE",
  "CHANNEL_AMBIGUOUS",
  "CONFIRMATION_UNAVAILABLE",
  "CONFIRMATION_DECLINED",
  "CONFIRMATION_EXPIRED",
  "CHANGE_STALE",
  "ALREADY_IN_ORG",
  "INVITE_INVALID",
  "INVITE_WRONG_EMAIL",
  "SLACK_TEAM_TAKEN",
  "REMOVED_FROM_ORG",
  "LAST_OWNER",
  "SLACK_TEAM_NOT_BOUND",
  "MODEL_PROXY_UNAVAILABLE",
  "BUDGET_EXCEEDED",
  "ORG_BUDGET_EXCEEDED",
  "TRIAL_LOCKED",
  "TRIAL_GITHUB_USED",
  "MACHINE_TIME_EXCEEDED",
  "AGENT_REVISION_CONFLICT",
  "AGENT_UNAVAILABLE",
  "AGENT_NOT_ON_PROJECT",
  "AGENT_TOOL_NOT_GRANTED",
  "MODEL_NOT_ALLOWED",
  "PROJECT_BUDGET_EXCEEDED",
  "AGENT_BUDGET_EXCEEDED",
  "AGENT_BUDGET_REQUIRED",
  "TEST_ALLOWANCE_USED",
  "APPROVAL_CLOSED",
  "AUDIT_RANGE_INVALID",
  "AUDIT_REASON_REQUIRED",
  "AUDIT_UNAVAILABLE",
  "AUDIT_FILTER_TOO_WIDE",
  "PROJECT_NAME_TAKEN",
  "PROJECT_ARCHIVED",
  "GITHUB_NOT_CONNECTED",
  "GITHUB_INSTALLATION_TAKEN",
  "TOO_MANY_REQUESTS",
]);

export type AgentXErrorCode = z.infer<typeof AgentXErrorCodeSchema>;

/** What INVITE_WRONG_EMAIL (409) says: an email-targeted invite was presented by a sign-in whose verified email is another address. */
export const INVITE_WRONG_EMAIL_MESSAGE = "This invite is for a different email address. Sign in with the address it was sent to, or ask for an invite to yours.";

/** What GITHUB_INSTALLATION_TAKEN (409) says: the GitHub account's installation is bound to another Rovara organization. */
export const GITHUB_INSTALLATION_TAKEN_MESSAGE = "This GitHub account is already connected to another Rovara organization.";

export class AgentXError extends Error {
  constructor(
    readonly code: AgentXErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "AgentXError";
  }
}

export function errorStatus(code: AgentXErrorCode): number {
  if (code === "AUTH_REQUIRED") return 401;
  // The sign-in is valid but too old, or the wrong kind, for this change: 403, so a client does not treat it as a sign-in that ended.
  if (code === "REAUTH_REQUIRED" || code === "FORBIDDEN" || code === "SLACK_TEAM_NOT_BOUND" || code === "PROJECT_ACCESS_DENIED" || code === "PROJECT_TASKS_DISABLED" || code === "TASK_ACCESS_DENIED" || code === "TRIAL_LOCKED" || code === "AGENT_NOT_ON_PROJECT" || code === "AGENT_TOOL_NOT_GRANTED" || code === "MODEL_NOT_ALLOWED" || code === "REMOVED_FROM_ORG" || code === "GITHUB_NOT_CONNECTED") return 403;
  if (code === "NOT_FOUND" || code === "PROJECT_NOT_FOUND" || code === "TASK_NOT_FOUND") return 404;
  if (code === "BUDGET_EXCEEDED" || code === "ORG_BUDGET_EXCEEDED" || code === "MACHINE_TIME_EXCEEDED" || code === "PROJECT_BUDGET_EXCEEDED" || code === "AGENT_BUDGET_EXCEEDED" || code === "TEST_ALLOWANCE_USED") return 402;
  if (code === "CONFIG_INVALID" || code === "AUDIT_RANGE_INVALID" || code === "AUDIT_REASON_REQUIRED" || code === "AUDIT_FILTER_TOO_WIDE") return 400;
  if (code === "TOO_MANY_REQUESTS") return 429;
  if (code === "RUNTIME_UNAVAILABLE" || code === "SLACK_UNAVAILABLE" || code === "MODEL_PROXY_UNAVAILABLE" || code === "AUDIT_UNAVAILABLE") return 503;
  return 409;
}

export function agentXError(code: AgentXErrorCode, message: string): AgentXError {
  return new AgentXError(code, message, errorStatus(code));
}

/** What a refusal to reach a repository through the org's GitHub connection says (GITHUB_NOT_CONNECTED, Plan 2). */
export const githubNotConnectedMessage = (fullName: string) => `Rovara can't reach ${fullName} through your organization's GitHub connection. Connect it with: agentx github connect`;
