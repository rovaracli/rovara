// Web intake, deterministic fallback (DEC 173). No model, keys, spend or task start on this path.
// The existing metered completion is lessons-only; do not disguise intake as a learning call.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, orgPk, projectPk, smallTalkOf, type RequestRouteKind } from "@rovara-code/contracts";
import { CODE_SUGGESTION_UNAVAILABLE, CodeSuggestionBodySchema, CodeSuggestionSchema, type CodeSuggestion } from "@agentx/cloud-contracts";
import { quickAutoStartRefusal, quickAutoStartText } from "../decisions/quick-auto-start.js";
import { z } from "zod";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes/types.js";
import { projectRoleForRoute } from "../aws/developer-routes/project-members.js";
import { requireNewWorkAllowed } from "../developer/project-roles.js";

export const CODE_SUGGEST_PATH = /^\/v1\/app\/projects\/([^/]+)\/code\/suggest$/;
const RETENTION_SECONDS = 86_400;
const WINDOW_SECONDS = 600;
const SUGGESTION_LIMIT = 30;
// Informational, company/person-scoped allowance: no provider call or money is admitted here.
const RateSchema = z.object({
  orgId: z.string(), developerId: z.string(), revision: z.number().int().nonnegative().safe(),
  windowStart: z.number().int().nonnegative().safe(), count: z.number().int().min(1).max(SUGGESTION_LIMIT),
  lastSuggestion: CodeSuggestionSchema,
});
const QUESTION = /(?:[?？]|^(?:how|why|what|where|when|who|which|explain|describe|tell\s+me|show\s+me)\b|^(?:can|could|would)\s+you\s+(?:explain|describe|tell|show)\b|^(?:is|are|does|do|did|has|have|will|should)\b)/iu;
const CHANGE_WORD = /\b(?:add|change|fix|update|build|create|implement|rename|replace|refactor|migrat\w*|rewrit\w*|redesign|delet\w*|remov\w*)\b/iu;

/** Exhaustive over Code's kinds: a future pin adding a kind must fail the build here. The guard only raises caution. */
export function codeSuggestionForKind(kind: RequestRouteKind, text: string): CodeSuggestion {
  switch (kind) {
    case "question": return { path: "answer", reason: "question", source: "wording" };
    case "small_change": return quickAutoStartRefusal(text) === undefined
      ? { path: "quick", reason: "small_change", source: "wording" }
      : { path: "full", reason: "large_change", source: "wording" };
    case "large_change": return { path: "full", reason: "large_change", source: "wording" };
    case "unclear": return { path: "answer", reason: "unclear", source: "wording" };
    default: { const exhaustive: never = kind;return exhaustive; }
  }
}
function fromWording(text: string): CodeSuggestion {
  if (smallTalkOf(text) !== undefined) return codeSuggestionForKind("question", text);
  const words = quickAutoStartText(text);
  if (QUESTION.test(words)) return codeSuggestionForKind("question", text);
  if (!CHANGE_WORD.test(words)) return codeSuggestionForKind("unclear", text);
  return codeSuggestionForKind("small_change", text);
}

/** Live start authority precedes validation and every replay. Failures of the informational store never block a manual start. */
export async function routeCodeSuggestion(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawProject: string, body: unknown): Promise<CodeSuggestion> {
  if (deps.agents === undefined) throw agentXError("NOT_FOUND", "starting work is not set up in this deployment");
  const project = await projectRoleForRoute(deps, caller, rawProject);
  await requireNewWorkAllowed(deps, caller.orgId, project.name, project.role, "task");
  const parsed = CodeSuggestionBodySchema.safeParse(body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "A suggestion needs a request ID and text of 1 to 4000 characters.");
  const { text, requestId } = parsed.data;
  const fingerprint = createHash("sha256").update(text, "utf8").digest("hex");
  const pk = projectPk(caller.orgId, project.name);
  const key = { pk, sk: `CODE_SUGGEST_TEXT#${fingerprint}` };
  const rateKey = { pk: orgPk(caller.orgId), sk: `CODE_SUGGEST_RATE#${caller.developerId}` };
  const now = Math.floor(deps.now() / 1000);
  const read = async (Key: { pk: string; sk: string }) => {
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    return response.Item;
  };
  const saved = (item: Record<string, unknown> | undefined): CodeSuggestion | undefined => {
    if (item === undefined || typeof item[INDEX_EXPIRY_ATTRIBUTE] !== "number" || item[INDEX_EXPIRY_ATTRIBUTE] <= now) return undefined;
    if (item["orgId"] !== caller.orgId || item["project"] !== project.name || item["fingerprint"] !== fingerprint) return CODE_SUGGESTION_UNAVAILABLE;
    const result = CodeSuggestionSchema.safeParse(item["suggestion"]);
    return result.success ? result.data : CODE_SUGGESTION_UNAVAILABLE;
  };
  // Keep the original writer's request-id records readable until their TTL. New records use text identity,
  // so a new browser UUID for unchanged text neither writes another cache entry nor consumes allowance.
  try {
    const legacy = await read({ pk, sk: `CODE_SUGGEST#${caller.developerId}#${requestId}` });
    if (legacy !== undefined && typeof legacy[INDEX_EXPIRY_ATTRIBUTE] === "number" && legacy[INDEX_EXPIRY_ATTRIBUTE] > now) {
      if (legacy["orgId"] === caller.orgId && legacy["project"] === project.name && legacy["fingerprint"] !== fingerprint) throw agentXError("IDEMPOTENCY_CONFLICT", "That suggestion request was already sent with different text.");
      return saved(legacy) ?? CODE_SUGGESTION_UNAVAILABLE;
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "IDEMPOTENCY_CONFLICT") throw error;
    return CODE_SUGGESTION_UNAVAILABLE;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const cached = saved(await read(key));
      if (cached !== undefined) return cached;
      const earlier = await read(rateKey);
      const parsedRate = earlier === undefined ? undefined : RateSchema.safeParse(earlier);
      if (parsedRate !== undefined && (!parsedRate.success || parsedRate.data.orgId !== caller.orgId || parsedRate.data.developerId !== caller.developerId)) return CODE_SUGGESTION_UNAVAILABLE;
      const rate = parsedRate?.success === true ? parsedRate.data : undefined;
      const active = rate !== undefined && rate.windowStart + WINDOW_SECONDS > now;
      if (active && rate.count >= SUGGESTION_LIMIT) return { ...rate.lastSuggestion, source: "previous_wording" };
      const suggestion = fromWording(text);
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: {
          TableName: deps.tableName,
          Item: { ...key, entityType: "CODE_SUGGESTION", orgId: caller.orgId, project: project.name, fingerprint, suggestion, [INDEX_EXPIRY_ATTRIBUTE]: now + RETENTION_SECONDS },
          ConditionExpression: "attribute_not_exists(pk) OR #expiry <= :now",
          ExpressionAttributeNames: { "#expiry": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":now": now },
        } },
        { Put: {
          TableName: deps.tableName,
          Item: { ...rateKey, entityType: "CODE_SUGGESTION_RATE", orgId: caller.orgId, developerId: caller.developerId, revision: (rate?.revision ?? 0) + 1,
            windowStart: active ? rate.windowStart : now, count: active ? rate.count + 1 : 1, lastSuggestion: suggestion, [INDEX_EXPIRY_ATTRIBUTE]: now + RETENTION_SECONDS },
          ...(rate === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : {
            ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": rate.revision },
          }),
        } },
      ] }));
      return suggestion;
    } catch (error) {
      if (!(error instanceof Error && error.name === "TransactionCanceledException")) return CODE_SUGGESTION_UNAVAILABLE;
      // A concurrent request won. Re-read cache and allowance; never overwrite either after a stale read.
    }
  }
  return CODE_SUGGESTION_UNAVAILABLE;
}
