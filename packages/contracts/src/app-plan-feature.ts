// Lead 4 PCF: what the plan card's "Change", "Create" and "No feature" send and read (Cloud's `/v1/web/tasks/{task}/feature-choices`, `/tasks/{task}/feature` and `/org/report/features`, which pass Rovara Code's
// routes through as the signed-in person). Code decides who may; these are only the shapes the app and Cloud's server agree on. Browser-safe.
import { z } from "zod";
import { PLAN_FEATURE_ID_PATTERN, PLAN_FEATURE_SOURCES } from "./decision-cards.js";

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

/** `POST /v1/web/tasks/{task}/feature`: a feature id, or null for "No feature". Nothing else rides along. */
export const SetTaskFeatureBodySchema = z.object({ feature: FeatureIdSchema.nullable() }).strict();
export type SetTaskFeatureBody = z.infer<typeof SetTaskFeatureBodySchema>;
export const SetTaskFeatureResponseSchema = z.object({
  task: z.object({ taskId: z.string().uuid(), feature: z.object({ id: FeatureIdSchema, source: z.enum(PLAN_FEATURE_SOURCES) }).strict().nullable() }).strict(),
}).strict();
export type SetTaskFeatureResponse = z.infer<typeof SetTaskFeatureResponseSchema>;

/** `POST /v1/web/org/report/features`: make a feature (company owner or admin). */
export const CreatePlanFeatureBodySchema = z.object({ name: FeatureNameSchema }).strict();
export type CreatePlanFeatureBody = z.infer<typeof CreatePlanFeatureBodySchema>;
export const CreatePlanFeatureResponseSchema = z.object({ feature: z.object({ id: FeatureIdSchema, name: FeatureNameSchema }).strict() }).strict();
export type CreatePlanFeatureResponse = z.infer<typeof CreatePlanFeatureResponseSchema>;
