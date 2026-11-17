import { AgentXNameSchema } from "./names.js";
import { forwardReader } from "./forward-reader.js";
import { z } from "zod";
import { cleanDisplayName } from "./display-name.js";
export const RenameOrganizationBodySchema = z.object({
 requestId: z.string().uuid(),
 name: z.string().refine(value => Array.from(value).length <= 80, "must have at most 80 characters").transform(value => cleanDisplayName(value)).refine((value): value is string => value !== undefined, "must have a printable name"),
}).strict();
export const RenameOrganizationResponseSchema = z.object({ org: z.object({ orgId: z.string(), name: z.string(), plan: z.string() }), role: z.literal("owner") });

const COMMAND_MAX_LENGTH = 500;
const DESCRIPTION_MAX_LENGTH = 280;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
/** Commands a project is created with: one in `setupCommand`/`testCommand`, or the whole ordered list in `setupCommands`/`testCommands` (the same 16 that project settings keep). */
const COMMANDS_MAX = 16;
const commandList = z.array(z.string().max(COMMAND_MAX_LENGTH)).min(1).max(COMMANDS_MAX);
export const CreateProjectBodySchema = z.object({
  requestId: z.string().uuid(),
  repository: z.string().regex(REPOSITORY, "must be owner/name").refine((value) => !/\/(\.{1,2}|\.git)$/.test(value), "must be owner/name"),
  name: AgentXNameSchema.optional(),
  description: z.string().max(DESCRIPTION_MAX_LENGTH).optional(),
  setupCommand: z.string().max(COMMAND_MAX_LENGTH).optional(),
  testCommand: z.string().max(COMMAND_MAX_LENGTH).optional(),
  setupCommands: commandList.optional(),
  testCommands: commandList.optional(),
}).strict().superRefine((body, context) => {
  for (const [single, list] of [["setupCommand", "setupCommands"], ["testCommand", "testCommands"]] as const) {
    if (body[single] !== undefined && body[list] !== undefined) context.addIssue({ code: "custom", path: [list], message: `give ${single} or ${list}, not both` });
  }
});
/**
 * Guided onboarding PR 10: the app's several-repository create. `separate` absent or false: ONE project holding every repository (Code's
 * `POST /v1/dev/client/projects` with `repositories`), named `name` or after the first one; `separate: true`: one project per repository, each named after
 * it (Code's `POST /v1/dev/client/projects/bulk`), with no `name`. 1 to 32 repositories, no repeats ignoring case and `.git`. The body never names a company:
 * Code takes the company from the person's live membership.
 */
export const CREATE_PROJECTS_REPOSITORIES_MAX = 32;
export const CreateProjectsBodySchema = z.object({
  requestId: z.string().uuid(),
  repositories: z.array(CreateProjectBodySchema.shape.repository).min(1).max(CREATE_PROJECTS_REPOSITORIES_MAX)
    .refine((list) => new Set(list.map((value) => value.toLowerCase().replace(/\.git$/, ""))).size === list.length, "repositories must be different"),
  separate: z.boolean().optional(),
  name: AgentXNameSchema.optional(),
}).strict().refine((body) => !(body.separate === true && body.name !== undefined), { path: ["name"], message: "separate projects are named after their repositories" });
/** Why one repository of a separate-projects create made no project (Code's four fixed reasons, `BULK_PROJECT_REFUSALS`). */
export const BULK_REFUSAL_REASONS = ["not_available", "name_taken", "unavailable", "not_started"] as const;
export const BulkProjectsCreatedResponseSchema = z.object({
  duplicate: z.boolean(),
  results: z.array(z.discriminatedUnion("outcome", [
    z.object({ repository: z.string(), outcome: z.literal("created"), project: AgentXNameSchema }),
    z.object({ repository: z.string(), outcome: z.literal("refused"), reason: z.enum(BULK_REFUSAL_REASONS) }),
  ])).max(CREATE_PROJECTS_REPOSITORIES_MAX),
});
/** One page of the repositories the company's connected GitHub accounts reach, each with the company's own projects that already hold it. */
export const RepositoryChoicesQuerySchema = z.object({
  q: z.string().max(100).regex(/^[A-Za-z0-9_./-]*$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  after: z.string().min(3).max(201).regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/).optional(),
}).strict();
export const RepositoryChoicesResponseSchema = z.object({
  repositories: z.array(z.object({ installationId: z.number().int().positive(), accountLogin: z.string(), fullName: z.string(), githubRepositoryId: z.number().int().positive(), private: z.boolean(), defaultBranch: z.string(), projects: z.array(z.string()) })),
  next: z.string().optional(),
  incomplete: z.boolean(),
});
/**
 * The most setup runs one company has going at once. Hosted Code has no setup-run route yet (so nothing starts a run today, and the bulk table says
 * "Waiting for setup"); when a runner exists, this is the one place that caps it: it asks `setupRunsToStart` how many waiting projects may start now.
 */
export const SETUP_RUNS_AT_ONCE_PER_COMPANY = 3;
export function setupRunsToStart(running: number, waiting: number, limit: number = SETUP_RUNS_AT_ONCE_PER_COMPANY): number {
  if (![running, waiting, limit].every((value) => Number.isInteger(value) && value >= 0)) return 0;
  return Math.min(waiting, Math.max(0, limit - running));
}
export const CreateOrganizationInviteBodySchema = z.object({ requestId: z.string().uuid(), role: z.enum(["admin", "member"]), email: z.string().trim().email().max(254).optional() }).strict();
export const OrganizationInviteResponseSchema = z.object({ inviteUrl: z.string() });
export const GithubConnectResponseSchema = z.object({ installUrl: z.string(), expiresAt: z.string(), orgName: z.string().optional(), ownerName: z.string().optional() });
export const GithubInstallationsResponseSchema = z.object({ installations: z.array(z.object({ installationId: z.number().int().positive(), accountLogin: z.string(), accountType: z.enum(["User", "Organization"]), repositorySelection: z.enum(["all", "selected"]), status: z.enum(["active", "suspended", "removed"]) })) });
export const GithubRepositoriesResponseSchema = z.object({ repositories: z.array(z.object({ fullName: z.string(), githubRepositoryId: z.number().int().positive(), private: z.boolean(), defaultBranch: z.string(), project: z.string().optional() })) });
export const CloudProjectCreatedResponseSchema = z.object({ duplicate: z.boolean(), project: z.object({ definition: z.object({ name: AgentXNameSchema }), registeredAt: z.string() }), warnings: z.array(z.string()).optional() });
export const ProjectRosterAddedResponseSchema = z.object({ agent: z.object({ agentId: z.string(), name: z.string().optional() }) });
export const GithubConnectResponseReaderSchema = forwardReader(GithubConnectResponseSchema);
export const GithubInstallationsResponseReaderSchema = forwardReader(GithubInstallationsResponseSchema);
export const GithubRepositoriesResponseReaderSchema = forwardReader(GithubRepositoriesResponseSchema);
export const CloudProjectCreatedResponseReaderSchema = forwardReader(CloudProjectCreatedResponseSchema);
export const BulkProjectsCreatedResponseReaderSchema = forwardReader(BulkProjectsCreatedResponseSchema);
export const RepositoryChoicesResponseReaderSchema = forwardReader(RepositoryChoicesResponseSchema);

export const RevokeOrganizationInviteBodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() }).strict();
export const RevokeOrganizationInviteResponseSchema = z.object({ inviteId: z.string().uuid(), revokedAt: z.string().datetime(), revision: z.number().int().positive() }).strict();
