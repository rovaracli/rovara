// Reviewed revocation: terminal invite state, request receipt and audit commit together.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, OrgIdSchema, RevokeOrganizationInviteBodySchema, RevokeOrganizationInviteResponseSchema, agentXError, developerOrgKey, orgInviteDirectoryKey, orgInviteKey, orgMemberKey, orgMetaKey, orgScoped } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { auditOrgInviteRevoked, auditOccurrence } from "../audit/events.js";
import { auditPending, type TransactItem } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { requestRecordPut } from "./request-records.js";
type Deps = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now" | "audit">;
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.object({ pk: z.string(), sk: z.string(), entityType: z.literal("ORG_INVITE_DIRECTORY"), orgId: OrgIdSchema, inviteId: uuid, tokenHash: hash });
const canonical = z.object({ entityType: z.literal("ORG_INVITE"), orgId: OrgIdSchema, inviteId: uuid, tokenHash: hash, role: z.enum(["admin", "member"]), createdAt: z.string().datetime(), expiresAt: z.string().datetime(), acceptedAt: z.string().datetime().optional(), revokedAt: z.string().datetime().optional(), revision: z.number().int().nonnegative().optional() });
const forbidden = () => agentXError("FORBIDDEN", "Only a current company owner or admin can revoke invites.");
const missing = () => agentXError("NOT_FOUND", "That invite is unavailable in this company.");
const stale = () => agentXError("CHANGE_STALE", "That invite changed or is no longer pending. Refresh before continuing.");
const unavailable = () => agentXError("AUDIT_UNAVAILABLE", "Invite revocation could not be confirmed. Refresh before trying again.");
async function read(deps: Deps, key: { pk: string; sk: string }) {
 const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };return result.Item;
}
export async function revokeOrganizationInvite(deps: Deps, caller: DeveloperCaller, inviteId: string, body: unknown): Promise<{ inviteId: string; revokedAt: string; revision: number }> {
 const parsed = RevokeOrganizationInviteBodySchema.safeParse(body);
 if (!parsed.success || !uuid.safeParse(inviteId).success || !OrgIdSchema.safeParse(caller.orgId).success || !/^[a-f0-9]{64}$/.test(caller.developerId)) throw agentXError("CONFIG_INVALID", "Review a valid company invite before revoking it.");
 try {
  const { orgId, developerId: by } = caller, actorKey = orgMemberKey(orgId, by), pointerKey = developerOrgKey(by), orgKey = orgMetaKey(orgId);
  const [actor, pointer, org] = await Promise.all([read(deps, actorKey), read(deps, pointerKey), read(deps, orgKey)]);
  if (actor?.orgId !== orgId || actor.developerId !== by || (actor.role !== "owner" && actor.role !== "admin") || pointer?.orgId !== orgId || pointer.role !== actor.role || org?.orgId !== orgId || org.closingAt !== undefined || org.closedAt !== undefined) throw forbidden();
  if (deps.audit === undefined || deps.audit.tableName !== deps.tableName) throw unavailable();
  const receiptKey = { pk: orgScoped(orgId, "INVITE_REVOKE"), sk: parsed.data.requestId }, action = "org.invite_revoked";
  const bodyHash = createHash("sha256").update(JSON.stringify([orgId, by, action, inviteId, parsed.data.expectedRevision])).digest("hex");
  async function replay() {
   // Retained receipts still replay even if asynchronous TTL deletion is overdue.
   const receipt = await read(deps, receiptKey);if (receipt === undefined) return undefined;
   if (receipt.by !== by || receipt.action !== action || receipt.bodyHash !== bodyHash) throw agentXError("CONFIG_INVALID", "Use a new request id for a different invite change.");
   const response = RevokeOrganizationInviteResponseSchema.safeParse({ inviteId: receipt.inviteId, revokedAt: receipt.revokedAt, revision: receipt.revision });
   if (!response.success || receipt.orgId !== orgId || response.data.inviteId !== inviteId) throw unavailable();return response.data;
  }
  const previous = await replay();if (previous !== undefined) return previous;
  const refKey = orgInviteDirectoryKey(orgId, inviteId), ref = reference.safeParse(await read(deps, refKey));
  if (!ref.success || ref.data.orgId !== orgId || ref.data.inviteId !== inviteId || ref.data.pk !== refKey.pk || ref.data.sk !== refKey.sk) throw missing();
  const key = orgInviteKey(ref.data.tokenHash), invite = canonical.safeParse(await read(deps, key));
  if (!invite.success || invite.data.orgId !== orgId || invite.data.inviteId !== inviteId || invite.data.tokenHash !== ref.data.tokenHash) throw missing();
  const now = deps.now(), revokedAt = new Date(now).toISOString();
  if ((invite.data.revision ?? 0) !== parsed.data.expectedRevision || invite.data.acceptedAt !== undefined || invite.data.revokedAt !== undefined || Date.parse(invite.data.expiresAt) <= now) throw stale();
  const revision = parsed.data.expectedRevision + 1;
  const result = { inviteId, revokedAt, revision }, labels: string[] = [], items: TransactItem[] = [];
  const add = (label: string, item: TransactItem) => { labels.push(label);items.push(item); };
  add("invite", { Update: { TableName: deps.tableName, Key: key, UpdateExpression: "SET revokedAt = :at, revokedBy = :by, revision = :next", ConditionExpression: "entityType = :type AND orgId = :org AND inviteId = :id AND tokenHash = :hash AND #role = :role AND attribute_not_exists(acceptedAt) AND attribute_not_exists(revokedAt) AND expiresAt = :expiry AND expiresAt > :now AND " + (invite.data.revision === undefined ? "attribute_not_exists(revision)" : "revision = :expected"), ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":type": "ORG_INVITE", ":org": orgId, ":id": inviteId, ":hash": ref.data.tokenHash, ":role": invite.data.role, ":expiry": invite.data.expiresAt, ":now": revokedAt, ":at": revokedAt, ":by": by, ":next": revision, ...(invite.data.revision === undefined ? {} : { ":expected": parsed.data.expectedRevision }) } } });
  add("reference", { ConditionCheck: { TableName: deps.tableName, Key: refKey, ConditionExpression: "entityType = :type AND orgId = :org AND inviteId = :id AND tokenHash = :hash", ExpressionAttributeValues: { ":type": "ORG_INVITE_DIRECTORY", ":org": orgId, ":id": inviteId, ":hash": ref.data.tokenHash } } });
  add("actor", { ConditionCheck: { TableName: deps.tableName, Key: actorKey, ConditionExpression: "orgId = :org AND developerId = :person AND #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":person": by, ":role": actor.role } } });
  add("pointer", { ConditionCheck: { TableName: deps.tableName, Key: pointerKey, ConditionExpression: "orgId = :org AND #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":role": actor.role } } });
  add("org", { ConditionCheck: { TableName: deps.tableName, Key: orgKey, ConditionExpression: "orgId = :org AND attribute_not_exists(closingAt) AND attribute_not_exists(closedAt)", ExpressionAttributeValues: { ":org": orgId } } });
  add("receipt", requestRecordPut(deps.tableName, receiptKey, "ORG_INVITE_REVOKE_REQUEST", { orgId, by, action, bodyHash, ...result }, now));
  const event = auditOrgInviteRevoked({ orgId, actor: { kind: "member", id: by }, occurredAt: revokedAt, occurrence: auditOccurrence("reviewed-invite-revoke", orgId, parsed.data.requestId, inviteId), inviteId, role: invite.data.role });
  const pending = auditPending(deps, event);if (pending.length !== 1) throw unavailable();for (const item of pending) add("audit", item);
  try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
  catch (error) {
   // A lost acknowledgement may hide a committed revocation. Its atomic receipt is authoritative.
   const already = await replay();if (already !== undefined) return already;
   const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
   const failed = labels.filter((_, index) => reasons?.[index]?.Code === "ConditionalCheckFailed");
   if (failed.some(label => ["actor", "pointer", "org"].includes(label))) throw forbidden();
   if (failed.includes("invite") || failed.includes("reference")) throw stale();throw unavailable();
  }
  await flushAuditEvents(deps, [event]);return result;
 } catch (error) { if (error instanceof AgentXError) throw error;throw unavailable(); }
}
