// Rovara Cloud only (0.5.15): when each health check last ran for a company, so the admin Health page can say "checked 5 minutes ago".
// One read (`GET /v1/app/org/health-observations`, a company owner or admin on a browser session) answers four features. A feature whose check has never
// been recorded reads `{ checked: false }`: it is "never checked", not healthy. The server computes every age, so a page never subtracts clocks.
// Nothing here names a person, a model, a token or a host: times, a result word and a fixed reason code only. Every field a page may not have is optional,
// so an older page that does not know a feature keeps working.
import { z } from "zod";
import { ModelFallbackReasonCodeSchema, OrgIdSchema } from "@rovara-code/contracts";

/** The window "used the main model" and "used a fallback" are answered for. */
export const HEALTH_MODEL_USE_WINDOW_HOURS = 24;
export const HEALTH_CHECK_RESULTS = ["ok", "failed", "unknown"] as const;
export const HealthCheckResultSchema = z.enum(HEALTH_CHECK_RESULTS);
export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>;

const Instant = z.string().datetime();
const Age = z.number().int().min(0);

/** One check that ran at a time with a result: the company's last model source check, the last Slack probe or the last GitHub App check. */
export const HealthCheckObservationSchema = z.discriminatedUnion("checked", [
  z.object({ checked: z.literal(false) }).strict(),
  z.object({ checked: z.literal(true), checkedAt: Instant, ageSeconds: Age, result: HealthCheckResultSchema }).strict(),
]);
export type HealthCheckObservation = z.infer<typeof HealthCheckObservationSchema>;

/**
 * Which model answered recently: the main model, or a fallback. `usedMain` and `usedFallback` say whether each happened inside the window; the last times and ages
 * say when, even beyond it. A company that has never started a model-governed step reads `{ checked: false }`.
 */
export const HealthModelUseObservationSchema = z.discriminatedUnion("checked", [
  z.object({ checked: z.literal(false) }).strict(),
  z.object({
    checked: z.literal(true), windowHours: z.literal(HEALTH_MODEL_USE_WINDOW_HOURS), usedMain: z.boolean(), usedFallback: z.boolean(),
    lastMainAt: Instant.optional(), lastMainAgeSeconds: Age.optional(),
    lastFallbackAt: Instant.optional(), lastFallbackAgeSeconds: Age.optional(), lastFallbackReason: ModelFallbackReasonCodeSchema.optional(),
  }).strict(),
]);
export type HealthModelUseObservation = z.infer<typeof HealthModelUseObservationSchema>;

export const OrgHealthObservationsResponseSchema = z.object({
  orgId: OrgIdSchema, readAt: Instant,
  /** The last time a model source's check ran (the "Check" button on an AI source) and what it found. */
  modelSource: HealthCheckObservationSchema.optional(),
  /** Main model against fallback over the last 24 hours. */
  modelUse: HealthModelUseObservationSchema.optional(),
  /** The last live Slack token probe. */
  slack: HealthCheckObservationSchema.optional(),
  /** The last check that the GitHub App is installed. */
  github: HealthCheckObservationSchema.optional(),
}).strict();
export type OrgHealthObservationsResponse = z.infer<typeof OrgHealthObservationsResponseSchema>;
/** What a page reads: a field a newer broker adds is dropped, not a failure. */
export const OrgHealthObservationsReaderSchema = OrgHealthObservationsResponseSchema.strip();
export const ORG_HEALTH_OBSERVATIONS_PATH = "/v1/app/org/health-observations";
