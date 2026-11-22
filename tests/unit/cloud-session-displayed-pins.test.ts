import { expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
const id = "ses_aaaaaaaaaaaaaaaaaaaa", taskId = "11111111-1111-4111-8111-111111111111", requestId = "33333333-3333-4333-8333-333333333333", developerId = "a".repeat(64), digest = "d".repeat(64);
async function setup() {
 const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
 let revision = 16, writes = 0, unsupported = false;
 const task = () => ({ taskId, title: "Reviewed task", project: "payments", status: "SUCCEEDED", startingRevision: 1, client: "app", shared: false, createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:00:00.000Z", events: [], workflow: { stage: "REVIEW", state: "BLOCKED", revision, candidate: { digest }, verification: { candidateDigest: digest, reviewOnly: true, results: [] }, reviews: [{ role: "CRITIC", status: "FINDINGS", candidateDigest: digest, findings: [{ origin: "INTRODUCED", advisory: false, text: "Shown finding" }] }] } });
 const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
 const client = new CodeClient({ baseUrl: "https://code.example.test", clientId: "test-client", clientSecret: "fixture-only", redirectUri: "https://cloud.example.test/callback", scopes: "projects:members", fetch: async (input, init) => {
  const path = new URL(input instanceof Request ? input.url : input).pathname;
  if ((init?.method ?? "GET") === "GET" && path === `/v1/dev/tasks/${taskId}`) return json(200, { task: task() });
  if (init?.method === "POST") {
   const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<string, unknown>;calls.push({ path, body });
   if (unsupported) return json(501, { error: { code: "CORE_NOT_YET", message: "Not served" } });
   // Stand-in for the owning Code transaction; a stale pin has no effects.
   if (body.expectedRevision !== revision || body.candidateDigest !== undefined && body.candidateDigest !== digest) return json(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "Changed after display" } });
   writes++;return json(200, { task: task() });
  }
  return json(404, { error: { code: "NOT_FOUND", message: "Not served" } });
 } });
 const store = new LocalSessionStore(undefined, { environment: {} }), work = new LocalWorkSessionStore();
 await store.create("fixture-cookie", { accessToken: "fixture-token", refreshToken: "fixture-refresh", csrf: "csrf", signedInAt: "2026-11-17T00:00:00.000Z", access: { developerId, displayName: "Ada", administrator: true, projects: [{ name: "payments", access: "administrator" }], notices: [] } });
 await work.put({ sessionId: id, taskId, project: "payments", owner: { developerId, name: "Ada" }, startedBy: { developerId, name: "Ada" }, createdAt: "2026-11-14T10:00:00.000Z", revision: 1 });
 const handler = createCloudHandler({ client, store, work, origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined });
 return { calls, drift() { revision++; }, unsupported() { unsupported = true; }, writes: () => writes, async post(action: string, pins: object = { expectedRevision: 16, candidateDigest: digest }) {
  const request: CloudRequest = { method: "POST", path: `/v1/web/sessions/${id}/${action}`, query: new URLSearchParams(), headers: { cookie: "rovara_cloud_session=fixture-cookie", "x-rovara-csrf": "csrf" }, body: JSON.stringify({ requestId, note: "Fix these findings", reason: "Reviewed these findings", ...pins }) };
  return handler(request);
 } };
}
for (const action of ["retry", "send-back", "accept-findings"]) {
 it(`DEC283 ${action}: preserves the displayed pins; drift returns 409 with zero effects and no resend`, async () => {
  const s = await setup();s.drift();expect((await s.post(action))?.status).toBe(409);expect(s.writes()).toBe(0);
  expect(s.calls).toHaveLength(1);expect(s.calls[0]?.body).toMatchObject({ expectedRevision: 16, ...(action === "send-back" ? {} : { candidateDigest: digest }) });
 });
 it(`DEC283 ${action}: matching displayed pins still work`, async () => {
  const s = await setup();expect((await s.post(action))?.status).toBe(200);expect(s.writes()).toBe(1);
 });
 it(`DEC283 ${action}: refuses missing pins without dispatch`, async () => {
  const s = await setup();expect((await s.post(action, {}))?.status).toBe(400);expect(s.calls).toHaveLength(0);expect(s.writes()).toBe(0);
 });
}
it("DEC283 Retry never falls back to the core's unversioned session Retry", async () => {
 const s = await setup();s.unsupported();expect((await s.post("retry"))?.status).not.toBe(200);expect(s.calls).toHaveLength(1);expect(s.calls[0]?.path).toMatch(/workflow\/review$/);expect(s.writes()).toBe(0);
});
