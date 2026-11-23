// @vitest-environment jsdom
import { inViewerZones, VIEWER_INSTANT } from "./support/viewer-zones.js";
// Guided onboarding PR 12b: Company settings, Connections. Each integration shows its account, who connected it and when, and its health; owners and admins see
// Connect/Reconnect; only an owner sees Disconnect, which confirms first (no step-up since owner DEC 254zzz73), names the projects that block it or lose
// their channel/team, and links only to GitHub's own settings. Refusals show Cloud's fixed words only.
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { CompanyConnections } from "../../packages/ui/src/screens/connect/CompanyConnections.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const LEAK = "SENSITIVE-SERVER-DETAIL";
const AT = "2026-11-17T12:00:00.000Z";
const github = (status = "active") => ({ installations: [{ installationId: 11, accountLogin: "acme", status, accountType: "Organization", connectedAt: AT, connectedBy: { kind: "person", name: "Maya" } }] });
interface Options { role?: "owner" | "admin" | "member"; github?: unknown; slack?: unknown; linear?: unknown; remove?: (request: ApiRequest) => ApiResponse }
function mount(options: Options = {}) {
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/github/connections") return { status: 200, body: options.github ?? github() };
    if (request.path === "/v1/app/slack" && request.method === "GET") return { status: 200, body: options.slack ?? { workspace: { teamName: "Acme", state: "connected", connectedAt: AT, connectedBy: { kind: "person", name: "Maya" } } } };
    if (request.path === "/v1/app/linear" && request.method === "GET") return { status: 200, body: options.linear ?? { status: "connected", workspace: { name: "Acme Linear", urlKey: "acme" }, connectedAt: AT, connectedBy: { name: "Maya" } } };
    if (request.method === "DELETE" || request.path === "/v1/app/slack/disconnect") {
      if (options.remove !== undefined) return options.remove(request);
      if (request.path === "/v1/app/github/connections/11") return { status: 200, body: { status: "disconnected", installationId: 11, accountLogin: "acme", uninstallUrl: "https://github.com/organizations/acme/settings/installations/11" } };
      if (request.path === "/v1/app/slack/disconnect") return { status: 200, body: { status: "disconnected", workspaceName: "Acme", projectsLosingChannel: ["web", "api"] } };
      if (request.path === "/v1/app/linear") return { status: 200, body: { status: "disconnected", workspaceName: "Acme Linear", projects: ["web"] } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/admin/connections"], children: h(CompanyConnections, { role: options.role ?? "owner" }) }) }) }), { theme: "light" });
  return { ...f, close() { ui.unmount(); query.clear(); } };
}
const sent = (f: ReturnType<typeof mount>, method: string, path: string) => f.request.mock.calls.map(([request]) => request).filter((request) => request.method === method && request.path === path);

describe("Connections", () => {
  it("shows each integration's account, who connected it and when, and its health", async () => {
    const f = mount();
    const gh = await screen.findByTestId("connections-github-account");
    expect(gh.textContent).toContain("acme (organization)");
    expect(gh.textContent).toContain("Working");
    expect(gh.textContent).toContain("Connected by Maya on Nov 17, 2026.");
    expect((await screen.findByTestId("connections-slack")).textContent).toContain("Added by Maya on Nov 17, 2026.");
    expect((await screen.findByTestId("connections-linear")).textContent).toContain("Acme Linear");
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("an owner disconnects GitHub after confirming; only GitHub's own settings page is linked", async () => {
    const f = mount();
    fireEvent.click(await screen.findByTestId("github-11-disconnect"));
    expect(sent(f, "DELETE", "/v1/app/github/connections/11")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("github-11-disconnect-confirm"));
    const done = await screen.findByTestId("github-11-done");
    expect(done.textContent).toContain("Disconnected acme.");
    expect(within(done).getByRole("link").getAttribute("href")).toBe("https://github.com/organizations/acme/settings/installations/11");
    expect(sent(f, "DELETE", "/v1/app/github/connections/11")[0]!.body).toBeUndefined();
    f.close();
    const g = mount({ remove: () => ({ status: 200, body: { status: "disconnected", installationId: 11, accountLogin: "acme", uninstallUrl: "https://evil.example/x" } }) });
    fireEvent.click(await screen.findByTestId("github-11-disconnect"));
    fireEvent.click(screen.getByTestId("github-11-disconnect-confirm"));
    expect(within(await screen.findByTestId("github-11-done")).queryByRole("link")).toBeNull();
    g.close();
  });

  it("an admin or member sees no Disconnect, only that an owner can", async () => {
    for (const role of ["admin", "member"] as const) {
      const f = mount({ role });
      expect((await screen.findByTestId("github-11-owner-only")).textContent).toBe("Only a company owner can disconnect GitHub.");
      expect(await screen.findByTestId("slack-owner-only")).toBeTruthy();
      expect(screen.queryByTestId("github-11-disconnect")).toBeNull();
      f.close();
    }
  });

  it("a 403 from Cloud is a fixed refusal with no sign-in step (owner DEC 254zzz73)", async () => {
    const f = mount({ remove: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only a company owner can disconnect GitHub." } } }) });
    fireEvent.click(await screen.findByTestId("github-11-disconnect"));
    fireEvent.click(screen.getByTestId("github-11-disconnect-confirm"));
    await screen.findByTestId("github-11-error");
    expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
    expect(f.host.signIn).not.toHaveBeenCalled();
    f.close();
  });

  it("names the projects that still use GitHub; an unknown refusal shows the app's own words", async () => {
    const words = "Projects still use this GitHub connection: web, api. Remove its repositories from them first.";
    const f = mount({ remove: () => ({ status: 409, body: { error: { code: "GITHUB_IN_USE", message: words }, projects: ["web", "api"] } }) });
    fireEvent.click(await screen.findByTestId("github-11-disconnect"));
    fireEvent.click(screen.getByTestId("github-11-disconnect-confirm"));
    expect((await screen.findByTestId("github-11-error")).textContent).toBe(words);
    f.close();
    const g = mount({ remove: () => ({ status: 418, body: { error: { code: "TEAPOT", message: LEAK } } }) });
    fireEvent.click(await screen.findByTestId("github-11-disconnect"));
    fireEvent.click(screen.getByTestId("github-11-disconnect-confirm"));
    expect((await screen.findByTestId("github-11-error")).textContent).toBe("GitHub could not be disconnected just now; try again.");
    expect(document.body.textContent).not.toContain(LEAK);
    g.close();
  });

  it("a suspended or removed GitHub account says so and offers Reconnect", async () => {
    const f = mount({ github: github("uninstalled") });
    expect((await screen.findByTestId("connections-github-broken")).textContent).toContain("GitHub disconnected. Reconnect it");
    expect(screen.getByRole("link", { name: "Reconnect" }).getAttribute("href")).toBe("/app/onboard?step=github");
    f.close();
  });

  it("disconnecting Slack and Linear names the projects that lose their channel or team", async () => {
    const f = mount();
    fireEvent.click(await screen.findByTestId("slack-disconnect"));
    fireEvent.click(screen.getByTestId("slack-disconnect-confirm"));
    expect((await screen.findByTestId("slack-done")).textContent).toContain("Projects that lost their channel: web, api.");
    fireEvent.click(await screen.findByTestId("linear-disconnect"));
    fireEvent.click(screen.getByTestId("linear-disconnect-confirm"));
    expect((await screen.findByTestId("linear-done")).textContent).toContain("Projects that lost their Linear team: web.");
    await waitFor(() => expect(sent(f, "DELETE", "/v1/app/linear")).toHaveLength(1));
    f.close();
  });

  it("Slack removed in Slack and Linear refusing the token show Reconnect", async () => {
    const f = mount({ slack: { workspace: { teamName: "Acme", state: "disconnected", connectedAt: AT, connectedBy: { kind: "person" } } }, linear: { status: "needs_reconnect", workspace: { name: "Acme Linear", urlKey: "acme" } } });
    expect(await screen.findByTestId("connections-slack-broken")).toBeTruthy();
    expect(screen.getByTestId("connections-slack-add").textContent).toBe("Reconnect Slack");
    expect(await screen.findByTestId("connections-linear-broken")).toBeTruthy();
    expect(screen.getByTestId("linear-connect").textContent).toBe("Reconnect Linear");
    f.close();
  });
});

it("renders company connection dates in both viewer zones", async () => {
 await inViewerZones(async expected => {
  const f = mount({ github: { installations: [{ ...github().installations[0], connectedAt: VIEWER_INSTANT }] } });
  try { const card = await screen.findByTestId("connections-github-account");expect(card.textContent).toContain(`on ${expected.date}`); } finally { f.close(); }
 });
});
