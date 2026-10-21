// Plan 2, Task 11: what the app shows of a project (its list and its detail) and what each project role may do. A person's
// role in a project is `maintainer`, `contributor` or `viewer`; an org owner or admin is a maintainer of every project in their org.
import { z } from "zod";
import { isPublicSuffix } from "./public-suffix.js";

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
    /** Until egress items exist (Plan 2, Task 18), every domain the revision stores reads as approved. */
    allowedDomains: z.array(z.object({ domain: z.string(), status: AppProjectDomainStatusSchema })),
  }),
  createdAt: z.string(),
  createdBy: z.object({ developerId: z.string(), name: z.string() }),
});
export type AppProjectDetail = z.infer<typeof AppProjectDetailSchema>;

export const AppProjectsResponseSchema = z.object({ projects: z.array(AppProjectSummarySchema) });
export type AppProjectsResponse = z.infer<typeof AppProjectsResponseSchema>;

/** What an allowed-domain refusal says. It names no value: a refusal reaches logs and other people's screens. */
export const ALLOWED_DOMAIN_MESSAGE = "must be a domain name such as artifacts.acme.dev or *.acme.dev";

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A real top-level name is letters (at least two) or punycode. A last label of digits (an IPv4 address) or with no letters never is one.
const TOP_LEVEL_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Whether a lower-cased entry is a hostname, or `*.` and a hostname, that is not a public suffix and does not sit over one. */
function isAllowedDomain(value: string): boolean {
  if (value.length > 253) return false;
  const host = value.startsWith("*.") ? value.slice(2) : value;
  const labels = host.split(".");
  // A single label (`localhost`, `com`, and so `*` and `*.com`) names no site of one owner.
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label))) return false;
  if (!TOP_LEVEL_LABEL.test(labels.at(-1)!)) return false;
  // `github.io` and `*.github.io` are every GitHub Pages site; `*.s3.amazonaws.com` is every bucket. Their owners are not this project's.
  return !isPublicSuffix(host);
}

/**
 * A domain a project's machines may reach: a hostname, lower-cased, of up to 253 characters, with an optional leading `*.` (subdomains
 * only, as the DNS firewall reads it). Refused: `*` alone, IP address literals, single-label names, a public suffix, and a wildcard over
 * a public suffix. The Public Suffix List decides the last two (`amazonaws.com` is not one, `s3.amazonaws.com` is).
 */
export const AllowedDomainSchema = z.string().transform((value, context) => {
  const domain = value.toLowerCase();
  if (isAllowedDomain(domain)) return domain;
  context.addIssue({ code: "custom", message: ALLOWED_DOMAIN_MESSAGE });
  return z.NEVER;
});

const SETTINGS_COMMAND_MAX_LENGTH = 500;
const SETTINGS_COMMANDS_MAX = 16;
const settingsCommands = z.array(z.string().max(SETTINGS_COMMAND_MAX_LENGTH)).max(SETTINGS_COMMANDS_MAX);
const REPOSITORY_FULL_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/**
 * `PUT /v1/app/projects/{name}/settings`: only the fields given change. Commands and domains replace their whole list. `devcontainer: null`
 * removes the devcontainer. `expectedRevision` is the revision the person was looking at; a newer one refuses the change.
 */
export const ProjectSettingsBodySchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  description: z.string().max(280).optional(),
  setupCommands: settingsCommands.optional(),
  testCommands: settingsCommands.optional(),
  devcontainer: z.object({ repository: z.string().min(1).max(140), configPath: z.string().min(1).max(512).optional() }).strict().nullable().optional(),
  allowedDomains: z.array(AllowedDomainSchema).max(50).optional(),
  addRepositories: z.array(z.string().regex(REPOSITORY_FULL_NAME, "must be owner/name").refine((value) => !/\/(\.{1,2}|\.git)$/.test(value), "must be owner/name")).max(8).optional(),
  removeRepositories: z.array(z.string().min(1).max(140)).max(8).optional(),
}).strict();
export type ProjectSettingsBody = z.infer<typeof ProjectSettingsBodySchema>;

export const ProjectSettingsResponseSchema = z.object({ project: AppProjectDetailSchema, warnings: z.array(z.string()) });
export type ProjectSettingsResponse = z.infer<typeof ProjectSettingsResponseSchema>;
