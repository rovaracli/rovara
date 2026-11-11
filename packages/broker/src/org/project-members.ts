// Plan 2, Task 21: people in a project. A person's role in a project is `maintainer`, `contributor` or `viewer`. It comes from a grant on the
// project (an item in the person's own grant partition, one per project), or from their org role (an owner or admin maintains every project
// in their org, with no grant), or, as a contributor, from the project's Slack channel. This module reads all three (`ProjectMembers`, which
// the agents platform imports) and writes the grants (`setProjectMember`, `removeProjectMember`).
//
// The grant item keeps `entityType`, `ownerKey` and `grantId` exactly as before, because the E2E direct-membership proof checks them. A
// maintainer or contributor keeps `role: "developer"`, so the access code that reads `role` is unchanged; a viewer's `role` is `viewer`, so
// that code does not count a viewer as a developer (a viewer starts no work, and is no task participant). The role itself is `projectRole`.
//
// Everything here is keyed by the `orgId` it is given: no key is built from a name alone, so another org's project of the same name, and its
// people, are never reached.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { INDEX_EXPIRY_ATTRIBUTE, MEMBER_GRANT_SK_PREFIX, PROJECT_REVISION_SK_PREFIX, agentXError, memberGrantsPk, orgPk, orgProjectCatalogPk, projectMemberKey, projectMetaKey, projectPk, type OrgId, type OrgKey, type ProjectRole } from "@rovara-code/contracts";
import { OrgRoleSchema, orgMemberKey, type AuditEventInput, type OrgRole } from "@agentx/cloud-contracts";
import { auditOccurrence, auditProjectMemberChanged, auditProjectMemberRemoved } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvent, type AuditRuntime } from "../audit/outbox.js";
import { approvalGrantChange } from "./approval-membership.js";
import { effectiveProjectRole, grantRoleOf, grantedByOf, type GrantedBy } from "../developer/project-roles.js";

/** A person in a project, as Plan 3 reads one: `grant` for a person holding a grant, `org_role` for an org owner or admin. */
export interface ProjectMembers {
  roleOf(orgId: OrgId, project: string, caller: { developerId: string; orgRole: OrgRole }): Promise<ProjectRole | undefined>;
  list(orgId: OrgId, project: string): Promise<Array<{ developerId: string; role: ProjectRole; source: "grant" | "org_role" }>>;
  projectsOf(orgId: OrgId, caller: { developerId: string; orgRole: OrgRole }): Promise<Array<{ project: string; role: ProjectRole }>>;
}

export interface ProjectMembersDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** A developer's sign-in record, for `mergedInto` (a developer merged into another reads as that other). Without it, no id is followed. */
  developerRecord?: (developerId: string) => Promise<{ mergedInto?: string } | undefined>;
  /** Whether the project's Slack channel gives this person access to it. Without it, channels give nobody access. */
  channelAccess?: (orgId: OrgId, project: string, developerId: string) => Promise<boolean>;
  /** The projects this person reaches through Slack channels. Without it, channels give nobody access. */
  channelProjects?: (orgId: OrgId, developerId: string) => Promise<string[]>;
}

type Item = Record<string, unknown>;
type Send = ProjectMembersDependencies["documentClient"];

const READS_AT_ONCE = 8;
const MAX_MERGE_HOPS = 5;

async function getItem(deps: { documentClient: Send; tableName: string }, key: OrgKey): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

async function queryAll(deps: { documentClient: Send; tableName: string }, pk: string, prefix: string): Promise<Item[]> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  return items;
}

/** `fn` over every item, at most READS_AT_ONCE at a time, results in the items' order. */
async function mapLimit<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, items.length) }, worker));
  return results;
}

/** Whether the project has a registered revision in this org. A catalog entry or a grant alone does not make a project. */
async function projectExists(deps: { documentClient: Send; tableName: string }, orgId: OrgId, project: string): Promise<boolean> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": PROJECT_REVISION_SK_PREFIX },
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: unknown[] };
  return (response.Items?.length ?? 0) > 0;
}

async function isArchived(deps: { documentClient: Send; tableName: string }, orgId: OrgId, project: string): Promise<boolean> {
  return (await getItem(deps, projectMetaKey(orgId, project)))?.status === "archived";
}

/** An org's members and their org roles. */
async function orgMembers(deps: { documentClient: Send; tableName: string }, orgId: OrgId): Promise<Array<{ developerId: string; role: OrgRole }>> {
  const members: Array<{ developerId: string; role: OrgRole }> = [];
  for (const item of await queryAll(deps, orgPk(orgId), "MEMBER#")) {
    const role = OrgRoleSchema.safeParse(item.role);
    if (typeof item.developerId === "string" && role.success) members.push({ developerId: item.developerId, role: role.data });
  }
  return members;
}

/** A person's grant on a project in an org, as stored (any `role`; the operator's `administrator` rows included). */
const readGrant = (deps: { documentClient: Send; tableName: string }, orgId: OrgId, developerId: string, project: string) => getItem(deps, projectMemberKey(orgId, developerId, project));

/**
 * The developer a (possibly merged-away) developer id stands for: the end of its `mergedInto` chain, or the id itself. A cycle or a chain
 * longer than MAX_MERGE_HOPS stops where it is.
 */
export async function survivorOf(deps: Pick<ProjectMembersDependencies, "developerRecord">, developerId: string): Promise<string> {
  let current = developerId;
  const seen = new Set<string>([current]);
  for (let hop = 0; hop < MAX_MERGE_HOPS && deps.developerRecord !== undefined; hop += 1) {
    const next = (await deps.developerRecord(current))?.mergedInto;
    if (typeof next !== "string" || next === "" || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

/** The ids whose grants count for a person: the survivor of their merge chain first, then their own id. */
async function idsFor(deps: Pick<ProjectMembersDependencies, "developerRecord">, developerId: string): Promise<string[]> {
  const survivor = await survivorOf(deps, developerId);
  return survivor === developerId ? [developerId] : [survivor, developerId];
}

/** One person in a project with what the route shows beyond `ProjectMembers.list`: who granted it. */
export interface ProjectMemberRow { developerId: string; role: ProjectRole; source: "grant" | "org_role"; grantedBy?: GrantedBy }

/**
 * Everyone with a role in the project: each org owner and admin (`org_role`, maintainer, once, whatever grants they also hold) and each
 * other member of the org who holds a grant (`grant`). A project with no registered revision in the org has no one. Another org's people and
 * grants are never read: the people are this org's members, and each grant is read in this org's partition.
 */
export async function listProjectMembers(deps: ProjectMembersDependencies, orgId: OrgId, project: string): Promise<ProjectMemberRow[]> {
  if (!await projectExists(deps, orgId, project)) return [];
  const rows = await mapLimit(await orgMembers(deps, orgId), async (member): Promise<ProjectMemberRow | undefined> => {
    if (member.role === "owner" || member.role === "admin") return { developerId: member.developerId, role: "maintainer", source: "org_role" };
    // Only a member holds a project role by grant. An Auditor (or a role this release does not know) is not listed whatever grant it was left with (I2).
    if (member.role !== "member") return undefined;
    const grant = await readGrant(deps, orgId, member.developerId, project);
    const role = grantRoleOf(grant);
    return role === undefined ? undefined : { developerId: member.developerId, role, source: "grant", grantedBy: grantedByOf(grant) };
  });
  return rows.filter((row): row is ProjectMemberRow => row !== undefined);
}

/** What Plan 3 (and the routes) read people through. See the interface. */
export function createProjectMembers(deps: ProjectMembersDependencies): ProjectMembers {
  return {
    async roleOf(orgId, project, caller) {
      if (!await projectExists(deps, orgId, project)) return undefined;
      if (caller.orgRole === "owner" || caller.orgRole === "admin") return effectiveProjectRole(caller, undefined, false);
      let grant: Item | undefined;
      for (const id of await idsFor(deps, caller.developerId)) {
        const found = await readGrant(deps, orgId, id, project);
        if (grantRoleOf(found) !== undefined) { grant = found; break; }
      }
      // An explicit grant is the role, even for a person who is also in the channel; the channel is asked only when there is no grant.
      const channel = grant === undefined && deps.channelAccess !== undefined && await deps.channelAccess(orgId, project, caller.developerId);
      return effectiveProjectRole(caller, grant, channel);
    },

    async list(orgId, project) {
      return (await listProjectMembers(deps, orgId, project)).map(({ developerId, role, source }) => ({ developerId, role, source }));
    },

    async projectsOf(orgId, caller) {
      const roles = new Map<string, ProjectRole>();
      if (caller.orgRole === "auditor") return [];
      if (caller.orgRole === "owner" || caller.orgRole === "admin") {
        for (const entry of await queryAll(deps, orgProjectCatalogPk(orgId), "PROJECT#")) {
          if (typeof entry.name === "string") roles.set(entry.name, "maintainer");
        }
      } else {
        for (const id of [...await idsFor(deps, caller.developerId)].reverse()) {
          for (const grant of await queryAll(deps, memberGrantsPk(orgId, id), MEMBER_GRANT_SK_PREFIX)) {
            const role = grantRoleOf(grant);
            if (role !== undefined && typeof grant.projectName === "string") roles.set(grant.projectName, role);
          }
        }
        for (const project of await deps.channelProjects?.(orgId, caller.developerId) ?? []) {
          if (!roles.has(project)) roles.set(project, effectiveProjectRole(caller, undefined, true)!);
        }
      }
      // Only projects that exist in this org and are not archived: a grant can outlive its project's revision, and an archived project takes no new work.
      const checked = await mapLimit([...roles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), async ([project, role]) =>
        await projectExists(deps, orgId, project) && !await isArchived(deps, orgId, project) ? { project, role } : undefined);
      return checked.filter((entry): entry is { project: string; role: ProjectRole } => entry !== undefined);
    },
  };
}

// ---- writing grants -------------------------------------------------------------------------------------------------------------------

const OPERATOR_ROW_MESSAGE = (project: string) => `that person administers \`${project}\` for the operator, so they cannot be given a project role here`;

/** The item for a new grant. Its shape is the one this task fixes: the E2E proof needs `entityType`, `ownerKey` and a UUID `grantId`. */
function newGrantItem(orgId: OrgId, project: string, developerId: string, role: ProjectRole, grantedBy: GrantedBy, at: string): Item {
  return {
    ...projectMemberKey(orgId, developerId, project), entityType: "MEMBERSHIP", ownerKey: developerId, grantId: randomUUID(), projectName: project,
    role: role === "viewer" ? "viewer" : "developer", projectRole: role, grantedBy, grantedAt: at,
  };
}

/** The logical project role and immutable grant identity must still be the
 * ones used to classify eligibility loss, not just the coarse storage role. */
function grantSnapshot(existing: Item): { condition: string; values: Item } {
  return {
    condition: ["projectRole", "grantId"].map(field => existing[field] === undefined ? `attribute_not_exists(${field})` : `${field} = :seen_${field}`).join(" AND "),
    values: Object.fromEntries(["projectRole", "grantId"].flatMap(field => existing[field] === undefined ? [] : [[`:seen_${field}`, existing[field]]])),
  };
}

/**
 * The write that gives `developerId` the role in the project, as a transaction item. A new person gets a new grant; a person who has one
 * keeps its `grantId`, who added them and when, and gets the new role (an old row that lacks `entityType`, `ownerKey` or `grantId` gains
 * them), conditioned on the role that was read. The operator's `administrator` row is never overwritten: the key is shared, so a grant would
 * replace it.
 */
async function grantWrite(deps: ProjectMembersDependencies, input: { orgId: OrgId; project: string; developerId: string; role: ProjectRole; grantedBy: GrantedBy; now: () => Date }): Promise<{ write: Item; fromRole: ProjectRole | undefined }> {
  const { orgId, project, developerId, role } = input;
  const existing = await readGrant(deps, orgId, developerId, project);
  if (existing !== undefined && existing.role !== "developer" && existing.role !== "viewer") throw agentXError("CONFIG_INVALID", OPERATOR_ROW_MESSAGE(project));
  if (existing === undefined) {
    return { fromRole: undefined, write: { Put: { TableName: deps.tableName, Item: newGrantItem(orgId, project, developerId, role, input.grantedBy, input.now().toISOString()), ConditionExpression: "attribute_not_exists(pk)" } } };
  }
  return { fromRole: grantRoleOf(existing), write: { Update: {
    TableName: deps.tableName, Key: projectMemberKey(orgId, developerId, project),
    UpdateExpression: "SET #role = :role, projectRole = :projectRole, entityType = if_not_exists(entityType, :entity), ownerKey = if_not_exists(ownerKey, :owner), projectName = if_not_exists(projectName, :project), grantId = if_not_exists(grantId, :grantId)",
    // Only the row that was read: an operator's row that appeared in between is not overwritten.
    ConditionExpression: "attribute_exists(pk) AND #role = :seen AND " + grantSnapshot(existing).condition,
    ExpressionAttributeNames: { "#role": "role" },
    ExpressionAttributeValues: {
      ":role": role === "viewer" ? "viewer" : "developer", ":projectRole": role, ":entity": "MEMBERSHIP", ":owner": developerId, ":project": project, ":grantId": randomUUID(), ":seen": existing.role, ...grantSnapshot(existing).values,
    },
  } } };
}

/**
 * The check that the person is still a member of the org when the grant commits (final review M7). `resolveTarget` read the member row a moment
 * earlier; a removal in between would otherwise leave a grant for someone outside the org, which comes back to life if they are invited again.
 * When it fails the transaction is cancelled and the next attempt reads again, so the answer is the usual "that person isn't in your organization".
 */
function stillMember(deps: ProjectMembersDependencies, orgId: OrgId, developerId: string): Item {
  return { ConditionCheck: { TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConditionExpression: "attribute_exists(pk)" } };
}

/** The write that removes a developer's grant and the role it gave, or undefined when there is none to remove (the operator's `administrator` row is not a project role and stays). */
async function revokeWrite(deps: ProjectMembersDependencies, orgId: OrgId, project: string, developerId: string): Promise<{ write: Item; role: ProjectRole | undefined } | undefined> {
  const existing = await readGrant(deps, orgId, developerId, project);
  if (existing === undefined || (existing.role !== "developer" && existing.role !== "viewer")) return undefined;
  return { role: grantRoleOf(existing), write: { Delete: {
    TableName: deps.tableName, Key: projectMemberKey(orgId, developerId, project),
    ConditionExpression: "attribute_exists(pk) AND #role = :seen AND " + grantSnapshot(existing).condition, ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":seen": existing.role, ...grantSnapshot(existing).values },
  } } };
}

/** Where a project's member requests are remembered: its own partition, beside META and the revisions, under a prefix nothing else reads. */
const memberRequestKey = (orgId: OrgId, project: string, requestId: string): OrgKey => ({ pk: projectPk(orgId, project), sk: `MEMBER_REQUEST#${requestId}` });

/** How long a request id is remembered: a day, as the project-creation request is. After that the State table's TTL removes it. */
const MEMBER_REQUEST_SECONDS = 86_400;

export interface ProjectMemberChangeDependencies extends ProjectMembersDependencies {
  now: () => Date;
  /** The Audit Ledger's outbox (Task 18): a change is recorded in the transaction that makes it. Absent on a legacy install. */
  audit?: AuditRuntime;
}

type StoredRequest = { indexExpiresAt?: unknown; action?: unknown; target?: unknown; role?: unknown; by?: unknown; response?: unknown };

/**
 * The stored outcome of a request id already used on this project, or undefined for a fresh one. A replay must be the same caller, action,
 * person and role; anything else with that id is IDEMPOTENCY_CONFLICT (so one caller can neither read nor replay another's request).
 */
async function replayOf(deps: ProjectMemberChangeDependencies, orgId: OrgId, project: string, requestId: string, expected: { action: "put" | "remove"; target: string; role?: ProjectRole; by: string }): Promise<unknown> {
  const stored = (await getItem(deps, memberRequestKey(orgId, project, requestId))) as StoredRequest | undefined;
  if (stored === undefined) return undefined;
  // The State table's TTL can lag by a day or two: a record past its expiry is gone, as far as a request id is concerned.
  if (typeof stored.indexExpiresAt === "number" && stored.indexExpiresAt <= Math.floor(deps.now().getTime() / 1000)) return undefined;
  if (stored.action !== expected.action || stored.target !== expected.target || stored.by !== expected.by || (stored.role ?? undefined) !== (expected.role ?? undefined)) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "that request id was already used for a different change; use a new one");
  }
  return stored.response;
}

/** The request's record, written in the same transaction as the change it belongs to, so a change is never applied without its id being remembered. */
function requestWrite(deps: ProjectMemberChangeDependencies, orgId: OrgId, project: string, requestId: string, record: { action: "put" | "remove"; target: string; role?: ProjectRole; by: string; response: unknown }): Item {
  const at = deps.now();
  return { Put: {
    TableName: deps.tableName,
    Item: { ...memberRequestKey(orgId, project, requestId), entityType: "PROJECT_MEMBER_REQUEST", at: at.toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at.getTime() / 1000) + MEMBER_REQUEST_SECONDS, ...record },
    // A record that has expired but is not yet deleted by the TTL does not stop the id being used again.
    ConditionExpression: `attribute_not_exists(pk) OR ${INDEX_EXPIRY_ATTRIBUTE} <= :now`,
    ExpressionAttributeValues: { ":now": Math.floor(at.getTime() / 1000) },
  } };
}

/**
 * Commits a change with its request record. A cancelled transaction means the grant changed under us, or the same request id got in first
 * (both read again at the top of the next attempt: the second is then a replay). Gives up with CHANGE_STALE after a few attempts.
 */
async function commitWithRequest(deps: ProjectMemberChangeDependencies, items: Item[], event?: AuditEventInput): Promise<boolean> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...items, ...(event === undefined ? [] : auditPending(deps, event))] }));
    if (event !== undefined) await flushAuditEvents(deps, [event]);
    return true;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
    return false;
  }
}

const STALE = () => agentXError("CHANGE_STALE", "that person's role was changed by someone else at the same time; try again");
const MAX_ATTEMPTS = 3;

/**
 * Who a change may name: a member of this org, other than an org owner or admin (their access is their org role; a grant would say nothing
 * and a removal would take nothing away). A merged-away developer id stands for its survivor. Anyone else, another org's people included,
 * is NOT_FOUND "that person isn't in your organization".
 */
async function resolveTarget(deps: ProjectMembersDependencies, orgId: OrgId, rawId: string): Promise<string> {
  const developerId = await survivorOf(deps, rawId);
  const member = await getItem(deps, orgMemberKey(orgId, developerId));
  const role = OrgRoleSchema.safeParse(member?.role);
  if (!role.success) throw agentXError("NOT_FOUND", "that person isn't in your organization");
  if (role.data === "owner" || role.data === "admin") throw agentXError("CONFIG_INVALID", "owners and admins already maintain every project");
  // The Auditor reads the audit log and nothing else; a project grant would say nothing it could use, so none is written.
  if (role.data === "auditor") throw agentXError("CONFIG_INVALID", "the Auditor role holds no project access");
  return developerId;
}

/**
 * `PUT /v1/app/projects/{name}/members/{developerId}`, after the route has checked that the caller may manage members. A replay of the same
 * request id answers the stored outcome and applies nothing. `actor` is the person who asked: they are recorded as who added a new member.
 * The grant and the request record are one transaction.
 */
export async function setProjectMember(
  deps: ProjectMemberChangeDependencies,
  orgId: OrgId,
  project: string,
  input: { requestId: string; developerId: string; role: ProjectRole; actor: { developerId: string } },
): Promise<{ developerId: string; role: ProjectRole }> {
  const expected = { action: "put" as const, target: input.developerId, role: input.role, by: input.actor.developerId };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const replayed = await replayOf(deps, orgId, project, input.requestId, expected);
    if (replayed !== undefined) return replayed as { developerId: string; role: ProjectRole };
    const developerId = await resolveTarget(deps, orgId, input.developerId);
    const response = { developerId, role: input.role };
    const { write, fromRole } = await grantWrite(deps, { orgId, project, developerId, role: input.role, grantedBy: { developerId: input.actor.developerId }, now: deps.now });
    // A change to the role the person already has is no change: the request is remembered and nothing is recorded.
    const event = fromRole === input.role ? undefined : await tryAuditEvent(deps, () => auditProjectMemberChanged({
      orgId, actor: { kind: "member", id: input.actor.developerId }, occurredAt: deps.now().toISOString(), occurrence: auditOccurrence(input.requestId, project, developerId, input.role),
      projectName: project, memberId: developerId, ...(fromRole === undefined ? {} : { fromRole }), toRole: input.role,
    }));
    if (await commitWithRequest(deps, [write, stillMember(deps, orgId, developerId), ...await approvalGrantChange(deps, orgId, project, fromRole === "maintainer" && input.role !== "maintainer"), requestWrite(deps, orgId, project, input.requestId, { ...expected, response })], event)) return response;
  }
  throw STALE();
}

/** `DELETE /v1/app/projects/{name}/members/{developerId}`, after the route's checks. `removed` is false for a person with no grant (the request is still recorded). */
export async function removeProjectMember(
  deps: ProjectMemberChangeDependencies,
  orgId: OrgId,
  project: string,
  input: { requestId: string; developerId: string; actor: { developerId: string } },
): Promise<{ developerId: string; removed: boolean }> {
  const expected = { action: "remove" as const, target: input.developerId, by: input.actor.developerId };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const replayed = await replayOf(deps, orgId, project, input.requestId, expected);
    if (replayed !== undefined) return replayed as { developerId: string; removed: boolean };
    const developerId = await resolveTarget(deps, orgId, input.developerId);
    const revoke = await revokeWrite(deps, orgId, project, developerId);
    const response = { developerId, removed: revoke !== undefined };
    const event = revoke?.role === undefined ? undefined : await tryAuditEvent(deps, () => auditProjectMemberRemoved({
      orgId, actor: { kind: "member", id: input.actor.developerId }, occurredAt: deps.now().toISOString(), occurrence: auditOccurrence(input.requestId, project, developerId),
      projectName: project, memberId: developerId, role: revoke.role!,
    }));
    if (await commitWithRequest(deps, [...(revoke === undefined ? [] : [revoke.write, ...await approvalGrantChange(deps, orgId, project, revoke.role === "maintainer")]), requestWrite(deps, orgId, project, input.requestId, { ...expected, response })], event)) return response;
  }
  throw STALE();
}
