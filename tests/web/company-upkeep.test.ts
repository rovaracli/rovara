// @vitest-environment jsdom
// L4-P3 (owner 2026-11-17): "Nightly upkeep for the company" on Company settings (owners and admins). It says whether nightly upkeep is allowed for the company and, when it is, offers Withdraw with ONE confirm ("Nightly runs
// stop for every project now. Projects keep their switch."). Withdrawing needs no fresh sign-in. Allowing happens on a project's setup page. Every sentence is one of the fixed wiki sentences; Code's text never shows.
// Mutants (each killed by the named test, run by hand): W1 Withdraw sends without the confirm; W2 the confirm drawn while consent is off; W3 the withdraw body carries more than the id and the choice, or allowed:true;
// W4 the request id changes on a retry after a failure; W5 a failure shows the server's own text; W6 the page does not move to "Not allowed" after the withdrawal; W7 Withdraw drawn while consent is off; W8 the sign-in step
// asked for on a withdrawal; W9 the section drawn for a member; W10 an unreadable answer drawn as a state.
import { beforeEach, describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema, WIKI_SETUP_WORDS } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const LEAK = "SENSITIVE-SERVER-DETAIL";
const PATH = "/v1/app/company/system-runs";
const RID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const err = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
const view = (allowed: boolean, available = true) => ({ status: 200, body: { available, allowed, systemRunsOn: available && allowed } });
beforeEach(() => undefined);

function mount(role: "owner" | "admin" | "member", respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>) {
  const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
  const f = fakeHost(async (r) => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : r.path === "/v1/app/org/settings" ? err(404, "NOT_FOUND", "route not found") : respond(r)));
  const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/settings"] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  return { ...f, ...ui, queryClient: query, close: () => { ui.unmount(); router.dispose(); query.clear(); } };
}
const calls = (f: ReturnType<typeof mount>, method: string) => f.request.mock.calls.map(([request]) => request).filter((request) => request.method === method && request.path === PATH);
const section = async () => screen.findByTestId("company-upkeep");

describe("Nightly upkeep for the company, on Company settings", () => {
  it("an owner with it allowed sees 'Allowed' and Withdraw; Withdraw opens ONE confirm with the fixed sentence and sends nothing yet (W1, W2, W7)", async () => {
    const f = mount("owner", () => view(true));
    const box = await section();
    expect((await within(box).findByTestId("company-upkeep-state")).textContent).toBe("Nightly upkeep for the company: Allowed");
    expect(screen.getByRole("heading", { name: "Nightly upkeep for the company" })).toBeTruthy();
    expect(screen.queryByTestId("company-upkeep-confirm")).toBeNull();
    fireEvent.click(within(box).getByTestId("company-upkeep-withdraw"));
    const confirm = await screen.findByTestId("company-upkeep-confirm");
    expect(confirm.textContent).toContain("Nightly runs stop for every project now. Projects keep their switch.");
    expect(screen.getByRole("group", { name: "Withdraw" })).toBe(confirm);
    expect(calls(f, "PUT")).toHaveLength(0);
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("Yes sends exactly the id and allowed:false, with no sign-in step; the page then says 'Not allowed' and the withdrawal's words; project pages re-read (W3, W6, W8)", async () => {
    let allowed = true;
    const f = mount("admin", (r) => {
      if (r.method === "PUT") { allowed = false; return view(false); }
      return view(allowed);
    });
    fireEvent.click(await screen.findByTestId("company-upkeep-withdraw"));
    fireEvent.click(await screen.findByTestId("company-upkeep-yes"));
    await waitFor(() => expect(screen.getByTestId("company-upkeep-state").textContent).toBe("Nightly upkeep for the company: Not allowed"));
    const sent = calls(f, "PUT");
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body as { requestId: string; allowed: boolean };
    expect(Object.keys(body).sort()).toEqual(["allowed", "requestId"]);
    expect(RID.test(body.requestId)).toBe(true);
    expect(body.allowed).toBe(false);
    expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
    expect(screen.queryByTestId("company-upkeep-withdraw")).toBeNull();
    expect(screen.getByTestId("company-upkeep-allow-where").textContent).toBe("Withdrawn. Nightly runs stopped for every project. Projects keep their switch.");
    f.close();
  });

  // MUTANT W11 (project pages not re-read: the app's query cache keeps a project's upkeep view fresh for 15 seconds) and W12 (focus is lost when the confirm goes away) and W13 (a re-read after the withdrawal flips it to "could not be read").
  it("after Yes: a project's cached upkeep view is marked stale, focus lands on the announced result line, and no second read can turn the withdrawal into an error", async () => {
    let allowed = true;
    const f = mount("owner", (r) => (r.method === "PUT" ? ((allowed = false), view(false)) : view(allowed)));
    const projectKey = ["wiki-setup", "web", "upkeep"];
    f.queryClient.setQueryData(projectKey, { enabled: true, canManage: true, available: true, systemRunsOn: true });
    expect(f.queryClient.getQueryState(projectKey)?.isInvalidated).toBe(false);
    fireEvent.click(await screen.findByTestId("company-upkeep-withdraw"));
    fireEvent.click(await screen.findByTestId("company-upkeep-yes"));
    const status = await screen.findByTestId("company-upkeep-allow-where");
    await waitFor(() => expect(status.getAttribute("role")).toBe("status"));
    expect(status.textContent).toBe("Withdrawn. Nightly runs stopped for every project. Projects keep their switch.");
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(f.queryClient.getQueryState(projectKey)?.isInvalidated).toBe(true);
    expect(calls(f, "GET")).toHaveLength(1);
    expect(screen.queryByTestId("company-upkeep-absent")).toBeNull();
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("Cancel sends nothing and puts focus back on Withdraw (W1)", async () => {
    const f = mount("owner", () => view(true));
    fireEvent.click(await screen.findByTestId("company-upkeep-withdraw"));
    fireEvent.click(await screen.findByTestId("company-upkeep-no"));
    expect(screen.queryByTestId("company-upkeep-confirm")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("company-upkeep-withdraw")));
    expect(calls(f, "PUT")).toHaveLength(0);
    f.close();
  });

  it("not allowed: the state, where to allow it, and no Withdraw (W7)", async () => {
    const f = mount("owner", () => view(false));
    const box = await section();
    await waitFor(() => expect(within(box).getByTestId("company-upkeep-state").textContent).toBe("Nightly upkeep for the company: Not allowed"));
    expect(within(box).getByTestId("company-upkeep-allow-where").textContent).toContain("To allow it, use");
    expect(screen.queryByTestId("company-upkeep-withdraw")).toBeNull();
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("allowed while nightly runs are not available on this Rovara: still withdrawable, and says so (W7)", async () => {
    const f = mount("owner", () => view(true, false));
    const box = await section();
    expect((await within(box).findByTestId("company-upkeep-state")).textContent).toContain("Allowed (Nightly upkeep isn't available on this Rovara yet.)");
    expect(within(box).getByTestId("company-upkeep-withdraw")).toBeTruthy();
    f.close();
  });

  // MUTANT W4 and W5.
  it("a failure shows only a fixed sentence, keeps the confirm, and the retry sends the SAME request id", async () => {
    let fail = true, allowed = true;
    const f = mount("owner", (r) => {
      if (r.method !== "PUT") return view(allowed);
      if (fail) return err(503, "RUNTIME_UNAVAILABLE", LEAK);
      allowed = false;
      return view(false);
    });
    fireEvent.click(await screen.findByTestId("company-upkeep-withdraw"));
    fireEvent.click(await screen.findByTestId("company-upkeep-yes"));
    expect((await screen.findByTestId("company-upkeep-error")).textContent).toBe("That could not be done just now. Try again.");
    expect(document.body.textContent).not.toContain(LEAK);
    expect(screen.getByTestId("company-upkeep-confirm")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByTestId("company-upkeep-yes"));
    await waitFor(() => expect(screen.getByTestId("company-upkeep-state").textContent).toContain("Not allowed"));
    const sent = calls(f, "PUT");
    expect(sent).toHaveLength(2);
    expect((sent[1]!.body as { requestId: string }).requestId).toBe((sent[0]!.body as { requestId: string }).requestId);
    f.close();
  });

  it("one of Code's fixed sentences is shown as it is; a route Code does not serve yet says 'not available yet'; an unreadable answer is not drawn as a state (W5, W10)", async () => {
    const said = mount("owner", (r) => (r.method === "PUT" ? err(403, "FORBIDDEN", WIKI_SETUP_WORDS.systemRunsNotAllowed) : view(true)));
    fireEvent.click(await screen.findByTestId("company-upkeep-withdraw"));
    fireEvent.click(await screen.findByTestId("company-upkeep-yes"));
    expect((await screen.findByTestId("company-upkeep-error")).textContent).toBe(WIKI_SETUP_WORDS.systemRunsNotAllowed);
    said.close();
    const notYet = mount("owner", () => err(501, "NOT_ON_CODE_YET", WIKI_SETUP_WORDS.upkeepNotYet));
    expect((await screen.findByTestId("company-upkeep-absent")).textContent).toBe("Nightly upkeep isn't available on this Rovara yet.");
    expect(screen.queryByTestId("company-upkeep-withdraw")).toBeNull();
    notYet.close();
    const odd = mount("owner", () => ({ status: 200, body: { available: true, allowed: "yes", systemRunsOn: true } }));
    expect((await screen.findByTestId("company-upkeep-absent")).textContent).toBe("Nightly upkeep for the company could not be read just now. Try again.");
    expect(screen.queryByTestId("company-upkeep-state")).toBeNull();
    odd.close();
  });

  it("a member does not get the section (W9)", async () => {
    const f = mount("member", () => view(true));
    expect((await screen.findByRole("heading", { name: "Administration unavailable" })).textContent).toBe("Administration unavailable");
    expect(screen.queryByTestId("company-upkeep")).toBeNull();
    expect(calls(f, "GET")).toHaveLength(0);
    f.close();
  });
});
