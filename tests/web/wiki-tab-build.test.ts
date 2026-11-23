// @vitest-environment jsdom
// SETUP-WIKI-CLOUD-FIXES (c): the empty Wiki tab is not a dead end. For a person who may build, the tab shows "Build the wiki": the SAME row the checklist draws (its forecast, its Build button, its calls), disabled with
// the reason Code and Cloud serve while it cannot start (no AI key, no file to write about, a build read that failed). A person who may not build reads one line. Rule #14: a failed re-read takes Build away.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { WikiSkillsReadEntry } from "../../packages/ui/src/screens/wiki-skills-read/ReadEntry.js";
import { T } from "../../packages/ui/src/screens/setup/wiki/wiki-setup-text.js";
import { wikiSetupKey } from "../../packages/ui/src/api/wiki-setup.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { wikiIndex } from "./support/wiki-fixture.js";

afterEach(cleanup);
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
const ROOT = "/v1/app/projects/web";
const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const map = (pages = 24) => ({
  computedAt: "2026-11-17T09:00:00.000Z", complete: true, repositoriesOmitted: 0,
  repositories: [{ name: "web", status: "ok", files: 1204, skipped: { generated: 4, vendored: 9, lockfiles: 1, assets: 30, secret: 2 }, skippedFolders: [], pages: { modules: 14, modulesCapped: false } }],
  chips: [{ id: "write-first-web-billing", kind: "write_first", repo: "web", path: "src/billing", label: "Write these first? web/src/billing", defaultOn: false }],
  forecast: { repositories: 1, files: 1204, pages, pagesCapped: false, complete: true },
});
const build = (extra: Record<string, unknown> = {}) => ({ status: "none", limits: { pages: 300 }, canManage: true, aiKey: "connected", agents: { on: false }, wiki: { pages: 0, refreshPages: 0 }, ...extra });

interface Options { upkeep?: () => ApiResponse; build?: () => ApiResponse; map?: () => ApiResponse; role?: "owner" | "member"; post?: (request: ApiRequest) => ApiResponse | undefined }
function mount(options: Options = {}) {
  const f = fakeHost(async request => {
    const path = request.path;
    if (path === "/v1/app/me") return json(200, meFixture({ developer: { ...meFixture().developer, orgRole: options.role ?? "owner" } }));
    if (path === ROOT + "/wiki" && request.method === "GET") return json(200, wikiIndex("web", { state: "none" }));
    if (path === ROOT + "/upkeep" && request.method === "GET") return options.upkeep?.() ?? json(200, { enabled: false, canManage: true, available: true, systemRunsOn: false, canEnableSystemRuns: true, cap: { monthlyUsd: 25, canRaise: true } });
    if (path === ROOT + "/wiki-build" && request.method === "GET") return options.build?.() ?? json(200, build());
    if (path === ROOT + "/wiki-map" && request.method === "GET") return options.map?.() ?? json(200, { status: "ready", canManage: true, map: map() });
    if (path === ROOT + "/wiki-build" && request.method === "POST") return options.post?.(request) ?? json(200, build({ status: "running" }));
    return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/web?tab=wiki"], children: h(WikiSkillsReadEntry, { project: "web" }) }) }) }), { theme: "light" });
  return { ...f, query, close() { ui.unmount(); query.clear(); } };
}
const builds = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method === "POST" && r.path === ROOT + "/wiki-build");

describe("the empty Wiki tab", () => {
  it("shows 'Build the wiki' to a person who may build, and pressing it sends the same build call the checklist row sends (once, with the forecast's chips)", async () => {
    const f = mount();
    const here = await screen.findByTestId("wiki-build-here");
    const button = await within(here).findByRole("button", { name: "Build the wiki" });
    // One way to build on the empty tab (the scope page has nothing to show yet), and copy that names only what exists.
    expect(screen.queryByRole("link", { name: "Scope and build" })).toBeNull();
    expect(here.textContent).toContain("Nothing is written until you press Build the wiki.");
    expect(here.textContent).not.toMatch(/Refresh now|your act|automation switch/u);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(builds(f)).toHaveLength(1));
    expect(Object.keys(builds(f)[0]!.body as object).sort()).toEqual(["chipsOn", "requestId"]);
    f.close();
  });

  it("with no AI key the button is disabled and the reason is on screen", async () => {
    const f = mount({ build: () => json(200, build({ aiKey: "missing", connectKey: "Connect an AI key to build the wiki." })) });
    const here = await screen.findByTestId("wiki-build-here");
    const button = await within(here).findByRole("button", { name: "Build the wiki" }) as unknown as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(here).getByTestId("wiki-setup-connect-key").textContent).toContain("Connect an AI key to build the wiki.");
    // With no key it says what is needed, never that building "uses your AI key".
    expect(here.textContent).toContain("To build the wiki, connect an AI key first.");
    expect(here.textContent).not.toContain("Building uses your AI key");
    fireEvent.click(button);
    expect(builds(f)).toHaveLength(0);
    f.close();
  });

  it("with nothing to write about (a forecast of 0 pages) the button is disabled and says why", async () => {
    const f = mount({ map: () => json(200, { status: "ready", canManage: true, map: map(0) }) });
    const here = await screen.findByTestId("wiki-build-here");
    const button = await within(here).findByRole("button", { name: "Build the wiki" }) as unknown as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(here).getByTestId("wiki-setup-no-pages").textContent).toBe(T.NO_PAGES);
    f.close();
  });

  it("a person who may not build sees no button, only that a project admin builds it", async () => {
    const f = mount({ role: "member", build: () => json(200, build({ canManage: false })), upkeep: () => json(200, { enabled: false, canManage: false, available: true, systemRunsOn: false, canEnableSystemRuns: true, cap: { monthlyUsd: 25, canRaise: false } }) });
    const here = await screen.findByTestId("wiki-build-here");
    await within(here).findByTestId("wiki-setup-read-only");
    expect(within(here).queryByRole("button", { name: "Build the wiki" })).toBeNull();
    // The copy names no button this person does not have, and the nightly-upkeep offer is not drawn even if the upkeep read says the company may enable it (same gate as Build).
    expect(here.textContent).not.toContain("press Build the wiki");
    expect(here.textContent).toContain("A project admin builds it.");
    await within(here).findByTestId("wiki-setup-upkeep");
    expect(within(here).queryByTestId("wiki-setup-upkeep-offer")).toBeNull();
    expect(builds(f)).toHaveLength(0);
    f.close();
  });

  it("a failed re-read takes Build away (last facts stay with one line), and a press at that moment sends nothing", async () => {
    const f = mount();
    const here = await screen.findByTestId("wiki-build-here");
    const button = await within(here).findByRole("button", { name: "Build the wiki" });
    f.query.getQueryCache().find({ queryKey: wikiSetupKey("web", "build") })!.setState({ status: "error", fetchFailureCount: 1, error: new Error("boom") });
    fireEvent.click(button);
    expect(builds(f)).toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId("wiki-setup-reconnecting").textContent).toBe(T.RECONNECTING));
    expect(screen.queryByRole("button", { name: "Build the wiki" })).toBeNull();
    // One line, not two: the reconnecting line stands alone (no "could not be done" under it with nothing to press).
    expect(screen.queryByTestId("wiki-setup-action-error")).toBeNull();
    f.close();
  });

  it("with 0 pages forecast every repo row says 0 too, so the rows add up to the total", async () => {
    const zero = { status: "ready", canManage: true, map: { ...map(0), repositories: [{ name: "web", status: "ok", files: 0, skipped: { generated: 0, vendored: 0, lockfiles: 0, assets: 0, secret: 0 }, skippedFolders: [], pages: { modules: 0, modulesCapped: false } }] } };
    const f = mount({ map: () => json(200, zero) });
    const here = await screen.findByTestId("wiki-build-here");
    await within(here).findByTestId("wiki-setup-no-pages");
    expect(within(within(here).getByRole("row", { name: /^web/u })).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["0", "0"]);
    expect(within(here).getByTestId("wiki-forecast-pages").textContent).toBe("0");
    f.close();
  });

  it("when Code does not serve the build the tab draws nothing extra (no dead button)", async () => {
    const f = mount({ build: () => json(501, { error: { code: "NOT_ON_CODE_YET", message: "Building the wiki isn't available on this Rovara yet." } }) });
    await screen.findByText(/No wiki pages yet/u);
    await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path === ROOT + "/wiki-build")).toBe(true));
    expect(screen.queryByRole("button", { name: "Build the wiki" })).toBeNull();
    f.close();
  });
});
