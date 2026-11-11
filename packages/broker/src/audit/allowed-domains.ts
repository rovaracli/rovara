import { auditEventId, type AuditEventInput } from "@agentx/cloud-contracts";
import type { AuditBuilderBase } from "./events.js";
export type AllowedDomainAuditAction = "proposed" | "rejected" | "cancelled" | "changed";
export type AllowedDomainChangeMode = "initial" | "direct_narrowing" | "second_person" | "sole_owner_exception";
/** One bounded summary per transition. Fingerprints live in erasable details,
 * never permanent facts; full lists remain in the pinned immutable revision. */
export function auditProjectAllowedDomains(input: AuditBuilderBase & {
 action: AllowedDomainAuditAction; mode?: AllowedDomainChangeMode; projectName: string;
 requestId: string; proposalId?: string; fromRevision: number; toRevision: number;
 added: number; removed: number; beforeDigest: string; afterDigest: string;
}): AuditEventInput {
 const action = `project.allowed_domains_${input.action}` as const;
 return {
  eventId: auditEventId(action, input.occurrence), orgId: input.orgId, action,
  actor: input.actor, target: { kind: "project", name: input.projectName }, occurredAt: input.occurredAt,
  ...(input.related === undefined ? {} : { related: input.related }),
  ...(input.proof === undefined ? {} : { proof: input.proof }),
  facts: { fromRevision: input.fromRevision, toRevision: input.toRevision, requestId: input.requestId,
   ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }), added: input.added, removed: input.removed,
   ...(input.action !== "changed" || input.mode === undefined ? {} : { mode: input.mode }) },
  details: [{ subject: "org", fields: { beforeDigest: input.beforeDigest, afterDigest: input.afterDigest } }],
 };
}
