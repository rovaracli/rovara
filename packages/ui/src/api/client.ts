import { PendingAdminApprovalReaderSchema, PendingConfirmationReaderSchema, type SoleOwnerConfirmationSchema } from "@agentx/contracts/web";
import type { z } from "zod";
import type { ApiMethod, ApiRequest, ApiResponse, AppHost } from "../host.js";
import { RETRY_DELAYS_MS } from "../constants.js";
import { isConfirmUrl } from "../text/links.js";
import { ApiError, apiError } from "./errors.js";
/** The shared confirmation metadata a 202 may carry (the company policy save uses it); absent on ordinary confirmations. */
export type SoleOwnerConfirmation = z.infer<typeof SoleOwnerConfirmationSchema>;
export interface Reader<T> { parse(value: unknown): T }
export type SendResult<T> = { kind: "done"; value: T } | { kind: "needs_confirmation"; confirmUrl?: string; changes: string[]; soleOwner?: SoleOwnerConfirmation } | { kind: "needs_admin_approval"; spendRequestId: string; message: string };
const idempotent = (body: unknown) => typeof body === "object" && body !== null && "requestId" in body && typeof body.requestId === "string" && body.requestId !== "";
const retryDelay = (attempt: number) => RETRY_DELAYS_MS[attempt]! * (1 + Math.random() * 0.3);
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
const redirectedHosts = new WeakSet<AppHost>();
export function createApiClient(host: AppHost) {
 async function request(input: ApiRequest): Promise<ApiResponse> {
  const readRequest = input.method === "GET" || input.method === "HEAD";
  const retry = input.retry !== "never" && (readRequest || idempotent(input.body));
  for (let attempt = 0;; attempt++) {
   let response: ApiResponse;
   try { response = await host.transport.request(input); }
   catch (error) {
    if (error instanceof ApiError) { if (error.code === "AUTH_REQUIRED" && !redirectedHosts.has(host)) { redirectedHosts.add(host);host.signIn(host.currentPath(), { automatic: true }); }throw error; }
    if (retry && attempt < RETRY_DELAYS_MS.length) { await sleep(retryDelay(attempt));continue; }
    throw new ApiError(0, "NETWORK_ERROR", "Couldn't reach Rovara. Check your connection and try again.");
   }
   if (response.status === 429 && retry && attempt < RETRY_DELAYS_MS.length) { await sleep(retryDelay(attempt));continue; }
   if (response.status >= 500 && response.status <= 599 && readRequest && retry && attempt < 2) { await sleep(retryDelay(attempt));continue; }
   if (response.status < 200 || response.status >= 300) {
    const error = apiError(response.status, response.body, host.origin);
    if ((error.code === "AUTH_REQUIRED" || response.status === 401) && !redirectedHosts.has(host)) { redirectedHosts.add(host);host.signIn(host.currentPath(), { automatic: true }); }
    throw error;
   }
   return response;
  }
 }
 function read<T>(body: unknown, schema: Reader<T>): T { try { return schema.parse(body); } catch { throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page."); } }
 return {
  async get<T>(path: string, schema: Reader<T>, headers?: Record<string, string>, options?: { retry: "never" }): Promise<T> { return read((await request({ method: "GET", path, ...(headers === undefined ? {} : { headers }), ...options })).body, schema); },
  async send<T>(method: Exclude<ApiMethod, "GET" | "HEAD">, path: string, body: unknown, schema: Reader<T>, options?: { retry: "never" }): Promise<SendResult<T>> {
   const response = await request({ method, path, body, ...options });
   if (response.status === 202) {
    const confirmation = PendingConfirmationReaderSchema.safeParse(response.body);
    if (confirmation.success && (confirmation.data.status === "NEEDS_CONFIRMATION" || confirmation.data.status === "NEEDS_OWNER_APPROVAL")) return { kind: "needs_confirmation", changes: confirmation.data.changes, ...(confirmation.data.soleOwner === undefined ? {} : { soleOwner: confirmation.data.soleOwner }), ...(confirmation.data.confirmUrl !== undefined && isConfirmUrl(confirmation.data.confirmUrl, host.origin) ? { confirmUrl: confirmation.data.confirmUrl } : {}) };
    const admin = PendingAdminApprovalReaderSchema.safeParse(response.body);
    if (admin.success && admin.data.status === "NEEDS_ADMIN_APPROVAL") return { kind: "needs_admin_approval", spendRequestId: admin.data.spendRequestId, message: admin.data.message };
    if (typeof response.body === "object" && response.body !== null && "status" in response.body) throw new ApiError(502, "INVALID_RESPONSE", "This request is still pending. Reload to check its status.");
   }
   return { kind: "done", value: read(response.body, schema) };
  },
 };
}
