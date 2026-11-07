// @vitest-environment jsdom
// Chains and triggers are hidden (owner 2026-11-07): a link to a chain run says "This isn't available" with a link home, unless the hidden `chains` switch is on. The data stays.
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { chainRunViewOf } from "./support/chain-fixture.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { navFixture } from "./support/fixtures.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";

const id = "crn_" + "a".repeat(20);
const nav = (chains: boolean) => navFixture({ features: { admin: false, localAgents: false, usage: false, chains, describe: false, notices: false } });
function chainPage(chains: boolean) {
  const chain = chainRunViewOf(id, { project: "payments" });
  const session = SessionViewReaderSchema.parse(workspaceFixture({ sessionId: id, kind: "chain", body: { kind: "chain", chain } }));
  const f = fakeHost(async request => request.path.endsWith("/events") ? { status: 200, body: { events: [] } } : request.path.endsWith("/presence") ? { status: 200, body: { viewingNow: [] } } : { status: 200, body: { session } });
  const query = createQueryClient();query.setQueryData(["nav"], nav(chains));
  const router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + id] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
  return { close() { ui.unmount();router.dispose();query.clear(); } };
}

it("a chain run link shows \"This isn't available\" and a link home while the chains switch is off", async () => {
  const f = chainPage(false);
  expect(await screen.findByRole("heading", { name: "This isn't available", level: 1 })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/app");
  expect(screen.queryByLabelText("Chain progress")).toBeNull();
  f.close();
});

it("the same link shows the chain's steps when the hidden chains switch is on (positive control)", async () => {
  const f = chainPage(true);
  expect(await screen.findByRole("heading", { name: "Fix duplicate refunds", level: 1 })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "This isn't available" })).toBeNull();
  f.close();
});
