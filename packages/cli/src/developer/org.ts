// `agentx org members | role | remove | leave` (Plan 2, Task 4): the people in the signed-in developer's organization. Each command is
// one signed-in call to the control plane's /v1/app/org routes; the control plane decides who may do what, and this only names the
// person (by email or ID), asks before leaving, and prints what happened.
import { randomUUID } from "node:crypto";
import { AppMeResponseSchema, OrgMemberLookupResponseReaderSchema, CommentTriggerOptOutSchema, DeveloperSignInMethodSchema, OrgRoleSchema, agentXError, type CommentTriggerOptOut, type OrgRole } from "@agentx/contracts";
import { z } from "zod";
import { sanitizeServerText } from "../auth.js";
import { neutralised, terminalSafe } from "./audit.js";
import { developerRequest } from "./commands.js";
import type { DeveloperSessionDeps } from "./session.js";

const MemberSchema = z.object({
  developerId: z.string(),
  name: z.string(),
  email: z.string().optional(),
  role: z.enum(["owner", "admin", "member", "auditor", "unknown"]),
  joinedAt: z.string().optional(),
  identities: z.array(DeveloperSignInMethodSchema).optional(),
});
const MembersResponseSchema = z.object({ members: z.array(MemberSchema) });
const RoleResponseSchema = z.object({ developerId: z.string(), role: OrgRoleSchema });
const RemoveResponseSchema = z.object({ removed: z.object({ developerId: z.string(), name: z.string() }), message: z.string() });
const LeaveResponseSchema = z.object({ left: z.literal(true), orgClosed: z.boolean(), message: z.string() });

export type OrgMember = z.infer<typeof MemberSchema>;
export type OrgMembersResult = { env: string; url: string; members: OrgMember[] };

const METHOD_TEXT = { slack: "Slack", oidc: "company sign-in", cloud: "Rovara sign-in", github: "GitHub" } as const;

export async function orgMembers(deps: DeveloperSessionDeps, env: string | undefined): Promise<OrgMembersResult> {
  const { env: resolved, url, body } = await developerRequest(deps, env, "/v1/app/org/members", MembersResponseSchema, { explain: true });
  return { env: resolved, url, members: body.members };
}

export function orgMembersText(result: OrgMembersResult): string {
  const lines = [`Members of your organization on ${result.env} (${result.url}):`];
  for (const member of result.members) {
    const methods = member.identities === undefined || member.identities.length === 0 ? "" : `  signs in with ${member.identities.map((method) => METHOD_TEXT[method]).join(", ")}`;
    lines.push(`  ${sanitizeServerText(member.name)}${member.email === undefined ? "" : ` <${sanitizeServerText(member.email)}>`}  ${member.role}  ${member.developerId}${methods}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The one member an email or developer ID names. An email matches without regard to case; nothing, or two people, is an error that says so. */
export function findMember(members: readonly OrgMember[], who: string): OrgMember {
  const wanted = who.trim().toLowerCase();
  const found = members.filter((member) => member.developerId.toLowerCase() === wanted || member.email?.toLowerCase() === wanted);
  if (found.length === 0) throw agentXError("NOT_FOUND", `no member of your organization has the email or ID ${sanitizeServerText(who)}; run agentx org members to see them`);
  if (found.length > 1) throw agentXError("CONFIG_INVALID", `more than one member matches ${sanitizeServerText(who)}; use the developer ID from agentx org members`);
  return found[0]!;
}

/** Resolve an exact email without requiring a private bulk directory projection. */
export async function resolveOrgMember(deps: DeveloperSessionDeps, env: string | undefined, who: string): Promise<{ env: string; url: string; member: OrgMember }> {
 const listed = await orgMembers(deps, env);
 if (who.includes("@") && listed.members.some(member => member.joinedAt === undefined) && !listed.members.some(member => member.email?.toLowerCase() === who.trim().toLowerCase())) {
  const { body } = await developerRequest(deps, env, "/v1/app/org/members/lookup", OrgMemberLookupResponseReaderSchema, { method: "POST", body: { email: who }, explain: true });
  if (body.match !== null) return { env: listed.env, url: listed.url, member: listed.members.find(member => member.developerId === body.match?.developerId) ?? { developerId: body.match.developerId, name: body.match.name, role: "unknown" } };
 }
 return { env: listed.env, url: listed.url, member: findMember(listed.members, who) };
}

export async function orgSetRole(deps: DeveloperSessionDeps, env: string | undefined, who: string, role: OrgRole): Promise<{ env: string; url: string; member: OrgMember; role: OrgRole }> {
  const listed = await resolveOrgMember(deps, env, who);
  const member = listed.member;
  const { body } = await developerRequest(deps, env, `/v1/app/org/members/${member.developerId}/role`, RoleResponseSchema, { method: "PUT", body: { requestId: randomUUID(), role }, explain: true });
  return { env: listed.env, url: listed.url, member, role: body.role };
}

const ROLE_PHRASE = { owner: "an owner", admin: "an admin", member: "a member", auditor: "an auditor" } as const;
export const orgRoleText = (result: { member: OrgMember; role: OrgRole }) => `${sanitizeServerText(result.member.name)} is now ${ROLE_PHRASE[result.role]}.\n`;

export async function orgRemove(deps: DeveloperSessionDeps, env: string | undefined, who: string): Promise<{ env: string; url: string; member: OrgMember; message: string }> {
  const listed = await resolveOrgMember(deps, env, who);
  const member = listed.member;
  const { body } = await developerRequest(deps, env, `/v1/app/org/members/${member.developerId}`, RemoveResponseSchema, { method: "DELETE", explain: true });
  return { env: listed.env, url: listed.url, member, message: body.message };
}

export const orgRemoveText = (result: { member: OrgMember; message: string }) => `Removed ${sanitizeServerText(result.member.name)} from your organization. ${sanitizeServerText(result.message)}\n`;

/** What `agentx org leave` asks first: who is leaving, and, for the only member, that the organization closes. */
export async function orgLeaveQuestion(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ question: string; closes: boolean }> {
  const [me, listed] = await Promise.all([
    developerRequest(deps, env, "/v1/app/me", AppMeResponseSchema, { explain: true }),
    orgMembers(deps, env),
  ]);
  const name = sanitizeServerText(me.body.org.name);
  const closes = me.body.developer.orgRole === "owner" && listed.members.length === 1;
  return {
    closes,
    question: closes
      ? `You are the only member of ${name}, so leaving closes the organization and releases its GitHub connection. Leave and close ${name}?`
      : `Leave ${name}? Your running tasks will stop after their current step.`,
  };
}

export async function orgLeave(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; url: string; orgClosed: boolean; message: string }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, "/v1/app/org/leave", LeaveResponseSchema, { method: "POST", body: {}, explain: true });
  return { env: resolved, url, orgClosed: body.orgClosed, message: body.message };
}

export const orgLeaveText = (result: { orgClosed: boolean; message: string }) => `${result.orgClosed ? "You left and the organization is closed." : "You left the organization."}\n`;

// Plan 3, Task 14b: `agentx org comment-triggers list`, the repositories an org admin opted out of the rule that every agent comment needs a person
// where workflows act on comments or labels. They are read from the guardrails (`GET /v1/app/org/agent-guardrails`); nothing here sets one.
const GuardrailsOptOutsSchema = z.object({ commentTriggerOptOuts: z.array(CommentTriggerOptOutSchema) });
export type OrgCommentTriggersResult = { env: string; url: string; optOuts: CommentTriggerOptOut[] };

export async function orgCommentTriggers(deps: DeveloperSessionDeps, env: string | undefined): Promise<OrgCommentTriggersResult> {
  // What the server says, a refusal's words included, is text from outside this computer.
  const { env: resolved, url, body } = await neutralised(() => developerRequest(deps, env, "/v1/app/org/agent-guardrails", GuardrailsOptOutsSchema, { explain: true }));
  return { env: resolved, url, optOuts: body.commentTriggerOptOuts };
}

const MAX_FILES_SHOWN = 20;

/** Every value is shown through `terminalSafe`: a name, a reason or a path from a repository can't move the cursor, recolour the terminal or hide behind a bidi mark. */
export function orgCommentTriggersText(result: OrgCommentTriggersResult): string {
  if (result.optOuts.length === 0) return `No repository is opted out of the comment-triggered workflow rule in your organization on ${terminalSafe(result.env)} (${terminalSafe(result.url)}).\n`;
  const lines = [`Repositories opted out of the comment-triggered workflow rule on ${terminalSafe(result.env)} (${terminalSafe(result.url)}):`];
  for (const optOut of result.optOuts) {
    lines.push(`  ${terminalSafe(optOut.project)}  ${terminalSafe(optOut.repository)}  digest ${terminalSafe(optOut.digest.slice(0, 12))}  reviewed by ${terminalSafe(optOut.reviewedBy)} at ${terminalSafe(optOut.reviewedAt)}`);
    lines.push(`    reason: ${terminalSafe(optOut.reason)}`);
    for (const file of optOut.files.slice(0, MAX_FILES_SHOWN)) lines.push(`    ${terminalSafe(file)}`);
    if (optOut.files.length > MAX_FILES_SHOWN) lines.push(`    and ${String(optOut.files.length - MAX_FILES_SHOWN)} more files`);
  }
  return `${lines.join("\n")}\n`;
}
