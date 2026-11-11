// Read-only branch HTTP boundary: throttle state is separate from project/configuration effects.
import { AgentXNameSchema, ProjectWorkingBranchPageBodySchema, ProjectWorkingBranchPreviewBodySchema, ProjectWorkingBranchPreviewSchema, agentXError, orgScoped } from "@rovara-code/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { takeRateAt } from "../developer/page-comments.js";
import { readProjectLifecycleAuthority as authority } from "./reviewed-project-archive.js";
import { readProjectWorkingBranchPreview } from "./project-working-branch.js";
import { readProjectWorkingBranchPage } from "./project-working-branch-list.js";
const invalid = (preview: boolean) => agentXError("CONFIG_INVALID", preview ? "Review valid company, project and branch preview values." : "Review valid company, project and branch page values.");
const forbidden = (preview: boolean) => agentXError("FORBIDDEN", preview ? "Only a current project maintainer can preview a working branch." : "Only a current project maintainer can list working branches.");
const unavailable = (preview: boolean) => agentXError("RUNTIME_UNAVAILABLE", preview ? "The working branch preview could not be checked. Try again." : "Working branches could not be checked. Try again.");
async function withBranchSession<T>(session: { finish: () => Promise<void> }, read: () => Promise<T>): Promise<T> {
  let result;
  try { result = await read(); }
  catch (error) {
    // Cleanup cannot replace an already-sanitized core refusal.
    try { await session.finish(); } catch { /* preserve the core failure */ }
    throw error;
  }
  await session.finish();
  return result;
}
export async function readProjectWorkingBranchHttp(deps: DeveloperRouteDependencies, caller: DeveloperCaller, encodedProject: string, encodedRepository: string, url: URL, headers: Record<string, string | undefined>, preview = false) {
  let project: string, repository: string;
  try { project = decodeURIComponent(encodedProject); repository = decodeURIComponent(encodedRepository); } catch { throw agentXError("NOT_FOUND", "That project repository is unavailable."); }
  if (!AgentXNameSchema.safeParse(project).success || !AgentXNameSchema.safeParse(repository).success) throw agentXError("NOT_FOUND", "That project repository is unavailable.");
  if (headers.origin !== undefined && headers.origin !== new URL(deps.developer.issuer).origin) throw agentXError("FORBIDDEN", "This request didn't come from Rovara's app.");
  const values: Record<string, unknown> = {}, allowedKeys = new Set(["expectedOrgId", "expectedRevision", "expectedProjectRevision", preview ? "branch" : "cursor"]);
  for (const [key, value] of url.searchParams) {
    if (!allowedKeys.has(key) || Object.hasOwn(values, key)) throw invalid(preview);
    if (key === "expectedRevision" || key === "expectedProjectRevision") {
      if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw invalid(preview);
      values[key] = Number(value);
    } else values[key] = value;
  }
  const parsed = (preview ? ProjectWorkingBranchPreviewBodySchema : ProjectWorkingBranchPageBodySchema).safeParse({ ...values, repository });
  if (!parsed.success) throw invalid(preview);
  const scope = Object.freeze({ ...caller });
  if (parsed.data.expectedOrgId !== scope.orgId) throw agentXError("CHANGE_STALE", preview ? "The company changed. Refresh and review the branch preview again." : "The company changed. Refresh and review the branch list again.");
  // Required before any project existence read, rate write or provider work.
  try { await authority(deps, scope, project); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "FORBIDDEN") throw forbidden(preview);
    throw unavailable(preview);
  }
  let admitted: boolean;
  try { admitted = await takeRateAt(deps, { pk: orgScoped(scope.orgId, "WORKING_BRANCH_PAGES"), sk: scope.developerId }, 10, 60_000); } catch { throw unavailable(preview); }
  if (!admitted) throw agentXError("TOO_MANY_REQUESTS", preview ? "Too many working branch previews. Try again shortly." : "Too many branch pages. Try again shortly.");
  // Sequential conservative admission: later refusal does not refund earlier debits.
  try { admitted = await takeRateAt(deps, { pk: orgScoped(scope.orgId, "WORKING_BRANCH_ORG_PAGES"), sk: "ALL" }, 30, 60_000); } catch { throw unavailable(preview); }
  if (!admitted) throw agentXError("TOO_MANY_REQUESTS", preview ? "Too many company working branch previews. Try again shortly." : "Too many company branch pages. Try again shortly.");
  try { admitted = await takeRateAt(deps, { pk: orgScoped(scope.orgId, "WORKING_BRANCH_ORG_HOURLY_PAGES"), sk: "ALL" }, 1_200, 3_600_000, undefined, 3); } catch { throw unavailable(preview); }
  if (!admitted) throw agentXError("TOO_MANY_REQUESTS", preview ? "Too many working branch previews this hour. Try again later." : "Too many company branch pages this hour. Try again later.");
  if (preview) {
    const session = deps.projectWorkingBranchPreview?.();
    if (session === undefined) throw unavailable(preview);
    const result = await withBranchSession(session, () => readProjectWorkingBranchPreview({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...session }, scope, project, parsed.data));
    const { orgId, project: name, repository: registered, repositoryFullName, branch, commit, expectedRevision, expectedProjectRevision, checkedAt } = result;
    return ProjectWorkingBranchPreviewSchema.parse({ orgId, project: name, repository: registered, repositoryFullName, branch, commit, expectedRevision, expectedProjectRevision, checkedAt });
  }
  const session = deps.projectWorkingBranches?.();
  if (session === undefined) throw unavailable(preview);
  return withBranchSession(session, () => readProjectWorkingBranchPage({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...session }, scope, project, parsed.data));
}
