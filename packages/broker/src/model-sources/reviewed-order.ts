// Reviewed source-order writes: revision, live authority, receipt and audit commit together.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, OrgIdSchema, OrgModelSourcesSchema, ModelSourceIdSchema, agentXError, canonicalJson, modelSourcesKey, orgScoped } from "@rovara-code/contracts";
import { developerOrgKey, orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
import type { RequestMark } from "../agents/table-writes.js";
import { auditModelSourceOrderChanged, auditOccurrence } from "../audit/events.js";
import { auditPending, type TransactItem } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { requestRecordPut } from "../org/request-records.js";
import type { ModelSourceStoreInput, StoredModelSources } from "./store.js";
type Input = { orgId: string; by: string; order: readonly string[]; expectedRevision: number; expectedOrgId?: string | undefined; expectedDeveloperId?: string | undefined; request?: RequestMark | undefined };
type Deps = ModelSourceStoreInput & { read(orgId: string): Promise<StoredModelSources> };
export const ReviewedSourceOrderBodySchema = z.object({ requestId: z.string().uuid(), expectedOrgId: OrgIdSchema.optional(), expectedDeveloperId: z.string().regex(/^[a-f0-9]{64}$/).optional(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), order: z.array(ModelSourceIdSchema).min(1).max(20) }).strict();
const resultSchema = z.object({ order: z.array(ModelSourceIdSchema).min(1).max(20), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const forbidden = () => agentXError("FORBIDDEN", "Only a current company owner or admin can change source order.");
const stale = () => agentXError("CHANGE_STALE", "Company sources changed. Reload and review the order again.");
const unavailable = () => agentXError("AUDIT_UNAVAILABLE", "The source-order change could not be confirmed. Reload before trying again.");
async function read(deps: Deps, key: { pk: string; sk: string }) { return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item; }
export async function changeReviewedSourceOrder(deps: Deps, input: Input): Promise<{ order: string[]; revision: number }> {
 const parsed = ReviewedSourceOrderBodySchema.safeParse({ requestId: input.request?.requestId, expectedOrgId: input.expectedOrgId, expectedDeveloperId: input.expectedDeveloperId, expectedRevision: input.expectedRevision, order: input.order });
 if (!parsed.success || !OrgIdSchema.safeParse(input.orgId).success || !/^[a-f0-9]{64}$/.test(input.by) || input.request?.orgId !== input.orgId || input.request.developerId !== input.by) throw agentXError("CONFIG_INVALID", "Review a valid company source order before submitting.");
 const change = parsed.data;
 if (change.expectedOrgId !== undefined && change.expectedOrgId !== input.orgId) throw agentXError("FORBIDDEN", "Company changed. Reload and review source order again.");
 if (change.expectedDeveloperId !== undefined && change.expectedDeveloperId !== input.by) throw agentXError("FORBIDDEN", "Your sign-in changed. Reload and review source order again.");
 try {
  const orgId = OrgIdSchema.parse(input.orgId), by = input.by, actorKey = orgMemberKey(orgId, by), pointerKey = developerOrgKey(by), orgKey = orgMetaKey(orgId);
  const [actor, pointer, org] = await Promise.all([read(deps, actorKey), read(deps, pointerKey), read(deps, orgKey)]);
  if (actor?.orgId !== orgId || actor.developerId !== by || (actor.role !== "owner" && actor.role !== "admin") || pointer?.orgId !== orgId || pointer.role !== actor.role || org?.orgId !== orgId || org.closingAt !== undefined || org.closedAt !== undefined) throw forbidden();
  if (deps.audit === undefined || deps.audit.tableName !== deps.tableName) throw unavailable();
  const action = "model_source.order_changed", receiptKey = { pk: orgScoped(orgId, "SOURCE_ORDER_REVIEW"), sk: change.requestId };
  const digest = createHash("sha256").update(canonicalJson([orgId, by, action, change.expectedRevision, change.order])).digest("hex");
  async function replay() {
   const receipt = await read(deps, receiptKey);if (receipt === undefined) return undefined;
   if (receipt.by !== by || receipt.action !== action || receipt.digest !== digest) throw agentXError("CONFIG_INVALID", "Use a new request id for a different source-order change.");
   const result = resultSchema.safeParse({ order: receipt.order, revision: receipt.revision });
   if (!result.success || receipt.orgId !== orgId || !result.data.order.every((id, index) => id === change.order[index]) || result.data.order.length !== change.order.length || (result.data.revision !== change.expectedRevision && result.data.revision !== change.expectedRevision + 1)) throw unavailable();return result.data;
  }
  const previous = await replay();if (previous !== undefined) return previous;
  const current = await deps.read(orgId);
  if (current.revision !== change.expectedRevision) throw stale();
  // The whole source contract enforces known IDs, uniqueness and supported built-in sources.
  const candidate = OrgModelSourcesSchema.safeParse({ sources: current.sources, order: change.order, ...(current.assistantModel === undefined ? {} : { assistantModel: current.assistantModel }), ...(current.chatgptPreferredModel === undefined ? {} : { chatgptPreferredModel: current.chatgptPreferredModel }) });
  if (!candidate.success) throw agentXError("CONFIG_INVALID", "Review a valid company source order before submitting.");
  if (candidate.data.order.includes("personal-chatgpt") && !current.order.includes("personal-chatgpt") && !(await deps.chatgptSwitch())) throw agentXError("CONFIG_INVALID", "Personal ChatGPT is disabled in this installation.");
  const changing = !candidate.data.order.every((id, index) => id === current.order[index]) || candidate.data.order.length !== current.order.length;
  const now = deps.now(), at = new Date(now).toISOString(), revision = changing ? current.revision + 1 : current.revision, result = { order: candidate.data.order, revision };
  const labels: string[] = [], items: TransactItem[] = [];
  const add = (label: string, item: TransactItem) => { labels.push(label);items.push(item); };
  const sourceKey = modelSourcesKey(orgId), guard = current.revision === 0 ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "revision = :expected", ExpressionAttributeValues: { ":expected": current.revision } };
  if (changing) {
   const { revision: _revision, ...document } = current; // eslint-disable-line @typescript-eslint/no-unused-vars -- internal revision is replaced below
   add("sources", { Put: { TableName: deps.tableName, Item: { ...sourceKey, ...document, order: result.order, revision, entityType: "ORG_MODEL_SOURCES", updatedBy: by, updatedAt: at }, ...guard } });
   add("directory", { Put: { TableName: deps.tableName, Item: { pk: "MODEL_SOURCES_ORGS", sk: orgId, entityType: "MODEL_SOURCES_ORG", updatedAt: at } } });
  } else add("sources", { ConditionCheck: { TableName: deps.tableName, Key: sourceKey, ...guard } });
  add("actor", { ConditionCheck: { TableName: deps.tableName, Key: actorKey, ConditionExpression: "orgId = :org AND developerId = :person AND #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":person": by, ":role": actor.role } } });
  add("pointer", { ConditionCheck: { TableName: deps.tableName, Key: pointerKey, ConditionExpression: "orgId = :org AND #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":role": actor.role } } });
  add("org", { ConditionCheck: { TableName: deps.tableName, Key: orgKey, ConditionExpression: "orgId = :org AND attribute_not_exists(closingAt) AND attribute_not_exists(closedAt)", ExpressionAttributeValues: { ":org": orgId } } });
  const receipt = requestRecordPut(deps.tableName, receiptKey, "SOURCE_ORDER_REVIEW_REQUEST", { orgId, by, action, digest, ...result }, now);
  // TTL is deletion eligibility only. A physically retained receipt cannot be replaced or reapplied after reversal.
  if (receipt.Put === undefined) throw unavailable();receipt.Put.ConditionExpression = "attribute_not_exists(pk)";delete receipt.Put.ExpressionAttributeValues;add("receipt", receipt);
  const event = changing ? auditModelSourceOrderChanged({ orgId, actor: { kind: "member", id: by }, occurredAt: at, occurrence: auditOccurrence("reviewed-source-order", orgId, change.requestId), count: result.order.length }) : undefined;
  if (event !== undefined) { const pending = auditPending(deps, event);if (pending.length !== 1) throw unavailable();for (const item of pending) { if (item.Put === undefined) throw unavailable();item.Put.ConditionExpression = "attribute_not_exists(pk)";add("audit", item); } }
  try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
  catch (error) {
   const already = await replay();if (already !== undefined) return already;
   const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
   const failed = labels.filter((_, index) => reasons?.[index]?.Code === "ConditionalCheckFailed");
   if (failed.some(label => ["actor", "pointer", "org"].includes(label))) throw forbidden();
   if (failed.includes("sources")) throw stale();throw unavailable();
  }
  if (event !== undefined) await flushAuditEvents(deps, [event]);return result;
 } catch (error) { if (error instanceof AgentXError) throw error;throw unavailable(); }
}
