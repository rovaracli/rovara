// Internal project-scoped read seam; no HTTP, save or task-admission consumer.
import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentXError, OrgIdSchema, AgentXNameSchema, ProjectWorkingBranchPageBodySchema, ProjectWorkingBranchPageSchema, WorkingBranchPageFactsSchema, agentXError, canonicalJson } from "@rovara-code/contracts";
import { type StoredProjectDefinition } from "@agentx/cloud-contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { parseGitHubRepository } from "../github-app.js";
import { githubPinsOf } from "./project-working-branch-host.js";
import { readProjectLifecycleAuthority as authority, readProjectLifecycleState as projectState, validateProjectLifecycleIdentifiers as identifiers } from "./reviewed-project-archive.js";
type Repository = Readonly<StoredProjectDefinition["repositories"][number]>;
export type WorkingBranchListDependencies = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now"> & { checkRepository?: (orgId: string, repository: Repository) => Promise<unknown>; listBranches?: (orgId: string, repository: Repository, page: number) => Promise<unknown> };
const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), lifecycle = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const identity = z.object({ installationId: number, repositoryId: number }).strict();
const continuation = z.object({ version: z.literal(1), orgId: OrgIdSchema, developerId: z.string().regex(/^[a-f0-9]{64}$/), project: AgentXNameSchema, repository: AgentXNameSchema, expectedRevision: lifecycle, expectedProjectRevision: number, installationId: number, repositoryId: number, definitionHash: z.string().regex(/^[a-f0-9]{64}$/), page: z.number().int().min(2).max(1000) }).strict();
const invalid = () => agentXError("CONFIG_INVALID", "Review a valid project repository and branch page.");
const stale = () => agentXError("CHANGE_STALE", "The company, project or branch page changed. Refresh and start the branch list again.");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Working branches could not be checked. Try again.");
function safe(error: unknown) {
  if (error instanceof AgentXError) {
    if (error.code === "CONFIG_INVALID") return invalid();
    if (error.code === "CHANGE_STALE") return stale();
    if (error.code === "FORBIDDEN") return agentXError("FORBIDDEN", "Only a current project maintainer can list working branches.");
    if (error.code === "NOT_FOUND") return agentXError("NOT_FOUND", "That project or repository is unavailable in this company.");
    if (error.code === "GITHUB_NOT_CONNECTED") return agentXError("GITHUB_NOT_CONNECTED", "Reconnect this project's repository before listing working branches.");
  }
  return unavailable();
}
export async function readProjectWorkingBranchPage(deps: WorkingBranchListDependencies, caller: DeveloperCaller, name: string, body: unknown) {
  try {
    const scope = Object.freeze({ ...caller }), parsed = ProjectWorkingBranchPageBodySchema.safeParse(body);
    if (!parsed.success) throw invalid();
    const input = parsed.data;
    identifiers(scope, name);
    if (input.expectedOrgId !== scope.orgId) throw stale();
    await authority(deps, scope, name);
    const state = await projectState(deps, scope, name);
    if (state.status !== "active" || state.epoch !== input.expectedRevision || state.projectRevision !== input.expectedProjectRevision) throw stale();
    const selected = state.definition.repositories.find(repo => repo.name === input.repository);
    if (selected === undefined) throw agentXError("NOT_FOUND", "Repository unavailable.");
    const registered = structuredClone(selected), pins = githubPinsOf(registered), github = parseGitHubRepository(registered.url);
    if (github.name === "." || github.name === ".." || pins.installationId === undefined || pins.githubRepositoryId === undefined) throw invalid();
    const snapshot = canonicalJson(state.definition), definitionHash = createHash("sha256").update(snapshot).digest("hex");
    const binding = { version: 1 as const, orgId: scope.orgId, developerId: scope.developerId, project: name, repository: input.repository, expectedRevision: state.epoch, expectedProjectRevision: state.projectRevision, installationId: pins.installationId, repositoryId: pins.githubRepositoryId, definitionHash };
    let page = 1;
    if (input.cursor !== undefined) {
      let cursor: z.infer<typeof continuation>;
      try {
        const text = Buffer.from(input.cursor, "base64url").toString("utf8");
        cursor = continuation.parse(JSON.parse(text) as unknown);
        if (canonicalJson(cursor) !== text || Buffer.from(text).toString("base64url") !== input.cursor) throw invalid();
      } catch { throw invalid(); }
      const { page: nextPage, ...prior } = cursor;
      if (canonicalJson(prior) !== canonicalJson(binding)) throw stale();
      page = nextPage;
    }
    const check = deps.checkRepository, list = deps.listBranches;
    if (check === undefined || list === undefined) throw unavailable();
    async function connected() {
      const checked = identity.parse(await check!(scope.orgId, structuredClone(registered)));
      if (checked.installationId !== pins.installationId || checked.repositoryId !== pins.githubRepositoryId) throw unavailable();
    }
    await connected();
    const facts = WorkingBranchPageFactsSchema.parse(await list(scope.orgId, structuredClone(registered), page));
    if (facts.page !== page) throw unavailable();
    await connected();
    await authority(deps, scope, name);
    const current = await projectState(deps, scope, name);
    if (current.status !== "active" || current.epoch !== state.epoch || current.projectRevision !== state.projectRevision || canonicalJson(current.definition) !== snapshot) throw stale();
    const nextCursor = facts.mayHaveMore && page < 1000 ? Buffer.from(canonicalJson({ ...binding, page: page + 1 })).toString("base64url") : undefined;
    return ProjectWorkingBranchPageSchema.parse({ orgId: scope.orgId, project: name, repository: input.repository, repositoryFullName: `${github.owner}/${github.name}`, expectedRevision: state.epoch, expectedProjectRevision: state.projectRevision, checkedAt: new Date(deps.now()).toISOString(), ...facts, limitReached: facts.mayHaveMore && page === 1000, ...(nextCursor === undefined ? {} : { nextCursor }) });
  } catch (error) { throw safe(error); }
}
