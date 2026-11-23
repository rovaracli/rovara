// @vitest-environment jsdom
// G1 SHIP: the rebuilt company pages (Overview, Settings, Audit) and the project page's working-branches panel, through the REAL router (appRoutes + shell + AdminLayout).
// Every live action the old pages offered is proved here: allowed = exactly ONE send; refused or stale = the one send shows the server's own words, no second send; the admin
// area re-checking who this is, a read that is fetching or failed, or a member = ZERO sends. Mutants are listed in the lane's MUTANTS.md.
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createElement as h } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { companyAdminReadRoute, companyAdminReadRoutes } from "../../packages/ui/src/routes/company-admin-read-routes.js";
import { ReadEntry } from "../../packages/ui/src/screens/company-admin-read/ReadEntry.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { identity, members, pendingSettings, project, reply, settings } from "./read-only/company-admin-read/fixtures.js";
import { mount } from "./read-only/company-admin-read/mount.js";

const ME = identity.developer.id;
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const err = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
const SETTINGS = "/v1/app/org/settings";
const sent = (app: { request: { mock: { calls: readonly (readonly [ApiRequest])[] } } }) => app.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET");
const here = () => screen.getByRole("region", { name: "Company administration" });
const mine = { ...pendingSettings, pending: { ...pendingSettings.pending, proposedBy: ME } };
type Respond = (r: ApiRequest) => ApiResponse | Promise<ApiResponse>;
/** Reads as the fixtures answer them; `write` answers the one write the test expects. */
const serve = (write: Respond, body: unknown = pendingSettings): Respond => r => (r.method !== "GET" ? write(r) : r.path.split("?")[0] === SETTINGS ? ok(body) : reply(r));

// ---------- the mount ----------
it.each([["/app/admin", "Acme"], ["/app/admin/settings", "Company settings"], ["/app/admin/audit", "Audit"]])("renders %s inside the admin area (side menu + the page)", async (path, title) => {
 const app = await mount(path);
 await screen.findByRole("heading", { level: 1, name: title });
 expect(screen.getByRole("navigation", { name: "Administration" })).toBeTruthy();
 expect(here()).toBeTruthy();
 app.close();
});
it("the three pages are lazy routes: no static import of a screen in routes.tsx, no element, and the old screens are gone", () => {
 const routes = readFileSync("packages/ui/src/routes.tsx", "utf8"), module = readFileSync("packages/ui/src/routes/company-admin-read-routes.tsx", "utf8");
 expect(routes).not.toMatch(/company-admin-read\/|AdminOverview|settings\/SettingsScreen|audit\/AuditScreen/);
 expect(module.split("\n").filter(line => /^import /.test(line) && !/^import type /.test(line)).join("\n")).not.toMatch(/screens\//);
 for (const route of companyAdminReadRoutes()) { expect(route.lazy).toBeTypeOf("function"); expect(route.element).toBeUndefined(); expect(route.Component).toBeUndefined(); }
 expect(() => companyAdminReadRoute("nope" as never)).toThrow();
 for (const old of ["admin/AdminOverview.tsx", "admin/settings/SettingsScreen.tsx", "admin/audit/AuditScreen.tsx", "admin/audit/audit.css", "company-admin-read/upkeep-held.ts"]) expect(existsSync(`packages/ui/src/screens/${old}`), old).toBe(false);
 expect(readFileSync("scripts/ui-copy-assets.mjs", "utf8")).toContain("screens/company-admin-read/company-admin-read.css");
});
it("ReadEntry refuses a member even if something mounts it for one (second line behind AdminLayout)", async () => {
 const f = fakeHost(async () => ok({})), query = createQueryClient();
 const router = createMemoryRouter([{ path: "/", element: h(Outlet, { context: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", company: "Acme", developerId: ME, role: "member", checking: false } }), children: [{ index: true, element: h(ReadEntry, null, h("p", null, "PRIVATE-PAGE")) }] }]);
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 await screen.findByText(/available to current company owners and admins/);
 expect(screen.queryByText("PRIVATE-PAGE")).toBeNull();
 view.unmount(); router.dispose(); query.clear();
});
it("a member gets 'Administration unavailable' and no admin read", async () => {
 const app = await mount("/app/admin/settings", r => r.path === "/v1/app/me" ? ok({ ...identity, developer: { ...identity.developer, orgRole: "member" } }) : reply(r));
 await screen.findByRole("heading", { name: "Administration unavailable" });
 expect(app.request.mock.calls.map(([r]) => r.path).filter(p => p.startsWith("/v1/app/org") || p.startsWith("/v1/app/company"))).toEqual([]);
 app.close();
});

// ---------- Save rules ----------
async function openEditor(app: Awaited<ReturnType<typeof mount>>) {
 await screen.findByText("Review changes before merging");
 fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
 const field = await screen.findByLabelText("Rule 1");
 return { field, app };
}
it("Save rules sends exactly ONE PUT with the read's version and the whole document, then shows Saved", async () => {
 const app = await mount("/app/admin/settings", serve(() => ok({ settings: settings.settings, version: 4 }), settings));
 const { field } = await openEditor(app);
 fireEvent.change(field, { target: { value: "Review every change twice" } });
 fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
 await screen.findByText(/Saved\. The new rules apply/);
 const writes = sent(app);
 expect(writes).toHaveLength(1);
 expect(writes[0]).toMatchObject({ method: "PUT", path: SETTINGS, body: { expectedVersion: 3, settings: { start: { allow: true }, instructions: [{ text: "Review every change twice", priority: "required" }] } } });
 app.close();
});
it("a second press in the same instant does not send a second PUT (one send in flight)", async () => {
 let release!: (r: ApiResponse) => void;
 const app = await mount("/app/admin/settings", serve(() => new Promise<ApiResponse>(r => { release = r; }), settings));
 await openEditor(app);
 const save = screen.getByRole("button", { name: "Save rules" });
 await act(async () => { save.click(); save.click(); });
 expect(sent(app)).toHaveLength(1);
 await act(async () => { release(ok({ settings: settings.settings, version: 4 })); });
 await screen.findByText(/Saved\./);
 expect(sent(app)).toHaveLength(1);
 app.close();
});
it("a refused or stale Save shows the server's own words, sends once, and keeps the typed rules", async () => {
 for (const [status, code, words] of [[403, "FORBIDDEN", "Only an owner or admin may change the company rules."], [409, "CHANGE_STALE", "The settings changed while you were editing. Reload and try again."]] as const) {
  const app = await mount("/app/admin/settings", serve(() => err(status, code, words), settings));
  const { field } = await openEditor(app);
  fireEvent.change(field, { target: { value: "Typed rule" } });
  fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
  expect((await screen.findByTestId("settings-error")).querySelector("p")!.textContent).toBe(words);
  expect(sent(app)).toHaveLength(1);
  expect(screen.getByLabelText<HTMLTextAreaElement>("Rule 1").value).toBe("Typed rule");
  // The refusal offers a re-read (a GET), never a second write.
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await waitFor(() => expect(app.request.mock.calls.filter(([r]) => r.method === "GET" && r.path === SETTINGS).length).toBeGreaterThan(1));
  expect(sent(app)).toHaveLength(1);
  app.close();
 }
});
it("a Save that needs a second admin says 'Your change was sent for approval.', not Saved", async () => {
 const app = await mount("/app/admin/settings", serve(() => ok({ pending: { changeId: "change-9" } }), settings));
 const { field } = await openEditor(app);
 fireEvent.change(field, { target: { value: "Looser rule" } });
 fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
 await screen.findByText("Your change was sent for approval.");
 expect(screen.queryByText(/^Saved\./)).toBeNull();
 expect(sent(app)).toHaveLength(1);
 app.close();
});
it("Change rules is not offered when the rules were not read (a save would send an empty list), or while a change is pending", async () => {
 const unread = await mount("/app/admin/settings", serve(() => ok({}), { companyId: identity.org.orgId, version: 2, settings: {} }));
 await screen.findByText(/can't tell yet which company rules/i);
 expect(screen.queryByRole("button", { name: "Change rules" })).toBeNull();
 unread.close();
 const waiting = await mount("/app/admin/settings", serve(() => ok({})));
 await screen.findByText("Review every change");
 expect(screen.queryByRole("button", { name: "Change rules" })).toBeNull();
 waiting.close();
});

// ---------- Approve / Reject / Withdraw ----------
it("Approve sends exactly ONE POST to the change's approve path", async () => {
 const app = await mount("/app/admin/settings", serve(() => ok({})));
 fireEvent.click(await screen.findByRole("button", { name: "Approve this change" }));
 await screen.findByText(/Approved\. The new rules apply/);
 expect(sent(app).map(r => [r.method, r.path])).toEqual([["POST", `${SETTINGS}/pending/change-1/approve`]]);
 app.close();
});
it("a change I can approve says 'Needs you'; my own says 'Waiting for approval'", async () => {
 const other = await mount("/app/admin/settings", serve(() => ok({})));
 await screen.findByText("Needs you");
 expect(screen.queryByText("Waiting for approval")).toBeNull();
 expect(document.querySelector(".rv-car-pending-you")).not.toBeNull();
 other.close();
 const own = await mount("/app/admin/settings", serve(() => ok({}), mine));
 await screen.findByText("Waiting for approval");
 expect(screen.queryByText("Needs you")).toBeNull();
 expect(document.querySelector(".rv-car-pending-you")).toBeNull();
 own.close();
});
it("Reject (someone else's change) sends exactly ONE POST to the withdraw path", async () => {
 const app = await mount("/app/admin/settings", serve(() => ok({})));
 fireEvent.click(await screen.findByRole("button", { name: "Reject this change" }));
 await screen.findByText(/Withdrawn\. The current rules stay in force/);
 expect(sent(app).map(r => [r.method, r.path])).toEqual([["POST", `${SETTINGS}/pending/change-1/withdraw`]]);
 app.close();
});
it("my own change: Withdraw my change sends ONE POST and Approve is never offered", async () => {
 const app = await mount("/app/admin/settings", serve(() => ok({}), mine));
 await screen.findByText("You proposed this change.", { exact: false });
 expect(screen.queryByRole("button", { name: "Approve this change" })).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Withdraw my change" }));
 await screen.findByText(/Withdrawn\./);
 expect(sent(app).map(r => [r.method, r.path])).toEqual([["POST", `${SETTINGS}/pending/change-1/withdraw`]]);
 app.close();
});
it("a refused Approve (403) and a stale one (409) show the server's words after exactly one POST", async () => {
 for (const [status, code, words] of [[403, "FORBIDDEN", "You proposed this change; another admin must approve it."], [409, "CHANGE_STALE", "This change is no longer open."]] as const) {
  const app = await mount("/app/admin/settings", serve(() => err(status, code, words)));
  fireEvent.click(await screen.findByRole("button", { name: "Approve this change" }));
  expect((await screen.findByTestId("settings-error")).querySelector("p")!.textContent).toBe(words);
  expect(sent(app)).toHaveLength(1);
  app.close();
 }
});

// ---------- the admin area re-checking who this is ----------
it("while the admin area re-checks identity: the page stays (typed rules survive), nothing re-reads, and no action can send", async () => {
 let hold = false, release!: (r: ApiResponse) => void;
 const app = await mount("/app/admin/settings", serve(() => ok({ settings: settings.settings, version: 4 }), settings));
 const respond = app.request.getMockImplementation()!;
 const { field } = await openEditor(app);
 fireEvent.change(field, { target: { value: "Half typed" } });
 const reads = () => app.request.mock.calls.filter(([r]) => r.method === "GET" && r.path === SETTINGS).length, before = reads();
 app.request.mockImplementation(async r => (hold && r.path === "/v1/app/me" ? new Promise<ApiResponse>(done => { release = done; }) : respond(r)));
 hold = true;
 await act(async () => { void app.query.refetchQueries({ queryKey: ["admin", "identity"] }); });
 await waitFor(() => expect(here().closest(".rv-admin")?.getAttribute("aria-busy")).toBe("true"));
 expect(screen.getByLabelText<HTMLTextAreaElement>("Rule 1").value).toBe("Half typed");
 const save = screen.getByRole("button", { name: "Save rules" });
 expect(save.hasAttribute("disabled")).toBe(true);
 fireEvent.click(save);
 expect(sent(app)).toHaveLength(0);
 await act(async () => { release(ok(identity)); });
 await waitFor(() => expect(here().closest(".rv-admin")?.getAttribute("aria-busy")).toBe("false"));
 expect(screen.getByLabelText<HTMLTextAreaElement>("Rule 1").value).toBe("Half typed");
 expect(reads()).toBe(before);
 expect(sent(app)).toHaveLength(0);
 app.close();
});
it("while identity is re-checked, Approve and Reject are disabled and send nothing", async () => {
 let hold = false, release!: (r: ApiResponse) => void;
 const app = await mount("/app/admin/settings", serve(() => ok({})));
 const respond = app.request.getMockImplementation()!;
 await screen.findByRole("button", { name: "Approve this change" });
 app.request.mockImplementation(async r => (hold && r.path === "/v1/app/me" ? new Promise<ApiResponse>(done => { release = done; }) : respond(r)));
 hold = true;
 await act(async () => { void app.query.refetchQueries({ queryKey: ["admin", "identity"] }); });
 await waitFor(() => expect(screen.getByRole("button", { name: "Approve this change" }).hasAttribute("disabled")).toBe(true));
 expect(screen.getByRole("button", { name: "Reject this change" }).hasAttribute("disabled")).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Approve this change" }));
 fireEvent.click(screen.getByRole("button", { name: "Reject this change" }));
 expect(sent(app)).toHaveLength(0);
 await act(async () => { release(ok(identity)); });
 app.close();
});
it("the audit page is not re-read when the window refocuses (identity re-check keeps it mounted)", async () => {
 const app = await mount("/app/admin/audit");
 await screen.findByText("Updated company rules");
 const reads = () => app.request.mock.calls.filter(([r]) => r.path.startsWith("/v1/app/company/audit")).length, before = reads();
 await act(async () => { await app.query.refetchQueries({ queryKey: ["admin", "identity"] }); });
 await screen.findByText("Updated company rules");
 expect(reads()).toBe(before);
 app.close();
});
it("a save elsewhere that invalidates the admin read area re-reads these pages (same cache area as the live pages)", async () => {
 const app = await mount("/app/admin/settings");
 await screen.findByText("Review every change");
 const reads = () => app.request.mock.calls.filter(([r]) => r.method === "GET" && r.path === SETTINGS).length, before = reads();
 await act(async () => { await app.query.invalidateQueries({ queryKey: ["admin", "lane-c", "company-settings"] }); });
 await waitFor(() => expect(reads()).toBeGreaterThan(before));
 const again = reads();
 await act(async () => { await app.query.invalidateQueries({ queryKey: ["admin", "lane-c"] }); });
 await waitFor(() => expect(reads()).toBeGreaterThan(again));
 app.close();
});

// ---------- a read that is fetching or failed draws no action ----------
it("while the settings read is fetching the facts stay on screen; after a first read failed there is no action button", async () => {
 let mode: "ok" | "hold" = "ok";
 const app = await mount("/app/admin/settings", serve(() => ok({})));
 const respond = app.request.getMockImplementation()!;
 await screen.findByRole("button", { name: "Approve this change" });
 app.request.mockImplementation(async r => (r.path === SETTINGS && r.method === "GET" && mode === "hold" ? new Promise<ApiResponse>(() => undefined) : respond(r)));
 mode = "hold";
 fireEvent.click(screen.getByRole("button", { name: "Read company settings again" }));
 await waitFor(() => expect(screen.getByRole("button", { name: "Read company settings again" }).hasAttribute("disabled")).toBe(true));
 // The last good facts stay (a press re-checks at send time: review-fixes.test.ts); nothing is blanked.
 expect(screen.queryByText(/Checking current details/)).toBeNull();
 expect(screen.getByText("Review every change")).toBeTruthy();
 app.close();
 const failed = await mount("/app/admin/settings", r => (r.path === SETTINGS ? err(503, "DOWN", "down") : reply(r)));
 await screen.findByText("Rovara couldn't read this page");
 expect(screen.queryByRole("button", { name: /Approve this change|Reject this change|Change rules|Save rules/ })).toBeNull();
 expect(sent(failed)).toHaveLength(0);
 failed.close();
});

// ---------- the other live actions kept on the page ----------
it("nightly upkeep Withdraw: one confirm, then exactly ONE PUT with the id and allowed:false", async () => {
 const app = await mount("/app/admin/settings", r => r.path === "/v1/app/company/system-runs" ? ok({ available: true, allowed: r.method === "GET", systemRunsOn: r.method === "GET" }) : serve(() => ok({}), settings)(r));
 fireEvent.click(await screen.findByTestId("company-upkeep-withdraw"));
 expect(sent(app)).toHaveLength(0);
 fireEvent.click(await screen.findByTestId("company-upkeep-yes"));
 await screen.findByTestId("company-upkeep-allow-where");
 const writes = sent(app);
 expect(writes).toHaveLength(1);
 expect(writes[0]).toMatchObject({ method: "PUT", path: "/v1/app/company/system-runs", body: { allowed: false } });
 app.close();
});
it("Knowledge stays: one press = exactly ONE PUT of the switch", async () => {
 let stays = false;
 const app = await mount("/app/admin/settings", r => r.path === "/v1/app/company/lessons/local-tools" ? (r.method === "PUT" ? (stays = (r.body as { stays: boolean }).stays, ok({ stays })) : ok({ stays })) : serve(() => ok({}), settings)(r));
 const card = within(await screen.findByTestId("knowledge-stays"));
 fireEvent.click(card.getByRole("switch"));
 await waitFor(() => expect(sent(app)).toHaveLength(1));
 expect(sent(app)[0]).toMatchObject({ method: "PUT", path: "/v1/app/company/lessons/local-tools", body: { stays: true } });
 app.close();
});
it("Overview: the Money row reads the spending read and links to it; People shows the count", async () => {
 const app = await mount("/app/admin", r => r.path === "/v1/app/org/spend" ? ok({ spentThisMonthUsd: 10, remainingUsd: 90, limitUsd: 100, month: "2026-11" }) : reply(r));
 const row = await screen.findByTestId("overview-spend");
 expect(row.textContent).toContain("spent this month");
 expect((await screen.findByTestId("overview-people")).textContent).toBe("3 people");
 expect(members.members).toHaveLength(3);
 app.close();
});
it("Overview: a refused member read hides the people count but not the company pages list or the Money row (the live page's money line has its own read)", async () => {
 const app = await mount("/app/admin", r => r.path === "/v1/app/org/members" ? err(403, "FORBIDDEN", "no") : r.path === "/v1/app/org/spend" ? ok({ spentThisMonthUsd: 10, remainingUsd: 90, limitUsd: 100, month: "2026-11" }) : reply(r));
 await screen.findByText("Rovara couldn't read this page");
 expect((await screen.findByTestId("overview-spend")).textContent).toContain("spent this month");
 expect(screen.queryByTestId("overview-people")).toBeNull();
 expect(screen.getByRole("link", { name: "Open People" }).getAttribute("href")).toBe("/app/admin/people");
 app.close();
});
it("the project page keeps the live working-branches controls INSIDE the panel for a maintainer, and unusable for a viewer (the full action set is proved by admin-working-branches.test.ts)", async () => {
 const maintainer = await mount("/app/admin/projects/payments");
 const panel = (await screen.findByRole("heading", { level: 2, name: "Working branches" })).closest("section")!;
 expect(within(panel).getByRole("button", { name: "Inspect working branches" })).toBeTruthy();
 expect(sent(maintainer)).toHaveLength(0);
 maintainer.close();
 const viewer = await mount("/app/admin/projects/payments", r => r.path === "/v1/app/projects/payments" ? ok({ ...project, myRole: "viewer" }) : reply(r));
 await screen.findByRole("heading", { level: 2, name: "Working branches" });
 const inspect = screen.queryByRole("button", { name: "Inspect working branches" });
 expect(inspect === null || inspect.getAttribute("aria-disabled") === "true" || inspect.hasAttribute("disabled")).toBe(true);
 if (inspect !== null) { fireEvent.click(inspect); expect(screen.queryByRole("combobox", { name: "Repository to inspect" })).toBeNull(); }
 viewer.close();
});
