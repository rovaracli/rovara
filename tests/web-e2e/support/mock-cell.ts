import { createAdminDirectory } from "./admin-directory.js";
import { CodeIntentBodySchema } from "@agentx/contracts";
import { taskPageFixture,TASK_PAGE_FIXTURE_ID } from "./task-page-fixture.js";
import { joinDonePage } from "../../../packages/broker/src/developer/join-page.js";
import { escapeHtml } from "../../../packages/broker/src/aws/web-session.js";
import { SetupApplyBodySchema,SetupApplyResponseSchema,SetupDraftResponseSchema,AppProjectDetailSchema,CreateProjectBodySchema,CloudProjectCreatedResponseSchema,RenameOrganizationBodySchema,RenameOrganizationResponseSchema,GithubConnectResponseSchema,GithubInstallationsResponseSchema,GithubRepositoriesResponseSchema,ProjectSettingsBodySchema,ProjectSettingsResponseSchema,ProjectSetupCheckBodySchema,ProjectSetupCheckResponseSchema,ProjectRosterAddedResponseSchema } from "@agentx/contracts";
import { builderFixture } from "../../web/support/builder-fixture.js";
import { agentDirectory, agentProfile, AGENT_FIXTURE_ID } from "../../web/support/agent-fixture.js";
import { taskFixture } from "../../web/support/session-fixture.js";
import { understandSession } from "../../web/support/understand-fixture.js";
import "../../../packages/broker/src/aws/broker-environment-init.js";
import { SERVER_PAGE_ICON } from "@agentx/design-tokens";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { applyOverlay,diffRecipes,EMPTY_RECIPE,AgentPublishBodySchema,AgentPublishResponseSchema,AgentVersionViewSchema,AgentDiffResponseSchema,AgentRunBodySchema,BuilderTestingBudgetSchema, AgentCreateBodySchema, AgentDraftPutBodySchema, AgentDraftResponseSchema, ModelListSchema, AgentDirectoryResponseSchema, AgentProfileResponseSchema, AgentVersionsResponseSchema, AgentSpendResponseSchema, AgentSharesResponseSchema, AgentSharesPutResponseSchema, AgentShareInputSchema, AgentOwnerPutBodySchema, AgentWriteResponseSchema, AppProjectsResponseSchema, SessionMakeAgentResponseSchema, AgentIdSchema, ProjectOverviewSchema, TaskResponseSchema, LiveResponseSchema, LiveTileSchema, SessionDiffSchema, AgentXError, errorStatus, RealtimeTokenResponseSchema, userChannel, projectChannel, SessionViewSchema, SessionMessageSchema, SessionMessagePageSchema, SessionShareSchema, AgentPrincipalSchema, SessionMakeAgentBodySchema, AppOrgMembersResponseSchema } from "@agentx/contracts";
import { createAppHandler } from "../../../packages/web/src/server/handler.js";
import { authenticateWebRequest, webRouteAllowed } from "../../../packages/broker/src/aws/web-auth.js";
import type { DeveloperRouteDependencies } from "../../../packages/broker/src/aws/developer-routes.js";
import { appCsrfTokenFor } from "../../../packages/broker/src/developer/app-csrf.js";
import { requireDecideNavigation, csrfTokenFor } from "../../../packages/broker/src/developer/decide-session.js";
import { confirmPage, CONFIRM_PAGE_HEADERS } from "../../../packages/broker/src/developer/confirm-page.js";
import { BROWSER_RETURN_TO } from "../../../packages/broker/src/developer/server.js";
import { homeFixture } from "../../web/support/fixtures.js";
import { FIXTURE_ORG, FIXTURE_DEVELOPER, FIXTURE_SESSION } from "../../web/support/fixtures.js";
import { scenario } from "./scenarios.js";
import { workAnswer } from "./work-mock.js";
import { setSpendingVariant, spendingAnswer } from "./spending-mock.js";
import { healthAnswer, resetHealth, setHealthVariant } from "./health-mock.js";
import { howWeWorkMock, resetHowWeWork } from "./how-we-work-mock.js";
import { lessonsMock, resetLessons, resetTaskLessons, setLessonsPaused, setRepoRetire, setDuplicateLesson, setPresetProposal, setSourceEditing, setTrialLessons, taskLessonsMock } from "./lessons-mock.js";
import { intakeHomeCards, intakeMock, resetIntake, showTicketOnHome } from "./intake-mock.js";
import { resetTestEnvironment, testEnvironmentMock } from "./test-environment-mock.js";
import { learningMock, learningSettingsMock, lockLearning, resetLearning, overviewLearning, homeSuggestionCards } from "./learning-mock.js";
import { companyPolicyMock, resetCompanyPolicy } from "./company-policy-mock.js";
import { homeV2Mock } from "./home-mock.js";
import { projectSetupMock } from "./project-setup-mock.js";
import { mockCellOrigin, mockCellPort, SLOT_ENV } from "./port.js";
const origin = mockCellOrigin(), directory = resolve(".test-build/web-e2e/tls-" + (process.env[SLOT_ENV] ?? "0")); // one directory per mock cell process: several start at once, and none may read a half-written key
mkdirSync(directory, { recursive: true });
const key = resolve(directory, "localhost-key.pem"), cert = resolve(directory, "localhost-cert.pem"), config = resolve(directory, "localhost.cnf");
// RULING Q19: ephemeral, test-only loopback TLS exercises Secure cookies and HTTPS-only confirmation links without relaxing production guards.
if (!existsSync(key) || !existsSync(cert)) {
 writeFileSync(config, "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
 execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "7", "-keyout", key, "-out", cert, "-config", config], { stdio: "ignore" });
}
let adminLoseCreateAck = false;
let current = scenario("shell"), revoked = false, expired = false, refusedSignIn = false;
let adminMemberName = "Maya", adminDirectory = createAdminDirectory(), adminFailAfterWrite = false, adminReadFailures = 0;
let onboardingConnected=false;
let onboardingProject:ReturnType<typeof AppProjectDetailSchema.parse>|undefined;
/** Meta repo lane B: the setup agent's draft for the onboarding project: asked, then ready on the next read. */
let onboardingDraft:"none"|"drafting"|"ready"='none';
// TE-3: Check and apply. The first press of a request id starts the check of the commands (nothing is saved); the next press of the same id finds it passed and saves.
const onboardingChecks=new Set<string>();
const taskPage=taskPageFixture(origin);
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
 orgs: { bindSlackTeam: unavailable, renameOrg: unavailable, orgForDeveloper: async id => id === FIXTURE_DEVELOPER ? { orgId: FIXTURE_ORG, role: current.name === "admin" ? adminDirectory.roleOf(id) : current.me.developer.orgRole } : undefined, getOrg: unavailable, createInvite: unavailable, listMembers: unavailable, setRole: unavailable, removeMember: unavailable, closeOrg: unavailable },
};
const handler = createAppHandler({ appDirectory: resolve("packages/web/dist/app"), assetOrigin: "", realtimeHttpHost: "", realtimeWsHost: "" });
async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
 const url = new URL(request.url ?? "/", origin), method = request.method ?? "GET", headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(",") : value]));
 function json(status: number, body: unknown) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });response.end(JSON.stringify(body)); }
 try {
 if (url.pathname === "/__mock/lessons-paused" && method === "POST") { let body = "";for await (const chunk of request) body += String(chunk);const input = JSON.parse(body) as { code?: unknown };setLessonsPaused(typeof input.code === "string" ? input.code : undefined);json(200, { ok: true });return; }
 if (url.pathname === "/__mock/source-editing" && method === "POST") { setSourceEditing(true);json(200, { ok: true });return; }
 if (url.pathname === "/__mock/repo-retire" && method === "POST") { setRepoRetire();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/trial-lessons" && method === "POST") { setTrialLessons();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/preset-proposal" && method === "POST") { setPresetProposal();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/duplicate-lesson" && method === "POST") { setDuplicateLesson();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/ticket-on-home" && method === "POST") { showTicketOnHome();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/scenario" && method === "POST") { let body = "";for await (const chunk of request) { body += String(chunk);if (body.length > 4096) throw new Error("Mock body limit."); }const input = JSON.parse(body) as { name?: unknown };if (typeof input.name !== "string") throw new Error("Invalid mock scenario.");current = scenario(input.name);adminMemberName = "Maya";adminDirectory = createAdminDirectory();if (current.name === "admin") adminDirectory.seedLaneB();adminLoseCreateAck = false;adminFailAfterWrite = false;adminReadFailures = 0;resetHealth();resetHowWeWork();resetLearning();resetLessons();resetTaskLessons();resetIntake();resetCompanyPolicy();taskPage.reset();onboardingConnected=false;onboardingProject=undefined;onboardingDraft="none";resetTestEnvironment();revoked = false;expired = false;refusedSignIn = false;requests.length = 0;json(200, { ok: true });return; }
 if (url.pathname === "/__mock/learning-lock" && method === "POST") { lockLearning();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/task-learning" && method === "POST") { taskPage.learn();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/task-read-only" && method === "POST") { taskPage.readOnly();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/live-state" && method === "POST" && current.live !== undefined) { let body = "";for await (const chunk of request) body += String(chunk);const input = JSON.parse(body) as { step: string; revision: number };current.live = current.live.map(tile => LiveTileSchema.parse({ ...tile, step: input.step, updatedAt: "2026-10-23T12:" + String(input.revision).padStart(2, "0") + ":00.000Z" }));current.changes = [{ type: "session.updated", sessionId: current.live[0]!.sessionId, revision: input.revision, at: "2026-10-23T12:00:00.000Z", sk: "live-" + input.revision }];json(200, { ok: true });return; }
 if (url.pathname === "/__mock/auth" && method === "POST") { let body = "";for await (const chunk of request) body += String(chunk);const state = JSON.parse(body) as { expired?: boolean; refused?: boolean };expired = state.expired === true;refusedSignIn = state.refused === true;json(200, { ok: true });return; }
 if (url.pathname === "/__mock/session-state" && method === "POST" && current.session !== undefined) { let body = "";for await (const chunk of request) body += String(chunk);const changes = JSON.parse(body) as Record<string, unknown>;current.session = SessionViewSchema.parse({ ...current.session, ...changes });json(200, { ok: true });return; }
 if (url.pathname === "/__mock/health" && method === "POST" && current.name === "admin") { setHealthVariant(url.searchParams.get("variant"));json(200, { ok: true });return; }
 if (url.pathname === "/__mock/spending" && method === "POST" && current.name === "admin") { setSpendingVariant(url.searchParams.get("variant"));json(200, { ok: true });return; }
 if (url.pathname === "/__mock/admin-fail-after-write" && method === "POST" && current.name === "admin") { adminFailAfterWrite = true;json(200, { ok: true });return; }
 if (url.pathname === "/__mock/admin-damage-invite" && method === "POST" && current.name === "admin") { adminDirectory.damageInvite();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/admin-add-member" && method === "POST" && current.name === "admin") { let raw = "";for await (const chunk of request) { raw += String(chunk);if (raw.length > 4096) throw new Error("Mock body limit."); }const input = JSON.parse(raw) as { name?: unknown };if (typeof input.name !== "string") throw new Error("Invalid mock member.");adminDirectory.addMember(input.name, "admin");json(200, { ok: true });return; }
 if (url.pathname === "/__mock/admin-invites" && method === "POST" && current.name === "admin") { await adminDirectory.seedInvites();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/admin-lose-create-ack" && method === "POST" && current.name === "admin") { adminLoseCreateAck = true;json(200,{ok:true});return; }
 if (url.pathname === "/__mock/b35-service-status" && method === "POST" && current.name === "admin") { adminDirectory.seedServiceStatus();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/b34-slack-links" && method === "POST" && current.name === "admin") { adminDirectory.seedSlackLinks();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/start-preview" && method === "POST" && current.name === "project") { adminDirectory.seedLaneB();adminDirectory.seedTaskStops(false, true);current.me.developer.orgRole = "owner";current.nav.me.orgRole = "owner";json(200, { ok: true });return; }
 if (url.pathname === "/__mock/m47-task-stops" && method === "POST" && current.name === "admin") { adminDirectory.seedTaskStops(url.searchParams.get("missingProject") === "1");json(200, { ok: true });return; }
 if (url.pathname === "/__mock/admin-evidence" && method === "GET" && current.name === "admin") { json(200, adminDirectory.evidence());return; }
 if (url.pathname === "/__mock/admin-source-drift" && method === "POST" && current.name === "admin") { adminDirectory.changeSourceOrder();json(200,{ok:true});return; }
 if (url.pathname === "/__mock/admin-target-owner" && method === "POST" && current.name === "admin") { adminDirectory.setRole("b".repeat(64), "owner");json(200, { ok: true });return; }
 if (url.pathname === "/__mock/agent-state" && method === "POST" && current.agent !== undefined) { let body = "";for await (const chunk of request) body += String(chunk);const changes = JSON.parse(body) as Record<string, unknown>;current.agent = AgentProfileResponseSchema.parse({ ...current.agent, agent: { ...current.agent.agent, ...changes } });json(200, { ok: true });return; }
 if (url.pathname === "/__mock/admin-role" && method === "POST" && current.name === "admin") { current.me.developer.orgRole = "member";adminDirectory.setRole(FIXTURE_DEVELOPER, "member");current.nav.me.orgRole = "member";json(200, { ok: true });return; }
 if (url.pathname === "/__mock/admin-long-name" && method === "POST" && current.name === "admin") { adminMemberName = "Long display name ".repeat(30).trim();json(200, { ok: true });return; }
 if (url.pathname === "/__mock/learning-settings" && await learningSettingsMock({ url, method, json, record: value => { evidence.body = value; }, body: async () => { let text = "";for await (const chunk of request) text += String(chunk);return text === "" ? {} : JSON.parse(text) as unknown; } })) return;
 if (url.pathname === "/__mock/company-policy" && await companyPolicyMock({ url, method, record: () => undefined, json, body: async () => { let text = "";for await (const chunk of request) text += String(chunk);return text === "" ? {} : JSON.parse(text) as unknown; } })) return;
 if (url.pathname === "/__mock/requests") { json(200, requests);return; }
 if (await homeV2Mock({ url, method, json, scenario: current, record: () => undefined, body: async () => { let text = "";for await (const chunk of request) text += String(chunk);return JSON.parse(text) as unknown; } })) return;
 const evidence: { method: string; path: string; body?: unknown } = { method, path: url.pathname };requests.push(evidence);
 if (current.name === "onboarding" && await projectSetupMock({ url, method, json, scenario: current, record: value => { evidence.body = value; }, body: async () => { let text = "";for await (const chunk of request) text += String(chunk);return text === "" ? {} : JSON.parse(text) as unknown; } }, { get: () => onboardingProject, set: value => { onboardingProject = value; } })) return;
 if(url.pathname.startsWith("/review/"+TASK_PAGE_FIXTURE_ID+"/task")){
 let body:string|undefined;if(method==="POST"){body="";for await(const chunk of request)body+=String(chunk);evidence.body=JSON.parse(body) as unknown;}
 const result=await taskPage.web({method,path:url.pathname,headers,requestId:"mock-task-page",...(body===undefined?{}:{body})},url);response.writeHead(result.statusCode,result.headers);response.end(result.body);return;
 }
 if (url.pathname === "/__mock/invite") { response.writeHead(200,CONFIRM_PAGE_HEADERS);response.end('<!doctype html><html lang="en"><head><title>Join Acme</title>'+SERVER_PAGE_ICON+'</head><body><main><h1>Join Acme on Rovara</h1><a href="/v1/auth/browser/authorize?return_to=%2Fapp%2Fwelcome%3Fjoined%3D1">Join Acme</a></main></body></html>');return; }
 if (url.pathname === "/__mock/join-done") { const page=joinDonePage({outcome:"joined",orgName:"Acme",role:"member",invitedOrgName:"Acme",inviterName:"Maya",codeChallenge:"test-fixture",expiresAt:0},origin);response.writeHead(200,CONFIRM_PAGE_HEADERS);response.end('<!doctype html><html lang="en"><head><title>'+escapeHtml(page.title)+'</title>'+SERVER_PAGE_ICON+'</head><body><main><h1>'+escapeHtml(page.title)+'</h1>'+page.paragraphs.map(line=>'<p>'+escapeHtml(line)+'</p>').join('')+(page.links??[]).map(link=>'<a href="'+escapeHtml(link.href)+'">'+escapeHtml(link.label)+'</a>').join('')+'</main></body></html>');return; }
 if (url.pathname === "/v1/auth/browser/authorize") {
 if (refusedSignIn) { response.writeHead(303, { location: "/app/signed-out?reason=removed" });response.end();return; }
 const path = url.searchParams.get("return_to") ?? "/app";const target = BROWSER_RETURN_TO.test(path) ? path : "/app";
 response.writeHead(200, { ...CONFIRM_PAGE_HEADERS });response.end(`<!doctype html><html lang="en"><head><title>Mock sign in</title>${SERVER_PAGE_ICON}</head><body><main><h1>Sign in to the mock cell</h1><form method="post" action="/v1/auth/browser/callback"><input type="hidden" name="return_to" value="${target.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"><button>Sign in</button></form></main></body></html>`);return;
 }
 if (url.pathname === "/v1/auth/browser/callback" && method === "POST") {
 let body = "";for await (const chunk of request) body += String(chunk);const path = new URLSearchParams(body).get("return_to") ?? "/app";revoked = false;expired = false;
 response.writeHead(303, { location: path === "/app/welcome?joined=1" ? "/__mock/join-done" : BROWSER_RETURN_TO.test(path) ? path : "/app", "set-cookie": `__Host-agentx_review_session=${FIXTURE_SESSION}; Path=/; Secure; HttpOnly; SameSite=Strict` });response.end();return;
 }
 // Stands in for GitHub's install page. Playwright's WebKit refuses to fulfil a stubbed request with a 3xx status, so the test serves this
 // 200 page (through route.fetch, from this cell) and the page itself moves on to the cell's 303 below.
 if (url.pathname === "/__mock/github-landing") { response.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>GitHub install</title><meta http-equiv="refresh" content="0;url='+origin+'/__mock/github-install"></head><body></body></html>');return; }
 if (url.pathname === "/__mock/github-install") { onboardingConnected=true;response.writeHead(303,{location:"/app/onboard?github=connected"});response.end();return; }
 if (url.pathname.startsWith("/v1/app/approve/")) {
 try { requireDecideNavigation({ method, path: url.pathname, headers }); } catch { response.writeHead(403, CONFIRM_PAGE_HEADERS);response.end("Open this approval from its link.");return; }
 if (method === "POST") { const cards = current.home.cards.filter(card => !card.buttons.some(button => button.action === "confirm" && button.href !== undefined && new URL(button.href).pathname === url.pathname));current.home = homeFixture({ cards, total: Math.max(0, current.home.total - (current.home.cards.length - cards.length)) });json(200, { decided: true });return; }
 const page = confirmPage({ title: "Confirm sharing this session", facts: [{ label: "Project", value: "payments" }] }, { approvalId: "apr_aaaaaaaaaaaaaaaaaaaa", csrf: csrfTokenFor(FIXTURE_SESSION) });response.writeHead(page.statusCode, page.headers);response.end(page.body);return;
 }
 if (url.pathname.startsWith("/v1/web/") || url.pathname === "/v1/auth/browser/sign-out") {
 if (url.pathname.startsWith("/v1/web/") && !webRouteAllowed(method, url.pathname)) { json(404, { error: { code: "NOT_FOUND", message: "Not found." } });return; }
 const webCaller = await authenticateWebRequest(deps, { method, path: url.pathname, headers, requestId: "mock-request" });
 // Health and readiness journey: fixed answers for its reads, only after a test chose a variant.
 if (current.name === "admin" && method === "GET") { const health = healthAnswer(url);if (health !== undefined) { json(health.status, health.body);return; } }
 // B7/B11 exercise reviewed lifecycle routes against the persisted transaction/audit table.
 if (current.name === "admin" && ((method === "GET" && /^\/v1\/web\/projects\/[^/]+\/(?:archive|restore)-preview$/.test(url.pathname)) || (method === "POST" && /^\/v1\/web\/projects\/[^/]+\/reviewed-(?:archive|restore)$/.test(url.pathname)))) {
  let body: unknown;if (method === "POST") { let raw = "";for await (const chunk of request) { raw += String(chunk);if (raw.length > 4096) throw new Error("Mock body limit."); }body = JSON.parse(raw) as unknown;evidence.body = body; }
  const result = await adminDirectory.request(deps, webCaller, method, url.pathname.replace("/v1/web/", "/v1/app/"), body);json(200,result);return;
 }
 if (current.name === "admin" && method === "GET" && url.pathname === "/v1/web/org/service-status") { const result = await adminDirectory.request(deps, webCaller, method, (url.pathname + url.search).replace("/v1/web/", "/v1/app/"), undefined, headers);json(200, result);return; }
 // Start preview reads the actual canonical policy through the cookie-authenticated route.
 if (current.name === "project" && method === "POST" && /^\/v1\/web\/projects\/[^/]+\/start-preview$/.test(url.pathname)) {
  let raw = "";for await (const chunk of request) { raw += String(chunk);if (raw.length > 4096) throw new Error("Mock body limit."); }
  const result = await adminDirectory.request(deps, webCaller, method, url.pathname.replace("/v1/web/", "/v1/app/"), JSON.parse(raw) as unknown, headers);json(200, typeof result === "object" && result !== null && !Array.isArray(result) ? { ...result, requestId: "mock-gateway-request" } : result);return;
 }
 // B33: the real browser-only website route adapter over the persisted directory.
 if(current.name==="admin" && /^\/v1\/web\/projects\/[^/]+\/allowed-websites(?:\/.*)?$/.test(url.pathname)) {
  let body:unknown;if(method!=="GET"){let raw="";for await(const chunk of request){raw+=String(chunk);if(raw.length>16384)throw new Error("Mock body limit.");}body=JSON.parse(raw) as unknown;}
  const result=await adminDirectory.request(deps,webCaller,method,(url.pathname+url.search).replace("/v1/web/","/v1/app/"),body,headers);json(200,result);return;
 }
 // B34: reviewed stored Slack evidence and unbind use real cookie handlers.
 if (current.name === "admin" && /^\/v1\/web\/projects\/[^/]+\/slack-channel\/(links|review|requests\/[^/]+|decisions\/[^/]+|unbind|proposals(?:\/[^/]+(?:\/(?:approve|cancel|reject))?)?)$/.test(url.pathname)) {
  let body: unknown;if (method !== "GET") { let raw = "";for await (const chunk of request) { raw += String(chunk);if (raw.length > 16384) throw new Error("Mock body limit."); }body = JSON.parse(raw) as unknown; }
  const result = await adminDirectory.request(deps, webCaller, method, (url.pathname + url.search).replace("/v1/web/", "/v1/app/"), body, headers);json(200, result);return;
 }
 // B32: browser-only save and database status use the same real route adapter.
 if(current.name==="admin"&&((method==="POST"&&/^\/v1\/web\/projects\/[^/]+\/working-branches$/.test(url.pathname))||(method==="GET"&&/^\/v1\/web\/projects\/[^/]+\/working-branches\/requests\/[^/]+$/.test(url.pathname)))){
  let body:unknown;if(method==="POST"){let raw="";for await(const chunk of request){raw+=String(chunk);if(raw.length>4096)throw new Error("Mock body limit.");}body=JSON.parse(raw) as unknown;}
  const result=await adminDirectory.request(deps,webCaller,method,(url.pathname+url.search).replace("/v1/web/","/v1/app/"),body,headers);json(200,result);return;
 }
 // B23: real cookie gate, project context/core and scoped SDK over synthetic HTTP/bindings.
 if(current.name==="admin"&&method==="GET"&&/^\/v1\/web\/projects\/[^/]+\/(?:working-branches|repositories\/[^/]+\/branches(?:\/preview)?)$/.test(url.pathname)){
  const result=await adminDirectory.request(deps,webCaller,method,(url.pathname+url.search).replace("/v1/web/","/v1/app/"),undefined,headers);json(200,result);return;
 }
 // M47: the same cookie/CSRF boundary and actual Spending adapters, over persisted fixture rows.
 if (current.name === "admin" && /^\/v1\/web\/org\/task-stop-policy(?:\/projects\/[^/]+)?(?:\/(editing|decisions|enrollment|cutover-review))?$/.test(url.pathname)) {
  let body: unknown;if (method !== "GET") { let raw = "";for await (const chunk of request) { raw += String(chunk);if (raw.length > 16384) throw new Error("Mock body limit."); }body = JSON.parse(raw) as unknown; }
  const result = await adminDirectory.request(deps, webCaller, method, (url.pathname + url.search).replace("/v1/web/", "/v1/app/"), body, headers);json(200, typeof result === "object" && result !== null && !Array.isArray(result) ? { ...result, requestId: "mock-gateway-request" } : result);return;
 }
 if (current.name === "admin" && method === "GET") { const spending = spendingAnswer(url, origin);if (spending !== undefined) { json(spending.status, spending.body);return; } }
 // Lane B: real read handlers; the scenario endpoint seeds only synthetic persisted rows.
 if (current.name === "admin" && method === "GET" && (url.pathname === "/v1/web/projects" || /^\/v1\/web\/projects\/[^/]+(?:\/members)?$/.test(url.pathname) || url.pathname === "/v1/web/agents" || /^\/v1\/web\/agents\/[^/]+\/versions$/.test(url.pathname) || url.pathname === "/v1/web/org/agent-guardrails")) {
  const result = await adminDirectory.request(deps, webCaller, method, (url.pathname + url.search).replace("/v1/web/", "/v1/app/"));json(200,result);return;
 }
 if (current.name === "admin" && ((method === "GET" && (url.pathname === "/v1/web/me" || url.pathname === "/v1/web/org/members" || url.pathname === "/v1/web/org/budget-settings" || url.pathname === "/v1/web/org/model-sources" || url.pathname === "/v1/web/org/invites" || /^\/v1\/web\/org\/invites\/[^/]+$/.test(url.pathname) || /^\/v1\/web\/org\/members\/[a-f0-9]{64}\/removal-preview$/.test(url.pathname) || /^\/v1\/web\/org\/removals\/[^/]+$/.test(url.pathname) || /^\/v1\/web\/org\/invites\/requests\/[^/]+$/.test(url.pathname))) || (method === "POST" && (url.pathname === "/v1/web/org/invites/reviewed" || /^\/v1\/web\/org\/members\/[a-f0-9]{64}\/removal$/.test(url.pathname) || /^\/v1\/web\/org\/invites\/[^/]+\/revoke$/.test(url.pathname))) || (method === "PUT" && (url.pathname === "/v1/web/org/model-sources-order" || /^\/v1\/web\/org\/members\/[a-f0-9]{64}\/role$/.test(url.pathname))))) {
  let body: unknown;if (method === "PUT" || method === "POST") { let raw = "";for await (const chunk of request) { raw += String(chunk);if (raw.length > 4096) throw new Error("Mock body limit."); }body = JSON.parse(raw) as unknown;evidence.body = body; }
  if (method === "GET" && (url.pathname.endsWith("/members") || url.pathname.endsWith("/model-sources")) && adminReadFailures > 0) { adminReadFailures--;json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "Fixture unavailable" } });return; }
  adminDirectory.setName(adminMemberName);const result = await adminDirectory.request(deps, webCaller, method, (url.pathname + url.search).replace("/v1/web/", "/v1/app/"), body);if (method === "PUT" && adminFailAfterWrite) { adminReadFailures = 3;adminFailAfterWrite = false; }if (method === "POST" && url.pathname === "/v1/web/org/invites/reviewed" && adminLoseCreateAck) { adminLoseCreateAck = false;json(503,{error:{code:"RUNTIME_UNAVAILABLE",message:"Fixture unavailable"}});return; }current.nav.me.orgRole = adminDirectory.roleOf(FIXTURE_DEVELOPER);current.me.developer.orgRole = adminDirectory.roleOf(FIXTURE_DEVELOPER);json(200, typeof result === "object" && result !== null && !Array.isArray(result) ? { ...result, requestId: "mock-gateway-request" } : result);return; /* the real broker adds the gateway's requestId to every object answer (json-reply.ts) */
 }
 if (url.pathname === "/v1/auth/browser/sign-out") { revoked = true;response.writeHead(204, { "set-cookie": "__Host-agentx_review_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0" });response.end();return; }
 if (url.pathname === "/v1/web/nav") { json(200, current.nav);return; }
 if (url.pathname === "/v1/web/me") { json(200, { ...current.me, csrf: appCsrfTokenFor(FIXTURE_SESSION) });return; }
 if(current.name==="onboarding") {
 const body=async()=>{let raw="";for await(const chunk of request)raw+=String(chunk);return JSON.parse(raw) as unknown;};
 if(url.pathname==="/v1/web/org"&&method==="PATCH"){const input=RenameOrganizationBodySchema.parse(await body());evidence.body=input;current.me.org={...current.me.org,name:input.name,nameIsDefault:false};json(200,RenameOrganizationResponseSchema.parse({org:current.me.org,role:"owner"}));return;}
 if(url.pathname==="/v1/web/github/connect"&&method==="POST"){const result=GithubConnectResponseSchema.parse({installUrl:"https://github.com/apps/rovara/installations/new",expiresAt:"2026-10-26T12:00:00.000Z"});json(200,result);return;}
 if(url.pathname==="/v1/web/github/installations"){json(200,GithubInstallationsResponseSchema.parse({installations:onboardingConnected||url.searchParams.has("fixture")?[{installationId:55,accountLogin:"acme",accountType:"Organization",repositorySelection:"selected",status:"active"}]:[]}));return;}
 if(url.pathname==="/v1/web/github/repositories"){json(200,GithubRepositoriesResponseSchema.parse({repositories:[{fullName:"acme/payments",githubRepositoryId:101,private:true,defaultBranch:"main"}]}));return;}
 if(url.pathname==="/v1/web/projects"&&method==="POST"){const input=CreateProjectBodySchema.parse(await body());evidence.body=input;onboardingProject=AppProjectDetailSchema.parse({name:input.name??"payments",description:input.description??"",status:"active",latestRevision:1,repositories:[{fullName:input.repository,defaultBranch:"main"}],myRole:"maintainer",setup:{status:"unchecked"},settings:{setupCommands:[],testCommands:[],devcontainer:null,allowedDomains:[]},createdAt:"2026-10-23T12:00:00.000Z",createdBy:{developerId:FIXTURE_DEVELOPER,name:"Priya"}});json(201,CloudProjectCreatedResponseSchema.parse({duplicate:false,project:{definition:{name:onboardingProject.name},registeredAt:"2026-10-23T12:00:00.000Z"}}));return;}
 if(onboardingProject&&url.pathname.startsWith("/v1/web/projects/"+onboardingProject.name)){
 if(await testEnvironmentMock({url,method,body,json,record:value=>{evidence.body=value;}},{get:()=>onboardingProject!,set:value=>{onboardingProject=value;}}))return;
 if(url.pathname.endsWith("/settings")&&method==="PUT"){const input=ProjectSettingsBodySchema.parse(await body());evidence.body=input;onboardingProject=AppProjectDetailSchema.parse({...onboardingProject,latestRevision:onboardingProject.latestRevision+1,settings:{...onboardingProject.settings,...input}});json(200,ProjectSettingsResponseSchema.parse({project:onboardingProject,warnings:[]}));return;}
 if(url.pathname.endsWith("/setup-check")&&method==="POST"){evidence.body=ProjectSetupCheckBodySchema.parse(await body());onboardingProject={...onboardingProject,setup:{status:"ready",checkedRevision:onboardingProject.latestRevision}};json(202,ProjectSetupCheckResponseSchema.parse({project:onboardingProject}));return;}
 if(url.pathname.endsWith("/setup-draft")&&method==="POST"){const input=await body() as {requestId?:unknown};evidence.body=input;onboardingDraft="drafting";json(202,SetupDraftResponseSchema.parse({status:"drafting",basedOnRevision:onboardingProject.latestRevision}));return;}
 if(url.pathname.endsWith("/setup-draft")&&method==="GET"){if(onboardingDraft==="drafting")onboardingDraft="ready";if(onboardingDraft!=="ready"){json(200,SetupDraftResponseSchema.parse({status:"none",basedOnRevision:onboardingProject.latestRevision}));return;}json(200,SetupDraftResponseSchema.parse(setupDraftFixture(onboardingProject)));return;}
 if(url.pathname.endsWith("/setup-draft/apply")&&method==="POST"){const input=SetupApplyBodySchema.parse(await body());evidence.body=input;const picked=new Set(input.items.map(entry=>entry.id));if(!onboardingChecks.has(input.requestId)){onboardingChecks.add(input.requestId);json(200,SetupApplyResponseSchema.parse({project:onboardingProject,warnings:[],setupCheck:"not_needed",results:input.items.map(entry=>({id:entry.id,kind:entry.id.startsWith("tests")?"tests":"setup",outcome:"checking",message:"Rovara is running these commands on a fresh machine. Nothing is saved until they pass."}))}));return;}onboardingProject=AppProjectDetailSchema.parse({...onboardingProject,latestRevision:onboardingProject.latestRevision+1,settings:{...onboardingProject.settings,...(picked.has("setup-payments")?{setupCommands:["npm ci"]}:{}),...(picked.has("tests-payments")?{testCommands:["npm test"]}:{})}});json(200,SetupApplyResponseSchema.parse({project:onboardingProject,warnings:[],setupCheck:"not_needed",results:input.items.map(entry=>({id:entry.id,kind:entry.id.startsWith("tests")?"tests":"setup",outcome:"applied"}))}));return;}
 if(url.pathname.endsWith("/agents/rovara-code")&&method==="PUT"){json(200,ProjectRosterAddedResponseSchema.parse({agent:{agentId:"rovara-code",name:"Rovara Code"}}));return;}
 if(method==="GET"&&!url.pathname.endsWith("/overview")){json(200,onboardingProject);return;}
 }
 if(url.pathname==="/v1/web/agents"&&method==="GET"){json(200,AgentDirectoryResponseSchema.parse({agents:[]}));return;}
 }
 if(current.builder!==undefined&&current.agent!==undefined){
 const draftPath="/v1/web/agents/"+current.agent.agent.agentId+"/draft";
 const resolveDraft=()=>applyOverlay(current.builder!.base??EMPTY_RECIPE,current.builder!.draft.overlay,{agentId:current.agent!.agent.agentId,name:current.agent!.agent.name,version:"draft",builtin:false});
 if(url.pathname==="/v1/web/budget"&&method==="GET"){json(200,BuilderTestingBudgetSchema.parse({month:"2026-10",perTestCapUsd:2,testing:{limitUsd:10,spentUsd:2,committedUsd:1}}));return;}
 if(url.pathname===draftPath.replace(/\/draft$/,"/diff")&&method==="GET"){const from=url.searchParams.get("from"),to=url.searchParams.get("to"),recipe=(value:string|null)=>value==="draft"?resolveDraft():value==="base"?current.builder!.base:current.agentRecipes?.[value??""];const before=recipe(from),after=recipe(to);if(!before||!after){json(404,{error:{code:"NOT_FOUND",message:"Version not found."}});return;}json(200,AgentDiffResponseSchema.parse({from:from==="base"||from==="draft"?from:Number(from),to:to==="draft"?to:Number(to),changes:diffRecipes(before,after),lessSafe:[],comparison:{before,after}}));return;}
 if(url.pathname===draftPath.replace(/\/draft$/,"/publish")&&method==="POST"){let body="";for await(const chunk of request)body+=String(chunk);const input=AgentPublishBodySchema.parse(JSON.parse(body));evidence.body=input;if(input.expectedRevision!==current.builder.draft.revision){json(409,{error:{code:"AGENT_REVISION_CONFLICT",message:"Someone else changed this agent's draft. Reload it and make your change again."}});return;}const number=current.agent.agent.latestVersion+1,recipe=resolveDraft();recipe.chain=recipe.chain.map(layer=>layer.agentId===current.agent!.agent.agentId?{...layer,version:number}:layer);const version=AgentVersionViewSchema.parse({version:number,publishedBy:FIXTURE_DEVELOPER,publishedAt:"2026-10-23T14:00:00.000Z",note:input.note,origin:current.builder.draft.origin});current.agent=AgentProfileResponseSchema.parse({...current.agent,agent:{...current.agent.agent,currentVersion:number,latestVersion:number},current:{version:number,recipe,changed:false}});current.agentRecipes={...current.agentRecipes,[number]:recipe};current.agentVersions=[version,...current.agentVersions??[]];json(200,AgentPublishResponseSchema.parse({agent:current.agent.agent,version}));return;}
 if(url.pathname==="/v1/web/models"&&method==="GET"){json(200,ModelListSchema.parse({models:[{provider:"openai",modelId:"gpt-5.4",label:"GPT-5.4",company:"openai",sources:["rovara"]}]}));return;}
 if(url.pathname==="/v1/web/org/agent-guardrails"&&method==="GET"){json(200,{guardrails:{maxAutonomy:"prepare"},revision:1});return;}
 if(url.pathname==="/v1/web/skills"&&method==="GET"){json(200,{skills:[]});return;}
 if(url.pathname==="/v1/web/agents"&&method==="POST"){let body="";for await(const chunk of request)body+=String(chunk);const input=AgentCreateBodySchema.parse(JSON.parse(body));evidence.body=input;current.builder=builderFixture();current.agent=AgentProfileResponseSchema.parse({...current.agent,agent:{...current.agent.agent,name:input.name,description:input.description??"",currentVersion:undefined,latestVersion:0,draftRevision:1},current:undefined});json(201,AgentWriteResponseSchema.parse({agent:current.agent.agent}));return;}
 if(url.pathname===draftPath&&method==="GET"){json(200,AgentDraftResponseSchema.parse(current.builder));return;}
 if(url.pathname===draftPath&&method==="PUT"){let body="";for await(const chunk of request)body+=String(chunk);const input=AgentDraftPutBodySchema.parse(JSON.parse(body));evidence.body=input;if(input.expectedRevision!==current.builder.draft.revision){json(409,{error:{code:"AGENT_REVISION_CONFLICT",message:"Someone else changed this agent's draft. Reload it and make your change again."}});return;}current.builder=AgentDraftResponseSchema.parse({...current.builder,draft:{...current.builder.draft,overlay:input.overlay,revision:input.expectedRevision+1}});json(200,AgentDraftResponseSchema.parse({draft:current.builder.draft}));return;}
 }
 if (current.agent !== undefined) {
  const agent = current.agent.agent, agentPath = "/v1/web/agents/" + agent.agentId;
  const builtin = { agentId: "ticket-triage", name: "Ticket triage", description: "Investigate an issue before deciding what to change.", builtin: true, access: "use", status: "active", pinnedVersion: 1, latestVersion: 1 };
  if (url.pathname === "/v1/web/agents" && method === "GET") { const scope = url.searchParams.get("scope") ?? "all", own = {...agentDirectory().agents[0]!,...current.agent.agent};json(200, AgentDirectoryResponseSchema.parse({ agents: scope === "builtin" ? [builtin] : scope === "mine" || scope === "shared" ? [own] : [own, builtin] }));return; }
  if (url.pathname === agentPath && method === "GET") { json(200, current.agent);return; }
  if (url.pathname === "/v1/web/agents/ticket-triage" && method === "GET") { const recipe = agentProfile().current!.recipe!;json(200, AgentProfileResponseSchema.parse({ agent: builtin, current: { version: 1, changed: false, recipe: { ...recipe, chain: recipe.chain.slice(0, 1), instructions: recipe.instructions.slice(0, 1) } }, suggestedMaxPerRunUsd: 2 }));return; }
  if (url.pathname === agentPath + "/versions" && method === "GET") { json(200, AgentVersionsResponseSchema.parse({ versions:(current.agentVersions??[]).map(version=>({...version,current:version.version===agent.currentVersion})) }));return; }
  if (url.pathname === agentPath + "/spend" && method === "GET") { json(200, AgentSpendResponseSchema.parse({ month: url.searchParams.get("month"), totalUsd: 3.25, byOrigin: { person: 2, autonomous: 1, test: 0.25 }, recentRuns: [] }));return; }
  if (url.pathname === agentPath + "/shares" && method === "GET") { json(200, AgentSharesResponseSchema.parse({ shares: current.agentShares ?? [] }));return; }
  if (url.pathname === agentPath + "/shares" && method === "PUT") { let body = "";for await (const chunk of request) body += String(chunk);const input = JSON.parse(body) as Record<string, unknown>, requestId = SessionMakeAgentBodySchema.shape.requestId.parse(input.requestId), shares = Array.isArray(input.shares) ? input.shares.map(value => AgentShareInputSchema.parse(value)) : undefined;if (shares === undefined) throw new Error("Invalid mock shares");evidence.body = { requestId, shares };current.agentShares = AgentSharesResponseSchema.parse({ shares: shares.map(share => ({ ...share, grantedBy: FIXTURE_DEVELOPER, grantedAt: "2026-10-23T12:00:00.000Z" })) }).shares;json(200, AgentSharesPutResponseSchema.parse({ shares }));return; }
  if (url.pathname === agentPath + "/owner" && method === "PUT") { let body = "";for await (const chunk of request) body += String(chunk);const input = AgentOwnerPutBodySchema.parse(JSON.parse(body));evidence.body = input;current.agent = AgentProfileResponseSchema.parse({ ...current.agent, agent: { ...agent, owner: input.owner, ...(input.accountable === undefined ? {} : { accountable: input.accountable }) } });json(200, AgentWriteResponseSchema.parse({ agent: current.agent.agent }));return; }
  if (url.pathname === "/v1/web/projects" && method === "GET") { json(200, AppProjectsResponseSchema.parse({ projects: ["payments", "checkout"].map(name => ({ name, status: "active", latestRevision: 1, repositories: [], myRole: "contributor", setup: { status: "ready" } })) }));return; }
 }
 if (await taskLessonsMock({ url, method, json, record: value => { evidence.body = value; }, body: async () => { let text = "";for await (const chunk of request) text += String(chunk);return text === "" ? {} : JSON.parse(text) as unknown; } })) return;
 if (await learningSettingsMock({ url, method, json, record: value => { evidence.body = value; }, body: async () => { let text = "";for await (const chunk of request) text += String(chunk);return text === "" ? {} : JSON.parse(text) as unknown; } })) return;
 if (await companyPolicyMock({ url, method, record: value => { evidence.body = value; }, json, body: async () => { let text = "";for await (const chunk of request) text += String(chunk);return text === "" ? {} : JSON.parse(text) as unknown; } })) return;
 if (current.project !== undefined && url.pathname === "/v1/web/projects/" + current.project.project.name + "/overview" && method === "GET") { json(200, current.name === "project" ? { ...current.project, learning: overviewLearning() } : current.project);return; }
 if (current.project !== undefined && current.project.project.name === "payments" && await intakeMock({ url, method, json, record: value => { evidence.body = value; }, body: async () => { let text = "";for await (const chunk of request) text += String(chunk);return text === "" ? {} : JSON.parse(text) as unknown; } })) return;
 if (current.project !== undefined && current.project.project.name === "payments" && await lessonsMock({ url, method, json, record: value => { evidence.body = value; }, body: async () => { let text = "";for await (const chunk of request) text += String(chunk);return text === "" ? {} : JSON.parse(text) as unknown; } })) return;
 if (current.project !== undefined && current.project.project.name === "payments" && await learningMock({ url, method, json, record: value => { evidence.body = value; }, body: async () => { let text = "";for await (const chunk of request) text += String(chunk);return text === "" ? {} : JSON.parse(text) as unknown; } })) return;
 if (current.project !== undefined && current.project.project.name === "payments" && await howWeWorkMock({ url, method, json, record: value => { evidence.body = value; }, body: async () => { let text = "";for await (const chunk of request) text += String(chunk);return JSON.parse(text) as unknown; } })) return;
 const code = /^\/v1\/web\/projects\/([^/]+)\/code$/.exec(url.pathname);
 if (current.project !== undefined && current.session !== undefined && code !== null && method === "POST") {
  let body = "";for await (const chunk of request) { body += String(chunk);if (body.length > 20000) throw new Error("Mock body limit"); }
  const input = CodeIntentBodySchema.parse(JSON.parse(body));
  if (code[1] !== current.project.project.name) { json(404, { error: { code: "PROJECT_NOT_FOUND", message: "Not found." } });return; }
  evidence.body = input;json(202, { task: taskFixture({ sessionId: current.session.sessionId }), sessionId: current.session.sessionId, sessionUrl: origin + "/app/sessions/" + current.session.sessionId });return;
 }
 const run = /^\/v1\/web\/agents\/([^/]+)\/runs$/.exec(url.pathname);
 if (current.project !== undefined && run !== null && method === "POST") {
  let body = "";for await (const chunk of request) { body += String(chunk);if (body.length > 20000) throw new Error("Mock body limit"); }
  const input=AgentRunBodySchema.parse(JSON.parse(body)),agent=AgentIdSchema.parse(run[1]),project=ProjectOverviewSchema.shape.project.shape.name.parse(input.project);
  if (agent === "rovara-code" || project !== current.project.project.name || (input.version!=="draft"&&!current.project.agents.some(item => item.agentId === agent))) { json(404, { error: { code: "NOT_FOUND", message: "Agent not available." } });return; }
  evidence.body = input;json(202, TaskResponseSchema.parse({ task: taskFixture({ sessionId: current.session!.sessionId }) }));return;
 }
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
 if (url.pathname === path + "/agent" && method === "POST" && current.agent !== undefined) {
  if (!session.you.actions.includes("make_agent")) { json(403, { error: { code: "FORBIDDEN", message: "This task cannot create a workflow." } });return; }
  let body = "";for await (const chunk of request) body += String(chunk);const input = SessionMakeAgentBodySchema.parse(JSON.parse(body));evidence.body = input;
  const agent = { ...current.agent.agent, agentId: "agt_bbbbbbbbbbbbbbbbbbbb", name: input.name ?? session.title, currentVersion: undefined, latestVersion: 0, draftRevision: 1, owner: { kind: "project", project: "payments" }, accountable: { developerId: FIXTURE_DEVELOPER } };
  json(201, SessionMakeAgentResponseSchema.parse({ agent, draft: { overlay: { instructions: session.title }, extends: { agentId: AGENT_FIXTURE_ID, version: 3 }, revision: 1, updatedBy: FIXTURE_DEVELOPER, updatedAt: "2026-10-23T12:00:00.000Z", origin: { kind: "session", visible: true, sessionId: session.sessionId, title: session.title, link: origin + "/s/" + session.sessionId, createdBy: FIXTURE_DEVELOPER, createdAt: "2026-10-23T12:00:00.000Z" } }, copied: true }));return;
 }
 if (url.pathname === path + "/events" && method === "GET") { json(200, { events: [] });return; }
 // Live buttons: Ask about this task and Fix with agent. The answers are fixed; the page only reads them.
 if (url.pathname === path + "/ask" && method === "POST") { let body = "";for await (const chunk of request) { body += String(chunk);if (body.length > 4000) throw new Error("Mock body limit."); }evidence.body = JSON.parse(body) as unknown;json(202, { askId: "ask_aaaaaaaaaaaaaaaaaaaa", state: "queued" });return; }
 if (url.pathname === path + "/asks/ask_aaaaaaaaaaaaaaaaaaaa" && method === "GET") { json(200, { askId: "ask_aaaaaaaaaaaaaaaaaaaa", state: "answered", answer: "The check failed because the lockfile is stale. <img src=x onerror=alert(1)>" });return; }
 if (url.pathname === "/v1/web/diagnoses" && method === "POST") { let body = "";for await (const chunk of request) { body += String(chunk);if (body.length > 4000) throw new Error("Mock body limit."); }const input = JSON.parse(body) as { errorRef?: unknown };evidence.body = input;json(202, { diagnosisId: "dgn_aaaaaaaaaaaaaaaaaaaa", tier: "light", state: "queued", errorRef: input.errorRef });return; }
 if (url.pathname === "/v1/web/diagnoses/dgn_aaaaaaaaaaaaaaaaaaaa" && method === "GET") { json(200, { diagnosisId: "dgn_aaaaaaaaaaaaaaaaaaaa", tier: "light", state: "ready", errorRef: session.errorRef, proposals: [{ kind: "explain", text: "Refunds were retried with a stale lockfile." }, { kind: "settings_change", target: "code_settings", path: "install.command", from: "npm install", to: "npm ci", citations: ["package-lock.json"] }], droppedProposals: 0 });return; }
 if (url.pathname === path + "/presence" && method === "POST") { json(200, { viewingNow: session.viewingNow });return; }
 // Understand's questions (playbook S3): answers are taken against the revision the page read; a workflow that moved on is INTENT_NOT_WAITING, as the broker answers.
 if (url.pathname === path + "/answers" && method === "POST") {
  let body = "";for await (const chunk of request) { body += String(chunk);if (body.length > 12000) throw new Error("Mock body limit."); }
  const input = JSON.parse(body) as { revision?: number; round?: number };evidence.body = input;
  if (input.revision !== session.revision || input.round !== 1) { json(409, { error: { code: "INTENT_NOT_WAITING", message: "This task isn't waiting for answers." } });return; }
  current.session = understandSession({ waiting: false, revision: session.revision + 1 });json(200, { session: current.session });return;
 }
 // "Make a change anyway" after an Answered task (R1b): the route starts a new task and its session (202); the mock then serves that new, running session, as the browser opens it.
 if (url.pathname === path + "/change-anyway" && method === "POST") {
  let body = "";for await (const chunk of request) { body += String(chunk);if (body.length > 4000) throw new Error("Mock body limit."); }
  evidence.body = JSON.parse(body) as unknown;
  const next = "ses_bbbbbbbbbbbbbbbbbbbb";
  current.session = SessionViewSchema.parse({ ...understandSession({ waiting: false }), sessionId: next });
  json(202, { task: taskFixture({ sessionId: next }), sessionId: next, sessionUrl: origin + "/app/sessions/" + next });return;
 }
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
 if (current.work !== undefined && (url.pathname === "/v1/web/live" || url.pathname === "/v1/web/sessions") && method === "GET") { json(200, workAnswer(current.work, url));return; }
 if (url.pathname === "/v1/web/live" && method === "GET") { json(200, LiveResponseSchema.parse({ tiles: (current.live ?? []).filter(tile => (url.searchParams.get("filter") !== "needs_me" || tile.needsYou) && (!url.searchParams.has("project") || tile.project === url.searchParams.get("project"))) }));return; }
 if (url.pathname === "/v1/web/home") { json(200, current.name === "project" ? homeFixture({ cards: [...homeSuggestionCards(), ...intakeHomeCards(origin)] as never }) : current.home);return; }
 if (url.pathname === "/v1/web/realtime/token" && method === "POST") { json(200, RealtimeTokenResponseSchema.parse({ token: "fixture-realtime-value", expiresAt: new Date(Date.now() + 900_000).toISOString(), endpoint: origin.replace("https:", "wss:") + "/event/realtime", channels: { user: userChannel(FIXTURE_ORG, FIXTURE_DEVELOPER), projects: { payments: projectChannel(FIXTURE_ORG, "payments") } } }));return; }
 if (url.pathname === "/v1/web/changes") { json(200, { notices: current.changes ?? [], next: "settled" });return; }
 json(404, { error: { code: "NOT_FOUND", message: "This mock route is not configured." } });return;
 }
 const page = await handler({ rawPath: url.pathname, headers, requestContext: { http: { method } } });response.writeHead(page.statusCode, page.headers);response.end(page.isBase64Encoded ? Buffer.from(page.body, "base64") : page.body);
 } catch (error) { if (error instanceof AgentXError) json(errorStatus(error.code), { error: { code: error.code, message: error.message } });else json(500, { error: { code: "MOCK_UNAVAILABLE", message: "The mock cell could not complete this request." } }); }
}
const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => { void handleRequest(request, response).catch(() => { if (!response.headersSent) response.writeHead(500);response.end("Mock cell unavailable."); }); });
server.listen(mockCellPort(), "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { server.close(() => process.exit(0)); });

/** The setup agent's proposal for the onboarding project: a setting with a verified source, an item whose source could not be found, and a risky item that gets its own card. */
function setupDraftFixture(project:{latestRevision:number}){
 const place=(path:string,line:number,quote:string)=>({kind:"file",repo:"payments",path,commit:"a".repeat(40),line,quote});
 const entry=(id:string,value:unknown,from:unknown[],risk:string)=>({id,value,from,confidence:"high",risk});
 return {status:"ready",basedOnRevision:project.latestRevision,proposal:{version:2,basedOnRevision:project.latestRevision,
  repositories:[entry("repo-https-github.com-acme-ledger",{name:"ledger",url:"https://github.com/acme/ledger"},[place("README.md",3,"ledger holds the books")],"needs_admin")],
  setup:[entry("setup-payments",{repo:"payments",commands:["npm ci"]},[place("package.json",4,"\"ci\": \"npm ci\"")],"safe")],
  tests:[entry("tests-payments",{repo:"payments",commands:["npm test"]},[place(".github/workflows/ci.yml",5,"run: npm test")],"safe")],
  checks:[],testEnvironment:[],knowledge:[],sources:[],intake:[],allowedDomains:[],secretsNeeded:[],flaggedCommands:[],foundNotUsed:[],notes:"Node 22 is needed."},
  review:[{id:"repo-https-github.com-acme-ledger",handling:"approval",verification:"verified",current:{state:"empty"}},{id:"setup-payments",handling:"settings",verification:"verified",current:{state:"empty"}},{id:"tests-payments",handling:"settings",verification:"unverified",current:{state:"empty"}}]};
}
