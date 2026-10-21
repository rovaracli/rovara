import { z } from "zod";

export const AgentXErrorCodeSchema = z.enum([
  "CONFIG_INVALID",
  "AUTH_REQUIRED",
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
  "SLACK_TEAM_TAKEN",
  "SLACK_TEAM_NOT_BOUND",
  "MODEL_PROXY_UNAVAILABLE",
  "BUDGET_EXCEEDED",
  "ORG_BUDGET_EXCEEDED",
  "TRIAL_LOCKED",
  "TRIAL_GITHUB_USED",
  "MACHINE_TIME_EXCEEDED",
  "AUDIT_RANGE_INVALID",
  "AUDIT_REASON_REQUIRED",
  "AUDIT_UNAVAILABLE",
  "AUDIT_FILTER_TOO_WIDE",
]);

export type AgentXErrorCode = z.infer<typeof AgentXErrorCodeSchema>;

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
  if (code === "FORBIDDEN" || code === "SLACK_TEAM_NOT_BOUND" || code === "PROJECT_ACCESS_DENIED" || code === "PROJECT_TASKS_DISABLED" || code === "TASK_ACCESS_DENIED" || code === "TRIAL_LOCKED") return 403;
  if (code === "NOT_FOUND" || code === "PROJECT_NOT_FOUND" || code === "TASK_NOT_FOUND") return 404;
  if (code === "BUDGET_EXCEEDED" || code === "ORG_BUDGET_EXCEEDED" || code === "MACHINE_TIME_EXCEEDED") return 402;
  if (code === "CONFIG_INVALID" || code === "AUDIT_RANGE_INVALID" || code === "AUDIT_REASON_REQUIRED" || code === "AUDIT_FILTER_TOO_WIDE") return 400;
  if (code === "RUNTIME_UNAVAILABLE" || code === "SLACK_UNAVAILABLE" || code === "MODEL_PROXY_UNAVAILABLE" || code === "AUDIT_UNAVAILABLE") return 503;
  return 409;
}

export function agentXError(code: AgentXErrorCode, message: string): AgentXError {
  return new AgentXError(code, message, errorStatus(code));
}
