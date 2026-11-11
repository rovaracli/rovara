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
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, orgProjectCatalogPk, projectMetaKey, type OrgId, type OrgKey } from "@rovara-code/contracts";
import { listEgressItems, setEgressOwnerActive, type EgressDomainsDependencies } from "./egress-domains.js";
import { RECONCILE_READ_CONCURRENCY, settleBounded } from "./settle-bounded.js";
import { readRequestRecord, requestRecordPut, requireSameRequest, type RequestTransactItem } from "./request-records.js";

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
      UpdateExpression: "SET entityType = if_not_exists(entityType, :entity), #name = if_not_exists(#name, :name), createdAt = if_not_exists(createdAt, :at), createdBy = if_not_exists(createdBy, :unknown), #status = :archived, archivedAt = :at, archivedBy = :by ADD archiveRevision :one",
      ConditionExpression: "attribute_not_exists(#status) OR #status <> :archived",
      ExpressionAttributeNames: { "#name": "name", "#status": "status" },
      ExpressionAttributeValues: { ":entity": "PROJECT_META", ":name": name, ":at": at, ":unknown": "unknown", ":archived": "archived", ":by": actor.developerId, ":one": 1 },
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
      UpdateExpression: "SET #status = :active REMOVE archivedAt, archivedBy ADD archiveRevision :one",
      ConditionExpression: "#status = :archived",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":active": "active", ":archived": "archived", ":one": 1 },
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
 * META's transition and lifecycle fence for one request. Each real transition advances archiveRevision; a no-op only fences the
 * observed META and still records its request item. This preserves legacy no-op receipts while invalidating stale reviewed previews.
 * A project that predates META gets one, created by "unknown".
 */
function metaChange(deps: ProjectArchiveDependencies, orgId: OrgId, name: string, change: "archive" | "restore", actor: { developerId: string }, at: string, current: Record<string, unknown> | undefined): RequestTransactItem {
  // Creating a missing META on legacy restore establishes epoch 1 even without a prior transition.
  const epoch = current?.archiveRevision ?? 0;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER) throw agentXError("RUNTIME_UNAVAILABLE", "Project lifecycle could not be checked.");
  const before = current?.status, desired = change === "archive" ? "archived" : "active";
  const condition = current === undefined ? "attribute_not_exists(pk)" : (before === undefined ? "attribute_not_exists(#status)" : "#status = :before") + " AND " + (current.archiveRevision === undefined ? "attribute_not_exists(archiveRevision)" : "archiveRevision = :expected");
  const fenceValues = { ...(current !== undefined && before !== undefined ? { ":before": before } : {}), ...(current?.archiveRevision === undefined ? {} : { ":expected": epoch }) };
  if (current !== undefined && (before ?? "active") === desired) return { ConditionCheck: { TableName: deps.tableName, Key: projectMetaKey(orgId, name), ConditionExpression: condition, ExpressionAttributeNames: { "#status": "status" }, ...(Object.keys(fenceValues).length ? { ExpressionAttributeValues: fenceValues } : {}) } };
  const make = "entityType = if_not_exists(entityType, :entity), #name = if_not_exists(#name, :name), createdAt = if_not_exists(createdAt, :at), createdBy = if_not_exists(createdBy, :unknown), archiveRevision = :next";
  return { Update: {
    TableName: deps.tableName, Key: projectMetaKey(orgId, name),
    UpdateExpression: change === "archive" ? `SET ${make}, #status = :archived, archivedAt = if_not_exists(archivedAt, :at), archivedBy = if_not_exists(archivedBy, :by)` : `SET ${make}, #status = :active REMOVE archivedAt, archivedBy`,
    ConditionExpression: condition, ExpressionAttributeNames: { "#name": "name", "#status": "status" },
    ExpressionAttributeValues: { ":entity": "PROJECT_META", ":name": name, ":at": at, ":unknown": "unknown", ":next": epoch + 1, ...fenceValues, ...(change === "archive" ? { ":archived": "archived", ":by": actor.developerId } : { ":active": "active" }) },
  } };
}

const REQUEST_ATTEMPTS = 3;

/**
 * One archive or restore request, by the one request-id pattern (`request-records`): the META change and the request record are ONE transaction,
 * the record is the caller's and expires, and a replay of the same id by the same person applies nothing and answers `replayed: true` (a late
 * replay after the opposite action cannot undo it). The same id by someone else, or for the other action, is IDEMPOTENCY_CONFLICT. The firewall
 * step follows the commit: if it fails the call fails, the project stays as asked, and the scheduled `reconcileProjectEgress` (or a new request)
 * finishes it, since a replay of the id writes nothing.
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
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    const nowMs = deps.now().getTime();
    const stored = await readRequestRecord(deps.documentClient, deps.tableName, key, nowMs);
    if (stored !== undefined) {
      requireSameRequest(stored, { by: actor.developerId, action: change });
      return { warnings: [], replayed: true };
    }
    const current = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectMetaKey(orgId, name), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        metaChange(deps, orgId, name, change, actor, new Date(nowMs).toISOString(), current),
        requestRecordPut(deps.tableName, key, "PROJECT_ARCHIVE_REQUEST", { action: change, by: actor.developerId }, nowMs),
      ] }));
    } catch (error) {
      // The same id got in first (read again: it is then a replay), or the item was busy.
      if (error instanceof Error && error.name === "TransactionCanceledException") continue;
      throw error;
    }
    const { warning } = await setEgressOwnerActive(deps.egress, orgId, { kind: "project", project: name }, change === "restore");
    return { warnings: warning === undefined ? [] : [warning], replayed: false };
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "the project could not be changed just now; try again with the same request id");
}

/**
 * The scheduled run's repair for an archive or restore that stopped after META (the process died, or the flip failed for good): every project-owned
 * egress item is made to agree with its project's META, an archived project's inactive and any other's active. A project with no META reads as
 * active. The consistent META reads go several at a time (follow-up N3); the flips go one at a time, since each one writes the sync marker. One
 * project failing does not stop the others; the run then throws. A restore that lands between a read and its flip is put right by the next run.
 */
export async function reconcileProjectEgress(deps: Pick<ProjectArchiveDependencies, "documentClient" | "tableName" | "egress">): Promise<{ flipped: number }> {
  const projects = (await listEgressItems(deps.egress)).filter((item) => item.owner.kind === "project");
  const read = await settleBounded(projects, RECONCILE_READ_CONCURRENCY, async (item) => {
    const owner = item.owner as Extract<typeof item.owner, { kind: "project" }>;
    const meta = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectMetaKey(item.orgId, owner.project), ConsistentRead: true })) as { Item?: { status?: unknown } };
    return meta.Item?.status !== "archived";
  });
  let flipped = 0;
  let failed = 0;
  for (const [index, outcome] of read.entries()) {
    const item = projects[index]!;
    try {
      if (outcome.status === "rejected") throw outcome.reason;
      if (item.active === outcome.value) continue;
      await setEgressOwnerActive(deps.egress, item.orgId, item.owner, outcome.value);
      flipped += 1;
    } catch (error) {
      failed += 1;
      console.log(JSON.stringify({ component: "broker", event: "egress.reconcile_project_egress_failed", orgId: item.orgId, error: error instanceof Error ? error.name : "UnknownError" }));
    }
  }
  if (failed > 0) throw new Error(`${String(failed)} egress item(s) could not be reconciled with their project`);
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

// Lane B reviewed transaction and app effect adapter.
export { readProjectArchivePreview, archiveProjectReviewed } from "./reviewed-project-archive.js";
export { archiveProjectReviewedWithEffects } from "./reviewed-project-archive-app.js";

// Lane B internal restore primitive; not wired to HTTP/UI.
export { readProjectRestorePreview, restoreProjectReviewed } from "./reviewed-project-restore.js";

// Lane B reviewed restore app adapter.
export { readReviewedProjectRestoreAppPreview, restoreProjectReviewedWithEffects } from "./reviewed-project-restore-app.js";
