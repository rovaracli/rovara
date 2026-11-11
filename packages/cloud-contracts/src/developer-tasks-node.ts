import { OperationStatusSchema, PullRequestSummarySchema } from "@rovara-code/contracts";
import { z } from "zod";
import { DeveloperTaskViewSchema, DeveloperTaskClientViewSchema } from "./developer-tasks.js";

export type DeveloperTaskView = z.infer<typeof DeveloperTaskViewSchema>;

/** Slice 5: a row also carries the task's session and its web link when it has one, so a list (MCP, the CLI) can hand a person the page without guessing. */
export const DeveloperTaskListItemSchema = DeveloperTaskViewSchema.pick({ taskId: true, title: true, project: true, status: true, shared: true, createdAt: true, updatedAt: true, sessionId: true, sessionUrl: true });

export type DeveloperTaskListItem = z.infer<typeof DeveloperTaskListItemSchema>;

/** `nextCursor` is opaque: pass it back as `cursor` for the next page; it is absent on the last page. */
export const DeveloperTaskListResponseSchema = z.object({ tasks: z.array(DeveloperTaskListItemSchema), nextCursor: z.string().optional() });

export const DeveloperTaskResponseSchema = z.object({ task: DeveloperTaskClientViewSchema });

export const DeveloperCloseResponseSchema = z.object({
  task: DeveloperTaskClientViewSchema,
  closed: z.boolean(),
  discardedUnpublished: z.boolean().optional(),
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) })).optional(),
  /** Present whenever `closed` is false: why the task is not closed yet, and what to do next. */
  message: z.string().optional(),
});

export type DeveloperCloseResponse = z.infer<typeof DeveloperCloseResponseSchema>;

export const DeveloperPullRequestResponseSchema = z.object({
  task: DeveloperTaskClientViewSchema,
  operationId: z.string().uuid(),
  operationStatus: OperationStatusSchema,
  pullRequest: PullRequestSummarySchema.optional(),
});

export type DeveloperPullRequestResponse = z.infer<typeof DeveloperPullRequestResponseSchema>;

export { DeveloperTaskViewSchema, DeveloperTaskClientViewSchema, knownTaskView, type DeveloperTaskClientView } from "./developer-tasks.js";
