import type { RealtimeTokenResponse } from "@agentx/cloud-contracts/web";
import { vi } from "vitest";
import type { AppHost, ApiRequest, ApiResponse } from "../../../packages/ui/src/host.js";
import { FakeSocket } from "./fake-socket.js";
export const USER_CHANNEL = "/rovara/o-aaaaaaaaaaaaaaaaaaaa/u/d-" + "a".repeat(40);
export const PROJECT_CHANNEL = "/rovara/o-aaaaaaaaaaaaaaaaaaaa/p/p-" + "b".repeat(40);
export const REALTIME_ENDPOINT = "wss://fixture.appsync-realtime-api.us-west-2.amazonaws.com/event/realtime";
export function fakeHost(implementation: (request: ApiRequest) => Promise<ApiResponse> = async () => ({ status: 200, body: { notices: [], next: "settled" } })) {
 const request = vi.fn(implementation), storage = new Map<string, string>(), sockets: Array<{ socket: FakeSocket; url: string; protocols: string[] }> = [];
 const realtimeToken = vi.fn<() => Promise<RealtimeTokenResponse>>(async () => ({ token: "fixture-realtime-value", expiresAt: new Date(Date.now() + 900_000).toISOString(), endpoint: REALTIME_ENDPOINT, channels: { user: USER_CHANNEL, projects: { web: PROJECT_CHANNEL } } }));
 const host: AppHost = { viewport: { width: () => 1280, subscribe: () => () => undefined }, kind: "web", origin: "https://cell.example", transport: { request }, realtimeToken,
  currentPath: () => "/app/live", setTitle: vi.fn(), openSocket: (url, protocols) => { const socket = new FakeSocket();sockets.push({ socket, url, protocols });return socket; },
  openExternal: vi.fn(), navigate: vi.fn(), signIn: vi.fn(), signOut: vi.fn(async () => undefined), saveFile: vi.fn(), features: { admin: true }, storage: { get: key => storage.get(key), set: (key, value) => { storage.set(key, value); } },
 };
 return { host, request, storage, sockets, realtimeToken };
}
