// @vitest-environment jsdom
// Lane U5, decision 116: Settings > Old screens, a troubleshooting page where an owner sends a new screen (on by default) back to the old one for the whole company, and turns it on again.
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

it("is in the settings list under How work runs, once, as a troubleshooting page offered to owners only (decision 116: turning screens on is not a customer task)", () => {
 const item = ADMIN_SECTIONS.flatMap(section => section.items).filter(entry => entry.to === "/app/admin/new-screens");
 expect(item).toHaveLength(1);expect(item[0]).toMatchObject({ label: "Old screens", ownerOnly: true });
 expect(item[0]!.blurb).toMatch(/^Troubleshooting: every new screen is on\./u);
 expect(visibleSections("owner", false).flatMap(section => section.items.map(entry => entry.label))).toContain("Old screens");
 for (const role of ["admin", "member"] as const) expect(visibleSections(role, false).flatMap(section => section.items.map(entry => entry.to))).not.toContain("/app/admin/new-screens");
 expect(ADMIN_SECTIONS.flatMap(section => section.items).map(entry => entry.label)).not.toContain("New screens");
});

it("a company on the defaults sees every finished screen as the new one, each with one button to send it back to the old screen", async () => {
 const defaults = answer({ revision: 0, changedAt: undefined, flags: UI_FLAG_CATALOG.map(entry => row(entry.name, entry.label, { wired: entry.wired, enabled: entry.defaultOn, state: entry.defaultOn ? "on" : "off" })) });
 const f = mount({ read: defaults });
 await screen.findByRole("heading", { name: "Old screens", level: 1 });
 const items = within(await screen.findByRole("list", { name: "New screens" })).getAllByRole("listitem");
 expect(items.map(item => item.getAttribute("aria-label"))).toEqual(UI_FLAG_CATALOG.filter(entry => entry.wired).map(entry => entry.label));
 for (const item of items) {
  expect(item.textContent).toContain("New screen");expect(item.textContent).toContain("Everyone in Acme has the new screen.");
  expect(within(item).getByRole("button").textContent).toBe(`Use the old screen instead of ${item.getAttribute("aria-label")!} for everyone`);
 }
 expect(screen.getByText(/^Troubleshooting\. Every new screen is on for everyone\./u)).toBeTruthy();
 expect(puts(f)).toEqual([]);
 await expectNoAxeViolations(document.body);
 f.close();
});

it("lists the wired switches with what each turns on, the company value and when it last changed; an unwired one is not shown", async () => {
 const f = mount();
 await screen.findByRole("heading", { name: "Old screens", level: 1 });
 const list = await screen.findByRole("list", { name: "New screens" });
 const items = within(list).getAllByRole("listitem");
 expect(items.map(item => item.getAttribute("aria-label"))).toEqual(["New look", "New navigation", "New Home", "Spending page", "Insights", "Continue in your own tool"]);
 expect(items[0]!.textContent).toContain("What New look turns on.");expect(items[0]!.textContent).toContain("New screen");expect(items[0]!.textContent).toContain("Everyone in Acme has the new screen.");
 expect(items[1]!.textContent).toContain("Old screen");expect(items[1]!.textContent).toContain("Anyone can try the new one in their own browser");
 expect(items[2]!.textContent).toContain("Everyone in Acme has the old screen.");
 expect(items[3]!.textContent).toContain("Turned off by the Rovara operator");
 expect(items[3]!.textContent).not.toContain("Held back");
 // Insights is a wired switch the owner can press, like the others: its own row, off, with its button.
 expect(items[4]!.textContent).toContain("What Insights turns on.");expect(items[4]!.textContent).toContain("Everyone in Acme has the old screen.");
 expect(within(items[4]!).getByRole("button", { name: "Turn Insights back on for everyone" })).toBeTruthy();
 // Decision 98: Continue in your own tool is a wired switch; Companies is not offered (the catalog marks it unwired until the broker answers /v1/app/companies).
 expect(items[5]!.textContent).toContain("Old screen");expect(within(items[5]!).getByRole("button", { name: "Turn Continue in your own tool back on for everyone" })).toBeTruthy();
 expect(within(list).queryByRole("listitem", { name: "Companies" })).toBeNull();expect(screen.queryByRole("button", { name: /Companies/u })).toBeNull();expect(screen.queryByText("What Companies turns on.")).toBeNull();
 expect(within(items[3]!).queryByRole("button")).toBeNull();
 expect(within(items[0]!).getByRole("button")).toBeTruthy();
 expect(screen.queryByText("Health page")).toBeNull();
 expect(screen.getByText(/Last changed Nov 11, 2026, 12:00 PM UTC/)).toBeTruthy();
 expect(screen.getByText(/Preview lets each person try a new screen in their own browser/)).toBeTruthy();
 expect(puts(f)).toEqual([]);
 await expectNoAxeViolations(document.body);
 f.close();
});

it("turning one on sends only that flag with the revision read, then shows the saved value and refreshes the navigation", async () => {
 const next = answer({ revision: 4, flags: [row("look", "New look", { enabled: true, state: "on" }), row("nav", "New navigation", { state: "preview" }), row("home", "New Home", { enabled: true, state: "on" })] });
 const f = mount({ put: () => ({ status: 200, body: next }) });
 fireEvent.click(await screen.findByRole("button", { name: "Turn New Home back on for everyone" }));
 await waitFor(() => { expect(puts(f)).toHaveLength(1); });
 expect(puts(f)[0]).toMatchObject({ method: "PUT", path: PATH, body: { expectedRevision: 3, flags: { home: true } }, retry: "never" });
 expect(Object.keys((puts(f)[0]!.body as { flags: object }).flags)).toEqual(["home"]);
 await screen.findByText(/Saved\. Takes effect when people next open or reload the app\./);
 expect(await screen.findByRole("button", { name: "Use the old screen instead of New Home for everyone" })).toBeTruthy();
 await waitFor(() => { expect(f.query.getQueryState(["nav"])?.isInvalidated || f.request.mock.calls.filter(([r]) => r.path === "/v1/app/nav").length > 0).toBe(true); });
 // the next change carries the new revision
 fireEvent.click(screen.getByRole("button", { name: "Use the old screen instead of New look for everyone" }));
 await waitFor(() => { expect(puts(f)).toHaveLength(2); });
 expect(puts(f)[1]!.body).toEqual({ expectedRevision: 4, flags: { look: false } });
 f.close();
});

for (const [name, label] of [["continue", "Continue in your own tool"]] as const) {
 it(`turning ${label} on sends only \`${name}\` with the revision read (decision 98)`, async () => {
  const f = mount();
  fireEvent.click(await screen.findByRole("button", { name: `Turn ${label} back on for everyone` }));
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
 fireEvent.click(await screen.findByRole("button", { name: "Turn New Home back on for everyone" }));
 await screen.findByText("Someone else changed this; reload.");
 expect(screen.queryByText(/Saved\./)).toBeNull();
 f.request.mockImplementation(async request => ({ status: 200, body: request.path === PATH ? answer({ revision: 9, flags: [row("home", "New Home", { enabled: true, state: "on" })] }) : {} }));
 fireEvent.click(screen.getByRole("button", { name: "Reload" }));
 expect(await screen.findByRole("button", { name: "Use the old screen instead of New Home for everyone" })).toBeTruthy();
 expect(screen.queryByText("Someone else changed this; reload.")).toBeNull();
 f.close();
});

it("REAUTH_REQUIRED shows the server's words and a Sign in again button", async () => {
 const f = mount({ put: () => ({ status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to change company screens." } } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Turn New Home back on for everyone" }));
 await screen.findByText("Sign in again to change company screens.");
 fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
 expect(f.host.signIn).toHaveBeenCalled();
 // nothing was repeated on its own
 expect(puts(f)).toHaveLength(1);
 f.close();
});

it("any other refusal is shown verbatim, as text", async () => {
 const f = mount({ put: () => ({ status: 503, body: { error: { code: "AUDIT_UNAVAILABLE", message: "No audit ledger <b>here</b>; the change was refused." } } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Turn New Home back on for everyone" }));
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
 expect(buttons.map(button => button.textContent)).toEqual(["Use the old screen instead of New look for everyone", "Turn New navigation back on for everyone", "Turn New Home back on for everyone", "Turn Insights back on for everyone", "Turn Continue in your own tool back on for everyone"]);
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
 fireEvent.click(await screen.findByRole("button", { name: "Turn New Home back on for everyone" }));
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
 const button = await screen.findByRole("button", { name: "Turn New Home back on for everyone" });
 button.focus();
 fireEvent.click(button);
 await waitFor(() => { expect(puts(f)).toHaveLength(1); });
 await waitFor(() => { expect(button.getAttribute("aria-disabled")).toBe("true"); });
 expect((button as HTMLButtonElement).disabled).toBe(false);
 expect(document.activeElement).toBe(button);
 const previews = screen.getByRole("button", { name: "Allow previews" });
 expect(previews.getAttribute("aria-disabled")).toBe("true");expect((previews as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(button);fireEvent.click(previews);fireEvent.click(screen.getByRole("button", { name: "Use the old screen instead of New look for everyone" }));
 expect(puts(f)).toHaveLength(1);
 release({ status: 200, body: answer({ revision: 4, flags: [row("look", "New look", { enabled: true, state: "on" }), row("nav", "New navigation", { state: "preview" }), row("home", "New Home", { enabled: true, state: "on" })] }) });
 await screen.findByText(/Saved\. Takes effect/);
 const after = await screen.findByRole("button", { name: "Use the old screen instead of New Home for everyone" });
 expect(after).toBe(button);expect(document.activeElement).toBe(button);
 expect(after.hasAttribute("aria-disabled")).toBe(false);
 f.close();
});

it("while a change is saving the page shows Saving…: the clicked control is aria-busy, the page is busy, and all of it clears when the answer comes", async () => {
 let release: (response: ApiResponse) => void = () => undefined;
 const f = mount({ put: () => new Promise<ApiResponse>(resolve => { release = resolve; }) });
 const button = await screen.findByRole("button", { name: "Turn New Home back on for everyone" });
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
 expect(screen.queryByRole("heading", { name: "Old screens", level: 1 })).toBeNull();
 expect(screen.queryByRole("list", { name: "New screens" })).toBeNull();
 expect(screen.queryByRole("button", { name: /back on for everyone|Use the old screen|Allow previews/ })).toBeNull();
 await new Promise(resolve => setTimeout(resolve, 50));
 expect(f.request.mock.calls.filter(([request]) => request.path === PATH)).toEqual([]);
 expect(puts(f)).toEqual([]);
 f.close();
});
