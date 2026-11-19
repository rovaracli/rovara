// @vitest-environment jsdom
// L4-EINT: the setup run section shows what the run's sample-data writer does and costs (Code's `standInWriter` words), before the run, beside the run's own limit. The words are Code's fixed text; the page only shows them.
import { afterEach, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { SetupAgentViewSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import SetupRunSection from "../../packages/ui/src/screens/setup/SetupRunSection.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

afterEach(cleanup);
const LIMITS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
const WORDS = "Rovara will also write realistic sample data for your tests with your own AI: up to $0.40, inside this run's $4 limit. It never sees a task or a change.";

function mount(read: unknown) {
  const f = fakeHost(async request => {
    if (request.path === "/v1/app/projects/web/setup-agent" && request.method === "GET") return { status: 200, body: { ...(read as object), requestId: "gw" } };
    return { status: 200, body: { status: "ready", entries: [], hostAsks: [], requestId: "gw" } };
  });
  const query = createQueryClient();
  query.setQueryData(["nav"], { me: { developerId: "a".repeat(64), name: "Maya", orgRole: "owner" } });
  return renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/onboard?project=web&step=setup"], children: h(SetupRunSection, { project: "web", settingsRevision: 3 }) }) }) }));
}

it("the schema keeps the writer card strict: an unknown key in it is refused", () => {
  const base = { status: "none", basedOnRevision: 3, limits: LIMITS };
  expect(SetupAgentViewSchema.parse({ ...base, standInWriter: { connected: true, ceilingCents: 40, words: WORDS } }).standInWriter?.ceilingCents).toBe(40);
  expect(() => SetupAgentViewSchema.parse({ ...base, standInWriter: { connected: true, words: WORDS, extra: 1 } })).toThrow();
  expect(SetupAgentViewSchema.parse(base).standInWriter).toBeUndefined();
});

it("shows the writer's words before the run, and nothing when the server sends none", async () => {
  const first = mount({ status: "none", basedOnRevision: 3, limits: LIMITS, canManage: true, standInWriter: { connected: true, ceilingCents: 40, words: WORDS } });
  expect((await screen.findByTestId("stand-in-writer")).textContent).toBe(WORDS);
  first.unmount(); cleanup();
  mount({ status: "none", basedOnRevision: 3, limits: LIMITS, canManage: true });
  await screen.findByText("Let Rovara run the setup");
  expect(screen.queryByTestId("stand-in-writer")).toBeNull();
});

it("says that an AI must be connected first, in the server's words, and hides the line while the run is going or runs are off", async () => {
  const noAi = "Rovara writes sample data for your tests with your own AI, and none is connected for this project. Connect your AI first; Rovara never pays for it. Nothing was written and nothing was spent.";
  const a = mount({ status: "none", basedOnRevision: 3, limits: LIMITS, canManage: true, standInWriter: { connected: false, words: noAi } });
  expect((await screen.findByTestId("stand-in-writer")).textContent).toBe(noAi);
  a.unmount(); cleanup();
  mount({ status: "running", basedOnRevision: 3, limits: LIMITS, canManage: true, standInWriter: { connected: true, words: WORDS } });
  await screen.findByText(/Rovara is setting the project up/u);
  expect(screen.queryByTestId("stand-in-writer")).toBeNull();
  cleanup();
  mount({ status: "none", basedOnRevision: 3, limits: LIMITS, canManage: true, companySetupOff: true, standInWriter: { connected: true, words: WORDS } });
  await screen.findByRole("status");
  expect(screen.queryByTestId("stand-in-writer")).toBeNull();
});
