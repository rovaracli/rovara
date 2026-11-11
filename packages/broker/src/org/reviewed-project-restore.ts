// Lane B reviewed restore transaction. Unexposed: future API adapter owns acknowledgment,
// immediate egress reconciliation and canonical outcomes; an immutable receipt is not current state.
import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, AgentXNameSchema, agentXError, orgScoped } from "@rovara-code/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { auditProjectRestored, auditOccurrence } from "../audit/events.js";
import { auditPending, type TransactItem } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { requestRecordPut } from "./request-records.js";
import { readProjectLifecycleRecord as read, validateProjectLifecycleIdentifiers as identifiers, readProjectLifecycleAuthority as authority, readProjectLifecycleState as projectState } from "./reviewed-project-archive.js";
type Deps = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now" | "audit" | "requireRepositoriesConnected">;
const bodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), expectedProjectRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const resultSchema = z.object({ project: AgentXNameSchema, status: z.literal("active"), revision: z.number().int().positive(), projectRevision: z.number().int().positive(), restoredAt: z.string().datetime(), egressReconciliation: z.literal("pending") });
const forbidden = () => agentXError("FORBIDDEN", "Only a current project maintainer can restore this project.");
const stale = () => agentXError("CHANGE_STALE", "The project changed. Refresh and review the restore again.");
const unavailable = () => agentXError("AUDIT_UNAVAILABLE", "The restore outcome could not be confirmed. Refresh before trying again.");
function safeError(error: unknown) {
 if (error instanceof AgentXError) {
  if (error.code === "FORBIDDEN") return forbidden();
  if (error.code === "AUDIT_UNAVAILABLE") return unavailable();
  if (error.code === "CONFIG_INVALID") return agentXError("CONFIG_INVALID", "Review a valid project restore before submitting.");
  if (error.code === "NOT_FOUND") return agentXError("NOT_FOUND", "That project is unavailable in this company.");
  if (error.code === "CHANGE_STALE") return stale();
  if (error.code === "GITHUB_NOT_CONNECTED") return agentXError("GITHUB_NOT_CONNECTED", "Reconnect this project's repositories before restoring.");
  if (error.code === "RUNTIME_UNAVAILABLE") return agentXError("RUNTIME_UNAVAILABLE", "Project prerequisites could not be checked. Try again.");
 }
 return unavailable();
}
async function prerequisites(deps: Deps, caller: DeveloperCaller, state: Awaited<ReturnType<typeof projectState>>) {
 if (deps.requireRepositoriesConnected === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Project prerequisites could not be checked. Try again.");
 try { await deps.requireRepositoriesConnected(caller.orgId, state.definition); }
 catch (error) {
  if (error instanceof AgentXError && error.code === "GITHUB_NOT_CONNECTED") throw agentXError("GITHUB_NOT_CONNECTED", "Reconnect this project's repositories before restoring.");
  throw agentXError("RUNTIME_UNAVAILABLE", "Project prerequisites could not be checked. Try again.");
 }
}
export async function readProjectRestorePreview(deps: Deps, caller: DeveloperCaller, name: string) {
 try {
  identifiers(caller, name);await authority(deps, caller, name);const state = await projectState(deps, caller, name);if (state.status === "archived") await prerequisites(deps, caller, state);
  return { project: name, status: state.status, expectedRevision: state.epoch, expectedProjectRevision: state.projectRevision, checkedAt: new Date(deps.now()).toISOString(), prerequisites: state.status === "archived" ? "checked" as const : "not_required" as const };
 } catch (error) { throw safeError(error); }
}
export async function restoreProjectReviewed(deps: Deps, caller: DeveloperCaller, name: string, body: unknown) {
 return (await commitReviewedProjectRestore(deps, caller, name, body)).receipt;
}
export async function commitReviewedProjectRestore(deps: Deps, caller: DeveloperCaller, name: string, body: unknown) {
 try {
  identifiers(caller, name);const parsed = bodySchema.safeParse(body);if (!parsed.success) throw agentXError("CONFIG_INVALID", "Review a valid project restore before submitting.");const change = parsed.data;
  const { orgId, developerId: by } = caller, auth = await authority(deps, caller, name);
  if (deps.audit === undefined || deps.audit.tableName !== deps.tableName) throw unavailable();
  // Historical archive namespace deliberately shared: old archive receipts remain valid and
  // UUID reuse across archive/restore is refused by action/body binding in either direction.
  const receiptKey = { pk: orgScoped(orgId, "REVIEWED_PROJECT_ARCHIVE"), sk: change.requestId }, action = "project.restored";
  const bodyHash = createHash("sha256").update(JSON.stringify([orgId, by, action, name, change.expectedRevision, change.expectedProjectRevision])).digest("hex");
  async function replay() {
   const receipt = await read(deps, receiptKey);if (receipt === undefined) return undefined;
   if (receipt.by !== by || receipt.action !== action || receipt.bodyHash !== bodyHash) throw agentXError("CONFIG_INVALID", "Review a valid project restore before submitting.");
   const result = resultSchema.safeParse(receipt);if (!result.success || receipt.orgId !== orgId || result.data.project !== name || result.data.revision !== change.expectedRevision + 1 || result.data.projectRevision !== change.expectedProjectRevision) throw unavailable();return result.data;
  }
  const previous = await replay();if (previous !== undefined) return { receipt: previous, replayed: true };
  const state = await projectState(deps, caller, name);
  if (state.meta === undefined || state.status !== "archived" || state.epoch !== change.expectedRevision || state.projectRevision !== change.expectedProjectRevision) throw stale();
  await prerequisites(deps, caller, state);
  const now = deps.now(), restoredAt = new Date(now).toISOString(), next = state.epoch + 1;
  const result = resultSchema.parse({ project: name, status: "active", revision: next, projectRevision: state.projectRevision, restoredAt, egressReconciliation: "pending" });
  const labels: string[] = [], items: TransactItem[] = [], add = (label: string, item: TransactItem) => { labels.push(label);items.push(item); };
  const epochCondition = state.meta.archiveRevision === undefined ? "attribute_not_exists(archiveRevision)" : "archiveRevision = :expected";
  add("meta", { Update: { TableName: deps.tableName, Key: state.metaKey, UpdateExpression: "SET #status = :active, archiveRevision = :next REMOVE archivedAt, archivedBy", ConditionExpression: "entityType = :type AND #name = :name AND #status = :archived AND " + epochCondition + (state.meta.orgId === undefined ? " AND attribute_not_exists(orgId)" : " AND orgId = :org"), ExpressionAttributeNames: { "#name": "name", "#status": "status" }, ExpressionAttributeValues: { ":type": "PROJECT_META", ":name": name, ":active": "active", ":archived": "archived", ":next": next, ...(state.meta.archiveRevision === undefined ? {} : { ":expected": state.epoch }), ...(state.meta.orgId === undefined ? {} : { ":org": orgId }) } } });
  add("catalog", { ConditionCheck: { TableName: deps.tableName, Key: state.catalogKey, ConditionExpression: "entityType = :type AND #name = :name AND latestRevision = :revision", ExpressionAttributeNames: { "#name": "name" }, ExpressionAttributeValues: { ":type": "PROJECT_CATALOG", ":name": name, ":revision": state.projectRevision } } });
  add("registered", { ConditionCheck: { TableName: deps.tableName, Key: state.registeredKey, ConditionExpression: "entityType = :type AND #definition.#name = :name AND #definition.#revision = :revision", ExpressionAttributeNames: { "#definition": "definition", "#name": "name", "#revision": "revision" }, ExpressionAttributeValues: { ":type": "PROJECT", ":name": name, ":revision": state.projectRevision } } });
  add("actor", { ConditionCheck: { TableName: deps.tableName, Key: auth.actorKey, ConditionExpression: "orgId = :org AND developerId = :person AND #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":person": by, ":role": auth.actor.role } } });
  add("pointer", { ConditionCheck: { TableName: deps.tableName, Key: auth.pointerKey, ConditionExpression: "orgId = :org AND #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":role": auth.actor.role } } });
  add("org", { ConditionCheck: { TableName: deps.tableName, Key: auth.orgKey, ConditionExpression: "orgId = :org AND attribute_not_exists(closingAt) AND attribute_not_exists(closedAt)", ExpressionAttributeValues: { ":org": orgId } } });
  if (auth.actor.role === "member") add("grant", { ConditionCheck: { TableName: deps.tableName, Key: auth.grantKey, ConditionExpression: "#role = :role AND projectRole = :maintainer AND projectName = :name", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "developer", ":maintainer": "maintainer", ":name": name } } });
  add("receipt", requestRecordPut(deps.tableName, receiptKey, "REVIEWED_PROJECT_RESTORE_REQUEST", { orgId, by, action, bodyHash, ...result }, now));
  const event = auditProjectRestored({ orgId, actor: { kind: "member", id: by }, projectName: name, fromRevision: state.epoch, toRevision: next, projectRevision: state.projectRevision, requestId: change.requestId, occurredAt: restoredAt, occurrence: auditOccurrence("reviewed-project-restore", orgId, change.requestId, name) });
  const pending = auditPending(deps, event);if (pending.length !== 1) throw unavailable();for (const item of pending) { if (item.Put === undefined) throw unavailable();add("audit", { Put: { ...item.Put, ConditionExpression: "attribute_not_exists(pk)" } }); }
  try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
  catch (error) {
   const already = await replay();if (already !== undefined) return { receipt: already, replayed: true };
   const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons, failed = labels.filter((_, index) => reasons?.[index]?.Code === "ConditionalCheckFailed");
   if (failed.some(label => ["actor", "pointer", "org", "grant"].includes(label))) throw forbidden();
   if (failed.some(label => ["meta", "catalog", "registered"].includes(label))) throw stale();throw unavailable();
  }
  await flushAuditEvents(deps, [event]);return { receipt: result, replayed: false };
 } catch (error) { throw safeError(error); }
}
