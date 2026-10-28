// Read-only branch HTTP boundary: throttle state is separate from project/configuration effects.
import { AgentXNameSchema, ProjectWorkingBranchPageBodySchema, ProjectWorkingBranchPreviewBodySchema, ProjectWorkingBranchPreviewSchema, agentXError, orgScoped } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { takeRateAt } from "../developer/page-comments.js";
import { readProjectLifecycleAuthority as authority } from "./reviewed-project-archive.js";
import { readProjectWorkingBranchPreview } from "./project-working-branch.js";
import { readProjectWorkingBranchPage } from "./project-working-branch-list.js";
const invalid = () => agentXError("CONFIG_INVALID", "Review valid company, project and branch page values.");
const forbidden = () => agentXError("FORBIDDEN", "Only a current project maintainer can list working branches.");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Working branches could not be checked. Try again.");
export async function readProjectWorkingBranchHttp(deps: DeveloperRouteDependencies, caller: DeveloperCaller, encodedProject: string, encodedRepository: string, url: URL, headers: Record<string, string | undefined>, preview = false) {
  let project: string, repository: string;
  try { project = decodeURIComponent(encodedProject); repository = decodeURIComponent(encodedRepository); } catch { throw agentXError("NOT_FOUND", "That project repository is unavailable."); }
  if (!AgentXNameSchema.safeParse(project).success || !AgentXNameSchema.safeParse(repository).success) throw agentXError("NOT_FOUND", "That project repository is unavailable.");
  if (headers.origin !== undefined && headers.origin !== new URL(deps.developer.issuer).origin) throw agentXError("FORBIDDEN", "This request didn't come from Rovara's app.");
  const values: Record<string, unknown> = {}, allowedKeys = new Set(["expectedOrgId", "expectedRevision", "expectedProjectRevision", preview ? "branch" : "cursor"]);
  for (const [key, value] of url.searchParams) {
    if (!allowedKeys.has(key) || Object.hasOwn(values, key)) throw invalid();
    if (key === "expectedRevision" || key === "expectedProjectRevision") {
      if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw invalid();
      values[key] = Number(value);
    } else values[key] = value;
  }
  const parsed = (preview ? ProjectWorkingBranchPreviewBodySchema : ProjectWorkingBranchPageBodySchema).safeParse({ ...values, repository });
  if (!parsed.success) throw invalid();
  const scope = Object.freeze({ ...caller });
  if (parsed.data.expectedOrgId !== scope.orgId) throw agentXError("CHANGE_STALE", "The company changed. Refresh and review the branch list again.");
  // Required before any project existence read, rate write or provider work.
  try { await authority(deps, scope, project); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "FORBIDDEN") throw forbidden();
    throw unavailable();
  }
  let admitted: boolean;
  try { admitted = await takeRateAt(deps, { pk: orgScoped(scope.orgId, "WORKING_BRANCH_PAGES"), sk: scope.developerId }, 10, 60_000); } catch { throw unavailable(); }
  if (!admitted) throw agentXError("TOO_MANY_REQUESTS", "Too many branch pages. Try again shortly.");
  // Sequential conservative admission: later refusal does not refund earlier debits.
  try { admitted = await takeRateAt(deps, { pk: orgScoped(scope.orgId, "WORKING_BRANCH_ORG_PAGES"), sk: "ALL" }, 30, 60_000); } catch { throw unavailable(); }
  if (!admitted) throw agentXError("TOO_MANY_REQUESTS", "Too many company branch pages. Try again shortly.");
  try { admitted = await takeRateAt(deps, { pk: orgScoped(scope.orgId, "WORKING_BRANCH_ORG_HOURLY_PAGES"), sk: "ALL" }, 1_200, 3_600_000); } catch { throw unavailable(); }
  if (!admitted) throw agentXError("TOO_MANY_REQUESTS", "Too many company branch pages this hour. Try again later.");
  if (preview) {
    const result = await readProjectWorkingBranchPreview({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...deps.projectWorkingBranchPreview }, scope, project, parsed.data);
    const { orgId, project: name, repository: registered, repositoryFullName, branch, commit, expectedRevision, expectedProjectRevision, checkedAt } = result;
    return ProjectWorkingBranchPreviewSchema.parse({ orgId, project: name, repository: registered, repositoryFullName, branch, commit, expectedRevision, expectedProjectRevision, checkedAt });
  }
  return readProjectWorkingBranchPage({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...deps.projectWorkingBranches }, scope, project, parsed.data);
}
