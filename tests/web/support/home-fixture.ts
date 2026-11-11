import { SessionListSchema, SessionTileSchema, AgentDirectoryResponseSchema } from "@agentx/contracts/web";
import { sessionPerson } from "./session-fixture.js";
import { liveFixture } from "./live-fixture.js";
import { agentProfile } from "./agent-fixture.js";
// Fixtures for the new Home (exp/home): my ended work (`GET /v1/app/sessions?owner=me&status=ended`), my open work (the live "mine" read) and the agent directory.
type Tile = ReturnType<typeof SessionTileSchema.parse>;
export const homeSessionId = (n: number): string => "ses_" + n.toString(36).padStart(20, "a");
export function endedTile(n: number, overrides: Record<string, unknown> = {}, summary: Record<string, unknown> = {}): Tile {
 const at = new Date(Date.UTC(2026, 10, 10, 12, 0) - n * 3_600_000).toISOString();
 return SessionTileSchema.parse({ contractVersion: 1, sessionId: homeSessionId(n), kind: "task", title: "Finished work " + String(n), project: "payments", owner: sessionPerson, where: { kind: "cloud" }, level: "edit", revision: 1, createdAt: at, updatedAt: at, endedAt: at,
  summary: { status: "succeeded", costUsd: 1, needsPeople: [], pendingApprovals: 0, digest: "Finished work " + String(n), computedAt: at, ...summary }, ...overrides });
}
export const endedList = (count: number) => SessionListSchema.parse({ sessions: Array.from({ length: count }, (_, index) => endedTile(index + 1)) });
export function openTile(n: number, overrides: Record<string, unknown> = {}) {
 const at = new Date(Date.UTC(2026, 10, 11, 9, 0) - n * 60_000).toISOString();
 return liveFixture({ sessionId: homeSessionId(100 + n), title: "Open work " + String(n), updatedAt: at, ...overrides });
}
export function directoryOf(names: Array<{ id: string; name: string; description?: string; status?: "active" | "archived" }>) {
 const base = agentProfile().agent;
 return AgentDirectoryResponseSchema.parse({ agents: names.map(item => ({ ...base, agentId: item.id, name: item.name, description: item.description ?? "Does " + item.name + " work.", status: item.status ?? "active" })) });
}
export const agentId = (n: number): string => "agt_" + n.toString(36).padStart(20, "a");
