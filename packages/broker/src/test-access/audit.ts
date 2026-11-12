// Customer test AWS account, lane TA2: the audit event of a connection change. The target is the connection. Facts are Regions, counts and fixed words; the account id, role, alias and project go in `details`
// (subject `org`). A token or an external id is never in an event. `version` is the connection's version AFTER the change, so the same change is the same event (replays and retries do not double-count).
import type { AuditActor, AuditEventInput, AuditProof } from "@agentx/cloud-contracts";
import { auditOccurrence, auditTestAccessChange, type TestAccessAuditAction } from "../audit/events.js";
import type { ConnectionRecord } from "./store.js";

export type ConnectionActor = { kind: "member"; developerId: string; proof?: AuditProof } | { kind: "system" };

export function connectionAudit(input: { record: ConnectionRecord; action: TestAccessAuditAction; actor: ConnectionActor; occurredAt: string; facts: Record<string, string | number | boolean | undefined> }): AuditEventInput {
  const { record } = input;
  const actor: AuditActor = input.actor.kind === "system" ? { kind: "system", id: "rovara" } : { kind: "member", id: input.actor.developerId };
  const fields: Record<string, string> = { projectId: record.projectId, region: record.region };
  if (record.accountId !== undefined) fields["accountId"] = record.accountId;
  if (record.roleArn !== undefined) fields["roleArn"] = record.roleArn;
  if (record.alias !== undefined) fields["alias"] = record.alias;
  return auditTestAccessChange({
    action: input.action,
    connectionId: record.connectionId,
    orgId: record.orgId,
    actor,
    occurredAt: input.occurredAt,
    occurrence: auditOccurrence(record.connectionId, input.action, String(record.version)),
    ...(input.actor.kind === "member" && input.actor.proof !== undefined ? { proof: input.actor.proof } : {}),
    details: [{ subject: "org", fields }],
    facts: input.facts,
  });
}
