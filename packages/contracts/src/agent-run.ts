import { z } from "zod";

export const RUN_INPUT_TEXT_MAX_BYTES = 8192;

export const RUN_INPUT_CONTEXT_MAX = 10;

export const RUN_INPUT_REF_MAX = 512;

export const RUN_INPUT_TITLE_MAX = 200;

export const RUN_INPUT_BODY_MAX_BYTES = 16_384;

export const RUN_CONTEXT_KINDS = ["ticket", "pull_request", "deploy", "alert", "report", "text"] as const;

export const utf8 = new TextEncoder();

export function boundedBytes(max: number) {
  return z.string().min(1).refine((text) => utf8.encode(text).length <= max, `must be at most ${max} bytes`);
}

export const RunContextItemSchema = z.object({
  kind: z.enum(RUN_CONTEXT_KINDS),
  ref: z.string().min(1).max(RUN_INPUT_REF_MAX),
  title: z.string().min(1).max(RUN_INPUT_TITLE_MAX).optional(),
  body: boundedBytes(RUN_INPUT_BODY_MAX_BYTES).optional(),
}).strict();

/** The request an agent run is given: the text, and information from elsewhere that is shown as information only. */
export const RunInputSchema = z.object({
  text: boundedBytes(RUN_INPUT_TEXT_MAX_BYTES),
  context: z.array(RunContextItemSchema).max(RUN_INPUT_CONTEXT_MAX).optional(),
}).strict();

export const AGENT_RUN_STATES = ["RUNNING", "WAITING_FOR_APPROVAL", "PAUSED_BUDGET", "COMPLETE", "FAILED", "CANCELLED"] as const;

export const AGENT_RUN_STEP_STATUSES = ["pending", "running", "waiting", "done", "failed"] as const;

export const AGENT_REPORT_MAX_BYTES = 32_768;
