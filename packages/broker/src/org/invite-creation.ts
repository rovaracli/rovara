// Reviewed creation never stores/replays bearer material. Recovery reads the historical receipt only.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, OrgIdSchema, agentXError, orgScoped, projectMemberKey } from "@rovara-code/contracts";
import { InviteCreateReceiptSchema, ReviewedInviteCreateBodySchema, orgMemberKey, developerOrgKey, orgMetaKey, type InviteProject } from "@agentx/cloud-contracts";
import { grantRoleOf } from "../developer/project-roles.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { takeRateAt } from "../developer/page-comments.js";
import { cloudJoinBase, inviteUrl } from "./invite-url.js";
import { inviteEmailAvailable, sendInviteEmail, takeInviteEmailAllowance } from "./invite-email.js";
const receiptRecord = InviteCreateReceiptSchema.extend({ pk: z.string(), sk: z.string(), entityType: z.literal("ORG_INVITE_CREATE_RECEIPT"), by: z.string().regex(/^[a-f0-9]{64}$/), action: z.literal("org.invite_created"), bodyHash: z.string().regex(/^[a-f0-9]{64}$/) });
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Invite creation could not be confirmed. Check its receipt before trying again.");
const missing = () => agentXError("NOT_FOUND", "That creation receipt is unavailable in this company.");
// UX1: `sendEmail` is not part of the invite's intent (the store hashes the same three fields), and a replay never sends anything.
// A-31: the project is part of the intent only when named, so a company-only invite hashes exactly as before (receipts already stored still match).
export const inviteCreateBodyHash = (body: { role: string; email?: string | undefined; project?: { name: string; role: string } | undefined }) => createHash("sha256").update(JSON.stringify({ action: "org.invite_created", role: body.role, email: body.email?.trim().toLowerCase() ?? null, ...(body.project === undefined ? {} : { project: [body.project.name, body.project.role] }) })).digest("hex");
async function read(deps: DeveloperRouteDependencies, Key: { pk: string; sk: string }) { const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: Record<string, unknown> };return result.Item; }
const forbidden = () => agentXError("FORBIDDEN", "Only a current company owner or admin can create this invite.");
/** The caller's live company role, read from the member row and the developer pointer together (both must agree), or undefined when they are not a current member of an open company. */
async function companyRole(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<unknown> {
 if (!OrgIdSchema.safeParse(caller.orgId).success || !/^[a-f0-9]{64}$/.test(caller.developerId)) throw agentXError("CONFIG_INVALID", "Check a valid company invite.");
 const [actor, pointer, org] = await Promise.all([read(deps, orgMemberKey(caller.orgId, caller.developerId)), read(deps, developerOrgKey(caller.developerId)), read(deps, orgMetaKey(caller.orgId))]);
 return actor?.orgId !== caller.orgId || actor.developerId !== caller.developerId || pointer?.orgId !== caller.orgId || pointer.role !== actor.role || org?.orgId !== caller.orgId || org.closingAt !== undefined || org.closedAt !== undefined ? undefined : actor.role;
}
/** A-31: whether the caller maintains the project by a grant now (an owner or admin is judged by their company role instead). */
const maintainsProject = async (deps: DeveloperRouteDependencies, caller: DeveloperCaller, project: string) => grantRoleOf(await read(deps, projectMemberKey(caller.orgId, caller.developerId, project))) === "maintainer";
/**
 * Who may make this invite: an owner (any role), an admin (a member invite), or, for a member invite that names a project (A-31), a company member who maintains that project.
 * The store checks it all again in the invite's own transaction; this is the route's early, live refusal.
 */
async function authority(deps: DeveloperRouteDependencies, caller: DeveloperCaller, role?: "admin" | "member", project?: InviteProject): Promise<"admin" | "maintainer"> {
 const actorRole = await companyRole(deps, caller);
 if ((actorRole === "owner" || actorRole === "admin") && (role !== "admin" || actorRole === "owner")) return "admin";
 if (project !== undefined && role === "member" && isPlainMember(actorRole) && await maintainsProject(deps, caller, project.name)) return "maintainer";
 throw forbidden();
}
/** A-31: a company member, not an owner or admin, and not the Auditor (who holds no project access). */
const isPlainMember = (role: unknown): boolean => role === "member";
async function receipt(deps: DeveloperRouteDependencies, caller: DeveloperCaller, requestId: string, bodyHash?: string) {
 const raw = await read(deps, { pk: orgScoped(caller.orgId, "INVITE_CREATE_REVIEWED"), sk: requestId });if (raw === undefined) return undefined;
 const parsed = receiptRecord.safeParse(raw);
 if (!parsed.success || parsed.data.orgId !== caller.orgId || parsed.data.requestId !== requestId || raw.pk !== orgScoped(caller.orgId, "INVITE_CREATE_REVIEWED") || raw.sk !== requestId) throw bodyHash === undefined ? missing() : unavailable();
 if (bodyHash !== undefined && (parsed.data.by !== caller.developerId || parsed.data.bodyHash !== bodyHash)) throw agentXError("CONFIG_INVALID", "That request was already used for a different invite intent.");
 if (parsed.data.by !== caller.developerId) throw missing();
 const { orgId, inviteId, role, createdAt, expiresAt, project } = parsed.data;return InviteCreateReceiptSchema.parse({ orgId, requestId, inviteId, role, createdAt, expiresAt, ...(project === undefined ? {} : { project }) });
}
const MAINTAINER_INVITE_NO_EMAIL_MESSAGE = "This install can't send email, so a maintainer's invite can't reach anyone. Ask a company owner or admin to invite them.";
/** Emails an invite's link to its own address, once, within the company's daily cap and one email per address per day (UX1 review I2). Answers how it went. */
async function emailInvite(deps: DeveloperRouteDependencies, caller: DeveloperCaller, to: string, committed: { role: "admin" | "member"; expiresAt: string }, link: string) {
 if (inviteEmailAvailable(deps.ownerNotice) && !await takeInviteEmailAllowance(deps, caller.orgId, to)) return "limited" as const;
 return sendInviteEmail(deps.ownerNotice, { to, orgName: (await deps.orgs?.getOrg(caller.orgId))?.name ?? "your team", inviterName: caller.name, role: committed.role, inviteUrl: link, expiresAt: committed.expiresAt });
}
export async function createReviewedOrganizationInvite(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown) {
 try {
  const parsed = ReviewedInviteCreateBodySchema.safeParse(body);if (!parsed.success) throw agentXError("CONFIG_INVALID", "Review a valid invite role and destination before submitting.");
  const asked = await authority(deps, caller, parsed.data.role, parsed.data.project);
  // A-31 review L2: a maintainer's invite reaches the person only by email, so it is not made where this install cannot send one.
  if (asked === "maintainer" && !inviteEmailAvailable(deps.ownerNotice)) throw agentXError("RUNTIME_UNAVAILABLE", MAINTAINER_INVITE_NO_EMAIL_MESSAGE);
  if (deps.orgs === undefined || deps.audit === undefined || deps.audit.tableName !== deps.tableName) throw unavailable();
  const digest = inviteCreateBodyHash(parsed.data), prior = await receipt(deps, caller, parsed.data.requestId, digest);
  if (prior !== undefined) { if (!await takeRateAt(deps, { pk: orgScoped(caller.orgId, "INVITE_CREATE_RATE"), sk: caller.developerId }, 20, 60_000)) throw agentXError("TOO_MANY_REQUESTS", "Too many invite creation attempts. Try again in a minute.");return { receipt: prior }; }
  try {
   const result = await deps.orgs.createInvite({ requestId: parsed.data.requestId, role: parsed.data.role, ...(parsed.data.email === undefined ? {} : { email: parsed.data.email }), orgId: caller.orgId, createdBy: caller.developerId, reviewed: true, ...(parsed.data.project === undefined ? {} : { project: parsed.data.project }) });
   // Verify the actual atomic record before delivering even the first link.
   const kind = await authority(deps, caller, parsed.data.role, parsed.data.project);const committed = await receipt(deps, caller, parsed.data.requestId, digest);if (committed === undefined) throw unavailable();
   const link = deps.cloud === true ? inviteUrl(cloudJoinBase(deps.developer.issuer), result.token, "fragment") : inviteUrl(`${deps.developer.issuer}/join`, result.token, "query");
   // UX1: emailed only when asked for, only to the invite's own address, and only once (a replay above never reaches here). The link is returned either way, so nothing is lost if the email fails.
   // A-31 review L2: a project maintainer never holds a shareable link. Their invite (always to one named address, the store insists) is emailed whether or not they asked, and the
   // answer carries the email's outcome only, never the link. Owners and admins are as before.
   if (kind === "maintainer") return { receipt: committed, email: parsed.data.email === undefined ? "failed" as const : await emailInvite(deps, caller, parsed.data.email, committed, link) };
   if (parsed.data.sendEmail !== true || parsed.data.email === undefined) return { receipt: committed, inviteUrl: link };
   // UX1 review I2: a daily cap per company and one email per address per day; past either, the link is still returned and nothing is sent.
   if (inviteEmailAvailable(deps.ownerNotice) && !await takeInviteEmailAllowance(deps, caller.orgId, parsed.data.email)) return { receipt: committed, inviteUrl: link, email: "limited" as const };
   const email = await sendInviteEmail(deps.ownerNotice, { to: parsed.data.email, orgName: (await deps.orgs.getOrg(caller.orgId))?.name ?? "your team", inviterName: caller.name, role: committed.role, inviteUrl: link, expiresAt: committed.expiresAt });
   return { receipt: committed, inviteUrl: link, email };
  } catch (error) {
   // A response may be lost after commit. Never mint another invite or replay its bearer.
   await authority(deps, caller, parsed.data.role, parsed.data.project);if (error instanceof AgentXError && error.code === "TOO_MANY_REQUESTS") throw error;const committed = await receipt(deps, caller, parsed.data.requestId, digest);if (committed !== undefined) return { receipt: committed };throw error;
  }
 } catch (error) { if (error instanceof AgentXError) throw error;throw unavailable(); }
}
export async function getInviteCreationReceipt(deps: DeveloperRouteDependencies, caller: DeveloperCaller, requestId: string) {
 if (!z.string().uuid().safeParse(requestId).success) throw agentXError("CONFIG_INVALID", "Check a valid invite request.");
 try {
  // A-31: a maintainer reads back the receipt of a project invite they made (the receipt is only ever the caller's own), while they still maintain that project.
  const actorRole = await companyRole(deps, caller), asMember = isPlainMember(actorRole);
  if (actorRole !== "owner" && actorRole !== "admin" && !asMember) throw forbidden();
  if (!await takeRateAt(deps, { pk: orgScoped(caller.orgId, "INVITE_DIRECTORY_RATE"), sk: caller.developerId }, 20, 60_000)) throw agentXError("TOO_MANY_REQUESTS", "Too many invite checks. Try again in a minute.");
  const value = await receipt(deps, caller, requestId);if (value === undefined) throw missing();
  if (asMember && (value.project === undefined || !await maintainsProject(deps, caller, value.project.name))) throw forbidden();
  return { receipt: value };
 } catch (error) { if (error instanceof AgentXError) throw error;throw unavailable(); }
}
