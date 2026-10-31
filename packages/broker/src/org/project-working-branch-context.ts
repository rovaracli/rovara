// Fresh stored-project context for a future branch chooser. No provider calls or writes.
import { AgentXError, AgentXNameSchema, ProjectWorkingBranchContextQuerySchema, ProjectWorkingBranchContextSchema, agentXError, canonicalJson } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { parseGitHubRepository } from "../github-app.js";
import { githubPinsOf } from "./project-working-branch-host.js";
import { readProjectLifecycleAuthority as authority, readProjectLifecycleState as projectState, validateProjectLifecycleIdentifiers as identifiers } from "./reviewed-project-archive.js";
type Deps = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now">;
const invalid = () => agentXError("CONFIG_INVALID", "Review valid company and project context values.");
const stale = () => agentXError("CHANGE_STALE", "The company or project changed. Refresh the working branch context.");
const forbidden = () => agentXError("FORBIDDEN", "Only a current project maintainer can read working branch context.");
const missing = () => agentXError("NOT_FOUND", "That project is unavailable in this company.");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Working branch context could not be checked. Try again.");
export async function readProjectWorkingBranchContext(deps: Deps, caller: DeveloperCaller, name: string, body: unknown) {
  try {
    const scope = Object.freeze({ ...caller }), parsed = ProjectWorkingBranchContextQuerySchema.safeParse(body);
    if (!parsed.success) throw invalid();
    identifiers(scope, name);
    if (parsed.data.expectedOrgId !== scope.orgId) throw stale();
    await authority(deps, scope, name);
    const state = await projectState(deps, scope, name);
    if (state.status !== "active") throw stale();
    const snapshot = canonicalJson(state.definition), repositories: { name: string; fullName: string }[] = [];
    let omittedUnsupported = false;
    for (const repo of state.definition.repositories) {
      try {
        // A repository on another code host is not offered (the review is GitHub's today).
        const pins = githubPinsOf(repo), github = parseGitHubRepository(repo.url);
        if (/^\.+$/.test(github.name) || !Number.isSafeInteger(pins.installationId) || (pins.installationId ?? 0) < 1 || !Number.isSafeInteger(pins.githubRepositoryId) || (pins.githubRepositoryId ?? 0) < 1) throw invalid();
        repositories.push({ name: repo.name, fullName: `${github.owner}/${github.name}` });
      } catch { omittedUnsupported = true; }
    }
    // Context and every subsequent page/preview independently recheck live authority and pins.
    await authority(deps, scope, name);
    const current = await projectState(deps, scope, name);
    if (current.status !== "active" || current.epoch !== state.epoch || current.projectRevision !== state.projectRevision || canonicalJson(current.definition) !== snapshot) throw stale();
    return ProjectWorkingBranchContextSchema.parse({ orgId: scope.orgId, project: name, status: "active", expectedRevision: state.epoch, expectedProjectRevision: state.projectRevision, checkedAt: new Date(deps.now()).toISOString(), repositories, omittedUnsupported });
  } catch (error) {
    if (error instanceof AgentXError) {
      if (error.code === "CONFIG_INVALID") throw invalid();
      if (error.code === "CHANGE_STALE") throw stale();
      if (error.code === "FORBIDDEN") throw forbidden();
      if (error.code === "NOT_FOUND") throw missing();
    }
    throw unavailable();
  }
}
export async function readProjectWorkingBranchContextHttp(deps: DeveloperRouteDependencies, caller: DeveloperCaller, encodedName: string, url: URL, headers: Record<string, string | undefined>) {
  let name: string;
  try { name = decodeURIComponent(encodedName); } catch { throw missing(); }
  if (!AgentXNameSchema.safeParse(name).success) throw missing();
  if (headers.origin !== undefined && headers.origin !== new URL(deps.developer.issuer).origin) throw agentXError("FORBIDDEN", "This request didn't come from Rovara's app.");
  const values: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (key !== "expectedOrgId" || Object.hasOwn(values, key)) throw invalid();
    values[key] = value;
  }
  return readProjectWorkingBranchContext(deps, caller, name, values);
}
