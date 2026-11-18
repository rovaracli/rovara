// Lead 4 PCF: the plan card's feature-choice read (`/v1/web/tasks/{task}/feature-choices`). Filing and creation use the existing Cost and time actions. Browser-safe.
import { z } from "zod";
import { PLAN_FEATURE_ID_PATTERN } from "./decision-cards.js";

const FeatureIdSchema = z.string().regex(PLAN_FEATURE_ID_PATTERN);
/** A feature's name as the app draws it: one plain line (Cloud's server makes every name inert before it sends it). */
const FeatureNameSchema = z.string().min(1).max(80).regex(/^[^\p{Cc}\p{Cf}]*$/u, "one plain line");

/** The most features the picker lists (Code's `PLAN_FEATURE_CHOICES_MAX`). */
export const PLAN_FEATURE_CHOICES_MAX = 50;
export const PlanFeatureChoicesResponseSchema = z.object({
  features: z.array(z.object({ id: FeatureIdSchema, name: FeatureNameSchema }).strict()).max(PLAN_FEATURE_CHOICES_MAX),
  canCreate: z.boolean(),
}).strict();
export type PlanFeatureChoicesResponse = z.infer<typeof PlanFeatureChoicesResponseSchema>;
