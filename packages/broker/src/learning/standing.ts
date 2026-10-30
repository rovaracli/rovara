// v1.2 learning loop: who is a member and who is an outsider (design 2.4, 5.1; owner Q1), and the project scope a capture is written in. Read live, from the server's own records, at
// every capture and again at Accept. Nothing a request says about standing, author or stage is ever used.
//
// Member means: the company member record exists for that person in that company, and either their company role is owner or admin, or the project grant gives them contributor or
// maintainer. Not enough, on their own: a project viewer; no grant; a Slack channel (owner Q1: people who reach a project only through its channel are outsiders); a GitHub link
// (`GITHUB_MEMBER` survives leaving the company); a task role (an owner who took a task over as a viewer, a commenter or with no grant is still an outsider).
//
// A record that cannot be read throws. Callers refuse the capture; they never guess a standing.
import { createHash } from "node:crypto";
import { GetCommand, type TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { OrgRoleSchema, orgMemberKey, orgMetaKey, projectMemberKey, projectMetaKey, type LearningStanding, type OrgId, type OrgRole, type ProjectRole } from "@agentx/contracts";
import { effectiveProjectRole, readProjectMeta } from "../developer/project-roles.js";
import type { LearningScope } from "./store.js";

export interface StandingDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

type Row = Record<string, unknown>;
/** A condition on a record that a write must still find as it was read (a `ConditionCheck` of the caller's transaction). */
export type StandingCheck = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

async function read(deps: StandingDeps, key: { pk: string; sk: string }): Promise<Row | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Row }).Item;
}

/**
 * The person's role in the project right now, or undefined when they have none that counts: no company member record (never joined, or removed: the grant rows a removal leaves behind
 * are ignored), a member record that names another person or company, or a grant that names another person or project. An owner or admin of the company maintains every project.
 */
export async function readProjectRole(deps: StandingDeps, orgId: OrgId, developerId: string, project: string): Promise<ProjectRole | undefined> {
  return (await readRoleFacts(deps, orgId, developerId, project)).role;
}

/** The role, and the records it was read from, as `checks`: conditions a transaction can hold the write to, so a removal or downgrade after the read stops the write. */
async function readRoleFacts(deps: StandingDeps, orgId: OrgId, developerId: string, project: string): Promise<{ role: ProjectRole | undefined; checks: StandingCheck[] }> {
  const none = { role: undefined, checks: [] };
  const member = await read(deps, orgMemberKey(orgId, developerId));
  if (member === undefined || member["orgId"] !== orgId || member["developerId"] !== developerId) return none;
  const role = OrgRoleSchema.safeParse(member["role"]);
  if (!role.success) return none;
  const orgRole: OrgRole = role.data;
  const memberCheck: StandingCheck = {
    ConditionCheck: {
      TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConditionExpression: "attribute_exists(pk) AND #role = :role AND orgId = :org AND developerId = :dev",
      ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": orgRole, ":org": orgId, ":dev": developerId },
    },
  };
  if (orgRole === "owner" || orgRole === "admin") return { role: effectiveProjectRole({ orgRole, developerId }, undefined, false), checks: [memberCheck] };
  const grant = await read(deps, projectMemberKey(orgId, developerId, project));
  if (grant === undefined) return none;
  // A grant row that names someone else or another project is not this person's grant here.
  if ((grant["ownerKey"] !== undefined && grant["ownerKey"] !== developerId) || (grant["projectName"] !== undefined && grant["projectName"] !== project)) return none;
  const granted = effectiveProjectRole({ orgRole, developerId }, grant, false);
  const storedRole = grant["projectRole"];
  const grantCheck: StandingCheck = {
    ConditionCheck: {
      TableName: deps.tableName, Key: projectMemberKey(orgId, developerId, project),
      ConditionExpression: `attribute_exists(pk) AND #role = :grantRole AND ${storedRole === undefined ? "attribute_not_exists(projectRole)" : "projectRole = :projectRole"}`,
      ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":grantRole": grant["role"], ...(storedRole === undefined ? {} : { ":projectRole": storedRole }) },
    },
  };
  return { role: granted, checks: [memberCheck, grantCheck] };
}

/** `readStanding`, with the conditions that keep it true at the write: the person's company record and project grant as they were read. Empty unless the standing is member. */
export async function readStandingChecked(deps: StandingDeps, orgId: OrgId, developerId: string, project: string): Promise<{ standing: LearningStanding; checks: StandingCheck[] }> {
  const { role, checks } = await readRoleFacts(deps, orgId, developerId, project);
  return role === "maintainer" || role === "contributor" ? { standing: "member", checks } : { standing: "outsider", checks: [] };
}

/** Member or outsider, as the module comment says. */
export async function readStanding(deps: StandingDeps, orgId: OrgId, developerId: string, project: string): Promise<LearningStanding> {
  const role = await readProjectRole(deps, orgId, developerId, project);
  return role === "maintainer" || role === "contributor" ? "member" : "outsider";
}

/**
 * True only while the company exists and is neither closing nor closed (the same test the company-owner and invite writes make: `closingAt` and `closedAt` absent on the org record). A company
 * with no record is not open.
 */
export async function companyIsOpen(deps: StandingDeps, orgId: OrgId): Promise<boolean> {
  const org = await read(deps, orgMetaKey(orgId));
  return org !== undefined && org["orgId"] === orgId && org["closingAt"] === undefined && org["closedAt"] === undefined;
}

/**
 * Who may accept a suggestion (design 5.1, L3): a person with standing in the project who has How we work edit rights (`edit_settings`: a maintainer), the same right any publish needs. Being the
 * author of one of its corrections grants nothing; it only means an author is not barred from accepting their own suggestion when they hold the right. THE one rule: Accept authorises with it
 * and the learning view's per-suggestion `canDecide` is computed with it, so the screen and the API cannot disagree.
 */
export function canAcceptSuggestion(who: { standing: LearningStanding; maintainer: boolean }): boolean {
  return who.standing === "member" && who.maintainer;
}

/** The standing of each distinct person, for the re-check at Accept (at most 25 people at once). */
export async function readStandings(deps: StandingDeps, orgId: OrgId, project: string, developerIds: readonly string[]): Promise<Map<string, LearningStanding>> {
  const distinct = [...new Set(developerIds)];
  if (distinct.length > 25) throw new Error("too many people to check at once");
  const entries = await Promise.all(distinct.map(async (id) => [id, await readStanding(deps, orgId, id, project)] as const));
  return new Map(entries);
}

/** `readStandings`, with the conditions that keep each member's standing true at the write (empty for anyone who is not a member). One entry per distinct person. */
export async function readStandingsChecked(deps: StandingDeps, orgId: OrgId, project: string, developerIds: readonly string[]): Promise<Map<string, { standing: LearningStanding; checks: StandingCheck[] }>> {
  const distinct = [...new Set(developerIds)];
  if (distinct.length > 25) throw new Error("too many people to check at once");
  const entries = await Promise.all(distinct.map(async (id) => [id, await readStandingChecked(deps, orgId, id, project)] as const));
  return new Map(entries);
}

/**
 * The scope a capture is written in: the project META's `createdAt` as a canonical instant. Undefined when the project has no META (registered before Plan 2) or is archived: nothing
 * is learned there. Read it at every capture; a project created again under the same name has a new `createdAt` and so a clean partition.
 */
export async function learningScopeOf(deps: StandingDeps, orgId: OrgId, project: string): Promise<LearningScope | undefined> {
  return (await learningScopeChecked(deps, orgId, project))?.scope;
}

/** `learningScopeOf`, with the condition that holds a write to the project as it was read: still active, and still the same instance (the same `createdAt`). */
export async function learningScopeChecked(deps: StandingDeps, orgId: OrgId, project: string): Promise<{ scope: LearningScope; checks: StandingCheck[] } | undefined> {
  const meta = await readProjectMeta(deps, orgId, project);
  if (meta === undefined || meta.status !== "active") return undefined;
  const time = Date.parse(meta.createdAt);
  if (!Number.isFinite(time)) return undefined;
  return {
    scope: { orgId, project, projectCreatedAt: new Date(time).toISOString() },
    checks: [{
      ConditionCheck: {
        TableName: deps.tableName, Key: projectMetaKey(orgId, project), ConditionExpression: "attribute_exists(pk) AND #status = :active AND createdAt = :created",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":active": "active", ":created": meta.createdAt },
      },
    }],
  };
}

/**
 * The project's salt for correction signatures (similarity.ts): one per company, project and project instance, so a signature says nothing about another project's text. It is derived
 * from ids, not a secret: it keeps projects apart, and the stored hashes are not the text. Every writer and reader of signatures (capture, grouping) must use this one.
 */
export function learningSalt(scope: Pick<LearningScope, "orgId" | "project" | "projectCreatedAt">): string {
  return createHash("sha256").update(`rovara-learning-signature\0${scope.orgId}\0${scope.project}\0${scope.projectCreatedAt}`, "utf8").digest("hex");
}
