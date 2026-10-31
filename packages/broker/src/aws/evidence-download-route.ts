// Proof and evidence P6: the HTTP answer for `GET /v1/app/tasks/{id}/evidence/{sha256}` and the audit event each download leaves. Everything is a function of the download decision from
// `serveEvidenceArtifact`; mounting the route (and building its dependencies from the task record) is one hunk in the hot file `developer-routes.ts`, see the lane report. The answer carries no task text, and
// a refusal says only that the thing is not there.
import { PRIVATE_HEADERS, safeResponse, type WebResponse } from "./web-session.js";
import type { AuditEventInput } from "@agentx/contracts";
import { auditEvidenceDownloaded, type AuditBuilderBase } from "../audit/events.js";
import { serveEvidenceArtifact, type EvidenceDownload, type EvidenceDownloadDependencies } from "./evidence-artifacts.js";

const NOT_FOUND = { error: "not_found" };
const FORBIDDEN = { error: "forbidden", message: "You don't have access to this task." };
const UNAVAILABLE = { error: "unavailable", message: "AgentX couldn't do that right now. Try again shortly." };

/** The response for a download decision. Bytes are served inline only for an image; a sample or a tail is an attachment, and nothing is ever rendered as a page. */
export function evidenceDownloadResponse(download: EvidenceDownload): WebResponse {
  switch (download.status) {
    case 403: return safeResponse(403, FORBIDDEN);
    case 404: return safeResponse(404, NOT_FOUND);
    case 503: return safeResponse(503, UNAVAILABLE);
    case 200: {
      const { pragma: _pragma, ...headers } = PRIVATE_HEADERS;
      void _pragma;
      return { statusCode: 200, isBase64Encoded: true, body: Buffer.from(download.bytes).toString("base64"),
        headers: { ...headers, "content-type": download.contentType, "cache-control": "private, max-age=60", "content-disposition": download.disposition,
          "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'" } };
    }
    case 302: {
      const { pragma: _pragma, ...headers } = PRIVATE_HEADERS;
      void _pragma;
      return { statusCode: 302, body: "", headers: { ...headers, location: download.location, "cache-control": "private, no-store, max-age=0" } };
    }
  }
}

/** The audit event of a download that was served (200 or 302); undefined for a refusal, which serves nothing. One per download: `occurrence` is the request id. */
export function evidenceDownloadAudit(download: EvidenceDownload, base: AuditBuilderBase, taskId: string): AuditEventInput | undefined {
  if (download.status !== 200 && download.status !== 302) return undefined;
  return auditEvidenceDownloaded({ ...base, taskId, artifactKind: download.kind, retentionClass: download.retentionClass });
}

/**
 * Serves one download: authorizes, decides, answers, and records the audit event for a served one. The audit write is the caller's (`record`); if it fails the artifact is NOT served (a download that
 * cannot be audited does not happen: the Auditor role depends on it).
 */
export async function handleEvidenceDownload(input: { deps: EvidenceDownloadDependencies; sha256: string; taskId: string; auditBase: AuditBuilderBase; record(event: AuditEventInput): Promise<void> }): Promise<WebResponse> {
  const download = await serveEvidenceArtifact(input.deps, input.sha256);
  const event = evidenceDownloadAudit(download, input.auditBase, input.taskId);
  if (event !== undefined) {
    try { await input.record(event); } catch { return evidenceDownloadResponse({ status: 503 }); }
  }
  return evidenceDownloadResponse(download);
}
