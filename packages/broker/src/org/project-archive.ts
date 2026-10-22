// Plan 2, Task 20: archive and restore a project. Archiving is the project's META item (`status`, `archivedAt`, `archivedBy`) plus its egress
// item going inactive, so its approved domains leave the cell firewall's union; restoring undoes both. Neither stops work that exists: only the
// places that start new work read the status (`requireNewWorkAllowed`, and a settings save).
//
// Order matters. META is written first and the egress flip follows it, because a new egress item reads the project's status inside its own
// transaction: an archive that lands first makes a racing item start inactive, and one that lands after finds the item to flip. If the flip then
// fails, the status stands and the call fails; repeating the call finds the project already in the state asked for, and runs the flip again
// (it changes nothing when the item is already as asked), so a retry is always safe. A half-done restore fails closed: the project is active and
// its domains stay out of the union until the flip lands. If the process dies between the two, nobody is told to repeat the call; the scheduled egress
// sync runs `reconcileProjectEgress`, which makes every project's items agree with its META again.
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, orgProjectCatalogPk, projectMetaKey, type OrgId, type OrgKey } from "@agentx/contracts";
import { listEgressItems, setEgressOwnerActive, type EgressDomainsDependencies } from "./egress-domains.js";

export interface ProjectArchiveDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Where the project's egress item lives, and how a change reaches the firewall. */
  egress: EgressDomainsDependencies;
  now: () => Date;
}

const isConditionFailure = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";

/** Writes META archived. A project already archived keeps its first `archivedAt` and `archivedBy`; one that predates META gets one. */
async function markArchived(deps: ProjectArchiveDependencies, orgId: OrgId, name: string, actor: { developerId: string }): Promise<void> {
  const at = deps.now().toISOString();
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName,
      Key: projectMetaKey(orgId, name),
      UpdateExpression: "SET entityType = if_not_exists(entityType, :entity), #name = if_not_exists(#name, :name), createdAt = if_not_exists(createdAt, :at), createdBy = if_not_exists(createdBy, :unknown), #status = :archived, archivedAt = :at, archivedBy = :by",
      ConditionExpression: "attribute_not_exists(#status) OR #status <> :archived",
      ExpressionAttributeNames: { "#name": "name", "#status": "status" },
      ExpressionAttributeValues: { ":entity": "PROJECT_META", ":name": name, ":at": at, ":unknown": "unknown", ":archived": "archived", ":by": actor.developerId },
    }));
  } catch (error) {
    // Already archived: the first archive's record stands.
    if (!isConditionFailure(error)) throw error;
  }
}

/**
 * Archives a project, then flips its egress item inactive (the flip runs even when the project was already archived, to finish an archive that
 * stopped after META). `warnings` says when the firewall could not be told at once. `actor` is the person who asked.
 */
export async function archiveProject(deps: ProjectArchiveDependencies, orgId: OrgId, name: string, actor: { developerId: string }): Promise<{ warnings: string[] }> {
  await markArchived(deps, orgId, name, actor);
  const { warning } = await setEgressOwnerActive(deps.egress, orgId, { kind: "project", project: name }, false);
  return { warnings: warning === undefined ? [] : [warning] };
}

/** Restores a project: active again, `archivedAt` and `archivedBy` removed, its approved domains back in the union without being asked for again. */
export async function restoreProject(deps: ProjectArchiveDependencies, orgId: OrgId, name: string): Promise<{ warnings: string[] }> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName,
      Key: projectMetaKey(orgId, name),
      UpdateExpression: "SET #status = :active REMOVE archivedAt, archivedBy",
      ConditionExpression: "#status = :archived",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":active": "active", ":archived": "archived" },
    }));
  } catch (error) {
    // Not archived (active, or a project with no META): nothing to undo here. The egress flip below still runs, to finish a restore that stopped after META.
    if (!isConditionFailure(error)) throw error;
  }
  const { warning } = await setEgressOwnerActive(deps.egress, orgId, { kind: "project", project: name }, true);
  return { warnings: warning === undefined ? [] : [warning] };
}

/** Where a project's archive and restore requests are remembered: its own partition, beside META and the revisions, under a prefix nothing else reads. */
const archiveRequestKey = (orgId: OrgId, name: string, requestId: string): OrgKey => ({ pk: projectMetaKey(orgId, name).pk, sk: `ARCHIVE_REQUEST#${requestId}` });

/**
 * One archive or restore request. The first call applies it (`archiveProject` or `restoreProject`) and then stores the request id with its action,
 * so a replay of the same id applies nothing and answers `replayed: true` (a late replay after the opposite action cannot undo it). The same id
 * for the other action is IDEMPOTENCY_CONFLICT. An id is stored only after the call finished, so a call that failed part-way is retried, not replayed.
 * The record has no expiry: archives are rare, and a replay may arrive at any time.
 */
export async function applyArchiveRequest(
  deps: ProjectArchiveDependencies,
  orgId: OrgId,
  name: string,
  change: "archive" | "restore",
  requestId: string,
  actor: { developerId: string },
): Promise<{ warnings: string[]; replayed: boolean }> {
  const key = archiveRequestKey(orgId, name, requestId);
  const stored = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: { action?: unknown } };
  if (stored.Item !== undefined) {
    if (stored.Item.action !== change) throw agentXError("IDEMPOTENCY_CONFLICT", "that request id was already used for a different action; use a new one");
    return { warnings: [], replayed: true };
  }
  const { warnings } = change === "archive" ? await archiveProject(deps, orgId, name, actor) : await restoreProject(deps, orgId, name);
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: { ...key, entityType: "PROJECT_ARCHIVE_REQUEST", action: change, at: deps.now().toISOString(), by: actor.developerId },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (error) {
    // An identical request stored its record first; both applied the same idempotent change.
    if (!isConditionFailure(error)) throw error;
  }
  return { warnings, replayed: false };
}

/**
 * The scheduled run's repair for an archive or restore that stopped after META (the process died, or the flip failed for good): every project-owned
 * egress item is made to agree with its project's META, an archived project's inactive and any other's active. A project with no META reads as
 * active. One consistent META read per project item. A restore that lands between a read and its flip is put right by the next run.
 */
export async function reconcileProjectEgress(deps: Pick<ProjectArchiveDependencies, "documentClient" | "tableName" | "egress">): Promise<{ flipped: number }> {
  let flipped = 0;
  for (const item of await listEgressItems(deps.egress)) {
    if (item.owner.kind !== "project") continue;
    const meta = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectMetaKey(item.orgId, item.owner.project), ConsistentRead: true })) as { Item?: { status?: unknown } };
    const shouldBeActive = meta.Item?.status !== "archived";
    if (item.active === shouldBeActive) continue;
    await setEgressOwnerActive(deps.egress, item.orgId, item.owner, shouldBeActive);
    flipped += 1;
  }
  return { flipped };
}

/**
 * Closing an org: every project in its catalog is archived (META only) by the person who closed it. The egress items are not flipped one by one,
 * with a sync each: `clearOrgEgress` deletes them right after, with its own sync. Safe to run again after a stop part-way.
 */
export async function archiveOrgProjects(deps: ProjectArchiveDependencies, orgId: OrgId, actor: { developerId: string }): Promise<void> {
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": orgProjectCatalogPk(orgId), ":prefix": "PROJECT#" },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ name?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (typeof item.name === "string") await markArchived(deps, orgId, item.name, actor);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
}
