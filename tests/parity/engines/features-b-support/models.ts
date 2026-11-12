// Model selection (area 24): the model each step of the task was told to run on, read from the worker invocations each path sent (a task step's
// `payload.model`, Code's and Cloud's one `ModelSelectionSchema`). Under each install's defaults: what the composition root has to map is exactly where
// these differ (S0-Q2: Cloud's project and company model settings onto the core's model selection service).
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
