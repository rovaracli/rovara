// What the worker reads from a Pi session's events, shared by a coding task (run-task.ts) and an agent step
// (agent-run/run-agent-step.ts): the end of a model turn, whether it failed, and the kind of an event for the log.
import { agentXError } from "@agentx/contracts";
import { budgetExhaustedFromMarker } from "@agentx/model-runtime";
import { redactCredentials } from "./events.js";

export interface AssistantOutcome {
  stopReason: string;
  errorMessage?: string;
}

/** The outcome an assistant message_end event reports, or undefined for any other event. */
export function assistantOutcome(event: unknown): AssistantOutcome | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
  if (value.type !== "message_end" || value.message?.role !== "assistant" || typeof value.message.stopReason !== "string") return undefined;
  return {
    stopReason: value.message.stopReason,
    ...(typeof value.message.errorMessage === "string" ? { errorMessage: value.message.errorMessage } : {}),
  };
}

/**
 * A turn whose last model call failed or was aborted is not a success. The error message comes
 * from pi or AgentX's OpenRouter transport, which already omit prompts and keys; it is still
 * redacted and bounded before it becomes the task's error.
 */
export function failedTurn(outcome: AssistantOutcome | undefined): Error | undefined {
  if (outcome?.stopReason === "error") {
    // A spent AI budget ends the task with its own category and words, and it can be continued once the budget is raised.
    const exhausted = budgetExhaustedFromMarker(outcome.errorMessage);
    if (exhausted !== undefined) return exhausted;
    const detail = String(redactCredentials(outcome.errorMessage ?? "no error message")).slice(0, 1_000);
    return agentXError("RUNTIME_UNAVAILABLE", `the model call failed: ${detail}`);
  }
  // The caller reports it as CANCELLED when a cancellation was requested, and as FAILED otherwise.
  if (outcome?.stopReason === "aborted") return agentXError("OPERATION_INTERRUPTED", "the model call was aborted");
  return undefined;
}

export function eventType(event: unknown): "progress" | "tool_start" | "tool_end" {
  if (event && typeof event === "object" && "type" in event) {
    const type = event.type;
    if (type === "tool_execution_start") return "tool_start";
    if (type === "tool_execution_end" || type === "tool_result") return "tool_end";
  }
  return "progress";
}
