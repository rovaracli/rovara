// Convergence A7 (`cloud/audit-sink`): Cloud's AuditSink adapter on Code's port, and the map from the core's audit events to Cloud's ledger events. Registered for conformance
// (tests/conformance/adapters/audit-sink-cloud.ts), not switched in: nothing calls it and Cloud's live audit path (audit/outbox.ts, flush.ts, drain.ts) is unchanged.
export * from "./event-map.js";
export * from "./sink.js";
