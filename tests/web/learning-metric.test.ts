// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { howWeWorkHost } from "./support/how-we-work-fixture.js";
import { projectFixture } from "./support/project-fixture.js";

type Learning = NonNullable<ReturnType<typeof projectFixture>["learning"]>;
const block = (overrides: Partial<Learning> = {}): Learning => ({ thisMonth: { repeats: 3, corrections: 12, enoughData: true }, repeatsAfterRule: [], ...overrides });
/** The project page of a maintainer, whose overview carries `learning` (or none). */
function setup(learning: Learning | undefined, theme: "light" | "dark" = "light") {
 const cell = howWeWorkHost({ handle: request => request.path === "/v1/app/projects/payments/overview" ? { status: 200, body: projectFixture(learning === undefined ? {} : { learning }) } : undefined }), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme });
 return { ...cell, ...ui };
}
const metric = async () => within(await screen.findByRole("region", { name: "Same correction given twice" }));
const read = async (learning: Learning) => { setup(learning);return metric(); };

describe("the Same correction given twice block", () => {
 it("shows this month's share and the counts, with the help line, next to the budget", async () => {
  const f = setup(block());
  const section = await screen.findByRole("region", { name: "Same correction given twice" });
  expect(within(section).getByRole("heading", { name: "Same correction given twice" })).toBeTruthy();
  expect(within(section).getByText("25% this month (3 of 12)")).toBeTruthy();
  expect(within(section).getByText("Lower is better: it means Rovara is learning your team's corrections.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: /^Budget, / }).closest("section")!.parentElement).toBe(section.parentElement);
  expect(within(section).queryByText(/last month/u)).toBeNull();
  expect(within(section).queryByRole("list")).toBeNull();
  expect(f.calls().filter(call => call === "GET /v1/app/projects/payments/how-we-work").length).toBeLessThanOrEqual(1);
 });

 it("rounds the share to a whole number", async () => {
  expect((await read(block({ thisMonth: { repeats: 1, corrections: 3, enoughData: true } }))).getByText("33% this month (1 of 3)")).toBeTruthy();
 });
 it("rounds half up", async () => {
  expect((await read(block({ thisMonth: { repeats: 1, corrections: 8, enoughData: true } }))).getByText("13% this month (1 of 8)")).toBeTruthy();
 });
 it("shows 0% when nothing repeated, and does not divide by zero", async () => {
  expect((await read(block({ thisMonth: { repeats: 0, corrections: 9, enoughData: true } }))).getByText("0% this month (0 of 9)")).toBeTruthy();
 });
 it("guards a zero-correction count that claims to have enough data", async () => {
  const section = await read(block({ thisMonth: { repeats: 0, corrections: 0, enoughData: true } }));
  expect(section.getByText("0% this month (0 of 0)")).toBeTruthy();
 });

 it("says it fell compared with last month", async () => {
  expect((await read(block({ lastMonthShare: 0.4 }))).getByText("down from 40% last month")).toBeTruthy();
 });
 it("says it rose compared with last month", async () => {
  expect((await read(block({ lastMonthShare: 0.1 }))).getByText("up from 10% last month")).toBeTruthy();
 });
 it("says it is the same when the two shares are equal after rounding", async () => {
  const section = await read(block({ lastMonthShare: 0.246 }));
  expect(section.getByText("same as last month")).toBeTruthy();
  expect(section.queryByText(/from 25%/u)).toBeNull();
 });
 it("compares the rounded shares, not the raw ones", async () => {
  expect((await read(block({ thisMonth: { repeats: 1, corrections: 3, enoughData: true }, lastMonthShare: 0.5 }))).getByText("down from 50% last month")).toBeTruthy();
 });

 it("says there are not enough corrections yet, with the count, and no percent", async () => {
  const section = await read(block({ thisMonth: { repeats: 1, corrections: 4, enoughData: false }, lastMonthShare: 0.5 }));
  expect(section.getByText("Not enough corrections yet")).toBeTruthy();
  expect(section.getByText("(4 so far this month)")).toBeTruthy();
  expect(section.queryByText(/%/u)).toBeNull();
 });

 it("lists the repeats that came after a rule, each linking to How we work, by the step's own name", async () => {
  const section = await read(block({ repeatsAfterRule: [{ ruleId: "rul_1", stage: "build", repeats: 2 }, { ruleId: "rul_2", stage: "plan", repeats: 1 }] }));
  expect(await section.findByText("3 repeats came after a rule was accepted")).toBeTruthy();
  const items = await section.findAllByRole("listitem");
  expect(items.map(item => item.textContent)).toEqual(["Build rule: 2 repeats", "Plan rule: 1 repeat"]);
  for (const item of items) expect(within(item).getByRole("link").getAttribute("href")).toBe("/app/projects/payments?tab=how-we-work");
  expect(section.queryByText(/rul_1|rul_2/u)).toBeNull();
 });
 it("says 1 repeat in the singular", async () => {
  expect(await (await read(block({ repeatsAfterRule: [{ ruleId: "rul_1", stage: "build", repeats: 1 }] }))).findByText("1 repeat came after a rule was accepted")).toBeTruthy();
 });
 it("names the project-wide stage in words", async () => {
  const items = await (await read(block({ repeatsAfterRule: [{ ruleId: "rul_1", stage: "*", repeats: 2 }] }))).findAllByRole("listitem");
  expect(items[0]!.textContent).toBe("Project-wide rule: 2 repeats");
 });
 it("shows a stage it does not know as its id", async () => {
  const items = await (await read(block({ repeatsAfterRule: [{ ruleId: "rul_1", stage: "future-stage", repeats: 2 }] }))).findAllByRole("listitem");
  expect(items[0]!.textContent).toBe("future-stage rule: 2 repeats");
 });
 it("says at least the sum when the server stopped reading corrections at its cap, and never shows the label's number as a count", async () => {
  const section = await read(block({ repeatsAfterRuleLabel: "500+", repeatsAfterRule: [{ ruleId: "rul_1", stage: "build", repeats: 3 }, { ruleId: "rul_2", stage: "plan", repeats: 2 }] }));
  expect(await section.findByText("At least 5 repeats came after a rule was accepted")).toBeTruthy();
  expect((await section.findAllByRole("listitem")).map(item => item.textContent)).toEqual(["Build rule: at least 3 repeats", "Plan rule: at least 2 repeats"]);
  expect(section.queryByText(/500/u)).toBeNull();
 });
 it("says at least 1 repeat in the singular when capped", async () => {
  expect(await (await read(block({ repeatsAfterRuleLabel: "500+", repeatsAfterRule: [{ ruleId: "rul_1", stage: "build", repeats: 1 }] }))).findByText("At least 1 repeat came after a rule was accepted")).toBeTruthy();
 });
 it("computes the share without floating-point drift (57 of 200 is 29%)", async () => {
  expect((await read(block({ thisMonth: { repeats: 57, corrections: 200, enoughData: true } }))).getByText("29% this month (57 of 200)")).toBeTruthy();
 });
 it("gives the direction in words, not only an arrow", async () => {
  const section = await read(block({ lastMonthShare: 0.4 }));
  expect(section.getByText("down from 40% last month").closest("span")!.textContent).toContain("down from");
  expect(section.getByText("↓").getAttribute("aria-hidden")).toBe("true");
 });

 it("shows nothing when the overview has no learning block", async () => {
  const f = setup(undefined);
  await screen.findByRole("heading", { name: /^Budget, / });
  expect(screen.queryByText("Same correction given twice")).toBeNull();
  expect(f.calls()).not.toContain("GET /v1/app/projects/payments/how-we-work");
 });

 for (const theme of ["light", "dark"] as const) it("has no accessibility violations in " + theme, async () => {
  const f = setup(block({ lastMonthShare: 0.4, repeatsAfterRule: [{ ruleId: "rul_1", stage: "build", repeats: 2 }] }), theme);
  await screen.findByRole("region", { name: "Same correction given twice" });await expectNoAxeViolations(f.container);
 });
});

describe("while the company's suggestions are off", () => {
 const LINE = "Suggestions are off for your company. Repeats are still counted, but no rules are suggested until they're turned on.";
 it("keeps the metric and adds one line when collecting", async () => {
  const section = await read(block({ suggestions: { state: "collecting", corrections: 7 } }));
  expect(section.getByText("25% this month (3 of 12)")).toBeTruthy();
  expect(section.getByText("Lower is better: it means Rovara is learning your team's corrections.")).toBeTruthy();
  expect(section.getAllByText(LINE)).toHaveLength(1);
 });
 it("shows the line with the not-enough-data wording too", async () => {
  const section = await read(block({ thisMonth: { repeats: 0, corrections: 2, enoughData: false }, suggestions: { state: "collecting", corrections: 2 } }));
  expect(section.getByText("Not enough corrections yet")).toBeTruthy();
  expect(section.getByText(LINE)).toBeTruthy();
 });
 it("has no such line when on, or when the field is missing", async () => {
  expect((await read(block({ suggestions: { state: "on" } }))).queryByText(LINE)).toBeNull();
  cleanup();
  expect((await read(block())).queryByText(LINE)).toBeNull();
 });
 for (const theme of ["light", "dark"] as const) it("has no accessibility violations in " + theme, async () => {
  const f = setup(block({ suggestions: { state: "collecting", corrections: 7 } }), theme);
  await screen.findByRole("region", { name: "Same correction given twice" });await expectNoAxeViolations(f.container);
 });
});

describe("last month's share rounds like this month's", () => {
  it("reads an exact half the same way on both sides (57 of 200 in both months is 'same')", async () => {
    const { lastMonthChange } = await import("../../packages/ui/src/screens/project/learning-text.js");
    expect(lastMonthChange(29, 0.285).arrow).toBeUndefined();
  });
});
