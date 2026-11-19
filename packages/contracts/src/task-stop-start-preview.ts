// Advisory start-stop preview: never a reservation or permission to start work.
import { z } from "zod";
import { OrgIdSchema } from "./org.js";
import { AgentXNameSchema } from "./names.js";
import { TaskStopMicrousdSchema } from "./task-stop.js";
export const TaskStopStartPreviewBodySchema = z.object({ requestId: z.string().uuid().optional(), path: z.enum(["QUICK", "FULL"]).optional() }).strict();
const scope = { orgId: OrgIdSchema, project: AgentXNameSchema };
export const TaskStopStartPreviewSchema = z.discriminatedUnion("kind", [
 z.object({ ...scope, kind: z.literal("disabled") }).strict(),
 z.object({ ...scope, kind: z.literal("unknown") }).strict(),
 z.object({ ...scope, kind: z.literal("captured"), effectiveStopMicrousd: TaskStopMicrousdSchema }).strict(),
]);

// V2 is negotiated independently; the strict legacy union above stays unchanged.
import { parsePreviewRequestV2, parsePreviewV2, type PreviewRequestV2, type PreviewV2 } from "./start-estimates.js";
export const PreviewRequestV2Schema = z.custom<PreviewRequestV2>(v => parsePreviewRequestV2(v) !== undefined);
export const PreviewV2Schema = z.custom<PreviewV2>(v => parsePreviewV2(v) !== undefined);
