import { z } from "zod";
import { actionPolicyProblems, ActionPolicySchema, AgentXNameSchema, ALLOWED_DOMAIN_MESSAGE, CodeBuildGateDefinitionSchema, ConnectorsSchema, DevcontainerDefinitionSchema, DeveloperTaskPolicySchema, E2E_PROJECT_CHECK_ID, E2EPolicySchema, ExternalIdSchema, firstRefusedDomainIndex, GitBranchNameSchema, type GitHubConnectorConfig, type GitHubMcpPolicy, GitHubMcpPolicySchema, LEGACY_PROJECT_FIELDS, PluginKindSchema, projectCommandEnvProblems, ProjectCommandSchema, ProjectModelsSchema, ProjectNetworkSchema, ProjectOriginsSchema, ProjectRegistriesSchema, RelativeWorkspacePathSchema, SpecTargetSchema, StoredConnectorsSchema } from "@rovara-code/contracts";

const HttpsOrLoopbackUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    context.addIssue({ code: "custom", message: "URL must use HTTPS (loopback HTTP is test-only)" });
  }
});

/**
 * Enterprise foundations, task P7: where a repository lives, by plug-in kind. A GitHub host carries the installation and the immutable repository id that
 * `installationId` / `githubRepositoryId` carried at the top of the record (both stay readable for one release: see `repositoryHostOf`). Any other kind
 * is a plug-in registered at build time; it carries one opaque reference of its own. Control-plane only, like the pins: a worker never reads it.
 */
export const RepositoryHostSchema = z.union([
  z.object({ kind: z.literal("github"), installationId: z.number().int().positive().optional(), repositoryId: z.number().int().positive().optional() }).strict(),
  z.object({ kind: PluginKindSchema.refine((kind) => kind !== "github", "github is the other variant"), ref: ExternalIdSchema.optional() }).strict(),
]);
export type RepositoryHost = z.infer<typeof RepositoryHostSchema>;

export const RepositoryDefinitionSchema = z
  .object({
    name: AgentXNameSchema,
    url: HttpsOrLoopbackUrlSchema,
    path: RelativeWorkspacePathSchema,
    defaultBranch: GitBranchNameSchema,
    credentialRef: AgentXNameSchema,
    codeBuildGates: z.array(CodeBuildGateDefinitionSchema).max(8).optional(),
    /**
     * Rovara Cloud (Plan 2, Tasks 15 and 16): the GitHub installation, and the repository's immutable GitHub id, the project was registered
     * against. When set, a task start refuses the project if the repository is now reached through another installation, so a transferred
     * repository cannot quietly change installation. Control-plane only: a worker never reads either (`workerProjectDefinition`).
     */
    installationId: z.number().int().positive().optional(),
    githubRepositoryId: z.number().int().positive().optional(),
    /**
     * Meta repo lane A: what the repository is to the project. Absent means `code`, as every repository of a project that predates it. The one `meta` repository holds
     * the project's config and knowledge (see `metaRepositoryOf`). `alsoCode` marks a one-repository project whose only repository is its own meta repo.
     * Control-plane only, like the pins above: a worker never reads either (`workerProjectDefinition`).
     */
    role: z.enum(["code", "meta"]).optional(),
    alsoCode: z.boolean().optional(),
    /** P7: the code host this repository lives on. Absent means GitHub, as every repository that predates it (`repositoryHostOf`). */
    host: RepositoryHostSchema.optional(),
  })
  .strict()
  .superRefine((repository, context) => {
    // Dual read: while both spellings exist they must agree, so a record can never say two things about where its repository lives.
    if (repository.host !== undefined) {
      const host: { kind: string; installationId?: number | undefined; repositoryId?: number | undefined } = repository.host;
      if (host.kind !== "github") {
        for (const field of ["installationId", "githubRepositoryId"] as const) {
          if (repository[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: "a repository on another code host has no GitHub pins" });
        }
      } else {
        if (repository.installationId !== undefined && host.installationId !== repository.installationId) {
          context.addIssue({ code: "custom", path: ["installationId"], message: "installationId must match host.installationId" });
        }
        if (repository.githubRepositoryId !== undefined && host.repositoryId !== repository.githubRepositoryId) {
          context.addIssue({ code: "custom", path: ["githubRepositoryId"], message: "githubRepositoryId must match host.repositoryId" });
        }
      }
    }
    if (repository.alsoCode !== undefined && repository.role !== "meta") {
      context.addIssue({ code: "custom", path: ["alsoCode"], message: "alsoCode is only for the meta repository" });
    }
    const names = new Set<string>();
    const projects = new Set<string>();
    for (const [index, gate] of (repository.codeBuildGates ?? []).entries()) {
      if (names.has(gate.name)) {
        context.addIssue({
          code: "custom",
          path: ["codeBuildGates", index, "name"],
          message: "CodeBuild gate names must be unique",
        });
      }
      if (projects.has(gate.projectName)) {
        context.addIssue({
          code: "custom",
          path: ["codeBuildGates", index, "projectName"],
          message: "CodeBuild projects must be unique within a repository",
        });
      }
      names.add(gate.name);
      projects.add(gate.projectName);
    }
    const totalTimeout = (repository.codeBuildGates ?? [])
      .reduce((total, gate) => total + gate.timeoutMinutes, 0);
    if (totalTimeout > 420) {
      context.addIssue({
        code: "custom",
        path: ["codeBuildGates"],
        message: "total CodeBuild gate timeout must not exceed 420 minutes",
      });
    }
  });

function projectDefinitionObject<Connectors extends z.ZodTypeAny>(connectorsSchema: Connectors) {
  return z
    .object({
      name: AgentXNameSchema,
      revision: z.number().int().positive(),
      repositories: z.array(RepositoryDefinitionSchema).min(1).max(32),
      setup: z.array(ProjectCommandSchema).max(64),
      readiness: z.array(ProjectCommandSchema).max(64),
      devcontainer: DevcontainerDefinitionSchema.optional(),
      network: ProjectNetworkSchema.optional(),
      /** N9 (INTG2): the project's private package registries. Where they are and which credential reference reaches them, never a token. Control-plane only (`workerProjectDefinition`). */
      registries: ProjectRegistriesSchema.optional(),
      orchestratorInstructions: z.string().min(1).max(32_768),
      models: ProjectModelsSchema.optional(),
      integrations: z.object({
        githubMcp: GitHubMcpPolicySchema.optional(),
        connectors: connectorsSchema.optional(),
      }).strict().optional(),
      actionPolicy: ActionPolicySchema.optional(),
      developerTasks: DeveloperTaskPolicySchema.optional(),
      /** Optional trusted-scenario policy. Absence preserves the legacy workflow. */
      e2e: E2EPolicySchema.optional(),
      /** K1 lane D: where this project's specs are written (spec-target.ts). Absent: no spec is written. */
      specTarget: SpecTargetSchema.optional(),
      origins: ProjectOriginsSchema.optional(),
    })
    .strict();
}

/**
 * Shared by `ProjectDefinitionSchema` and `StoredProjectDefinitionSchema`. A connector's `scopes`
 * is checked against registered repository names only for a `github` entry: an entry of a type
 * this release's schema does not know (from `StoredConnectorsSchema`'s passthrough branch) may
 * carry any shape there, which this release does not interpret.
 */
function checkProjectDefinition(
  project: {
    repositories: ReadonlyArray<{ name: string; path: string; role?: "code" | "meta" | undefined; alsoCode?: boolean | undefined }>;
    devcontainer?: { repository: string } | undefined;
    integrations?: {
      githubMcp?: unknown;
      connectors?: ReadonlyArray<{ name: string; type: string; scopes?: unknown }> | undefined;
    } | undefined;
  },
  context: z.RefinementCtx,
): void {
  const names = new Set<string>();
  for (const [index, repository] of project.repositories.entries()) {
    if (names.has(repository.name)) {
      context.addIssue({
        code: "custom",
        path: ["repositories", index, "name"],
        message: "repository names must be unique",
      });
    }
    names.add(repository.name);
  }
  const paths = project.repositories.map((repository) => repository.path).sort();
  for (let index = 1; index < paths.length; index += 1) {
    const previous = paths[index - 1];
    const current = paths[index];
    if (previous && current && (current === previous || current.startsWith(`${previous}/`))) {
      context.addIssue({ code: "custom", path: ["repositories"], message: "repository paths overlap" });
    }
  }
  if (project.devcontainer && !names.has(project.devcontainer.repository)) {
    context.addIssue({ code: "custom", path: ["devcontainer", "repository"], message: `devcontainer names unregistered repository ${project.devcontainer.repository}` });
  }
  // Meta repo lane A: at most one meta repository (a project that predates meta repos has none). A meta repository that is not also code needs a code
  // repository beside it; one that is also code is the whole project. The devcontainer runs code, so it never names a pure meta repository.
  const metas = project.repositories.map((repository, index) => ({ repository, index })).filter(({ repository }) => repository.role === "meta");
  if (metas.length > 1) {
    context.addIssue({ code: "custom", path: ["repositories", metas[1]!.index, "role"], message: "a project has at most one meta repository" });
  }
  const meta = metas[0]?.repository;
  if (meta !== undefined) {
    if (meta.alsoCode === true && project.repositories.length !== 1) {
      context.addIssue({ code: "custom", path: ["repositories", metas[0]!.index, "alsoCode"], message: "a repository that is both meta and code must be the project's only repository; make the meta repository a separate one first" });
    }
    if (meta.alsoCode !== true && project.repositories.length < 2) {
      context.addIssue({ code: "custom", path: ["repositories"], message: "a meta repository that is not also code needs at least one code repository" });
    }
    if (meta.alsoCode !== true && project.devcontainer?.repository === meta.name) {
      context.addIssue({ code: "custom", path: ["devcontainer", "repository"], message: "the devcontainer cannot be in a meta repository that is not also code" });
    }
  }
  if (project.integrations?.githubMcp && project.integrations.connectors) {
    context.addIssue({ code: "custom", path: ["integrations"], message: "use either integrations.githubMcp or integrations.connectors, not both" });
  }
  for (const connector of project.integrations?.connectors ?? []) {
    if (connector.type !== "github") continue;
    const scopes = connector.scopes;
    if (scopes === "all-repositories") continue;
    for (const name of scopes as string[]) {
      if (!names.has(name)) {
        context.addIssue({ code: "custom", path: ["integrations", "connectors"], message: `connector ${connector.name} scopes unregistered repository ${name}` });
      }
    }
  }
}

export const ProjectDefinitionSchema = projectDefinitionObject(ConnectorsSchema)
  .superRefine(checkProjectDefinition)
  .superRefine((project, context) => {
    if ((project.e2e?.targets ?? []).some((target) => target.targetId === E2E_PROJECT_CHECK_ID)) {
      context.addIssue({ code: "custom", path: ["e2e", "targets"], message: "project-e2e is a reserved check identity, not a target ID" });
    }
  })
  // P7 / Opus review I5: this release READS a repository's `host` (a record written by a later release, or by the lazy rewrite in a later release) but does not WRITE one. Two reasons:
  // the release before this one parses a repository strictly and would refuse the whole project, so a rollback would take it dark; and nothing routes by `host` yet, so a save that
  // said a repository lives elsewhere would still be cloned and pushed through GitHub. A later release turns writes on, for the kinds an install has registered.
  .superRefine((project, context) => {
    project.repositories.forEach((repository, index) => {
      if (repository.host !== undefined) context.addIssue({ code: "custom", path: ["repositories", index, "host"], message: "a repository's code host is not set by this release; leave host out" });
    });
  })
  // Registration and settings saves: the Public Suffix List is consulted when a domain is written, never when a stored revision is read.
  .superRefine((project, context) => {
    const index = firstRefusedDomainIndex(project.network?.allowedDomains ?? []);
    if (index !== undefined) context.addIssue({ code: "custom", path: ["network", "allowedDomains", index], message: ALLOWED_DOMAIN_MESSAGE });
  })
  // Runs wherever ProjectDefinitionSchema parses a project: registration, the developer CLI's
  // local project-file check, and the local broker. A stored revision is read with
  // StoredProjectDefinitionSchema, which does not re-check.
  .superRefine((project, context) => {
    for (const message of actionPolicyProblems(project)) context.addIssue({ code: "custom", path: ["actionPolicy"], message });
  })
  // Registration only (#54): a stored revision is read without these name and value rules.
  .superRefine((project, context) => {
    for (const stage of ["setup", "readiness"] as const) {
      for (const [index, command] of project[stage].entries()) {
        for (const { name, message } of projectCommandEnvProblems(command.env ?? {})) {
          context.addIssue({ code: "custom", path: [stage, index, "env", name], message });
        }
      }
    }
  });

/**
 * A project definition already on record: an `integrations.connectors` entry of a type this
 * release's schema does not know (for example one written by a later control plane, before a
 * rollback) passes through as `{name, type, ...}` instead of failing the parse. A `github` entry
 * still validates exactly as strictly as `ProjectDefinitionSchema` does. Registration always uses
 * `ProjectDefinitionSchema`, which keeps refusing an unknown connector type.
 */
const StoredProjectDefinitionObjectSchema = projectDefinitionObject(StoredConnectorsSchema).superRefine(checkProjectDefinition);

/** Parses a definition that may predate the removal of {@link LEGACY_PROJECT_FIELDS}, and that may
 * carry a connector of a type this release does not know (see `StoredConnectorsSchema`). */
export const StoredProjectDefinitionSchema = z.preprocess(
  (value) => withoutFields(value, LEGACY_PROJECT_FIELDS),
  StoredProjectDefinitionObjectSchema,
);

function withoutFields(value: unknown, fields: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const remaining: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of fields) delete remaining[field];
  return remaining;
}

export type ProjectDefinition = z.infer<typeof ProjectDefinitionSchema>;

/**
 * A project definition as a worker is sent it: without `network`, and without any repository's `installationId` and `githubRepositoryId`.
 * Workers of an earlier release parse the definition with a strict schema that does not know the fields, and they are the control plane's
 * alone (the DNS firewall enforces `network`, the broker's start check the pins).
 * `includeMeta` keeps a meta repository that is not also code, for the one run that reads it whole (the setup draft).
 */
export function workerProjectDefinition<Definition extends object>(definition: Definition, options: { includeMeta?: boolean } = {}): Omit<Definition, "network" | "origins" | "specTarget" | "registries"> {
  const rest: Record<string, unknown> = { ...(definition as Record<string, unknown>) };
  delete rest.network;
  // N9: the registries reach a worker as the prepare payload's `registries` (where, never how), only if it lists `prepare.registries.v1`; an earlier worker's strict schema does not know the field.
  delete rest.registries;
  // Meta repo lane A: who set each setting is the control plane's too.
  delete rest.origins;
  // Lane D: where specs are written is the control plane's (the broker renders and publishes them); an earlier worker's strict schema does not know it.
  delete rest.specTarget;
  // The same for the repository pins (`installationId`, `githubRepositoryId`) and the meta role: the repository entry of an earlier worker is strict too.
  if (Array.isArray(rest.repositories)) {
    rest.repositories = rest.repositories
      // A meta repository that is not also code is not code to a worker: it is never cloned as a checkout, changed or published. A worker that can read one is
      // sent it beside the project (the prepare payload's `meta`, lane A task A3).
      // `includeMeta`: a setup draft reads the meta repository in full, as an ordinary read-only checkout (it has no `meta` request), so its knowledge and citations are there.
      .filter((entry: unknown) => options.includeMeta === true || !(isPureMetaRepository(entry)))
      .map((entry: unknown) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const repository: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
        delete repository.installationId;
        delete repository.githubRepositoryId;
        delete repository.host;
        delete repository.role;
        delete repository.alsoCode;
        return repository;
      });
  }
  return rest as Omit<Definition, "network" | "origins" | "specTarget" | "registries">;
}

function isPureMetaRepository(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const repository = entry as { role?: unknown; alsoCode?: unknown };
  return repository.role === "meta" && repository.alsoCode !== true;
}

/** A project definition as `StoredProjectDefinitionSchema` parses it: its connectors may include
 * an entry of a type this release's schema does not know, passed through unexamined. */
export type StoredProjectDefinition = z.infer<typeof StoredProjectDefinitionSchema>;

export type RepositoryDefinition = z.infer<typeof RepositoryDefinitionSchema>;

/**
 * P7 dual read: the host of a repository record. The explicit `host` wins; a record without one (every record written before P7) is a GitHub repository with
 * the pins it carried. Never throws, never returns a kind the record did not name or imply.
 */
export function repositoryHostOf(repository: Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">): RepositoryHost {
  if (repository.host !== undefined) return repository.host;
  return {
    kind: "github",
    ...(repository.installationId === undefined ? {} : { installationId: repository.installationId }),
    ...(repository.githubRepositoryId === undefined ? {} : { repositoryId: repository.githubRepositoryId }),
  };
}

/**
 * The lazy rewrite of a record on its way to storage. A GitHub repository is NOT given a `host` in this release: its old pins say the same thing, the release before this one reads only
 * those, and a rewrite that added `host` would make the project unreadable after a rollback (the exact step if a later release has written it: save the project again with this
 * release, which drops `host`). So this returns the record unchanged; it exists so the day writes are turned on there is one place that decides, and a test that fails if it starts writing early.
 */
export function withRepositoryHost<Repository extends Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">>(repository: Repository): Repository {
  return repository;
}

export interface ResolvedGitHubConnector {
  name: string;
  repositories: RepositoryDefinition[];
  policy: GitHubMcpPolicy;
  attribution: boolean;
}

/**
 * The project's GitHub connector from either configuration form. Definitions registered with the
 * feature 007 `githubMcp` policy read as a connector named `github` over every repository.
 */
export function githubConnectorOf(project: Pick<ProjectDefinition, "repositories" | "integrations">): ResolvedGitHubConnector | undefined {
  const legacy = project.integrations?.githubMcp;
  if (legacy) return { name: "github", repositories: project.repositories, policy: legacy, attribution: true };
  const connector = project.integrations?.connectors?.find((entry): entry is GitHubConnectorConfig => entry.type === "github");
  if (!connector) return undefined;
  const scopes = connector.scopes;
  const repositories = scopes === "all-repositories"
    ? project.repositories
    : project.repositories.filter((repository) => scopes.includes(repository.name));
  return { name: connector.name, repositories, policy: { tools: connector.tools }, attribution: connector.attribution ?? true };
}