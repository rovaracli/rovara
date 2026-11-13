// The audit facet in one vocabulary: Cloud's audit actions (`AUDIT_ACTIONS`, cloud-contracts). Cloud's path records them directly (its audit outbox,
// captured by `capturingAuditDeps`). The core records its own actions through the Cloud audit sink (A7, `onInvalid: "skip"`), which maps each to a Cloud
// action with `CORE_AUDIT_EVENT_MAP`; an event the sink would not record shows as `unrecorded:<refusal>:<core action>`, never dropped silently.
import type { AuditEvent } from "@rovara-code/contracts";
import { toCloudAuditEvent } from "../../../../packages/broker/src/cloud/adapters/audit-sink/index.js";

export function coreAuditWord(event: AuditEvent): string {
  const mapped = toCloudAuditEvent(event);
  return mapped.ok ? mapped.event.action : `unrecorded:${mapped.refusal}:${event.action}`;
}
