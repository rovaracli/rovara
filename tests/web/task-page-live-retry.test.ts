// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionTile } from "../../packages/ui/src/screens/live/SessionTile.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { liveFixture } from "./support/live-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expect, it, vi } from "vitest";
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

it("R6-1 cold Live Retry opens the task review without making consent pins or a pinless Cloud POST", async () => {
 const cloud = await setup();
 const missing = await cloud.post("retry", {});expect(missing?.status).toBe(400);
 expect(JSON.parse(missing!.body)).toMatchObject({ error: { code: "CONFIG_INVALID" } });
 expect(cloud.calls).toHaveLength(0);
 const f = fakeHost(async r => {
  if (r.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (r.method === "GET") return { status: 200, body: { session: workspaceFixture({ you: { ...workspaceFixture().you, actions: ["retry"] } }) } };
  const answer = await cloud.post("retry", r.body as object);
  return { status: answer!.status, body: JSON.parse(answer!.body) as unknown };
 }), query = createQueryClient();
 const navigate = vi.spyOn(f.host, "navigate");
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(SessionTile, { tile: liveFixture({ actions: ["retry"] }), onChanged: async () => undefined }) }) }) }));
 try {
  expect(query.getQueryData(["session", id])).toBeUndefined();
  const retry = screen.getByRole<HTMLButtonElement>("button", { name: "Retry" });await waitFor(() => expect(retry.disabled).toBe(false));fireEvent.click(retry);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/s/" + id));
  expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(0);
  expect(f.request.mock.calls.filter(([r]) => r.path === "/v1/app/sessions/" + id)).toHaveLength(0);
  expect(query.getQueryData(["session", id])).toBeUndefined();expect(cloud.calls).toHaveLength(0);expect(cloud.writes()).toBe(0);
 } finally { ui.unmount();query.clear(); }
});
