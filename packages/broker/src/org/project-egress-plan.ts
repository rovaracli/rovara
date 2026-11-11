import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AllowedDomainSchema, DEFAULT_AGENT_ALLOW_DOMAINS, EgressDomainsItemSchema, EGRESS_SYNC_KEY, agentXError, egressDomainsKey, type EgressDomainEntry, type OrgId } from "@rovara-code/contracts";
import type { TransactItem } from "../audit/outbox.js";
interface Dependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; cloud: boolean; now(): Date }
/** Read and plan only. The caller commits these items WITH its revision,
 * authority fences, receipt and one summary audit. No replan or standalone write. */
export async function planProjectEgressChange(deps: Dependencies, input: { orgId: OrgId; project: string; actorId: string; domains: readonly string[] }): Promise<{ items: TransactItem[]; pending: string[] }> {
 if (input.domains.length > 50) throw agentXError("CONFIG_INVALID", "At most 50 project website rules are allowed.");
 const wanted = [...new Set(input.domains.map(domain => AllowedDomainSchema.parse(domain)))].filter(domain => !DEFAULT_AGENT_ALLOW_DOMAINS.includes(domain)).sort();
 const owner = { kind: "project" as const, project: input.project }, key = egressDomainsKey(input.orgId, owner);
 const raw = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown }).Item;
 const parsed = raw === undefined ? undefined : EgressDomainsItemSchema.safeParse(raw);
 if (parsed !== undefined && !parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "The project's website approval record could not be read.");
 const current = parsed?.success ? parsed.data : undefined;
 if (current !== undefined && (current.orgId !== input.orgId || current.owner.kind !== "project" || current.owner.project !== input.project || !current.active)) throw agentXError("CHANGE_STALE", "Project website state changed. Review it again.");
 const previousTime = current === undefined ? 0 : Date.parse(current.updatedAt);
 if (!Number.isFinite(previousTime)) throw agentXError("RUNTIME_UNAVAILABLE", "The project's website approval record could not be read.");
 const at = new Date(Math.max(deps.now().getTime(), previousTime + 1)).toISOString();
 const domains: EgressDomainEntry[] = wanted.map(domain => current?.domains.find(entry => entry.domain === domain)
  ?? { domain, status: deps.cloud ? "pending" : "approved", requestedAt: at, requestedBy: input.actorId, ...(deps.cloud ? {} : { decidedAt: at }) });
 const approvedBefore = (current?.domains ?? []).filter(entry => entry.status === "approved").map(entry => entry.domain).sort();
 const approvedAfter = domains.filter(entry => entry.status === "approved").map(entry => entry.domain).sort();
 const items: TransactItem[] = [{ Put: {
  TableName: deps.tableName, Item: { ...key, entityType: "EGRESS_DOMAINS", orgId: input.orgId, owner, active: true, domains, updatedAt: at },
  ConditionExpression: current === undefined ? "attribute_not_exists(pk)" : "updatedAt = :seen",
  ...(current === undefined ? {} : { ExpressionAttributeValues: { ":seen": current.updatedAt } }),
 } }];
 if (JSON.stringify(approvedBefore) !== JSON.stringify(approvedAfter)) items.push({ Update: {
  TableName: deps.tableName, Key: EGRESS_SYNC_KEY,
  UpdateExpression: "SET dirtyAt = :at, entityType = :entity, dirtySeq = if_not_exists(dirtySeq, :zero) + :one",
  ExpressionAttributeValues: { ":at": at, ":entity": "EGRESS_SYNC", ":zero": 0, ":one": 1 },
 } });
 return { items, pending: domains.filter(entry => entry.status === "pending").map(entry => entry.domain) };
}
