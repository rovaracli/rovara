// @vitest-environment jsdom
// Lane U5: Settings > New screens, where an owner or admin turns the new screens on for the whole company.
import { expect, it } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppMeResponseSchema, UI_FLAG_CATALOG, UiFlagsAdminAnswerSchema, UiFlagsAdminAnswerReaderSchema } from "@agentx/cloud-contracts/web";
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

/** The catalog's own `wired` for a name, as the broker sends it (decision 98: companies is not offered until its route exists). */
const wiredOf = (name: string) => UI_FLAG_CATALOG.find(entry => entry.name === name)!.wired;
const row = (name: string, label: string, over: Record<string, unknown> = {}) => ({ name, label, summary: `What ${label} turns on.`, wired: true, enabled: false, forcedOff: false, state: "off", ...over });
const answer = (over: Record<string, unknown> = {}) => ({ revision: 3, previews: false, changedAt: "2026-11-11T12:00:00.000Z", flags: [row("look", "New look", { enabled: true, state: "on" }), row("nav", "New navigation", { state: "preview" }), row("home", "New Home"), row("spending", "Spending page", { enabled: true, forcedOff: true }), row("insights", "Insights"), row("health", "Health page", { wired: false }), row("companies", "Companies", { wired: wiredOf("companies") }), row("continue", "Continue in your own tool", { state: "preview", wired: wiredOf("continue") })], ...over });
const PATH = "/v1/app/org/ui-flags";
function mount(options: { role?: "owner" | "admin" | "member"; read?: unknown; put?: (request: ApiRequest) => ApiResponse | Promise<ApiResponse> } = {}) {
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
 expect(items.map(item => item.getAttribute("aria-label"))).toEqual(["New look", "New navigation", "New Home", "Spending page", "Insights", "Continue in your own tool"]);
 expect(items[0]!.textContent).toContain("What New look turns on.");expect(items[0]!.textContent).toContain("On");expect(items[0]!.textContent).toContain("On for everyone in Acme.");
 expect(items[1]!.textContent).toContain("Preview");expect(items[1]!.textContent).toContain("Anyone can try it in their own browser");
 expect(items[2]!.textContent).toContain("Off.");
 expect(items[3]!.textContent).toContain("Turned off by the Rovara operator");
 expect(items[3]!.textContent).not.toContain("Held back");
 // Insights is a wired switch the owner can press, like the others: its own row, off, with its button.
 expect(items[4]!.textContent).toContain("What Insights turns on.");expect(items[4]!.textContent).toContain("Off.");
 expect(within(items[4]!).getByRole("button", { name: "Turn on Insights for everyone" })).toBeTruthy();
 // Decision 98: Continue in your own tool is a wired switch; Companies is not offered (the catalog marks it unwired until the broker answers /v1/app/companies).
 expect(items[5]!.textContent).toContain("Preview");expect(within(items[5]!).getByRole("button", { name: "Turn on Continue in your own tool for everyone" })).toBeTruthy();
 expect(within(list).queryByRole("listitem", { name: "Companies" })).toBeNull();expect(screen.queryByRole("button", { name: /Companies/u })).toBeNull();expect(screen.queryByText("What Companies turns on.")).toBeNull();
 expect(within(items[3]!).queryByRole("button")).toBeNull();
 expect(within(items[0]!).getByRole("button")).toBeTruthy();
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
 fireEvent.click(await screen.findByRole("button", { name: "Turn on New Home for everyone" }));
 await waitFor(() => { expect(puts(f)).toHaveLength(1); });
 expect(puts(f)[0]).toMatchObject({ method: "PUT", path: PATH, body: { expectedRevision: 3, flags: { home: true } }, retry: "never" });
 expect(Object.keys((puts(f)[0]!.body as { flags: object }).flags)).toEqual(["home"]);
 await screen.findByText(/Saved\. Takes effect when people next open or reload the app\./);
 expect(await screen.findByRole("button", { name: "Turn off New Home for everyone" })).toBeTruthy();
 await waitFor(() => { expect(f.query.getQueryState(["nav"])?.isInvalidated || f.request.mock.calls.filter(([r]) => r.path === "/v1/app/nav").length > 0).toBe(true); });
 // the next change carries the new revision
 fireEvent.click(screen.getByRole("button", { name: "Turn off New look for everyone" }));
 await waitFor(() => { expect(puts(f)).toHaveLength(2); });
 expect(puts(f)[1]!.body).toEqual({ expectedRevision: 4, flags: { look: false } });
 f.close();
});

for (const [name, label] of [["continue", "Continue in your own tool"]] as const) {
 it(`turning ${label} on sends only \`${name}\` with the revision read (decision 98)`, async () => {
  const f = mount();
  fireEvent.click(await screen.findByRole("button", { name: `Turn on ${label} for everyone` }));
  await waitFor(() => { expect(puts(f)).toHaveLength(1); });
  expect(puts(f)[0]).toMatchObject({ method: "PUT", path: PATH, body: { expectedRevision: 3, flags: { [name]: true } }, retry: "never" });
  expect(Object.keys((puts(f)[0]!.body as { flags: object }).flags)).toEqual([name]);
  f.close();
 });
}
it("an older broker's answer (no companies or continue rows) lists only the rows it sends, and nothing breaks", async () => {
 const older = answer({ flags: [row("look", "New look", { enabled: true, state: "on" }), row("insights", "Insights")] });
 const f = mount({ read: older });
 const list = await screen.findByRole("list", { name: "New screens" });
 expect(within(list).getAllByRole("listitem").map(item => item.getAttribute("aria-label"))).toEqual(["New look", "Insights"]);
 expect(screen.queryByText("Companies")).toBeNull();expect(screen.queryByText("Continue in your own tool")).toBeNull();
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
 fireEvent.click(await screen.findByRole("button", { name: "Turn on New Home for everyone" }));
 await screen.findByText("Someone else changed this; reload.");
 expect(screen.queryByText(/Saved\./)).toBeNull();
 f.request.mockImplementation(async request => ({ status: 200, body: request.path === PATH ? answer({ revision: 9, flags: [row("home", "New Home", { enabled: true, state: "on" })] }) : {} }));
 fireEvent.click(screen.getByRole("button", { name: "Reload" }));
 expect(await screen.findByRole("button", { name: "Turn off New Home for everyone" })).toBeTruthy();
 expect(screen.queryByText("Someone else changed this; reload.")).toBeNull();
 f.close();
});

it("REAUTH_REQUIRED shows the server's words and a Sign in again button", async () => {
 const f = mount({ put: () => ({ status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to change company screens." } } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Turn on New Home for everyone" }));
 await screen.findByText("Sign in again to change company screens.");
 fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
 expect(f.host.signIn).toHaveBeenCalled();
 // nothing was repeated on its own
 expect(puts(f)).toHaveLength(1);
 f.close();
});

it("any other refusal is shown verbatim, as text", async () => {
 const f = mount({ put: () => ({ status: 503, body: { error: { code: "AUDIT_UNAVAILABLE", message: "No audit ledger <b>here</b>; the change was refused." } } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Turn on New Home for everyone" }));
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

it("the fixtures are shapes the server's contract accepts (forcedOff included), and the reader tolerates a flag or state a newer server adds", () => {
 expect(UiFlagsAdminAnswerSchema.safeParse(answer()).success).toBe(true);
 expect(UiFlagsAdminAnswerReaderSchema.safeParse(answer({ flags: [row("look", "New look"), row("brand-new", "Brand new", { state: "sparkly" })] })).success).toBe(true);
});

const savedRegions = () => [...document.querySelectorAll("[role=status], [aria-live]")].filter(node => (node.textContent ?? "").includes("Saved."));

it("each switch's accessible name is its visible text (WCAG 2.5.3): no aria-label overrides it, and it names the screen", async () => {
 const f = mount();
 const list = await screen.findByRole("list", { name: "New screens" });
 const buttons = within(list).getAllByRole("button");
 expect(buttons.map(button => button.textContent)).toEqual(["Turn off New look for everyone", "Turn on New navigation for everyone", "Turn on New Home for everyone", "Turn on Insights for everyone", "Turn on Continue in your own tool for everyone"]);
 for (const button of buttons) {
  expect(button.hasAttribute("aria-label")).toBe(false);
  expect(screen.getByRole("button", { name: button.textContent })).toBe(button);
 }
 await expectNoAxeViolations(document.body);
 f.close();
});

it("the previews button keeps one name and says its state with aria-pressed only", async () => {
 const next = answer({ revision: 4, previews: true });
 const f = mount({ put: () => ({ status: 200, body: next }) });
 const before = await screen.findByRole("button", { name: "Allow previews" });
 expect(before.getAttribute("aria-pressed")).toBe("false");
 fireEvent.click(before);
 await waitFor(() => { expect(screen.getByRole("button", { name: "Allow previews" }).getAttribute("aria-pressed")).toBe("true"); });
 expect(screen.queryByRole("button", { name: "Stop allowing previews" })).toBeNull();
 expect(screen.getByRole("button", { name: "Allow previews" })).toBe(before);
 f.close();
});

it("Saved. is announced by one live region, not two", async () => {
 const f = mount();
 fireEvent.click(await screen.findByRole("button", { name: "Turn on New Home for everyone" }));
 await screen.findByText(/Saved\. Takes effect/);
 // The shared announcer waits a second before it speaks: give it the time, then count the regions that carry the text.
 await new Promise(resolve => setTimeout(resolve, 1300));
 expect(savedRegions()).toHaveLength(1);
 expect(screen.getByRole("status").textContent).toContain("Saved.");
 f.close();
});

it("while a change is saving the control keeps focus, says it is disabled, and a second click sends nothing", async () => {
 let release: (response: ApiResponse) => void = () => undefined;
 const f = mount({ put: () => new Promise<ApiResponse>(resolve => { release = resolve; }) });
 const button = await screen.findByRole("button", { name: "Turn on New Home for everyone" });
 button.focus();
 fireEvent.click(button);
 await waitFor(() => { expect(puts(f)).toHaveLength(1); });
 await waitFor(() => { expect(button.getAttribute("aria-disabled")).toBe("true"); });
 expect((button as HTMLButtonElement).disabled).toBe(false);
 expect(document.activeElement).toBe(button);
 const previews = screen.getByRole("button", { name: "Allow previews" });
 expect(previews.getAttribute("aria-disabled")).toBe("true");expect((previews as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(button);fireEvent.click(previews);fireEvent.click(screen.getByRole("button", { name: "Turn off New look for everyone" }));
 expect(puts(f)).toHaveLength(1);
 release({ status: 200, body: answer({ revision: 4, flags: [row("look", "New look", { enabled: true, state: "on" }), row("nav", "New navigation", { state: "preview" }), row("home", "New Home", { enabled: true, state: "on" })] }) });
 await screen.findByText(/Saved\. Takes effect/);
 const after = await screen.findByRole("button", { name: "Turn off New Home for everyone" });
 expect(after).toBe(button);expect(document.activeElement).toBe(button);
 expect(after.hasAttribute("aria-disabled")).toBe(false);
 f.close();
});

it("while a change is saving the page shows Saving…: the clicked control is aria-busy, the page is busy, and all of it clears when the answer comes", async () => {
 let release: (response: ApiResponse) => void = () => undefined;
 const f = mount({ put: () => new Promise<ApiResponse>(resolve => { release = resolve; }) });
 const button = await screen.findByRole("button", { name: "Turn on New Home for everyone" });
 const previews = screen.getByRole("button", { name: "Allow previews" });
 const page = button.closest("section")!;
 expect(page.getAttribute("aria-busy")).toBe("false");expect(button.hasAttribute("aria-busy")).toBe(false);expect(screen.getByRole("status").textContent).toBe("");
 fireEvent.click(button);
 await waitFor(() => { expect(screen.getByRole("status").textContent).toBe("Saving…"); });
 expect(button.getAttribute("aria-busy")).toBe("true");expect(previews.hasAttribute("aria-busy")).toBe(false);expect(page.getAttribute("aria-busy")).toBe("true");
 expect((button as HTMLButtonElement).disabled).toBe(false);
 release({ status: 200, body: answer({ revision: 4 }) });
 await screen.findByText(/Saved\. Takes effect/);
 expect(screen.getByRole("status").textContent).not.toContain("Saving");expect(button.hasAttribute("aria-busy")).toBe(false);expect(page.getAttribute("aria-busy")).toBe("false");
 // The previews switch shows the same state on its own button.
 fireEvent.click(previews);
 await waitFor(() => { expect(previews.getAttribute("aria-busy")).toBe("true"); });
 expect(button.hasAttribute("aria-busy")).toBe(false);
 release({ status: 200, body: answer({ revision: 5, previews: true }) });
 await waitFor(() => { expect(previews.hasAttribute("aria-busy")).toBe(false); });
 f.close();
});

it("a member is refused the page: the admin layout's refusal shows, the list is never read and no PUT is possible", async () => {
 const f = mount({ role: "member" });
 await screen.findByRole("heading", { name: "Administration unavailable" });
 expect(screen.queryByRole("heading", { name: "New screens", level: 1 })).toBeNull();
 expect(screen.queryByRole("list", { name: "New screens" })).toBeNull();
 expect(screen.queryByRole("button", { name: /Turn (on|off)|Allow previews/ })).toBeNull();
 await new Promise(resolve => setTimeout(resolve, 50));
 expect(f.request.mock.calls.filter(([request]) => request.path === PATH)).toEqual([]);
 expect(puts(f)).toEqual([]);
 f.close();
});
