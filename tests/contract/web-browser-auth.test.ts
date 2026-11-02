import { createInviteAdminApi } from "../../packages/ui/src/api/invite-admin.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { developerOrgKey, orgMemberKey, orgRemovedKey, orgBanKey, orgEmailKey, orgProjectCatalogKey, projectAiKey, projectMemberKey, projectRevisionKey, projectMetaKey, StoredProjectDefinitionSchema, githubInstallationKey, orgGithubInstallationKey, type GithubInstallationRecord } from "@agentx/contracts";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { BROWSER_RETURN_TO } from "../../packages/broker/src/developer/server.js";
import { createTaskWebApi } from "../../packages/broker/src/aws/task-web-api.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { httpEvent, identityHarness } from "../support/developer-fakes.js";
import { bench } from "../support/audit-routes-bench.js";
import { createOnboardingApi } from "../../packages/ui/src/api/onboarding.js";
import { fakeHost } from "../web/support/fake-host.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { modelSourcesKey } from "@agentx/contracts";
import { TEST_ORG } from "../support/orgs.js";
const CELL = "https://cell.example", SID = "11111111-1111-4111-8111-111111111111", WHO = "a".repeat(64);
const COOKIE = `__Host-agentx_review_session=${SID}`;
const PERSON = { userId: "U0WEB001", name: "Web member", email: "web-fixture@example.test" };
const errorOf = (body: Record<string, unknown>) => body.error as { code: string; message: string };
async function broker(extra: Record<string, unknown> = {}, webOrigin?: string) {
 const verify = vi.fn(async (authorization: string | undefined) => authorization === "Bearer test-only-bearer" ? { iss: CELL + "/v1/auth", aud: "agentx-developer", sub: WHO, sid: SID, amr: "cloud", env: "staging", org: TEST_ORG, org_role: "owner" } : {});
 const methods = { slack: false, oidc: false, cloud: true };
 const h = await createAdminBroker({ developer: { issuer: CELL + "/v1/auth", ...(webOrigin === undefined ? {} : { webOrigin }), env: "staging", signInTableName: "signin", methods, verifyAccessToken: verify, channelMembers: async () => ({ ok: true, memberOf: [] }) }, extra });
 seedMembership(h.db, WHO, { orgId: TEST_ORG, role: "owner" });
 h.db.set({ pk: `DEVELOPER#${WHO}`, sk: "META", developerId: WHO, displayName: "Web member", provider: "cloud" });
 h.db.set({ pk: `SESSION#${SID}`, sk: "META", sessionId: SID, developerId: WHO, amr: "cloud", startedAt: new Date(Date.now() - 60000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 3600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
 async function call(method: string, path: string, headers: Record<string, string | undefined> = { cookie: COOKIE }, body?: unknown) {
  const response = await h.handler({ rawPath: path, routeKey: path.startsWith("/v1/web/") ? "ANY /v1/web/{proxy+}" : "ANY /v1/app/{proxy+}", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "web-auth-fixture", http: { method } } });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
 }
 return { ...h, call, verify, methods };
}
describe("browser API boundary", () => {
 it("shares create and revoke quotas across the real token and cookie request adapters", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-27T12:00:00Z"));
  try {
   const audit = capturingAuditDeps(), h = await broker({ audit: audit.audit });audit.attach(h.db);
   const headers = { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, token = { authorization: "Bearer test-only-bearer" };
   for (let i = 0; i < 20; i++) expect((await h.call("POST", i % 2 === 0 ? "/v1/web/org/invites" : "/v1/app/org/invites", i % 2 === 0 ? headers : token, { requestId: randomUUID(), role: "member" })).status).toBe(200);
   expect((await h.call("POST", "/v1/web/org/invites", headers, { requestId: randomUUID(), role: "member" })).status).toBe(429);
   const ref = h.db.find(row => row.entityType === "ORG_INVITE_DIRECTORY")[0]!, body = { requestId: randomUUID(), expectedRevision: 0 }, path = `/org/invites/${String(ref.inviteId)}/revoke`;
   for (let i = 0; i < 20; i++) expect((await h.call("POST", (i % 2 === 0 ? "/v1/web" : "/v1/app") + path, i % 2 === 0 ? headers : token, body)).status).toBe(200);
   expect((await h.call("POST", "/v1/web" + path, headers, body)).status).toBe(429);expect(audit.flushed().filter(event => String(event.action) === "org.invite_revoked").length).toBe(1);
  } finally { clock.mockRestore(); }
 });
 it("returns fixed accepted/revoked terminal codes through the real cookie error boundary", async () => {
  for (const state of ["acceptedAt", "revokedAt"] as const) {
   const audit = capturingAuditDeps(), h = await broker({ audit: audit.audit });audit.attach(h.db);const headers = { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) };
   expect((await h.call("POST", "/v1/web/org/invites", headers, { requestId: randomUUID(), role: "member", email: "private.person@example.test" })).status).toBe(200);
   const invite = h.db.find(row => row.entityType === "ORG_INVITE")[0]!;h.db.set({ ...invite, [state]: new Date().toISOString() });const response = await h.call("POST", `/v1/web/org/invites/${String(invite.inviteId)}/revoke`, headers, { requestId: randomUUID(), expectedRevision: 0 });expect(response.status).toBe(409);expect(errorOf(response.body)).toEqual({ code: state === "acceptedAt" ? "INVITE_ALREADY_ACCEPTED" : "INVITE_ALREADY_REVOKED", message: state === "acceptedAt" ? "This invite has already been accepted." : "This invite has already been revoked." });
  }
 });

 it("revokes indexed invites through real cookie CSRF routes with atomic replay and live authority", async () => {
  const audit = capturingAuditDeps(), h = await broker({ audit: audit.audit });audit.attach(h.db);
  const headers = { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) };
  const created = await h.call("POST", "/v1/web/org/invites", headers, { requestId: randomUUID(), role: "member", email: "private.person@example.test" });expect(created.status).toBe(200);
  const ref = h.db.find(row => row.entityType === "ORG_INVITE_DIRECTORY")[0]!, path = `/v1/web/org/invites/${String(ref.inviteId)}/revoke`, body = { requestId: randomUUID(), expectedRevision: 0 };
  expect((await h.call("POST", path, { cookie: COOKIE, origin: CELL }, body)).status).toBe(403);
  expect(h.db.find(row => row.entityType === "ORG_INVITE" && row.revokedAt !== undefined).length).toBe(0);
  const revoked = await h.call("POST", path, headers, body);expect(revoked.status).toBe(200);expect(revoked.body).toMatchObject({ inviteId: ref.inviteId, revision: 1 });expect(await h.call("POST", path, headers, body)).toEqual(revoked);
  expect((await h.call("GET", "/v1/web/org/invites")).body).toMatchObject({ invites: [], unavailableCount: 0 });
  expect(audit.flushed().filter(event => String(event.action) === "org.invite_revoked").length).toBe(1);
  seedMembership(h.db, WHO, { orgId: TEST_ORG, role: "member" });expect((await h.call("POST", path, headers, body)).status).toBe(403);
 });

 it("derives the app CSRF token from the exact session value", () => {
  expect(APP_CSRF_HEADER).toBe("x-rovara-csrf");expect(appCsrfTokenFor(SID)).toBe(createHash("sha256").update("rovara-app-csrf:" + SID).digest("base64url"));
 });
 it("uses a live cookie for web routes and leaves app routes token-only", async () => {
  const h = await broker();
  const browser = await h.call("GET", "/v1/web/projects"), token = await h.call("GET", "/v1/app/projects", { authorization: "Bearer test-only-bearer" });
  expect(browser.status).toBe(200);expect(browser.body).toEqual(token.body);
  const me = await h.call("GET", "/v1/web/me");expect(me.body.csrf).toBe(appCsrfTokenFor(SID));
  expect((await h.call("GET", "/v1/app/me", { authorization: "Bearer test-only-bearer" })).body.csrf).toBeUndefined();
  expect(errorOf((await h.call("GET", "/v1/app/projects")).body).code).toBe("AUTH_REQUIRED");
  for (const authorization of ["Bearer test-only-bearer", ""]) {
   const response = await h.call("GET", "/v1/web/projects", { cookie: COOKIE, Authorization: authorization });
   expect(response.status).toBe(401);expect(errorOf(response.body).message).toBe("Use the /v1/app routes with a token.");
  }
  h.methods.cloud = false;expect((await h.call("GET", "/v1/web/projects")).status).toBe(401);h.methods.cloud = true;
  h.db.set({ ...h.db.get(`SESSION#${SID}`, "META")!, revokedAt: new Date().toISOString() });
  const ended = await h.call("GET", "/v1/web/projects");expect(ended.status).toBe(401);expect(errorOf(ended.body).message).toBe("Sign in to continue.");
 });
 it("reads the masked invite directory through the cookie adapter and refuses live member access", async () => {
  const h = await broker();const created = await h.call("POST", "/v1/web/org/invites", { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, { requestId: randomUUID(), role: "member", email: "private.person@example.test" });expect(created.status).toBe(200);
  const page = await h.call("GET", "/v1/web/org/invites");expect(page.status).toBe(200);expect(page.body).toMatchObject({ coverage: "indexed_only", invites: [{ destination: { kind: "email", label: "***@example.test" } }] });const serialized = JSON.stringify(page.body);let token: string | null;try { token = new URL(String(created.body.inviteUrl)).searchParams.get("invite"); } catch { throw new Error("Invalid fixture invite link."); }expect(token !== null && /^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);expect(serialized.includes("private.person") || (token !== null && (serialized.includes(token) || serialized.includes(createHash("sha256").update(token).digest("hex"))))).toBe(false);
  seedMembership(h.db, WHO, { orgId: TEST_ORG, role: "member" });expect((await h.call("GET", "/v1/web/org/invites")).status).toBe(403);
 });
 it("refuses invite creation when the cookie actor is demoted after authentication", async () => {
  const h = await broker(), send = h.db.send.bind(h.db);let demote = true;h.db.send = async command => { const answer = await send(command);if (demote && command.constructor.name === "GetCommand" && (command.input as { Key?: { pk?: string } }).Key?.pk === `DEVELOPER_ORG#${WHO}`) { demote = false;seedMembership(h.db, WHO, { orgId: TEST_ORG, role: "member" }); }return answer; };
  const result = await h.call("POST", "/v1/web/org/invites", { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, { requestId: randomUUID(), role: "member" });expect(result.status).toBe(403);expect(h.db.find(row => row.entityType === "ORG_INVITE" || row.entityType === "ORG_INVITE_DIRECTORY" || row.entityType === "ORG_INVITE_REQUEST").length).toBe(0);expect(demote).toBe(false);
 });
 it("audits the existing onboarding invite client through the real cookie route atomically", async () => {
  const h = await broker(), host = fakeHost(async r => h.call(r.method, r.path.replace("/v1/app/", "/v1/web/"), { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, r.body));const result = await createOnboardingApi(host.host).invite({ requestId: randomUUID(), role: "member", email: "private.person@example.test" });expect(typeof result.inviteUrl === "string").toBe(true);const pending = h.db.find(row => String(row.pk).startsWith("AUDIT_PENDING#"));expect(pending.length).toBe(1);expect((pending[0]?.event as { action?: string }).action).toBe("org.invite_created");expect(h.db.transactions().some(items => items.some(item => "Put" in item && (item.Put as { Item?: { entityType?: string } } | undefined)?.Item?.entityType === "ORG_INVITE") && items.some(item => "Put" in item && String((item.Put as { Item?: { pk?: string } } | undefined)?.Item?.pk).startsWith("AUDIT_PENDING#")))).toBe(true);
 });
 it("checks Origin and CSRF before any write, with distinct stale recovery", async () => {
  const h = await broker();const body = { requestId: randomUUID(), role: "member" };
  for (const headers of [{}, { origin: CELL }, { origin: "null", [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, { origin: "https://evil.example", [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, { [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }]) {
   const start = h.db.commandNames().length;
   const response = await h.call("POST", "/v1/web/org/invites", { cookie: COOKIE, ...headers }, body);
   expect(response.status).toBe(403);expect(errorOf(response.body)).toEqual({ code: "FORBIDDEN", message: "This request didn't come from Rovara's app." });
   expect(h.db.commandNames().slice(start).filter(name => /Put|Update|Delete|TransactWrite/.test(name))).toEqual([]);
  }
  const start = h.db.commandNames().length;
  const stale = await h.call("POST", "/v1/web/org/invites", { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor("old-session") }, body);
  expect(stale.status).toBe(403);expect(errorOf(stale.body)).toEqual({ code: "CSRF_STALE", message: "Your sign-in changed in another tab. Trying again." });
  expect(h.db.commandNames().slice(start).filter(name => /Put|Update|Delete|TransactWrite/.test(name))).toEqual([]);
  for (const token of ["", "short", "😀".repeat(43)]) {
   const bad = await h.call("POST", "/v1/web/org/invites", { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: token }, body);
   expect(bad.status).toBe(403);expect(errorOf(bad.body).code).toBe("CSRF_STALE");
  }
  const good = await h.call("POST", "/v1/web/org/invites", { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, body);
  expect(good.status).toBe(200);expect(h.db.commandNames().slice(start)).toContain("TransactWriteCommand");
 });
 it("refuses cross-site reads before audit disclosure or a recorded read", async () => {
  const b = bench(), h = await broker({ auditLedger: b.deps });
  const blocked = await h.call("GET", "/v1/web/org/audit/records", { cookie: COOKIE, "Sec-Fetch-Site": "cross-site" });
  expect(blocked.status).toBe(403);expect(b.sqs.calls).toHaveLength(0);expect(b.h.db.commandNames()).toEqual([]);
  for (const headers of [{ cookie: COOKIE, "Sec-Fetch-Site": "same-origin" }, { cookie: COOKIE }]) expect((await h.call("GET", "/v1/web/org/audit/records", headers)).status).toBe(200);
  expect(b.sqs.calls.length).toBeGreaterThan(0);
 });
 it("keeps approval pages, decide endpoints, token-only identity management and unknown families out of web", async () => {
  const h = await broker();
  for (const [method, path] of [["GET", "/approve/apr_aaaaaaaaaaaaaaaaaaaa"], ["POST", "/approvals/apr_aaaaaaaaaaaaaaaaaaaa/decide"], ["POST", "/spend-requests/spr_aaaaaaaaaaaaaaaaaaaa/decide"], ["POST", "/devices/dvc_aaaaaaaaaaaaaaaaaaaa"], ["DELETE", "/me/identities/cloud"], ["GET", "/admin/keys"]]) expect((await h.call(method!, "/v1/web" + path!, { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) })).status, path).toBe(404);
 });
 it("lets a browser change only its own display name, with Origin and CSRF checked before the write", async () => {
  const h = await broker();const body = { name: "Web M" };
  const attempt = (headers: Record<string, string | undefined>, payload: unknown = body) => h.call("PUT", "/v1/web/me/name", headers, payload);
  for (const headers of [{ cookie: COOKIE }, { cookie: COOKIE, origin: CELL }, { cookie: COOKIE, origin: "https://evil.example", [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, { cookie: COOKIE, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }]) {
   const start = h.db.commandNames().length;
   const refused = await attempt(headers);
   expect(refused.status).toBe(403);expect(errorOf(refused.body)).toEqual({ code: "FORBIDDEN", message: "This request didn't come from Rovara's app." });
   expect(h.db.commandNames().slice(start).filter(name => /Put|Update|Delete|TransactWrite/.test(name))).toEqual([]);
  }
  const stale = await attempt({ cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor("old-session") });
  expect(stale.status).toBe(403);expect(errorOf(stale.body).code).toBe("CSRF_STALE");
  expect(h.db.get(`DEVELOPER#${WHO}`, "META")).toMatchObject({ displayName: "Web member" });
  const cross = await h.call("PUT", "/v1/web/me/name", { cookie: COOKIE, origin: CELL, "sec-fetch-site": "cross-site", [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, body);
  expect(cross.status).toBe(403);
  const good = await attempt({ cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) });
  expect(good.status).toBe(200);expect(good.body).toMatchObject({ name: "Web M", nameChosen: true });
  // Release 0.4.18: the name is an item in the State table; the sign-in record keeps the name it had.
  expect(h.db.get(`DEVELOPER_NAME#${WHO}`, "NAME")).toMatchObject({ name: "Web M" });
  expect(h.db.get(`DEVELOPER#${WHO}`, "META")).toMatchObject({ displayName: "Web member" });
  const refusedName = await attempt({ cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, { name: "web@example.test" });
  expect(refusedName.status).toBe(400);
  expect(h.db.get(`DEVELOPER_NAME#${WHO}`, "NAME")).toMatchObject({ name: "Web M" });
  const unsupportedRoutes: ReadonlyArray<readonly [string, string]> = [["POST", "/me/name"], ["DELETE", "/me/name"], ["PUT", "/me"], ["PUT", "/me/identities/cloud"], ["PUT", "/me/name/x"]];
  for (const [method, path] of unsupportedRoutes) expect((await h.call(method, "/v1/web" + path, { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, body)).status, method + path).toBe(404);
 });
 it("dispatches each supported read family to the same app handler", async () => {
  const h = await broker();
  for (const path of ["projects", "org", "org/members", "agents", "models", "skills", "approvals", "spend-requests", "connections", "github/installations", "budget", "usage", "nav", "home", "live", "changes", "realtime", "sessions", "chains", "chain-runs", "trash", "devices"]) {
   const app = await h.call("GET", "/v1/app/" + path, { authorization: "Bearer test-only-bearer" });
   const web = await h.call("GET", "/v1/web/" + path);
   expect(web, path).toEqual(app);
  }
 });
});
describe("browser sign-in returns and sign-out", () => {
 it("accepts only safe app, session and existing review return paths", () => {
  for (const path of ["/app", "/app/", "/app/projects/web", "/app/live?filter=needs_me", "/s/ses_aaaaaaaaaaaaaaaaaaaa", "/review/11111111-1111-4111-8111-111111111111/task"]) expect(BROWSER_RETURN_TO.test(path), path).toBe(true);
  for (const path of ["//evil.example", "/app/../v1/admin", "/app/%2e%2e/v1/dev/x", "/app/%2E%2e/x", "/app/a%2fb", "/app/a%5Cb", "/app//x", "/apple", "/s/../x", "/app/./x", "/app?next=//evil.example"]) expect(BROWSER_RETURN_TO.test(path), path).toBe(false);
 });
 it("returns a removed member once to the signed-out page and preserves review behavior", async () => {
  for (const target of ["/s/ses_aaaaaaaaaaaaaaaaaaaa", "/app/live", "/review/11111111-1111-4111-8111-111111111111/task"]) {
   const h = identityHarness({ slackUsers: [PERSON] });await h.signIn("slack", PERSON.userId);
   const id = (await import("../../packages/broker/src/aws/lambda.js")).ownerKeyForSubject("https://slack.com", PERSON.userId);
   const membership = (await h.orgs.orgForDeveloper(id))!;
   const pointer = developerOrgKey(id), member = orgMemberKey(membership.orgId, id);
   h.state.delete(pointer.pk, pointer.sk);h.state.delete(member.pk, member.sk);h.state.set({ ...orgRemovedKey(membership.orgId, id), entityType: "ORG_REMOVED", orgId: membership.orgId, developerId: id, removedAt: new Date(h.now()).toISOString() });
   h.state.set({ ...orgBanKey(membership.orgId, id), entityType: "ORG_BAN", orgId: membership.orgId, developerId: id, bannedAt: new Date(h.now()).toISOString() });
   const start = await h.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=" + encodeURIComponent(target)));
   expect(start.statusCode).toBe(302);
   const event = httpEvent("GET", h.slack.approve(start.headers.location!, PERSON.userId));event.headers = { cookie: start.cookies!.find(value => value.startsWith("__Host-agentx_review_pkce="))!.split(";", 1)[0] };
   const result = await h.http(event);expect(result.headers.location).toBe(target.startsWith("/review/") ? target : "/app/signed-out?reason=removed");
  }
 });
 it("revokes only a valid same-origin sign-out and clears its cookie", async () => {
  const h = identityHarness({ slackUsers: [PERSON] });
  const start = await h.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=%2Fapp"));
  const event = httpEvent("GET", h.slack.approve(start.headers.location!, PERSON.userId));event.headers = { cookie: start.cookies!.find(value => value.startsWith("__Host-agentx_review_pkce="))!.split(";", 1)[0] };
  const done = await h.http(event);const cookie = done.cookies!.find(value => value.startsWith("__Host-agentx_review_session="))!.split(";", 1)[0]!;
  const session = cookie.split("=")[1]!;
  const signOut = (headers: Record<string, string | undefined>) => h.http({ ...httpEvent("POST", "/v1/auth/browser/sign-out"), headers: { cookie, ...headers } });
  const origin = new URL(h.deps.config.issuer).origin, csrf = appCsrfTokenFor(session);
  for (const headers of [{}, { origin }, { origin: "https://evil.example", [APP_CSRF_HEADER]: csrf }, { origin: "null", [APP_CSRF_HEADER]: csrf }, { [APP_CSRF_HEADER]: csrf }, { origin, [APP_CSRF_HEADER]: "wrong" }]) {
   const before = h.db.commandNames().length;
   expect((await signOut(headers)).statusCode).toBe(403);
   expect(h.db.commandNames().slice(before).filter(name => /Put|Update|Delete|TransactWrite/.test(name))).toEqual([]);
   expect((await h.deps.store.getSession(session))?.revokedAt).toBeUndefined();
  }
  const stored = h.db.get(`SESSION#${session}`, "META")!;
  for (const changed of [{ endsAt: 1 }, { reviewExpiresAt: 1 }, { revokedAt: new Date(h.now()).toISOString() }]) {
   h.db.set({ ...stored, ...changed });
   for (const headers of [{ origin }, { origin, [APP_CSRF_HEADER]: csrf }]) {
    const before = h.db.commandNames().length;
    const response = await signOut(headers);
    expect(response.statusCode).toBe(204);
    expect(response.cookies).toContain("__Host-agentx_review_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    expect(h.db.commandNames().slice(before).filter(name => /Put|Update|Delete|TransactWrite/.test(name))).toEqual([]);
   }
   expect((await signOut({ origin: "https://evil.example" })).statusCode).toBe(403);
  }
  h.db.set(stored);
  const ended = await signOut({ origin, [APP_CSRF_HEADER]: csrf });
  expect(ended.statusCode).toBe(204);expect((await h.deps.store.getSession(session))?.revokedAt).toBeDefined();
  expect(ended.cookies?.some(value => value.startsWith("__Host-agentx_review_session=;") && value.includes("Max-Age=0"))).toBe(true);
  expect(h.logs.some(line => JSON.stringify(line).includes(session))).toBe(false);
 });
 it("maps cancelled, failed and ended app callbacks to fixed recovery reasons", async () => {
  for (const reason of ["cancelled", "failed", "ended"] as const) {
   const h = identityHarness({ slackUsers: [PERSON] });
   if (reason === "ended") {
    await h.signIn("slack", PERSON.userId);
    const id = (await import("../../packages/broker/src/aws/lambda.js")).ownerKeyForSubject("https://slack.com", PERSON.userId);
    h.db.set({ ...h.db.get(`DEVELOPER#${id}`, "META")!, revoked: true });
   }
   const start = await h.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=%2Fapp%2Flive"));
   const target = new URL(h.slack.approve(start.headers.location!, PERSON.userId));
   if (reason === "cancelled") target.searchParams.delete("code");
   if (reason === "failed") target.searchParams.set("code", "invalid-fixture-code");
   const callback = httpEvent("GET", target.toString());callback.headers = { cookie: start.cookies!.find(value => value.startsWith("__Host-agentx_review_pkce="))!.split(";", 1)[0] };
   const response = await h.http(callback);expect(response.headers.location).toBe(`/app/signed-out?reason=${reason}`);
   expect(response.cookies?.some(value => value.startsWith("__Host-agentx_review_session="))).toBe(false);
  }
 });
 it("lets a task-page comment use the app session's CSRF header", async () => {
  const createComment = vi.fn(async () => ({ comment: {} as never }));
  const caller = { developerId: WHO, sessionId: SID, amr: "cloud" as const, orgId: TEST_ORG, orgRole: "owner" as const, name: "Web member" };
  const unused = async (): Promise<never> => { throw new Error("Unexpected fixture route"); };
  const api = createTaskWebApi({ origin: CELL, authenticateSession: async () => caller, createComment, taskState: unused, listComments: unused, editComment: unused, deleteComment: unused, setSuggestion: unused, decide: unused });
  const path = "/review/11111111-1111-4111-8111-111111111111/task/api/comments";
  const body = { requestId: randomUUID(), document: "plan", version: 1, target: { kind: "claim", id: "2.1" }, text: "A comment", ask: false };
  for (const headers of [{ origin: CELL }, { origin: CELL, [APP_CSRF_HEADER]: "wrong" }, { origin: "https://evil.example", [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }]) {
   const refused = await api({ method: "POST", path, requestId: "fixture", headers: { cookie: COOKIE, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, new URL(path, CELL));
   expect(refused.statusCode).toBe(403);expect(createComment).not.toHaveBeenCalled();
  }
  const response = await api({ method: "POST", path, requestId: "fixture", headers: { cookie: COOKIE, origin: CELL, "content-type": "application/json", [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, body: JSON.stringify(body) }, new URL(path, CELL));
  expect(response.statusCode).toBe(201);expect(createComment).toHaveBeenCalledTimes(1);
 });
});

it("serves exact-email lookup through the real cookie/CSRF boundary and broker envelope", async () => {
 const h = await broker(), email = "web-fixture@example.test";
 h.db.set({ ...h.db.get({ pk: `DEVELOPER#${WHO}`, sk: "META" }), email });h.db.set({ ...orgEmailKey(email), orgId: TEST_ORG, developerId: WHO });
 const path = "/v1/web/org/members/lookup", body = { email };
 expect((await h.call("POST", path, { cookie: COOKIE, origin: CELL }, body)).status).toBe(403);
 const result = await h.call("POST", path, { cookie: COOKIE, origin: CELL, "x-rovara-csrf": appCsrfTokenFor(SID) }, body);
 expect(result.status).toBe(200);expect(result.body).toEqual({ match: { developerId: WHO, name: "Web member" }, requestId: "web-auth-fixture" });
});

it("requires a reviewed expectedRole for cookie role changes before any write", async () => {
 const h = await broker(), target = "b".repeat(64);seedMembership(h.db, target, { orgId: TEST_ORG, role: "member" });
 for (const body of [{ requestId: randomUUID(), role: "admin" }, { requestId: randomUUID(), role: "admin", expectedRole: null }, { requestId: randomUUID(), role: "admin", expectedRole: "unknown" }]) {
  const before = h.db.commandNames().length;
  const response = await h.call("PUT", `/v1/web/org/members/${target}/role`, { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, body);
  expect(response.status).toBe(400);expect(errorOf(response.body).code).toBe("CONFIG_INVALID");expect(h.db.commandNames().slice(before).filter(name => /Put|Update|Delete|TransactWrite/.test(name))).toEqual([]);expect(h.db.get(orgMemberKey(TEST_ORG, target))?.role).toBe("member");
 }
});
it("keeps legacy token role writes available while cookie omission is refused", async () => {
 const h = await broker(), target = "b".repeat(64);seedMembership(h.db, target, { orgId: TEST_ORG, role: "member" });
 const response = await h.call("PUT", `/v1/app/org/members/${target}/role`, { authorization: "Bearer test-only-bearer" }, { requestId: randomUUID(), role: "admin" });expect(response.status).toBe(200);expect(h.db.get(orgMemberKey(TEST_ORG, target))?.role).toBe("admin");
});
it("runs reviewed cookie role writes with receipts and audit while preserving live owner authority", async () => {
 const { capturingAuditDeps } = await import("../support/audit-capture.js");const audit = capturingAuditDeps(), h = await broker({ audit: audit.audit }), target = "b".repeat(64);audit.attach(h.db);seedMembership(h.db, target, { orgId: TEST_ORG, role: "member" });const body = { requestId: randomUUID(), role: "admin", expectedRole: "member" }, headers = { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) };
 for (let i = 0; i < 2; i++) expect((await h.call("PUT", `/v1/web/org/members/${target}/role`, headers, body)).status).toBe(200);
 expect(audit.recordedBy("member.role_changed")).toHaveLength(1);expect(h.db.get(orgMemberKey(TEST_ORG, target))?.role).toBe("admin");
 for (const role of ["admin", "member"] as const) { seedMembership(h.db, WHO, { orgId: TEST_ORG, role });const response = await h.call("PUT", `/v1/web/org/members/${target}/role`, headers, { requestId: randomUUID(), role: "owner", expectedRole: "admin" });expect(response.status).toBe(403);expect(h.db.get(orgMemberKey(TEST_ORG, target))?.role).toBe("admin"); }
});

it("uses the real cookie Origin and CSRF boundary for reviewed creation and safe receipt recovery", async () => {
 const audit=capturingAuditDeps(),h=await broker({audit:audit.audit});audit.attach(h.db);const body={requestId:randomUUID(),role:"member",email:"private.person@example.test"},path="/v1/web/org/invites/reviewed",headers={cookie:COOKIE,origin:CELL,[APP_CSRF_HEADER]:appCsrfTokenFor(SID)};
 for(const bad of [{cookie:COOKIE,origin:CELL},{...headers,origin:"https://evil.example"}]){expect((await h.call("POST",path,bad,body)).status).toBe(403);expect(h.db.find(row=>row.entityType==="ORG_INVITE").length).toBe(0);}
 const first=await h.call("POST",path,headers,body);expect(first.status).toBe(200);expect(typeof first.body.inviteUrl==="string").toBe(true);const replay=await h.call("POST",path,headers,body);expect(replay.status).toBe(200);expect(replay.body.inviteUrl).toBeUndefined();expect(replay.body.receipt).toEqual(first.body.receipt);const recovery=await h.call("GET",`/v1/web/org/invites/requests/${body.requestId}`);expect(recovery.status).toBe(200);expect(recovery.body.receipt).toEqual(first.body.receipt);expect(Object.keys(recovery.body).sort()).toEqual(["receipt","requestId"]);expect(audit.flushed().filter(event=>event.action==="org.invite_created").length).toBe(1);
 seedMembership(h.db,WHO,{orgId:TEST_ORG,role:"member"});expect((await h.call("GET",`/v1/web/org/invites/requests/${body.requestId}`)).status).toBe(403);expect((await h.call("POST",path,headers,body)).status).toBe(403);
});

it("delivers a configured cloud join link across origins through the real cookie route and console client",async()=>{const audit=capturingAuditDeps(),h=await broker({audit:audit.audit,cloud:true},"https://join.example.test");audit.attach(h.db);const host=fakeHost(async r=>h.call(r.method,r.path.replace("/v1/app/","/v1/web/"),{cookie:COOKIE,origin:CELL,[APP_CSRF_HEADER]:appCsrfTokenFor(SID)},r.body));const result=await createInviteAdminApi(host.host,TEST_ORG).create({requestId:randomUUID(),role:"member",email:"private.person@example.test"});expect(new URL(result.inviteUrl!).origin).toBe("https://join.example.test");expect(result.receipt.orgId).toBe(TEST_ORG);expect(h.db.find(row=>row.entityType==="ORG_INVITE").length).toBe(1);expect(audit.flushed().filter(event=>event.action==="org.invite_created").length).toBe(1);});

it("reads only current-org monthly base settings through the real cookie boundary",async()=>{const h=await broker();const path="/v1/web/org/budget-settings";expect((await h.call("GET",path,{})).status).toBe(401);const first=await h.call("GET",path,{cookie:COOKIE});expect(first.status).toBe(200);expect(first.body.orgId).toBe(TEST_ORG);expect(first.body.coverage).toBe("monthly_base_settings_only");expect(first.body.usage).toBe("not_checked");seedMembership(h.db,WHO,{orgId:TEST_ORG,role:"member"});expect((await h.call("GET",path,{cookie:COOKIE})).status).toBe(403);});

it("reads only the narrow company ceiling through real cookie auth and refuses live role loss", async () => {
 const h = await broker(), path = "/v1/web/org/task-stop-ceiling";
 expect((await h.call("GET", path, {})).status).toBe(401);
 const first = await h.call("GET", path, { cookie: COOKIE });
 expect(first.status).toBe(200);expect(first.body.orgId).toBe(TEST_ORG);
 expect(first.body.ceilingMicrousd).toBe(100_000_000);expect(first.body.enforcement).toBe("not_connected");
 expect(first.body.companyDefault).toBe("not_loaded");
 seedMembership(h.db, WHO, { orgId: TEST_ORG, role: "member" });
 expect((await h.call("GET", path, { cookie: COOKIE })).status).toBe(403);
});


it("reads configured company defaults through the real cookie boundary without inventing missing settings", async () => {
  const h = await broker();
  const path = "/v1/web/org/task-stop-policy";
  expect((await h.call("GET", path, {})).status).toBe(401);
  expect((await h.call("GET", path, { cookie: COOKIE })).status).toBe(503);
  h.db.set({ pk: `ORG#${TEST_ORG}#SETTINGS`, sk: "TASK_STOP_POLICY", entityType: "ORG_TASK_STOP_POLICY", orgId: TEST_ORG, revision: 1, policy: { schemaVersion: 1, defaultStopMicrousd: 10_000_000 } });
  const shown = await h.call("GET", path, { cookie: COOKIE });
  expect(shown.status).toBe(200);
  expect(shown.body.defaultStopMicrousd).toBe(10_000_000);
  expect(shown.body.locks).toBe("not_loaded");
  expect(shown.body.enforcement).toBe("not_connected");
  seedMembership(h.db, WHO, { orgId: TEST_ORG, role: "member" });
  expect((await h.call("GET", path, { cookie: COOKIE })).status).toBe(403);
});


it("reads only a builtin agent's money layer through cookie auth without creating settings", async () => {
  const h = await broker();
  const path = "/v1/web/org/task-stop-policy/agents/rovara-code";
  expect((await h.call("GET", path, {})).status).toBe(401);
  h.db.set({ pk: `ORG#${TEST_ORG}#SETTINGS`, sk: "TASK_STOP_POLICY", entityType: "ORG_TASK_STOP_POLICY", orgId: TEST_ORG, revision: 1, policy: { schemaVersion: 1, defaultStopMicrousd: 10_000_000 } });
  const shown = await h.call("GET", path, { cookie: COOKIE });
  expect(shown.status).toBe(200);
  expect(shown.body.sourceKind).toBe("builtin_absent");
  expect(shown.body.agentOverride).toEqual({ kind: "inherit" });
  expect(shown.body.calculation).toBe("unavailable");
  expect(h.db.get({ pk: `ORG#${TEST_ORG}#BUILTIN_AGENTS`, sk: "rovara-code" })).toBeUndefined();
  seedMembership(h.db, WHO, { orgId: TEST_ORG, role: "member" });
  expect((await h.call("GET", path, { cookie: COOKIE })).status).toBe(403);
});

it("reads a known project's source through cookie auth without initializing settings", async () => {
  const h = await broker(), path = "/v1/web/org/task-stop-policy/projects/web";
  expect((await h.call("GET", path, {})).status).toBe(401);
  h.db.set({ pk: `ORG#${TEST_ORG}#SETTINGS`, sk: "TASK_STOP_POLICY", entityType: "ORG_TASK_STOP_POLICY", orgId: TEST_ORG, revision: 1, policy: { schemaVersion: 1, defaultStopMicrousd: 10_000_000 } });
  expect((await h.call("GET", path, { cookie: COOKIE })).status).toBe(503);
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web", latestRevision: 1 });
  const shown = await h.call("GET", path, { cookie: COOKIE });
  expect(shown.status).toBe(200);
  expect(shown.body.projectOverride).toEqual({ kind: "inherit" });
  expect(shown.body.projectLifecycle).toBe("not_loaded");
  expect(h.db.get(projectAiKey(TEST_ORG, "web"))).toBeUndefined();
  seedMembership(h.db, WHO, { orgId: TEST_ORG, role: "member" });
  expect((await h.call("GET", path, { cookie: COOKIE })).status).toBe(403);
});

it("requires a reviewed source-order body on real cookie routes before any mutation", async () => {
 const audit = capturingAuditDeps(), h = await broker({ audit: audit.audit, agents: {}, modelAccess: { access: fakeModelAccess(), proxyUrl: "https://proxy.example.test" } }), headers = { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) };audit.attach(h.db);
 for (const body of [{ requestId: randomUUID(), order: ["rovara"] }, { requestId: randomUUID(), expectedRevision: null, order: ["rovara"] }, { requestId: randomUUID(), expectedRevision: -1, order: ["rovara"] }]) {
  const before = h.db.transactions().length, response = await h.call("PUT", "/v1/web/org/model-sources-order", headers, body);expect(response.status).toBe(400);expect(errorOf(response.body)).toMatchObject({ code: "CONFIG_INVALID", message: "Review a valid company source order before submitting." });expect(h.db.transactions()).toHaveLength(before);
 }
});
it("runs reviewed source-order cookie writes through CSRF, live authority and atomic replay", async () => {
 const audit = capturingAuditDeps(), h = await broker({ audit: audit.audit, agents: {}, modelAccess: { access: fakeModelAccess(), proxyUrl: "https://proxy.example.test" } });audit.attach(h.db);
 h.db.set({ ...modelSourcesKey(TEST_ORG), entityType: "ORG_MODEL_SOURCES", revision: 1, sources: [], order: ["personal-chatgpt", "rovara"], credentials: [], removing: [], updatedBy: WHO, updatedAt: "2026-10-27T12:00:00Z" });
 const headers = { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, body = { requestId: randomUUID(), expectedOrgId: TEST_ORG, expectedDeveloperId: WHO, expectedRevision: 1, order: ["rovara"] }, path = "/v1/web/org/model-sources-order";
 expect((await h.call("PUT", path, { cookie: COOKIE, origin: CELL }, body)).status).toBe(403);
 for (let i = 0; i < 2; i++) { const reply = await h.call("PUT", path, headers, body);expect(reply.status).toBe(200);expect(reply.body).toMatchObject({ order: ["rovara"], revision: 2 }); }
 expect(h.db.get(modelSourcesKey(TEST_ORG))?.revision).toBe(2);expect(audit.recordedBy("model_source.order_changed")).toHaveLength(1);
 seedMembership(h.db, WHO, { orgId: TEST_ORG, role: "member" });expect((await h.call("PUT", path, headers, body)).status).toBe(403);expect(h.db.get(modelSourcesKey(TEST_ORG))?.revision).toBe(2);
 h.db.delete({ pk: `SESSION#${SID}`, sk: "META" });expect((await h.call("PUT", path, headers, body)).status).toBe(401);
});
it("retains the explicit bearer CLI source-order compatibility path", async () => {
 const h = await broker({ agents: {}, modelAccess: { access: fakeModelAccess(), proxyUrl: "https://proxy.example.test" } });
 expect((await h.call("PUT", "/v1/app/org/model-sources-order", { authorization: "Bearer test-only-bearer" }, { requestId: randomUUID(), order: ["rovara"] })).status).toBe(200);
});
function seedCompanySource(db: Awaited<ReturnType<typeof broker>>["db"]) {
 const sourceId = "src_" + "a".repeat(20);
 const item = { ...modelSourcesKey(TEST_ORG), entityType: "ORG_MODEL_SOURCES", revision: 1, sources: [{ sourceId, kind: "anthropic", label: "Company source", models: [{ catalog: { provider: "anthropic", modelId: "claude-sonnet-4-5" } }] }], order: [sourceId, "rovara"], credentials: [], removing: [], updatedBy: WHO, updatedAt: "2026-10-27T12:00:00Z" };db.set(item);return { sourceId, item };
}
for (const role of ["owner", "admin", "member"] as const) it(`refuses unreviewed cookie source deletion for ${role} without touching order or proxy`, async () => {
 const audit = capturingAuditDeps(), access = fakeModelAccess(), h = await broker({ audit: audit.audit, agents: {}, modelAccess: { access, proxyUrl: "https://proxy.example.test" } });audit.attach(h.db);seedMembership(h.db, WHO, { orgId: TEST_ORG, role });const source = seedCompanySource(h.db), before = h.db.commandNames().length;
 const response = await h.call("DELETE", `/v1/web/org/model-sources/${source.sourceId}`, { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, { requestId: randomUUID() });
 expect(response.status).toBe(403);expect(errorOf(response.body)).toMatchObject({ code: "FORBIDDEN", message: "Removing a company AI source is not available in the console yet." });expect(h.db.get(modelSourcesKey(TEST_ORG))).toEqual(source.item);expect(h.db.commandNames().slice(before).filter(name => /Put|Update|Delete|TransactWrite/.test(name))).toEqual([]);expect(audit.recorded()).toEqual([]);expect(access.removeSource).not.toHaveBeenCalled();
});
it("preserves bearer CLI source-removal compatibility while deleting its ordered ID", async () => {
 const access = fakeModelAccess(), h = await broker({ agents: {}, modelAccess: { access, proxyUrl: "https://proxy.example.test" } }), source = seedCompanySource(h.db);
 expect((await h.call("DELETE", `/v1/app/org/model-sources/${source.sourceId}`, { authorization: "Bearer test-only-bearer" }, { requestId: randomUUID() })).status).toBe(200);expect(h.db.get(modelSourcesKey(TEST_ORG))?.order).toEqual(["rovara"]);expect(h.db.get(modelSourcesKey(TEST_ORG))?.sources).toEqual([]);expect(access.removeSource).toHaveBeenCalledWith(TEST_ORG, source.sourceId);
});
it("refuses cookie deletes uniformly for unknown and foreign-company source IDs", async () => {
 const h = await broker({ agents: {}, modelAccess: { access: fakeModelAccess(), proxyUrl: "https://proxy.example.test" } }), source = seedCompanySource(h.db), otherOrg = "org_bbbbbbbbbbbbbbbbbbbb";
 h.db.delete(modelSourcesKey(TEST_ORG));const foreign = { ...source.item, ...modelSourcesKey(otherOrg) };h.db.set(foreign);const before = h.db.commandNames().length;
 for (const sourceId of [source.sourceId, "src_" + "b".repeat(20)]) {
  const response = await h.call("DELETE", `/v1/web/org/model-sources/${sourceId}`, { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, { requestId: randomUUID() });expect(response.status).toBe(403);expect(errorOf(response.body)).toMatchObject({ code: "FORBIDDEN", message: "Removing a company AI source is not available in the console yet." });
 }
 expect(h.db.get(modelSourcesKey(otherOrg))).toEqual(foreign);expect(h.db.get(modelSourcesKey(TEST_ORG))).toBeUndefined();expect(h.db.commandNames().slice(before).filter(name => /Put|Update|Delete|TransactWrite/.test(name))).toEqual([]);
});
it("requires an expected company before a reviewed cookie order can affect a moved session's company", async () => {
 const { orgMetaKey } = await import("@agentx/contracts"), audit = capturingAuditDeps(), h = await broker({ audit: audit.audit, agents: {}, modelAccess: { access: fakeModelAccess(), proxyUrl: "https://proxy.example.test" } }), otherOrg = "org_bbbbbbbbbbbbbbbbbbbb";audit.attach(h.db);
 const original = { ...modelSourcesKey(TEST_ORG), entityType: "ORG_MODEL_SOURCES", revision: 1, sources: [], order: ["personal-chatgpt", "rovara"], credentials: [], removing: [], updatedBy: WHO, updatedAt: "2026-10-27T12:00:00Z" }, foreign = { ...original, ...modelSourcesKey(otherOrg) };h.db.set(original);h.db.set(foreign);h.db.set({ ...orgMetaKey(otherOrg), orgId: otherOrg, name: "Other company", plan: "team" });seedMembership(h.db, WHO, { orgId: otherOrg, role: "owner" });
 const before = h.db.transactions().length, headers = { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, body = { requestId: randomUUID(), expectedDeveloperId: WHO, expectedRevision: 1, order: ["rovara"] };
 const omitted = await h.call("PUT", "/v1/web/org/model-sources-order", headers, body);expect(h.db.get(modelSourcesKey(otherOrg))).toEqual(foreign);expect(omitted.status).toBe(400);
 expect((await h.call("PUT", "/v1/web/org/model-sources-order", headers, { ...body, expectedOrgId: TEST_ORG })).status).toBe(403);
 expect(h.db.get(modelSourcesKey(TEST_ORG))).toEqual(original);expect(h.db.get(modelSourcesKey(otherOrg))).toEqual(foreign);expect(h.db.transactions()).toHaveLength(before);expect(audit.recorded()).toEqual([]);
});
for (const role of ["owner", "admin"] as const) it(`applies and replays a same-company bound cookie order for ${role} with one atomic audit`, async () => {
 const audit = capturingAuditDeps(), h = await broker({ audit: audit.audit, agents: {}, modelAccess: { access: fakeModelAccess(), proxyUrl: "https://proxy.example.test" } });audit.attach(h.db);seedMembership(h.db, WHO, { orgId: TEST_ORG, role });h.db.set({ ...modelSourcesKey(TEST_ORG), entityType: "ORG_MODEL_SOURCES", revision: 1, sources: [], order: ["personal-chatgpt", "rovara"], credentials: [], removing: [], updatedBy: WHO, updatedAt: "2026-10-27T12:00:00Z" });
 const body = { requestId: randomUUID(), expectedOrgId: TEST_ORG, expectedDeveloperId: WHO, expectedRevision: 1, order: ["rovara"] }, headers = { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) };
 for (let i = 0; i < 2; i++) expect((await h.call("PUT", "/v1/web/org/model-sources-order", headers, body)).status).toBe(200);expect(h.db.get(modelSourcesKey(TEST_ORG))?.revision).toBe(2);expect(audit.recordedBy("model_source.order_changed")).toHaveLength(1);
});
it("does not authenticate a cookie-only app source delete or route check/trailing-slash deletes", async () => {
 const audit = capturingAuditDeps(), access = fakeModelAccess(), h = await broker({ audit: audit.audit, agents: {}, modelAccess: { access, proxyUrl: "https://proxy.example.test" } });audit.attach(h.db);const source = seedCompanySource(h.db), body = { requestId: randomUUID() }, before = h.db.commandNames().length;
 const app = await h.call("DELETE", `/v1/app/org/model-sources/${source.sourceId}`, { cookie: COOKIE }, body);expect(app.status).toBe(401);expect(errorOf(app.body).code).toBe("AUTH_REQUIRED");
 for (const suffix of ["/check", "/"]) expect((await h.call("DELETE", `/v1/web/org/model-sources/${source.sourceId}${suffix}`, { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, body)).status).toBe(404);
 expect(h.db.get(modelSourcesKey(TEST_ORG))).toEqual(source.item);expect(h.db.commandNames().slice(before).filter(name => /Put|Update|Delete|TransactWrite/.test(name))).toEqual([]);expect(audit.recorded()).toEqual([]);expect(access.removeSource).not.toHaveBeenCalled();
});
it("refuses a mismatched company on the bearer reviewed route without audit or state change", async () => {
 const audit = capturingAuditDeps(), h = await broker({ audit: audit.audit, agents: {}, modelAccess: { access: fakeModelAccess(), proxyUrl: "https://proxy.example.test" } });audit.attach(h.db);const source = seedCompanySource(h.db), before = h.db.transactions().length;
 expect((await h.call("PUT", "/v1/app/org/model-sources-order", { authorization: "Bearer test-only-bearer" }, { requestId: randomUUID(), expectedOrgId: "org_bbbbbbbbbbbbbbbbbbbb", expectedRevision: 1, order: ["rovara"] })).status).toBe(403);expect(h.db.get(modelSourcesKey(TEST_ORG))).toEqual(source.item);expect(h.db.transactions()).toHaveLength(before);expect(audit.recorded()).toEqual([]);
});
for (const bound of [false,true]) it(`does not replay an ${bound?"actor-bound":"unbound"} intent as a different person after real browser CSRF refresh`, async () => {
 // Browser host is checked by the web compiler. Import at runtime through its transport protocol
 // so this Node-only contract program does not acquire DOM-only declarations.
 const browserModulePath: string = "../../packages/web/src/browser-host.js", browserModule: unknown = await import(browserModulePath);
 if(typeof browserModule!=="object"||browserModule===null||!("createBrowserHost" in browserModule)||typeof browserModule.createBrowserHost!=="function")throw new Error("Browser host module unavailable.");
 const createBrowserHost = browserModule.createBrowserHost as (win:{location:{origin:string;pathname:string;search:string;assign():void};fetch:typeof globalThis.fetch})=>Pick<ReturnType<typeof fakeHost>["host"],"transport">;
 const audit = capturingAuditDeps(), h = await broker({ audit: audit.audit, agents: {}, modelAccess: { access: fakeModelAccess(), proxyUrl: "https://proxy.example.test" } });audit.attach(h.db);const source = seedCompanySource(h.db), other = "b".repeat(64), otherSid = "22222222-2222-4222-8222-222222222222";
 seedMembership(h.db, other, { orgId: TEST_ORG, role: "owner" });h.db.set({ pk: `DEVELOPER#${other}`, sk: "META", developerId: other, displayName: "Other owner", provider: "cloud" });h.db.set({ pk: `SESSION#${otherSid}`, sk: "META", sessionId: otherSid, developerId: other, amr: "cloud", startedAt: new Date(Date.now()-60000).toISOString(), endsAt: Math.floor(Date.now()/1000)+3600, reviewExpiresAt: Math.floor(Date.now()/1000)+3600 });
 let currentCookie = COOKIE, switched = false;const calls: Array<{ method: string; path: string }> = [];
 const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => { const raw=typeof input==="string"?input:input instanceof URL?input.href:input.url, url=new URL(raw,CELL), path=url.pathname+url.search, method = init?.method ?? "GET";calls.push({ method, path });if (method === "PUT" && !switched) { switched = true;currentCookie = `__Host-agentx_review_session=${otherSid}`; }const headers = Object.fromEntries(new Headers(init?.headers));const result = await h.call(method, path, { ...headers, cookie: currentCookie, ...(method === "GET" ? {} : { origin: CELL }) }, typeof init?.body === "string" ? JSON.parse(init.body) : undefined);return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } }); }) as typeof globalThis.fetch;
 const host = createBrowserHost({ location: { origin: CELL, pathname: "/app/admin/models/sources", search: "", assign() {} }, fetch });await host.transport.request({ method: "GET", path: "/v1/app/me" });
 const result = await host.transport.request({ method: "PUT", path: "/v1/app/org/model-sources-order", body: { requestId: randomUUID(), expectedOrgId: TEST_ORG, ...(bound?{expectedDeveloperId:WHO}:{}), expectedRevision: 1, order: ["rovara"] } });expect(h.db.get(modelSourcesKey(TEST_ORG))).toEqual(source.item);expect(result.status).toBe(bound?403:400);expect(calls.filter(c=>c.path.endsWith("/me"))).toHaveLength(2);expect(calls.filter(c=>c.method==="PUT")).toHaveLength(2);expect(audit.recorded()).toEqual([]);
});
it("refuses explicit cookie review intent belonging to another person before a write", async()=>{
 const audit=capturingAuditDeps(),h=await broker({audit:audit.audit,agents:{},modelAccess:{access:fakeModelAccess(),proxyUrl:"https://proxy.example.test"}});audit.attach(h.db);const source=seedCompanySource(h.db),before=h.db.transactions().length;
 const result=await h.call("PUT","/v1/web/org/model-sources-order",{cookie:COOKIE,origin:CELL,[APP_CSRF_HEADER]:appCsrfTokenFor(SID)},{requestId:randomUUID(),expectedOrgId:TEST_ORG,expectedDeveloperId:"b".repeat(64),expectedRevision:1,order:["rovara"]});expect(result.status).toBe(403);expect(h.db.get(modelSourcesKey(TEST_ORG))).toEqual(source.item);expect(h.db.transactions()).toHaveLength(before);expect(audit.recorded()).toEqual([]);
});

// Lane B reviewed archive API: real cookie adapter, route and transactional persistence.
async function reviewedArchiveBroker(extra:Record<string,unknown>={}){const audit=capturingAuditDeps(),h=await broker({audit:audit.audit,...extra});audit.attach(h.db);const definition=StoredProjectDefinitionSchema.parse({name:"payments",revision:1,repositories:[{name:"web",url:"https://github.com/acme/payments.git",path:"repo/web",defaultBranch:"main",credentialRef:"github-app"}],setup:[],readiness:[],orchestratorInstructions:"Synthetic fixture"});h.db.set({...orgProjectCatalogKey(TEST_ORG,"payments"),entityType:"PROJECT_CATALOG",name:"payments",latestRevision:1});h.db.set({...projectRevisionKey(TEST_ORG,"payments",1),entityType:"PROJECT",definition});return {...h,audit};}
const reviewedArchiveHeaders={cookie:COOKIE,origin:CELL,[APP_CSRF_HEADER]:appCsrfTokenFor(SID)};
const reviewedArchiveBody=()=>({requestId:randomUUID(),expectedRevision:0,expectedProjectRevision:1,acknowledgeNewWorkStops:true});
it("reviewed archive clears the project's learning data: one bounded page inline, the rest left to the scheduled run", async () => {
  const { projectLearningKey } = await import("@agentx/contracts");
  const { resumeOpenLearningWalks, ARCHIVE_INLINE_WRITES } = await import("../../packages/broker/src/learning/cleanup.js");
  const h = await reviewedArchiveBroker();
  const pk = projectLearningKey(TEST_ORG, "payments", "STATE").pk;
  const stored = () => h.db.find((item) => item.pk === pk).length;
  h.db.set({ ...projectLearningKey(TEST_ORG, "payments", "STATE"), orgId: TEST_ORG, projectCreatedAt: "2026-10-01T00:00:00.000Z", revision: 1, openSuggestions: 0, liveCorrections: 250, pendingRules: 0 });
  for (let n = 0; n < 250; n += 1) h.db.set({ ...projectLearningKey(TEST_ORG, "payments", `CORRECTION#2026-10-20T09:00:00.000Z#c${String(n).padStart(4, "0")}`), orgId: TEST_ORG, projectCreatedAt: "2026-10-01T00:00:00.000Z", text: "words" });
  const result = await h.call("POST", "/v1/web/projects/payments/reviewed-archive", reviewedArchiveHeaders, reviewedArchiveBody());
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(h.db.get(projectMetaKey(TEST_ORG, "payments"))?.status).toBe("archived");
  expect(251 - stored()).toBeLessThanOrEqual(ARCHIVE_INLINE_WRITES);
  expect(stored()).toBeGreaterThan(100);
  expect(stored()).toBeLessThan(251);
  expect(await resumeOpenLearningWalks({ documentClient: h.db, tableName: "state", now: () => Date.now() })).toMatchObject({ walks: 1, done: 1 });
  expect(stored()).toBe(0);
});
it("serves safe reviewed archive preview and explicit archive with canonical receipt through cookie routes",async()=>{const h=await reviewedArchiveBroker();const preview=await h.call("GET","/v1/web/projects/payments/archive-preview");expect(preview.status).toBe(200);expect(preview.body).toMatchObject({orgId:TEST_ORG,project:"payments",status:"active",expectedRevision:0,expectedProjectRevision:1,access:{actions:["archive"]}});const result=await h.call("POST","/v1/web/projects/payments/reviewed-archive",reviewedArchiveHeaders,reviewedArchiveBody());expect(result.status,JSON.stringify(result.body)).toBe(200);expect(result.body).toMatchObject({replayed:false,current:{status:"archived"},receipt:{status:"archived",revision:1}});expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))?.status).toBe("archived");expect(h.audit.recordedBy("project.archived").length).toBe(1);});
it("protects reviewed archive with session, Origin and CSRF before persistence",async()=>{const h=await reviewedArchiveBroker();for(const headers of [{},{cookie:COOKIE},{cookie:COOKIE,origin:CELL},{...reviewedArchiveHeaders,origin:"https://evil.example"},{...reviewedArchiveHeaders,[APP_CSRF_HEADER]:"wrong"}]){expect([401,403]).toContain((await h.call("POST","/v1/web/projects/payments/reviewed-archive",headers,reviewedArchiveBody())).status);expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))).toBeUndefined();expect(h.audit.recordedBy("project.archived")).toEqual([]);}});
for(const role of ["owner","admin","member"] as const)it(`checks live ${role} on the cookie reviewed archive route`,async()=>{const h=await reviewedArchiveBroker();seedMembership(h.db,WHO,{orgId:TEST_ORG,role});const result=await h.call("POST","/v1/web/projects/payments/reviewed-archive",reviewedArchiveHeaders,reviewedArchiveBody());expect(result.status).toBe(role==="member"?403:200);expect(h.audit.recordedBy("project.archived").length).toBe(role==="member"?0:1);});
it("maps request UUID conflicts to stale copy and rejects acknowledgment omission",async()=>{const h=await reviewedArchiveBroker(),body=reviewedArchiveBody(),path="/v1/web/projects/payments/reviewed-archive";expect((await h.call("POST",path,reviewedArchiveHeaders,{requestId:body.requestId,expectedRevision:0,expectedProjectRevision:1})).status).toBe(400);expect((await h.call("POST",path,reviewedArchiveHeaders,body)).status).toBe(200);const conflict=await h.call("POST",path,reviewedArchiveHeaders,{...body,expectedRevision:1});expect(errorOf(conflict.body).code).toBe("CHANGE_STALE");});

for(const role of ["maintainer","contributor","viewer","revoked","second-org"] as const)it(`keeps reviewed cookie archive scoped for ${role}`,async()=>{const h=await reviewedArchiveBroker();seedMembership(h.db,WHO,{orgId:TEST_ORG,role:"member"});if(["maintainer","contributor","viewer"].includes(role))h.db.set({...projectMemberKey(TEST_ORG,WHO,"payments"),role:role==="viewer"?"viewer":"developer",projectRole:role,projectName:"payments"});if(role==="revoked")h.db.delete(orgMemberKey(TEST_ORG,WHO));if(role==="second-org")seedMembership(h.db,WHO,{orgId:"org_bbbbbbbbbbbbbbbbbbbb",role:"owner"});const result=await h.call("POST","/v1/web/projects/payments/reviewed-archive",reviewedArchiveHeaders,reviewedArchiveBody());expect(result.status,JSON.stringify(result.body)).toBe(role==="maintainer"?200:role==="second-org"?404:403);expect(h.audit.recordedBy("project.archived").length).toBe(role==="maintainer"?1:0);});
it("gives the same cookie response for foreign-only and missing archive previews",async()=>{const h=await reviewedArchiveBroker();h.db.set({...orgProjectCatalogKey("org_bbbbbbbbbbbbbbbbbbbb","foreign-only"),entityType:"PROJECT_CATALOG",name:"foreign-only",latestRevision:1});const missing=await h.call("GET","/v1/web/projects/missing/archive-preview"),foreign=await h.call("GET","/v1/web/projects/foreign-only/archive-preview");expect(missing.status).toBe(404);expect(foreign).toEqual(missing);});

it("pins reviewed archive method and path pairs without any wrong-method writes",async()=>{const h=await reviewedArchiveBroker();for(const [method,path] of [["POST","/v1/web/projects/payments/archive-preview"],["GET","/v1/web/projects/payments/reviewed-archive"]]){const response=await h.call(method!,path!,reviewedArchiveHeaders,method==="POST"?reviewedArchiveBody():undefined);expect(response.status,JSON.stringify(response.body)).toBe(404);expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))).toBeUndefined();expect(h.audit.recordedBy("project.archived")).toEqual([]);expect(h.db.transactions()).toEqual([]);}});

// Lane B restore exposure: real cookie broker + repository binding gate, no external network.
async function reviewedRestoreBroker(policy:"private"|"cloud"|"cloud-missing"="private"){
 let mode="connected";const probe=vi.fn(async(owner:string,repository:string,options?:{fresh?:boolean})=>{expect(owner).toBe("acme");expect(repository).toBe("payments");expect(options).toEqual({fresh:true});if(mode==="denied")return undefined;if(mode==="unavailable")throw new Error("private provider outage");return {installationId:77};});
 const extra:Record<string,unknown>=policy==="private"?{}:{cloud:true,githubPullRequests:{reconcilePullRequest:vi.fn(),getPullRequest:vi.fn(),updatePullRequest:vi.fn(),...(policy==="cloud"?{installationForRepository:probe}:{})}};
 const h=await reviewedArchiveBroker(extra);h.db.set({...projectMetaKey(TEST_ORG,"payments"),entityType:"PROJECT_META",name:"payments",status:"archived",archiveRevision:2,archivedAt:"2026-10-20T00:00:00Z",archivedBy:WHO,createdAt:"2026-10-01T00:00:00Z",createdBy:WHO});
 const record:GithubInstallationRecord={installationId:77,orgId:TEST_ORG,accountLogin:"acme",accountId:977,accountType:"Organization",repositorySelection:"all",installedByGithubUserId:"gh-fixture",boundByDeveloperId:WHO,status:"active",boundAt:"2026-10-01T00:00:00Z",updatedAt:"2026-10-01T00:00:00Z"};h.db.set({...githubInstallationKey(77),entityType:"GITHUB_INSTALLATION",...record});h.db.set({...orgGithubInstallationKey(TEST_ORG,77),entityType:"GITHUB_INSTALLATION",...record});
 return {...h,probe,repo(value:string){mode=value;}};
}
const reviewedRestoreBody=()=>({requestId:randomUUID(),expectedRevision:2,expectedProjectRevision:1,acknowledgeNewWorkAllowed:true});
it("serves reviewed restore with explicit private policy and canonical persisted outcome through cookie routes",async()=>{const h=await reviewedRestoreBroker();const preview=await h.call("GET","/v1/web/projects/payments/restore-preview");expect(preview.status,JSON.stringify(preview.body)).toBe(200);expect(preview.body).toMatchObject({orgId:TEST_ORG,status:"archived",expectedRevision:2,access:{actions:["restore"]}});const result=await h.call("POST","/v1/web/projects/payments/reviewed-restore",reviewedArchiveHeaders,reviewedRestoreBody());expect(result.status,JSON.stringify(result.body)).toBe(200);expect(result.body).toMatchObject({replayed:false,receipt:{status:"active",revision:3},current:{status:"active",prerequisites:"not_required",access:{actions:[]}}});expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))?.status).toBe("active");expect(h.audit.recordedBy("project.restored").length).toBe(1);expect(h.probe).not.toHaveBeenCalled();});
it("rechecks Cloud repository access fresh and binds it to this org through the actual checker",async()=>{const h=await reviewedRestoreBroker("cloud");expect((await h.call("GET","/v1/web/projects/payments/restore-preview")).status).toBe(200);expect(h.probe).toHaveBeenCalledTimes(1);const result=await h.call("POST","/v1/web/projects/payments/reviewed-restore",reviewedArchiveHeaders,reviewedRestoreBody());expect(result.status,JSON.stringify(result.body)).toBe(200);expect(h.probe).toHaveBeenCalledTimes(2);expect(h.audit.recordedBy("project.restored").length).toBe(1);});
for(const damage of ["foreign","suspended"] as const)it(`refuses ${damage} Cloud repository binding in preview and commit`,async()=>{const h=await reviewedRestoreBroker("cloud");h.db.set({...h.db.get(githubInstallationKey(77)),...(damage==="foreign"?{orgId:"org_bbbbbbbbbbbbbbbbbbbb"}:{status:"suspended"})});for(const [method,path] of [["GET","/v1/web/projects/payments/restore-preview"],["POST","/v1/web/projects/payments/reviewed-restore"]]){const result=await h.call(method!,path!,reviewedArchiveHeaders,method==="POST"?reviewedRestoreBody():undefined);expect(errorOf(result.body).code).toBe("GITHUB_NOT_CONNECTED");expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))?.status).toBe("archived");expect(h.audit.recordedBy("project.restored")).toEqual([]);}});
for(const mode of ["denied","unavailable"])it(`sanitizes Cloud restore ${mode} preview and commit without changes`,async()=>{const h=await reviewedRestoreBroker("cloud");h.repo(mode);for(const [method,path] of [["GET","/v1/web/projects/payments/restore-preview"],["POST","/v1/web/projects/payments/reviewed-restore"]]){const result=await h.call(method!,path!,reviewedArchiveHeaders,method==="POST"?reviewedRestoreBody():undefined);expect(errorOf(result.body).code).toBe(mode==="denied"?"GITHUB_NOT_CONNECTED":"RUNTIME_UNAVAILABLE");expect(JSON.stringify(result.body)).not.toContain("private provider");expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))?.status).toBe("archived");expect(h.audit.recordedBy("project.restored")).toEqual([]);}});
it("refuses Cloud repository access revoked after successful restore preview",async()=>{const h=await reviewedRestoreBroker("cloud");expect((await h.call("GET","/v1/web/projects/payments/restore-preview")).status).toBe(200);h.repo("denied");const result=await h.call("POST","/v1/web/projects/payments/reviewed-restore",reviewedArchiveHeaders,reviewedRestoreBody());expect(errorOf(result.body).code).toBe("GITHUB_NOT_CONNECTED");expect(h.probe).toHaveBeenCalledTimes(2);expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))?.status).toBe("archived");expect(h.audit.recordedBy("project.restored")).toEqual([]);});
it("fails closed for absent Cloud checker while active preview stays non-actionable",async()=>{const h=await reviewedRestoreBroker("cloud-missing");expect((await h.call("POST","/v1/web/projects/payments/reviewed-restore",reviewedArchiveHeaders,reviewedRestoreBody())).status).toBe(503);h.db.set({...h.db.get(projectMetaKey(TEST_ORG,"payments")),status:"active"});const result=await h.call("GET","/v1/web/projects/payments/restore-preview");expect(result.status).toBe(200);expect(result.body).toMatchObject({status:"active",prerequisites:"not_required",access:{actions:[]}});expect(h.audit.recordedBy("project.restored")).toEqual([]);});
it("protects reviewed restore with cookie Origin and CSRF before persistence",async()=>{const h=await reviewedRestoreBroker();for(const headers of [{},{cookie:COOKIE},{cookie:COOKIE,origin:CELL},{...reviewedArchiveHeaders,origin:"https://evil.example"},{...reviewedArchiveHeaders,[APP_CSRF_HEADER]:"wrong"}]){expect([401,403]).toContain((await h.call("POST","/v1/web/projects/payments/reviewed-restore",headers,reviewedRestoreBody())).status);expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))?.status).toBe("archived");expect(h.audit.recordedBy("project.restored")).toEqual([]);}});
for(const role of ["owner","admin","maintainer","contributor","viewer","member","revoked","second-org"] as const)it(`requires live ${role} for cookie reviewed restore`,async()=>{const h=await reviewedRestoreBroker();seedMembership(h.db,WHO,{orgId:TEST_ORG,role:role==="owner"||role==="admin"?role:"member"});if(["maintainer","contributor","viewer"].includes(role))h.db.set({...projectMemberKey(TEST_ORG,WHO,"payments"),role:role==="viewer"?"viewer":"developer",projectRole:role,projectName:"payments"});if(role==="revoked")h.db.delete(orgMemberKey(TEST_ORG,WHO));if(role==="second-org")seedMembership(h.db,WHO,{orgId:"org_bbbbbbbbbbbbbbbbbbbb",role:"owner"});const result=await h.call("POST","/v1/web/projects/payments/reviewed-restore",reviewedArchiveHeaders,reviewedRestoreBody()),allowed=["owner","admin","maintainer"].includes(role);expect(result.status,JSON.stringify(result.body)).toBe(allowed?200:role==="second-org"?404:403);expect(h.audit.recordedBy("project.restored").length).toBe(allowed?1:0);});
it("pins restore method/path pairing and rejects missing acknowledgment without writes",async()=>{const h=await reviewedRestoreBroker();for(const [method,path] of [["POST","/v1/web/projects/payments/restore-preview"],["GET","/v1/web/projects/payments/reviewed-restore"]]){expect((await h.call(method!,path!,reviewedArchiveHeaders,method==="POST"?reviewedRestoreBody():undefined)).status).toBe(404);expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))?.status).toBe("archived");expect(h.audit.recordedBy("project.restored")).toEqual([]);}const body=reviewedRestoreBody();expect((await h.call("POST","/v1/web/projects/payments/reviewed-restore",reviewedArchiveHeaders,{requestId:body.requestId,expectedRevision:2,expectedProjectRevision:1})).status).toBe(400);expect(h.audit.recordedBy("project.restored")).toEqual([]);});
it("replays restore receipts without another audit and maps changed-body UUID conflicts to stale",async()=>{const h=await reviewedRestoreBroker(),body=reviewedRestoreBody(),path="/v1/web/projects/payments/reviewed-restore";expect((await h.call("POST",path,reviewedArchiveHeaders,body)).status).toBe(200);const replay=await h.call("POST",path,reviewedArchiveHeaders,body);expect(replay.status).toBe(200);expect(replay.body).toMatchObject({replayed:true,effects:{egress:"not_attempted"},current:{status:"active"}});const conflict=await h.call("POST",path,reviewedArchiveHeaders,{...body,expectedRevision:3});expect(errorOf(conflict.body).code).toBe("CHANGE_STALE");expect(h.audit.recordedBy("project.restored").length).toBe(1);});

// B6 compatibility boundary: cookie lifecycle writes must use the reviewed APIs.
for(const change of ["archive","restore"] as const)for(const role of ["owner","admin","maintainer","contributor","viewer","member","revoked","second-org"] as const)it(`refuses legacy cookie ${change} for ${role} before any writes`,async()=>{const h=change==="restore"?await reviewedRestoreBroker():await reviewedArchiveBroker();seedMembership(h.db,WHO,{orgId:TEST_ORG,role:role==="owner"||role==="admin"?role:"member"});if(["maintainer","contributor","viewer"].includes(role))h.db.set({...projectMemberKey(TEST_ORG,WHO,"payments"),role:role==="viewer"?"viewer":"developer",projectRole:role,projectName:"payments"});if(role==="revoked")h.db.delete(orgMemberKey(TEST_ORG,WHO));if(role==="second-org")seedMembership(h.db,WHO,{orgId:"org_bbbbbbbbbbbbbbbbbbbb",role:"owner"});const before=h.db.get(projectMetaKey(TEST_ORG,"payments")),commands=h.db.commandNames().length;const result=await h.call("POST",`/v1/web/projects/payments/${change}`,reviewedArchiveHeaders,{requestId:randomUUID()});expect(result.status,JSON.stringify(result.body)).toBe(404);expect(errorOf(result.body).code).toBe("NOT_FOUND");expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))).toEqual(before);expect(h.db.commandNames().slice(commands).filter(name=>/Put|Update|Delete|TransactWrite/.test(name))).toEqual([]);expect(h.audit.recordedBy("project.archived")).toEqual([]);expect(h.audit.recordedBy("project.restored")).toEqual([]);});
for(const change of ["archive","restore"] as const)it(`refuses encoded and unavailable targets on legacy cookie ${change}`,async()=>{for(const project of ["%70ayments","missing","foreign-only"]){const h=change==="restore"?await reviewedRestoreBroker():await reviewedArchiveBroker(),before=h.db.get(projectMetaKey(TEST_ORG,"payments"));const result=await h.call("POST",`/v1/web/projects/${project}/${change}`,reviewedArchiveHeaders,{requestId:randomUUID()});expect(result.status,JSON.stringify(result.body)).toBe(404);expect(errorOf(result.body).message).toBe("route not found");expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))).toEqual(before);expect(h.audit.recordedBy("project.archived")).toEqual([]);expect(h.audit.recordedBy("project.restored")).toEqual([]);}});
it("does not leave a legacy cookie restore that skips a missing Cloud checker",async()=>{const h=await reviewedRestoreBroker("cloud-missing"),before=h.db.get(projectMetaKey(TEST_ORG,"payments"));const result=await h.call("POST","/v1/web/projects/payments/restore",reviewedArchiveHeaders,{requestId:randomUUID()});expect(result.status).toBe(404);expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))).toEqual(before);expect(h.audit.recordedBy("project.restored")).toEqual([]);});
for(const change of ["archive","restore"] as const)it(`preserves legacy token ${change} for CLI compatibility without requiring a new body`,async()=>{const h=change==="restore"?await reviewedRestoreBroker():await reviewedArchiveBroker();const body={requestId:randomUUID()},path=`/v1/app/projects/payments/${change}`,headers={authorization:"Bearer test-only-bearer"};const first=await h.call("POST",path,headers,body);expect(first.status,JSON.stringify(first.body)).toBe(200);expect(first.body.project).toMatchObject({name:"payments",status:change==="archive"?"archived":"active"});const meta=h.db.get(projectMetaKey(TEST_ORG,"payments"));const replay=await h.call("POST",path,headers,body);expect(replay.status).toBe(200);expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))).toEqual(meta);const noOp=await h.call("POST",path,headers,{requestId:randomUUID()});expect(noOp.status).toBe(200);expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))).toEqual(meta);expect(h.audit.recordedBy("project.archived")).toEqual([]);expect(h.audit.recordedBy("project.restored")).toEqual([]);});
for(const change of ["archive","restore"] as const)it(`refuses cookie-only fallback to the token ${change} path`,async()=>{const h=change==="restore"?await reviewedRestoreBroker():await reviewedArchiveBroker(),before=h.db.get(projectMetaKey(TEST_ORG,"payments"));const result=await h.call("POST",`/v1/app/projects/payments/${change}`,reviewedArchiveHeaders,{requestId:randomUUID()});expect(result.status).toBe(401);expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))).toEqual(before);});

// B10: real cookie restore company-pin fencing, including a valid same-name target.
it("accepts a cookie restore company pin and replays without the optional pin",async()=>{const h=await reviewedRestoreBroker(),body=reviewedRestoreBody(),path="/v1/web/projects/payments/reviewed-restore";expect((await h.call("POST",path,reviewedArchiveHeaders,{...body,expectedOrgId:TEST_ORG})).status).toBe(200);const replay=await h.call("POST",path,reviewedArchiveHeaders,body);expect(replay.status).toBe(200);expect(replay.body).toMatchObject({replayed:true,effects:{egress:"not_attempted"},current:{orgId:TEST_ORG,status:"active"}});expect(h.audit.recordedBy("project.restored")).toHaveLength(1);});
it("refuses a stale displayed company after a live cookie company switch with identical restore pins",async()=>{const h=await reviewedRestoreBroker(),otherOrg="org_bbbbbbbbbbbbbbbbbbbb",preview=await h.call("GET","/v1/web/projects/payments/restore-preview");expect(preview.status).toBe(200);for(const key of [orgProjectCatalogKey(TEST_ORG,"payments"),projectRevisionKey(TEST_ORG,"payments",1),projectMetaKey(TEST_ORG,"payments")]){const row=h.db.get(key)!;h.db.set({...row,pk:String(row.pk).replace(TEST_ORG,otherOrg)});}seedMembership(h.db,WHO,{orgId:otherOrg,role:"owner"});const before=h.db.transactions().length,result=await h.call("POST","/v1/web/projects/payments/reviewed-restore",reviewedArchiveHeaders,{...reviewedRestoreBody(),expectedOrgId:preview.body.orgId});expect(result.status,JSON.stringify(result.body)).toBe(409);expect(errorOf(result.body)).toMatchObject({code:"CHANGE_STALE",message:"The company changed. Refresh and review the restore again."});for(const orgId of [TEST_ORG,otherOrg])expect(h.db.get(projectMetaKey(orgId,"payments"))?.status).toBe("archived");expect(h.db.transactions()).toHaveLength(before);expect(h.audit.recordedBy("project.restored")).toEqual([]);});
it("refuses a cookie restore replay with a foreign company pin",async()=>{const h=await reviewedRestoreBroker(),body=reviewedRestoreBody(),path="/v1/web/projects/payments/reviewed-restore";expect((await h.call("POST",path,reviewedArchiveHeaders,body)).status).toBe(200);const result=await h.call("POST",path,reviewedArchiveHeaders,{...body,expectedOrgId:"org_bbbbbbbbbbbbbbbbbbbb"});expect(result.status).toBe(409);expect(errorOf(result.body).code).toBe("CHANGE_STALE");expect(h.audit.recordedBy("project.restored")).toHaveLength(1);});
it("rejects malformed cookie restore pins and retains CSRF fencing with valid pins",async()=>{const h=await reviewedRestoreBroker(),path="/v1/web/projects/payments/reviewed-restore",body=reviewedRestoreBody();for(const expectedOrgId of [null,42,"bad"]){expect((await h.call("POST",path,reviewedArchiveHeaders,{...body,expectedOrgId})).status).toBe(400);}for(const headers of [{cookie:COOKIE,origin:CELL},{...reviewedArchiveHeaders,origin:"https://evil.example"},{...reviewedArchiveHeaders,[APP_CSRF_HEADER]:"wrong"}])expect((await h.call("POST",path,headers,{...body,expectedOrgId:TEST_ORG})).status).toBe(403);expect(h.db.get(projectMetaKey(TEST_ORG,"payments"))?.status).toBe("archived");expect(h.audit.recordedBy("project.restored")).toEqual([]);});
