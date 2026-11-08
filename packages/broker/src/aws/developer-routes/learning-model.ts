// Lessons in production, lane 1b: the company's "lessons model" setting, `/v1/app/org/learning-model` (the model its lesson learning runs on; unset = the cheapest suitable company-billed model).
//   GET   an owner or admin: { model: { provider, modelId } | null, candidates: [...] }, the models the company can choose (company-billed, not forbidden).
//   POST  from a live browser session only, an owner or admin; audited (`lesson.model_set`), never silent:
//           { action: "set", model: { provider, modelId }, expected: { provider, modelId } | null }
//           { action: "clear", expected: { provider, modelId } | null }
// A model that is not served by a company-billed source or is forbidden is refused. The route answers `undefined` (not found) where the install has no lessons ports.
import { z } from "zod";
import { agentXError, forbiddenModelMatcher } from "@agentx/contracts";
import { readGuardrails } from "../../agents/guardrails.js";
import { allowedModels, readLessonsModel, setLessonsModel, type LessonsModelDeps } from "../../lessons/model-setting.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const LEARNING_MODEL_PATH = "/v1/app/org/learning-model";
export const LEARNING_MODEL_BROWSER_MESSAGE = "Use a live browser session to change the model lessons run on.";

const Ref = z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict();
const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), model: Ref, expected: Ref.nullable() }).strict(),
  z.object({ action: z.literal("clear"), expected: Ref.nullable() }).strict(),
]);

const isAdmin = (caller: DeveloperCaller): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";

export async function routeLearningModel(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<StatusReply | undefined> {
  const table = deps.teamRecord === undefined ? undefined : (deps.teamRecord as { table?: LessonsModelDeps["table"] }).table;
  if (url.pathname !== LEARNING_MODEL_PATH || deps.lessons === undefined || table === undefined) return undefined;
  if (!isAdmin(caller)) throw agentXError("FORBIDDEN", "Only a company owner or admin can see or change this.");
  const forbidden = forbiddenModelMatcher((await readGuardrails({ documentClient: deps.documentClient, tableName: deps.tableName }, caller.orgId)).forbiddenModels);
  const modelDeps: LessonsModelDeps = { table, routing: deps.agents?.modelRouting ?? {}, forbidden, audit: deps.lessons.audit, now: deps.now };
  if (request.method === "GET") {
    const [model, candidates] = await Promise.all([readLessonsModel(table, caller.orgId), allowedModels(modelDeps, caller.orgId)]);
    return new StatusReply(200, { model: model ?? null, candidates: candidates.slice(0, 200).map((candidate) => ({ provider: candidate.provider, modelId: candidate.modelId })) });
  }
  if (request.method !== "POST") return undefined;
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", LEARNING_MODEL_BROWSER_MESSAGE);
  const parsed = BodySchema.safeParse(jsonBody(request));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "That is not a valid change.");
  const body = parsed.data;
  const result = await setLessonsModel(modelDeps, { orgId: caller.orgId, by: caller.developerId, model: body.action === "set" ? body.model : undefined, expected: body.expected ?? undefined });
  if (result.ok) return new StatusReply(200, { status: "applied", model: body.action === "set" ? body.model : null });
  switch (result.failure) {
    case "not_allowed": throw agentXError("CONFIG_INVALID", "Lessons can run only on a model from one of your company's AI providers that is not forbidden.");
    case "audit_unavailable": throw agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
    default: throw agentXError("CHANGE_STALE", "This setting changed. Reload and try again.");
  }
}
