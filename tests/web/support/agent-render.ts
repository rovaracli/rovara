import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest, ApiResponse } from "../../../packages/ui/src/host.js";
import { AppHostProvider } from "../../../packages/ui/src/host.js";
import { Announcer } from "../../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../../packages/ui/src/api/query.js";
import { DirectoryScreen } from "../../../packages/ui/src/screens/agents/DirectoryScreen.js";
import { renderUi } from "./render.js";
import { h } from "./h.js";
import { fakeHost } from "./fake-host.js";
import { navFixture, meFixture } from "./fixtures.js";
import { agentDirectory, agentProfile, AGENT_FIXTURE_ID, agentPerson } from "./agent-fixture.js";
export function renderAgents(options: { path?: string; profile?: ReturnType<typeof agentProfile>; reply?: (request: ApiRequest) => Promise<ApiResponse>; live?: unknown[]; liveReply?: () => Promise<ApiResponse>; projectRole?: "viewer" | "contributor"; projectStatus?: "active" | "archived"; agentOnProject?: boolean; shares?: unknown[]; versions?:unknown[]; theme?: "light" | "dark"; width?: number; storage?: Record<string, string> } = {}) {
 let profile = options.profile ?? agentProfile();
 const f = fakeHost(async request => {
  if (request.method !== "GET") return options.reply?.(request) ?? { status: 200, body: { agent: profile.agent } };
  if (request.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (request.path.startsWith("/v1/app/agents?")) return { status: 200, body: request.path.includes("?project=") && options.agentOnProject === false ? { agents: [] } : agentDirectory() };
  if (request.path === "/v1/app/agents/" + AGENT_FIXTURE_ID || request.path === "/v1/app/agents/rovara-code" || request.path === "/v1/app/agents/ticket-triage") return { status: 200, body: profile };
  if (request.path.endsWith("/draft")) return { status: 200, body: { draft: { revision: 9, overlay: { instructions: "Retain refund checks." }, extends: { agentId: "ticket-triage", version: 1 }, updatedBy: agentPerson, updatedAt: "2026-10-23T12:00:00.000Z" } } };
  if (request.path.endsWith("/versions")) return { status: 200, body: { versions: options.versions??[{ version: 3, publishedAt: "2026-10-23T12:00:00.000Z", publishedBy: agentPerson, note: "Refund checks", current: true }] } };
  if (request.path.endsWith("/shares")) return { status: 200, body: { shares: options.shares ?? [] } };
  if (request.path.includes("/spend?")) return { status: 200, body: { month: "2026-10", totalUsd: 3.25, byOrigin: { person: 2, autonomous: 1, test: 0.25 }, recentRuns: [] } };
  if (request.path.startsWith("/v1/app/live?")) return options.liveReply ? options.liveReply() : { status: 200, body: { tiles: options.live ?? [] } };
  if (request.path.startsWith("/v1/app/changes")) return { status: 200, body: { notices: [], next: "settled" } };
  if (request.path === "/v1/app/org/members") return { status: 200, body: { members: [{ developerId: agentPerson, name: "Priya", role: "member", identities: ["cloud"], joinedAt: "2026-10-23T12:00:00.000Z" }, { developerId: "b".repeat(64), name: "Arjun", role: "member", identities: ["cloud"], joinedAt: "2026-10-23T12:00:00.000Z" }] } };
  if (request.path === "/v1/app/projects") return { status: 200, body: { projects: ["payments", "checkout"].map(name => ({ name, status: options.projectStatus ?? "active", latestRevision: 1, repositories: [], myRole: options.projectRole ?? "contributor", setup: { status: "ready" } })) } };
  return options.reply?.(request) ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 });
 for (const [key, value] of Object.entries(options.storage ?? {})) f.storage.set(key, value);
 if (options.width !== undefined) { const width = options.width;f.host.viewport = { width: () => width, subscribe: () => () => undefined }; }
 const query = createQueryClient();query.setQueryData(["nav"], navFixture());
 const router = createMemoryRouter([{ path: "/app/agents/:id?", element: h(DirectoryScreen, {}) }], { initialEntries: [options.path ?? "/app/agents"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }), { theme: options.theme ?? "light" });
 return { ...f, ...ui, query, router, setProfile(next: typeof profile) { profile = next; }, close() { ui.unmount();router.dispose();query.clear(); } };
}
