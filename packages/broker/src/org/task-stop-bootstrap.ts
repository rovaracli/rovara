// These items join the native organization creation transaction. No post-create
// ensure, runtime numeric default, independent ceiling, or enrollment side effect.
import { AuditEventInputSchema, DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, orgScoped, orgSettingsKey, type OrgId } from "@agentx/contracts";
import { auditTaskStopPolicySeeded } from "../audit/events.js";
import { auditPendingItem, type TransactItem } from "../audit/outbox.js";

export function taskStopBootstrapItems(tableName: string, orgId: OrgId, nowMs: number): TransactItem[] {
  const at = new Date(nowMs).toISOString();
  const occurrence = `task-stop-bootstrap-v1#${orgId}`;
  const event = AuditEventInputSchema.parse(auditTaskStopPolicySeeded({
    orgId, actor: { kind: "system", id: "rovara" }, occurredAt: at, occurrence,
    source: "bootstrap", mode: "rovara_estimate", revision: 1, ceilingMicrousd: DEFAULT_AGENT_GUARDRAILS.maxPerRunCeilingUsd * 1_000_000,
  }));
  const put = (Item: Record<string, unknown>): TransactItem => ({ Put: { TableName: tableName, Item, ConditionExpression: "attribute_not_exists(pk)" } });
  return [
    put({ ...orgSettingsKey(orgId, "TASK_STOP_POLICY"), entityType: "ORG_TASK_STOP_POLICY", orgId, revision: 1,
      policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } },
      enrollment: { version: 1, state: "disabled" },
      seedProvenance: { occurrence, source: "bootstrap", reviewRequired: true, seededAt: at },
      updatedBy: "system", updatedAt: at }),
    put({ ...agentGuardrailsKey(orgId), entityType: "AGENT_GUARDRAILS", orgId, revision: 1,
      guardrails: structuredClone(DEFAULT_AGENT_GUARDRAILS), updatedBy: "system", updatedAt: at }),
    put({ pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#bootstrap", entityType: "TASK_STOP_SEED", orgId,
      version: 1, occurrenceId: occurrence, source: "bootstrap", outcome: "created", completedAt: at, policyRevision: 1, auditOccurrence: event.eventId }),
    // Persist even when delivery runtime isn't wired yet: no audit-free money seed.
    put({ ...auditPendingItem(event, nowMs) }),
  ];
}
