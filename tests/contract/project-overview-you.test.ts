import { expect, it } from "vitest";
import { projectOverview } from "../../packages/broker/src/agent-sessions/project-overview.js";
import { sessionWorld, PRIYA, MIA, MAX, CELL, ORG_A } from "../support/agent-session-world.js";
for (const [who, start, edit] of [[PRIYA, true, false], [MIA, false, false], [MAX, true, true]] as const) it("returns authoritative project start/settings flags for " + (who === PRIYA ? "contributor" : who === MIA ? "viewer" : "maintainer"), async () => {
 const w = sessionWorld();
 const result = await projectOverview({ documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64), taskView: async () => { throw new Error("No task read expected"); }, projectPage: async (_caller, name) => ({ name, status: "active", repositories: [], setup: { status: "ready" }, channels: [] }) }, w.caller(who), "web");
 expect(result).toHaveProperty("orgId", ORG_A);
 expect(result.you).toMatchObject({ canStartWork: start, canEditSettings: edit });
});
