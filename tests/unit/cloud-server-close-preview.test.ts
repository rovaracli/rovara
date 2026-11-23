import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type CodeSession, type WorkSession } from "../../packages/cloud-server/src/index.js";
import { SessionCloseResponseReaderSchema } from "../../packages/contracts/src/web.js";
import { CORE_TASK_ROUTES as F } from "../fixtures/code-core-task-routes.js";
import { CLOSE_TASK_ID as TASK, CLOSE_REQUEST_ID as REQUEST, CLOSE_DIGEST as DIGEST, closePreview, RETAINED_CLOSE_REFUSAL } from "../web/support/task-close-preview.js";

const SESSION = "ses_aaaaaaaaaaaaaaaaaaaa", ORIGIN = "https://cloud.example.test";
const path = `/v1/web/sessions/${SESSION}/close`;
type Reply = { status: number; body: unknown };
interface Call { method: string; path: string; search: string; token: string; body: unknown }
function setup(options: { preview?: unknown; previewReply?: Reply; close?: Reply; missing?: boolean } = {}) {
 const calls: Call[] = [];
 const task = { ...F.sessions.startedTask, taskId: TASK };
 const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const call: Call = { method: init?.method ?? "GET", path: url.pathname, search: url.search, token: new Headers(init?.headers).get("authorization") ?? "", body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined };
  calls.push(call);
  let answer: Reply = { status: 404, body: { error: { code: "TASK_NOT_FOUND", message: "No such task." } } };
  // Even if the preview endpoint were permissive, Cloud must first use the same read check as the task page.
  if (call.method === "GET" && url.pathname.endsWith("/close")) answer = options.previewReply ?? { status: 200, body: options.preview ?? closePreview(url.searchParams.get("action") as "close" | "discard") };
  if (call.token === "Bearer ada" || call.token === "Bearer reader") {
   if (url.pathname === `/v1/dev/tasks/${TASK}`) answer = { status: 200, body: { task } };
   if (call.method === "POST" && url.pathname.endsWith("/close")) answer = call.token === "Bearer reader" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Only the task owner can close it." } } } : options.close ?? { status: 200, body: { task: { ...task, status: "CLOSED", closedAt: "2026-11-22T12:00:00.000Z" }, closed: true } };
  }
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
 }) as typeof fetch;
 const store = new LocalSessionStore(undefined, { environment: {} }), work = new LocalWorkSessionStore();
 const client = new CodeClient({ baseUrl: "https://code.example.test", clientId: "cloud", clientSecret: "fixture", redirectUri: ORIGIN + "/callback", scopes: "", fetch: fetchImpl });
 const handler = createCloudHandler({ client, store, work, origin: ORIGIN, org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined });
 const signIn = async (who = "ada") => {
  const access: CodeSession["access"] = { developerId: (who === "ada" ? "a" : "b").repeat(64), displayName: who, administrator: false, projects: who === "foreign" ? [] : [{ name: "payments", access: "developer" }], notices: [] };
  await store.create(who, { accessToken: who, csrf: "csrf", signedInAt: "2026-11-22T00:00:00.000Z", access });
  if (!options.missing && await work.get(SESSION) === undefined) await work.put({ sessionId: SESSION, taskId: TASK, project: "payments", startedBy: { developerId: "a".repeat(64), name: "Ada" }, owner: { developerId: "a".repeat(64), name: "Ada" }, createdAt: "2026-11-22T00:00:00.000Z", revision: 1 } satisfies WorkSession);
  return { cookie: `rovara_cloud_session=${who}`, "x-rovara-csrf": "csrf", origin: ORIGIN } as Record<string, string>;
 };
 const send = async (method: string, target: string, headers: Record<string, string>, body?: unknown) => {
  const url = new URL(target, ORIGIN);
  const req: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  const res = (await handler(req))!;
  return { status: res.status, body: JSON.parse(res.body) as unknown };
 };
 return { calls, signIn, send, task };
}

describe("Cloud Close preview", () => {
 // The dialog falls back to the legacy close ONLY on this served answer: Code's own "route not found" for a route an older Code lacks.
 it("says 501 NOT_ON_CODE_YET only for Code's exact 404 NOT_FOUND 'route not found'", async () => {
  const w = setup({ previewReply: { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } } });
  expect(await w.send("GET", path + "?action=close", await w.signIn())).toEqual({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "This Rovara Code can't show a Close preview yet." } } });
 });
 it.each([
  ["Code's core 404 for hosted tasks (the app treats this exact answer as 'no preview yet')", 404, "NOT_FOUND", "That is not on the core engine on this install yet."],
  ["a task refusal", 404, "TASK_NOT_FOUND", "No such task."], ["NOT_FOUND with another sentence", 404, "NOT_FOUND", "no such task"],
  ["'route not found' under another code", 404, "TASK_NOT_FOUND", "route not found"], ["'route not found' at another status", 403, "NOT_FOUND", "route not found"],
  ["a permission refusal", 403, "FORBIDDEN", "Not yours."], ["an outage", 503, "RUNTIME_UNAVAILABLE", "down"],
 ])("passes %s through unchanged, never as the not-served answer", async (_name, status, code, message) => {
  const w = setup({ previewReply: { status, body: { error: { code, message } } } });
  expect(await w.send("GET", path + "?action=close", await w.signIn())).toEqual({ status, body: { error: { code, message } } });
 });
 it.each(["close", "discard"] as const)("forwards the %s preview unchanged as the authorised reader", async action => {
   const w = setup(), headers = await w.signIn("reader");
   const res = await w.send("GET", path + `?action=${action}`, headers);
   expect(res).toEqual({ status: 200, body: closePreview(action) });
   expect(w.calls).toEqual([
    { method: "GET", path: `/v1/dev/tasks/${TASK}`, search: "?events=0", token: "Bearer reader", body: undefined },
    { method: "GET", path: `/v1/dev/tasks/${TASK}/close`, search: `?action=${action}`, token: "Bearer reader", body: undefined },
   ]);
 });
 it.each(["inspection_required", "busy", "unsupported"])("keeps unavailable: %s as a refusal to offer a bound action", async unavailable => {
  const body = { preview: null, unavailable }, w = setup({ preview: body });
  expect(await w.send("GET", path + "?action=close", await w.signIn())).toEqual({ status: 200, body });
 });
 it("refuses anonymous, no-access and foreign callers before reading any preview", async () => {
  const w = setup();
  expect((await w.send("GET", path + "?action=close", {})).status).toBe(401);expect(w.calls).toEqual([]);
  for (const who of ["unshared", "foreign"]) {
   expect((await w.send("GET", path + "?action=close", await w.signIn(who))).status).toBe(404);
   expect(w.calls.filter(c => c.path.endsWith("/close"))).toEqual([]);
  }
 });
 it("does not ask Code for a missing Cloud session", async () => {
  const w = setup({ missing: true });
  expect((await w.send("GET", path + "?action=close", await w.signIn())).status).toBe(404);expect(w.calls).toEqual([]);
 });
 it.each(["", "?action=destroy", "?action=close&action=discard", "?action=close&taskId=other"])("rejects an invalid preview query %s without asking the preview endpoint", async query => {
  const w = setup();expect((await w.send("GET", path + query, await w.signIn())).status).toBe(400);
  expect(w.calls.filter(c => c.path.endsWith("/close"))).toEqual([]);
 });
 it("refuses an unreadable preview without offering a digest", async () => {
  const w = setup({ preview: { preview: { digest: DIGEST } } });
  expect((await w.send("GET", path + "?action=close", await w.signIn())).status).toBe(502);
 });
});

describe("Cloud bound Close", () => {
 it.each([true, false, undefined])("forwards the digest and discard=%s byte-exact without legacy fallback", async discard => {
  const w = setup();
  const body = { requestId: REQUEST, expectedPreviewDigest: DIGEST, ...(discard === undefined ? {} : { discard_unpublished: discard }) };
  const res = await w.send("POST", path, await w.signIn(), body);
  expect(res.status).toBe(200);expect(SessionCloseResponseReaderSchema.parse(res.body).closed).toBe(true);
  expect(w.calls.filter(c => c.method === "POST")).toEqual([{ method: "POST", path: `/v1/dev/tasks/${TASK}/close`, search: "", token: "Bearer ada", body }]);
 });
 it("keeps an accepted close pending until Code actually closes the task", async () => {
  const w = setup({ close: { status: 200, body: { task: { ...F.sessions.startedTask, taskId: TASK } } } });
  const res = await w.send("POST", path, await w.signIn(), { requestId: REQUEST, expectedPreviewDigest: DIGEST });
  expect(res.status).toBe(200);expect(SessionCloseResponseReaderSchema.parse(res.body).closed).toBe(false);
 });
 it.each([
  { requestId: REQUEST, expectedPreviewDigest: null }, { requestId: REQUEST, expectedPreviewDigest: "A".repeat(64) },
  { requestId: REQUEST, expectedPreviewDigest: "a".repeat(63) }, { requestId: "bad", expectedPreviewDigest: DIGEST },
  { requestId: REQUEST, expectedPreviewDigest: DIGEST, discard_unpublished: "true" },
  { requestId: REQUEST, expectedPreviewDigest: DIGEST, discardUnpublished: true },
  { requestId: REQUEST, expectedPreviewDigest: DIGEST, force: true }, { requestId: REQUEST, discard_unpublished: true },
  { requestId: REQUEST, discard_unpublished: false },
 ])("rejects malformed bound input rather than downgrading it: %j", async body => {
  const w = setup();expect((await w.send("POST", path, await w.signIn(), body)).status).toBe(400);expect(w.calls).toEqual([]);
 });
 it.each([
  { status: 409, body: { error: { code: "CHANGE_STALE", message: "the close preview has changed; review it again" } } },
  { status: 404, body: { error: { code: "NOT_FOUND", message: "That is not on the core engine on this install yet." } } },
  { status: 409, body: RETAINED_CLOSE_REFUSAL },
 ])("preserves a bound refusal without an unbound fallback: %j", async close => {
  const w = setup({ close });
  expect(await w.send("POST", path, await w.signIn(), { requestId: REQUEST, expectedPreviewDigest: DIGEST, discard_unpublished: true })).toEqual(close);
  expect(w.calls).toHaveLength(1);
 });
 it("keeps Code's owner check and Cloud's CSRF on a bound write", async () => {
  const w = setup(), body = { requestId: REQUEST, expectedPreviewDigest: DIGEST };
  expect((await w.send("POST", path, {}, body)).status).toBe(401);
  const headers = await w.signIn();delete headers["x-rovara-csrf"];
  expect((await w.send("POST", path, headers, body)).status).toBe(403);expect(w.calls).toEqual([]);
  expect((await w.send("POST", path, await w.signIn("reader"), body)).status).toBe(403);
 });
 it("passes a retained-workspace legacy refusal through with its Close preview direction", async () => {
  const close = { status: 409, body: RETAINED_CLOSE_REFUSAL }, w = setup({ close });
  expect(await w.send("POST", path, await w.signIn(), { requestId: REQUEST })).toEqual(close);expect(w.calls).toHaveLength(1);
 });
 it.each([false, true])("leaves legacy close discard=%s body unchanged", async discard => {
  const w = setup();
  expect((await w.send("POST", path, await w.signIn(), { requestId: REQUEST, ...(discard ? { discardUnpublished: true } : {}) })).status).toBe(200);
  expect(w.calls[0]?.body).toEqual({ requestId: REQUEST, ...(discard ? { discard_unpublished: true } : {}) });
 });
});
