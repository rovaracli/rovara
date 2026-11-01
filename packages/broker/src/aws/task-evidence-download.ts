// Proof and evidence (wire-proof): `GET /v1/app/tasks/{id}/evidence/{sha256}`, the one place a stored evidence artifact leaves the store. It exists only while the proof switch is on (`deps.evidence`): with it off the
// path is not a route at all. The reader's right to the task is the page's own rule (`resolveTaskAccess`: the owner, a person the task was shared with, or a member of the task's Slack channel who can use its project),
// checked on EVERY request, and only a role that may read the task is served; anyone else is told 403, a task that does not exist as well. What is served is only what the task's CURRENT pack names as available
// (`servableEvidenceArtifact`, in `serveEvidenceArtifact`); every download that is served is audited first, and one that cannot be audited does not happen.
import { agentXError } from "@agentx/contracts";
import type { AuditEventInput } from "@agentx/contracts";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { recordAuditEventDurably } from "../audit/flush.js";
import { can, resolveTaskAccess } from "../developer/task-access.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "./developer-tasks.js";
import { handleEvidenceDownload } from "./evidence-download-route.js";
import { RawReply } from "./status-reply.js";

export const EVIDENCE_DOWNLOAD_PATH = /^\/v1\/app\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/evidence\/([0-9a-f]{64})$/u;

export interface EvidenceDownloadRequest {
  /** The task routes' dependencies; `evidence` is present only while the proof switch is on. */
  deps: DeveloperTaskRouteDependencies;
  caller: DeveloperCaller;
  taskId: string;
  sha256: string;
  /** The gateway's request id: the audit event's occurrence, so each download is its own event. */
  requestId: string;
  now(): number;
  /** The task access check; the page's own by default. Tests stand in. */
  resolveAccess?: typeof resolveTaskAccess;
  /** Where the audit event goes; the durable write by default. */
  record?: (event: AuditEventInput) => Promise<void>;
}

/** The download, or undefined when the switch is off (the caller then goes on as if the path did not exist). */
export async function routeEvidenceDownload(request: EvidenceDownloadRequest): Promise<RawReply | undefined> {
  const port = request.deps.evidence;
  if (port === undefined) return undefined;
  const resolveAccess = request.resolveAccess ?? resolveTaskAccess;
  const record = request.record ?? ((event: AuditEventInput) => recordAuditEventDurably(port.download.audit === undefined ? {} : { audit: port.download.audit }, event));
  const response = await handleEvidenceDownload({
    deps: {
      store: port.download.store, presign: port.download.presign,
      authorize: async () => {
        const { task, role } = await resolveAccess(request.deps, request.caller, request.taskId);
        // Whoever may read the task page may read what it shows; a role that cannot read it is told the page's own not-found.
        if (!can(role, "read")) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
        const candidateDigest = task.workflow?.candidate?.digest;
        return { ownerKey: task.ownerKey, workspaceId: task.workspaceId, taskId: task.taskId, candidateDigest, view: await port.view(task, candidateDigest) };
      },
    },
    sha256: request.sha256, taskId: request.taskId,
    auditBase: { orgId: request.caller.orgId, actor: auditActorOf(request.caller.developerId), occurredAt: new Date(request.now()).toISOString(), occurrence: request.requestId },
    record,
  });
  return new RawReply(response);
}
