import { ScriptTokenMetadataListSchema, CreatedScriptTokenMetadataSchema, RevokedScriptTokenMetadataSchema, type CreateScriptTokenBody } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

const path = "/v1/app/script-tokens";
export function createScriptTokenApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  list: () => api.get(path, ScriptTokenMetadataListSchema, undefined, { retry: "never" }),
  // Never use a query or mutation cache for this answer, and never retry a show-once creation.
  create: (body: CreateScriptTokenBody) => api.sendAnswer("POST", path, body, CreatedScriptTokenMetadataSchema, { retry: "never" }),
  revoke: (tokenId: string) => api.sendAnswer("POST", `${path}/${encodeURIComponent(tokenId)}/revoke`, undefined, RevokedScriptTokenMetadataSchema, { retry: "never" }),
 };
}
export function scriptTokenError(error: unknown, action: "load" | "create" | "revoke"): string {
 if (error instanceof ApiError) {
  if (error.status === 501 || error.status === 404 && error.code === "NOT_FOUND" && error.message === "route not found") return "Automation keys are not available yet.";
  if (error.status === 404 && action === "create") return "One of those projects wasn't found, or you can't use it.";
  if (error.status === 404) return "That automation key doesn't exist, or you can't manage it.";
  if (error.status === 409 && action === "create") return "You may have reached the limit of automation keys. Revoke one you no longer need, then try again.";
  if (error.status === 429) return "Too many automation key requests. Wait a moment, then try again.";
  if (error.status === 403) return "You can't manage these automation keys.";
 }
 return action === "load" ? "Couldn't load automation keys. Try again." : action === "create" ? "Couldn't create the automation key. Try again." : "Couldn't revoke the automation key. Try again.";
}
