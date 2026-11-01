// Live interaction F2 to F4: the audit of diagnoses. Ids, fixed words and counts only (the builders in audit/events.ts take no text). A failure to audit never fails the diagnosis or the proposal: the
// action is already done, and a failure leaves no event and logs only a name.
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { AuditEventInput } from "@agentx/contracts";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditDeps } from "../audit/outbox.js";

export interface DiagnosisAuditDependencies extends AuditDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

/** Records one event. Never throws. */
export async function auditDiagnosis(deps: DiagnosisAuditDependencies, build: () => AuditEventInput): Promise<void> {
  try {
    const events = await tryAuditEvents(deps, () => [build()]);
    const items = events.flatMap((event) => auditPending(deps, event));
    if (items.length > 0) await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    await flushAuditEvents(deps, events);
  } catch (error) {
    deps.audit?.log({ event: "diagnosis.audit_failed", level: "warn", error: error instanceof Error ? error.name : "unknown" });
  }
}
