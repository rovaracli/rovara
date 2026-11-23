import type { RealtimeTokenResponse } from "@agentx/contracts/web";
import { vi } from "vitest";
import type { AppHost, ApiRequest, ApiResponse } from "../../../packages/ui/src/host.js";
import { FakeSocket } from "./fake-socket.js";
export const USER_CHANNEL = "/rovara/o-aaaaaaaaaaaaaaaaaaaa/u/d-" + "a".repeat(40);
export const PROJECT_CHANNEL = "/rovara/o-aaaaaaaaaaaaaaaaaaaa/p/p-" + "b".repeat(40);
export const REALTIME_ENDPOINT = "wss://fixture.appsync-realtime-api.us-west-2.amazonaws.com/event/realtime";
/**
 * What HOSTED Code really answers today to the Close dialog's read of GET /v1/app/sessions/<id>/close?action=...: its core engine does not serve the DEV preview
 * path, so Cloud passes through Code's 404 NOT_FOUND "That is not on the core engine on this install yet." (reviewed at engine-boundary.ts:335). The dialog's read is
 * answered this way unless the test serves a newer Code on purpose (a 200 with a `preview` envelope, or an explicit `{ error }` body), so the many tests of the
 * legacy Close and Discard keep proving the path hosted tasks use today.
 */
const CLOSE_PREVIEW_READ = /^\/v1\/app\/sessions\/ses_[0-9a-z]{20}\/close\?action=(close|discard)$/u;
export const CLOSE_PREVIEW_NOT_SERVED: ApiResponse = { status: 404, body: { error: { code: "NOT_FOUND", message: "That is not on the core engine on this install yet." } } };
/** An older Code with no preview route at all: Cloud maps Code's "route not found" to this. */
export const CLOSE_PREVIEW_OLDER_CODE: ApiResponse = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "This Rovara Code can't show a Close preview yet." } } };
const servedOnPurpose = (answer: ApiResponse): boolean => typeof answer.body === "object" && answer.body !== null && ("preview" in answer.body || "error" in answer.body);
export function fakeHost(implementation: (request: ApiRequest) => Promise<ApiResponse> = async () => ({ status: 200, body: { notices: [], next: "settled" } })) {
 const request = vi.fn(async (input: ApiRequest): Promise<ApiResponse> => {
  const answer = await implementation(input);
  return input.method === "GET" && CLOSE_PREVIEW_READ.test(input.path) && !servedOnPurpose(answer) ? CLOSE_PREVIEW_NOT_SERVED : answer;
 }), storage = new Map<string, string>(), sockets: Array<{ socket: FakeSocket; url: string; protocols: string[] }> = [];
 const realtimeToken = vi.fn<() => Promise<RealtimeTokenResponse>>(async () => ({ token: "fixture-realtime-value", expiresAt: new Date(Date.now() + 900_000).toISOString(), endpoint: REALTIME_ENDPOINT, channels: { user: USER_CHANNEL, projects: { web: PROJECT_CHANNEL } } }));
 const host: AppHost = { viewport: { width: () => 1280, subscribe: () => () => undefined }, kind: "web", origin: "https://cell.example", transport: { request }, realtimeToken,
  currentPath: () => "/app/live", setTitle: vi.fn(), openSocket: (url, protocols) => { const socket = new FakeSocket();sockets.push({ socket, url, protocols });return socket; },
  openExternal: vi.fn(), navigate: vi.fn(), signIn: vi.fn(), signOut: vi.fn(async () => undefined), saveFile: vi.fn(), features: { admin: true }, storage: { get: key => storage.get(key), set: (key, value) => { storage.set(key, value); } },
 };
 return { host, request, storage, sockets, realtimeToken };
}
