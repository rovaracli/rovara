// Reviewed creation never stores/replays bearer material. Recovery reads the historical receipt only.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, InviteCreateReceiptSchema, ReviewedInviteCreateBodySchema, OrgIdSchema, agentXError, orgMemberKey, developerOrgKey, orgMetaKey, orgScoped } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { takeRateAt } from "../developer/page-comments.js";
import { cloudJoinBase, inviteUrl } from "./invite-url.js";
import { inviteEmailAvailable, sendInviteEmail, takeInviteEmailAllowance } from "./invite-email.js";
const receiptRecord = InviteCreateReceiptSchema.extend({ pk: z.string(), sk: z.string(), entityType: z.literal("ORG_INVITE_CREATE_RECEIPT"), by: z.string().regex(/^[a-f0-9]{64}$/), action: z.literal("org.invite_created"), bodyHash: z.string().regex(/^[a-f0-9]{64}$/) });
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Invite creation could not be confirmed. Check its receipt before trying again.");
const missing = () => agentXError("NOT_FOUND", "That creation receipt is unavailable in this company.");
// UX1: `sendEmail` is not part of the invite's intent (the store hashes the same three fields), and a replay never sends anything.
export const inviteCreateBodyHash = (body: { role: string; email?: string | undefined }) => createHash("sha256").update(JSON.stringify({ action: "org.invite_created", role: body.role, email: body.email?.trim().toLowerCase() ?? null })).digest("hex");
async function read(deps: DeveloperRouteDependencies, Key: { pk: string; sk: string }) { const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: Record<string, unknown> };return result.Item; }
async function authority(deps: DeveloperRouteDependencies, caller: DeveloperCaller, role?: "admin" | "member") {
 if (!OrgIdSchema.safeParse(caller.orgId).success || !/^[a-f0-9]{64}$/.test(caller.developerId)) throw agentXError("CONFIG_INVALID", "Check a valid company invite.");
 const [actor, pointer, org] = await Promise.all([read(deps, orgMemberKey(caller.orgId, caller.developerId)), read(deps, developerOrgKey(caller.developerId)), read(deps, orgMetaKey(caller.orgId))]);
 if (actor?.orgId !== caller.orgId || actor.developerId !== caller.developerId || (actor.role !== "owner" && actor.role !== "admin") || (role === "admin" && actor.role !== "owner") || pointer?.orgId !== caller.orgId || pointer.role !== actor.role || org?.orgId !== caller.orgId || org.closingAt !== undefined || org.closedAt !== undefined) throw agentXError("FORBIDDEN", "Only a current company owner or admin can create this invite.");
}
async function receipt(deps: DeveloperRouteDependencies, caller: DeveloperCaller, requestId: string, bodyHash?: string) {
 const raw = await read(deps, { pk: orgScoped(caller.orgId, "INVITE_CREATE_REVIEWED"), sk: requestId });if (raw === undefined) return undefined;
 const parsed = receiptRecord.safeParse(raw);
 if (!parsed.success || parsed.data.orgId !== caller.orgId || parsed.data.requestId !== requestId || raw.pk !== orgScoped(caller.orgId, "INVITE_CREATE_REVIEWED") || raw.sk !== requestId) throw bodyHash === undefined ? missing() : unavailable();
 if (bodyHash !== undefined && (parsed.data.by !== caller.developerId || parsed.data.bodyHash !== bodyHash)) throw agentXError("CONFIG_INVALID", "That request was already used for a different invite intent.");
 if (parsed.data.by !== caller.developerId) throw missing();
 const { orgId, inviteId, role, createdAt, expiresAt } = parsed.data;return InviteCreateReceiptSchema.parse({ orgId, requestId, inviteId, role, createdAt, expiresAt });
}
export async function createReviewedOrganizationInvite(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown) {
 try {
  const parsed = ReviewedInviteCreateBodySchema.safeParse(body);if (!parsed.success) throw agentXError("CONFIG_INVALID", "Review a valid invite role and destination before submitting.");
  await authority(deps, caller, parsed.data.role);
  if (deps.orgs === undefined || deps.audit === undefined || deps.audit.tableName !== deps.tableName) throw unavailable();
  const digest = inviteCreateBodyHash(parsed.data), prior = await receipt(deps, caller, parsed.data.requestId, digest);
  if (prior !== undefined) { if (!await takeRateAt(deps, { pk: orgScoped(caller.orgId, "INVITE_CREATE_RATE"), sk: caller.developerId }, 20, 60_000)) throw agentXError("TOO_MANY_REQUESTS", "Too many invite creation attempts. Try again in a minute.");return { receipt: prior }; }
  try {
   const result = await deps.orgs.createInvite({ requestId: parsed.data.requestId, role: parsed.data.role, ...(parsed.data.email === undefined ? {} : { email: parsed.data.email }), orgId: caller.orgId, createdBy: caller.developerId, reviewed: true });
   // Verify the actual atomic record before delivering even the first link.
   await authority(deps, caller, parsed.data.role);const committed = await receipt(deps, caller, parsed.data.requestId, digest);if (committed === undefined) throw unavailable();
   const link = deps.cloud === true ? inviteUrl(cloudJoinBase(deps.developer.issuer), result.token, "fragment") : inviteUrl(`${deps.developer.issuer}/join`, result.token, "query");
   // UX1: emailed only when asked for, only to the invite's own address, and only once (a replay above never reaches here). The link is returned either way, so nothing is lost if the email fails.
   if (parsed.data.sendEmail !== true || parsed.data.email === undefined) return { receipt: committed, inviteUrl: link };
   // UX1 review I2: a daily cap per company and one email per address per day; past either, the link is still returned and nothing is sent.
   if (inviteEmailAvailable(deps.ownerNotice) && !await takeInviteEmailAllowance(deps, caller.orgId, parsed.data.email)) return { receipt: committed, inviteUrl: link, email: "limited" as const };
   const email = await sendInviteEmail(deps.ownerNotice, { to: parsed.data.email, orgName: (await deps.orgs.getOrg(caller.orgId))?.name ?? "your team", inviterName: caller.name, role: committed.role, inviteUrl: link, expiresAt: committed.expiresAt });
   return { receipt: committed, inviteUrl: link, email };
  } catch (error) {
   // A response may be lost after commit. Never mint another invite or replay its bearer.
   await authority(deps, caller, parsed.data.role);if (error instanceof AgentXError && error.code === "TOO_MANY_REQUESTS") throw error;const committed = await receipt(deps, caller, parsed.data.requestId, digest);if (committed !== undefined) return { receipt: committed };throw error;
  }
 } catch (error) { if (error instanceof AgentXError) throw error;throw unavailable(); }
}
export async function getInviteCreationReceipt(deps: DeveloperRouteDependencies, caller: DeveloperCaller, requestId: string) {
 if (!z.string().uuid().safeParse(requestId).success) throw agentXError("CONFIG_INVALID", "Check a valid invite request.");
 try {
  await authority(deps, caller);if (!await takeRateAt(deps, { pk: orgScoped(caller.orgId, "INVITE_DIRECTORY_RATE"), sk: caller.developerId }, 20, 60_000)) throw agentXError("TOO_MANY_REQUESTS", "Too many invite checks. Try again in a minute.");
  const value = await receipt(deps, caller, requestId);if (value === undefined) throw missing();return { receipt: value };
 } catch (error) { if (error instanceof AgentXError) throw error;throw unavailable(); }
}
