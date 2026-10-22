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
  "PROJECT_NAME_TAKEN",
  "PROJECT_ARCHIVED",
  "GITHUB_NOT_CONNECTED",
  "GITHUB_INSTALLATION_TAKEN",
]);

export type AgentXErrorCode = z.infer<typeof AgentXErrorCodeSchema>;

/** What LAST_OWNER (409) says: the organization's last owner may not step down, leave or be removed. */
export const LAST_OWNER_MESSAGE = "An organization needs at least one owner. Make someone else an owner first.";

/** What PROJECT_NAME_TAKEN (409) says. The name is shown between backticks; the caller has checked it is a project name. */
export const projectNameTakenMessage = (name: string): string => `Your organization already has a project named \`${name}\` (it may be archived). Choose another name.`;

/** What PROJECT_ARCHIVED (409) says, whichever new work or change it refuses. */
export const projectArchivedMessage = (name: string): string => `Project \`${name}\` is archived. Ask a project maintainer to restore it.`;

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
  if (code === "REAUTH_REQUIRED" || code === "FORBIDDEN" || code === "SLACK_TEAM_NOT_BOUND" || code === "PROJECT_ACCESS_DENIED" || code === "PROJECT_TASKS_DISABLED" || code === "TASK_ACCESS_DENIED" || code === "TRIAL_LOCKED" || code === "REMOVED_FROM_ORG" || code === "GITHUB_NOT_CONNECTED") return 403;
  if (code === "NOT_FOUND" || code === "PROJECT_NOT_FOUND" || code === "TASK_NOT_FOUND") return 404;
  if (code === "BUDGET_EXCEEDED" || code === "ORG_BUDGET_EXCEEDED" || code === "MACHINE_TIME_EXCEEDED") return 402;
  if (code === "CONFIG_INVALID") return 400;
  if (code === "RUNTIME_UNAVAILABLE" || code === "SLACK_UNAVAILABLE" || code === "MODEL_PROXY_UNAVAILABLE") return 503;
  return 409;
}

export function agentXError(code: AgentXErrorCode, message: string): AgentXError {
  return new AgentXError(code, message, errorStatus(code));
}

/** What a refusal to reach a repository through the org's GitHub connection says (GITHUB_NOT_CONNECTED, Plan 2). */
export const githubNotConnectedMessage = (fullName: string) => `Rovara can't reach ${fullName} through your organization's GitHub connection. Connect it with: agentx github connect`;
