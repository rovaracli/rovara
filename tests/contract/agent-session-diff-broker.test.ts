import { randomUUID, generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { agentSessionKey } from "@rovara-code/contracts";
import { sessionWorld } from "../support/agent-session-world.js";
import { TEST_ORG } from "../support/orgs.js";
it("reads the pinned named repository through the browser broker and real GitHub provider", async () => {
 const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
 const binding = vi.fn(async () => undefined), urls: string[] = [];
 const provider = new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: "123", getPrivateKey: async () => key, requireInstallationBound: binding,
 fetchImplementation: async input => {
 const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;urls.push(url);
 if (url.endsWith("/installation")) return Response.json({ id: 123, account: { login: "example" } });
 if (url.endsWith("/access_tokens")) return Response.json({ token: "fake-test-only", expires_at: "2030-01-01T00:00:00Z" });
 expect(url).toBe("https://api.github.com/repos/example/demo/pulls/42/files?per_page=100&page=1");
 return Response.json([{ filename: "src/fix.ts", status: "copied", previous_filename: "src/old.ts", additions: 1, deletions: 0, patch: "+fixed" }]);
 } });
 const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {}, cloud: true, githubPullRequests: provider } });
 const world = sessionWorld(), seeded = world.seedSession({ owner: MAYA.developerId, orgId: TEST_ORG, project: "payments" });
 const task: Record<string, unknown> = { ...world.db.get("DEVTASK#" + seeded.taskId, "META")!, startingRevision: 1 };
 h.db.set(task);h.db.set({ ...agentSessionKey(TEST_ORG, seeded.sessionId, "META"), entityType: "AGENT_SESSION", ...seeded.record });
 h.db.set({ pk: "WORKSPACE#" + String(task.workspaceId), sk: "PULL_REQUEST#demo#42", repository: "demo", number: 42, url: "https://github.com/example/demo/pull/42", state: "open" });
 const browserId = randomUUID();h.db.set({ ...h.db.get("SESSION#" + MAYA.sessionId, "META")!, pk: "SESSION#" + browserId, sessionId: browserId, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
 async function read(repository: string) {
 const path = "/v1/web/sessions/" + seeded.sessionId + "/diff";
 const response = await h.handler({ rawPath: path, rawQueryString: "repository=" + repository + "&number=42&page=1", routeKey: "ANY /v1/web/{proxy+}", headers: { cookie: "__Host-agentx_review_session=" + browserId, "sec-fetch-site": "same-origin" }, requestContext: { requestId: "diff-broker", http: { method: "GET" } } });
 return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
 }
 const response = await read("demo");expect(response.status).toBe(200);expect(response.body).toMatchObject({ files: [{ path: "src/fix.ts", status: "added", previousPath: "src/old.ts", patch: "+fixed" }] });
 expect(binding).toHaveBeenCalledWith(TEST_ORG, 123, { owner: "example", name: "demo" });
 const before = urls.length;
 h.db.set({ pk: "WORKSPACE#" + String(task.workspaceId), sk: "PULL_REQUEST#missing#43", repository: "missing", number: 42, url: "https://github.com/example/missing/pull/42", state: "open" });
 expect((await read("missing")).status).toBe(404);expect(urls).toHaveLength(before);
});

it("fails closed before diff resolution when task dependencies are unavailable", async () => {
 const { routeDeveloperRequest } = await import("../../packages/broker/src/aws/developer-routes.js");
 const world = sessionWorld(), seeded = world.seedSession();
 const deps = { agentSessions: {}, developer: { issuer: "https://cell.example/v1/auth" } } as unknown as DeveloperRouteDependencies;
 const url = new URL("/v1/app/sessions/" + seeded.sessionId + "/diff?repository=demo&number=42", "https://cell.example");
 await expect(routeDeveloperRequest(deps, { requestId: "missing-task-deps", method: "GET", path: url.pathname, headers: {} }, url, { caller: world.caller("a".repeat(64)), csrf: "test-only" })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
