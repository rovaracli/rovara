// Convergence A7 (`cloud/audit-sink`): Cloud's AuditSink under Code's audit-sink conformance suite, over Code's in-memory document store (no AWS). The suite's sample event is a core-shaped event with the
// action `task.approved`, which the real map does not carry (the core never records it): the harness adds a test-only entry for it, so the suite exercises the real path (a mapped event, a staged row, a
// stored row) and not the refusal.
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import { CORE_AUDIT_EVENT_MAP, createCloudAuditSink } from "../../../packages/broker/src/cloud/adapters/audit-sink/index.js";
import { defineCloudAdapter } from "../registry.js";

const FIXED_NOW = Date.parse("2026-11-09T10:00:00.000Z");
const map = { ...CORE_AUDIT_EVENT_MAP, "task.approved": { cloud: "task.closed", target: { id: "task" } } } as const;

export const cloudAuditSink = defineCloudAdapter({
  port: "audit-sink",
  name: "Cloud (audit outbox rows)",
  harness: { create: async () => createCloudAuditSink({ store: () => new MemoryDocumentStore(), now: () => FIXED_NOW, map }) },
});
