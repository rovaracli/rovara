// Lane 7 (DECISIONS 47, 68): ONE model call for the lessons replay, on the company's own model path: a grading of a replayed copy, or a call of an arm's offline lesson pipeline. It is the only learning-model path that is
// NOT behind the install's lessons switch (`gatedByLessonsSwitch`), and it is reached only by `POST /v1/admin/projects/{project}/lessons-replay/model` (a company owner or admin, audited, counted in the run's budget).
// Why it may: a grading is not learning (it writes nothing to any lesson), and the offline pipeline runs on the operator's explicit say-so in eval mode (decision 68), over the same historical tasks for every arm.
// What still holds: the model's own quote (no usable model, every model forbidden or too dear is a refusal with the fixed code), the call's hold limited to what the caller allows, and the company's learning month
// (`LearningSpend`): a call the month has no room for is refused before it is made. Nothing is stored; the answer is the text and the cost.
import type { LearningSpend, PipelineModel } from "./ports.js";
import { spendLook } from "./pause.js";

export const EVAL_MODEL_OUTPUT_MAX_TOKENS = 4_000;
export const EVAL_MODEL_INPUT_MAX_CHARS = 120_000;

export class EvalModelRefusal extends Error {
  constructor(readonly code: "no_model" | "too_dear" | "month_full" | "too_large" | "failed") { super(`the replay model call was refused (${code})`); this.name = "EvalModelRefusal"; }
}

export async function evalModelCall(deps: { model: PipelineModel; spend: LearningSpend }, input: { workspaceId: string; project: string; system: string; user: string; maxOutputTokens: number; maxHoldUsd: number }): Promise<{ text: string; costUsd: number; /** The model that answered, as the company's route names it (a grading is only comparable across runs when this does not change). */ model: string }> {
  if (input.system.length + input.user.length > EVAL_MODEL_INPUT_MAX_CHARS || input.maxOutputTokens > EVAL_MODEL_OUTPUT_MAX_TOKENS || input.maxOutputTokens < 1) throw new EvalModelRefusal("too_large");
  const request = { purpose: "judge" as const, system: input.system, user: input.user, maxOutputTokens: input.maxOutputTokens, workspaceId: input.workspaceId, project: input.project, maxHoldUsd: input.maxHoldUsd };
  let estimate = input.maxHoldUsd;
  if (deps.model.quote !== undefined) {
    const quoted = await deps.model.quote(request).catch(() => undefined);
    if (quoted === undefined || !quoted.ok) throw new EvalModelRefusal("no_model");
    if (quoted.usd > input.maxHoldUsd + 1e-9) throw new EvalModelRefusal("too_dear");
    estimate = quoted.usd;
  }
  if ((await spendLook(deps.spend, input.workspaceId, estimate)) !== "ok") throw new EvalModelRefusal("month_full");
  try {
    const reply = await deps.model.complete({ ...request, budgetUsd: estimate });
    return { text: reply.text, costUsd: reply.costUsd, model: reply.model };
  } catch { throw new EvalModelRefusal("failed"); }
}
