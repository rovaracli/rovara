import { logResponseShapeFailure } from "./response-shape.js";
import { PendingAdminApprovalReaderSchema, PendingConfirmationReaderSchema, type SoleOwnerConfirmationSchema } from "@agentx/contracts/web";
import type { z } from "zod";
import type { ApiMethod, ApiRequest, ApiResponse, AppHost } from "../host.js";
import { RETRY_DELAYS_MS } from "../constants.js";
import { isConfirmUrl } from "../text/links.js";
import { ApiError, apiError, actionErrorRoutes } from "./errors.js";
import { accessEndedCode } from "./served-read.js";
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
   // Access ends even at 2xx/5xx and even with a malformed error envelope. Preserve that signal before retries or schema parsing.
   const accessCode = readRequest ? accessEndedCode(response.body) : undefined;
   if (accessCode !== undefined) {
    if ((accessCode === "AUTH_REQUIRED" || accessCode === "SESSION_EXPIRED") && !redirectedHosts.has(host)) { redirectedHosts.add(host);host.signIn(host.currentPath(), { automatic: true }); }
    const error = apiError(response.status, response.body, host.origin);
    throw error.code === accessCode ? error : new ApiError(response.status, accessCode, "This information is no longer available to you.");
   }
   if (response.status === 429 && retry && attempt < RETRY_DELAYS_MS.length) { await sleep(retryDelay(attempt));continue; }
   // A 501 (NOT_ON_CODE_YET) is Cloud saying the route is not on Rovara Code yet: that does not change in a few seconds, so it is not retried and the screen says so at once.
   if (response.status >= 500 && response.status <= 599 && response.status !== 501 && readRequest && retry && attempt < 2) { await sleep(retryDelay(attempt));continue; }
   if (response.status < 200 || response.status >= 300) {
    const error = apiError(response.status, response.body, host.origin);
    if ((error.code === "AUTH_REQUIRED" || response.status === 401) && !redirectedHosts.has(host)) { redirectedHosts.add(host);host.signIn(host.currentPath(), { automatic: true }); }
    throw error;
   }
   return response;
  }
 }
 function read<T>(body: unknown, schema: Reader<T>): T {
  try { return schema.parse(body); } catch (error) {
   logResponseShapeFailure(error);
   throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page.");
  }
 }
 return {
  async get<T>(path: string, schema: Reader<T>, headers?: Record<string, string>, options?: { retry: "never" }): Promise<T> { return read((await request({ method: "GET", path, ...(headers === undefined ? {} : { headers }), ...options })).body, schema); },
  async send<T>(method: Exclude<ApiMethod, "GET" | "HEAD">, path: string, body: unknown, schema: Reader<T>, options?: { retry: "never"; pendingIsUnknown?: boolean; /** Decision actions only: a 202 confirmation request is handed back for the confirm link / merge prompt (its frozen request stays locked); any other 202 stays unknown. */ confirmationIsPending?: boolean }): Promise<SendResult<T>> {
   try {
   const response = await request({ method, path, body, ...(options?.retry === undefined ? {} : { retry: options.retry }) });
   if (response.status === 202) {
    // A decision approval has no served receipt reader. Even an outcome-shaped body cannot
    // turn an accepted response into a final decision or release its frozen request lock.
    // The one 202 that passes through is a confirmation request (contract: decision-card-tabs.ts "202: the existing endpoint did not decide; the person decides on its
    // confirmation page"): the caller keeps its frozen request and shows the merge prompt or the confirm link. Any other 202 stays unknown.
    if (options?.pendingIsUnknown === true) {
     // Only decision sends need this reader; its module also builds the lazy cards' schemas.
     const { DecisionOutcomeReaderSchema } = await import("./decision-outcome-reader.js");
     const confirmsLater = (DecisionOutcomeReaderSchema.safeParse(response.body).data?.outcome === "needs_confirmation") || PendingConfirmationReaderSchema.safeParse(response.body).success || PendingAdminApprovalReaderSchema.safeParse(response.body).success;
     if (!(options.confirmationIsPending === true && confirmsLater)) throw new ApiError(409, "APPROVAL_UNKNOWN", "Rovara didn't confirm this yet. Check this decision before trying again.");
    }
    const confirmation = PendingConfirmationReaderSchema.safeParse(response.body);
    if (confirmation.success && (confirmation.data.status === "NEEDS_CONFIRMATION" || confirmation.data.status === "NEEDS_OWNER_APPROVAL")) return { kind: "needs_confirmation", changes: confirmation.data.changes, ...(confirmation.data.soleOwner === undefined ? {} : { soleOwner: confirmation.data.soleOwner }), ...(confirmation.data.confirmUrl !== undefined && isConfirmUrl(confirmation.data.confirmUrl, host.origin) ? { confirmUrl: confirmation.data.confirmUrl } : {}) };
    const admin = PendingAdminApprovalReaderSchema.safeParse(response.body);
    if (admin.success && admin.data.status === "NEEDS_ADMIN_APPROVAL") return { kind: "needs_admin_approval", spendRequestId: admin.data.spendRequestId, message: admin.data.message };
    if (typeof response.body === "object" && response.body !== null && "status" in response.body) throw new ApiError(502, "INVALID_RESPONSE", "This request is still pending. Reload to check its status.");
   }
   return { kind: "done", value: read(response.body, schema) };
   } catch (failure) { actionErrorRoutes.set(failure as ApiError, path);throw failure; }
  },
  /**
   * A request whose answer is its own body at any 2xx, a 202 included (the setup draft's start answers 202 with the draft's status). It never reads a 202 as a confirmation,
   * so use it only for a route that cannot ask for one.
   */
  async sendAnswer<T>(method: Exclude<ApiMethod, "GET" | "HEAD">, path: string, body: unknown, schema: Reader<T>, options?: { retry: "never" }): Promise<T> {
   try { return read((await request({ method, path, body, ...options })).body, schema); }
   catch (failure) { actionErrorRoutes.set(failure as ApiError, path);throw failure; }
  },
 };
}
