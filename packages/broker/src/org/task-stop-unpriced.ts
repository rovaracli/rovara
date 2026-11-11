import { randomUUID } from "node:crypto";
import { TransactGetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AuditEventInputSchema, TaskStopCompanyPolicySchema, auditEventId, orgMetaKey, orgSettingsKey } from "@agentx/cloud-contracts";
import { OrgIdSchema, agentXError, orgScoped } from "@rovara-code/contracts";
import { type AuditActor } from "@agentx/cloud-contracts";
import { auditPendingItem } from "../audit/outbox.js";
import { nativeSnapshotConditions } from "./native-snapshot-conditions.js";
import { failedIndexes } from "../agents/table-writes.js";

/** §2 paid branches with no trusted USD admission basis must refuse under M47.
 * Token/call/command bounds cannot be converted into money or an invented agent.
 * Disabled legacy orgs retain their existing admission; unknown scope never exempts. */
export async function requirePricedTaskStopAdmission(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now?: () => number },
 input: { orgId: unknown; actor: AuditActor; workKind: string }): Promise<void> {
 const parsed = OrgIdSchema.safeParse(input.orgId);
 if (!parsed.success) throw agentXError("TASK_STOP_CONFIG_MISSING", "Paid work requires a known company and a trusted dollar admission basis.");
 const orgId = parsed.data, keys = [orgMetaKey(orgId), orgSettingsKey(orgId, "TASK_STOP_POLICY"),
  { pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#bootstrap" }, { pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#upgrade" }];
 const reply = await deps.documentClient.send(new TransactGetCommand({ TransactItems: keys.map(Key => ({ Get: { TableName: deps.tableName, Key } })) })) as { Responses?: Array<{ Item?: Record<string, unknown> }> };
 if (reply.Responses?.length !== keys.length) throw agentXError("TASK_STOP_CONFIG_INVALID", "The spending snapshot is unreadable.");
 const rows = reply.Responses.map(row => row.Item), org = rows[0], company = rows[1];
 if (org?.closingAt !== undefined || org?.closedAt !== undefined) throw agentXError("FORBIDDEN", "The company is closed to new work.");
 if (org === undefined || org.pk !== keys[0]?.pk || org.sk !== keys[0]?.sk || org.orgId !== orgId) throw agentXError("TASK_STOP_CONFIG_MISSING", "Paid work requires a known company.");
 if (rows.some((row, index) => row !== undefined && (row.pk !== keys[index]?.pk || row.sk !== keys[index]?.sk || row.orgId !== orgId))) throw agentXError("TASK_STOP_CONFIG_INVALID", "The spending snapshot identity is invalid.");
 if (company !== undefined && (company.entityType !== "ORG_TASK_STOP_POLICY" || !Number.isSafeInteger(company.revision) || Number(company.revision) < 1 || !TaskStopCompanyPolicySchema.safeParse(company.policy).success)) throw agentXError("TASK_STOP_CONFIG_INVALID", "The company spending policy is invalid.");
 const enrollment = company?.enrollment;
 if (enrollment !== null && typeof enrollment === "object" && "version" in enrollment && enrollment.version === 1 && "state" in enrollment
  && (enrollment.state === "disabled" || enrollment.state === "ready")) return;
 if (company === undefined && rows[2] === undefined && rows[3] === undefined) return;
 const at = new Date((deps.now ?? Date.now)()).toISOString(), occurrence = randomUUID();
 const event = AuditEventInputSchema.parse({ eventId: auditEventId("spending.stop_refused", occurrence), orgId, action: "spending.stop_refused", actor: input.actor,
  target: { kind: "spend_policy", id: "task_stop" }, occurredAt: at, facts: { outcomeCode: "TASK_STOP_CONFIG_MISSING", workKind: input.workKind, admissionId: occurrence } });
 try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...nativeSnapshotConditions(deps.tableName, keys, rows, []),
  { Put: { TableName: deps.tableName, Item: auditPendingItem(event, Date.parse(at)), ConditionExpression: "attribute_not_exists(pk)" } }] })); }
 catch (error) { if (!failedIndexes(error)?.size) throw error; }
 throw agentXError("TASK_STOP_CONFIG_MISSING", "This paid path has no trusted dollar admission basis. Work cannot start.");
}
