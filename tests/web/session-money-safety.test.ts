// @vitest-environment jsdom
import { expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { MoneyBanners } from "../../packages/ui/src/screens/session/MoneyBanners.js";
import { beginSessionRead, finishSessionRead, sessionScope } from "../../packages/ui/src/api/session-safety.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

it("normal-task continuation fences a concurrent read for its session without fencing another session", async () => {
 const session = workspaceFixture({}, { testOffer: { capUsd: 1 } }), other = workspaceFixture({ sessionId: "ses_bbbbbbbbbbbbbbbbbbbb" }, { testOffer: { capUsd: 2 } }), me = meFixture();
 let readIssue: number | undefined, otherIssue: number | undefined, injected = false;
 const f = fakeHost(async r => {
  if (r.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (r.path.endsWith("/continue-as-task")) return { status: 503, body: {} };
  if (r.method === "GET" && r.path.startsWith("/v1/app/sessions/")) {
   return { status: 200, body: { session: r.path.endsWith(other.sessionId) ? other : session } };
  }
  return { status: 200, body: {} };
 }), query = createQueryClient();
 const store = f.host.storage.set.bind(f.host.storage), scope = sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, session.sessionId);
 f.host.storage.set = (key, value) => {
  store(key, value);
  if (!injected && key.endsWith(":request") && key.includes(encodeURIComponent("normal-task:" + session.sessionId))) {
   injected = true;readIssue = beginSessionRead(f.host, scope);otherIssue = beginSessionRead(f.host, sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, other.sessionId));
  }
 };
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MoneyBanners, { session }) }) });
 const ui = renderUi(tree());
 fireEvent.click(await screen.findByRole("button", { name: "Continue as a normal task" }));
 await screen.findByText(/Rovara didn't confirm this yet/);await waitFor(() => expect(f.request.mock.calls.filter(([request]) => request.path.endsWith("/continue-as-task"))).toHaveLength(1));
 expect(injected).toBe(true);expect(() => finishSessionRead(f.host, scope, readIssue!)).toThrowError(expect.objectContaining({ code: "READ_SUPERSEDED" }));
 expect(() => finishSessionRead(f.host, sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, other.sessionId), otherIssue!)).not.toThrow();
 const operationScope = sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, "normal-task:" + session.sessionId);
 expect(f.storage.get(operationScope + ":request")).toBeDefined();expect(f.storage.get(scope + ":request")).toBeUndefined();
 ui.unmount();query.clear();
});

it("does not dispatch a normal-task continuation when its durable operation lock cannot be saved", async () => {
 const session = workspaceFixture({}, { testOffer: { capUsd: 1 } });
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.method === "GET" ? { status: 200, body: { session } } : { status: 503, body: {} }), query = createQueryClient();
 const setStorage = f.host.storage.set.bind(f.host.storage);
 f.host.storage.set = (key, value) => { if (key.includes("normal-task") && key.endsWith(":request")) throw new Error("storage unavailable");setStorage(key, value); };
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MoneyBanners, { session }) }) });
 const ui = renderUi(tree());fireEvent.click(await screen.findByRole("button", { name: "Continue as a normal task" }));
 expect((await screen.findByRole("alert")).textContent).toContain("can't be made safely");
 expect(f.request.mock.calls.filter(([request]) => request.path.endsWith("/continue-as-task"))).toHaveLength(0);ui.unmount();query.clear();
});

it("a normal-task continuation lost at 503 stays locked across remount", async () => {
 const session = workspaceFixture({}, { testOffer: { capUsd: 1 } });
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.method === "GET" ? { status: 200, body: { session } } : { status: 503, body: {} }), query = createQueryClient();
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MoneyBanners, { session }) }) });
 const first = renderUi(tree());const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Continue as a normal task" });
 await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
 await screen.findByText(/Rovara didn't confirm this yet/);first.unmount();
 const next = renderUi(tree());await screen.findByText(/Rovara didn't confirm this yet/);
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue as a normal task" }).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Check" }));
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1));next.unmount();query.clear();
});
