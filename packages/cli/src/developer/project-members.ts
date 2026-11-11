// `agentx project members | add-member | remove-member` (Plan 2, Task 21): the people in a project and their roles. Each command is one or two
// signed-in calls to the control plane's /v1/app/projects/{name}/members routes; the control plane decides who may do what, and this only
// names the person (by email or ID, from the org's people) and prints what happened.
import { randomUUID } from "node:crypto";
import { ProjectMemberChangeResponseSchema, ProjectMemberRemoveResponseSchema, ProjectMembersResponseSchema, type ProjectMember, type ProjectRole } from "@rovara-code/contracts";
import { sanitizeServerText } from "../auth.js";
import { developerRequest } from "./commands.js";
import { resolveOrgMember, type OrgMember } from "./org.js";
import type { DeveloperSessionDeps } from "./session.js";

const clean = sanitizeServerText;
const membersPath = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/members`;

export async function projectMembers(deps: DeveloperSessionDeps, env: string | undefined, project: string): Promise<{ env: string; url: string; members: ProjectMember[] }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, membersPath(project), ProjectMembersResponseSchema, { explain: true });
  return { env: resolved, url, members: body.members };
}

/** Where a person's role comes from, in the words a person reads: who added them, or that they own or administer the org. */
function sourceText(member: ProjectMember): string {
  if (member.source === "org_role") return "org owner or admin";
  return `added by ${member.grantedBy === undefined ? "an admin" : clean(member.grantedBy.name)}`;
}

export function projectMembersText(result: { env: string; url: string; project: string; members: readonly ProjectMember[] }): string {
  const lines = [`People in ${clean(result.project)} on ${result.env} (${result.url}):`];
  for (const member of result.members) {
    lines.push(`  ${clean(member.name)}${member.email === undefined ? "" : ` <${clean(member.email)}>`}  ${member.role}  (${sourceText(member)})`);
  }
  return `${lines.join("\n")}\n`;
}

export async function projectAddMember(
  deps: DeveloperSessionDeps, env: string | undefined, project: string, who: string, role: ProjectRole,
): Promise<{ env: string; url: string; project: string; member: OrgMember; role: ProjectRole }> {
  const found = await resolveOrgMember(deps, env, who);
  const { body } = await developerRequest(deps, env, `${membersPath(project)}/${found.member.developerId}`, ProjectMemberChangeResponseSchema, {
    method: "PUT", body: { requestId: randomUUID(), role }, explain: true,
  });
  return { ...found, project, role: body.member.role };
}

const ROLE_PHRASE = { maintainer: "a maintainer", contributor: "a contributor", viewer: "a viewer" } as const;
export const projectAddMemberText = (result: { project: string; member: OrgMember; role: ProjectRole }) =>
  `${clean(result.member.name)} is now ${ROLE_PHRASE[result.role]} in ${clean(result.project)}.\n`;

export async function projectRemoveMember(
  deps: DeveloperSessionDeps, env: string | undefined, project: string, who: string,
): Promise<{ env: string; url: string; project: string; member: OrgMember; removed: boolean }> {
  const found = await resolveOrgMember(deps, env, who);
  const { body } = await developerRequest(deps, env, `${membersPath(project)}/${found.member.developerId}`, ProjectMemberRemoveResponseSchema, {
    method: "DELETE", body: { requestId: randomUUID() }, explain: true,
  });
  return { ...found, project, removed: body.removed };
}

export const projectRemoveMemberText = (result: { project: string; member: OrgMember; removed: boolean }) =>
  result.removed ? `Removed ${clean(result.member.name)} from ${clean(result.project)}.\n` : `${clean(result.member.name)} had no role in ${clean(result.project)}; nothing changed.\n`;
