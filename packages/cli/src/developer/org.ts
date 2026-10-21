// `agentx org members | role | remove | leave` (Plan 2, Task 4): the people in the signed-in developer's organization. Each command is
// one signed-in call to the control plane's /v1/app/org routes; the control plane decides who may do what, and this only names the
// person (by email or ID), asks before leaving, and prints what happened.
import { randomUUID } from "node:crypto";
import { AppMeResponseSchema, DeveloperSignInMethodSchema, OrgRoleSchema, agentXError, type OrgRole } from "@agentx/contracts";
import { z } from "zod";
import { sanitizeServerText } from "../auth.js";
import { developerRequest } from "./commands.js";
import type { DeveloperSessionDeps } from "./session.js";

const MemberSchema = z.object({
  developerId: z.string(),
  name: z.string(),
  email: z.string().optional(),
  role: OrgRoleSchema,
  joinedAt: z.string(),
  identities: z.array(DeveloperSignInMethodSchema),
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
    const methods = member.identities.length === 0 ? "" : `  signs in with ${member.identities.map((method) => METHOD_TEXT[method]).join(", ")}`;
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

export async function orgSetRole(deps: DeveloperSessionDeps, env: string | undefined, who: string, role: OrgRole): Promise<{ env: string; url: string; member: OrgMember; role: OrgRole }> {
  const listed = await orgMembers(deps, env);
  const member = findMember(listed.members, who);
  const { body } = await developerRequest(deps, env, `/v1/app/org/members/${member.developerId}/role`, RoleResponseSchema, { method: "PUT", body: { requestId: randomUUID(), role }, explain: true });
  return { env: listed.env, url: listed.url, member, role: body.role };
}

const ROLE_PHRASE = { owner: "an owner", admin: "an admin", member: "a member" } as const;
export const orgRoleText = (result: { member: OrgMember; role: OrgRole }) => `${sanitizeServerText(result.member.name)} is now ${ROLE_PHRASE[result.role]}.\n`;

export async function orgRemove(deps: DeveloperSessionDeps, env: string | undefined, who: string): Promise<{ env: string; url: string; member: OrgMember; message: string }> {
  const listed = await orgMembers(deps, env);
  const member = findMember(listed.members, who);
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
  const { env: resolved, url, body } = await developerRequest(deps, env, "/v1/app/org/leave", LeaveResponseSchema, { method: "POST", body: { requestId: randomUUID() }, explain: true });
  return { env: resolved, url, orgClosed: body.orgClosed, message: body.message };
}

export const orgLeaveText = (result: { orgClosed: boolean; message: string }) => `${result.orgClosed ? "You left and the organization is closed." : "You left the organization."}\n`;
