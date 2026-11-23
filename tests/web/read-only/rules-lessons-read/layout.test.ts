// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { mount } from "./mount.js";
import { bodies, responder } from "./fixtures.js";

const pages = [["/app/admin/how-we-work", "Rules", ["Company"]], ["/app/admin/how-we-work/recipes", "Setup recipes", ["Company"]]] as const;
const views = [["/app/projects/payments?tab=how-we-work", "Rules for every task in this project", "Rules"], ["/app/projects/payments?tab=lessons", "This week", "Learned"], ["/app/projects/payments?tab=how-we-work&view=models", "The model each stage uses", "Models by stage"], ["/app/projects/payments?tab=how-we-work&view=history", "1 version", "History"]] as const;
describe("G4 layouts on the shared design system", () => {
 for (const [path, heading, pill] of views) {
  it("fills the host's How we work tab with the board's view and no page title of its own: " + path, async () => {
   const view = mount(path);
   expect(await screen.findByRole("heading", { level: 2, name: heading })).toBeTruthy();
   expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
   expect(screen.getByRole("link", { name: pill }).getAttribute("aria-current")).toBe("page");
   expect(view.container.querySelectorAll(".g4-pills [aria-current=page]")).toHaveLength(1);
  });
 }
 for (const [path, title, crumbs] of pages) {
  it("uses the shared page header with a plain current crumb: " + path, async () => {
   const view = mount(path);
   expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
   const trail = within(view.container.querySelector(".rv-page-header")!.querySelector("nav")!);
   expect(trail.getAllByRole("listitem").map(item => item.textContent)).toEqual([...crumbs]);
   expect(view.container.querySelectorAll(".rv-page-breadcrumbs a")).toHaveLength(0);
   expect(view.container.querySelector(".rv-page-breadcrumbs [aria-current=page]")?.textContent).toBe(crumbs[crumbs.length - 1]);
  });
 }
 it("puts the served rule versions in a rail next to the rules, newest first, with no compare or roll back", async () => {
  const data = bodies();
  data.history.versions.push({ version: 1, publishedBy: "Ana", publishedAt: "2026-10-21T14:05:00Z", note: "First rules" });
  const view = mount(undefined, responder(data));
  const rail = await screen.findByRole("region", { name: "What changed, and when" });
  expect(rail.classList.contains("g4-rail")).toBe(true);
  expect((await within(rail).findAllByRole("heading", { level: 3 })).map(h => h.textContent)).toEqual(["Version 2 · live", "Version 1"]);
  expect(within(rail).getByText(/Priya · Keep changes small/)).toBeTruthy();
  expect(view.container.querySelectorAll(".g4-rail button")).toHaveLength(0);
  expect([...view.container.querySelectorAll(".g4-rail a")].map(a => a.textContent)).toEqual(["See all 2 versions"]);
  expect(view.container.textContent).not.toMatch(/Compare|Roll back|Edit rules/);
 });
 it("shows the stage models in the shared table with where each model comes from", async () => {
  const view = mount("/app/projects/payments?tab=how-we-work&view=models");
  const table = await screen.findByRole("table", { name: "Stage models" });
  expect(within(table).getAllByText("Opus 5.5").length).toBeGreaterThan(0);
  expect(view.container.textContent).not.toContain("anthropic/");
  expect(within(table).getAllByRole("columnheader").map(c => c.textContent)).toEqual(["Stage", "Model in force", "Comes from"]);
  expect(within(table).getAllByText("Rovara default").length).toBeGreaterThan(0);
  expect(within(table).getByText("No model for this step.")).toBeTruthy();
  expect(view.container.querySelectorAll("table button,table input,table form")).toHaveLength(0);
 });
 it("keeps unsupported process facts to one quiet line each", async () => {
  const view = mount();
  await screen.findByRole("heading", { name: "Instructions from the repo" });
  const held = [...view.container.querySelectorAll(".g4-held")].map(node => node.textContent);
  expect(held).toContain("We can’t tell yet which instruction files or skills were found in this repo.");
  expect(held).toContain("We can’t tell yet. This read does not report the setting for new tasks.");
  expect(view.container.querySelectorAll(".g4-held button,.g4-held a")).toHaveLength(0);
 });
 it("counts the recipes in the header meta and lists each recipe's served contents", async () => {
  const view = mount("/app/admin/how-we-work/recipes");
  expect(await screen.findByText("1 recipe")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open Node service" })).toBeTruthy();
  const specs = within(view.container.querySelector(".g4-specs")!);
  expect(specs.getByRole("heading", { name: "Setup commands" })).toBeTruthy();
  expect(specs.getByText("npm ci")).toBeTruthy();
 });
 it("draws a failed read as the 4e error block with one way to try again and no cached facts", async () => {
  const view = mount(undefined, async () => ({ status: 400, body: {} }));
  const alert = await screen.findByRole("alert");
  expect(alert.classList.contains("g4-error")).toBe(true);
  expect(within(alert).getByRole("heading", { level: 2 }).textContent).toBe("Rovara couldn\u2019t read this page");
  expect(within(alert).getAllByRole("term").map(t => t.textContent)).toEqual(["What happened", "What is safe", "What to do"]);
  expect(within(alert).getAllByRole("button").map(b => b.textContent)).toEqual(["Load again", "Copy"]);
  expect(alert.textContent).toContain("PROJECT-READ-FAILED");
  expect(view.container.textContent).not.toContain("Keep changes small.");
 });
 it("draws lost access as the same 4e block with its own reference, and wipes the data", async () => {
  const view = mount("/app/projects/payments?tab=how-we-work", async () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Access ended" } } }));
  const alert = await screen.findByRole("alert");
  expect(alert.classList.contains("g4-error")).toBe(true);
  expect(alert.getAttribute("data-kind")).toBe("denied");
  expect(within(alert).getByText("You no longer have access to this page. Earlier information is hidden.")).toBeTruthy();
  expect(within(alert).getAllByRole("button").map(b => b.textContent)).toEqual(["Load again", "Copy"]);
  expect(alert.textContent).toContain("PROJECT-ACCESS-LOST");
  expect(view.container.textContent).not.toContain("Keep changes small.");
 });
 it("draws loading as skeleton rows beside one status line, never an empty state", async () => {
  const view = mount(undefined, () => new Promise(() => undefined));
  const status = await screen.findByRole("status");
  expect(status.textContent).toBe("Reading this section…");
  expect(view.container.querySelectorAll(".g4-skeleton-rows[aria-hidden=true] .rv-skeleton").length).toBeGreaterThan(0);
  expect(view.container.textContent).not.toMatch(/No project rules/);
 });
});

describe("G4 stale line (owner DEC 254zzz324 render path)", () => {
 it("draws one quiet line per page however many sections kept their data, in the viewer's own zone", async () => {
  const { StaleScope, StaleMark, StaleSlot } = await import("../../../../packages/ui/src/screens/rules-lessons-read/stale.js");
  const { renderUi } = await import("../../support/render.js");
  const { h } = await import("../../support/h.js");
  const early = Date.UTC(2026, 10, 21, 12, 5), late = Date.UTC(2026, 10, 21, 12, 40);
  const view = renderUi(h(StaleScope, null, h(StaleSlot), h(StaleMark, { at: late }), h(StaleMark, { at: early })));
  const lines = await screen.findAllByRole("status");
  expect(lines).toHaveLength(1);
  const expected = new Date(early).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  expect(lines[0]!.textContent).toBe(`Updated ${expected} · Reconnecting`);
  view.unmount();
 });
});
