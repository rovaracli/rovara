// @vitest-environment jsdom
// The project page's Spending tab (switch `rovara.spending` = "v2"): a maintainer sees that project's spent, held and left from GET /v1/app/projects/{p}/spend, totals only. Off, or without the server's `canViewSpend`,
// there is no tab and no read. The formulas are the company Spending page's own: held = max(0, committed - spent); left = max(0, limit - committed), only when the read gives a limit.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { SPENDING_STORAGE_KEY } from "../../packages/ui/src/screens/admin/spending-flags.js";
import { ProjectSpendReaderSchema, projectSpendPath } from "../../packages/ui/src/api/spending.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { projectFixture } from "./support/project-fixture.js";

type Answer = { status: number; body: unknown };
const month = "2026-11", ok = (figures: Record<string, unknown>): Answer => ({ status: 200, body: { month, project: "payments", requestId: "gateway", ...figures } });
function setup(options: { on?: boolean; canViewSpend?: boolean; spend?: Answer; path?: string } = {}) {
 const base = projectFixture(), overview = options.canViewSpend === false ? projectFixture({ you: { ...base.you, canViewSpend: false }, budget: undefined } as never) : base;
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
  if (request.path.endsWith("/start-preview")) return { status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", kind: "disabled" } };
  if (request.path === "/v1/app/projects/payments/spend") return options.spend ?? ok({ spentUsd: 150, committedUsd: 180, limitUsd: 500 });
  return request.method === "GET" ? { status: 200, body: overview } : { status: 202, body: {} };
 });
 if (options.on !== false) f.storage.set(SPENDING_STORAGE_KEY, "v2");
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.path ?? "/app/projects/payments"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }));
 const spendReads = () => f.request.mock.calls.filter(([request]) => request.path.includes("/spend")).length;
 return { ...f, ...ui, spendReads, close() { ui.unmount();query.clear(); } };
}
const figure = (name: string) => screen.getByText(name).nextElementSibling!.textContent;
const openTab = async () => { fireEvent.mouseDown(await screen.findByRole("tab", { name: "Spending" }), { button: 0 });fireEvent.click(screen.getByRole("tab", { name: "Spending" })); };

it("switch off: no Spending tab, no read, and ?tab=spending is the overview as before", async () => {
 const f = setup({ on: false, path: "/app/projects/payments?tab=spending" });
 await screen.findByRole("heading", { name: "payments" });
 expect(screen.queryByRole("tab", { name: "Spending" })).toBeNull();
 expect(screen.getByRole("tab", { name: "Overview", selected: true })).toBeTruthy();
 expect(f.spendReads()).toBe(0);
 f.close();
});
it("switch on but the server does not let this person see the spend: no tab and no read", async () => {
 const f = setup({ canViewSpend: false, path: "/app/projects/payments?tab=spending" });
 await screen.findByRole("heading", { name: "payments" });
 expect(screen.queryByRole("tab", { name: "Spending" })).toBeNull();expect(screen.getByRole("tab", { name: "Overview", selected: true })).toBeTruthy();
 expect(f.spendReads()).toBe(0);
 f.close();
});
it("shows spent, held and left from the project's own read, and reads nothing until the tab is open", async () => {
 const f = setup();
 await screen.findByRole("heading", { name: "payments" });
 expect(f.spendReads()).toBe(0);
 await openTab();
 expect(await screen.findByRole("heading", { name: "Spending, November 2026" })).toBeTruthy();
 expect(figure("Spent")).toBe("$150.00");expect(figure("Held for work in progress")).toBe("$30.00");expect(figure("Left")).toBe("$320.00");
 expect(f.request.mock.calls.some(([request]) => request.path === projectSpendPath("payments") && request.method === "GET")).toBe(true);
 expect(screen.queryByRole("columnheader", { name: "Person" })).toBeNull();expect(screen.queryByText(/by person/i)).toBeNull();
 f.close();
});
it("left is measured from committed (which already holds the spend), never below zero; held never below zero", async () => {
 let f = setup({ spend: ok({ spentUsd: 200, committedUsd: 250, limitUsd: 500 }), path: "/app/projects/payments?tab=spending" });
 await screen.findByRole("heading", { name: "Spending, November 2026" });
 expect(figure("Held for work in progress")).toBe("$50.00");expect(figure("Left")).toBe("$250.00");f.close();
 f = setup({ spend: ok({ spentUsd: 480, committedUsd: 540, limitUsd: 500 }), path: "/app/projects/payments?tab=spending" });
 await screen.findByRole("heading", { name: "Spending, November 2026" });
 expect(figure("Left")).toBe("$0.00");expect(screen.getByRole("status").textContent).toContain("past this project's allowance");f.close();
 f = setup({ spend: ok({ spentUsd: 10, committedUsd: 4 }), path: "/app/projects/payments?tab=spending" });
 await screen.findByRole("heading", { name: "Spending, November 2026" });
 expect(figure("Held for work in progress")).toBe("$0.00");f.close();
});
it("with no limit in the read it says so and shows no Left amount", async () => {
 const f = setup({ spend: ok({ spentUsd: 12.5, committedUsd: 13.5 }), path: "/app/projects/payments?tab=spending" });
 await screen.findByRole("heading", { name: "Spending, November 2026" });
 expect(figure("Left")).toBe("No limit set");expect(screen.getByText(/No allowance is set for this project/)).toBeTruthy();
 f.close();
});
for (const status of [403, 404]) it(`a ${String(status)} gives one plain sentence and no amounts`, async () => {
 const f = setup({ spend: { status, body: { error: { code: status === 403 ? "FORBIDDEN" : "NOT_FOUND", message: "Only a maintainer of payments can see its spend." } } }, path: "/app/projects/payments?tab=spending" });
 expect(await screen.findByText("You can't see this project's spending. It is shown to the project's maintainers.")).toBeTruthy();
 expect(screen.queryByText("Spent")).toBeNull();expect(screen.queryByRole("alert")).toBeNull();
 f.close();
});
it("an answer about another project, or a figure that is not a number, is refused rather than shown", async () => {
 let f = setup({ spend: { status: 200, body: { month, project: "checkout", spentUsd: 1, committedUsd: 1 } }, path: "/app/projects/payments?tab=spending" });
 expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load this project's spending. No amounts are shown.");expect(screen.queryByText("Spent")).toBeNull();f.close();
 f = setup({ spend: ok({ spentUsd: "12", committedUsd: 13 }), path: "/app/projects/payments?tab=spending" });
 await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());expect(screen.queryByText("Spent")).toBeNull();f.close();
 expect(ProjectSpendReaderSchema.safeParse({ month, project: "p", spentUsd: -1, committedUsd: 0 }).success).toBe(false);
});
