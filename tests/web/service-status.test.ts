// @vitest-environment jsdom
import { createElement as h } from "react";
import { expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa", checkedAt = "2026-10-30T14:30:00.000Z", expiresAt = "2026-11-02T14:30:00.000Z";
const evidence = { orgId, source: "stored_runtime_qualification", configured: true, checkedAt, checks: [{ kind: "web", state: "ready", observation: "qualified", reason: "qualified", expiresAt }, { kind: "api", state: "unknown", observation: "unknown", reason: "not_observed" }] };
it("B35 Health details show coarse status with table semantics and explicit read-only refresh", async () => {
 const { ServiceStatusContent } = await import("../../packages/ui/src/screens/admin/health/ServiceStatusScreen.js"), f = fakeHost(async () => ({ status: 200, body: evidence }));
 renderUi(h(MemoryRouter, { children: h(AppHostProvider, { host: f.host, children: h(ServiceStatusContent, { orgId, kind: "web", enabled: true }) }) }));
 expect(await screen.findByRole("heading", { name: "Rovara service status: browser runtime" })).toBeTruthy();await screen.findByText("ready");
 const table = screen.getByRole("table", { name: "Stored browser runtime qualification" });expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(4);expect(table.querySelectorAll("time")).toHaveLength(2);
 expect(screen.getByText(/not a live availability check/i)).toBeTruthy();expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
 fireEvent.click(screen.getByRole("button", { name: "Refresh stored status" }));await screen.findByText(/Stored status refreshed/);
 expect(f.request.mock.calls.every(([input]) => input.method === "GET" && input.retry === "never")).toBe(true);expect(JSON.stringify(f.request.mock.calls)).not.toContain("/v1/admin/");
});
it("B35 missing runtime evidence is unknown and never a healthy claim", async () => {
 const { ServiceStatusContent } = await import("../../packages/ui/src/screens/admin/health/ServiceStatusScreen.js"), f = fakeHost(async () => ({ status: 200, body: evidence }));
 renderUi(h(MemoryRouter, { children: h(AppHostProvider, { host: f.host, children: h(ServiceStatusContent, { orgId, kind: "api", enabled: true }) }) }));
 await screen.findByText("unknown");expect(screen.getByText(/No stored qualification was observed/)).toBeTruthy();expect(screen.queryByText("ready")).toBeNull();
});
it("B35 disabling company scope hides prior service evidence immediately", async () => {
 const { ServiceStatusContent } = await import("../../packages/ui/src/screens/admin/health/ServiceStatusScreen.js"), f = fakeHost(async () => ({ status: 200, body: evidence }));
 const view = renderUi(h(MemoryRouter, { children: h(AppHostProvider, { host: f.host, children: h(ServiceStatusContent, { orgId, kind: "web", enabled: true }) }) }));await screen.findByText("ready");
 view.rerender(h(MemoryRouter, { children: h(AppHostProvider, { host: f.host, children: h(ServiceStatusContent, { orgId, kind: "web", enabled: false }) }) }));expect(screen.queryByRole("table")).toBeNull();expect(screen.queryByText("ready")).toBeNull();
});
it("SRL-6 the list shows one Team record deletes row when the answer has it, and none when it does not", async () => {
 const { ServiceStatusContent } = await import("../../packages/ui/src/screens/admin/health/ServiceStatusScreen.js");
 const show = async (body: unknown) => { const f = fakeHost(async () => ({ status: 200, body })), view = renderUi(h(MemoryRouter, { children: h(AppHostProvider, { host: f.host, children: h(ServiceStatusContent, { orgId, enabled: true }) }) })); await screen.findByText(/Stored status refreshed/);return view; };
 const view = await show({ ...evidence, teamRecord: { status: "warn", detail: "1 erase second pass failed or stuck in the last 24 hours" } });
 expect(screen.getByText(/Team record deletes: warn · 1 erase second pass failed or stuck/)).toBeTruthy();
 expect(screen.getAllByRole("listitem")).toHaveLength(3);
 view.unmount();
 await show(evidence);
 expect(screen.queryByText(/Team record deletes/)).toBeNull();
 expect(screen.getAllByRole("listitem")).toHaveLength(2);
});
