// @vitest-environment jsdom
// Round 2 (PB22): "A newer Rovara Code is available" on the How we work tab. A maintainer's Update moves the layer's draft onto the new base and opens Review changes; a viewer sees the notice only.
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { LegacyHowWeWorkTab } from "./support/legacy-how-we-work-tab.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { LAYER, howWeWorkHost, howWeWorkView, type Handler } from "./support/how-we-work-fixture.js";

const NOTICE = "A newer Rovara Code is available (version 1 → 2).";
const withUpdate = () => howWeWorkView({ process: { kind: "project_process", agentId: LAYER, version: 2, draftRevision: 3, update: { from: 1, to: 2 } } });
function setup(options: { canEdit?: boolean; view?: unknown; handle?: Handler } = {}) {
 const cell = howWeWorkHost({ view: withUpdate(), ...options }), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments?tab=how-we-work"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(LegacyHowWeWorkTab, {}) }) }) }) }) }) }), { theme: "light" });
 return { ...cell, ...ui, query };
}
const open = async (options: Parameters<typeof setup>[0] = {}) => { const world = setup(options);await screen.findByRole("heading", { name: "Build" });return world; };
describe("the newer Rovara Code notice", () => {
 it("shows the notice but no Update button even to a maintainer: editing the playbook is hidden (DEC 254zzz113/115/116)", async () => {
  await open();
  expect(screen.getByText(NOTICE)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
 });

 it("shows the notice without the button to a viewer", async () => {
  await open({ canEdit: false });
  expect(screen.getByText(NOTICE)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
 });

 it("shows nothing when the view has no update", async () => {
  await open({ view: howWeWorkView() });
  expect(screen.queryByText(/newer Rovara Code/u)).toBeNull();
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
 });

 it("has no accessibility violations", async () => {
  const f = await open();
  await expectNoAxeViolations(f.container);
 });

});
