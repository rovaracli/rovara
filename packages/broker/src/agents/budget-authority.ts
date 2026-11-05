// Transactional current-org actor fence for the existing user budget write paths.
import { OrgIdSchema, OrgRoleSchema, agentXError, orgMemberKey, developerOrgKey, orgMetaKey, projectMemberKey, type AgentOwner, type OrgId, type OrgRole } from "@agentx/contracts";
import type { TransactItem } from "./table-writes.js";
export interface BudgetIdentity { developerId: string; role: OrgRole }
export interface BudgetActor extends BudgetIdentity { signedIn?: BudgetIdentity }
export const budgetActorRefused = () => agentXError("FORBIDDEN", "Your company access changed. Reload and check your access before changing this budget.");
export function budgetActorChecks(tableName: string, orgId: OrgId, actor: BudgetActor): TransactItem[] {
  if (!OrgIdSchema.safeParse(orgId).success || !/^[a-f0-9]{64}$/.test(actor.developerId) || !OrgRoleSchema.safeParse(actor.role).success) throw budgetActorRefused();
  const roleNames = { "#role": "role" }, roleValues = { ":org": orgId, ":role": actor.role };
  const checks: TransactItem[] = [
    { ConditionCheck: { TableName: tableName, Key: orgMemberKey(orgId, actor.developerId), ConditionExpression: "orgId = :org AND developerId = :person AND #role = :role", ExpressionAttributeNames: roleNames, ExpressionAttributeValues: { ...roleValues, ":person": actor.developerId } } },
    { ConditionCheck: { TableName: tableName, Key: developerOrgKey(actor.developerId), ConditionExpression: "orgId = :org AND #role = :role", ExpressionAttributeNames: roleNames, ExpressionAttributeValues: roleValues } },
    { ConditionCheck: { TableName: tableName, Key: orgMetaKey(orgId), ConditionExpression: "orgId = :org AND attribute_not_exists(closingAt) AND attribute_not_exists(closedAt)", ExpressionAttributeValues: { ":org": orgId } } },
  ];
  // DynamoDB permits one operation per key: share the org-open condition, retain both identities' member and pointer checks.
  if (actor.signedIn !== undefined && actor.signedIn.developerId !== actor.developerId) {
    checks.push(...budgetActorChecks(tableName, orgId, actor.signedIn).slice(0, 2));
  }
  return checks;
}

/** Unarchive restores a monthly share. Validate server identity before reading
 * it; approved decisions receive their actor checks exactly once in withOverride. */
export function unarchiveActorChecks(tableName: string, orgId: OrgId, by: string,
  request: { orgId: OrgId; developerId: string } | undefined,
  options: { actor?: BudgetActor; overrideCap?: { actor?: BudgetActor }; cause?: unknown }): TransactItem[] {
  const actor = options.actor ?? options.overrideCap?.actor;
  if (actor === undefined) {
    if (request !== undefined || by !== "system" || options.cause === undefined) throw budgetActorRefused();
    return [];
  }
  if (actor.developerId !== by || (request !== undefined && (request.orgId !== orgId || request.developerId !== by))
    || (options.overrideCap !== undefined && (options.overrideCap.actor?.developerId !== by || options.overrideCap.actor.role !== actor.role))) throw budgetActorRefused();
  const checks = budgetActorChecks(tableName, orgId, actor);
  return options.overrideCap === undefined ? checks : [];
}

/**
 * Archive takes a share out of its owner's total, so the person archiving must still hold the access the route checked, at the moment it commits (C106).
 * A write that carries a request (the route's) must carry its actor; one with neither must be Rovara's own (`by` is `system`).
 */
export function archiveActorChecks(tableName: string, orgId: OrgId, by: string,
  request: { orgId: OrgId; developerId: string } | undefined,
  options: { actor?: BudgetActor; overrideCap?: { actor?: BudgetActor }; cause?: unknown }): TransactItem[] {
  if ((options.actor ?? options.overrideCap?.actor) === undefined && request === undefined) {
    // Rovara's own call, which the caller vouches for; any other name needs the actor fence.
    if (by !== "system") throw budgetActorRefused();
    return [];
  }
  return unarchiveActorChecks(tableName, orgId, by, request, options);
}

/**
 * The grant that gave a person who is not an org owner or admin their manage access to a project's agent or chain (S1-M2). The org-role checks above pin
 * who the person is in the company; a project maintainer's access to the project's things is the grant row, so a write that rests on it pins that row as well,
 * in the same transaction. A grant revoked or lowered between the route's check and the commit then fails the write whole (FORBIDDEN, like the other
 * actor losses). An org owner or admin holds every project with no grant, and a member's own agent or chain rests on the org role alone, so neither adds a check.
 * A person whose grant does not read as a maintainer's is refused here too: the route would not have let them in.
 * Only the direct write carries this; an approved request brings the deciding actor's checks (withOverride).
 */
export async function actorGrantChecks(
  read: (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined>,
  tableName: string, orgId: OrgId, actor: BudgetActor, subject: { owner?: AgentOwner },
): Promise<TransactItem[]> {
  if (actor.role === "owner" || actor.role === "admin" || subject.owner === undefined || subject.owner.kind !== "project") return [];
  if (actor.role !== "member") throw budgetActorRefused();
  const key = projectMemberKey(orgId, actor.developerId, subject.owner.project), grant = await read(key);
  if (grant?.["role"] !== "developer" || grant["projectRole"] !== "maintainer") throw budgetActorRefused();
  return [{ ConditionCheck: { TableName: tableName, Key: key, ConditionExpression: "#grantRole = :grantRole AND #projectRole = :projectRole",
    ExpressionAttributeNames: { "#grantRole": "role", "#projectRole": "projectRole" }, ExpressionAttributeValues: { ":grantRole": "developer", ":projectRole": "maintainer" } } }];
}

/** What a person named as an owner or accountable maintainer must still be when the write commits. */
export type DestinationNeed = "member" | "admin" | { maintainerOf: string };

export const destinationRefused = () => agentXError("CONFIG_INVALID", "That person's access to your company changed just now. Reload and pick again.");

/** Which of `checks` failed, read from the indexes a cancelled transaction reports: `start` is where the actor checks begin. */
export function fenceRefusal(failed: Set<number>, start: number, actorChecks: TransactItem[], destination: TransactItem[]): Error | undefined {
  if ([...failed].some(index => index >= start && index < start + actorChecks.length)) return budgetActorRefused();
  const destinationStart = start + actorChecks.length;
  if ([...failed].some(index => index >= destinationStart && index < destinationStart + destination.length)) return destinationRefused();
  return undefined;
}

/**
 * The conditions that keep each person a write names (a new owner, a new accountable maintainer) a member of this org, in the role they were read in, and a
 * maintainer of the project where that is needed, in the same transaction as the write (C99). The route checked them earlier; this closes the gap before the
 * commit. Checks on an item the actor's own checks already cover are left out, since a transaction may name an item once. A person who is not eligible now is refused here.
 */
export async function destinationChecks(
  read: (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined>,
  tableName: string, orgId: OrgId, destinations: ReadonlyArray<{ developerId: string; need: DestinationNeed }>, taken: TransactItem[], actor?: BudgetActor,
): Promise<TransactItem[]> {
  const keyOf = (item: TransactItem) => item.ConditionCheck === undefined ? "" : `${String(item.ConditionCheck.Key?.["pk"])}|${String(item.ConditionCheck.Key?.["sk"])}`;
  const used = new Set(taken.map(keyOf));
  const found: TransactItem[] = [];
  const add = (item: TransactItem) => { if (!used.has(keyOf(item))) { used.add(keyOf(item)); found.push(item); } };
  for (const { developerId, need } of destinations) {
    // The actor naming themselves is held by the actor's own checks (their refusal is the actor's), so their role is not read again here.
    const parsed = OrgRoleSchema.safeParse(actor !== undefined && actor.developerId === developerId ? actor.role : (await read(orgMemberKey(orgId, developerId)))?.["role"]);
    if (!parsed.success || !/^[a-f0-9]{64}$/.test(developerId)) throw destinationRefused();
    const role = parsed.data, admin = role === "owner" || role === "admin";
    if (need === "admin" && !admin) throw destinationRefused();
    for (const check of budgetActorChecks(tableName, orgId, { developerId, role }).slice(0, 2)) add(check);
    if (typeof need === "object" && !admin) {
      const key = projectMemberKey(orgId, developerId, need.maintainerOf), grant = await read(key);
      if (grant?.["role"] !== "developer" || grant["projectRole"] !== "maintainer") throw destinationRefused();
      add({ ConditionCheck: { TableName: tableName, Key: key, ConditionExpression: "#grantRole = :grantRole AND #projectRole = :projectRole",
        ExpressionAttributeNames: { "#grantRole": "role", "#projectRole": "projectRole" }, ExpressionAttributeValues: { ":grantRole": "developer", ":projectRole": "maintainer" } } });
    }
  }
  return found;
}
