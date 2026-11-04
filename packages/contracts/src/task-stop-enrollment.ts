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
 outcome: z.enum(["refuse_next_admission", "new_window_at_stop", "retain_current_window", "exempt"]),
}).strict();
export const TaskStopReviewSchema = z.object({ orgId: OrgIdSchema, reviewId: z.string().uuid(), digest, revision, complete: z.literal(true),
 capturedAt: z.string().datetime(), expiresAt: z.string().datetime(), tasks: z.array(TaskStopImpactSchema).max(25), truncated: z.boolean(),
 counts: z.object({ refuse_next_admission: z.number().int().min(0).max(100), new_window_at_stop: z.number().int().min(0).max(100), retain_current_window: z.number().int().min(0).max(100), exempt: z.number().int().min(0).max(100) }).strict(),
}).strict().superRefine((review, context) => {
 const total = Object.values(review.counts).reduce((sum, count) => sum + count, 0);
 if (total > 100 || review.truncated !== (total > review.tasks.length) || review.tasks.length !== Math.min(total, 25)) context.addIssue({ code: "custom", message: "Review counts and listed impacts disagree." });
 for (const outcome of Object.keys(review.counts) as Array<keyof typeof review.counts>) if (review.tasks.filter(task => task.outcome === outcome).length > review.counts[outcome]) context.addIssue({ code: "custom", message: "Review outcome count is too small." });
});
export const TaskStopEnrollmentReadSchema = z.object({ orgId: OrgIdSchema, state: TaskStopEnrollmentStateSchema, revision }).strict();
export const TaskStopEnrollmentResultSchema = TaskStopEnrollmentReadSchema.extend({ requestId: z.string().uuid(), tasksReviewed: z.number().int().nonnegative().max(100), tasksAtEnable: z.number().int().nonnegative().max(100), newImpacts: z.number().int().nonnegative().max(100) }).strict();
export type TaskStopReview = z.infer<typeof TaskStopReviewSchema>;
export type TaskStopImpact = z.infer<typeof TaskStopImpactSchema>;
