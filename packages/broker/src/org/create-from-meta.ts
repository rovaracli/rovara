// Meta repo lane A, task A2: create a project that starts from a meta repo.
//
// `POST /v1/app/projects` with a `metaRepository` (contracts/meta-project.ts). The body names the repositories; everything else (setup, tests, knowledge, sources) comes
// afterwards, from the setup agent and the meta repo's config file, which a person confirms. So this only records which repositories the project has, and which one is the meta repo:
//   - with `codeRepositories`: a separate meta repo (role `meta`), listed LAST so that the settings' "commands run in the first repository" still means a code repository;
//   - without: one repository that is its own meta repo (`role: "meta"`, `alsoCode: true`).
// It follows `createCloudProject` (broker.ts) step for step: the same replay record, the same check that the org's own GitHub connection reaches each repository, the same
// registration as a new name. That function is in a hot file, so the primitives it uses are passed in (`CreateFromMetaDependencies`) and the broker wires them (the wiring is
// in the lane report). Nothing here names a company or a code host beyond GitHub, the only host the repository checks support today.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, CreateProjectFromMetaBodySchema, DEFAULT_ORCHESTRATOR_INSTRUCTIONS, agentXError, canonicalJson, githubNotConnectedMessage, projectRevisionKey, type CreateProjectFromMetaBody, type Ec2RuntimeBinding, type OrgId } from "@rovara-code/contracts";
import { ProjectDefinitionSchema, type ProjectDefinition } from "@agentx/cloud-contracts";
import { projectCreateRequestKey, type OrgRole } from "@agentx/cloud-contracts";
import type { TransactItem } from "../audit/outbox.js";
import { cloudRepositoryEntry } from "./cloud-projects.js";
import { readRequestRecord, requestRecordPut, requireSameRequest } from "./request-records.js";

export interface CreateFromMetaCaller { developerId: string; orgId: OrgId; orgRole: OrgRole }

export interface CreateFromMetaDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** Where the org's projects run and the credential their repositories use (`cloudProjectDefaultsFromEnvironment`); undefined when the deployment sets none. */
  defaults: { runtimeBinding: Ec2RuntimeBinding; githubCredentialRef: string } | undefined;
  /** The broker's `requireRepositoryConnected` over its repository gate: whether the org's own GitHub connection reaches the repository. Throws GITHUB_NOT_CONNECTED. */
  requireRepositoryConnected(orgId: OrgId, owner: string, name: string): Promise<{ installationId: number; githubRepositoryId: number }>;
  /** GitHub's own description of a repository, through the App. */
  repositoryIdentity(url: string, orgId: OrgId): Promise<{ repositoryId: number; fullName: string; defaultBranch?: string | undefined } | undefined>;
  /** The broker's `registerProjectFor`. */
  registerProject(
    actor: { orgId: OrgId; ownerKey: string },
    input: { definition: ProjectDefinition; runtimeBinding: Ec2RuntimeBinding },
    options: { creatorMembership: "developer"; requireNewName: true; description?: string; extraItems: TransactItem[] },
  ): Promise<{ project: { definition: ProjectDefinition; registeredAt: string }; duplicate: boolean; warnings?: string[] }>;
}

/** What a tenant is told of a project it created: no runtime binding and no credential reference. */
export interface MetaProjectCreated {
  duplicate: boolean;
  project: {
    definition: Omit<ProjectDefinition, "repositories"> & { repositories: Array<Pick<ProjectDefinition["repositories"][number], "name" | "url" | "path" | "defaultBranch" | "role" | "alsoCode">> };
    registeredAt: string;
  };
  warnings?: string[];
}

function answer(registered: { project: { definition: ProjectDefinition; registeredAt: string }; duplicate: boolean; warnings?: string[] }): MetaProjectCreated {
  const { definition } = registered.project;
  return {
    duplicate: registered.duplicate,
    project: {
      definition: { ...definition, repositories: definition.repositories.map(({ name, url, path, defaultBranch, role, alsoCode }) => ({ name, url, path, defaultBranch, ...(role === undefined ? {} : { role }), ...(alsoCode === undefined ? {} : { alsoCode }) })) },
      registeredAt: registered.project.registeredAt,
    },
    ...(registered.warnings === undefined ? {} : { warnings: registered.warnings }),
  };
}

export function parseCreateFromMetaBody(body: unknown): CreateProjectFromMetaBody {
  const parsed = CreateProjectFromMetaBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

const splitFullName = (fullName: string): { owner: string; name: string } => {
  const [owner, rawName] = fullName.split("/") as [string, string];
  return { owner, name: rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName };
};

/** The identity of a request for a replay: repositories without regard to case, in the order given (the first code repository is where commands run). */
function bodyHash(input: CreateProjectFromMetaBody): string {
  return createHash("sha256").update(canonicalJson({
    kind: "from-meta",
    meta: input.metaRepository.toLowerCase(),
    ...(input.codeRepositories === undefined ? {} : { code: input.codeRepositories.map((name) => name.toLowerCase()) }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
  }), "utf8").digest("hex");
}

async function replayed(deps: CreateFromMetaDependencies, orgId: OrgId, requestId: string, by: string, hash: string): Promise<MetaProjectCreated | undefined> {
  const recorded = await readRequestRecord(deps.documentClient, deps.tableName, projectCreateRequestKey(orgId, requestId), deps.now());
  if (recorded === undefined || typeof recorded.projectName !== "string") return undefined;
  requireSameRequest(recorded, { by, bodyHash: hash }, "this requestId was already used to create a different project");
  const made = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectRevisionKey(orgId, recorded.projectName, 1), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (made === undefined) return undefined;
  const parsed = ProjectDefinitionSchema.safeParse(made.definition);
  if (!parsed.success || typeof made.registeredAt !== "string") return undefined;
  return answer({ project: { definition: parsed.data, registeredAt: made.registeredAt }, duplicate: true });
}

/**
 * Creates the project: a replay of the request answers the project it made (another body is IDEMPOTENCY_CONFLICT); each repository must be reached through the org's own
 * GitHub connection, and GitHub's description of it must agree with the connection's (a repository deleted and recreated between the two reads is not that repository); then one
 * registration as a new name, which writes the project, its META, the caller's grant and the request's record in one transaction. The caller has already been checked for
 * the install and the role (`createProjectFromMetaRoute`).
 */
export async function createProjectFromMeta(deps: CreateFromMetaDependencies, caller: CreateFromMetaCaller, input: CreateProjectFromMetaBody): Promise<MetaProjectCreated> {
  const hash = bodyHash(input);
  const earlier = await replayed(deps, caller.orgId, input.requestId, caller.developerId, hash);
  if (earlier !== undefined) return earlier;
  if (deps.defaults === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "creating projects is not set up in this deployment; ask Rovara support");
  const defaults = deps.defaults;

  const separate = input.codeRepositories !== undefined;
  const wanted = [...(input.codeRepositories ?? []).map((fullName) => ({ fullName, role: "code" as const })), { fullName: input.metaRepository, role: "meta" as const }];
  const repositories: ProjectDefinition["repositories"] = [];
  for (const [index, { fullName, role }] of wanted.entries()) {
    const { owner, name } = splitFullName(fullName);
    const where = `${owner}/${name}`;
    const place = role === "meta" ? "metaRepository" : `codeRepositories.${String(index)}`;
    const connection = await deps.requireRepositoryConnected(caller.orgId, owner, name);
    const identity = await deps.repositoryIdentity(`https://github.com/${where}.git`, caller.orgId);
    if (identity === undefined) throw agentXError("GITHUB_NOT_CONNECTED", githubNotConnectedMessage(where));
    if (identity.repositoryId !== connection.githubRepositoryId) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub described ${where} differently a moment ago; try again`);
    const spelledOwner = identity.fullName.split("/")[0];
    if (spelledOwner === undefined || identity.defaultBranch === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub did not describe that repository; try again");
    if (spelledOwner.toLowerCase() !== owner.toLowerCase()) throw agentXError("FORBIDDEN", `GitHub describes ${where} under ${spelledOwner}; use its current owner/name`);
    const entry = cloudRepositoryEntry({ repositoryName: name, repository: { fullName: identity.fullName, defaultBranch: identity.defaultBranch }, githubCredentialRef: defaults.githubCredentialRef, connection });
    if (repositories.some((other) => other.name === entry.name)) {
      throw agentXError("CONFIG_INVALID", `${place}: another repository would also be called ${entry.name}; rename one of them on GitHub first`);
    }
    repositories.push(role === "meta" ? { ...entry, role: "meta", ...(separate ? {} : { alsoCode: true }) } : { ...entry, role: "code" });
  }
  const metaEntry = repositories[repositories.length - 1]!;
  const parsed = ProjectDefinitionSchema.safeParse({
    name: input.name ?? metaEntry.name,
    revision: 1,
    repositories,
    setup: [],
    readiness: [],
    orchestratorInstructions: DEFAULT_ORCHESTRATOR_INSTRUCTIONS,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const definition = parsed.data;
  const nowMs = deps.now();
  const requestKey = projectCreateRequestKey(caller.orgId, input.requestId);
  try {
    const registered = await deps.registerProject(
      { orgId: caller.orgId, ownerKey: caller.developerId },
      { definition, runtimeBinding: defaults.runtimeBinding },
      {
        creatorMembership: "developer", requireNewName: true, ...(input.description === undefined ? {} : { description: input.description }),
        extraItems: [requestRecordPut(deps.tableName, requestKey, "PROJECT_CREATE_REQUEST", { by: caller.developerId, bodyHash: hash, projectName: definition.name }, nowMs)],
      },
    );
    console.log(JSON.stringify({ component: "broker", event: "developer.project_created", orgId: caller.orgId, project: definition.name, duplicate: registered.duplicate, fromMeta: true, separateMeta: separate }));
    return answer(registered);
  } catch (error) {
    // An identical request in flight may have won the name a moment ago: its record is then there, and this one answers the same project.
    if (error instanceof AgentXError && error.code === "PROJECT_NAME_TAKEN") {
      const raced = await replayed(deps, caller.orgId, input.requestId, caller.developerId, hash);
      if (raced !== undefined) return raced;
    }
    throw error;
  }
}

/**
 * The route's own checks, then `createProjectFromMeta`: another install's projects are created by an administrator, and only an owner or admin creates one. The developer
 * routes call this where they call `createProject` today, when `isCreateFromMetaBody(body)` (wiring pending: `developer-routes.ts` is a hot file).
 */
export async function createProjectFromMetaRoute<Caller extends CreateFromMetaCaller>(
  deps: { cloud: boolean; createFromMeta?: (caller: Caller, input: CreateProjectFromMetaBody) => Promise<MetaProjectCreated> },
  caller: Caller,
  body: unknown,
): Promise<{ status: number; body: MetaProjectCreated }> {
  if (!deps.cloud) throw agentXError("FORBIDDEN", "projects on this install are created by an administrator; ask an administrator to run agentx project add");
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can create a project; ask your organization's owner");
  if (deps.createFromMeta === undefined) throw agentXError("NOT_FOUND", "project creation is not set up in this deployment");
  const created = await deps.createFromMeta(caller, parseCreateFromMetaBody(body));
  return { status: created.duplicate ? 200 : 201, body: created };
}
