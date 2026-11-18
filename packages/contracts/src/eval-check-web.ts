// L4-EVCI2 (Thursday fallback): the setup checklist's "Eval check from your CI". Rovara Code reads the project's workflow files, proposes the jobs that look like an eval, and keeps the one a maintainer confirms;
// Code then shows that check's result on its pull requests. Cloud rebuilds every answer from these fields (cloud-server/src/eval-check-routes.ts); the page parses them again. The words are Rovara's: a check's name
// and a workflow's path are the customer's own and are shown as text only.
import { z } from "zod";

export const EVAL_CHECK_LIMITS = { name: 200, source: 200, items: 5, repository: 100, workflow: 256 } as const;
export const EVAL_CHECK_VERDICTS = ["proposals", "none_found", "unknown"] as const;
const oneLine = (max: number) => z.string().min(1).max(max).regex(/^[^\p{Cc}\p{Cf}]+$/u);

export const EvalCheckSchema = z.object({ name: oneLine(EVAL_CHECK_LIMITS.name), source: oneLine(EVAL_CHECK_LIMITS.source).optional() }).strict();
export type EvalCheck = z.infer<typeof EvalCheckSchema>;
export const EvalCheckProposalSchema = z.object({
  name: oneLine(EVAL_CHECK_LIMITS.name), source: oneLine(EVAL_CHECK_LIMITS.source).optional(),
  workflow: oneLine(EVAL_CHECK_LIMITS.workflow), repository: oneLine(EVAL_CHECK_LIMITS.repository), basis: z.enum(["name", "commands"]),
}).strict();
export type EvalCheckProposal = z.infer<typeof EvalCheckProposalSchema>;

export const EvalCheckViewSchema = z.object({
  project: z.string().min(1).max(100),
  canManage: z.boolean(),
  /** The confirmed check, or null: none chosen. */
  confirmed: EvalCheckSchema.nullable(),
  /** What setup read from the workflow files. Only a person who manages the setup gets it; null for a reader. */
  proposals: z.object({ verdict: z.enum(EVAL_CHECK_VERDICTS), items: z.array(EvalCheckProposalSchema).max(EVAL_CHECK_LIMITS.items), cut: z.boolean() }).strict().nullable(),
  explanation: z.string().min(1).max(200),
}).strict();
export type EvalCheckView = z.infer<typeof EvalCheckViewSchema>;

/** The confirm: one of the proposals, or null for none. */
export const EvalCheckSetBodySchema = z.object({ requestId: z.string().uuid(), check: EvalCheckSchema.nullable() }).strict();
export type EvalCheckSetBody = z.infer<typeof EvalCheckSetBodySchema>;

/** The fixed sentences a refusal of this card is shown in (Cloud's own words and Code's two exact ones); the page shows no other text of a refusal. */
export const EVAL_CHECK_SENTENCES_LIST = [
  "Only company owners and admins, or this project's admins, can choose the eval check.",
  "That is not a check Rovara found in your workflow files. Open the setup again to see the list.",
  "Rovara could not read your workflow files just now, so it cannot confirm a check. Try again.",
  "The record of this change could not be written, so nothing was done. Try again.",
  "The eval check could not be read just now. Try again.",
  "project not found",
] as const;
export const EVAL_CHECK_SENTENCES: ReadonlySet<string> = new Set(EVAL_CHECK_SENTENCES_LIST);
