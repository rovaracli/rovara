// Lessons in production, lane 1b: the company's optional "lessons model", the model its lesson learning (reflect, judge) runs on. Unset (the default): the company's cheapest suitable company-billed model
// (`chooseLearningRoute`). Set: that model, as long as it is still served by a company-billed source and not forbidden; otherwise learning falls back to the cheapest one.
//   company: pk of the workspace, sk `LESSONSET#MODEL`  (`provider`, `modelId`, `updatedAt`; the person who set it is in the audit event, not here)
// The sort key starts with `LESSONSET`, which the workspace erase already wipes. A write is conditional on the value the caller read, is audited (`lesson.model_set`, required: no ledger entry, no change), and
// is refused unless the model is one the company can use for learning right now (company-billed source, not forbidden). Nothing here calls a model.
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { canonicalModelName, teamRecordPk, type ModelIdentifier, type OrgId } from "@agentx/contracts";
import { errorName } from "../agents/table-writes.js";
import { customerProviderRouting } from "../model-sources/diagnosis-provider.js";
import { servableModels, type RoutingDependencies } from "../model-sources/routing.js";
import type { TeamRecordTable } from "../team-record/types.js";
import type { LessonAuditSink } from "./ports.js";

const SK = "LESSONSET#MODEL";
const keyOf = (orgId: OrgId) => ({ pk: teamRecordPk(orgId, undefined), sk: SK });
const SAFE = /^[A-Za-z0-9:_\-./@]{1,128}$/u;
export const modelWord = (model: ModelIdentifier | undefined): string => (model === undefined ? "default" : `${model.provider}/${model.modelId}`);

/** The company's lessons model, or undefined (the default). A stored value that does not parse is read as unset (the cheapest model is used), never as a way round the forbidden list. */
export async function readLessonsModel(table: TeamRecordTable, orgId: OrgId): Promise<ModelIdentifier | undefined> {
  const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: keyOf(orgId), ConsistentRead: true }))) as { Item?: { provider?: unknown; modelId?: unknown } }).Item;
  if (item === undefined || typeof item.provider !== "string" || typeof item.modelId !== "string") return undefined;
  return SAFE.test(item.provider) && SAFE.test(item.modelId) ? { provider: item.provider, modelId: item.modelId } : undefined;
}

/** The models the company can choose for learning: served by one of its company-billed sources (never a person's ChatGPT plan), and not forbidden. */
export async function allowedModels(deps: Pick<LessonsModelDeps, "routing" | "forbidden">, orgId: OrgId): Promise<ModelIdentifier[]> {
  const own = customerProviderRouting(deps.routing);
  if (own === undefined) return [];
  return (await servableModels(own, orgId)).filter((model) => !deps.forbidden(model));
}

export type LessonsModelFailure = "not_allowed" | "stale" | "audit_unavailable";
export interface LessonsModelDeps {
  table: TeamRecordTable;
  /** The company-billed routing (`customerProviderRouting` is applied inside) and the forbidden matcher, both read now by the caller. */
  routing: RoutingDependencies;
  forbidden: (model: ModelIdentifier) => boolean;
  audit: LessonAuditSink;
  now: () => number;
}

/**
 * Sets (a model) or clears (undefined) the lessons model. `expected` is the value the caller read (the write is conditional on it). A model the company cannot use for learning now is `not_allowed`.
 * The audit event is written first and is required: if the ledger cannot take it, nothing changes.
 */
export async function setLessonsModel(deps: LessonsModelDeps, input: { orgId: OrgId; by: string; model: ModelIdentifier | undefined; expected: ModelIdentifier | undefined }): Promise<{ ok: true } | { ok: false; failure: LessonsModelFailure }> {
  if (input.model !== undefined) {
    if (!SAFE.test(input.model.provider) || !SAFE.test(input.model.modelId)) return { ok: false, failure: "not_allowed" };
    if (!(await allowedModels(deps, input.orgId)).some((model) => canonicalModelName(model) === canonicalModelName(input.model!))) return { ok: false, failure: "not_allowed" };
  }
  const current = await readLessonsModel(deps.table, input.orgId);
  if (modelWord(current) !== modelWord(input.expected)) return { ok: false, failure: "stale" };
  try {
    await deps.audit.emit({ action: "lesson.model_set", workspaceId: input.orgId, project: "_workspace", actor: input.by, facts: { from: modelWord(current), to: modelWord(input.model) } }, { required: true });
  } catch { return { ok: false, failure: "audit_unavailable" }; }
  try {
    if (input.model === undefined) {
      await deps.table.documentClient.send(new DeleteCommand({ TableName: deps.table.tableName, Key: keyOf(input.orgId) }));
    } else {
      await deps.table.documentClient.send(new PutCommand({
        TableName: deps.table.tableName, Item: { ...keyOf(input.orgId), entityType: "LESSON_MODEL_SETTING", provider: input.model.provider, modelId: input.model.modelId, updatedAt: deps.now() },
        ...(current === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "provider = :p AND modelId = :m", ExpressionAttributeValues: { ":p": current.provider, ":m": current.modelId } }),
      }));
    }
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return { ok: false, failure: "stale" };
    throw error;
  }
  return { ok: true };
}
