// Reviewed archive transaction; the separate app adapter owns explicit acknowledgment and post-commit effects.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, AgentXNameSchema, OrgIdSchema, StoredProjectDefinitionSchema, agentXError, developerOrgKey, orgMemberKey, orgMetaKey, orgProjectCatalogKey, projectRevisionKey, projectMetaKey, projectMemberKey, orgScoped } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { auditProjectArchived, auditOccurrence } from "../audit/events.js";
import { auditPending, type TransactItem } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { requestRecordPut } from "./request-records.js";
type Deps = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now" | "audit">;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const bodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: revision, expectedProjectRevision: z.number().int().positive() }).strict();
const resultSchema = z.object({ project: AgentXNameSchema, status: z.literal("archived"), revision: z.number().int().positive(), projectRevision: z.number().int().positive(), archivedAt: z.string().datetime(), egressReconciliation: z.literal("pending") });
const forbidden = () => agentXError("FORBIDDEN", "Only a current project maintainer can archive this project.");
const missing = () => agentXError("NOT_FOUND", "That project is unavailable in this company.");
const stale = () => agentXError("CHANGE_STALE", "The project changed. Refresh and review the archive again.");
const unavailable = () => agentXError("AUDIT_UNAVAILABLE", "The archive outcome could not be confirmed. Refresh before trying again.");
async function read(deps: Deps, key: { pk: string; sk: string }) { return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item; }
function identifiers(caller: DeveloperCaller, name: string) { if (!OrgIdSchema.safeParse(caller.orgId).success || !/^[a-f0-9]{64}$/.test(caller.developerId) || !AgentXNameSchema.safeParse(name).success) throw agentXError("CONFIG_INVALID", "Review a valid project before archiving."); }
async function authority(deps: Deps, caller: DeveloperCaller, name: string) {
 const { orgId, developerId } = caller;
 const actorKey = orgMemberKey(orgId, developerId), pointerKey = developerOrgKey(developerId), orgKey = orgMetaKey(orgId), grantKey = projectMemberKey(orgId, developerId, name);
 const [actor, pointer, org] = await Promise.all([read(deps, actorKey), read(deps, pointerKey), read(deps, orgKey)]);
 if (actor?.orgId !== orgId || actor.developerId !== developerId || (actor.role !== "owner" && actor.role !== "admin" && actor.role !== "member") || pointer?.orgId !== orgId || pointer.role !== actor.role || org?.orgId !== orgId || org.closingAt !== undefined || org.closedAt !== undefined) throw forbidden();
 if (actor.role === "member") { const grant = await read(deps, grantKey);if (grant?.role !== "developer" || grant.projectRole !== "maintainer" || grant.projectName !== name) throw forbidden(); }
 return { actor, actorKey, pointerKey, orgKey, grantKey };
}
async function projectState(deps: Deps, caller: DeveloperCaller, name: string) {
 const catalogKey = orgProjectCatalogKey(caller.orgId, name), metaKey = projectMetaKey(caller.orgId, name);
 const [catalog, meta] = await Promise.all([read(deps, catalogKey), read(deps, metaKey)]);
 const projectRevision = z.number().int().positive().safeParse(catalog?.latestRevision);
 if (catalog?.entityType !== "PROJECT_CATALOG" || catalog.name !== name || !projectRevision.success) throw missing();
 const registeredKey = projectRevisionKey(caller.orgId, name, projectRevision.data), registered = await read(deps, registeredKey), definition = StoredProjectDefinitionSchema.safeParse(registered?.definition);
 if (registered?.entityType !== "PROJECT" || !definition.success || definition.data.name !== name || definition.data.revision !== projectRevision.data) throw missing();
 if (meta !== undefined && (meta.entityType !== "PROJECT_META" || meta.name !== name || (meta.orgId !== undefined && meta.orgId !== caller.orgId) || (meta.status !== undefined && meta.status !== "active" && meta.status !== "archived"))) throw missing();
 const epoch = revision.safeParse(meta?.archiveRevision === undefined ? 0 : meta.archiveRevision);if (!epoch.success) throw unavailable();
 return { catalogKey, metaKey, registeredKey, meta, definition: definition.data, epoch: epoch.data, projectRevision: projectRevision.data, status: meta?.status === "archived" ? "archived" as const : "active" as const };
}
export async function readProjectArchivePreview(deps: Deps, caller: DeveloperCaller, name: string) {
 identifiers(caller, name);
 try { await authority(deps, caller, name);const state = await projectState(deps, caller, name);return { project: name, status: state.status, expectedRevision: state.epoch, expectedProjectRevision: state.projectRevision, checkedAt: new Date(deps.now()).toISOString() }; }
 catch (error) { if (error instanceof AgentXError) throw error;throw unavailable(); }
}
export async function archiveProjectReviewed(deps: Deps, caller: DeveloperCaller, name: string, body: unknown) {
 return (await commitReviewedProjectArchive(deps, caller, name, body)).receipt;
}
/** Execution metadata is not stored in the immutable receipt. Replays must not repeat hooks. */
export async function commitReviewedProjectArchive(deps: Deps, caller: DeveloperCaller, name: string, body: unknown) {
 identifiers(caller, name);const parsed = bodySchema.safeParse(body);if (!parsed.success) throw agentXError("CONFIG_INVALID", "Review a valid project archive before submitting.");
 try {
  const change = parsed.data;
  const { orgId, developerId: by } = caller, auth = await authority(deps, caller, name);
  if (deps.audit === undefined || deps.audit.tableName !== deps.tableName) throw unavailable();
  const receiptKey = { pk: orgScoped(orgId, "REVIEWED_PROJECT_ARCHIVE"), sk: change.requestId }, action = "project.archived";
  const bodyHash = createHash("sha256").update(JSON.stringify([orgId, by, action, name, change.expectedRevision, change.expectedProjectRevision])).digest("hex");
  async function replay() {
   const receipt = await read(deps, receiptKey);if (receipt === undefined) return undefined;
   if (receipt.by !== by || receipt.action !== action || receipt.bodyHash !== bodyHash) throw agentXError("CONFIG_INVALID", "Use a new request id for a different archive.");
   const result = resultSchema.safeParse(receipt);if (!result.success || receipt.orgId !== orgId || result.data.project !== name || result.data.revision !== change.expectedRevision + 1 || result.data.projectRevision !== change.expectedProjectRevision) throw unavailable();return result.data;
  }
  const previous = await replay();if (previous !== undefined) return { receipt: previous, replayed: true };
  const state = await projectState(deps, caller, name);
  if (state.status !== "active" || state.epoch !== change.expectedRevision || state.projectRevision !== change.expectedProjectRevision) throw stale();
  const now = deps.now(), archivedAt = new Date(now).toISOString(), next = state.epoch + 1;
  const result = resultSchema.parse({ project: name, status: "archived", revision: next, projectRevision: state.projectRevision, archivedAt, egressReconciliation: "pending" });
  const labels: string[] = [], items: TransactItem[] = [], add = (label: string, item: TransactItem) => { labels.push(label);items.push(item); };
  const epochCondition = state.meta?.archiveRevision === undefined ? "attribute_not_exists(archiveRevision)" : "archiveRevision = :expected";
  add("meta", { Update: { TableName: deps.tableName, Key: state.metaKey, UpdateExpression: "SET entityType = :type, #name = :name, #status = :archived, archivedAt = :at, archivedBy = :by, archiveRevision = :next, createdAt = if_not_exists(createdAt, :at), createdBy = if_not_exists(createdBy, :unknown)", ConditionExpression: state.meta === undefined ? "attribute_not_exists(pk)" : "entityType = :type AND #name = :name AND " + (state.meta.status === undefined ? "attribute_not_exists(#status)" : "#status = :active") + " AND " + epochCondition + (state.meta.orgId === undefined ? " AND attribute_not_exists(orgId)" : " AND orgId = :org"), ExpressionAttributeNames: { "#name": "name", "#status": "status" }, ExpressionAttributeValues: { ":type": "PROJECT_META", ":name": name, ":archived": "archived", ":at": archivedAt, ":by": by, ":next": next, ":unknown": "unknown", ...(state.meta === undefined ? {} : { ...(state.meta.status === undefined ? {} : { ":active": "active" }), ...(state.meta.archiveRevision === undefined ? {} : { ":expected": state.epoch }), ...(state.meta.orgId === undefined ? {} : { ":org": orgId }) }) } } });
  add("catalog", { ConditionCheck: { TableName: deps.tableName, Key: state.catalogKey, ConditionExpression: "entityType = :type AND #name = :name AND latestRevision = :revision", ExpressionAttributeNames: { "#name": "name" }, ExpressionAttributeValues: { ":type": "PROJECT_CATALOG", ":name": name, ":revision": state.projectRevision } } });
  add("registered", { ConditionCheck: { TableName: deps.tableName, Key: state.registeredKey, ConditionExpression: "entityType = :type AND #definition.#name = :name AND #definition.#revision = :revision", ExpressionAttributeNames: { "#definition": "definition", "#name": "name", "#revision": "revision" }, ExpressionAttributeValues: { ":type": "PROJECT", ":name": name, ":revision": state.projectRevision } } });
  add("actor", { ConditionCheck: { TableName: deps.tableName, Key: auth.actorKey, ConditionExpression: "orgId = :org AND developerId = :person AND #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":person": by, ":role": auth.actor.role } } });
  add("pointer", { ConditionCheck: { TableName: deps.tableName, Key: auth.pointerKey, ConditionExpression: "orgId = :org AND #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":role": auth.actor.role } } });
  add("org", { ConditionCheck: { TableName: deps.tableName, Key: auth.orgKey, ConditionExpression: "orgId = :org AND attribute_not_exists(closingAt) AND attribute_not_exists(closedAt)", ExpressionAttributeValues: { ":org": orgId } } });
  if (auth.actor.role === "member") add("grant", { ConditionCheck: { TableName: deps.tableName, Key: auth.grantKey, ConditionExpression: "#role = :role AND projectRole = :maintainer AND projectName = :name", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "developer", ":maintainer": "maintainer", ":name": name } } });
  add("receipt", requestRecordPut(deps.tableName, receiptKey, "REVIEWED_PROJECT_ARCHIVE_REQUEST", { orgId, by, action, bodyHash, ...result }, now));
  const event = auditProjectArchived({ orgId, actor: { kind: "member", id: by }, projectName: name, fromRevision: state.epoch, toRevision: next, projectRevision: state.projectRevision, requestId: change.requestId, occurredAt: archivedAt, occurrence: auditOccurrence("reviewed-project-archive", orgId, change.requestId, name) });
  const pending = auditPending(deps, event);if (pending.length !== 1) throw unavailable();for (const item of pending) { if (item.Put === undefined) throw unavailable();add("audit", { Put: { ...item.Put, ConditionExpression: "attribute_not_exists(pk)" } }); }
  try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
  catch (error) {
   const already = await replay();if (already !== undefined) return { receipt: already, replayed: true };
   const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons, failed = labels.filter((_, index) => reasons?.[index]?.Code === "ConditionalCheckFailed");
   if (failed.some(label => ["actor", "pointer", "org", "grant"].includes(label))) throw forbidden();
   if (failed.some(label => ["meta", "catalog", "registered"].includes(label))) throw stale();throw unavailable();
  }
  await flushAuditEvents(deps, [event]);return { receipt: result, replayed: false };
 } catch (error) { if (error instanceof AgentXError) throw error;throw unavailable(); }
}

// Internal lifecycle readers shared by the reviewed restore primitive; no HTTP exports.
export { read as readProjectLifecycleRecord, identifiers as validateProjectLifecycleIdentifiers, authority as readProjectLifecycleAuthority, projectState as readProjectLifecycleState };
