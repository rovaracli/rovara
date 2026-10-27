// Additive project money intent. This payload alone is not runtime enforcement.
import { z } from "zod";
import { TaskStopMicrousdSchema } from "./task-stop.js";
export const TaskStopProjectPolicySchema = z.object({
  schemaVersion: z.literal(1),
  stopMicrousd: TaskStopMicrousdSchema,
}).strict();
export type TaskStopProjectPolicy = z.infer<typeof TaskStopProjectPolicySchema>;
