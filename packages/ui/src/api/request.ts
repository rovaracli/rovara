import { logResponseShapeFailure } from "./response-shape.js";
import type { ApiRequest, ApiResponse, AppHost } from "../host.js";
import { RETRY_DELAYS_MS } from "../constants.js";
import { ApiError, apiError } from "./errors.js";
import { accessEndedCode } from "./served-read.js";
import type { Reader } from "./client.js";
const idempotent = (body: unknown) => typeof body === "object" && body !== null && "requestId" in body && typeof body.requestId === "string" && body.requestId !== "";
const retryDelay = (attempt: number) => RETRY_DELAYS_MS[attempt]! * (1 + Math.random() * 0.3);
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
const redirectedHosts = new WeakSet<AppHost>();
export function createRequest(host: AppHost) {
 return async function request(input: ApiRequest): Promise<ApiResponse> {
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
 };
}
export function readResponse<T>(body: unknown, schema: Reader<T>): T {
  try { return schema.parse(body); } catch (error) {
   logResponseShapeFailure(error);
   throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page.");
  }
 }
