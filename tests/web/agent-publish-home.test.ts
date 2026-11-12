// @vitest-environment jsdom
// The Home agents row (exp/agent-publish on Home, the only Home since decision 125): favourites then suggested agents with their reasons, only where `rovara.publish` is "v2".
// With the publishing switch off, Home's recently-used-then-directory row is unchanged.
import { expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { HomeScreen } from "../../packages/ui/src/screens/home/HomeScreen.js";
import { AGENT_PUBLISH_STORAGE_KEY } from "../../packages/ui/src/screens/agents/publish-flags.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
import { directoryOf, agentId } from "./support/home-fixture.js";
import { agentCard, errorBody, myAgents, ok } from "./support/publish-fixture.js";

interface Setup { publish?: boolean; mine?: unknown }
function render(options: Setup) {
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/home") return ok({ cards: [], total: 0, needsYou: 0 });
  if (request.path === "/v1/app/decisions") return ok({ cards: [], total: 0, tabs: [], details: {}, digests: {}, dropped: 0 });
  if (request.path.startsWith("/v1/app/live")) return ok({ tiles: [] });
  if (request.path.startsWith("/v1/app/me/agents")) return options.mine === undefined ? ok(errorBody("NOT_FOUND", "Not found."), 404) : ok(options.mine);
  if (request.path.startsWith("/v1/app/sessions")) return ok({ sessions: [] });
  if (request.path.startsWith("/v1/app/agents")) return ok(directoryOf([{ id: agentId(1), name: "Directory agent one" }, { id: agentId(2), name: "Directory agent two" }]));
  if (/^\/v1\/app\/projects\/[^/]+\/overview$/u.test(request.path)) return ok(errorBody("NOT_FOUND", "Not found."), 404);
  return ok({ notices: [], next: "settled" });
 });
 if (options.publish === true) f.storage.set(AGENT_PUBLISH_STORAGE_KEY, "v2");
 const query = createQueryClient();query.setQueryData(["nav"], navFixture());
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}
const A = (n: number) => agentId(n);
const mine = myAgents([agentCard(A(11), "Favourite one", "favourite"), agentCard(A(12), "Favourite two", "favourite")], [agentCard(A(11), "Favourite one", "used_by_you"), agentCard(A(13), "Used agent", "used_by_you"), agentCard(A(14), "Roster agent", "project_roster"), agentCard("ticket-triage", "Ticket triage", "starter"), agentCard(A(15), "Fifth suggestion", "starter"), agentCard(A(16), "Sixth", "starter")]);

it("with the publishing switch on, the row is favourites then suggested agents with their reasons, not the directory", async () => {
 const f = render({ publish: true, mine });
 const favourites = await screen.findByRole("list", { name: "Favourite agents" }), suggested = await screen.findByRole("list", { name: "Suggested agents" });
 expect(within(favourites).getAllByRole("link").map(link => link.textContent)).toEqual(["Favourite oneYour favourite".replace("Your favourite", "Favourite one does its work."), "Favourite twoFavourite two does its work."].map(text => text));
 // The suggested list never repeats a favourite, shows the reason line, and stops at four.
 const links = within(suggested).getAllByRole("link").map(link => link.textContent);
 expect(links).toEqual(["Used agentYou use this", "Roster agentOn this project's roster", "Ticket triageStarter", "Fifth suggestionStarter"]);
 expect(screen.queryByText("Directory agent one")).toBeNull();expect(screen.queryByRole("list", { name: "Agents" })).toBeNull();
 expect(screen.getByRole("heading", { name: "Your favourites" })).toBeTruthy();expect(screen.getByRole("heading", { name: "Suggested for you" })).toBeTruthy();
 expect(within(favourites).getAllByRole("link")[0]!.getAttribute("href")).toBe("/app/agents/" + A(11));
 f.close();
});
it("is empty-safe: nothing from the server says so plainly", async () => {
 const f = render({ publish: true, mine: myAgents([], []) });
 expect(await screen.findByText("No agents are available yet.")).toBeTruthy();expect(screen.queryByRole("list", { name: "Agents" })).toBeNull();
 f.close();
});
it("falls back to today's new-Home row when the server cannot answer yet", async () => {
 const f = render({ publish: true });
 expect(await screen.findByText("Directory agent one")).toBeTruthy();expect(screen.getByRole("list", { name: "Agents" })).toBeTruthy();
 f.close();
});
it("with the publishing switch off, the new Home's row is unchanged and nothing asks for favourites", async () => {
 const f = render({ mine });
 expect(await screen.findByText("Directory agent one")).toBeTruthy();expect(screen.getByRole("list", { name: "Agents" })).toBeTruthy();expect(screen.queryByRole("list", { name: "Favourite agents" })).toBeNull();
 await waitFor(() => expect(f.request).toHaveBeenCalled());
 expect(f.request.mock.calls.filter(([request]) => request.path.startsWith("/v1/app/me/agents"))).toEqual([]);
 f.close();
});
