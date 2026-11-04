// Owner enrollment wire contracts; no native condition or authority crosses the API.
import { z } from "zod";
import { OrgIdSchema } from "./org.js";
import { TaskStopMicrousdSchema } from "./task-stop.js";
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const TaskStopEnrollmentStateSchema = z.enum(["disabled", "ready", "enabled"]);
export const TaskStopReviewBodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: revision }).strict();
export const TaskStopEnrollmentBodySchema = z.discriminatedUnion("state", [
 z.object({ requestId: z.string().uuid(), expectedRevision: revision, state: z.literal("disabled") }).strict(),
 ...["ready", "enabled"].map(state => z.object({ requestId: z.string().uuid(), expectedRevision: revision, state: z.literal(state), reviewId: z.string().uuid(), expectedReviewDigest: digest }).strict()),
]);
export const TaskStopImpactSchema = z.object({ taskId: z.string().uuid(), project: z.string().min(1).max(256), phase: z.enum(["running", "queued"]),
 effectiveStopMicrousd: TaskStopMicrousdSchema, approvalCapMicrousd: TaskStopMicrousdSchema, currentCapMicrousd: TaskStopMicrousdSchema,
 outcome: z.enum(["refuse_next_admission", "stop_at_next_admission", "retain_current_window", "exempt"]),
}).strict();
export const TaskStopReviewSchema = z.object({ orgId: OrgIdSchema, reviewId: z.string().uuid(), digest, revision, complete: z.literal(true),
 capturedAt: z.string().datetime(), expiresAt: z.string().datetime(), tasks: z.array(TaskStopImpactSchema).max(25),
}).strict();
export const TaskStopEnrollmentReadSchema = z.object({ orgId: OrgIdSchema, state: TaskStopEnrollmentStateSchema, revision }).strict();
export const TaskStopEnrollmentResultSchema = TaskStopEnrollmentReadSchema.extend({ requestId: z.string().uuid(), tasksReviewed: z.number().int().nonnegative().max(25), tasksAtEnable: z.number().int().nonnegative().max(25), newImpacts: z.number().int().nonnegative().max(25) }).strict();
export type TaskStopReview = z.infer<typeof TaskStopReviewSchema>;
export type TaskStopImpact = z.infer<typeof TaskStopImpactSchema>;
