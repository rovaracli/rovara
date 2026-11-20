// Cloud mirrors Code's app script-token routes. Code alone decides authorization and keeps the token records.
// Responses are projected field by field: list/revoke can never carry a secret, and refusals never echo Code text.
import { isCodeOutcomeUnknown, CodeError, SignInEnded } from "./code-client.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const name = (v: unknown): v is string => typeof v === "string" && v === v.trim() && [...v].length >= 1 && [...v].length <= 60 && !/[\p{Cc}\p{Cf}]/u.test(v);
const project = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9-]{0,62}$/u.test(v);
const id = (v: unknown): v is string => typeof v === "string" && /^stk_[0-9a-z]{20}$/u.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(v) && Number.isFinite(Date.parse(v));
const list = (v: unknown, max: number, check: (x: unknown) => boolean): v is unknown[] => Array.isArray(v) && v.length <= max && v.every(check);
const permission = (v: unknown) => ["read", "start", "lessons", "wiki"].includes(v as string);
const fail = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
const invalid = () => fail(400, "CONFIG_INVALID", "That automation key request isn't valid.");
const unreadable = () => fail(502, "RUNTIME_UNAVAILABLE", "Rovara Code sent an automation key answer Cloud couldn't read.");

function metadata(raw: unknown): Obj | undefined {
 if (!obj(raw) || !id(raw["tokenId"]) || !name(raw["name"]) || typeof raw["hint"] !== "string" || !/^rvst_…[0-9a-z]{8}$/u.test(raw["hint"])
  || !list(raw["projects"], 20, project) || !list(raw["permissions"], 4, permission) || !instant(raw["createdAt"]) || !instant(raw["expiresAt"])
  || !["active", "expired", "revoked"].includes(raw["status"] as string) || typeof raw["mine"] !== "boolean"
  || raw["lastUsedAt"] !== undefined && !instant(raw["lastUsedAt"]) || raw["revokedAt"] !== undefined && !instant(raw["revokedAt"])
  || raw["createdBy"] !== undefined && !(typeof raw["createdBy"] === "string" && raw["createdBy"].length >= 1 && raw["createdBy"].length <= 200)) return undefined;
 return Object.fromEntries(["tokenId", "name", "hint", "projects", "permissions", "createdAt", "expiresAt", "lastUsedAt", "revokedAt", "status", "mine", "createdBy"]
  .filter(key => raw[key] !== undefined).map(key => [key, raw[key]]));
}
function createBody(raw: unknown): Obj | undefined {
 if (!obj(raw) || Object.keys(raw).some(key => !["requestId", "name", "projects", "permissions", "days"].includes(key))
  || typeof raw["requestId"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(raw["requestId"])
  || typeof raw["name"] !== "string" || !name(raw["name"].trim()) || !list(raw["projects"], 20, project) || raw["projects"].length === 0
  || new Set(raw["projects"]).size !== raw["projects"].length || !list(raw["permissions"], 4, permission)
  || raw["permissions"].length === 0 || new Set(raw["permissions"]).size !== raw["permissions"].length
  || raw["days"] !== undefined && !(typeof raw["days"] === "number" && Number.isInteger(raw["days"]) && raw["days"] >= 1 && raw["days"] <= 90)) return undefined;
 return { requestId: raw["requestId"], name: raw["name"].trim(), projects: raw["projects"], permissions: raw["permissions"], ...(raw["days"] === undefined ? {} : { days: raw["days"] }) };
}
function refusal(error: unknown): RouteAnswer {
  if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
 if (error instanceof CodeError) {
  const e = obj(error.body) && obj(error.body["error"]) ? error.body["error"] : undefined;
  if (error.status === 501 || error.status === 404 && e?.["code"] === "NOT_FOUND" && e["message"] === "route not found") return fail(501, "NOT_ON_CODE_YET", "Automation keys are not available yet.");
  if (error.status === 403) return fail(403, "FORBIDDEN", "You can't manage these automation keys.");
  if (error.status === 404) return fail(404, "NOT_FOUND", "That automation key doesn't exist, or you can't manage it.");
  if (error.status === 409) return fail(409, "CONFLICT", "That automation key request couldn't be completed. Refresh the list before trying again.");
  if (error.status === 400) return invalid();
  if (error.status === 429) return fail(429, "RATE_LIMITED", "Too many automation key requests. Wait a moment, then try again.");
 }
 // Session expiry is handled by Cloud's existing sign-in redirect, without exposing the thrown error's text.
 if (error instanceof SignInEnded) throw error;
 return fail(503, "RUNTIME_UNAVAILABLE", "Couldn't finish that automation key request. Try again.");
}
async function answer(context: RouteContext, action: "list" | "create" | "revoke"): Promise<RouteAnswer> {
 let body: Obj | undefined;
 if (action === "create") {
  body = createBody(context.body); if (body === undefined) return invalid();
 }
 if (action === "revoke" && (!id(context.params[0]) || context.body !== undefined && !(obj(context.body) && Object.keys(context.body).length === 0))) return invalid();
 const path = `/v1/app/script-tokens${action === "revoke" ? `/${context.params[0]!}/revoke` : ""}`;
 try {
  const raw = await context.client.json<unknown>(context.session, path, action === "list" ? { method: "GET" } : { method: "POST", ...(body === undefined ? {} : { body }) });
  if (!obj(raw)) return unreadable();
  if (action === "list") {
   if (!Array.isArray(raw["tokens"]) || raw["tokens"].length > 1000 || raw["canCreate"] !== undefined && typeof raw["canCreate"] !== "boolean") return unreadable();
   const tokens = (raw["tokens"] as unknown[]).map(metadata);
   return tokens.some(token => token === undefined) ? unreadable() : { status: 200, body: { tokens, ...(raw["canCreate"] === undefined ? {} : { canCreate: raw["canCreate"] }) } };
  }
  const token = metadata(raw["token"]); if (token === undefined) return unreadable();
  if (action === "revoke") return { status: 200, body: { token } };
  const secret = raw["secret"];
  if (typeof secret !== "string" || !/^rvst_[0-9a-z]{20}_[0-9a-z]{20}_[A-Za-z0-9_-]{43}$/u.test(secret)) return unreadable();
  return { status: 201, body: { token, secret } };
 } catch (error) { return refusal(error); }
}
export const SCRIPT_TOKEN_ROUTES: Route[] = [
 { method: "GET", path: /^\/script-tokens$/u, answer: context => answer(context, "list") },
 { method: "POST", path: /^\/script-tokens$/u, answer: context => answer(context, "create") },
 { method: "POST", path: /^\/script-tokens\/(stk_[0-9a-z]{20})\/revoke$/u, answer: context => answer(context, "revoke") },
];
