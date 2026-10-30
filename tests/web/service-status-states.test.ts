// @vitest-environment jsdom
import { createElement as h } from "react";
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa", checkedAt = "2026-10-30T14:30:00.000Z", expiresAt = "2026-10-31T14:30:00.000Z";
type Check = { kind: "web" | "api"; state: string; observation: string; reason: string; expiresAt?: string };
const unknown = (reason: string): Check[] => (["web", "api"] as const).map(kind => ({ kind, state: "unknown", observation: "unknown", reason }));
const body = (checks: Check[], configured = true) => ({ orgId, source: "stored_runtime_qualification", configured, checkedAt, checks });
async function mount(respond: () => Promise<{ status: number; body: unknown }>, kind?: "web" | "api") {
 const { ServiceStatusContent } = await import("../../packages/ui/src/screens/admin/health/ServiceStatusScreen.js"), f = fakeHost(respond);
 const view = renderUi(h(MemoryRouter, { children: h(AppHostProvider, { host: f.host, children: h(ServiceStatusContent, { orgId, ...(kind === undefined ? {} : { kind }), enabled: true }) }) }));
 return { f, view };
}
const states = [
 ["warning (expiring)", [{ kind: "web", state: "ready", observation: "warning", reason: "expiring", expiresAt }, ...unknown("not_observed").slice(1)], true, "Warning", /expires soon\. Contact your Rovara operator/, "ready"],
 ["warning (not ready)", [{ kind: "web", state: "parked", observation: "warning", reason: "not_ready", expiresAt }, ...unknown("not_observed").slice(1)], true, "Warning", /does not permit browser or API checks/, "parked"],
 ["expired", [{ kind: "web", state: "ready", observation: "expired", reason: "expired", expiresAt }, ...unknown("not_observed").slice(1)], true, "Expired", /has expired\. Contact your Rovara operator/, "ready"],
 ["invalid_evidence", unknown("invalid_evidence"), true, "Not observed", /evidence could not be validated/, "unknown"],
 ["not_configured", unknown("not_configured"), false, "Not observed", /not configured in this deployment/, "unknown"],
 ["unavailable", unknown("unavailable"), true, "Not observed", /could not be read\.$/, "unknown"],
] as const;
for (const [label, checks, configured, observation, copy, state] of states) it(`B35 ${label} shows its own copy and never reads as healthy`, async () => {
 await mount(async () => ({ status: 200, body: body(checks as unknown as Check[], configured) }), "web");
 const table = await screen.findByRole("table", { name: "Stored browser runtime qualification" });
 expect(screen.getByText(copy)).toBeTruthy();
 expect(table.querySelector("tr:nth-child(1) td")?.textContent).toBe(state);
 expect(table.querySelector("tr:nth-child(2) td")?.textContent).toBe(observation);
 expect(screen.queryByText("Qualification recorded")).toBeNull();expect(screen.queryByText(/outside the doctor's expiry warning window/)).toBeNull();
 expect(table.querySelectorAll("time")).toHaveLength(checks[0].expiresAt === undefined ? 1 : 2);
 expect(table.querySelector("tr:nth-child(4) td")?.textContent).toBe(checks[0].expiresAt === undefined ? "Not observed" : new Date(expiresAt).toLocaleString());
});
it("B35 Overview lists each runtime with its state and observation label", async () => {
 await mount(async () => ({ status: 200, body: body([{ kind: "web", state: "ready", observation: "warning", reason: "expiring", expiresAt }, { kind: "api", state: "ready", observation: "expired", reason: "expired", expiresAt }]) }));
 const items = (await screen.findAllByRole("listitem")).map(item => item.textContent);
 expect(items).toEqual(["browser runtime — ready · Warning", "API runtime — ready · Expired"]);
 expect(screen.getByText(/Their configuration does not prove a successful check\./)).toBeTruthy();
});
it("B35 a 401 sends the person to sign in once, shows no evidence and does not repeat on refresh", async () => {
 const { f } = await mount(async () => ({ status: 401, body: { error: { code: "AUTH_REQUIRED" } } }), "web");
 expect((await screen.findByRole("alert")).textContent).toMatch(/Stored service status could not be verified\. Refresh to try another read\./);
 expect(f.host.signIn).toHaveBeenCalledTimes(1);expect(f.host.signIn).toHaveBeenCalledWith("/app/live", { automatic: true });
 expect(screen.queryByRole("table")).toBeNull();expect(screen.getByRole("status").textContent).toBe("No current service status is displayed.");
 fireEvent.click(screen.getByRole("button", { name: "Refresh stored status" }));await waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));await screen.findByRole("alert");
 expect(f.host.signIn).toHaveBeenCalledTimes(1);
});
it("B35 a 403 fails closed with the same fixed copy, no sign-in redirect and no leaked server text", async () => {
 const { f } = await mount(async () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "private-server-detail" } } }), "api");
 expect((await screen.findByRole("alert")).textContent).toMatch(/Stored service status could not be verified/);
 expect(f.host.signIn).not.toHaveBeenCalled();expect(screen.queryByRole("table")).toBeNull();expect(document.body.textContent).not.toContain("private-server-detail");
 expect(f.request.mock.calls.every(([input]) => input.method === "GET" && input.retry === "never")).toBe(true);
});
it("B35 a later failed refresh replaces earlier evidence with the failure notice", async () => {
 let status = 200;const { f } = await mount(async () => status === 200 ? { status, body: body([{ kind: "web", state: "ready", observation: "qualified", reason: "qualified", expiresAt }, ...unknown("not_observed").slice(1)]) } : { status, body: {} }, "web");
 await screen.findByRole("table");status = 403;fireEvent.click(screen.getByRole("button", { name: "Refresh stored status" }));
 await screen.findByRole("alert");expect(screen.queryByRole("table")).toBeNull();expect(f.host.signIn).not.toHaveBeenCalled();
});
