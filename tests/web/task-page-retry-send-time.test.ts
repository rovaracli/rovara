// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { sessionScope } from "../../packages/ui/src/api/session-safety.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

it("R4-2/R6c: a legacy Retry arriving while a new Retry claim waits cannot be resent from stale rendered controls", async () => {
 const base = workspaceFixture(), me = meFixture(), identity = { companyId: me.org.orgId, personId: me.developer.id };
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : r.method === "GET" ? { status: 200, body: { session: { ...base, you: { ...base.you, actions: ["retry", "stop", "close"] } } } } : { status: 503, body: { error: { code: "UPSTREAM", message: "Result unknown" } } });
 const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(SessionControls, { id: base.sessionId, agent: "Agent", actions: ["retry", "stop", "close"], following: false, onChanged: async () => undefined }) }) }));
 const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry" });await waitFor(() => expect(button.disabled).toBe(false));
 const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks")!;let claim: (() => Promise<unknown>) | undefined;
 Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => new Promise((resolve, reject) => { claim = async () => { try { const result = await callback({ name: "retry-claim", mode: "exclusive" });resolve(result);return result; } catch (error) { reject(error instanceof Error ? error : new Error(String(error)));throw error; } }; }) } });
 const old = { requestId: "11111111-1111-4111-8111-111111111111", action: "retry", body: { requestId: "11111111-1111-4111-8111-111111111111" }, startedAt: Date.now() - 1000, fence: 0 }, legacyKey = sessionScope(identity, "retry-legacy:" + base.sessionId) + ":request";
 try {
  fireEvent.click(button);await waitFor(() => expect(claim).toBeTypeOf("function"));
  // Another tab has migrated the old lock, before its storage event reaches this mount.
  f.storage.set(legacyKey, JSON.stringify(old));
  await act(async () => { await claim!(); });await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(0);
  expect(f.storage.get(legacyKey)).toBe(JSON.stringify(old));expect(screen.getByRole<HTMLButtonElement>("button", { name: "Retry" }).disabled).toBe(true);
 } finally { Object.defineProperty(navigator, "locks", descriptor);ui.unmount();query.clear(); }
});

for (const code of ["IDEMPOTENCY_CONFLICT", "CONFLICT"]) it(`R6 Retry ${code}: shows the refusal, re-reads and releases the request across remount`, async () => {
 const base = workspaceFixture(), me = meFixture();let reads = 0;
 const words = code === "CONFLICT" ? "There's nothing to retry on this session right now." : "The reviewed task changed. Read it again.";
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : r.method === "GET" ? (reads++, { status: 200, body: { session: { ...base, revision: reads + 1, you: { ...base.you, actions: ["retry", "stop"] } } } }) : { status: 409, body: { error: { code, message: words } } });
 const query = createQueryClient();query.setQueryData(["session", base.sessionId], base);
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(SessionControls, { id: base.sessionId, agent: "Agent", actions: ["retry", "stop"], following: false, onChanged: async () => undefined }) }) });
 let ui = renderUi(tree());
 try {
  const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry" });await waitFor(() => expect(retry.disabled).toBe(false));fireEvent.click(retry);
  await screen.findByText(words);
  await waitFor(() => expect(reads).toBe(2));await waitFor(() => expect(retry.disabled).toBe(false));
  const scope = sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, "retry:" + base.sessionId);
  expect(f.storage.get(scope + ":request")).toBe("null");
  expect(screen.queryByText(/Rovara didn't confirm this yet/)).toBeNull();
  ui.unmount();ui = renderUi(tree());await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Retry" }).disabled).toBe(false));
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 } finally { ui.unmount();query.clear(); }
});
