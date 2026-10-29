// Lane B restore application boundary: no automatic task start, no invented restore hook.
import { AgentXError, agentXError, ReviewedProjectRestoreBodySchema, ReviewedProjectRestorePreviewSchema, ReviewedProjectRestoreOutcomeSchema, type ReviewedProjectRestoreOutcome } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { logDeveloperEvent } from "../developer/log.js";
import { commitReviewedProjectRestore, readProjectRestorePreview } from "./reviewed-project-restore.js";
import { setEgressOwnerActive, type EgressDomainsDependencies } from "./egress-domains.js";
type Base = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now" | "audit" | "requireRepositoriesConnected" | "cloud">;
type Deps = Base & { egress: EgressDomainsDependencies };
const unknownOutcome = () => agentXError("AUDIT_UNAVAILABLE", "The restore outcome could not be confirmed. Refresh before trying again.");
function withRepositoryPolicy(deps: Base): Base {
 // Existing org/github-connection requireRepositoriesConnected returns immediately outside
 // Cloud, where org installation bindings are not required. Never infer this for Cloud.
 if (deps.requireRepositoriesConnected !== undefined || deps.cloud === true) return deps;
 return { ...deps, requireRepositoriesConnected: async () => undefined };
}
export async function readReviewedProjectRestoreAppPreview(deps: Base, caller: DeveloperCaller, name: string) {
 const current = await readProjectRestorePreview(withRepositoryPolicy(deps), caller, name);
 return ReviewedProjectRestorePreviewSchema.parse({ ...current, orgId: caller.orgId, access: { actions: current.status === "archived" && current.prerequisites === "checked" ? ["restore"] : [] } });
}
export async function restoreProjectReviewedWithEffects(deps: Deps, caller: DeveloperCaller, name: string, body: unknown): Promise<ReviewedProjectRestoreOutcome> {
 const parsed = ReviewedProjectRestoreBodySchema.safeParse(body);
 if (!parsed.success) throw agentXError("CONFIG_INVALID", "Review the project and acknowledge that new work can be requested before restoring.");
 // A displayed-company pin only fences the authenticated scope; it never selects it.
 if (parsed.data.expectedOrgId !== undefined && parsed.data.expectedOrgId !== caller.orgId) throw agentXError("CHANGE_STALE", "The company changed. Refresh and review the restore again.");
 const change = { requestId: parsed.data.requestId, expectedRevision: parsed.data.expectedRevision, expectedProjectRevision: parsed.data.expectedProjectRevision };
 try {
  const outcome = await commitReviewedProjectRestore(withRepositoryPolicy(deps), caller, name, change);
  const effects: ReviewedProjectRestoreOutcome["effects"] = { egress: "not_attempted" };
  if (!outcome.replayed) {
   logDeveloperEvent({ event: "developer.project_restored", orgId: caller.orgId, project: name });
   // Same derived-state order as legacy restore. Scheduled reconciliation repairs a crash,
   // failed flip/sync or racing archive; domain approval statuses are never changed here.
   try {
    const { warning } = await setEgressOwnerActive(deps.egress, caller.orgId, { kind: "project", project: name }, true);
    effects.egress = warning === undefined ? "synchronized" : "pending";
    if (warning !== undefined) logDeveloperEvent({ event: "developer.project_restored_egress_pending", orgId: caller.orgId, project: name, reason: "sync_pending" });
   } catch {
    effects.egress = "pending";logDeveloperEvent({ event: "developer.project_restored_egress_pending", orgId: caller.orgId, project: name, reason: "flip_failed" });
   }
  }
  try {
   const current = await readReviewedProjectRestoreAppPreview(deps, caller, name);
   return ReviewedProjectRestoreOutcomeSchema.parse({ ...outcome, current, effects });
  } catch {
   // A receipt was already confirmed. Access loss or an unreadable current state cannot
   // turn that committed action into a refusal or disclose data to recover the result.
   throw unknownOutcome();
  }
 } catch (error) {
  if (error instanceof AgentXError) {
   if (error.code === "CONFIG_INVALID") throw agentXError("CHANGE_STALE", "The project changed. Refresh and review the restore again.");
   throw error;
  }
  throw unknownOutcome();
 }
}
