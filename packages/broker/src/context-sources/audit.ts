// The audit trail of private MCP servers and project Sources: the adapters that turn the hooks of mcp-servers.ts and settings.ts into ledger events (audit/events.ts) and record them
// durably (audit/flush.ts: the event is a pending item first, then sent). The admin change has already committed when its hook runs, so this is the "record after" pattern used where
// the store cannot join the ledger's transaction; a failure is logged by the ledger and never undoes the decision (`told` in the callers). Ids, fixed words and flags only: the server's
// label goes in the event's org details; its address, its token and a source's name never do.
import { auditContextSourceChange, auditMcpServerChangedNeedsReview, auditMcpServerEgressUpdated, auditMcpServerTaskStarted, auditMcpServerTaskStopped, auditMcpServerApproved, auditMcpServerChanged, auditMcpServerInstalled, auditMcpServerProbed, auditMcpServerTokenChanged, auditOccurrence } from "../audit/events.js";
import { recordAuditEventDurably } from "../audit/flush.js";
import type { AuditDeps } from "../audit/outbox.js";
import type { DrainDependencies } from "./controller-events.js";
import type { McpServerDependencies } from "./mcp-servers.js";
import type { SettingsDependencies } from "./settings.js";

/** The `audit` hook of the MCP servers flow; undefined where the install has no ledger (nothing is built or looked up). */
export function mcpServerAudit(deps: AuditDeps, now: () => number): McpServerDependencies["audit"] | undefined {
  if (deps.audit === undefined) return undefined;
  return async (event) => {
    const at = new Date(now()).toISOString();
    const base = { orgId: event.actor.orgId, actor: { kind: "member" as const, id: event.actor.developerId }, occurredAt: at, occurrence: auditOccurrence(event.serverId, at) };
    // One occurrence per kind of fact: the same server can be installed, tested and approved at the same moment under one clock reading.
    const occurrence = auditOccurrence(event.serverId, at, event.action);
    switch (event.action) {
      case "mcp_server.token_changed": await recordAuditEventDurably(deps, auditMcpServerTokenChanged({ ...base, serverId: event.serverId, change: event.change })); return;
      case "mcp_server.approved": await recordAuditEventDurably(deps, auditMcpServerApproved({ ...base, occurrence, serverId: event.serverId, label: event.label, transport: event.transport, hasToken: event.hasToken, ...(event.pin === undefined ? {} : { pin: event.pin }) })); return;
      case "mcp_server.installed": await recordAuditEventDurably(deps, auditMcpServerInstalled({ ...base, occurrence, serverId: event.serverId, name: event.name, version: event.version, integrity: event.integrity, lockfileHash: event.lockfileHash, bundleHash: event.bundleHash, packageCount: event.packageCount, unpackedBytes: event.unpackedBytes })); return;
      case "mcp_server.probed": await recordAuditEventDurably(deps, auditMcpServerProbed({ ...base, occurrence, serverId: event.serverId, purpose: event.purpose, toolsHash: event.toolsHash, bundleHash: event.bundleHash, toolCount: event.toolCount })); return;
      default: await recordAuditEventDurably(deps, auditMcpServerChanged({ ...base, action: event.action, serverId: event.serverId, label: event.label, transport: event.transport, hasToken: event.hasToken }));
    }
  };
}

/** The `audit` hook of the Sources settings. */
export function contextSourceAudit(deps: AuditDeps, now: () => number): SettingsDependencies["audit"] | undefined {
  if (deps.audit === undefined) return undefined;
  return async (event) => {
    const at = new Date(now()).toISOString();
    await recordAuditEventDurably(deps, auditContextSourceChange({
      orgId: event.actor.orgId, actor: { kind: "member", id: event.actor.developerId }, occurredAt: at, occurrence: auditOccurrence(event.changeId),
      action: event.action, projectName: event.project, sourceId: event.sourceId, change: event.change, related: [event.changeId],
    }));
  };
}

/**
 * The `audit` hook of the controller's events: each is recorded as the system's own fact about a package-run server. The event's sort key is the occurrence, so draining the same event
 * twice (after a failure between recording and marking) is one event in the ledger.
 */
export function controllerEventAudit(deps: AuditDeps): DrainDependencies["audit"] | undefined {
  if (deps.audit === undefined) return undefined;
  return async (orgId, sk, event) => {
    const base = { orgId, actor: { kind: "system" as const, id: "rovara" as const }, occurredAt: event.at, occurrence: sk };
    switch (event.type) {
      case "task_started": await recordAuditEventDurably(deps, auditMcpServerTaskStarted({ ...base, serverId: event.serverId, trigger: event.trigger })); return;
      case "task_stopped": await recordAuditEventDurably(deps, auditMcpServerTaskStopped({ ...base, serverId: event.serverId, reason: event.reason })); return;
      case "egress_updated": await recordAuditEventDurably(deps, auditMcpServerEgressUpdated({ ...base, serverId: event.serverId, added: event.added, removed: event.removed, addresses: event.addresses })); return;
      case "changed_needs_review": await recordAuditEventDurably(deps, auditMcpServerChangedNeedsReview({ ...base, serverId: event.serverId, approvedToolsHash: event.approved, observedToolsHash: event.observed })); return;
    }
  };
}
