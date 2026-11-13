// Web intake, deterministic fallback (DEC 173). No model, keys, spend or task start on this path.
// The existing metered completion is lessons-only; do not disguise intake as a learning call.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, projectPk, smallTalkOf, type RequestRouteKind } from "@rovara-code/contracts";
import { CODE_SUGGESTION_UNAVAILABLE, CodeSuggestionBodySchema, CodeSuggestionSchema, type CodeSuggestion } from "@agentx/cloud-contracts";
// Code's helper is not exported by its intake barrel at this pin. Consume the built module; never fork the guard or edit vendor.
import { quickAutoStartRefusal, quickAutoStartText } from "../../../../vendor/rovara-code/packages/broker/dist/core/intake/quick-auto-start.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes/types.js";
import { projectRoleForRoute } from "../aws/developer-routes/project-members.js";
import { requireNewWorkAllowed } from "../developer/project-roles.js";

export const CODE_SUGGEST_PATH = /^\/v1\/app\/projects\/([^/]+)\/code\/suggest$/;
const RETENTION_SECONDS = 86_400;
const CHANGE_WORD = /\b(?:add|change|fix|update|build|create|implement|rename|replace|refactor|migrat\w*|rewrit\w*|redesign|delet\w*|remov\w*)\b/iu;

/** Exhaustive over Code's kinds: a future pin adding a kind must fail the build here. The guard only raises caution. */
export function codeSuggestionForKind(kind: RequestRouteKind, text: string): CodeSuggestion {
  switch (kind) {
    case "question": return { path: "answer", reason: "question", source: "wording" };
    case "small_change": return quickAutoStartRefusal(text) === undefined
      ? { path: "quick", reason: "small_change", source: "wording" }
      : { path: "full", reason: "large_change", source: "wording" };
    case "large_change": return { path: "full", reason: "large_change", source: "wording" };
    case "unclear": return CODE_SUGGESTION_UNAVAILABLE;
    default: { const exhaustive: never = kind;return exhaustive; }
  }
}
function fromWording(text: string): CodeSuggestion {
  if (smallTalkOf(text) !== undefined) return codeSuggestionForKind("question", text);
  if (quickAutoStartRefusal(text) === undefined) return codeSuggestionForKind("small_change", text);
  return codeSuggestionForKind(CHANGE_WORD.test(quickAutoStartText(text)) ? "large_change" : "unclear", text);
}

/** Live start authority precedes validation and every replay. Failures of the informational store never block a manual start. */
export async function routeCodeSuggestion(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawProject: string, body: unknown): Promise<CodeSuggestion> {
  if (deps.agents === undefined) throw agentXError("NOT_FOUND", "starting work is not set up in this deployment");
  const project = await projectRoleForRoute(deps, caller, rawProject);
  await requireNewWorkAllowed(deps, caller.orgId, project.name, project.role, "task");
  const parsed = CodeSuggestionBodySchema.safeParse(body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "A suggestion needs a request ID and text of 1 to 4000 characters.");
  const { text, requestId } = parsed.data;
  const key = { pk: projectPk(caller.orgId, project.name), sk: `CODE_SUGGEST#${caller.developerId}#${requestId}` };
  const fingerprint = createHash("sha256").update(text, "utf8").digest("hex");
  const now = Math.floor(deps.now() / 1000);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let earlier: Record<string, unknown> | undefined;
    try {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
      earlier = response.Item;
    } catch { return CODE_SUGGESTION_UNAVAILABLE; }
    if (earlier !== undefined && typeof earlier[INDEX_EXPIRY_ATTRIBUTE] === "number" && earlier[INDEX_EXPIRY_ATTRIBUTE] > now) {
      if (earlier["orgId"] !== caller.orgId || earlier["project"] !== project.name) return CODE_SUGGESTION_UNAVAILABLE;
      if (earlier["fingerprint"] !== fingerprint) throw agentXError("IDEMPOTENCY_CONFLICT", "That suggestion request was already sent with different text.");
      const saved = CodeSuggestionSchema.safeParse(earlier["suggestion"]);
      return saved.success ? saved.data : CODE_SUGGESTION_UNAVAILABLE;
    }
    const suggestion = fromWording(text);
    try {
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName,
        Item: { ...key, entityType: "CODE_SUGGESTION", orgId: caller.orgId, project: project.name, fingerprint, suggestion, [INDEX_EXPIRY_ATTRIBUTE]: now + RETENTION_SECONDS },
        ConditionExpression: "attribute_not_exists(pk) OR #expiry <= :now",
        ExpressionAttributeNames: { "#expiry": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":now": now },
      }));
      return suggestion;
    } catch (error) {
      if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) return CODE_SUGGESTION_UNAVAILABLE;
      // A concurrent request won. Read its committed answer; a bounded lost race returns unavailable, never guesses.
    }
  }
  return CODE_SUGGESTION_UNAVAILABLE;
}
