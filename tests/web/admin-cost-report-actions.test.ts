// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the tests read and break Cloud's JSON answers at a path */
// The Cost and time actions (lane L4-CR4): New feature, Rename, Merge into, Mark done or reopen, and Move to feature. Each asks for a confirm, sends one change that Cloud passes to Rovara Code, shows
// a refusal in Cloud's fixed words and reads again. A button is drawn only where Cloud said the person may change features and there is something it can do.
import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { readCostReport, readFeatureDetail } from "../../packages/ui/src/api/admin-report.js";
import { nameProblem } from "../../packages/ui/src/screens/admin/report/ReportActions.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const DAY = 86_400_000;
const FT = (letter: string) => `ft_${letter.repeat(20)}`;
const F1 = FT("1"), F2 = FT("2"), FDONE = FT("d");
const page = (n: number) => `/review/00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}/task`;
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const fail = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
const nums = { tasks: 2, prsOpened: 2, prsMerged: 1, costCents: 10_000, unpricedCalls: 0, costIsFloor: false, costPerMergedCents: 10_000, endToEndMs: 5 * DAY, endToEndSoFar: false, medianRequestToPrMs: 2 * DAY };
const PICK = [{ id: F1, name: "Checkout v2", state: "open" }, { id: F2, name: "Search", state: "open" }, { id: FDONE, name: "Old work", state: "done" }];
const report = (over: Record<string, unknown> = {}) => ({
  range: {}, asOf: "2026-11-17T12:00:00.000Z", totals: nums, projects: ["web"], canChange: true, features: PICK,
  byFeature: [{ key: F1, name: "Checkout v2", state: "open", ...nums }, { key: "none", name: "No feature", ...nums }], byProject: [{ key: "web", name: "web", ...nums }], ...over,
});
const task = (n: number, over: Record<string, unknown> = {}) => ({
  taskId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, title: `Task ${String(n)}`, project: "web", origin: "web", state: "merged", startedAt: "2026-11-10T00:00:00.000Z", costCents: 5_000, unpricedCalls: 0,
  prsOpened: 1, prsMerged: 1, prLinks: [], wallMs: DAY, ...over,
});
const detail = (id: string, over: Record<string, unknown> = {}) => ({
  feature: id === "none" ? { id: "none", name: "No feature", none: true } : { id, name: PICK.find(f => f.id === id)?.name ?? "Checkout v2", state: PICK.find(f => f.id === id)?.state ?? "open", none: false },
  range: {}, asOf: "2026-11-17T12:00:00.000Z", totals: nums, sources: [{ source: "chosen", count: 2 }], tasksTotal: 2, canChange: true, features: PICK, tasks: [task(1, { taskPage: page(1) }), task(2)], ...over,
});

function mount(path: string, respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>) {
  const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
  const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : respond(r)));
  const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  return { ...f, ...view, router, query, close: () => { view.unmount(); router.dispose(); query.clear(); cleanup(); } };
}
const posts = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method === "POST");
const gets = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method === "GET" && r.path.startsWith("/v1/app/org/report"));
/** A server: the report and the feature's page as given, and the answer to each POST from `post`. */
const server = (body: unknown, post: (r: ApiRequest) => ApiResponse = () => ok({ feature: { id: F1, name: "x", state: "open" } })) => (r: ApiRequest): ApiResponse => (r.method === "POST" ? post(r) : r.path.startsWith("/v1/app/org/report") ? ok(body) : ok({}));
const dialog = () => screen.getByRole("dialog");
const type = (label: string, value: string) => fireEvent.change(within(dialog()).getByLabelText(label), { target: { value } });
const press = (name: string | RegExp, scope: HTMLElement = document.body) => fireEvent.click(within(scope).getByRole("button", { name }));

describe("the readers", () => {
  it("read whether the person may change features (absent is no), the picker's features (a bad one is left out) and a task's page reference", () => {
    const base = report() as any;
    expect(readCostReport.parse(base)).toMatchObject({ canChange: true, features: PICK });
    const old = { ...base }; delete old.canChange; delete old.features;
    expect(readCostReport.parse(old)).toMatchObject({ canChange: false, features: [] });
    expect(readCostReport.parse({ ...base, canChange: "yes" }).canChange).toBe(false);
    expect(readCostReport.parse({ ...base, features: [{ id: "none", name: "x" }, { id: F1, name: "" }, { id: F2, name: "Ok", state: "weird" }, "x", { id: F1, name: "Fine", state: "open" }] }).features).toEqual([{ id: F2, name: "Ok" }, { id: F1, name: "Fine", state: "open" }]);
    const d = detail(F1) as any;
    expect(readFeatureDetail.parse(d).tasks.map(t => t.taskPage)).toEqual([page(1), undefined]);
    // only exactly this task's own page counts: another task's page, an address, a script, an api path, a query and a session are dropped
    for (const bad of [page(2), `https://evil.example${page(1)}`, `//evil.example${page(1)}`, "javascript:alert(1)", `${page(1)}/api/state`, `${page(1)}?next=//evil`, `${page(1)}#x`, "/s/ses_aaaaaaaaaaaaaaaaaaaa", "", 7]) {
      d.tasks[0].taskPage = bad;
      expect(readFeatureDetail.parse(d).tasks[0]!.taskPage, String(bad)).toBeUndefined();
    }
    d.tasks[0].sessionId = "ses_aaaaaaaaaaaaaaaaaaaa";
    expect(readFeatureDetail.parse(d).tasks[0]).not.toHaveProperty("sessionId");
  });
  it("checks a feature name the way Code does: one line, 80 characters", () => {
    expect(nameProblem("Checkout v2")).toBeUndefined();
    expect(nameProblem("   ")).toBeTruthy();
    expect(nameProblem("é".repeat(80))).toBeUndefined();
    expect(nameProblem("é".repeat(81))).toBeTruthy();
    expect(nameProblem("a\nb")).toBeTruthy();
    expect(nameProblem("a‮b")).toBeTruthy();
  });
});

describe("no action without Cloud's say-so", () => {
  it("draws none on either page when Cloud does not say the person may change features", async () => {
    const f = mount("/app/admin/money/report", server(report({ canChange: false })));
    try {
      await screen.findByRole("table", { name: "Cost and time by feature" });
      expect(screen.queryByRole("button", { name: "New feature" })).toBeNull();
    } finally { f.close(); }
    const g = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1, { canChange: false })));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      for (const name of [/Rename/u, /Merge into/u, /Mark done|Reopen/u, /Move/u]) expect(screen.queryByRole("button", { name })).toBeNull();
      expect(screen.queryByRole("columnheader", { name: "Move" })).toBeNull();
    } finally { g.close(); }
  });
  it("draws Rename, Merge into and Mark done on a feature and not on the No feature page; Move shows in both", async () => {
    const f = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1)));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      for (const name of ["Rename", "Merge into", "Mark done"]) expect(screen.getByRole("button", { name })).toBeTruthy();
      expect(screen.getAllByRole("button", { name: /^Move Task/u })).toHaveLength(2);
    } finally { f.close(); }
    const g = mount("/app/admin/money/report/features/none", server(detail("none")));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      for (const name of [/^Rename$/u, /^Merge into$/u, /^Mark done$/u, /^Reopen$/u]) expect(screen.queryByRole("button", { name })).toBeNull();
      expect(screen.getAllByRole("button", { name: /^Move Task/u })).toHaveLength(2);
    } finally { g.close(); }
  });
  it("draws no button that has nothing to do: no Merge into with no other feature, no Move with no place to go, no state button when Code gives no state, Reopen on a done feature", async () => {
    const only = [{ id: F1, name: "Checkout v2", state: "open" }];
    const f = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1, { features: only })));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      expect(screen.queryByRole("button", { name: "Merge into" })).toBeNull();
      // The task is in Checkout v2 and the only other choice is "No feature", so Move is there.
      expect(screen.getAllByRole("button", { name: /^Move Task/u })).toHaveLength(2);
    } finally { f.close(); }
    const g = mount("/app/admin/money/report/features/none", server(detail("none", { features: [{ id: FDONE, name: "Old work", state: "done" }] })));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      expect(screen.queryByRole("button", { name: /^Move Task/u })).toBeNull();
    } finally { g.close(); }
    const k = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1, { feature: { id: F1, name: "Checkout v2", none: false } })));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      expect(screen.queryByRole("button", { name: /Mark done|Reopen/u })).toBeNull();
    } finally { k.close(); }
    const d = mount(`/app/admin/money/report/features/${FDONE}`, server(detail(FDONE)));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    } finally { d.close(); }
  });
});

describe("New feature", () => {
  it("asks for a name, sends exactly it once, and opens the new feature's page", async () => {
    const f = mount("/app/admin/money/report", server(report(), () => ok({ feature: { id: FT("9"), name: "Billing v3", state: "open" } })));
    try {
      await screen.findByRole("table", { name: "Cost and time by feature" });
      press("New feature");
      const confirm = within(dialog()).getByRole("button", { name: "Make feature" });
      expect(confirm).toHaveProperty("disabled", true);
      type("Feature name", "  Billing v3 ");
      // Pressing twice, and submitting the form twice (Enter), sends one change: the second is ignored while the first is out.
      fireEvent.click(confirm); fireEvent.click(confirm);
      const form = dialog().querySelector("form")!;
      fireEvent.submit(form); fireEvent.submit(form);
      await waitFor(() => expect(f.router.state.location.pathname).toBe(`/app/admin/money/report/features/${FT("9")}`));
      expect(posts(f)).toHaveLength(1);
      expect(posts(f)[0]).toMatchObject({ method: "POST", path: "/v1/app/org/report/features", body: { name: "Billing v3" } });
    } finally { f.close(); }
  });
  it("keeps the confirm open with Cloud's fixed words when Code refuses, and reads the report again", async () => {
    const f = mount("/app/admin/money/report", server(report(), () => fail(400, "CONFIG_INVALID", "A feature with that name already exists.")));
    try {
      await screen.findByRole("table", { name: "Cost and time by feature" });
      const before = gets(f).length;
      press("New feature"); type("Feature name", "Search");
      press("Make feature", dialog());
      expect((await screen.findByTestId("report-action-error")).textContent).toBe("A feature with that name already exists.");
      expect(screen.getByRole("dialog")).toBeTruthy();
      await waitFor(() => expect(gets(f).length).toBeGreaterThan(before));
      expect(f.router.state.location.pathname).toBe("/app/admin/money/report");
      // Pressing again sends again (the first send ended).
      press("Make feature", dialog());
      await waitFor(() => expect(posts(f)).toHaveLength(2));
    } finally { f.close(); }
  });
  it("says an answer it cannot read in the app's own fixed words", async () => {
    const f = mount("/app/admin/money/report", server(report(), () => ({ status: 200, body: { feature: "nope" } })));
    try {
      await screen.findByRole("table", { name: "Cost and time by feature" });
      press("New feature"); type("Feature name", "Billing");
      press("Make feature", dialog());
      expect((await screen.findByTestId("report-action-error")).textContent).toContain("unreadable response");
    } finally { f.close(); }
  });
});

describe("Rename, Merge into and Mark done", () => {
  it("renames: the confirm waits for a new name, sends it and reads the page again", async () => {
    const f = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1), () => ok({ feature: { id: F1, name: "Checkout v3", state: "open" } })));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      const before = gets(f).length;
      press("Rename");
      const confirm = within(dialog()).getByRole("button", { name: "Rename" });
      expect(confirm).toHaveProperty("disabled", true);
      type("Feature name", "Checkout v3");
      fireEvent.click(confirm);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(posts(f)).toEqual([expect.objectContaining({ path: `/v1/app/org/report/features/${F1}/rename`, body: { name: "Checkout v3" } })]);
      expect(gets(f).length).toBeGreaterThan(before);
    } finally { f.close(); }
  });
  it("puts the form back when the confirm is closed without sending", async () => {
    const f = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1)));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      press("Rename"); type("Feature name", "Half typed");
      fireEvent.keyDown(dialog(), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      press("Rename");
      expect((within(dialog()).getByLabelText<HTMLInputElement>("Feature name")).value).toBe("Checkout v2");
      expect(posts(f)).toHaveLength(0);
    } finally { f.close(); }
  });
  it("shows the new name, not the old one, when Rename is opened again after a rename", async () => {
    let name = "Checkout v2";
    const f = mount(`/app/admin/money/report/features/${F1}`, (r) => {
      if (r.method === "POST") { name = (r.body as { name: string }).name; return ok({ feature: { id: F1, name, state: "open" } }); }
      return r.path.startsWith("/v1/app/org/report") ? ok(detail(F1, { feature: { id: F1, name, state: "open", none: false } })) : ok({});
    });
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      press("Rename"); type("Feature name", "Checkout v3"); press("Rename", dialog());
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await screen.findByRole("heading", { name: "Checkout v3" });
      press("Rename");
      expect(within(dialog()).getByLabelText<HTMLInputElement>("Feature name").value).toBe("Checkout v3");
    } finally { f.close(); }
  });
  it("merges: asks which feature, says it cannot be undone, sends the choice and opens the feature it went into", async () => {
    const f = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1), () => ok({ feature: { id: F2, name: "Search", state: "open" } })));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      press("Merge into");
      expect(dialog().textContent).toContain("can't be brought back");
      const options = within(within(dialog()).getByLabelText("Merge into")).getAllByRole("option").map(o => o.textContent);
      expect(options).toEqual(["Choose a feature", "Search", "Old work (done)"]);
      const confirm = within(dialog()).getByRole("button", { name: "Merge" });
      expect(confirm).toHaveProperty("disabled", true);
      fireEvent.change(within(dialog()).getByLabelText("Merge into"), { target: { value: F2 } });
      fireEvent.click(confirm);
      await waitFor(() => expect(f.router.state.location.pathname).toBe(`/app/admin/money/report/features/${F2}`));
      expect(posts(f)).toEqual([expect.objectContaining({ path: `/v1/app/org/report/features/${F1}/merge`, body: { into: F2 } })]);
    } finally { f.close(); }
  });
  it("marks done and reopens with one sentence of what changes", async () => {
    const f = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1), () => ok({ feature: { id: F1, name: "Checkout v2", state: "done" } })));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      press("Mark done");
      expect(dialog().textContent).toContain("takes no new tasks until you reopen it");
      press("Mark done", dialog());
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(posts(f)).toEqual([expect.objectContaining({ path: `/v1/app/org/report/features/${F1}/state`, body: { state: "done" } })]);
    } finally { f.close(); }
    const g = mount(`/app/admin/money/report/features/${FDONE}`, server(detail(FDONE), () => ok({ feature: { id: FDONE, name: "Old work", state: "open" } })));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      press("Reopen"); press("Reopen", dialog());
      await waitFor(() => expect(posts(g)).toEqual([expect.objectContaining({ body: { state: "open" } })]));
    } finally { g.close(); }
  });
  it("shows Cloud's fixed words for a refused change and keeps the page honest by reading again", async () => {
    const f = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1), () => fail(404, "NOT_FOUND", "That feature doesn't exist, or you can't see it.")));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      press("Mark done"); press("Mark done", dialog());
      expect((await screen.findByTestId("report-action-error")).textContent).toBe("That feature doesn't exist, or you can't see it.");
    } finally { f.close(); }
  });
});

describe("Move to feature", () => {
  it("offers the features that take tasks (not done, not this one) and No feature, and sends the choice", async () => {
    const f = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1), (r) => ok({ task: { taskId: (r.body as any).feature === null ? "x" : "00000000-0000-4000-8000-000000000001", feature: { id: F2 } } })));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      fireEvent.click(screen.getByRole("button", { name: "Move Task 1 to a feature" })); // the first row
      const options = within(within(dialog()).getByLabelText("Move to feature")).getAllByRole("option").map(o => o.textContent);
      expect(options).toEqual(["Choose a feature", "Search", "No feature"]);
      expect(dialog().textContent).toContain("Task 1");
      const confirm = within(dialog()).getByRole("button", { name: "Move task" });
      expect(confirm).toHaveProperty("disabled", true);
      fireEvent.change(within(dialog()).getByLabelText("Move to feature"), { target: { value: F2 } });
      fireEvent.click(confirm);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(posts(f)).toEqual([expect.objectContaining({ method: "POST", path: "/v1/app/tasks/00000000-0000-4000-8000-000000000001/feature", body: { feature: F2 } })]);
    } finally { f.close(); }
  });
  it("sends null for No feature, and the No feature page does not offer No feature", async () => {
    const f = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1), () => ok({ task: { taskId: "00000000-0000-4000-8000-000000000002", feature: null } })));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      fireEvent.click(screen.getByRole("button", { name: "Move Task 2 to a feature" }));
      fireEvent.change(within(dialog()).getByLabelText("Move to feature"), { target: { value: "__none__" } });
      press("Move task", dialog());
      await waitFor(() => expect(posts(f)).toEqual([expect.objectContaining({ path: "/v1/app/tasks/00000000-0000-4000-8000-000000000002/feature", body: { feature: null } })]));
    } finally { f.close(); }
    const g = mount("/app/admin/money/report/features/none", server(detail("none")));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      fireEvent.click(screen.getByRole("button", { name: "Move Task 1 to a feature" }));
      expect(within(within(dialog()).getByLabelText("Move to feature")).getAllByRole("option").map(o => o.textContent)).toEqual(["Choose a feature", "Checkout v2", "Search"]);
    } finally { g.close(); }
  });
  it("words Code's maintainer refusal as Cloud sent it", async () => {
    const f = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1), () => fail(403, "FORBIDDEN", "Only a project maintainer, owner or admin can move a task that already has a feature.")));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      fireEvent.click(screen.getByRole("button", { name: "Move Task 1 to a feature" })); fireEvent.change(within(dialog()).getByLabelText("Move to feature"), { target: { value: F2 } });
      press("Move task", dialog());
      expect((await screen.findByTestId("report-action-error")).textContent).toContain("Only a project maintainer, owner or admin");
    } finally { f.close(); }
  });
});

describe("task titles", () => {
  it("link to the task page only where Code gave a reference; a title with none is plain text", async () => {
    const f = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1)));
    try {
      const table = await screen.findByRole("table", { name: "Tasks in this feature" });
      expect(within(table).getByRole("link", { name: "Task 1" }).getAttribute("href")).toBe(page(1));
      expect(within(table).queryByRole("link", { name: "Task 2" })).toBeNull();
      expect(within(table).getByText("Task 2")).toBeTruthy();
    } finally { f.close(); }
  });
});

describe("accessibility", () => {
  it("has no violations with a confirm open", async () => {
    const f = mount(`/app/admin/money/report/features/${F1}`, server(detail(F1)));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      press("Merge into");
      await expectNoAxeViolations(document.body);
    } finally { f.close(); }
  });
});
