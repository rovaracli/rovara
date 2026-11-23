// @vitest-environment jsdom
// SETUP-WIKI-CLOUD-FIXES (e): four reads the app makes are NOT on the Rovara Code the prod Cloud runs on (and not on code/next): the project's setup-agent/limits, /connections, /github/requests and
// /org/slack-workspace-evidence. Cloud answers its fixed 501 NOT_ON_CODE_YET (Code's own route-not-found 404 is the same thing). Each page degrades calmly: no error page, no alert, no Try again, no control for the missing
// route, the rest of the page stays, and a Code that does not serve a read is not asked again every few seconds.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "./support/legacy-admin-routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { SetupLimitsSection } from "../../packages/ui/src/screens/setup/SetupLimitsSection.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

afterEach(cleanup);
const NOT_YET: ApiResponse = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "/v1/app/x isn't connected to Rovara Code yet." } } };
const ROUTE_404: ApiResponse = { status: 404, body: { error: { code: "route_not_on_code", message: "route not on code" } } };
const CASES: Array<[string, ApiResponse]> = [["Cloud's 501 NOT_ON_CODE_YET", NOT_YET], ["Code's own 404 route-not-found", ROUTE_404]];
const LIMITS = "/v1/app/projects/payments/setup-agent/limits";

describe("the project's setup limits (setup-agent/limits)", () => {
  for (const [name, reply] of CASES) it(`${name}: the card is left out with no alert and no form, and is not asked again on a remount`, async () => {
    const f = fakeHost(async request => (request.path === LIMITS ? reply : { status: 404, body: {} }));
    const query = createQueryClient();
    const mountIt = () => renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(SetupLimitsSection, { project: "payments" }) }) }) }));
    const first = mountIt();
    await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.path === LIMITS)).toHaveLength(1));
    await waitFor(() => expect(query.getQueryState(["setup-limits", "payments"])?.status).toBe("success"));
    expect(screen.queryByRole("region", { name: "Setup limits" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    first.unmount();
    const second = mountIt();
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(f.request.mock.calls.filter(([r]) => r.path === LIMITS)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    second.unmount();
  });
  it("any OTHER failure still says it could not load (with Try again): only 'not served' is calm", async () => {
    const f = fakeHost(async request => (request.path === LIMITS ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } } : { status: 404, body: {} }));
    const query = createQueryClient();
    renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(SetupLimitsSection, { project: "payments" }) }) }) }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the setup limits");
  });
});

// ---- the company Connections page (connections, github/requests, slack-workspace-evidence) ----
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
function connectionsPage(replies: Record<string, ApiResponse>) {
  const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
  const f = fakeHost(async (r: ApiRequest) => replies[r.path] ?? { status: 200, body: r.path === "/v1/app/nav" ? nav : r.path === "/v1/app/me" ? me : r.path === "/v1/app/github/installations" ? { installations: [{ installationId: 7, accountLogin: "Example", status: "active" }] } : r.path === "/v1/app/home" ? { cards: [], total: 0 } : {} });
  f.storage.set("rovara.theme", "light");
  const query = createQueryClient();
  query.setQueryData(["nav"], nav);
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/connections"] });
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  return { ...f, query, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}
const VALID: Record<string, ApiResponse> = {
  "/v1/app/connections": { status: 200, body: { connections: [{ connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "linear", label: "Tracker", identity: "service", hasCredential: true, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" }] } },
  "/v1/app/github/requests": { status: 200, body: { requests: [{ githubLogin: "requester", status: "waiting", requestedAt: "2026-10-01T00:00:00Z", accountLogin: "Pending organization" }] } },
  "/v1/app/org/slack-workspace-evidence": { status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", checkedAt: "2026-10-27T23:00:00Z", kind: "stored_workspace_associations", associationCount: 3, unavailableCount: 0, coverage: "complete", verification: "unverified" } },
};
/** How many alerts the page shows when the three reads work: the page's other sections own them; a missing route must add none. */
async function baselineAlerts(): Promise<number> {
  const f = connectionsPage(VALID);
  await screen.findByText("Example"); await screen.findByText("Tracker"); await screen.findByRole("heading", { name: "GitHub installation requests" }); await screen.findByText("3 stored associations observed in this read.");
  const count = screen.queryAllByRole("alert").length;
  f.close(); cleanup();
  return count;
}
const asked = (f: ReturnType<typeof connectionsPage>, path: string) => f.request.mock.calls.filter(([r]) => r.path === path).length;

describe("the company Connections page when a read is not served", () => {
  for (const [name, reply] of CASES) {
    it(`${name} for /v1/app/connections: the registered-connections block is left out, with no alert and no control; GitHub and Slack stay`, async () => {
      const base = await baselineAlerts();
      const f = connectionsPage({ ...VALID, "/v1/app/connections": reply });
      await screen.findByRole("heading", { name: "GitHub installations (operator records)" });
      await waitFor(() => expect(asked(f, "/v1/app/connections")).toBeGreaterThan(0));
      await screen.findByText("Example");
      expect(screen.queryByRole("heading", { name: "Registered connections" })).toBeNull();
      expect(screen.queryAllByRole("alert").length).toBeLessThanOrEqual(base);
      expect(screen.getByRole("heading", { name: "Slack (operator records)" })).toBeTruthy();
      f.close();
    });
    it(`${name} for /v1/app/github/requests: the installation-requests block is left out, with no alert; the installations stay`, async () => {
      const base = await baselineAlerts();
      const f = connectionsPage({ ...VALID, "/v1/app/github/requests": reply });
      await screen.findByText("Example");
      await waitFor(() => expect(asked(f, "/v1/app/github/requests")).toBeGreaterThan(0));
      expect(screen.queryByRole("heading", { name: "GitHub installation requests" })).toBeNull();
      expect(screen.queryAllByRole("alert").length).toBeLessThanOrEqual(base);
      f.close();
    });
  }
  it("Cloud's 501 for /v1/app/org/slack-workspace-evidence: the Slack details card is left out, with no alert and no refresh button; the Slack guidance stays", async () => {
    const base = await baselineAlerts();
    const f = connectionsPage({ ...VALID, "/v1/app/org/slack-workspace-evidence": NOT_YET });
    await screen.findByText("Example");
    await waitFor(() => expect(asked(f, "/v1/app/org/slack-workspace-evidence")).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole("status", { name: /loading slack/i })).toBeNull());
    expect(screen.queryByRole("region", { name: "Slack workspace details" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh Slack workspace details" })).toBeNull();
    expect(screen.queryAllByRole("alert").length).toBeLessThanOrEqual(base);
    expect(screen.getByText("Slack setup guidance")).toBeTruthy();
    f.close();
  });
  it("Code's own 404 for /v1/app/org/slack-workspace-evidence: a fixed 'aren't available here yet' line, never Code's words, and no stored figures", async () => {
    const f = connectionsPage({ ...VALID, "/v1/app/org/slack-workspace-evidence": ROUTE_404 });
    expect(await screen.findByText("Slack workspace details aren't available here yet.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("route not on code");
    expect(screen.queryByText(/stored associations observed/u)).toBeNull();
    f.close();
  });
});
