import { ApiErrorResponseReaderSchema } from "@agentx/contracts/web";
import { isConfirmUrl, safeExternalUrl } from "../text/links.js";
export class ApiError extends Error {
 constructor(readonly status: number, readonly code: string, message: string, readonly signInUrl?: string, readonly confirmUrl?: string, /** Lane C's process-model refusal (409 `{code, stage, fixHref}`): the stage and the page that fixes it. */ readonly refusal?: { stage: string; fixHref?: string }) { super(message);this.name = "ApiError"; }
}
function safeSignInUrl(value: string | undefined, origin: string): string | undefined {
 if (value === undefined || /[\p{Cc}\p{Cf}\\]|%2e|%2f|%5c/iu.test(value.split("?", 1)[0]!)) return undefined;
 try { const url = new URL(value, origin);return safeExternalUrl(url.href) !== undefined && url.origin === new URL(origin).origin && /^\/v1\/auth\/(?:browser\/authorize|decide\/(?:start|identify))$/.test(url.pathname) && !url.hash ? url.href : undefined; } catch { return undefined; }
}
export function apiError(status: number, body: unknown, origin: string): ApiError {
 const parsed = ApiErrorResponseReaderSchema.safeParse(body);
 if (parsed.success) {
  const error = parsed.data.error;
  const stage = (error as { stage?: unknown }).stage, fixHref = (error as { fixHref?: unknown }).fixHref;
  return new ApiError(status, /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : "REQUEST_FAILED", error.message.slice(0, 2000), safeSignInUrl(error.signInUrl, origin), error.confirmUrl !== undefined && isConfirmUrl(error.confirmUrl, origin) ? error.confirmUrl : undefined, typeof stage === "string" && /^[a-z_]{2,40}$/.test(stage) ? { stage, ...(typeof fixHref === "string" ? { fixHref } : {}) } : undefined);
 }
 return new ApiError(status, "REQUEST_FAILED", status === 401 ? "Sign in to continue." : status === 404 ? "This item wasn't found, or you no longer have access." : "Rovara couldn't complete this request. Try again shortly.");
}
