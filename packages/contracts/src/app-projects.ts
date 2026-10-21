// Plan 2, Task 11: what the app shows of a project (its list and its detail) and what each project role may do. A person's
// role in a project is `maintainer`, `contributor` or `viewer`; an org owner or admin is a maintainer of every project in their org.
import { z } from "zod";

export const ProjectRoleSchema = z.enum(["maintainer", "contributor", "viewer"]);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

/** What a project role may do. A union (not an enum of the schema) so a later plan extends it with its own actions. */
export type ProjectPermission = "view" | "start_tasks" | "edit_settings" | "manage_members" | "archive" | "setup_check";

export const PROJECT_PERMISSIONS: Record<ProjectRole, ReadonlyArray<ProjectPermission>> = {
  maintainer: ["view", "start_tasks", "edit_settings", "manage_members", "archive", "setup_check"],
  contributor: ["view", "start_tasks"],
  viewer: ["view"],
};

export function projectAllows(role: ProjectRole, action: ProjectPermission): boolean {
  return PROJECT_PERMISSIONS[role].includes(action);
}

export const ProjectStatusSchema = z.enum(["active", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectSetupStatusSchema = z.enum(["unchecked", "checking", "ready", "failed", "outdated"]);
export type ProjectSetupStatus = z.infer<typeof ProjectSetupStatusSchema>;

export const AppProjectSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  status: ProjectStatusSchema,
  latestRevision: z.number().int().positive(),
  repositories: z.array(z.object({ fullName: z.string(), defaultBranch: z.string() })),
  myRole: ProjectRoleSchema,
  setup: z.object({
    status: ProjectSetupStatusSchema,
    checkedRevision: z.number().int().positive().optional(),
    checkedAt: z.string().optional(),
    failedStep: z.string().optional(),
  }),
});
export type AppProjectSummary = z.infer<typeof AppProjectSummarySchema>;

export const AppProjectDomainStatusSchema = z.enum(["approved", "pending", "rejected"]);

export const AppProjectDetailSchema = AppProjectSummarySchema.extend({
  settings: z.object({
    setupCommands: z.array(z.string()),
    testCommands: z.array(z.string()),
    devcontainer: z.object({ repository: z.string(), configPath: z.string() }).nullable(),
    /** Until egress items exist (Plan 2, Task 18), every stored domain reads as approved. */
    allowedDomains: z.array(z.object({ domain: z.string(), status: AppProjectDomainStatusSchema })),
  }),
  createdAt: z.string(),
  createdBy: z.object({ developerId: z.string(), name: z.string() }),
});
export type AppProjectDetail = z.infer<typeof AppProjectDetailSchema>;

export const AppProjectsResponseSchema = z.object({ projects: z.array(AppProjectSummarySchema) });
export type AppProjectsResponse = z.infer<typeof AppProjectsResponseSchema>;
