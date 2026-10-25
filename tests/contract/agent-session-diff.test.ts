import { expect, it, vi } from "vitest";
import { DeveloperTaskViewSchema } from "@agentx/contracts";
import { sessionDiff, type SessionDiffDependencies } from "../../packages/broker/src/agent-sessions/diff.js";
import { ARJUN, BO, CELL, ORG_A, ORG_B, PRIYA, sessionWorld } from "../support/agent-session-world.js";
function setup() {
 const w = sessionWorld(), { sessionId } = w.seedSession();
 w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "view");
 const files = vi.fn(async () => ({ files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+ghp_" + "x".repeat(36) }], nextPage: 2 }));
 const repository = vi.fn(async (): Promise<string | undefined> => "https://github.com/acme/app");
 const deps: SessionDiffDependencies = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL,
 taskView: async task => DeveloperTaskViewSchema.parse({ taskId: task.taskId, project: task.project, title: "Fix", status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z", events: [], pullRequests: [{ repository: "app", number: 42, url: "https://github.com/acme/app/pull/42", state: "open" }] }),
 diff: { repository, files } };
 return { w, sessionId, deps, files, repository };
}
it("allows an explicit view share and redacts token text", async () => {
 const f = setup();expect(await sessionDiff(f.deps, f.w.caller(ARJUN), f.sessionId, { repository: "app", number: 42, page: 1 })).toMatchObject({ files: [{ patch: "+[REDACTED]" }], nextPage: 2 });
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
 const f = setup();f.repository.mockResolvedValue(undefined);
 await expect(sessionDiff(f.deps, f.w.caller(ARJUN), f.sessionId, { repository: "app", number: 42, page: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });expect(f.files).not.toHaveBeenCalled();
});

it("maps an unbound installation to the same invisible diff response", async () => {
 const f = setup();f.files.mockRejectedValue(Object.assign(new Error("not connected"), { code: "GITHUB_NOT_CONNECTED" }));
 await expect(sessionDiff(f.deps, f.w.caller(ARJUN), f.sessionId, { repository: "app", number: 42, page: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("mints exactly two read permissions only after the live org binding check", async () => {
 const { generateKeyPairSync } = await import("node:crypto");
 const { GitHubAppCredentialProvider } = await import("../../packages/broker/src/github-app.js");
 const { agentXError } = await import("@agentx/contracts");
 const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
 for (const bound of [true, false]) {
 const calls: string[] = [], tokenBodies: unknown[] = [];
 const provider = new GitHubAppCredentialProvider({ credentialRef: "test", appId: "123", getPrivateKey: async () => key,
 requireInstallationBound: async org => { expect(org).toBe(ORG_A);calls.push("binding");if (!bound) throw agentXError("GITHUB_NOT_CONNECTED", "not connected"); },
 fetchImplementation: async (input, init) => {
 const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
 if (url.endsWith("/installation")) return Response.json({ id: 123, account: { login: "acme" } });
 if (url.endsWith("/access_tokens")) { calls.push("mint");if (typeof init?.body !== "string") throw new Error("expected JSON body");tokenBodies.push(JSON.parse(init.body));return Response.json({ token: "fake-test-only", expires_at: "2030-01-01T00:00:00Z" }); }
 calls.push("files");expect(url).toBe("https://api.github.com/repos/acme/app/pulls/42/files?per_page=100&page=2");
 return Response.json([{ filename: "a", status: "modified", additions: 1, deletions: 0, patch: "+full", previous_filename: "b" }], { headers: { link: '<https://api.github.com/anything>; rel="next"' } });
 } });
 if (bound) {
 expect(await provider.listPullRequestFiles("https://github.com/acme/app", 42, { page: 2 }, { orgId: ORG_A })).toMatchObject({ files: [{ patch: "+full", previous_filename: "b" }], nextPage: 3 });
 expect(calls).toEqual(["binding", "mint", "files"]);expect(tokenBodies).toEqual([{ repositories: ["app"], permissions: { pull_requests: "read", contents: "read" } }]);
 } else {
 await expect(provider.listPullRequestFiles("https://github.com/acme/app", 42, { page: 2 }, { orgId: ORG_A })).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });expect(calls).toEqual(["binding"]);expect(tokenBodies).toEqual([]);
 }
 }
});

it("dispatches only the read diff route and rejects malformed selectors without GitHub", async () => {
 const { routeAgentSessionRequest } = await import("../../packages/broker/src/agent-sessions/routes.js");
 const f = setup();const path = "/v1/app/sessions/" + f.sessionId + "/diff";
 const url = new URL(path + "?repository=app&number=42&page=1", CELL);
 const request = { requestId: "diff-test", method: "GET", path: url.pathname + url.search, headers: {} };
 expect(await routeAgentSessionRequest(f.deps, f.w.caller(ARJUN), request, url)).toMatchObject({ pullRequest: { number: 42 } });
 f.files.mockClear();
 for (const suffix of ["?repository=app&number=0", "?repository=app&number=42&page=-1", "?repository=app&number=42&page=1.5"]) {
 const bad = new URL(path + suffix, CELL);await expect(routeAgentSessionRequest(f.deps, f.w.caller(ARJUN), request, bad)).rejects.toMatchObject({ code: "NOT_FOUND" });
 }
 await expect(routeAgentSessionRequest(f.deps, f.w.caller(ARJUN), { ...request, method: "POST" }, url)).rejects.toMatchObject({ code: "NOT_FOUND" });expect(f.files).not.toHaveBeenCalled();
});
it("caps output to one file page and counts UTF-8 bytes", async () => {
 const f = setup();f.files.mockResolvedValue({ files: Array.from({ length: 101 }, (_, i) => ({ filename: "file" + i, status: "modified", additions: 1, deletions: 0, patch: "é".repeat(33_000) })), nextPage: 2 });
 const diff = await sessionDiff(f.deps, f.w.caller(ARJUN), f.sessionId, { repository: "app", number: 42, page: 1 });expect(diff.files).toHaveLength(100);expect(diff.files.every(file => file.patch === undefined && file.patchOmitted === "too_large")).toBe(true);
});
