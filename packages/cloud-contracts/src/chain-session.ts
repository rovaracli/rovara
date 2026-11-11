// The one-session view data of a chain run (Plan 4 Task 10): what Plan 5's sessions read of a chain. A chain run is one session: `sessionId` is the run's
// own id. Version 1 is forward-compatible. What the server writes is strict (`…Schema`: it refuses what it does not know), and what a client reads is not
// (`…ReaderSchema`: every object keeps unknown fields and every enum reads a value a newer server added as "unknown"). The reader is derived from the strict
// schema, so the two cannot drift apart. Removing or renaming a key, or changing a type or a meaning, needs Plans 4 and 5 and a new version number; new optional
// fields, new event types and new statuses stay in version 1.
import { z } from "zod";
import { forwardReader } from "@rovara-code/contracts";
import { DeveloperTaskViewSchema } from "./developer-tasks.js";

/** `GET /v1/app/chain-runs/{id}/sections/{seq}/task`: a step's task as Plan 3's task view shows it, read for a reader of the run. */
export const ChainStepTaskViewSchema = z.object({ seq: z.number().int().min(1), taskId: z.string().min(1), rovaraCode: z.boolean(), task: DeveloperTaskViewSchema }).strict();
export type ChainStepTaskView = z.infer<typeof ChainStepTaskViewSchema>;
export const ChainStepTaskViewReaderSchema = forwardReader(ChainStepTaskViewSchema);
