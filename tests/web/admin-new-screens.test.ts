// @vitest-environment jsdom
// Lane U5: Settings > New screens, where an owner or admin turns the new screens on for the whole company.
import { expect, it } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { ADMIN_SECTIONS, visibleSections } from "../../packages/ui/src/screens/admin/admin-sections.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";

const row = (name: string, label: string, over: Record<string, unknown> = {}) => ({ name, label, summary: `What ${label} turns on.`, wired: true, enabled: false, forcedOff: false, state: "off", ...over });
const answer = (over: Record<string, unknown> = {}) => ({ revision: 3, previews: false, changedAt: "2026-11-11T12:00:00.000Z", flags: [row("look", "New look", { enabled: true, state: "on" }), row("nav", "New navigation", { state: "preview" }), row("home", "New Home"), row("spending", "Spending page", { enabled: true, forcedOff: true }), row("health", "Health page", { wired: false })], ...over });
const PATH = "/v1/app/org/ui-flags";
function mount(options: { role?: "owner" | "admin"; read?: unknown; put?: (request: ApiRequest) => ApiResponse | Promise<ApiResponse> } = {}) {
 const role = options.role ?? "owner";
 const nav = navFixture({ me: { developerId: "a".repeat(64), name: "Omar", orgRole: role }, features: { localAgents: false, admin: true, usage: false, chains: false, notices: false, describe: false } });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Omar", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async request => {
  if (request.path === PATH && request.method === "PUT") return options.put?.(request) ?? { status: 200, body: answer({ revision: 4 }) };
  return { status: 200, body: request.path === "/v1/app/nav" ? nav : request.path === "/v1/app/me" ? me : request.path === PATH ? (options.read ?? answer()) : {} };
 });
 f.host.kind = "web";f.host.viewport = { width: () => 1280, subscribe: () => () => undefined };
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/new-screens"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(Announcer, null, h(RouterProvider, { router })) }) }) }));
 return { ...f, ...view, query, close: () => { view.unmount();router.dispose();query.clear(); } };
}
const puts = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "PUT");

it("is in the settings list under How work runs, once, and open to owners and admins", () => {
 const item = ADMIN_SECTIONS.flatMap(section => section.items).filter(entry => entry.to === "/app/admin/new-screens");
 expect(item).toHaveLength(1);expect(item[0]!.label).toBe("New screens");
 for (const role of ["owner", "admin"] as const) expect(visibleSections(role, false).flatMap(section => section.items.map(entry => entry.label))).toContain("New screens");
});

it("lists the wired switches with what each turns on, the company value and when it last changed; an unwired one is not shown", async () => {
 const f = mount();
 await screen.findByRole("heading", { name: "New screens", level: 1 });
 const list = await screen.findByRole("list", { name: "New screens" });
 const items = within(list).getAllByRole("listitem");
 expect(items.map(item => item.getAttribute("aria-label"))).toEqual(["New look", "New navigation", "New Home", "Spending page"]);
 expect(items[0]!.textContent).toContain("What New look turns on.");expect(items[0]!.textContent).toContain("On");expect(items[0]!.textContent).toContain("On for everyone in Acme.");
 expect(items[1]!.textContent).toContain("Preview");expect(items[1]!.textContent).toContain("Anyone can try it in their own browser");
 expect(items[2]!.textContent).toContain("Off.");
 expect(items[3]!.textContent).toContain("Held back by your install's operator");
 expect(within(items[3]!).getByRole("button")).toHaveProperty("disabled", true);
 expect(screen.queryByText("Health page")).toBeNull();
 expect(screen.getByText(/Last changed Nov 11, 2026, 12:00 PM UTC/)).toBeTruthy();
 expect(screen.getByText(/Preview lets each person try a screen in their own browser first/)).toBeTruthy();
 expect(puts(f)).toEqual([]);
 await expectNoAxeViolations(document.body);
 f.close();
});

it("turning one on sends only that flag with the revision read, then shows the saved value and refreshes the navigation", async () => {
 const next = answer({ revision: 4, flags: [row("look", "New look", { enabled: true, state: "on" }), row("nav", "New navigation", { state: "preview" }), row("home", "New Home", { enabled: true, state: "on" })] });
 const f = mount({ put: () => ({ status: 200, body: next }) });
 fireEvent.click(await screen.findByRole("button", { name: "Turn on New Home for the company" }));
 await waitFor(() => { expect(puts(f)).toHaveLength(1); });
 expect(puts(f)[0]).toMatchObject({ method: "PUT", path: PATH, body: { expectedRevision: 3, flags: { home: true } }, retry: "never" });
 expect(Object.keys((puts(f)[0]!.body as { flags: object }).flags)).toEqual(["home"]);
 await screen.findByText(/Saved\. Takes effect when people next open or reload the app\./);
 expect(await screen.findByRole("button", { name: "Turn off New Home for the company" })).toBeTruthy();
 await waitFor(() => { expect(f.query.getQueryState(["nav"])?.isInvalidated || f.request.mock.calls.filter(([r]) => r.path === "/v1/app/nav").length > 0).toBe(true); });
 // the next change carries the new revision
 fireEvent.click(screen.getByRole("button", { name: "Turn off New look for the company" }));
 await waitFor(() => { expect(puts(f)).toHaveLength(2); });
 expect(puts(f)[1]!.body).toEqual({ expectedRevision: 4, flags: { look: false } });
 f.close();
});

it("the previews switch sends previews with the revision", async () => {
 const f = mount();
 expect(await screen.findByText(/Previews are not allowed/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Allow previews" }));
 await waitFor(() => { expect(puts(f)).toHaveLength(1); });
 expect(puts(f)[0]!.body).toEqual({ expectedRevision: 3, previews: true });
 f.close();
});

it("a revision conflict says someone else changed this, and Reload reads the fresh state", async () => {
 const f = mount({ put: () => ({ status: 409, body: { error: { code: "CHANGE_STALE", message: "Someone else changed this. Reload and try again." } } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Turn on New Home for the company" }));
 await screen.findByText("Someone else changed this; reload.");
 expect(screen.queryByText(/Saved\./)).toBeNull();
 f.request.mockImplementation(async request => ({ status: 200, body: request.path === PATH ? answer({ revision: 9, flags: [row("home", "New Home", { enabled: true, state: "on" })] }) : {} }));
 fireEvent.click(screen.getByRole("button", { name: "Reload" }));
 expect(await screen.findByRole("button", { name: "Turn off New Home for the company" })).toBeTruthy();
 expect(screen.queryByText("Someone else changed this; reload.")).toBeNull();
 f.close();
});

it("REAUTH_REQUIRED shows the server's words and a Sign in again button", async () => {
 const f = mount({ put: () => ({ status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to change company screens." } } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Turn on New Home for the company" }));
 await screen.findByText("Sign in again to change company screens.");
 fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
 expect(f.host.signIn).toHaveBeenCalled();
 // nothing was repeated on its own
 expect(puts(f)).toHaveLength(1);
 f.close();
});

it("any other refusal is shown verbatim, as text", async () => {
 const f = mount({ put: () => ({ status: 503, body: { error: { code: "AUDIT_UNAVAILABLE", message: "No audit ledger <b>here</b>; the change was refused." } } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Turn on New Home for the company" }));
 const alert = await screen.findByRole("alert");
 expect(alert.textContent).toContain("No audit ledger <b>here</b>; the change was refused.");
 expect(alert.querySelector("b")).toBeNull();
 expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
 f.close();
});

it("an unreadable list says so and offers to try again", async () => {
 const f = mount({ read: { nope: true } });
 await screen.findByText("Couldn't load the new screens settings.");
 expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
 f.close();
});
