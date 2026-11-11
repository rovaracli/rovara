// Index only final, nonerasable canonical metadata. Postings survive erasure and shredding.
import { createHash } from "node:crypto";
import type { AuditRecordV1 } from "@agentx/cloud-contracts";
export type AuditIndexDimension = "action" | "actor" | "target";
export const AUDIT_INDEX_COVERAGE = "FILTER#v1#COVERAGE";
export function auditFramed(parts: readonly string[]): Buffer {
  return Buffer.concat(parts.map(part => {
    const bytes = Buffer.from(part, "utf8"), length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  }));
}
export function auditIndexDigest(orgId: string, dimension: AuditIndexDimension, fields: readonly string[]): string {
  return createHash("sha256").update(auditFramed(["rovara.audit.index.v1", orgId, dimension, ...fields])).digest("hex");
}
export function auditIndexPrefix(dimension: AuditIndexDimension, digest: string): string { return `FILTER#v1#${dimension}#${digest}#SEQ#`; }
export function auditIndexPostings(record: AuditRecordV1): Array<Record<string, unknown>> {
  return (["action", "actor", "target"] as const).map(dimension => {
    const fields = dimension === "action" ? [record.action] : [record[dimension].kind, record[dimension].id];
    const digest = auditIndexDigest(record.orgId, dimension, fields);
    return { pk: `AUDIT#${record.orgId}`, sk: `${auditIndexPrefix(dimension, digest)}${String(record.seq).padStart(12, "0")}`, v: 1, orgId: record.orgId, dimension, digest, seq: record.seq, hash: record.hash };
  });
}
