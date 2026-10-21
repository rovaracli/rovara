// Plan 2, Task 20: archive and restore a project. Archiving is the project's META item (`status`, `archivedAt`, `archivedBy`) plus its egress
// item going inactive, so its approved domains leave the cell firewall's union; restoring undoes both. Neither stops work that exists: only the
// places that start new work read the status (`requireNewWorkAllowed`, and a settings save).
//
// Order matters. META is written first and the egress flip follows it, because a new egress item reads the project's status inside its own
// transaction: an archive that lands first makes a racing item start inactive, and one that lands after finds the item to flip. If the flip then
// fails, the status stands and the call fails; repeating the call finds the project already in the state asked for, and runs the flip again
// (it changes nothing when the item is already as asked), so a retry is always safe. A half-done restore fails closed: the project is active and
// its domains stay out of the union until the flip lands.
import { UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { orgProjectCatalogPk, projectMetaKey, type OrgId } from "@agentx/contracts";
import { setEgressOwnerActive, type EgressDomainsDependencies } from "./egress-domains.js";

export interface ProjectArchiveDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Where the project's egress item lives, and how a change reaches the firewall. */
  egress: EgressDomainsDependencies;
  now: () => Date;
}

const isConditionFailure = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";

/**
 * Archives a project. A project already archived keeps its first `archivedAt` and `archivedBy`. A project that predates META gets one (active
 * and created by "unknown" before this write, which is how it already reads). `actor` is the person who asked.
 */
export async function archiveProject(deps: ProjectArchiveDependencies, orgId: OrgId, name: string, actor: { developerId: string }): Promise<void> {
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
    // Already archived: the first archive's record stands. The egress flip below still runs, to finish an archive that stopped after META.
    if (!isConditionFailure(error)) throw error;
  }
  await setEgressOwnerActive(deps.egress, orgId, { kind: "project", project: name }, false);
}

/** Restores a project: active again, `archivedAt` and `archivedBy` removed, its approved domains back in the union without being asked for again. */
export async function restoreProject(deps: ProjectArchiveDependencies, orgId: OrgId, name: string): Promise<void> {
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
  await setEgressOwnerActive(deps.egress, orgId, { kind: "project", project: name }, true);
}

/** Closing an org: every project in its catalog is archived by the person who closed it. Safe to run again after a stop part-way. */
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
      if (typeof item.name === "string") await archiveProject(deps, orgId, item.name, actor);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
}
