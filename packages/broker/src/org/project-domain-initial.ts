import { createHash, randomUUID } from "node:crypto";
import { agentXError, canonicalJson, type AuditActor, type AuditEventInput, type OrgId } from "@agentx/contracts";
import { auditPending, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import { auditOccurrence } from "../audit/events.js";
import { auditProjectAllowedDomains } from "../audit/allowed-domains.js";
import { planProjectEgressChange } from "./project-egress-plan.js";
interface Dependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; audit?: AuditRuntime }
/** Creation-only plan; commit with the first immutable revision, new META and catalog. */
export async function planInitialProjectDomains(deps: Dependencies, input: { orgId: OrgId; project: string; actorId: string; actor: AuditActor; revision: number; domains: readonly string[]; at: string }): Promise<{ items: TransactItem[]; event: AuditEventInput }> {
 if (deps.audit === undefined || deps.audit.tableName !== deps.tableName || deps.audit.documentClient !== deps.documentClient) throw agentXError("AUDIT_UNAVAILABLE", "Website changes require the audit ledger.");
 const after = [...new Set(input.domains)].sort();
 const fingerprint = (domains: readonly string[]) => createHash("sha256").update(canonicalJson(domains)).digest("hex");
 const event = auditProjectAllowedDomains({ orgId: input.orgId, actor: input.actor, occurredAt: input.at,
  occurrence: auditOccurrence(input.project, String(input.revision), "initial"), action: "changed", mode: "initial", projectName: input.project,
  requestId: randomUUID(), fromRevision: 0, toRevision: input.revision, added: after.length, removed: 0, beforeDigest: fingerprint([]), afterDigest: fingerprint(after),
 });
 const pending = auditPending(deps, event);if (pending.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Website changes require the audit ledger.");
 const egress = await planProjectEgressChange({ ...deps, cloud: true, now: () => new Date(input.at) }, { orgId: input.orgId, project: input.project, actorId: input.actorId, domains: after });
 return { items: [...egress.items, ...pending], event };
}
