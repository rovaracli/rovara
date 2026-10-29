// Canonical status for deliberate review/recovery; never infer a terminal state from directory absence.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, AppOrgInviteStatusSchema, OrgInvitePublicIdSchema, OrgIdSchema, agentXError, developerOrgKey, orgInviteDirectoryKey, orgInviteKey, orgMemberKey, orgMetaKey, orgScoped } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { takeRateAt } from "../developer/page-comments.js";
type Deps = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now">;
const hash = z.string().regex(/^[a-f0-9]{64}$/), revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const refSchema = z.object({ pk: z.string(), sk: z.string(), entityType: z.literal("ORG_INVITE_DIRECTORY"), orgId: OrgIdSchema, inviteId: OrgInvitePublicIdSchema, tokenHash: hash });
const inviteSchema = z.object({ entityType: z.literal("ORG_INVITE"), orgId: OrgIdSchema, inviteId: OrgInvitePublicIdSchema, tokenHash: hash, role: z.enum(["admin", "member"]), revision: revision.optional(), expiresAt: z.string().datetime(), acceptedAt: z.string().datetime().optional(), revokedAt: z.string().datetime().optional() });
const missing = () => agentXError("NOT_FOUND", "That invite is unavailable in this company.");
async function read(deps: Deps, Key: { pk: string; sk: string }) { const value = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: Record<string, unknown> };return value.Item; }
export async function getOrganizationInviteStatus(deps: Deps, caller: DeveloperCaller, inviteId: string) {
 if (!OrgInvitePublicIdSchema.safeParse(inviteId).success || !OrgIdSchema.safeParse(caller.orgId).success || !/^[a-f0-9]{64}$/.test(caller.developerId)) throw agentXError("CONFIG_INVALID", "Check a valid company invite.");
 try {
  const [actor, pointer, org] = await Promise.all([read(deps, orgMemberKey(caller.orgId, caller.developerId)), read(deps, developerOrgKey(caller.developerId)), read(deps, orgMetaKey(caller.orgId))]);
  if (actor?.orgId !== caller.orgId || actor.developerId !== caller.developerId || (actor.role !== "owner" && actor.role !== "admin") || pointer?.orgId !== caller.orgId || pointer.role !== actor.role || org?.orgId !== caller.orgId || org.closingAt !== undefined || org.closedAt !== undefined) throw agentXError("FORBIDDEN", "Only current company owners and admins can check invites.");
  if (!await takeRateAt(deps, { pk: orgScoped(caller.orgId, "INVITE_DIRECTORY_RATE"), sk: caller.developerId }, 20, 60_000)) throw agentXError("TOO_MANY_REQUESTS", "Too many invite checks. Try again in a minute.");
  const key = orgInviteDirectoryKey(caller.orgId, inviteId), ref = refSchema.safeParse(await read(deps, key));
  if (!ref.success || ref.data.pk !== key.pk || ref.data.sk !== key.sk || ref.data.orgId !== caller.orgId || ref.data.inviteId !== inviteId) throw missing();
  const parsed = inviteSchema.safeParse(await read(deps, orgInviteKey(ref.data.tokenHash)));
  if (!parsed.success || parsed.data.orgId !== caller.orgId || parsed.data.inviteId !== inviteId || parsed.data.tokenHash !== ref.data.tokenHash || (parsed.data.acceptedAt !== undefined && parsed.data.revokedAt !== undefined)) throw missing();
  const invite = parsed.data, now = deps.now(), status = invite.acceptedAt !== undefined ? "accepted" : invite.revokedAt !== undefined ? "revoked" : Date.parse(invite.expiresAt) <= now ? "expired" : "pending";
  return AppOrgInviteStatusSchema.parse({ orgId: caller.orgId, inviteId, revision: invite.revision ?? 0, role: invite.role, status, expiresAt: invite.expiresAt, checkedAt: new Date(now).toISOString(), ...(status === "revoked" ? { revokedAt: invite.revokedAt } : {}) });
 } catch (error) { if (error instanceof AgentXError) throw error;throw agentXError("RUNTIME_UNAVAILABLE", "The current invite could not be checked. Try again."); }
}
