// @vitest-environment jsdom
// Round 2 (PB22): "A newer Rovara Code is available" on the How we work tab. A maintainer's Update moves the layer's draft onto the new base and opens Review changes; a viewer sees the notice only.
import { describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { LAYER, diffBody, draftBody, howWeWorkHost, howWeWorkView, publishedAgent, type Handler } from "./support/how-we-work-fixture.js";

const CONFIRM_URL = "https://cell.example/v1/app/approve/abc123";
const NOTICE = "A newer Rovara Code is available (version 1 → 2).";
const withUpdate = () => howWeWorkView({ process: { kind: "project_process", agentId: LAYER, version: 2, draftRevision: 3, update: { from: 1, to: 2 } } });
function setup(options: { canEdit?: boolean; view?: unknown; handle?: Handler } = {}) {
 const cell = howWeWorkHost({ view: withUpdate(), ...options }), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments?tab=how-we-work"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: "light" });
 return { ...cell, ...ui, query };
}
const open = async (options: Parameters<typeof setup>[0] = {}) => { const world = setup(options);await screen.findByRole("heading", { name: "Build" });return world; };
/** Update-base answers with the draft one revision on; the draft read after it shows that revision. */
function rebasing(extra?: Handler): { handle: Handler; revision: () => number } {
 let revision = 3;
 const overlay = { instructions: "Keep changes small.", steps: { build: { instructions: "Run the linter." } } };
 return { revision: () => revision, handle: async (request, url) => {
  const custom = await extra?.(request, url);
  if (custom !== undefined) return custom;
  if (url.pathname === `/v1/app/agents/${LAYER}/update-base`) { revision = 4;return { status: 200, body: { draft: draftBody(overlay, 4).draft, changes: ["Adds the plan check"] } }; }
  if (url.pathname === `/v1/app/agents/${LAYER}/draft` && request.method === "GET" && revision === 4) return { status: 200, body: draftBody(overlay, 4) };
  return undefined;
 } };
}
const update = () => fireEvent.click(screen.getByRole("button", { name: "Update" }));

describe("the newer Rovara Code notice", () => {
 it("shows the notice and an Update button to a maintainer", async () => {
  await open();
  expect(screen.getByText(NOTICE)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
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

 it("Update re-bases the draft, then opens Review changes comparing the running version with the moved draft; nothing is published by itself", async () => {
  const r = rebasing();
  const f = await open({ handle: r.handle });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  update();
  const dialog = await screen.findByRole("dialog", { name: "Review changes" });
  await within(dialog).findByText("What changes");
  const base = f.sent().find(request => request.path.endsWith("/update-base"))!;
  expect(base.path).toBe(`/v1/app/agents/${LAYER}/update-base`);
  expect(base.body).toMatchObject({ expectedRevision: 3 });
  expect(f.calls().some(call => call.includes("/diff"))).toBe(true);
  expect(f.sent().some(request => request.path.endsWith("/publish"))).toBe(false);
  // The dialog publishes the moved draft's revision.
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
  await waitFor(() => expect(f.sent().some(request => request.path.endsWith("/publish"))).toBe(true));
  expect(f.sent().find(request => request.path.endsWith("/publish"))!.body).toMatchObject({ expectedRevision: 4 });
 });

 it("says a publish applied (200), with the version, after Update", async () => {
  const r = rebasing((request, url) => url.pathname.endsWith("/publish") ? { status: 200, body: { agent: publishedAgent(), version: { version: 3 } } } : undefined);
  await open({ handle: r.handle });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  update();
  const dialog = await screen.findByRole("dialog", { name: "Review changes" });
  await within(dialog).findByText("What changes");
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
  expect((await within(dialog).findByRole("status")).textContent).toBe("Published as version 3. New tasks use it; running tasks keep their version.");
 });

 it("shows the less-safe reasons and says a publish was sent for confirmation (202), never that it is live", async () => {
  const r = rebasing((request, url) => url.pathname.endsWith("/diff") ? { status: 200, body: diffBody(2, ["Lowers the review rounds"], ['Lowers how many times the review step "Review" sends findings back, from 3 to 2']) }
   : url.pathname.endsWith("/publish") ? { status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: CONFIRM_URL, changes: ['Lowers how many times the review step "Review" sends findings back, from 3 to 2'] } } : undefined);
  const f = await open({ handle: r.handle });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  update();
  const dialog = await screen.findByRole("dialog", { name: "Review changes" });
  const reasons = await within(dialog).findByRole("region", { name: "Needs someone else to confirm" });
  expect(within(reasons).getByText('Lowers how many times the review step "Review" sends findings back, from 3 to 2')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
  await within(dialog).findByText("Sent for confirmation: someone else who can approve changes in this project confirms it.");
  expect(within(dialog).queryByText(/Published as version/u)).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Open confirmation" }));
  expect(f.host.openExternal).toHaveBeenCalledWith(CONFIRM_URL);
 });

 it("a refused Update shows why, opens no dialog and keeps the notice", async () => {
  await open({ handle: (request, url) => url.pathname.endsWith("/update-base") ? { status: 409, body: { error: { code: "AGENT_REVISION_CONFLICT", message: "Someone else changed this agent's draft. Reload it and make your change again." } } } : undefined });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  update();
  expect((await screen.findByRole("alert")).textContent).toContain("Someone else changed this agent's draft");
  expect(screen.queryByRole("dialog", { name: "Review changes" })).toBeNull();
  expect(screen.getByText(NOTICE)).toBeTruthy();
 });

 it("Update waits while edits are unsaved, so they are never moved silently", async () => {
  await open();
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  fireEvent.change(screen.getAllByRole("textbox", { name: /Project rules/u })[0]!, { target: { value: "Something new" } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Update" }).disabled).toBe(true);
 });
});
