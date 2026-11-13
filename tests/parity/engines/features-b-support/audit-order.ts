// The audit ledger in order (area 26): every audit event of the run, in the order it was recorded, in Cloud's action names. Cloud: its audit outbox as the
// broker wrote it (AuditCapture). Core: the events the core recorded on its AuditSink, each mapped by A7's event map (toCloudAuditEvent); an event the map
// refuses shows as `refused:<core action>:<why>` (the A7 sink drops it with onInvalid "skip", so the ledger would not have it).
import type { AuditEvent } from "@rovara-code/contracts";
import { toCloudAuditEvent } from "../../../../packages/broker/src/cloud/adapters/audit-sink/index.js";
import { outcome } from "./outcomes.js";

export function coreLedgerOrder(events: readonly AuditEvent[]): string[] {
  return events.map((event) => {
    const mapped = toCloudAuditEvent(event);
    return mapped.ok ? mapped.event.action : `refused:${event.action}:${mapped.refusal}`;
  });
}

export function ledgerWords(actions: readonly string[]): string[] {
  return [outcome("audit", `count:${String(actions.length)}`), ...actions.map((action, index) => outcome("audit", `${String(index + 1).padStart(2, "0")}:${action}`))];
}
