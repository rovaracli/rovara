import { LiveTileSchema } from "@agentx/cloud-contracts/web";
import { sessionPerson, SESSION_FIXTURE_ID } from "./session-fixture.js";
type LiveTile = ReturnType<typeof LiveTileSchema.parse>;
export function liveFixture(overrides: Partial<LiveTile> = {}): LiveTile {
 return LiveTileSchema.parse({ contractVersion: 1, sessionId: SESSION_FIXTURE_ID, kind: "local", title: "Fix duplicate refunds", agent: { agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "Payments expert", version: 3 }, project: "payments", owner: sessionPerson, where: { kind: "cloud" }, status: "running", statusWords: "Running", step: "Planning", costUsd: 1.2, viewingNow: [sessionPerson], viewingNowCount: 1, needsYou: false, following: false, actions: ["watch"], updatedAt: "2026-10-23T12:00:00.000Z", ...overrides });
}
