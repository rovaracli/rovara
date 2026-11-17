// @vitest-environment jsdom
// Web task channel K6: the teammate's welcome on Home names a Slack channel only when a project shown there has one linked (golden for the sentence where Slack is in use).
import { expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { TeammateWelcome } from "../../packages/ui/src/screens/home/TeammateWelcome.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";

const checklist = (channels: unknown[]) => ({
  project: "payments", viewer: { companyRole: "member", projectAdmin: false, canSkip: false }, progress: { done: 8, total: 8, percent: 100, nextRequired: null },
  repos: { state: "done", count: 1, items: [] }, setupRun: { state: "done", status: "ready" }, evalConfirm: { state: "done", report: "confirmed" }, aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
  slackChannel: { state: channels.length > 0 ? "done" : "optional", channels }, linear: { state: "optional", team: null }, invites: { state: "optional" }, firstTask: { state: "done", hasTask: true, canStart: true },
});
function mount(channels: unknown[]) {
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/nav") return { status: 200, body: navFixture({ me: { developerId: "a".repeat(64), name: "Sam", orgRole: "member" }, projects: [{ name: "payments", agents: [] }] }) };
    if (request.path === "/v1/app/projects/payments/setup-status") return { status: 200, body: checklist(channels) };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app?joined=1"], children: h(TeammateWelcome, {}) }) }) }), { theme: "light" });
  return { ...f, close() { ui.unmount(); query.clear(); } };
}

it("says 'or in its Slack channel' when the project has a linked channel (golden)", async () => {
  const f = mount([{ channelId: "CPAY00001", name: "payments-dev" }]);
  await waitFor(() => expect(screen.getByTestId("teammate-welcome").textContent).toContain("You're in this project. Start a task here, or in its Slack channel."));
  expect(screen.getByTestId("welcome-project").textContent).toContain("Slack: #payments-dev");
  f.close();
});

it("says only 'Start a task here' when no shown project has a channel, and never names Slack", async () => {
  const f = mount([]);
  await waitFor(() => expect(screen.getByTestId("teammate-welcome").textContent).toContain("You're in this project. Start a task here."));
  await new Promise((done) => setTimeout(done, 30));
  expect(screen.getByTestId("teammate-welcome").textContent).not.toMatch(/slack/iu);
  f.close();
});
