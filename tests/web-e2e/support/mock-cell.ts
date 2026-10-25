import "../../../packages/broker/src/aws/broker-environment-init.js";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { SessionDiffSchema, AgentXError, errorStatus, RealtimeTokenResponseSchema, userChannel, projectChannel, SessionViewSchema, SessionMessageSchema, SessionMessagePageSchema, SessionShareSchema, AgentPrincipalSchema, SessionMakeAgentBodySchema, AppOrgMembersResponseSchema } from "@agentx/contracts";
import { createAppHandler } from "../../../packages/web/src/server/handler.js";
import { authenticateWebRequest, webRouteAllowed } from "../../../packages/broker/src/aws/web-auth.js";
import type { DeveloperRouteDependencies } from "../../../packages/broker/src/aws/developer-routes.js";
import { appCsrfTokenFor } from "../../../packages/broker/src/developer/app-csrf.js";
import { requireDecideNavigation, csrfTokenFor } from "../../../packages/broker/src/developer/decide-session.js";
import { confirmPage, CONFIRM_PAGE_HEADERS } from "../../../packages/broker/src/developer/confirm-page.js";
import { BROWSER_RETURN_TO } from "../../../packages/broker/src/developer/server.js";
import { FIXTURE_ORG, FIXTURE_DEVELOPER, FIXTURE_SESSION } from "../../web/support/fixtures.js";
import { scenario } from "./scenarios.js";
import { mockCellOrigin, mockCellPort } from "./port.js";
const origin = mockCellOrigin(), directory = resolve(".test-build/web-e2e/tls");
mkdirSync(directory, { recursive: true });
const key = resolve(directory, "localhost-key.pem"), cert = resolve(directory, "localhost-cert.pem"), config = resolve(directory, "localhost.cnf");
// RULING Q19: ephemeral, test-only loopback TLS exercises Secure cookies and HTTPS-only confirmation links without relaxing production guards.
if (!existsSync(key) || !existsSync(cert)) {
 writeFileSync(config, "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
 execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "7", "-keyout", key, "-out", cert, "-config", config], { stdio: "ignore" });
}
let current = scenario("shell"), revoked = false, expired = false, refusedSignIn = false;
const requests: Array<{ method: string; path: string; body?: unknown }> = [];
const unavailable = async (): Promise<never> => { throw new Error("Mock operation is not configured."); };
const deps: DeveloperRouteDependencies = {
 tableName: "mock-state", now: Date.now,
 documentClient: { async send(command) {
 if (!(command instanceof GetCommand)) throw new Error("Mock read is not configured.");
 const pk: unknown = command.input.Key?.pk;
 if (pk === `SESSION#${FIXTURE_SESSION}`) return { Item: { developerId: FIXTURE_DEVELOPER, amr: "cloud", endsAt: Math.floor(Date.now() / 1000) + (expired ? -1 : 3600), reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600, startedAt: new Date(Date.now() - 60000).toISOString(), ...(revoked ? { revokedAt: new Date().toISOString() } : {}) } };
 if (pk === `DEVELOPER#${FIXTURE_DEVELOPER}`) return { Item: { displayName: "Priya" } };
 return {};
 } },
 developer: { issuer: origin + "/v1/auth", env: "test", methods: { slack: false, oidc: false, cloud: true }, signInTableName: "mock-signin", verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) },
 orgs: { orgForDeveloper: async id => id === FIXTURE_DEVELOPER ? { orgId: FIXTURE_ORG, role: "member" } : undefined, getOrg: unavailable, createInvite: unavailable, listMembers: unavailable, setRole: unavailable, removeMember: unavailable, closeOrg: unavailable },
};
const handler = createAppHandler({ appDirectory: resolve("packages/web/dist/app"), assetOrigin: "", realtimeHttpHost: "", realtimeWsHost: "" });
async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
 const url = new URL(request.url ?? "/", origin), method = request.method ?? "GET", headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(",") : value]));
 function json(status: number, body: unknown) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });response.end(JSON.stringify(body)); }
 try {
 if (url.pathname === "/__mock/scenario" && method === "POST") { let body = "";for await (const chunk of request) { body += String(chunk);if (body.length > 4096) throw new Error("Mock body limit."); }const input = JSON.parse(body) as { name?: unknown };if (typeof input.name !== "string") throw new Error("Invalid mock scenario.");current = scenario(input.name);revoked = false;expired = false;refusedSignIn = false;requests.length = 0;json(200, { ok: true });return; }
 if (url.pathname === "/__mock/auth" && method === "POST") { let body = "";for await (const chunk of request) body += String(chunk);const state = JSON.parse(body) as { expired?: boolean; refused?: boolean };expired = state.expired === true;refusedSignIn = state.refused === true;json(200, { ok: true });return; }
 if (url.pathname === "/__mock/session-state" && method === "POST" && current.session !== undefined) { let body = "";for await (const chunk of request) body += String(chunk);const changes = JSON.parse(body) as Record<string, unknown>;current.session = SessionViewSchema.parse({ ...current.session, ...changes });json(200, { ok: true });return; }
 if (url.pathname === "/__mock/requests") { json(200, requests);return; }
 const evidence: { method: string; path: string; body?: unknown } = { method, path: url.pathname };requests.push(evidence);
 if (url.pathname === "/v1/auth/browser/authorize") {
 if (refusedSignIn) { response.writeHead(303, { location: "/app/signed-out?reason=removed" });response.end();return; }
 const path = url.searchParams.get("return_to") ?? "/app";const target = BROWSER_RETURN_TO.test(path) ? path : "/app";
 response.writeHead(200, { ...CONFIRM_PAGE_HEADERS });response.end(`<!doctype html><html lang="en"><head><title>Mock sign in</title></head><body><main><h1>Sign in to the mock cell</h1><form method="post" action="/v1/auth/browser/callback"><input type="hidden" name="return_to" value="${target.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"><button>Sign in</button></form></main></body></html>`);return;
 }
 if (url.pathname === "/v1/auth/browser/callback" && method === "POST") {
 let body = "";for await (const chunk of request) body += String(chunk);const path = new URLSearchParams(body).get("return_to") ?? "/app";revoked = false;expired = false;
 response.writeHead(303, { location: BROWSER_RETURN_TO.test(path) ? path : "/app", "set-cookie": `__Host-agentx_review_session=${FIXTURE_SESSION}; Path=/; Secure; HttpOnly; SameSite=Strict` });response.end();return;
 }
 if (url.pathname.startsWith("/v1/app/approve/")) {
 try { requireDecideNavigation({ method, path: url.pathname, headers }); } catch { response.writeHead(403, CONFIRM_PAGE_HEADERS);response.end("Open this approval from its link.");return; }
 if (method === "POST") { json(200, { decided: true });return; }
 const page = confirmPage({ title: "Confirm sharing this session", facts: [{ label: "Project", value: "payments" }] }, { approvalId: "apr_aaaaaaaaaaaaaaaaaaaa", csrf: csrfTokenFor(FIXTURE_SESSION) });response.writeHead(page.statusCode, page.headers);response.end(page.body);return;
 }
 if (url.pathname.startsWith("/v1/web/") || url.pathname === "/v1/auth/browser/sign-out") {
 if (url.pathname.startsWith("/v1/web/") && !webRouteAllowed(method, url.pathname)) { json(404, { error: { code: "NOT_FOUND", message: "Not found." } });return; }
 await authenticateWebRequest(deps, { method, path: url.pathname, headers, requestId: "mock-request" });
 if (url.pathname === "/v1/auth/browser/sign-out") { revoked = true;response.writeHead(204, { "set-cookie": "__Host-agentx_review_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0" });response.end();return; }
 if (url.pathname === "/v1/web/nav") { json(200, current.nav);return; }
 if (url.pathname === "/v1/web/me") { json(200, { ...current.me, csrf: appCsrfTokenFor(FIXTURE_SESSION) });return; }
 if (current.session !== undefined) {
 const session = current.session, path = "/v1/web/sessions/" + session.sessionId;
 if (url.pathname === path + "/diff" && method === "GET") {
 if (url.searchParams.get("repository") !== "acme/payments" || url.searchParams.get("number") !== "42") { json(404, { error: { code: "NOT_FOUND", message: "Not found." } });return; }
 const second = url.searchParams.get("page") === "2";
 json(200, SessionDiffSchema.parse({ files: [{ path: second ? "assets/refund.png" : "src/refund.ts", status: "modified", additions: second ? 0 : 1, deletions: 0, ...(second ? { patchOmitted: "binary" } : { patch: "+</pre><script>window.__pwned=1</script>" }) }], ...(second ? {} : { nextPage: 2 }), pullRequest: { repository: "acme/payments", number: 42, url: "https://github.com/acme/payments/pull/42" } }));return;
 }
 if (url.pathname === path && method === "GET") { json(200, { session });return; }
 if (url.pathname === path + "/messages" && method === "GET") {
 const anchor = url.searchParams.get("anchor"), visible = anchor === null || session.anchors?.some(part => part.target + ":" + part.targetId === anchor) === true;
 const messages = visible ? (current.messages ?? []).filter(message => anchor === null || (message.anchor !== undefined && "targetId" in message.anchor && message.anchor.target + ":" + message.anchor.targetId === anchor)) : [];
 json(200, SessionMessagePageSchema.parse({ messages }));return;
 }
 if (url.pathname === path + "/events" && method === "GET") { json(200, { events: [] });return; }
 if (url.pathname === path + "/presence" && method === "POST") { json(200, { viewingNow: session.viewingNow });return; }
 if (url.pathname === path + "/follow" && (method === "POST" || method === "DELETE")) { const following = method === "POST";current.session = SessionViewSchema.parse({ ...session, you: { ...session.you, following } });json(200, { following });return; }
 if (url.pathname === path + "/shares" && method === "GET") { json(200, { shares: current.shares ?? [] });return; }
 if ((url.pathname === path + "/messages" && method === "POST") || (url.pathname === path + "/shares" && method === "PUT")) {
 let body = "";for await (const chunk of request) { body += String(chunk);if (body.length > 12000) throw new Error("Mock body limit."); }
 const input = JSON.parse(body) as Record<string, unknown>, requestId = SessionMakeAgentBodySchema.shape.requestId.parse(input.requestId);
 if (method === "POST") {
 const message = SessionMessageSchema.parse({ messageId: "msg_" + String((current.messages?.length ?? 0) + 1).padStart(20, "a"), sessionId: session.sessionId, kind: input.kind, source: "app", author: { developerId: FIXTURE_DEVELOPER, name: "Priya" }, text: input.text, rev: 1, createdAt: new Date().toISOString(), ...(input.anchor === undefined ? {} : { anchor: input.anchor, anchorState: "current" }), ...(input.threadId === undefined ? {} : { threadId: input.threadId }) });
 current.messages = [...current.messages ?? [], message];evidence.body = { requestId, kind: message.kind, ...(message.anchor !== undefined && "targetId" in message.anchor ? { anchor: { target: message.anchor.target, targetId: message.anchor.targetId, revision: message.anchor.revision } } : {}) };json(200, message);return;
 }
 const principal = AgentPrincipalSchema.parse(input.principal), share = SessionShareSchema.parse({ principal, level: input.level, sharedBy: { developerId: FIXTURE_DEVELOPER, name: "Priya" }, sharedAt: new Date().toISOString() });current.shares = [...current.shares ?? [], share];evidence.body = { requestId, principal, level: share.level };json(200, { share });return;
 }
 if (/^\/v1\/web\/sessions\/[^/]+$/.test(url.pathname) && method === "GET") { json(404, { error: { code: "NOT_FOUND", message: "Not found." } });return; }
 if (url.pathname === "/v1/web/org/members" && method === "GET") { json(200, AppOrgMembersResponseSchema.parse({ members: [{ developerId: FIXTURE_DEVELOPER, name: "Priya", role: "member", identities: ["cloud"], joinedAt: "2026-10-23T12:00:00.000Z" }, { developerId: "b".repeat(64), name: "Arjun", role: "member", identities: ["cloud"], joinedAt: "2026-10-23T12:00:00.000Z" }] }));return; }
 if (url.pathname === "/v1/web/projects" && method === "GET") { json(200, { projects: [] });return; }
 }
 if (url.pathname === "/v1/web/home") { json(200, current.home);return; }
 if (url.pathname === "/v1/web/realtime/token" && method === "POST") { json(200, RealtimeTokenResponseSchema.parse({ token: "fixture-realtime-value", expiresAt: new Date(Date.now() + 900_000).toISOString(), endpoint: origin.replace("https:", "wss:") + "/event/realtime", channels: { user: userChannel(FIXTURE_ORG, FIXTURE_DEVELOPER), projects: { payments: projectChannel(FIXTURE_ORG, "payments") } } }));return; }
 if (url.pathname === "/v1/web/changes") { json(200, { notices: [], next: "settled" });return; }
 json(404, { error: { code: "NOT_FOUND", message: "This mock route is not configured." } });return;
 }
 const page = await handler({ rawPath: url.pathname, headers, requestContext: { http: { method } } });response.writeHead(page.statusCode, page.headers);response.end(page.isBase64Encoded ? Buffer.from(page.body, "base64") : page.body);
 } catch (error) { if (error instanceof AgentXError) json(errorStatus(error.code), { error: { code: error.code, message: error.message } });else json(500, { error: { code: "MOCK_UNAVAILABLE", message: "The mock cell could not complete this request." } }); }
}
const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => { void handleRequest(request, response).catch(() => { if (!response.headersSent) response.writeHead(500);response.end("Mock cell unavailable."); }); });
server.listen(mockCellPort(), "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { server.close(() => process.exit(0)); });
