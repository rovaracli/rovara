// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../../../packages/ui/src/host.js";
import { ThemeProvider } from "../../../../packages/ui/src/theme.js";
import { createQueryClient } from "../../../../packages/ui/src/api/query.js";
import { appRoutes } from "../../../../packages/ui/src/routes.js";
import { fakeHost } from "../../support/fake-host.js";
import { createMemoryRouter, RouterProvider, MemoryRouter } from "react-router";
import { PageHeader } from "../../../../packages/ui/src/design/PageHeader.js";
import { DesignSystemGallery } from "../../../../packages/ui/src/design/DesignSystemGallery.js";
import { renderUi } from "../../support/render.js";
import { expectNoAxeViolations } from "../../support/axe.js";
import { h } from "../../support/h.js";
afterEach(cleanup);
const ids = ["colours", "type", "space", "statuses", "buttons", "decisions", "timeline", "table", "toast", "confirmation", "outcome", "focus", "shell-running", "shell-plan", "shell-gaps", "delivery", "held", "states-loading", "states-empty", "states-slow", "states-error", "states-stale", "states-phone", "states-first-load-failed", "states-stale-or-heartbeat", "states-write-unconfirmed"];
function gallery(id: string, theme: "light" | "dark" = "light") {
 return renderUi(h(MemoryRouter, { initialEntries: [`/app/design-system?scene=${id}`], children: h(DesignSystemGallery) }), { theme });
}
it("retains the old header and renders optional breadcrumbs, status, meta and its supplied action", () => {
 renderUi(h(PageHeader, { title: "Refunds\u202e", description: "Existing description", breadcrumbs: [{ label: "Work", href: "/app/live" }, { label: "acme/payments" }], status: { state: "running" }, meta: "You own this task", actions: h("button", {}, "Task actions") }));
 expect(screen.getByRole("heading", { level: 1, name: "Refunds[U+202E]" })).toBeTruthy();
 expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Work" }).getAttribute("href")).toBe("/app/live");
 expect(screen.getByText("Running")).toBeTruthy();expect(screen.getByText("You own this task")).toBeTruthy();expect(screen.getByText("Existing description")).toBeTruthy();
 expect(screen.getAllByRole("button")).toHaveLength(1);
});
it("isolates each of the 26 scene URLs and keeps every scene discoverable", () => {
 for (const id of ids) {
  const f = gallery(id);
  expect(f.container.querySelectorAll('[data-gallery-scene]')).toHaveLength(1);
  expect(f.container.querySelector('[data-gallery-scene]')?.getAttribute("data-gallery-scene")).toBe(id);
  const links = within(screen.getByRole("navigation", { name: "Gallery scenes" })).getAllByRole("link");
  expect(links.map(link => link.getAttribute("href"))).toEqual(ids.map(scene => `?scene=${scene}`));
  f.unmount();
 }
});
it("rejects an unknown scene visibly instead of capturing a successful fallback", () => {
 gallery("missing");expect(screen.getByRole("heading", { name: "Scene not found" })).toBeTruthy();
 expect(document.querySelector('[data-gallery-scene]')).toBeNull();
});
for (const theme of ["light", "dark"] as const) it(`${theme}: shows both focus panels, full intro, chips and readable composer`, async () => {
 gallery("focus", theme);
 expect(screen.getByRole("heading", { name: "New in v2: selection, focus and outlines" })).toBeTruthy();
 expect(screen.getByText(/Where an outline or a fill is the only way/)).toBeTruthy();
 for (const mode of ["light", "dark"]) {
  const panel = document.querySelector<HTMLElement>(`[data-focus-theme=${mode}]`);expect(panel).toBeTruthy();
  expect(panel?.textContent).toContain("Needs you");expect(panel?.textContent).toContain("Not run");
 }
 await expectNoAxeViolations(document.body);
});
it("uses token spacing to prevent double gutters, split numbers, mono breaks and touching focus rings", () => {
 const css = readFileSync("packages/ui/src/design/parts/shell-gallery.css", "utf8");
 expect(css).toContain("--rv-gallery-gutter:var(--rv-space-7)");
 expect(css).toContain("--rv-gallery-gutter:var(--rv-space-4)");
 expect(css).toContain("flex:0 0 var(--rv-space-5)");
 expect(css).toContain("white-space:nowrap;overflow-x:auto");
 expect(css).toContain("gap:calc(var(--rv-space-3) + var(--rv-space-2))");
});
it("keeps first-load failure separate from empty and a silent build separate from an old list (R1/R4)", () => {
 const failed = gallery("states-first-load-failed");expect(screen.getByText(/couldn't load this project's tasks/)).toBeTruthy();expect(screen.queryByText("No tasks yet")).toBeNull();failed.unmount();
 gallery("states-stale-or-heartbeat");expect(screen.getByText(/Was Running at 14:20/)).toBeTruthy();expect(screen.getByText(/build itself has been silent/)).toBeTruthy();expect(screen.getAllByText("Unknown")).toHaveLength(1);expect(screen.queryByRole("button", { name: "Stop work" })).toBeNull();
});
it("an unconfirmed write offers only a local check and reports the observed value (R2/R4)", async () => {
 gallery("states-write-unconfirmed");expect(screen.queryByRole("button", { name: /save|try again/i })).toBeNull();
 await userEvent.click(screen.getByRole("button", { name: "Check current limit" }));
 expect(screen.getByText(/Checked 14:07: the limit is \$600/)).toBeTruthy();expect(screen.queryByText(/your change was saved/i)).toBeNull();
});
it("the shell demo uses the existing menu, preserves focus return and expands the live log", async () => {
 gallery("shell-running");const user = userEvent.setup(), trigger = screen.getByRole("button", { name: "Task actions" });
 await user.click(trigger);expect(await screen.findByRole("menu")).toBeTruthy();await user.keyboard("{Escape}");expect(document.activeElement).toBe(trigger);
 await user.click(screen.getByText("Live log"));expect(screen.getByText("edit src/refunds/handlers.py (+48 -0)")).toBeTruthy();
});

it("mounts the selected scene in the real authenticated app shell with landmarks and workspace access", async () => {
 const nav = AppNavReaderSchema.parse({ me: { developerId: "a".repeat(64), name: "Ana", orgRole: "member" }, org: { name: "Acme" }, homeCount: 3, projects: [], shared: { agents: [], sessions: [] }, features: { localAgents: true, usage: false, admin: false, chains: false, notices: false, describe: false } });
 const f = fakeHost(async () => ({ status: 200, body: nav })), query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/design-system?scene=shell-plan"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 try {
  expect(await screen.findByRole("heading", { name: "Approve plan v3?" })).toBeTruthy();
  expect(screen.getByRole("main").id).toBe("main");expect(screen.getByRole("link", { name: "Skip to main content" }).getAttribute("href")).toBe("#main");
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open workspace menu" }));
  expect(within(await screen.findByRole("dialog", { name: "Workspace" })).getByRole("link", { name: "Work" })).toBeTruthy();
  expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
 } finally { ui.unmount();router.dispose();query.clear(); }
});
for (const theme of ["light", "dark"] as const) it(`${theme}: shell and nine state examples have no automated accessibility violations`, async () => {
 for (const id of ["shell-running", "shell-plan", "shell-gaps", ...ids.filter(id => id.startsWith("states-"))]) {
  const ui = gallery(id, theme);await expectNoAxeViolations(ui.container);ui.unmount();
 }
});
