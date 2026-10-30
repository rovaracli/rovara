import { planPendingWebsiteInvalidation } from "./project-domain-invalidation.js";
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, canonicalJson, projectMetaKey, projectPk, type AuditActor, type AuditEventInput, type OrgId, type ProjectSettingsBody } from "@agentx/contracts";
import { auditPending, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import { auditOccurrence } from "../audit/events.js";
import { auditProjectAllowedDomains } from "../audit/allowed-domains.js";
import { planProjectEgressChange } from "./project-egress-plan.js";
export const directDomainReceiptKey = (orgId: OrgId, project: string, requestId: string) => ({ pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${requestId}` });
export const domainRequestHash = (orgId: OrgId, project: string, by: string, body: ProjectSettingsBody) => createHash("sha256").update(canonicalJson({ orgId, project, by, body })).digest("hex");
const digest = (domains: readonly string[]) => createHash("sha256").update(canonicalJson([...new Set(domains)].sort())).digest("hex");
interface Dependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; cloud: boolean; now(): Date; audit?: AuditRuntime }
/** Compose only; registration commits this plan with its immutable revision. */
export async function planLegacyDomainNarrowing(deps: Dependencies, input: { orgId: OrgId; project: string; by: string; auditActor?: AuditActor; body: ProjectSettingsBody; before: readonly string[]; after: readonly string[]; authority: TransactItem[] }): Promise<{ items: TransactItem[]; event: AuditEventInput }> {
 if (deps.audit === undefined || deps.audit.tableName !== deps.tableName || deps.audit.documentClient !== deps.documentClient) throw agentXError("AUDIT_UNAVAILABLE", "Website changes require the audit ledger.");
 const metaKey = projectMetaKey(input.orgId, input.project);
 const meta = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: metaKey, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
 if (meta === undefined || meta.status !== "active") throw agentXError("CHANGE_STALE", "Project website context changed. Review again.");
 const at = deps.now().toISOString(), now = Date.parse(at);
 const egress = await planProjectEgressChange(deps, { orgId: input.orgId, project: input.project, actorId: input.by, domains: input.after });
 const invalidation = await planPendingWebsiteInvalidation(deps, { orgId: input.orgId, project: input.project, by: input.by, requestId: input.body.requestId, nextRevision: input.body.expectedRevision + 1, at });
 const event = auditProjectAllowedDomains({ orgId: input.orgId, actor: input.auditActor ?? { kind: "member", id: input.by }, occurredAt: at,
  occurrence: auditOccurrence(input.project, input.body.requestId, "direct_narrowing"), action: "changed", mode: "direct_narrowing", projectName: input.project,
  requestId: input.body.requestId, ...(invalidation.proposalId === undefined ? {} : { proposalId: invalidation.proposalId }), fromRevision: input.body.expectedRevision, toRevision: input.body.expectedRevision + 1,
  added: input.after.filter(domain => !input.before.includes(domain)).length, removed: input.before.filter(domain => !input.after.includes(domain)).length,
  beforeDigest: digest(input.before), afterDigest: digest(input.after),
 });
 const fields = ["status", "createdAt", "createdBy", "archiveRevision"];
 const names: Record<string, string> = {}, values: Record<string, unknown> = {}, conditions = ["attribute_exists(pk)"];
 for (const [i, field] of fields.entries()) { const name = `#m${String(i)}`, value = `:m${String(i)}`;names[name] = field;
  if (meta[field] === undefined) conditions.push(`attribute_not_exists(${name})`);else { conditions.push(`${name} = ${value}`);values[value] = meta[field]; }
 }
 const condition = { TableName: deps.tableName, Key: metaKey, ConditionExpression: conditions.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values };
 const description = input.body.description?.trim();
 const projectFence: TransactItem = description === undefined ? { ConditionCheck: condition } : { Update: { ...condition,
  UpdateExpression: description === "" ? "REMOVE description" : "SET description = :description", ExpressionAttributeValues: { ...values, ...(description === "" ? {} : { ":description": description }) },
 } };
 const pending = auditPending({ audit: deps.audit }, event);if (pending.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Website changes require the audit ledger.");
 const items: TransactItem[] = [...input.authority, projectFence, ...egress.items, ...invalidation.items, { Put: { TableName: deps.tableName,
  Item: { ...directDomainReceiptKey(input.orgId, input.project, input.body.requestId), entityType: "EGRESS_PROPOSAL", orgId: input.orgId, project: input.project, by: input.by,
   requestId: input.body.requestId, bodyHash: domainRequestHash(input.orgId, input.project, input.by, input.body), state: "applied", mode: "direct_narrowing",
   baseRevision: input.body.expectedRevision, resultRevision: input.body.expectedRevision + 1, createdAt: at, expiresAt: new Date(now + 86_400_000).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / 1000) + 31 * 86400 },
  ConditionExpression: "attribute_not_exists(pk)" } }, ...pending];
 if (items.length > 80) throw agentXError("CONFIG_INVALID", "This website change cannot fit one transaction.");
 return { items, event };
}
