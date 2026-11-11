import { SessionTileSchema } from "@agentx/cloud-contracts/web";
import { sessionPerson, SESSION_FIXTURE_ID } from "./session-fixture.js";
type FinishedTile = ReturnType<typeof SessionTileSchema.parse>;
/** One ended session as `GET /v1/app/sessions?...&status=ended` lists it. */
export function finishedFixture(overrides: Partial<FinishedTile> = {}): FinishedTile {
 return SessionTileSchema.parse({ contractVersion: 1, sessionId: SESSION_FIXTURE_ID, kind: "task", title: "Fix duplicate refunds", project: "payments", agent: { agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "Payments expert", version: 3 }, owner: sessionPerson, where: { kind: "cloud" }, level: "edit", revision: 3,
  summary: { status: "succeeded", costUsd: 1.2, needsPeople: [], pendingApprovals: 0, digest: "Finished", computedAt: "2026-10-23T12:00:00.000Z" }, createdAt: "2026-10-23T10:00:00.000Z", updatedAt: "2026-10-23T12:00:00.000Z", endedAt: "2026-10-23T12:00:00.000Z", ...overrides });
}
