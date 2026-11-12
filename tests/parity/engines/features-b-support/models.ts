// Model selection (area 24): the model each step of the task was told to run on, read from the worker invocations each path sent (a task step's
// `payload.model`, Code's and Cloud's one `ModelSelectionSchema`). Under each install's defaults: what the composition root has to map is exactly where
// these differ. S0-Q2 maps Cloud's model choice onto the core's port (cloud/app/model-mapping.ts); the core tells the worker its model through the route it
// records on each operation (`modelChoice`, vendor core/task-flow/step-model.ts), and `payload.model` only carries a thinking level, so the core's words
// are read from what it recorded.
import type { WorkerInvocation } from "@rovara-code/contracts";
import { outcome } from "./outcomes.js";

export function modelWords(invocations: readonly WorkerInvocation[]): string[] {
  const words = invocations.flatMap((invocation) => {
    if (invocation.kind !== "task") return [];
    const payload = invocation.payload as { workflowMode?: string; model?: { provider?: string; modelId?: string } };
    const model = payload.model === undefined ? "none" : `${String(payload.model.provider)}/${String(payload.model.modelId)}`;
    return [outcome("models", `${String(payload.workflowMode ?? "task")}:${model}`)];
  });
  return [...new Set(words)];
}

const createdOf = (operation: Record<string, unknown>): string => (typeof operation["createdAt"] === "string" ? operation["createdAt"] : "");

/** The core's words: the model each workflow step's operation recorded as its choice (the route the worker was given names the same model). */
export function coreModelWords(operations: ReadonlyArray<Record<string, unknown>>): string[] {
  // In the order the steps ran (the operations are read by random id).
  const ordered = [...operations].sort((a, b) => createdOf(a).localeCompare(createdOf(b)));
  const words = ordered.flatMap((operation) => {
    const choice = operation["modelChoice"] as { model?: { provider?: string; modelId?: string } } | undefined;
    if (typeof operation["workflowMode"] !== "string" || choice?.model === undefined) return [];
    return [outcome("models", `${operation["workflowMode"]}:${String(choice.model.provider)}/${String(choice.model.modelId)}`)];
  });
  return [...new Set(words)];
}
