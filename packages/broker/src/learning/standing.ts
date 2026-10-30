// v1.2 learning loop: who is a member and who is an outsider (design 2.4, 5.1; owner Q1), and the project scope a capture is written in. Read live, from the server's own records, at
// every capture and again at Accept. Nothing a request says about standing, author or stage is ever used.
//
// Member means: the company member record exists for that person in that company, and either their company role is owner or admin, or the project grant gives them contributor or
// maintainer. Not enough, on their own: a project viewer; no grant; a Slack channel (owner Q1: people who reach a project only through its channel are outsiders); a GitHub link
// (`GITHUB_MEMBER` survives leaving the company); a task role (an owner who took a task over as a viewer, a commenter or with no grant is still an outsider).
//
// A record that cannot be read throws. Callers refuse the capture; they never guess a standing.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgRoleSchema, orgMemberKey, projectMemberKey, type LearningStanding, type OrgId, type OrgRole, type ProjectRole } from "@agentx/contracts";
import { effectiveProjectRole, readProjectMeta } from "../developer/project-roles.js";
import type { LearningScope } from "./store.js";

export interface StandingDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

type Row = Record<string, unknown>;

async function read(deps: StandingDeps, key: { pk: string; sk: string }): Promise<Row | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Row }).Item;
}

/**
 * The person's role in the project right now, or undefined when they have none that counts: no company member record (never joined, or removed: the grant rows a removal leaves behind
 * are ignored), a member record that names another person or company, or a grant that names another person or project. An owner or admin of the company maintains every project.
 */
export async function readProjectRole(deps: StandingDeps, orgId: OrgId, developerId: string, project: string): Promise<ProjectRole | undefined> {
  const member = await read(deps, orgMemberKey(orgId, developerId));
  if (member === undefined || member["orgId"] !== orgId || member["developerId"] !== developerId) return undefined;
  const role = OrgRoleSchema.safeParse(member["role"]);
  if (!role.success) return undefined;
  const orgRole: OrgRole = role.data;
  if (orgRole === "owner" || orgRole === "admin") return effectiveProjectRole({ orgRole, developerId }, undefined, false);
  const grant = await read(deps, projectMemberKey(orgId, developerId, project));
  if (grant === undefined) return undefined;
  // A grant row that names someone else or another project is not this person's grant here.
  if ((grant["ownerKey"] !== undefined && grant["ownerKey"] !== developerId) || (grant["projectName"] !== undefined && grant["projectName"] !== project)) return undefined;
  return effectiveProjectRole({ orgRole, developerId }, grant, false);
}

/** Member or outsider, as the module comment says. */
export async function readStanding(deps: StandingDeps, orgId: OrgId, developerId: string, project: string): Promise<LearningStanding> {
  const role = await readProjectRole(deps, orgId, developerId, project);
  return role === "maintainer" || role === "contributor" ? "member" : "outsider";
}

/** The standing of each distinct person, for the re-check at Accept (at most 25 people at once). */
export async function readStandings(deps: StandingDeps, orgId: OrgId, project: string, developerIds: readonly string[]): Promise<Map<string, LearningStanding>> {
  const distinct = [...new Set(developerIds)];
  if (distinct.length > 25) throw new Error("too many people to check at once");
  const entries = await Promise.all(distinct.map(async (id) => [id, await readStanding(deps, orgId, id, project)] as const));
  return new Map(entries);
}

/**
 * The scope a capture is written in: the project META's `createdAt` as a canonical instant. Undefined when the project has no META (registered before Plan 2) or is archived: nothing
 * is learned there. Read it at every capture; a project created again under the same name has a new `createdAt` and so a clean partition.
 */
export async function learningScopeOf(deps: StandingDeps, orgId: OrgId, project: string): Promise<LearningScope | undefined> {
  const meta = await readProjectMeta(deps, orgId, project);
  if (meta === undefined || meta.status !== "active") return undefined;
  const time = Date.parse(meta.createdAt);
  if (!Number.isFinite(time)) return undefined;
  return { orgId, project, projectCreatedAt: new Date(time).toISOString() };
}

/**
 * The project's salt for correction signatures (similarity.ts): one per company, project and project instance, so a signature says nothing about another project's text. It is derived
 * from ids, not a secret: it keeps projects apart, and the stored hashes are not the text. Every writer and reader of signatures (capture, grouping) must use this one.
 */
export function learningSalt(scope: Pick<LearningScope, "orgId" | "project" | "projectCreatedAt">): string {
  return createHash("sha256").update(`rovara-learning-signature\0${scope.orgId}\0${scope.project}\0${scope.projectCreatedAt}`, "utf8").digest("hex");
}
