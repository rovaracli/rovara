// Lane B reviewed archive integration: no task cancellation; effects happen only after the audited commit.
import { AgentXError, agentXError, ReviewedProjectArchiveBodySchema, ReviewedProjectArchivePreviewSchema, ReviewedProjectArchiveOutcomeSchema, type ReviewedProjectArchiveOutcome } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { logDeveloperEvent } from "../developer/log.js";
import { commitReviewedProjectArchive, readProjectArchivePreview } from "./reviewed-project-archive.js";
import { setEgressOwnerActive, type EgressDomainsDependencies } from "./egress-domains.js";
type Deps = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now" | "audit" | "projectArchived"> & { egress: EgressDomainsDependencies; /** v1.2 learning loop: deletes the project's learning data once the archive has applied; best effort (a failure is never an archive failure). */ clearLearning?: (orgId: DeveloperCaller["orgId"], project: string) => Promise<void> };
const unknownOutcome = () => agentXError("AUDIT_UNAVAILABLE", "The archive outcome could not be confirmed. Refresh before trying again.");
export async function readReviewedProjectArchiveAppPreview(deps: Pick<Deps,"documentClient"|"tableName"|"now"|"audit">, caller: DeveloperCaller, name: string) {
 const current = await readProjectArchivePreview(deps, caller, name);
 return ReviewedProjectArchivePreviewSchema.parse({ ...current, orgId: caller.orgId, access: { actions: current.status === "active" ? ["archive"] : [] } });
}
export async function archiveProjectReviewedWithEffects(deps: Deps, caller: DeveloperCaller, name: string, body: unknown): Promise<ReviewedProjectArchiveOutcome> {
 const parsed = ReviewedProjectArchiveBodySchema.safeParse(body);
 if (!parsed.success) throw agentXError("CONFIG_INVALID", "Review the project and acknowledge that new work stops before archiving.");
 if (parsed.data.expectedOrgId !== undefined && parsed.data.expectedOrgId !== caller.orgId) throw agentXError("CHANGE_STALE", "The company changed. Refresh and review the archive again.");
 const change = { requestId: parsed.data.requestId, expectedRevision: parsed.data.expectedRevision, expectedProjectRevision: parsed.data.expectedProjectRevision };
 try {
  const outcome = await commitReviewedProjectArchive(deps, caller, name, change);
  const effects: ReviewedProjectArchiveOutcome["effects"] = { egress: "not_attempted", archiveHook: "not_attempted" };
  if (!outcome.replayed) {
   logDeveloperEvent({ event: "developer.project_archived", orgId: caller.orgId, project: name });
   // Like the existing archive route, META commits first. The scheduled reconciler repairs a crash,
   // failed flip or racing restore; synchronized means this sync succeeded, not an atomic firewall guarantee.
   try { const { warning } = await setEgressOwnerActive(deps.egress, caller.orgId, { kind: "project", project: name }, false);effects.egress = warning === undefined ? "synchronized" : "pending";if (warning !== undefined) logDeveloperEvent({ event: "developer.project_archived_egress_pending", orgId: caller.orgId, project: name, reason: "sync_pending" }); }
   catch { effects.egress = "pending";logDeveloperEvent({ event: "developer.project_archived_egress_pending", orgId: caller.orgId, project: name, reason: "flip_failed" }); }
   effects.archiveHook = "not_configured";
   if (deps.projectArchived !== undefined) {
    try { await deps.projectArchived(caller.orgId, name);effects.archiveHook = "completed"; }
    catch { effects.archiveHook = "pending";logDeveloperEvent({ event: "developer.project_archived_hook_failed", orgId: caller.orgId, project: name, error: "Unavailable" }); }
   }
   if (deps.clearLearning !== undefined) { try { await deps.clearLearning(caller.orgId, name); } catch { logDeveloperEvent({ event: "developer.project_archived_learning_failed", orgId: caller.orgId, project: name, error: "Unavailable" }); } }
  }
  // Freshly authorize and read even on replay, which may follow restore. Failure is an unknown
  // outcome, never an invitation to automatically repeat a consequential write with a new UUID.
  try {
   const current = await readReviewedProjectArchiveAppPreview(deps, caller, name);
   return ReviewedProjectArchiveOutcomeSchema.parse({ ...outcome, current, effects });
  } catch {
   // The receipt has already been confirmed. A later access loss is an unknown current
   // state, not a refusal of the committed action; never disclose data to recover it.
   throw unknownOutcome();
  }
 } catch (error) {
  if (error instanceof AgentXError) {
   if (error.code === "CONFIG_INVALID") throw agentXError("CHANGE_STALE", "The project changed. Refresh and review the archive again.");
   throw error;
  }
  throw unknownOutcome();
 }
}
