import { createInviteAdminApi } from "../../packages/ui/src/api/invite-admin.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { developerOrgKey, orgMemberKey, orgRemovedKey, orgBanKey, orgEmailKey, orgProjectCatalogKey, projectAiKey } from "@agentx/contracts";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { BROWSER_RETURN_TO } from "../../packages/broker/src/developer/server.js";
import { createTaskWebApi } from "../../packages/broker/src/aws/task-web-api.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { httpEvent, identityHarness } from "../support/developer-fakes.js";
import { bench } from "../support/audit-routes-bench.js";
import { createOnboardingApi } from "../../packages/ui/src/api/onboarding.js";
import { fakeHost } from "../web/support/fake-host.js";
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
 it("keeps decisions, token-only identity management and unknown families out of web", async () => {
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
