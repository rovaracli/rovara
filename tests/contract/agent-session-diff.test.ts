import { expect, it, vi } from "vitest";
import { DeveloperTaskViewSchema } from "@agentx/contracts";
import { sessionDiff, type SessionDiffDependencies } from "../../packages/broker/src/agent-sessions/diff.js";
import { ARJUN, BO, CELL, ORG_A, ORG_B, PRIYA, sessionWorld } from "../support/agent-session-world.js";
function setup() {
 const w = sessionWorld(), { sessionId } = w.seedSession();
 w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "view");
 const files = vi.fn(async () => ({ files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+ghp_" + "x".repeat(36) }], nextPage: 2 }));
 const repository = vi.fn(async () => "https://github.com/acme/app");
 const deps: SessionDiffDependencies = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL,
 taskView: async task => DeveloperTaskViewSchema.parse({ taskId: task.taskId, project: task.project, title: "Fix", status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z", events: [], pullRequests: [{ repository: "app", number: 42, url: "https://github.com/acme/app/pull/42", state: "open" }] }),
 diff: { repository, files } };
 return { w, sessionId, deps, files, repository };
}
it("allows an explicit view share and redacts token text", async () => {
 const f = setup();expect(await sessionDiff(f.deps, f.w.caller(ARJUN), f.sessionId, { repository: "app", number: 42, page: 1 })).toMatchObject({ files: [{ patch: "+[redacted]" }], nextPage: 2 });
 expect(f.files).toHaveBeenCalledWith("https://github.com/acme/app", 42, { page: 1 }, { orgId: ORG_A });
});
it("omits patches over the byte limit", async () => {
 const f = setup();f.files.mockResolvedValue({ files: [{ filename: "large", status: "modified", additions: 1, deletions: 0, patch: "a".repeat(70_000) }], nextPage: 2 });
 expect(await sessionDiff(f.deps, f.w.caller(PRIYA), f.sessionId, { repository: "app", number: 42, page: 1 })).toMatchObject({ files: [{ patchOmitted: "too_large" }] });
});
it("refuses foreign orgs and PR selectors before any GitHub file read", async () => {
 for (const input of [{ who: BO, org: ORG_B, repository: "app", number: 42 }, { who: ARJUN, org: ORG_A, repository: "outside", number: 42 }, { who: ARJUN, org: ORG_A, repository: "app", number: 43 }]) {
 const f = setup();await expect(sessionDiff(f.deps, f.w.caller(input.who, input.org), f.sessionId, { repository: input.repository, number: input.number, page: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });expect(f.files).not.toHaveBeenCalled();
 }
});
it("refuses a repository absent from the pinned project before GitHub", async () => {
 const f = setup();f.repository.mockResolvedValue(undefined as never);
 await expect(sessionDiff(f.deps, f.w.caller(ARJUN), f.sessionId, { repository: "app", number: 42, page: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });expect(f.files).not.toHaveBeenCalled();
});
