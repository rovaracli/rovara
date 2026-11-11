// @vitest-environment jsdom
import { expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { NewAgentScreen } from "../../packages/ui/src/screens/builder/NewAgentScreen.js";
import { renderAgents } from "./support/agent-render.js";
import { renderBuilder } from "./support/builder-render.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { agentProfile, AGENT_FIXTURE_ID } from "./support/agent-fixture.js";
import { expectNoAxeViolations } from "./support/axe.js";
const NOTE = "Building agents works best on a larger screen.";
const profilePath = "/app/agents/" + AGENT_FIXTURE_ID;
// The shell hides .rv-large-screen-content and shows the block message below 768px. A page that is not wrapped has neither element, so it cannot be blocked at any width.
const blocked = (container: HTMLElement) => container.querySelector(".rv-large-screen-content") !== null || container.querySelector(".rv-large-screen-message") !== null;
for (const width of [360, 390]) {
 it("the directory is a usable page at " + String(width) + "px, not behind the larger-screen block", async () => {
  const f = renderAgents({ width });const link = await screen.findByRole("link", { name: "Payments Expert" });
  expect(blocked(f.container)).toBe(false);expect(screen.queryByRole("heading", { name: "Open on a larger screen" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Agent directory", level: 1 })).toBeTruthy();expect(screen.getByRole("textbox", { name: "Find in these workflows" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "New agent" }).getAttribute("href")).toBe("/app/agents/new");expect(screen.getByRole("note").textContent).toBe(NOTE);
  fireEvent.change(screen.getByRole("textbox", { name: "Find in these workflows" }), { target: { value: "nothing like this" } });expect(await screen.findByText("No loaded workflows match your search.")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Find in these workflows" }), { target: { value: "payments" } });expect((await screen.findByRole("link", { name: "Payments Expert" })).getAttribute("href")).toContain(link.getAttribute("href"));
  await expectNoAxeViolations(f.container);f.close();
 });
}
it("a phone opens an agent as its own page with a way back, never as a tray over the list", async () => {
 const f = renderAgents({ width: 390 });fireEvent.click(await screen.findByRole("link", { name: "Payments Expert" }));
 expect(await screen.findByRole("heading", { name: "Payments Expert", level: 1 })).toBeTruthy();expect(screen.queryByRole("dialog")).toBeNull();expect(screen.queryByRole("list", { name: "Shared workflows" })).toBeNull();
 const back = screen.getByRole("link", { name: "All agents" });expect(back.getAttribute("href")).toBe("/app/agents");
 // Reading order is visual order: the way back comes first, then the title.
 const order = [back, screen.getByRole("heading", { level: 1 })];expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 fireEvent.click(back);expect(await screen.findByRole("heading", { name: "Agent directory", level: 1 })).toBeTruthy();f.close();
});
it("a large screen keeps the tray, shows no phone note and no way-back link", async () => {
 const f = renderAgents({ width: 1280 });fireEvent.click(await screen.findByRole("link", { name: "Payments Expert" }));
 await screen.findByRole("dialog", { name: "Payments Expert" });expect(screen.queryByRole("note")).toBeNull();expect(screen.queryByRole("link", { name: "All agents" })).toBeNull();f.close();
});
it("the profile at 390px can be read, started and shared, and sends building to a larger screen", async () => {
 const f = renderAgents({ path: profilePath, width: 390 });await screen.findByRole("heading", { name: "Payments Expert", level: 1 });
 expect(blocked(f.container)).toBe(false);expect(screen.getByText("Check refund idempotency.")).toBeTruthy();
 expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();expect(screen.getByRole("link", { name: "Edit" }).getAttribute("href")).toBe(profilePath + "/edit");expect(screen.getByRole("link", { name: "Test" })).toBeTruthy();
 expect(screen.getAllByRole("note").map(note => note.textContent)).toContain(NOTE);
 fireEvent.click(screen.getByText("Sharing and versions"));
 const versions = await screen.findByRole("link", { name: "Version 3" });expect(versions.getAttribute("href")).toContain("/edit?from=");expect(screen.getAllByRole("note").map(note => note.textContent)).toContain("Comparing versions works best on a larger screen.");
 fireEvent.click(screen.getByText("Spend this month"));expect(await screen.findByText("Started by people")).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Start session" }));
 const dialog = await screen.findByRole("dialog", { name: "New session with Payments Expert" });expect(dialog.className).toContain("rv-agent-dialog");
 fireEvent.change(await within(dialog).findByRole("combobox", { name: "Project" }), { target: { value: "payments" } });await waitFor(() => expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(false));
 fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));expect(await within(dialog).findByRole("textbox", { name: "What should Payments Expert do?" })).toBeTruthy();
 await expectNoAxeViolations(f.container);f.close();
});
it("a view-only reader on a phone sees no builder note and no builder actions", async () => {
 const base = agentProfile(), f = renderAgents({ path: profilePath, width: 390, profile: agentProfile({ agent: { ...base.agent, access: "view" } }) });await screen.findByRole("heading", { name: "Payments Expert", level: 1 });
 expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();expect(screen.queryByText(NOTE)).toBeNull();f.close();
});
it("the dialogs opened from the profile carry the phone-width class", async () => {
 const f = renderAgents({ path: profilePath, width: 360 });await screen.findByRole("heading", { name: "Payments Expert", level: 1 });
 fireEvent.click(screen.getByRole("button", { name: "Share" }));expect((await screen.findByRole("dialog", { name: "Share this workflow" })).className).toContain("rv-agent-dialog");
 fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
 fireEvent.click(screen.getByText("Sharing and versions"));fireEvent.click(await screen.findByRole("button", { name: "Change owner" }));expect((await screen.findByRole("dialog", { name: "Change owner" })).className).toContain("rv-agent-dialog");f.close();
});
it("the builder and the new-agent page still sit behind the larger-screen block", async () => {
 const builder = renderBuilder();await waitFor(() => expect(builder.container.querySelector(".rv-large-screen-content")).not.toBeNull());
 expect(within(builder.container).getByRole("heading", { name: "Open on a larger screen", hidden: true })).toBeTruthy();builder.close();
 const f = fakeHost(async () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } })), query = createQueryClient(), router = createMemoryRouter([{ path: "/app/agents/new", element: h(NewAgentScreen, {}) }], { initialEntries: ["/app/agents/new"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 expect(ui.container.querySelector(".rv-large-screen-content")).not.toBeNull();expect(within(ui.container).getByRole("heading", { name: "Open on a larger screen", hidden: true })).toBeTruthy();ui.unmount();router.dispose();query.clear();
});
