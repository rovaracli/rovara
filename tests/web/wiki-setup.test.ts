// @vitest-environment jsdom
// Lead 4 W6: the wiki row of the project's setup checklist (Code W0's file map, W4's build controls and the nightly upkeep seam, through Cloud). The row shows pages and never a dollar figure (the nightly upkeep cap and this month's upkeep spend are the two it names); every
// control is Code's call (a person who may not manage sees where the wiki stands and nothing to press); a refusal shows only a fixed sentence; one request id per action until it succeeds.
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { WIKI_SETUP_CODE_WORDS, WIKI_SETUP_WORDS } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { readUpkeepCap, parseUsd } from "../../packages/ui/src/api/wiki-setup.js";
import { ProjectChecklist } from "../../packages/ui/src/screens/setup/ProjectChecklist.js";
import { WikiChecklistRow } from "../../packages/ui/src/screens/setup/wiki/WikiChecklistRow.js";
import { rowStateOf, skippedLine } from "../../packages/ui/src/screens/setup/wiki/wiki-setup-text.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const LEAK = "SENSITIVE-SERVER-DETAIL";
const err = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
const WORDS = WIKI_SETUP_CODE_WORDS;
const map = (extra: Record<string, unknown> = {}) => ({
  computedAt: "2026-11-17T09:00:00.000Z", complete: true, repositoriesOmitted: 0,
  repositories: [
    { name: "web", status: "ok", files: 1204, skipped: { generated: 4, vendored: 9, lockfiles: 1, assets: 30, secret: 2 }, skippedFolders: ["dist", "vendor"], pages: { modules: 14, modulesCapped: false } },
    { name: "api", status: "partial", partial: "partial: the code host cut a listing", files: 2310, skipped: { generated: 0, vendored: 0, lockfiles: 2, assets: 4, secret: 0 }, skippedFolders: [], pages: { modules: 6, modulesCapped: true } },
  ],
  chips: [
    { id: "write-first-web-billing", kind: "write_first", repo: "web", path: "src/billing", label: "Write these first? web/src/billing", defaultOn: false },
    { id: "skip-generated-web-dist", kind: "skip_generated", repo: "web", path: "dist", label: "Skip? web/dist (generated)", defaultOn: true },
  ],
  forecast: { repositories: 2, files: 3514, pages: 24, pagesCapped: false, complete: false }, ...extra,
});
const build = (extra: Record<string, unknown> = {}) => ({ status: "none", limits: { pages: 300 }, canManage: true, aiKey: "connected", agents: { on: false }, wiki: { pages: 0, refreshPages: 0 }, ...extra });
const built = (extra: Record<string, unknown> = {}) => build({
  status: "built", stop: "built", message: WORDS.built, startedAt: "2026-11-17T10:00:00.000Z", summary: { pagesPlanned: 24, pagesWritten: 24, pagesKeptFromEarlier: 0, claimsKept: 144, claimsDropped: 3 }, wiki: { pages: 24, refreshPages: 2 }, ...extra,
});
const checklist = (extra: Record<string, unknown> = {}) => ({
  project: "web", viewer: { companyRole: "owner", projectAdmin: false, canSkip: true }, progress: { done: 2, total: 8, percent: 25, nextRequired: "setupRun" },
  repos: { state: "done", count: 1, items: [{ name: "web", fullName: "acme/web", defaultBranch: "main" }] }, setupRun: { state: "needs_you", status: "none", approval: "none" }, evalConfirm: { state: "needs_you", report: "none", blockedBy: "setupRun" },
  aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null }, slackChannel: { state: "optional", channels: [] }, linear: { state: "optional", team: null }, invites: { state: "optional" },
  firstTask: { state: "needs_you", hasTask: false, canStart: false }, ...extra,
});

interface Options {
  build?: () => ApiResponse; map?: () => ApiResponse; upkeep?: () => ApiResponse; post?: (request: ApiRequest) => ApiResponse | undefined; put?: (request: ApiRequest) => ApiResponse | undefined;
  cap?: () => ApiResponse; capPut?: (request: ApiRequest) => ApiResponse; status?: () => ApiResponse; companyAdmin?: boolean;
}
const ROOT = "/v1/app/projects/web";
function mount(element: ReturnType<typeof h>, options: Options = {}) {
  const f = fakeHost(async (request) => {
    const path = request.path;
    if (path === ROOT + "/wiki-build" && request.method === "GET") return options.build?.() ?? { status: 200, body: build() };
    if (path === ROOT + "/wiki-map" && request.method === "GET") return options.map?.() ?? { status: 200, body: { status: "ready", canManage: true, map: map() } };
    if (path === ROOT + "/wiki-map") return options.post?.(request) ?? { status: 200, body: { status: "ready", canManage: true, map: map() } };
    if (path === ROOT + "/upkeep" && request.method === "GET") return options.upkeep?.() ?? { status: 200, body: { enabled: false, canManage: true, available: true } };
    if (path === ROOT + "/upkeep") return options.put?.(request) ?? { status: 200, body: { enabled: (request.body as { on: boolean }).on, canManage: true, available: true } };
    if (path === "/v1/app/org/spend-limits" && request.method === "GET") return options.cap?.() ?? { status: 200, body: { companyId: "org_aaaaaaaaaaaaaaaaaaaa", defaults: { upkeepMonthlyUsd: 25 }, upkeep: [] } };
    if (path.startsWith("/v1/app/org/spend-limits/upkeep/")) return options.capPut?.(request) ?? { status: 200, body: {} };
    if (path.startsWith(ROOT + "/wiki-build")) return options.post?.(request) ?? { status: 200, body: build() };
    if (path === ROOT + "/setup-status") return options.status?.() ?? { status: 200, body: checklist() };
    if (path === ROOT + "/setup-agent") return { status: 200, body: { status: "none", basedOnRevision: 3, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, canManage: true } };
    return err(404, "NOT_FOUND", "route not found");
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/web"], children: element }) }) }), { theme: "light" });
  return { ...f, queryClient: query, close() { ui.unmount(); query.clear(); } };
}
const row = (admin = true) => h("ol", {}, h(WikiChecklistRow, { project: "web", companyAdmin: admin }));
const calls = (f: ReturnType<typeof mount>, method: string, path: string) => f.request.mock.calls.map(([request]) => request).filter((request) => request.method === method && request.path === path);
const open = async () => { const li = await screen.findByTestId("checklist-row-wiki"); li.querySelector("details")!.open = true; return li; };
const RID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe("the row is absent when Code has no wiki build", () => {
  it("Cloud's 'not on this Rovara yet' (501) and a project that is gone (404) draw nothing", async () => {
    for (const answer of [err(501, "NOT_ON_CODE_YET", WIKI_SETUP_WORDS.notYet), err(404, "NOT_FOUND", "project not found")]) {
      const f = mount(row(), { build: () => answer });
      await waitFor(() => expect(calls(f, "GET", ROOT + "/wiki-build")).toHaveLength(1));
      await waitFor(() => expect(screen.queryByTestId("checklist-row-wiki")).toBeNull());
      f.close();
    }
  });
  it("another failure keeps the row and says so in fixed words, with a way to try again", async () => {
    const f = mount(row(), { build: () => err(503, "RUNTIME_UNAVAILABLE", LEAK) });
    expect((await screen.findByTestId("wiki-setup-error", {}, { timeout: 5_000 })).textContent).toBe(WIKI_SETUP_WORDS.unavailable);
    expect(document.body.textContent).not.toContain(LEAK);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    f.close();
  });
});

describe("before a build", () => {
  it("no map yet: 'Map the files' (free), then the forecast in pages with no dollar figure", async () => {
    const f = mount(row(), { map: () => ({ status: 200, body: { status: "none", canManage: true } }) });
    const li = await open();
    fireEvent.click(await screen.findByTestId("wiki-setup-map"));
    await screen.findByTestId("wiki-forecast-pages");
    expect(calls(f, "POST", ROOT + "/wiki-map")[0]!.body).toEqual({});
    expect(screen.getByTestId("wiki-forecast-pages").textContent).toBe("24");
    // The forecast and the build say pages and no dollar figure (the upkeep cap below is the one place that names dollars: it is a limit a person sets).
    expect(screen.getByTestId("wiki-setup-forecast").textContent).not.toMatch(/\$|dollar/iu);
    expect(li.textContent).toContain("There is no cost figure yet");
    expect(screen.getByTestId("wiki-forecast-partial").textContent).toContain("real number of pages may be higher");
    expect(li.textContent).toContain("(partial: the code host cut a listing)");
    f.close();
  });

  it("Build sends the request id, the chips left on and the notes, and nothing else; the answer draws the running state", async () => {
    const f = mount(row(), { post: () => ({ status: 200, body: build({ status: "running", startedAt: "2026-11-17T10:00:00.000Z", summary: { pagesPlanned: 24, pagesWritten: 6, pagesKeptFromEarlier: 0, claimsKept: 30, claimsDropped: 0 } }) }) });
    await open();
    const first = await screen.findByRole("checkbox", { name: /Write these first\? web\/src\/billing/u });
    expect(first.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("checkbox", { name: /Skip\? web\/dist/u }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(first);
    fireEvent.change(screen.getByLabelText("Notes for the wiki build"), { target: { value: "Billing is the core." } });
    fireEvent.click(screen.getByTestId("wiki-setup-build"));
    await screen.findByTestId("wiki-setup-running");
    const sent = calls(f, "POST", ROOT + "/wiki-build");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ notes: "Billing is the core.", chipsOn: ["write-first-web-billing", "skip-generated-web-dist"] });
    expect(Object.keys(sent[0]!.body as object).sort()).toEqual(["chipsOn", "notes", "requestId"]);
    expect((sent[0]!.body as { requestId: string }).requestId).toMatch(RID);
    expect(screen.getByTestId("wiki-setup-progress").textContent).toBe("6 of 24 pages");
    expect(screen.getByTestId("checklist-row-wiki").getAttribute("data-state")).toBe("running");
    f.close();
  });

  it("blank notes are not sent; with no chip left on the list is empty, not absent", async () => {
    const f = mount(row(), { post: () => ({ status: 200, body: build({ status: "running" }) }) });
    await open();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Skip\? web\/dist/u }));
    fireEvent.click(screen.getByTestId("wiki-setup-build"));
    await screen.findByTestId("wiki-setup-running");
    expect(calls(f, "POST", ROOT + "/wiki-build")[0]!.body).toMatchObject({ chipsOn: [] });
    expect(calls(f, "POST", ROOT + "/wiki-build")[0]!.body).not.toHaveProperty("notes");
    f.close();
  });

  it("no AI key: Build is off and says why, with a link for a company admin and plain words for a project admin; nothing is sent", async () => {
    const view = () => ({ status: 200, body: build({ aiKey: "missing", connectKey: WORDS.connectKey }) });
    const f = mount(row(true), { build: view });
    await open();
    expect((await screen.findByTestId("wiki-setup-build")).hasAttribute("disabled")).toBe(true);
    const line = screen.getByTestId("wiki-setup-connect-key");
    expect(line.textContent).toContain(WORDS.connectKey);
    expect(within(line).getByRole("link", { name: "Connect an AI key" }).getAttribute("href")).toBe("/app/admin/ai-spending");
    expect(calls(f, "POST", ROOT + "/wiki-build")).toHaveLength(0);
    f.close();
    const g = mount(row(false), { build: view });
    await open();
    expect((await screen.findByTestId("wiki-setup-connect-key")).textContent).toContain("Ask a company owner or admin to connect one.");
    expect(within(screen.getByTestId("wiki-setup-connect-key")).queryByRole("link")).toBeNull();
    g.close();
  });

  it("a person who may not manage sees the state and no control; Code said so (canManage false)", async () => {
    const f = mount(row(false), { build: () => ({ status: 200, body: built({ canManage: false, agents: { on: true } }) }), upkeep: () => ({ status: 200, body: { enabled: true, canManage: false, available: true } }) });
    const li = await open();
    expect((await screen.findByTestId("wiki-setup-read-only")).textContent).toContain("Only project admins can build the wiki");
    expect(li.textContent).toContain("Wiki built.");
    expect(within(li).queryAllByRole("button")).toHaveLength(0);
    expect(within(li).queryAllByRole("switch")).toHaveLength(0);
    expect(screen.getByTestId("wiki-setup-agents-state").textContent).toContain("Agents use the wiki.");
    expect((await screen.findByTestId("wiki-setup-upkeep-state")).textContent).toContain("Nightly upkeep is on.");
    expect(screen.queryByTestId("wiki-setup-cap")).toBeNull();
    f.close();
    const g = mount(row(false), { build: () => ({ status: 200, body: build({ canManage: false }) }), map: () => ({ status: 200, body: { status: "none", canManage: false } }) });
    const none = await open();
    await screen.findByText("A project admin builds the wiki here. They see how many pages it will have first.");
    expect(within(none).queryByRole("button", { name: "Map the files" })).toBeNull();
    g.close();
  });
});

describe("while and after a build", () => {
  it("running: progress in pages and Stop; Stop sends the request id only", async () => {
    const running = build({ status: "running", summary: { pagesPlanned: 40, pagesWritten: 12, pagesKeptFromEarlier: 0, claimsKept: 5, claimsDropped: 0 } });
    const f = mount(row(), { build: () => ({ status: 200, body: running }), post: () => ({ status: 200, body: build({ status: "stopped", stop: "stopped_by_person", message: WORDS.stopped_by_person, canContinue: true, stoppedBy: { name: "Priya", at: "2026-11-17T10:30:00.000Z" }, wiki: { pages: 12, refreshPages: 0 } }) }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-progress")).textContent).toBe("12 of 40 pages");
    expect(screen.getByRole("progressbar", { name: "Wiki build progress" }).getAttribute("value")).toBe("12");
    fireEvent.click(screen.getByTestId("wiki-setup-stop"));
    expect((await screen.findByTestId("wiki-setup-message")).textContent).toContain("Stopped by Priya.");
    expect(Object.keys(calls(f, "POST", ROOT + "/wiki-build/stop")[0]!.body as object)).toEqual(["requestId"]);
    expect(screen.getByTestId("wiki-setup-continue")).toBeTruthy();
    f.close();
  });

  it("stopped at the build's limit says so in Code's sentence and offers Continue; a refusal of Continue shows only a fixed sentence", async () => {
    const stopped = build({ status: "stopped", stop: "budget_used", message: WORDS.budget_used, canContinue: true, summary: { pagesPlanned: 40, pagesWritten: 12, pagesKeptFromEarlier: 0, claimsKept: 70, claimsDropped: 2 }, wiki: { pages: 12, refreshPages: 0 } });
    const f = mount(row(), { build: () => ({ status: 200, body: stopped }), post: () => err(402, "BUDGET_EXCEEDED", WORDS.raiseCap) });
    const li = await open();
    expect((await screen.findByTestId("wiki-setup-message")).textContent).toBe(WORDS.budget_used);
    expect(screen.getByTestId("wiki-setup-result").textContent).not.toMatch(/\$/u);
    expect(li.textContent).toContain("reached its spending limit");
    // Code refuses Continue after the build's limit was used (it asks to raise the limit) and this page cannot raise it: no button is drawn, and the page says so.
    expect(screen.queryByTestId("wiki-setup-continue")).toBeNull();
    expect(screen.getByTestId("wiki-setup-raise-cap").textContent).toContain("Raising it is not something this page can do yet");
    f.close();
    const other = build({ status: "stopped", stop: "repo_unreadable", message: WORDS.repo_unreadable, canContinue: true, wiki: { pages: 12, refreshPages: 0 } });
    const g = mount(row(), { build: () => ({ status: 200, body: other }), post: () => err(503, "RUNTIME_UNAVAILABLE", LEAK) });
    await open();
    fireEvent.click(await screen.findByTestId("wiki-setup-continue"));
    expect((await screen.findByTestId("wiki-setup-action-error")).textContent).toBe("That could not be done just now. Try again.");
    expect(document.body.textContent).not.toContain(LEAK);
    g.close();
  });

  it("built: the report counts pages and sentences, names what was skipped (counts only, never a secret file's name), and links to the wiki", async () => {
    const f = mount(row(), { build: () => ({ status: 200, body: built() }) });
    const li = await open();
    const report = await screen.findByTestId("wiki-setup-report");
    expect(within(report).getByText("Pages written").nextSibling!.textContent).toBe("24");
    expect(within(report).getByText("Sentences with a source found").nextSibling!.textContent).toBe("144");
    expect(within(report).getByText("Sentences dropped").nextSibling!.textContent).toBe("3");
    expect(screen.getByTestId("wiki-setup-skipped").textContent).toBe("Skipped: 13 generated or vendored files, 3 lock files, 34 images and other binary files, 2 secret-shaped files (never read).");
    expect(li.textContent).toContain("web/dist");
    expect(screen.getByTestId("wiki-setup-open").getAttribute("href")).toBe("/app/projects/web?tab=wiki");
    expect(li.getAttribute("data-state")).toBe("done");
    f.close();
  });
});

describe("the wiki's switches", () => {
  it("'Give the wiki to agents' starts off and says so; turning it on sends the request id and the choice", async () => {
    const f = mount(row(), { build: () => ({ status: 200, body: built() }), post: () => ({ status: 200, body: built({ agents: { on: true } }) }) });
    await open();
    const toggle = await screen.findByRole("switch", { name: "Give the wiki to agents" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("wiki-setup-agents-state").textContent).toContain("Agents do not get it until you turn this on.");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Give the wiki to agents" }).getAttribute("aria-checked")).toBe("true"));
    const sent = calls(f, "POST", ROOT + "/wiki-build/agents");
    expect(sent[0]!.body).toMatchObject({ on: true });
    expect(Object.keys(sent[0]!.body as object).sort()).toEqual(["on", "requestId"]);
    f.close();
  });

  it("Refresh now says how many pages are out of date and sends the request id only; nothing out of date reads 'Every page is up to date'", async () => {
    const f = mount(row(), { build: () => ({ status: 200, body: built() }), post: () => ({ status: 200, body: built({ status: "running" }) }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-refresh-count")).textContent).toBe("2 pages are out of date or marked wrong.");
    fireEvent.click(screen.getByTestId("wiki-setup-refresh"));
    await waitFor(() => expect(calls(f, "POST", ROOT + "/wiki-build/refresh")).toHaveLength(1));
    expect(Object.keys(calls(f, "POST", ROOT + "/wiki-build/refresh")[0]!.body as object)).toEqual(["requestId"]);
    f.close();
    const g = mount(row(), { build: () => ({ status: 200, body: built({ wiki: { pages: 24, refreshPages: 0 } }) }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-refresh-count")).textContent).toBe("Every page is up to date.");
    g.close();
  });

  it("Delete asks first: Cancel sends nothing, Delete sends the request id and shows the empty state with the deleted notice", async () => {
    const f = mount(row(), { build: () => ({ status: 200, body: built() }), post: (request) => (request.path.endsWith("/delete") ? { status: 200, body: { deleted: true, message: WORDS.deleted, view: build() } } : undefined) });
    await open();
    fireEvent.click(await screen.findByTestId("wiki-setup-delete"));
    expect(screen.getByText("Delete all pages and notes?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("wiki-setup-delete-no"));
    expect(calls(f, "POST", ROOT + "/wiki-build/delete")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("wiki-setup-delete"));
    fireEvent.click(screen.getByTestId("wiki-setup-delete-yes"));
    expect((await screen.findByTestId("wiki-setup-deleted")).textContent).toContain("The wiki was deleted.");
    expect(Object.keys(calls(f, "POST", ROOT + "/wiki-build/delete")[0]!.body as object)).toEqual(["requestId"]);
    await waitFor(() => expect(screen.getByTestId("checklist-row-wiki").getAttribute("data-state")).toBe("optional"));
    expect(screen.queryByTestId("wiki-setup-controls")).toBeNull();
    f.close();
  });

  it("Delete cannot be pressed while a build runs", async () => {
    const f = mount(row(), { build: () => ({ status: 200, body: built({ status: "running" }) }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-delete")).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Stop the build first, then delete the wiki.")).toBeTruthy();
    f.close();
  });

  it("a failed change repeats the SAME request id on the next try, and a new action gets a new one", async () => {
    let fail = true;
    const f = mount(row(), { build: () => ({ status: 200, body: built() }), post: () => { if (fail) { fail = false; return err(503, "RUNTIME_UNAVAILABLE", LEAK); } return { status: 200, body: built({ agents: { on: true } }) }; } });
    await open();
    fireEvent.click(await screen.findByRole("switch", { name: "Give the wiki to agents" }));
    await screen.findByTestId("wiki-setup-action-error");
    fireEvent.click(screen.getByRole("switch", { name: "Give the wiki to agents" }));
    await waitFor(() => expect(calls(f, "POST", ROOT + "/wiki-build/agents")).toHaveLength(2));
    const [one, two] = calls(f, "POST", ROOT + "/wiki-build/agents").map((request) => (request.body as { requestId: string }).requestId);
    expect(one).toBe(two);
    await waitFor(() => expect(screen.queryByTestId("wiki-setup-action-error")).toBeNull());
    fireEvent.click(screen.getByRole("switch", { name: "Give the wiki to agents" }));
    await waitFor(() => expect(calls(f, "POST", ROOT + "/wiki-build/agents")).toHaveLength(3));
    expect((calls(f, "POST", ROOT + "/wiki-build/agents")[2]!.body as { requestId: string }).requestId).not.toBe(one);
    f.close();
  });
});

describe("an AI key that Code cannot see (hosted: aiKey unknown)", () => {
  it("Build is offered with no key warning; a run that ends 'needs an AI key' says so and links to connect one", async () => {
    const f = mount(row(), { build: () => ({ status: 200, body: build({ aiKey: "unknown" }) }) });
    await open();
    expect(((await screen.findByTestId("wiki-setup-build")).hasAttribute("disabled"))).toBe(false);
    expect(screen.queryByTestId("wiki-setup-connect-key")).toBeNull();
    f.close();
    const ended = build({ status: "stopped", stop: "needs_ai_key", message: WORDS.needs_ai_key, aiKey: "unknown", canContinue: true, wiki: { pages: 3, refreshPages: 0 }, summary: { pagesPlanned: 20, pagesWritten: 3, pagesKeptFromEarlier: 0, claimsKept: 9, claimsDropped: 0 } });
    const g = mount(row(), { build: () => ({ status: 200, body: ended }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-message")).textContent).toBe(WORDS.needs_ai_key);
    const line = screen.getByTestId("wiki-setup-connect-key");
    expect(within(line).getByRole("link", { name: "Connect an AI key" }).getAttribute("href")).toBe("/app/admin/ai-spending");
    g.close();
  });
});

describe("small behaviours the review asked for", () => {
  it("an open Delete confirmation does not come back after a build has run", async () => {
    let state = built();
    const f = mount(row(), { build: () => ({ status: 200, body: state }) });
    await open();
    fireEvent.click(await screen.findByTestId("wiki-setup-delete"));
    expect(screen.getByTestId("wiki-setup-delete-yes")).toBeTruthy();
    state = built({ status: "running" });
    await act(async () => { await f.queryClient.refetchQueries({ queryKey: ["wiki-setup", "web", "build"] }); });
    await waitFor(() => expect(screen.getByTestId("checklist-row-wiki").getAttribute("data-state")).toBe("running"));
    state = built();
    await act(async () => { await f.queryClient.refetchQueries({ queryKey: ["wiki-setup", "web", "build"] }); });
    await waitFor(() => expect(screen.getByTestId("checklist-row-wiki").getAttribute("data-state")).toBe("done"));
    await screen.findByTestId("wiki-setup-delete");
    expect(screen.queryByTestId("wiki-setup-delete-yes")).toBeNull();
    f.close();
  });

  it("control characters typed or pasted into the notes are dropped (a tab would make the body unreadable); new lines stay", async () => {
    const f = mount(row(), { post: () => ({ status: 200, body: build({ status: "running" }) }) });
    await open();
    const notes = await screen.findByLabelText("Notes for the wiki build");
    fireEvent.change(notes, { target: { value: "a\tb\u200bc\nline two" } });
    fireEvent.click(screen.getByTestId("wiki-setup-build"));
    await screen.findByTestId("wiki-setup-running");
    expect(calls(f, "POST", ROOT + "/wiki-build")[0]!.body).toMatchObject({ notes: "abc\nline two" });
    f.close();
  });

  it("one failed poll during a running build keeps the progress on screen", async () => {
    let fail = false;
    const f = mount(row(), { build: () => (fail ? err(503, "RUNTIME_UNAVAILABLE", LEAK) : { status: 200, body: build({ status: "running", summary: { pagesPlanned: 40, pagesWritten: 12, pagesKeptFromEarlier: 0, claimsKept: 1, claimsDropped: 0 } }) }) });
    await open();
    await screen.findByTestId("wiki-setup-progress");
    fail = true;
    await act(async () => { await f.queryClient.refetchQueries({ queryKey: ["wiki-setup", "web", "build"] }).catch(() => undefined); });
    expect(screen.getByTestId("wiki-setup-progress").textContent).toBe("12 of 40 pages");
    expect(screen.queryByTestId("wiki-setup-error")).toBeNull();
    f.close();
  });
});

describe("nightly upkeep", () => {
  it("one switch, off by default; turning it on sends the request id and the choice; each part names its limit", async () => {
    const f = mount(row(), { put: (request) => ({ status: 200, body: { enabled: (request.body as { on: boolean }).on, canManage: true, available: true } }) });
    await open();
    const toggle = await screen.findByRole("switch", { name: "Nightly upkeep" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("wiki-setup-upkeep-state").textContent).toContain("Nightly upkeep is off.");
    const limits = screen.getByTestId("wiki-setup-upkeep-limits").textContent;
    expect(limits).toContain("Setup and mock checks: no AI.");
    expect(limits).toContain("held by the nightly upkeep cap below");
    expect(limits).toContain("held by this project's monthly limit and the build's own limit");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Nightly upkeep" }).getAttribute("aria-checked")).toBe("true"));
    const sent = calls(f, "PUT", ROOT + "/upkeep");
    expect(sent[0]!.body).toMatchObject({ on: true });
    expect(Object.keys(sent[0]!.body as object).sort()).toEqual(["on", "requestId"]);
    expect(screen.getByTestId("wiki-setup-upkeep-state").textContent).toContain("Nightly upkeep is on.");
    f.close();
  });

  it("a Code without the upkeep route says so and draws no switch; another failure says fixed words only", async () => {
    const f = mount(row(), { upkeep: () => err(501, "NOT_ON_CODE_YET", WIKI_SETUP_WORDS.upkeepNotYet) });
    await open();
    expect((await screen.findByTestId("wiki-setup-upkeep-absent")).textContent).toBe(WIKI_SETUP_WORDS.upkeepNotYet);
    expect(screen.queryByRole("switch", { name: "Nightly upkeep" })).toBeNull();
    f.close();
    const g = mount(row(), { upkeep: () => err(503, "RUNTIME_UNAVAILABLE", LEAK) });
    await open();
    expect((await screen.findByTestId("wiki-setup-upkeep-absent", {}, { timeout: 5_000 })).textContent).toBe("That could not be done just now. Try again.");
    expect(document.body.textContent).not.toContain(LEAK);
    g.close();
  });

  it("until Code says its nightly runs are available (false or absent), no switch, state or cap is drawn; only the not-yet line", async () => {
    for (const body of [{ enabled: false, canManage: true, available: false }, { enabled: false, canManage: true }]) {
      const f = mount(row(true), { upkeep: () => ({ status: 200, body }) });
      await open();
      expect((await screen.findByTestId("wiki-setup-upkeep-absent")).textContent).toBe(WIKI_SETUP_WORDS.upkeepNotYet);
      expect(screen.queryByRole("switch", { name: "Nightly upkeep" })).toBeNull();
      expect(screen.queryByTestId("wiki-setup-upkeep-state")).toBeNull();
      expect(screen.queryByTestId("wiki-setup-upkeep-limits")).toBeNull();
      expect(screen.queryByTestId("wiki-setup-cap")).toBeNull();
      expect(screen.queryByTestId("wiki-setup-cap-ask")).toBeNull();
      f.close();
    }
  });

  it("a PUT answer that omits available keeps the switch and its state visible (the switch was only drawn because Code said it was available)", async () => {
    const f = mount(row(), { put: (request) => ({ status: 200, body: { enabled: (request.body as { on: boolean }).on, canManage: true } }) });
    await open();
    fireEvent.click(await screen.findByRole("switch", { name: "Nightly upkeep" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Nightly upkeep" }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByTestId("wiki-setup-upkeep-state").textContent).toContain("Nightly upkeep is on.");
    expect(screen.queryByTestId("wiki-setup-upkeep-absent")).toBeNull();
    f.close();
  });

  it("a refused switch shows fixed words only", async () => {
    const f = mount(row(), { put: () => err(403, "FORBIDDEN", LEAK) });
    await open();
    fireEvent.click(await screen.findByRole("switch", { name: "Nightly upkeep" }));
    expect((await screen.findByTestId("wiki-setup-upkeep-error")).textContent).toBe("That could not be done just now. Try again.");
    expect(document.body.textContent).not.toContain(LEAK);
    f.close();
  });

  it("the cap: a company admin reads the company default, saves their own with the Spending page's body, and sees the new words", async () => {
    let rows: unknown[] = [];
    const f = mount(row(true), {
      cap: () => ({ status: 200, body: { companyId: "org_aaaaaaaaaaaaaaaaaaaa", defaults: { upkeepMonthlyUsd: 25 }, upkeep: rows } }),
      capPut: (request) => { rows = [{ id: "web", monthlyUsd: (request.body as { monthlyUsd: number }).monthlyUsd, version: 1 }]; return { status: 200, body: {} }; },
    });
    await open();
    const box = await screen.findByTestId("wiki-setup-cap");
    expect(within(box).getByLabelText("Monthly cap on nightly upkeep")).toHaveProperty("value", "25.00");
    expect(box.textContent).toContain("This is the standard cap for nightly upkeep.");
    fireEvent.change(within(box).getByLabelText("Monthly cap on nightly upkeep"), { target: { value: "$12.50" } });
    fireEvent.click(screen.getByTestId("wiki-setup-cap-save"));
    await screen.findByTestId("wiki-setup-cap-saved");
    expect(calls(f, "PUT", "/v1/app/org/spend-limits/upkeep/web")[0]!.body).toEqual({ expectedVersion: 0, monthlyUsd: 12.5 });
    await waitFor(() => expect(screen.getByTestId("wiki-setup-cap").textContent).toContain("This project has its own cap."));
    // The word "Saved." survives the redraw of the field with its new version.
    expect(screen.getByTestId("wiki-setup-cap-saved")).toBeTruthy();
    fireEvent.change(within(screen.getByTestId("wiki-setup-cap")).getByLabelText("Monthly cap on nightly upkeep"), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("wiki-setup-cap-save"));
    await waitFor(() => expect(calls(f, "PUT", "/v1/app/org/spend-limits/upkeep/web")).toHaveLength(2));
    expect(calls(f, "PUT", "/v1/app/org/spend-limits/upkeep/web")[1]!.body).toEqual({ expectedVersion: 1, monthlyUsd: 0 });
    f.close();
  });

  it("the cap: a bad amount is refused here without a call; an old STEP_UP_REQUIRED is a plain refusal with no sign-in step; a refusal shows only a known sentence", async () => {
    const f = mount(row(true), { capPut: () => err(403, "STEP_UP_REQUIRED", "Confirm it's you again, then try once more.") });
    await open();
    const input = await screen.findByLabelText("Monthly cap on nightly upkeep");
    for (const bad of ["abc", "-1", "1.234", "1000001"]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.click(screen.getByTestId("wiki-setup-cap-save"));
      expect((await screen.findByTestId("wiki-setup-cap-error")).textContent).toBe("Use an amount from 0 to 1,000,000, with at most two decimals.");
    }
    expect(calls(f, "PUT", "/v1/app/org/spend-limits/upkeep/web")).toHaveLength(0);
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.click(screen.getByTestId("wiki-setup-cap-save"));
    expect((await screen.findByTestId("wiki-setup-cap-error")).textContent).toBe("That could not be saved just now. Try again.");
    expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
    f.close();
    for (const [message, shown] of [[LEAK, "That could not be saved just now. Try again."], ["Raising this limit needs a second admin under your company's rules. Ask an owner to change the rules, or raise the company default in Company settings.", "Raising this limit needs a second admin under your company's rules. Ask an owner to change the rules, or raise the company default in Company settings."]] as const) {
      const g = mount(row(true), { capPut: () => err(403, "SECOND_PERSON_REQUIRED", message) });
      await open();
      fireEvent.change(await screen.findByLabelText("Monthly cap on nightly upkeep"), { target: { value: "40" } });
      fireEvent.click(screen.getByTestId("wiki-setup-cap-save"));
      expect((await screen.findByTestId("wiki-setup-cap-error")).textContent).toBe(shown);
      expect(document.body.textContent).not.toContain(LEAK);
      g.close();
    }
  });

  it("the cap: a project admin who is not a company admin is told who sets it and nothing is read; an unreadable answer says so and draws no number", async () => {
    const f = mount(row(false));
    await open();
    expect((await screen.findByTestId("wiki-setup-cap-ask")).textContent).toBe("A company owner or admin sets the monthly cap.");
    expect(calls(f, "GET", "/v1/app/org/spend-limits")).toHaveLength(0);
    f.close();
    const g = mount(row(true), { cap: () => ({ status: 200, body: { upkeep: "nope" } }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-cap-unreadable")).textContent).toBe("The monthly cap could not be read just now.");
    expect(screen.queryByTestId("wiki-setup-cap")).toBeNull();
    g.close();
  });
});

// ---- L4-W6b: the company's choice (DEC 254zzt option A, two locks) -------------------------------------------------------------------------------------------------------------------
// Mutants (each killed by the named test, run by hand): U1 offer drawn without canEnableSystemRuns; U2 offer drawn while system runs are on; U3 a maintainer's switch drawn while consent is off; U4 a reader's switch drawn;
// U5 controls drawn when available is false; U6 the confirm sends without allowSystemRuns; U7 "on" shown for a project switch that is on while consent is off; U8 raise link without canRaise; U9 a made-up number for a null cap;
// U10 a plain switch sends allowSystemRuns; U11 the "allow first" line shown to a reader; U12 the offer sends before the confirm; U13 a failed confirm shows Code's own text; U14 legacy Code (no systemRunsOn) gets the offer.
const VIEW = { enabled: false, canManage: true, available: true, systemRunsOn: false, canEnableSystemRuns: true, cap: { monthlyUsd: null, canRaise: true } };
const upkeepIs = (extra: Record<string, unknown>) => () => ({ status: 200, body: { ...VIEW, ...extra } });
const OFFER = "Keep this project healthy every night";
const noControls = () => {
  expect(screen.queryByRole("switch", { name: "Nightly upkeep" })).toBeNull();
  expect(screen.queryByTestId("wiki-setup-upkeep-offer")).toBeNull();
  expect(screen.queryByTestId("wiki-setup-upkeep-confirm")).toBeNull();
};

// ---- L4-P3 (owner 2026-11-17): allowing needs a fresh sign-in; the company's one control is linked from here ---------------------------------------------------------------------------------
// Mutants (each killed by the named test, run by hand): V1 a step-up answer shown as an error sentence instead of the sign-in step; V2 the request id replaced after a step-up refusal (the retry is a new act);
// V3 a sign-in step drawn for a refusal; V4 the company link drawn for a maintainer or while consent is off.
describe("nightly upkeep: no sign-in step (owner DEC 254zzz73) and the company control's link (L4-P3)", () => {
  it("allowing is one press: no sign-in step, and an old REAUTH_REQUIRED from Code is an error sentence, never a sign-in step (V1, V2)", async () => {
    const f = mount(row(true), { upkeep: upkeepIs({}), put: () => err(403, "REAUTH_REQUIRED", LEAK) });
    await open();
    fireEvent.click(await screen.findByTestId("wiki-setup-upkeep-offer"));
    fireEvent.click(await screen.findByTestId("wiki-setup-upkeep-yes"));
    expect(await screen.findByTestId("wiki-setup-upkeep-error")).toBeTruthy();
    expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
    expect(f.host.signIn).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(LEAK);
    f.close();
  });

  it("a refusal is an error sentence, never a sign-in step (V3)", async () => {
    const f = mount(row(true), { upkeep: upkeepIs({}), put: () => err(403, "FORBIDDEN", WIKI_SETUP_WORDS.upkeepConsentNotAllowed) });
    await open();
    fireEvent.click(await screen.findByTestId("wiki-setup-upkeep-offer"));
    fireEvent.click(await screen.findByTestId("wiki-setup-upkeep-yes"));
    expect((await screen.findByTestId("wiki-setup-upkeep-error")).textContent).toBe(WIKI_SETUP_WORDS.upkeepConsentNotAllowed);
    expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
    f.close();
  });

  it("an owner or admin with consent on sees where to withdraw it; a maintainer and anyone while consent is off do not (V4)", async () => {
    const on = upkeepIs({ enabled: true, systemRunsOn: true, canEnableSystemRuns: true });
    const a = mount(row(true), { upkeep: on });
    await open();
    const line = await screen.findByTestId("wiki-setup-upkeep-company-link");
    expect(line.textContent).toBe("Withdraw nightly upkeep for the whole company in Company settings.");
    expect(within(line).getByRole("link", { name: "Company settings" }).getAttribute("href")).toBe("/app/admin/settings");
    a.close();
    const m = mount(row(false), { upkeep: upkeepIs({ enabled: true, systemRunsOn: true, canEnableSystemRuns: false }) });
    await open();
    await screen.findByTestId("wiki-setup-upkeep-state");
    expect(screen.queryByTestId("wiki-setup-upkeep-company-link")).toBeNull();
    m.close();
    const off = mount(row(true), { upkeep: upkeepIs({}) });
    await open();
    await screen.findByTestId("wiki-setup-upkeep-offer");
    expect(screen.queryByTestId("wiki-setup-upkeep-company-link")).toBeNull();
    off.close();
  });
});

describe("nightly upkeep: the company's choice", () => {
  it("a company owner or admin, consent off: one choice, then one confirm that says what runs and the cap; yes sends the consent and the switch in one act (U1, U6, U12, U14)", async () => {
    let state = { ...VIEW } as Record<string, unknown>;
    const f = mount(row(true), { upkeep: () => ({ status: 200, body: state }), put: () => { state = { ...state, enabled: true, systemRunsOn: true }; return { status: 200, body: state }; } });
    await open();
    const offer = await screen.findByTestId("wiki-setup-upkeep-offer");
    expect(offer.textContent).toBe(OFFER);
    noControlsExceptOffer();
    expect(screen.queryByTestId("wiki-setup-upkeep-limits")).toBeNull();
    expect(screen.queryByTestId("wiki-setup-cap")).toBeNull();
    expect(screen.getByTestId("wiki-setup-upkeep-state").textContent).toContain("Nightly upkeep is off.");
    fireEvent.click(offer);
    const confirm = await screen.findByTestId("wiki-setup-upkeep-confirm");
    expect(calls(f, "PUT", ROOT + "/upkeep")).toHaveLength(0);
    expect(screen.getByRole("group", { name: OFFER })).toBe(confirm);
    expect(confirm.textContent).toContain("Setup check and mock checks: no AI. Wiki refresh: AI, uses your key.");
    // Code has no read of the cap: the page says where it is set and invents no figure.
    const line = within(confirm).getByTestId("wiki-setup-upkeep-cap-line");
    expect(line.textContent).toBe("Monthly cap: set in Spending limits.");
    expect(within(line).getByRole("link", { name: "Spending limits" }).getAttribute("href")).toBe("/app/admin/money/limits");
    expect(confirm.textContent).not.toMatch(/\$/u);
    await expectNoAxeViolations(document.body);
    fireEvent.click(within(confirm).getByTestId("wiki-setup-upkeep-yes"));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Nightly upkeep" }).getAttribute("aria-checked")).toBe("true"));
    const sent = calls(f, "PUT", ROOT + "/upkeep");
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body as { requestId: string; on: boolean; allowSystemRuns: boolean };
    expect(Object.keys(body).sort()).toEqual(["allowSystemRuns", "on", "requestId"]);
    expect(RID.test(body.requestId)).toBe(true);
    expect([body.on, body.allowSystemRuns]).toEqual([true, true]);
    expect(screen.queryByTestId("wiki-setup-upkeep-offer")).toBeNull();
    expect(screen.queryByTestId("wiki-setup-upkeep-confirm")).toBeNull();
    expect(screen.getByTestId("wiki-setup-upkeep-state").textContent).toContain("Nightly upkeep is on.");
    expect(screen.getByTestId("wiki-setup-upkeep-limits")).toBeTruthy();
    await screen.findByTestId("wiki-setup-cap");
    f.close();
  });

  it("the confirm shows the cap Code states, and a raise link only when Code says the person can raise it (U8, U9)", async () => {
    for (const [canRaise, link] of [[true, true], [false, false]] as const) {
      const f = mount(row(true), { upkeep: upkeepIs({ cap: { monthlyUsd: 40, canRaise } }) });
      await open();
      fireEvent.click(await screen.findByTestId("wiki-setup-upkeep-offer"));
      const line = await screen.findByTestId("wiki-setup-upkeep-cap-line");
      expect(line.textContent?.startsWith("Monthly cap: $40.00.")).toBe(true);
      expect(line.textContent).not.toContain("25");
      expect(within(line).queryAllByRole("link").length).toBe(link ? 1 : 0);
      if (link) expect(within(line).getByRole("link", { name: "Raise the cap" }).getAttribute("href")).toBe("/app/admin/money/limits");
      f.close();
    }
    const g = mount(row(true), { upkeep: upkeepIs({ cap: { monthlyUsd: null, canRaise: false } }) });
    await open();
    fireEvent.click(await screen.findByTestId("wiki-setup-upkeep-offer"));
    const none = await screen.findByTestId("wiki-setup-upkeep-cap-line");
    expect(none.textContent).toBe("Monthly cap: set in Spending limits.");
    expect(within(none).queryAllByRole("link")).toHaveLength(0);
    g.close();
  });

  it("cancel sends nothing; a refused confirm shows Cloud's fixed words and never Code's text, and the choice is still there (U13)", async () => {
    const f = mount(row(true), { upkeep: upkeepIs({}) });
    await open();
    fireEvent.click(await screen.findByTestId("wiki-setup-upkeep-offer"));
    fireEvent.click(await screen.findByTestId("wiki-setup-upkeep-no"));
    expect(screen.queryByTestId("wiki-setup-upkeep-confirm")).toBeNull();
    expect(screen.getByTestId("wiki-setup-upkeep-offer")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("wiki-setup-upkeep-offer"));
    expect(calls(f, "PUT", ROOT + "/upkeep")).toHaveLength(0);
    f.close();
    for (const [answer, words] of [
      [err(403, "FORBIDDEN", WIKI_SETUP_WORDS.upkeepConsentNotAllowed), WIKI_SETUP_WORDS.upkeepConsentNotAllowed],
      [err(403, "FORBIDDEN", LEAK), "That could not be done just now. Try again."],
      [err(501, "NOT_ON_CODE_YET", WIKI_SETUP_WORDS.upkeepNotYet), WIKI_SETUP_WORDS.upkeepNotYet],
    ] as const) {
      const g = mount(row(true), { upkeep: upkeepIs({}), put: () => answer });
      await open();
      fireEvent.click(await screen.findByTestId("wiki-setup-upkeep-offer"));
      fireEvent.click(await screen.findByTestId("wiki-setup-upkeep-yes"));
      expect((await screen.findByTestId("wiki-setup-upkeep-error")).textContent).toBe(words);
      expect(document.body.textContent).not.toContain(LEAK);
      expect(screen.queryByRole("switch", { name: "Nightly upkeep" })).toBeNull();
      g.close();
    }
  });

  it("a maintainer (may manage, may not give the consent): no choice and no switch while consent is off, only who must act first (U1, U3)", async () => {
    const f = mount(row(false), { upkeep: upkeepIs({ canEnableSystemRuns: false, cap: { monthlyUsd: 40, canRaise: false } }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-upkeep-needs-admin")).textContent).toBe("A company admin must allow nightly upkeep first.");
    noControls();
    expect(screen.getByTestId("wiki-setup-upkeep-state").textContent).toContain("Nightly upkeep is off.");
    expect(screen.queryByTestId("wiki-setup-upkeep-limits")).toBeNull();
    expect(screen.queryByRole("link", { name: /Raise the cap|Spending limits/u })).toBeNull();
    expect(document.body.textContent).not.toContain("$40");
    f.close();
  });

  it("a maintainer, consent on: the project switch, which sends only the id and the choice, never the consent (U10)", async () => {
    let state = { ...VIEW, canEnableSystemRuns: false, systemRunsOn: true, cap: { monthlyUsd: 40, canRaise: false } } as Record<string, unknown>;
    const f = mount(row(false), { upkeep: () => ({ status: 200, body: state }), put: (request) => { state = { ...state, enabled: (request.body as { on: boolean }).on }; return { status: 200, body: state }; } });
    await open();
    const toggle = await screen.findByRole("switch", { name: "Nightly upkeep" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("wiki-setup-upkeep-offer")).toBeNull();
    expect(screen.queryByTestId("wiki-setup-upkeep-needs-admin")).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Nightly upkeep" }).getAttribute("aria-checked")).toBe("true"));
    const sent = calls(f, "PUT", ROOT + "/upkeep");
    expect(Object.keys(sent[0]!.body as object).sort()).toEqual(["on", "requestId"]);
    expect(sent[0]!.body).toMatchObject({ on: true });
    expect(screen.getByTestId("wiki-setup-upkeep-state").textContent).toContain("Nightly upkeep is on.");
    expect(screen.getByTestId("wiki-setup-cap-ask").textContent).toBe("A company owner or admin sets the monthly cap.");
    expect(screen.queryByRole("link", { name: /Raise the cap|Spending limits/u })).toBeNull();
    f.close();
  });

  it("an owner or admin, consent on: the plain project switch and the cap editor, not the choice (U2)", async () => {
    const f = mount(row(true), { upkeep: upkeepIs({ systemRunsOn: true, enabled: true }) });
    await open();
    expect((await screen.findByRole("switch", { name: "Nightly upkeep" })).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("wiki-setup-upkeep-offer")).toBeNull();
    await screen.findByTestId("wiki-setup-cap");
    f.close();
  });

  it("a reader sees where it stands and nothing to press or ask for, with consent off or on (U4, U11)", async () => {
    for (const [systemRunsOn, enabled, on] of [[false, false, false], [true, true, true], [true, false, false]] as const) {
      const f = mount(row(false), { upkeep: upkeepIs({ canManage: false, canEnableSystemRuns: false, systemRunsOn, enabled, cap: { monthlyUsd: 40, canRaise: false } }) });
      await open();
      const state = await screen.findByTestId("wiki-setup-upkeep-state");
      expect(state.textContent).toContain(on ? "Nightly upkeep is on." : "Nightly upkeep is off.");
      noControls();
      expect(screen.queryByTestId("wiki-setup-upkeep-needs-admin")).toBeNull();
      expect(screen.queryByTestId("wiki-setup-cap")).toBeNull();
      expect(screen.queryByTestId("wiki-setup-cap-ask")).toBeNull();
      expect(screen.queryByRole("link", { name: /Raise the cap|Spending limits/u })).toBeNull();
      f.close();
    }
  });

  it("the project switch counts only while the company consent is on: a project switch left on with consent off reads as off (U7)", async () => {
    const f = mount(row(true), { upkeep: upkeepIs({ enabled: true, systemRunsOn: false }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-upkeep-state")).textContent).toContain("Nightly upkeep is off.");
    expect(screen.getByTestId("wiki-setup-upkeep-offer")).toBeTruthy();
    f.close();
  });

  it("not available on this Rovara (the ceiling is off): one muted line and no controls for anyone (U5)", async () => {
    for (const [admin, extra] of [[true, {}], [false, { canEnableSystemRuns: false }], [false, { canManage: false, canEnableSystemRuns: false }], [true, { systemRunsOn: true, enabled: true }]] as const) {
      const f = mount(row(admin), { upkeep: upkeepIs({ available: false, ...extra }) });
      await open();
      expect((await screen.findByTestId("wiki-setup-upkeep-absent")).textContent).toBe("Nightly upkeep isn't available on this Rovara yet.");
      noControls();
      for (const id of ["wiki-setup-upkeep-state", "wiki-setup-upkeep-limits", "wiki-setup-cap", "wiki-setup-cap-ask", "wiki-setup-upkeep-needs-admin", "wiki-setup-upkeep-cap-line"]) expect(screen.queryByTestId(id), id).toBeNull();
      expect(screen.queryByRole("link", { name: /Raise the cap|Spending limits/u })).toBeNull();
      f.close();
    }
  });

  it("a Code with the project switch only (no consent members) keeps the plain switch and offers no choice (U14)", async () => {
    const f = mount(row(true), { upkeep: () => ({ status: 200, body: { enabled: false, canManage: true, available: true } }) });
    await open();
    expect(await screen.findByRole("switch", { name: "Nightly upkeep" })).toBeTruthy();
    expect(screen.queryByTestId("wiki-setup-upkeep-offer")).toBeNull();
    expect(screen.queryByTestId("wiki-setup-upkeep-needs-admin")).toBeNull();
    f.close();
  });
});

function noControlsExceptOffer() {
  expect(screen.queryByRole("switch", { name: "Nightly upkeep" })).toBeNull();
  expect(screen.queryByTestId("wiki-setup-upkeep-confirm")).toBeNull();
  expect(screen.queryByTestId("wiki-setup-upkeep-needs-admin")).toBeNull();
}

describe("in the checklist", () => {
  it("it is one more row, not counted in the progress Code computes, and the other rows are unchanged", async () => {
    const f = mount(h(ProjectChecklist, { project: "web" }));
    const list = await screen.findByTestId("project-checklist");
    await screen.findByTestId("checklist-row-wiki");
    expect(within(list).getAllByRole("listitem").some((item) => item.getAttribute("data-testid") === "checklist-row-wiki")).toBe(true);
    expect(screen.getByTestId("checklist-progress").textContent).toContain("25% done (2 of 8)");
    expect(screen.getByTestId("checklist-row-setupRun")).toBeTruthy();
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("a finished checklist leaves the project page, but the wiki row stays for people who may change the project, and not for others", async () => {
    const done = () => ({ status: 200, body: checklist({ progress: { done: 8, total: 8, percent: 100, nextRequired: null } }) });
    const f = mount(h(ProjectChecklist, { project: "web" }), { status: done });
    await screen.findByTestId("project-wiki-only");
    expect(screen.queryByTestId("project-checklist")).toBeNull();
    expect(screen.getByTestId("checklist-row-wiki")).toBeTruthy();
    f.close();
    const g = mount(h(ProjectChecklist, { project: "web" }), { status: () => ({ status: 200, body: checklist({ viewer: { companyRole: "member", projectAdmin: false, canSkip: false }, progress: { done: 8, total: 8, percent: 100, nextRequired: null } }) }) });
    await waitFor(() => expect(calls(g, "GET", ROOT + "/setup-status")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("checklist-row-wiki")).toBeNull();
    expect(screen.queryByTestId("project-wiki-only")).toBeNull();
    g.close();
    const k = mount(h(ProjectChecklist, { project: "web" }), { status: done, build: () => err(501, "NOT_ON_CODE_YET", WIKI_SETUP_WORDS.notYet) });
    await waitFor(() => expect(calls(k, "GET", ROOT + "/wiki-build")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("project-wiki-only")).toBeNull();
    k.close();
  });

  it("axe finds nothing in the forecast, the report and the controls", async () => {
    for (const body of [build(), built()]) {
      const f = mount(row(), { build: () => ({ status: 200, body }) });
      await open();
      await screen.findByTestId(body["status"] === "none" ? "wiki-setup-forecast" : "wiki-setup-report");
      await expectNoAxeViolations(document.body);
      f.close();
    }
  });
});

describe("small helpers", () => {
  it("rowStateOf: not built is optional, running runs, built is done, a stopped build is 'needs you' only for someone who can continue it", () => {
    expect(rowStateOf({ status: "none", canManage: true })).toBe("optional");
    expect(rowStateOf({ status: "running", canManage: false })).toBe("running");
    expect(rowStateOf({ status: "built", canManage: true })).toBe("done");
    expect(rowStateOf({ status: "stopped", canManage: true, canContinue: true })).toBe("needs_you");
    expect(rowStateOf({ status: "stopped", canManage: false, canContinue: true })).toBe("done");
  });
  it("skippedLine counts and never names; nothing skipped is no line", () => {
    expect(skippedLine([])).toBeUndefined();
    expect(skippedLine([{ name: "x", status: "ok", files: 1, skipped: { generated: 0, vendored: 0, lockfiles: 0, assets: 0, secret: 0 }, skippedFolders: [], pages: { modules: 0, modulesCapped: false } }])).toBeUndefined();
  });
  it("readUpkeepCap: the project's own row, else the company default; anything else is unreadable", () => {
    const body = (upkeep: unknown, upkeepMonthlyUsd: unknown = 25) => ({ defaults: { upkeepMonthlyUsd }, upkeep });
    expect(readUpkeepCap(body([{ id: "web", monthlyUsd: 12.5, version: 3 }, { id: "other", monthlyUsd: 1, version: 1 }]), "web")).toEqual({ usd: 12.5, own: true, version: 3 });
    expect(readUpkeepCap(body([{ id: "other", monthlyUsd: 1, version: 1 }]), "web")).toEqual({ usd: 25, own: false, version: 0 });
    expect(readUpkeepCap(body([], null), "web")).toEqual({ usd: null, own: false, version: 0 });
    for (const bad of [null, {}, body("x"), body([], "25"), body([{ id: "web", monthlyUsd: -1, version: 1 }]), body([{ id: "web", monthlyUsd: 1, version: 0 }]), body([5])]) expect(readUpkeepCap(bad, "web")).toBeUndefined();
  });
  it("parseUsd", () => {
    expect(["5", "$1,200", "12.50", "0"].map(parseUsd)).toEqual([5, 1200, 12.5, 0]);
    expect(["", "-1", "1.234", "1000001", "1e3", "abc"].map(parseUsd)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});

// L4-CAPR: "Nightly upkeep this month: $X of $Y" for people who manage the project (Code's `spend`, passed through Cloud). Each mutant is killed by the named test: U1 the line drawn for a reader (canManage false);
// U2 the cap invented when Code states none ("of $25"); U3 unknown runs not counted in words; U4 dollars drawn as exact when a run's cost is unknown (no "at least"); U5 spend drawn while the page says upkeep is not available.
const THIS_MONTH = new Date().toISOString().slice(0, 7);
describe("nightly upkeep spend line (L4-CAPR)", () => {
  const view = (extra: Record<string, unknown> = {}) => ({ enabled: true, canManage: true, available: true, systemRunsOn: true, canEnableSystemRuns: true, cap: { monthlyUsd: 25, canRaise: true }, spend: { month: THIS_MONTH, spentUsd: 3.5, runs: 4, unknownRuns: 0 }, ...extra });
  it("a manager sees what was spent against the cap, in dollars and no counts when every run's cost is known", async () => {
    const f = mount(row(), { upkeep: () => ({ status: 200, body: view() }) });
    await open();
    const line = await screen.findByTestId("wiki-setup-upkeep-spend");
    expect(line.textContent).toBe("Nightly upkeep this month: $3.50 of $25.00");
    expect(screen.queryByTestId("wiki-setup-upkeep-spend-unknown")).toBeNull();
    f.close();
  });
  it("runs with an unknown cost are counted in words and the dollars are 'at least' (U3, U4); one run reads in the singular", async () => {
    const f = mount(row(), { upkeep: () => ({ status: 200, body: view({ spend: { month: THIS_MONTH, spentUsd: 2, runs: 5, unknownRuns: 2 } }) }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-upkeep-spend")).textContent).toBe("Nightly upkeep this month: at least $2.00 of $25.00 (2 runs with unknown cost)");
    f.close();
    const g = mount(row(), { upkeep: () => ({ status: 200, body: view({ spend: { month: THIS_MONTH, spentUsd: 0, runs: 1, unknownRuns: 1 } }) }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-upkeep-spend")).textContent).toBe("Nightly upkeep this month: at least $0.00 of $25.00 (1 run with unknown cost)");
    g.close();
  });
  it("a cap Code does not state is not made up: only what was spent is shown (U2); a $0 cap is shown as $0", async () => {
    const f = mount(row(), { upkeep: () => ({ status: 200, body: view({ cap: { monthlyUsd: null, canRaise: true } }) }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-upkeep-spend")).textContent).toBe("Nightly upkeep this month: $3.50");
    f.close();
    const g = mount(row(), { upkeep: () => ({ status: 200, body: view({ cap: { monthlyUsd: 0, canRaise: true }, spend: { month: THIS_MONTH, spentUsd: 0, runs: 0, unknownRuns: 0 } }) }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-upkeep-spend")).textContent).toBe("Nightly upkeep this month: $0.00 of $0.00");
    g.close();
  });
  it("no spend from Code, no line; a reader gets none even if the answer carried one (U1); nothing is drawn while upkeep is not available (U5)", async () => {
    const none = mount(row(), { upkeep: () => ({ status: 200, body: view({ spend: undefined }) }) });
    await open(); await screen.findByTestId("wiki-setup-upkeep-state");
    expect(screen.queryByTestId("wiki-setup-upkeep-spend")).toBeNull();
    none.close();
    const reader = mount(row(false), { build: () => ({ status: 200, body: build({ canManage: false, agents: { on: true } }) }), upkeep: () => ({ status: 200, body: view({ canManage: false }) }) });
    await open(); await screen.findByTestId("wiki-setup-upkeep-state");
    expect(screen.queryByTestId("wiki-setup-upkeep-spend")).toBeNull();
    reader.close();
    const off = mount(row(), { upkeep: () => ({ status: 200, body: view({ available: false }) }) });
    await open(); await screen.findByTestId("wiki-setup-upkeep-absent");
    expect(screen.queryByTestId("wiki-setup-upkeep-spend")).toBeNull();
    off.close();
  });
  it("a total for another month is not called 'this month' (not drawn), and under half a cent says so instead of $0.00", async () => {
    const f = mount(row(), { upkeep: () => ({ status: 200, body: view({ spend: { month: "2001-01", spentUsd: 3.5, runs: 4, unknownRuns: 0 } }) }) });
    await open(); await screen.findByTestId("wiki-setup-upkeep-state");
    expect(screen.queryByTestId("wiki-setup-upkeep-spend")).toBeNull();
    f.close();
    const g = mount(row(), { upkeep: () => ({ status: 200, body: view({ spend: { month: THIS_MONTH, spentUsd: 0.002, runs: 1, unknownRuns: 0 } }) }) });
    await open();
    expect((await screen.findByTestId("wiki-setup-upkeep-spend")).textContent).toBe("Nightly upkeep this month: less than $0.01 of $25.00");
    g.close();
  });
  it("a switch change keeps the spend line the answer carries", async () => {
    const f = mount(row(), { upkeep: () => ({ status: 200, body: view({ enabled: false }) }), put: (request) => ({ status: 200, body: view({ enabled: (request.body as { on: boolean }).on }) }) });
    await open();
    fireEvent.click(await screen.findByRole("switch", { name: "Nightly upkeep" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Nightly upkeep" }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByTestId("wiki-setup-upkeep-spend").textContent).toBe("Nightly upkeep this month: $3.50 of $25.00");
    f.close();
  });
});
