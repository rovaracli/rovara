// Member removal (v1.1), task 5: the route logic. Who may remove whom is unchanged (an owner removes anyone, an admin members only, nobody removes themselves); what is new is the
// preview, the receipt per request id, the chosen successor and the status. The functions take what developer-routes owns (the person's emails, the legacy session end) as arguments.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  MemberRemovalBodySchema, MemberRemovalPreviewSchema, MemberRemovalStatusSchema, OrgRoleSchema, REMOVAL_CHANGE_STALE_MESSAGE, SUCCESSOR_INVALID_MESSAGE, agentXError, memberRemovalRecordKey,
  type MemberRemovalRecord, type OrgRole,
} from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../../aws/developer-routes.js";
import { DeveloperSignInStore } from "../../developer/store.js";
import { nameResolverOf, replacementNamesFrom, shownNameOf } from "../../developer/name-resolver.js";
import { listOrganizationInvites } from "../invite-directory.js";
import { COUNT_CAP, countHandOffs, hasGithubLink, readDuties, removalEnds } from "./preview.js";

type Deps = DeveloperRouteDependencies;
const HEX64 = /^[a-f0-9]{64}$/;
const REMOVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RemovalHelpers {
  /** Every address that may hold the person's `ORG_EMAIL#` pointer. */
  emailsOf(developerId: string): Promise<string[]>;
  /** What the route does after the removal when no movers are wired (it ends the person's sessions itself). */
  afterRemoval(developerId: string, removedAt: string): Promise<void>;
  /** The sentence about running tasks, by name. */
  stops(name: string): string;
}

/** The rules that were already there: an owner or admin, never yourself, an admin removes members only. `target` is read only when there is one to read. */
function requireMayRemove(caller: DeveloperCaller, developerId: string): void {
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can remove people from the organization");
  if (developerId === caller.developerId) throw agentXError("FORBIDDEN", "use agentx org leave to leave");
}
function requireMayRemoveRole(caller: DeveloperCaller, role: OrgRole): void {
  if (caller.orgRole === "admin" && role !== "member") throw agentXError("FORBIDDEN", "an admin can remove members only; ask an owner to remove an owner or admin");
}

/** The people the route names (the one removed, the one who takes over), read without loading the whole directory: one member query and one batch of names. */
async function peopleOf(deps: Deps, caller: DeveloperCaller, ids: readonly string[]): Promise<Map<string, { name: string; role: OrgRole | undefined }>> {
  const members = await deps.orgs!.listMembers(caller.orgId);
  const found = members.filter((member) => ids.includes(member.developerId));
  const store = new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, nameTableName: deps.tableName, now: deps.now });
  const foundIds = found.map((member) => member.developerId);
  const { records, nameItems } = await store.getDevelopersWithNameItems(foundIds);
  const replaced = (await replacementNamesFrom(nameResolverOf(deps, caller.orgId), foundIds, nameItems)).currentOnly();
  return new Map(found.map((member) => {
    const role = OrgRoleSchema.safeParse(member.role);
    return [member.developerId, { name: replaced.get(member.developerId) ?? records.get(member.developerId)?.displayName ?? "Unknown", role: role.success ? role.data : undefined }];
  }));
}

/** An admin may remove members only, and a role that cannot be read counts as owner (fail closed). */
const roleForRule = (role: OrgRole | undefined): OrgRole => role ?? "owner";

/** The open invites the person created, from the first page of the invite list; `atLeast` when the list has more pages. */
async function invitesCreatedBy(deps: Deps, caller: DeveloperCaller, developerId: string): Promise<{ count: number; atLeast: boolean } | undefined> {
  try {
    const invites = await listOrganizationInvites(deps, caller, new URL("https://rovara.invalid/v1/app/org/invites?limit=50"));
    return { count: invites.invites.filter((invite) => invite.createdBy === developerId).length, atLeast: invites.nextCursor !== undefined };
  } catch { return undefined; }
}

/** `GET /v1/app/org/members/{id}/removal-preview?successorId=`. */
export async function previewMemberRemoval(deps: Deps, caller: DeveloperCaller, developerId: string, url: URL) {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  requireMayRemove(caller, developerId);
  const asked = url.searchParams.get("successorId");
  if (asked !== null && !HEX64.test(asked)) throw agentXError("CONFIG_INVALID", "successorId: invalid");
  const successorId = asked ?? caller.developerId;
  const people = await peopleOf(deps, caller, [developerId, successorId]);
  const target = people.get(developerId);
  if (target === undefined) throw agentXError("NOT_FOUND", "that person is not a member of the organization");
  requireMayRemoveRole(caller, roleForRule(target.role));
  if (target.role === undefined) throw agentXError("CHANGE_STALE", REMOVAL_CHANGE_STALE_MESSAGE);
  const successor = people.get(successorId);
  if (successorId === developerId || successor === undefined) throw agentXError("SUCCESSOR_INVALID", SUCCESSOR_INVALID_MESSAGE);
  const previewDeps = { documentClient: deps.documentClient, tableName: deps.tableName };
  const handOffs = await countHandOffs({ ...previewDeps, agents: deps.agents }, caller.orgId, developerId);
  const duties = await readDuties(previewDeps, caller.orgId, developerId);
  const warnings = [...handOffs.warnings];
  const invites = await invitesCreatedBy(deps, caller, developerId);
  if (invites === undefined) warnings.push("Their open invites could not be read.");
  const { moves } = handOffs;
  const capped = [moves.agents, moves.skills, moves.chains, moves.triggers, moves.approvals, moves.spendRequests, duties.projectGrants, duties.maintainerProjects].some((count) => count >= COUNT_CAP);
  if (capped) warnings.push(`Counts of ${String(COUNT_CAP)} mean ${String(COUNT_CAP)} or more.`);
  return MemberRemovalPreviewSchema.parse({
    member: { developerId, name: target.name, role: target.role }, successor: { developerId: successorId, name: successor.name },
    moves, ends: removalEnds(await hasGithubLink(previewDeps, caller.orgId, developerId)),
    duties: { wasRole: target.role, ...duties, invitesCreated: invites?.count ?? 0, ...(invites?.atLeast === true ? { invitesCreatedAtLeast: true } : {}) }, warnings,
  });
}

/** `POST /v1/app/org/members/{id}/removal`. */
export async function startMemberRemovalRoute(deps: Deps, caller: DeveloperCaller, developerId: string, rawBody: unknown, helpers: RemovalHelpers, cloud: boolean) {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  requireMayRemove(caller, developerId);
  const parsed = MemberRemovalBodySchema.safeParse(rawBody);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const body = parsed.data;
  const people = await peopleOf(deps, caller, [developerId]);
  const target = people.get(developerId);
  // A person already removed by this very request is the receipt's to answer (the store reads it first); anyone else who is not a member is NOT_FOUND there too.
  if (target !== undefined) requireMayRemoveRole(caller, roleForRule(target.role));
  const emails = target === undefined ? [] : await helpers.emailsOf(developerId);
  const store = new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, nameTableName: deps.tableName, now: deps.now });
  const name = target?.name ?? (await store.getDeveloper(developerId))?.displayName ?? "That person";
  const started = await deps.orgs.removeMember({
    orgId: caller.orgId, developerId, emails, ban: !cloud, expectedRole: body.expectedRole, by: { kind: "member", id: caller.developerId }, callerRole: caller.orgRole,
    ...(body.successorId === undefined ? {} : { successorId: body.successorId }), requestId: body.requestId,
  });
  if (!started.replay && deps.agents === undefined) await helpers.afterRemoval(developerId, started.removedAt);
  return { removalId: started.removalId, state: started.state, message: helpers.stops(name) };
}

/** `GET /v1/app/org/removals/{removalId}`. */
export async function getMemberRemoval(deps: Deps, caller: DeveloperCaller, removalId: string) {
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can see a removal");
  if (!REMOVAL_ID.test(removalId)) throw agentXError("NOT_FOUND", "removal not found");
  const record = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: memberRemovalRecordKey(caller.orgId, removalId), ConsistentRead: true }))) as { Item?: MemberRemovalRecord }).Item;
  if (record === undefined || record.orgId !== caller.orgId) throw agentXError("NOT_FOUND", "removal not found");
  const store = new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, nameTableName: deps.tableName, now: deps.now });
  const ids = [record.leaverId, ...(record.successorId === undefined ? [] : [record.successorId])];
  const { records: people, nameItems } = await store.getDevelopersWithNameItems(ids);
  // ERASE-NAME-2: a person erased (also before the name item had a tombstone) is not shown by the name stored for them.
  // A stored removal is history: a leaver or successor who was erased and came back reads by the new name only if this removal happened in the new membership, else "A former member".
  const replaced = await replacementNamesFrom(nameResolverOf(deps, caller.orgId), ids, nameItems);
  const invites = await invitesCreatedBy(deps, caller, record.leaverId);
  const nameOf = (id: string) => shownNameOf(people.get(id)?.displayName ?? "Unknown", id, replaced, record.removedAt);
  return MemberRemovalStatusSchema.parse({
    removalId, state: record.state, removedAt: record.removedAt, member: { developerId: record.leaverId, name: nameOf(record.leaverId), role: record.role },
    ...(record.successorId === undefined ? {} : { successor: { developerId: record.successorId, name: nameOf(record.successorId) } }), by: record.by,
    duties: { wasRole: record.role, projectGrants: Math.min(record.grants.length, COUNT_CAP), maintainerProjects: Math.min(record.grants.filter((grant) => grant.projectRole === "maintainer").length, COUNT_CAP), invitesCreated: invites?.count ?? 0, ...(invites?.atLeast === true ? { invitesCreatedAtLeast: true } : {}) },
  });
}
