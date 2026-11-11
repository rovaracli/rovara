import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@rovara-code/contracts";
import { DECIDE_COOKIE, DecideReauthRequired, DecideStore, csrfTokenFor, requireDecideNavigation, requireDecideSession, type DecideRequestContext } from "../../packages/broker/src/developer/decide-session.js";
import type { DecideKind } from "../../packages/broker/src/developer/decide-kinds.js";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import { confirmPage, decidedPage, forbiddenPage, notFoundPage, reauthPage, refusedPage, resultPage } from "../../packages/broker/src/developer/confirm-page.js";
import type { HttpResult } from "../../packages/broker/src/developer/server.js";
import { createTaskWeb } from "../../packages/broker/src/aws/task-web.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { httpEvent, identityHarness } from "../support/developer-fakes.js";
const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, WHO = "a".repeat(64), APR = "apr_aaaaaaaaaaaaaaaaaaaa";
const CELL = "https://cell.example", NOW = Date.parse("2026-10-23T12:00:00Z"), COOKIE = "test-only-decide-cookie-" + "a".repeat(32);
const navigation = { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
async function setup() {
 const db = new FakeDynamoDb(), store = new DecideStore({ documentClient: db, tableName: "signin", now: () => NOW });
 const inspect = vi.fn<DecideKind["inspect"]>(async () => ({ status: "open", view: { title: "Sensitive approval fixture", facts: [], call: { connector: "fixture", tool: "write", arguments: { secretArgumentFixture: "never disclose before navigation" } } } }));
 const decide = vi.fn<DecideKind["decide"]>(async () => ({ message: "Approved." }));
 const context: DecideRequestContext = { store, now: () => NOW, cellOrigin: CELL, kinds: { apr: { inspect, decide }, spr: { inspect, decide } }, authenticateBearer: async () => ({ orgId: ORG, developerId: WHO }) };
 await store.putSession(COOKIE, { orgId: ORG, developerId: WHO, approvalId: APR, signedInAt: NOW / 1000, method: "email_code", csrfHash: createHash("sha256").update(csrfTokenFor(COOKIE)).digest("hex"), expiresAt: NOW / 1000 + 600 });
 const path = "/v1/app/approve/" + APR;
 const page = (method: string, headers: Record<string, string | undefined> = {}) => routeDecidePage(context, { method, path, requestId: "fixture", headers: { cookie: `${DECIDE_COOKIE}=${COOKIE}`, ...(method === "POST" ? { origin: CELL, "content-type": "application/x-www-form-urlencoded" } : {}), ...headers }, ...(method === "POST" ? { body: new URLSearchParams({ decision: "approve", csrf: csrfTokenFor(COOKIE) }).toString() } : {}) }, new URL(path, CELL));
 return { db, store, inspect, decide, context, page, path };
}
describe("a person's own approval navigation", () => {
 it("refuses every fetch and embedded document before exposing arguments or CSRF", async () => {
  const s = await setup();
  for (const headers of [{ "sec-fetch-mode": "cors", "sec-fetch-dest": "document" }, { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }, { "sec-fetch-mode": "same-origin", "sec-fetch-dest": "empty" }, { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty" }, { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }, { "sec-fetch-site": "same-origin" }]) {
   const response = await s.page("GET", { "sec-fetch-site": "same-origin", ...headers });
   expect(response.statusCode).toBe(403);expect(response.body).toContain("Open this approval from its link.");expect(response.body).not.toContain("secretArgumentFixture");expect(response.body).not.toContain('name="csrf"');expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
  }
  expect(s.inspect).not.toHaveBeenCalled();
  const opened = await s.page("GET", navigation);expect(opened.statusCode).toBe(200);expect(opened.body).toContain("secretArgumentFixture");expect(opened.body).toContain(csrfTokenFor(COOKIE));
 });
 it("requires activated form navigation and claims the decision only once", async () => {
  const s = await setup();
  for (const headers of [{ "sec-fetch-mode": "same-origin", "sec-fetch-dest": "empty", "sec-fetch-user": "?1" }, navigation, { ...navigation, "sec-fetch-user": "?0" }]) {
   expect((await s.page("POST", { "sec-fetch-site": "same-origin", ...headers })).statusCode).toBe(403);expect(s.decide).not.toHaveBeenCalled();expect((await s.store.getSession(COOKIE))?.usedAt).toBeUndefined();
  }
  expect((await s.page("POST", { ...navigation, "sec-fetch-site": "same-origin", "sec-fetch-user": "?1" })).statusCode).toBe(200);expect(s.decide).toHaveBeenCalledTimes(1);
  expect((await s.page("POST", { ...navigation, "sec-fetch-site": "same-origin", "sec-fetch-user": "?1" })).statusCode).toBe(401);expect(s.decide).toHaveBeenCalledTimes(1);
 });
 it("accepts a form POST from Safari, which sends no Sec-Fetch-User, and from browsers that send ?1", async () => {
  const post = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  for (const user of [undefined, "?1"]) {
   const s = await setup();
   expect((await s.page("POST", { ...post, ...(user === undefined ? {} : { "sec-fetch-user": user }) })).statusCode).toBe(200);expect(s.decide).toHaveBeenCalledTimes(1);
  }
 });
 it("still refuses a POST that is not a same-origin document navigation, or has a wrong Sec-Fetch-User, or no CSRF token", async () => {
  const post = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-user": "?1" };
  for (const bad of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "none" }, { "sec-fetch-mode": "cors" }, { "sec-fetch-mode": "same-origin" }, { "sec-fetch-dest": "iframe" }, { "sec-fetch-dest": "empty" }, { "sec-fetch-user": "?0" }, { "sec-fetch-user": "1" }, { "sec-fetch-user": "" }, { "sec-fetch-user": "?1, ?1" }]) {
   for (const withoutUser of [false, true]) {
    if (withoutUser && "sec-fetch-user" in bad) continue;
    const s = await setup(), headers: Record<string, string | undefined> = { ...post, ...bad };if (withoutUser) delete headers["sec-fetch-user"];
    expect((await s.page("POST", headers)).statusCode, JSON.stringify(headers)).toBe(403);expect(s.decide).not.toHaveBeenCalled();expect((await s.store.getSession(COOKIE))?.usedAt).toBeUndefined();
   }
  }
  const s = await setup();
  const noToken = await routeDecidePage(s.context, { method: "POST", path: s.path, requestId: "fixture", headers: { cookie: `${DECIDE_COOKIE}=${COOKIE}`, origin: CELL, "content-type": "application/x-www-form-urlencoded", ...post }, body: new URLSearchParams({ decision: "approve" }).toString() }, new URL(s.path, CELL));
  expect(noToken.statusCode).toBe(403);expect(s.decide).not.toHaveBeenCalled();expect((await s.store.getSession(COOKIE))?.usedAt).toBeUndefined();
 });
 it("keeps older browser navigation and forms working without fetch metadata", async () => {
  const s = await setup();expect((await s.page("GET")).statusCode).toBe(200);expect((await s.page("POST")).statusCode).toBe(200);expect(s.decide).toHaveBeenCalledTimes(1);
 });
 it("refuses scripted JSON decisions before minting a token's confirmation ticket", async () => {
  const s = await setup();
  for (const id of [APR, "spr_aaaaaaaaaaaaaaaaaaaa"]) for (const mode of ["cors", "same-origin", "no-cors"]) {
   const before = s.db.commandNames().length;
   const refused = requireDecideSession(s.context, { method: "POST", path: `/v1/app/${id.startsWith("apr") ? "approvals" : "spend-requests"}/${id}/decide`, headers: { authorization: "Bearer fixture", "sec-fetch-site": "same-origin", "sec-fetch-mode": mode } });
   await expect(refused).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });await expect(refused).rejects.toThrow("Open this approval from its link.");
   expect(s.db.commandNames().slice(before)).toEqual([]);
  }
  await expect(requireDecideSession(s.context, { method: "POST", path: `/v1/app/approvals/${APR}/decide`, headers: { authorization: "Bearer fixture" } })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
  expect(s.db.find(item => String(item.pk).startsWith("DECIDE_TICKET#"))).toHaveLength(1);
 });
 it("preserves REAUTH_REQUIRED for real Node fetch bearer clients with mode cors and no site", async () => {
  const s = await setup();let mode: string | undefined, site: string | undefined;
  const server = createServer((request, response) => {
   void (async () => {
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(",") : value]));mode = headers["sec-fetch-mode"];site = headers["sec-fetch-site"];
    try { await requireDecideSession(s.context, { method: "POST", path: request.url!, headers });response.end(JSON.stringify({ code: "unexpected_success" })); }
    catch (failure) { response.setHeader("content-type", "application/json");response.end(JSON.stringify(failure instanceof DecideReauthRequired ? { code: failure.code, confirmationMinted: typeof failure.details.confirmUrl === "string" } : { code: "FORBIDDEN", confirmationMinted: false })); }
   })().catch(() => { response.statusCode = 500;response.end("fixture_error"); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
   const address = server.address();if (address === null || typeof address === "string") throw new Error("Fixture listener missing.");
   for (const [family, id] of [["approvals", APR], ["spend-requests", "spr_aaaaaaaaaaaaaaaaaaaa"]] as const) {
    const answer = await fetch(`http://127.0.0.1:${address.port}/v1/app/${family}/${id}/decide`, { method: "POST", headers: { authorization: "Bearer fixture" } });
    expect(await answer.json()).toEqual({ code: "REAUTH_REQUIRED", confirmationMinted: true });expect(mode).toBe("cors");expect(site).toBeUndefined();
   }
  } finally { server.closeAllConnections();await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
 });
 it("exposes the same explicit navigation guard to callers", () => {
  expect(() => requireDecideNavigation({ method: "GET", path: "/v1/app/approve/" + APR, headers: navigation })).not.toThrow();
  expect(() => requireDecideNavigation({ method: "GET", path: "/v1/app/approve/" + APR, headers: { "sec-fetch-site": "same-origin", "sec-fetch-user": "?1" } })).toThrow("Open this approval from its link.");
 });
 it("isolates every rendered confirmation state and a missing-session redirect", async () => {
  const pages = [confirmPage({ title: "Fixture", facts: [] }, { approvalId: APR, csrf: "fixture" }), decidedPage("Already done"), forbiddenPage("No access"), notFoundPage(), reauthPage("/v1/auth/decide/start"), refusedPage(403, "Refused", "Open again"), resultPage("Approved", "Done")];
  for (const page of pages) expect(page.headers["cross-origin-opener-policy"]).toBe("same-origin");
  const s = await setup();await s.store.deleteSession(COOKIE);expect((await s.page("GET", navigation)).headers["cross-origin-opener-policy"]).toBe("same-origin");
 });
 it("isolates the broker error response when approvals are not configured", async () => {
  const h = await createAdminBroker();const event = httpEvent("GET", "/v1/app/approve/" + APR);
  const response = await h.handler({ ...event, routeKey: "ANY /v1/app/{proxy+}" }) as HttpResult;
  expect(response.statusCode).toBe(404);expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
 });
 it("isolates decide sign-in error and chooser pages", async () => {
  for (const h of [identityHarness({ slackUsers: [], cloud: {}, decide: {} }), identityHarness({ slackUsers: [], cloud: {} })]) for (const path of ["/v1/auth/decide/start?ticket=invalid", "/v1/auth/decide/identify?return=invalid", `/v1/auth/decide/identify?return=${encodeURIComponent('/v1/app/approve/' + APR)}`]) {
   const response = await h.http(httpEvent("GET", path));expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
  }
 });
 it("isolates task-page errors and sign-in redirects", async () => {
  const task = createTaskWeb({ authenticateSession: async () => undefined, getTaskDocumentView: async () => { throw new Error("Unexpected task read"); } });
  for (const path of ["/review/not-an-id/task", "/review/11111111-1111-4111-8111-111111111111/task"]) {
   const response = await task({ method: "GET", path, requestId: "fixture", headers: {} }, new URL(path, CELL));expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
  }
 });
});
