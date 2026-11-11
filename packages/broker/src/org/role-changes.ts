import { approvalCompanyChange } from "./approval-membership.js";
// Reviewed console writes: authority, result receipt and audit commit together.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, agentXError, orgScoped } from "@rovara-code/contracts";
import { OrgMemberRoleChangeBodySchema, OrgRoleSchema, developerOrgKey, orgMemberKey, type OrgRole } from "@agentx/cloud-contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { auditMemberRoleChanged, auditOccurrence } from "../audit/events.js";
import { auditPending, type TransactItem } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { requireAuditorEdition } from "./auditor.js";
type Deps = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "orgs" | "now" | "audit" | "editionPolicy">;
type Change = { requestId: string; role: OrgRole; expectedRole: OrgRole };
async function read(deps: Deps, key: { pk: string; sk: string }) {
 const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };return result.Item;
}
const forbidden = () => agentXError("FORBIDDEN", "Only a current company owner can change roles.");
const stale = () => agentXError("CHANGE_STALE", "Company roles changed. Reload and review the change again.");
const unavailable = () => agentXError("AUDIT_UNAVAILABLE", "The role change could not be confirmed. Reload before trying again.");
export async function changeReviewedMemberRole(deps: Deps, caller: DeveloperCaller, target: string, change: Change): Promise<{ developerId: string; role: OrgRole }> {
 if (!OrgMemberRoleChangeBodySchema.required({ expectedRole: true }).safeParse(change).success || !OrgIdSchema.safeParse(caller.orgId).success || !/^[a-f0-9]{64}$/.test(caller.developerId) || !/^[a-f0-9]{64}$/.test(target)) throw agentXError("CONFIG_INVALID", "Review a valid company role change before submitting.");
 const { orgId, developerId: actor } = caller, actorKey = orgMemberKey(orgId, actor), targetKey = orgMemberKey(orgId, target);
 const liveActor = await read(deps, actorKey);
 if (liveActor?.orgId !== orgId || liveActor.developerId !== actor || liveActor.role !== "owner") throw forbidden();
 // I2: the Auditor is given only where the edition has it. A role that stays the Auditor is no change and needs no check.
 if (change.role === "auditor" && change.expectedRole !== "auditor") requireAuditorEdition(deps.editionPolicy);
 if (deps.audit === undefined || deps.audit.tableName !== deps.tableName) throw unavailable();
 const receiptKey = { pk: orgScoped(orgId, "ROLE_CHANGE"), sk: change.requestId };
 const digest = createHash("sha256").update(JSON.stringify([orgId, actor, target, change.expectedRole, change.role])).digest("hex");
 async function replay() {
  const receipt = await read(deps, receiptKey);if (receipt === undefined) return undefined;
  if (receipt.digest !== digest) throw agentXError("CONFIG_INVALID", "Use a new request id for a different role change.");
  if (receipt.developerId !== target || receipt.role !== change.role) throw unavailable();
  return { developerId: target, role: change.role };
 }
 const previous = await replay();if (previous !== undefined) return previous;
 const member = actor === target ? liveActor : await read(deps, targetKey);
 if (member?.orgId !== orgId || member.developerId !== target) throw agentXError("NOT_FOUND", "That person is not a member of this company.");
 if (!OrgRoleSchema.safeParse(member.role).success || member.role !== change.expectedRole) throw stale();
 const at = new Date(deps.now()).toISOString(), changing = change.role !== change.expectedRole;
 const items: TransactItem[] = [], labels: string[] = [];
 function add(label: string, item: TransactItem) { labels.push(label);items.push(item); }
 function roleFence(who: string, role: OrgRole): TransactItem {
  return { ConditionCheck: { TableName: deps.tableName, Key: orgMemberKey(orgId, who), ConditionExpression: "orgId = :org AND developerId = :person AND #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":person": who, ":role": role } } };
 }
 if (changing) {
  add("target", { Update: { TableName: deps.tableName, Key: targetKey, UpdateExpression: "SET #role = :role, roleUpdatedAt = :at", ConditionExpression: "orgId = :org AND developerId = :person AND #role = :expected", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":person": target, ":role": change.role, ":expected": change.expectedRole, ":at": at } } });
  add("pointer", { Update: { TableName: deps.tableName, Key: developerOrgKey(target), UpdateExpression: "SET #role = :role", ConditionExpression: "orgId = :org", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":role": change.role } } });
 } else add("target", roleFence(target, change.expectedRole));
 // Self-change's target fence already verifies owner; DynamoDB forbids two operations on the same item.
 if (actor !== target) add("actor", roleFence(actor, "owner"));
 if (changing && actor === target && change.expectedRole === "owner" && change.role !== "owner") {
  const owners = await deps.orgs?.listMembers(orgId);
  let otherOwner: string | undefined;
  // A directory query may lag a demotion. Verify candidates consistently and skip stale rows.
  for (const person of owners ?? []) {
   if (person.developerId === actor || person.role !== "owner" || person.orgId !== orgId) continue;
   const candidate = await read(deps, orgMemberKey(orgId, person.developerId));
   if (candidate?.orgId === orgId && candidate.developerId === person.developerId && candidate.role === "owner") { otherOwner = person.developerId;break; }
  }
  if (otherOwner === undefined) throw agentXError("LAST_OWNER", "Add another company owner before changing your own role.");
  add("owner", roleFence(otherOwner, "owner"));
 }
 if (changing) {
  const generation = await approvalCompanyChange({ ...deps, now: () => new Date(deps.now()) }, orgId, (change.expectedRole === "owner" || change.expectedRole === "admin") && (change.role === "member" || change.role === "auditor"));
  for (const item of generation) add("membership_generation", item);
 }
 add("receipt", { Put: { TableName: deps.tableName, Item: { ...receiptKey, digest, developerId: target, role: change.role, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1000) + 30 * 86400 }, ConditionExpression: "attribute_not_exists(pk)" } });
 const event = changing ? auditMemberRoleChanged({ orgId, actor: { kind: "member", id: actor }, memberId: target, fromRole: change.expectedRole, toRole: change.role, occurredAt: at, occurrence: auditOccurrence("reviewed-role", orgId, change.requestId, target, change.role) }) : undefined;
 if (event !== undefined) {
  const pending = auditPending(deps, event);if (pending.length !== 1) throw unavailable();for (const item of pending) add("audit", item);
 }
 try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
 catch (error) {
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  // A timeout may hide a successful commit. Recover its receipt before classifying any write error.
  const already = await replay();if (already !== undefined) return already;
  if (reasons !== undefined) {
   const failed = labels.filter((_, index) => reasons[index]?.Code === "ConditionalCheckFailed");
   if (failed.includes("actor") || (actor === target && failed.includes("target"))) throw forbidden();
   if (failed.includes("owner")) throw agentXError("LAST_OWNER", "Another owner changed. Reload before changing your own role.");
   if (failed.includes("target") || failed.includes("pointer") || failed.includes("membership_generation")) throw stale();
  }
  throw unavailable();
 }
 if (event !== undefined) await flushAuditEvents(deps, [event]);
 return { developerId: target, role: change.role };
}
