// Cloud's own text of the project summary and the answers that carry it (convergence W0-3, r8): the summary names the project's meta repository. Owed upstream: see owed-upstream.json.
import { z } from "zod";
import { ProjectRoleSchema as CloudProjectRoleSchema } from "./project-roles.js";
import { CollaboratorApprovalsSettingSchema } from "./product-decisions.js";
import { AppProjectDomainStatusSchema, ErrorRefSchema, ProjectRoleSchema, ProjectSetupStatusSchema, ProjectStatusSchema, SettingsHeldSchema, SettingsProofSchema } from "@rovara-code/contracts";


export const AppProjectSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  status: ProjectStatusSchema,
  latestRevision: z.number().int().positive(),
  repositories: z.array(z.object({ name: z.string().optional(), fullName: z.string(), defaultBranch: z.string() })),
  /**
   * The project's meta repository (the one repository whose role is `meta`), also listed in `repositories`. Absent for a project that predates meta repos.
   * `alsoCode` is true when the project's one repository is its own meta repo. Names and the branch only: nothing from inside the repository.
   */
  metaRepository: z.object({ name: z.string().optional(), fullName: z.string(), defaultBranch: z.string(), alsoCode: z.boolean().optional() }).optional(),
  myRole: ProjectRoleSchema,
  /** Collaborator role (W11): the caller's exact project role. `myRole` stays Code's three roles (a collaborator reads there as `viewer`, its floor) so today's pages keep parsing. */
  myProjectRole: CloudProjectRoleSchema.optional(),
  setup: z.object({
    status: ProjectSetupStatusSchema,
    checkedRevision: z.number().int().positive().optional(),
    checkedAt: z.string().optional(),
    failedStep: z.string().optional(),
    /** Live interaction F1: what "Fix with agent" is about when the setup check failed or is outdated. Fixed codes and ids only. */
    errorRef: ErrorRefSchema.optional(),
  }),
});
export type AppProjectSummary = z.infer<typeof AppProjectSummarySchema>;

export const AppProjectDetailSchema = AppProjectSummarySchema.extend({
  savedWorkingBranches: z.array(z.object({repository:z.string(),fullName:z.string(),branch:z.string(),commit:z.string().regex(/^[a-f0-9]{40}$/)})).max(32).optional(),
  settings: z.object({
    setupCommands: z.array(z.string()),
    testCommands: z.array(z.string()),
    devcontainer: z.object({ repository: z.string(), configPath: z.string() }).nullable(),
    /** Each domain with where it stands: on Rovara Cloud a new one is `pending` until staff approve it, and a `rejected` one says why. */
    allowedDomains: z.array(z.object({ domain: z.string(), status: AppProjectDomainStatusSchema, reason: z.string().optional() })),
  }),
  createdAt: z.string(),
  createdBy: z.object({ developerId: z.string(), name: z.string() }),
  /** TE-4: whether the commands in the settings are proved. Absent where setup checks are not set up. */
  settingsProof: SettingsProofSchema.optional(),
  /** Decision 36: whether collaborators may approve LOW-risk product decisions here (on by default), and whether the reader may change it. Absent from an older control plane. */
  collaboratorApprovals: CollaboratorApprovalsSettingSchema.optional(),
});
export type AppProjectDetail = z.infer<typeof AppProjectDetailSchema>;

/** The answer to archiving or restoring a project (Plan 2, Task 20): the project as the app now shows it, and a warning when the firewall could not be told at once. */
export const ProjectArchiveResponseSchema = z.object({ project: AppProjectDetailSchema, warnings: z.array(z.string()) });
export type ProjectArchiveResponse = z.infer<typeof ProjectArchiveResponseSchema>;
export const ProjectSetupCheckResponseSchema = z.object({ project: AppProjectDetailSchema });
export type ProjectSetupCheckResponse = z.infer<typeof ProjectSetupCheckResponseSchema>;

export const AppProjectsResponseSchema = z.object({ projects: z.array(AppProjectSummarySchema) });
export type AppProjectsResponse = z.infer<typeof AppProjectsResponseSchema>;

/** `held` (TE-4): present when an API key asked to change commands or the dev container: they are not in the settings yet, and are written only if their check passes. */
export const ProjectSettingsResponseSchema = z.object({ project: AppProjectDetailSchema, warnings: z.array(z.string()), held: SettingsHeldSchema.optional() });
export type ProjectSettingsResponse = z.infer<typeof ProjectSettingsResponseSchema>;