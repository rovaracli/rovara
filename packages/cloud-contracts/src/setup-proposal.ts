// Cloud's own text of the setup apply answer (convergence W0-3, r8): it carries the project detail, which now names its meta repository. Owed upstream: see owed-upstream.json.
import { z } from "zod";
import { SETUP_APPLY_ITEMS_MAX, SetupApplyResultItemSchema } from "@rovara-code/contracts";
import { AppProjectDetailSchema } from "./app-projects.js";


/** What `POST …/setup-draft/apply` answers: the project as the app shows it, and what happened to each named item. */
export const SetupApplyResponseSchema = z.object({
  project: AppProjectDetailSchema,
  warnings: z.array(z.string().max(500)).max(100),
  setupCheck: z.enum(["started", "not_started", "not_needed"]),
  setupCheckMessage: z.string().max(500).optional(),
  results: z.array(SetupApplyResultItemSchema).max(SETUP_APPLY_ITEMS_MAX),
}).strict();
export type SetupApplyResponse = z.infer<typeof SetupApplyResponseSchema>;