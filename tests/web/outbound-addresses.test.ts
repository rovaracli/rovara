// @vitest-environment jsdom
// L4-EGR: "Rovara's outbound addresses", one read-only line in Company settings for owners and admins. The line names the addresses, says every company on this Rovara shares them and promises 30 days'
// notice before they change. It sends one GET and nothing else, draws nothing while loading, when there are none yet, or when they can't be read (no error for a line that is only information), and never
// draws an answer that is not exactly the contract.
// Mutants (each killed by the named test, run by hand): O1 the line drawn for a plain member; O2 drawn with an empty list; O3 an unreadable answer drawn as a line or an error; O4 a private or malformed
// address drawn; O5 the sentence loses "shared by all companies" or the 30 days; O6 anything but a bare GET sent; O7 the singular sentence drawn with the plural words; O8 an extra member of the answer accepted; O9 the scope caveat (what does not use the addresses) dropped.
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { EGRESS_ADDRESSES_PATH, EGRESS_NOTICE_DAYS, readEgressAddresses } from "../../packages/ui/src/api/egress-addresses.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const LEAK = "SENSITIVE-SERVER-DETAIL";
const ADDRESSES = ["44.235.136.195", "44.226.134.187"];
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const err = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
const ok = (addresses: unknown): ApiResponse => ({ status: 200, body: addresses === undefined ? {} : { addresses } });

function mount(role: "owner" | "admin" | "member", respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>, orgId = A) {
  const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: role }, org: { orgId, name: "Acme", plan: "team" }, identities: [] });
  const f = fakeHost(async (r) => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : r.path === "/v1/app/org/settings" ? err(404, "NOT_FOUND", "route not found") : r.path === "/v1/app/company/system-runs" ? err(404, "NOT_FOUND", "route not found") : respond(r)));
  const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/settings"] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  return { ...f, ...ui, close: () => { ui.unmount(); router.dispose(); query.clear(); } };
}
const asked = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([request]) => request).filter((request) => request.path === EGRESS_ADDRESSES_PATH);
/** Waits until the page and the read have both settled (the upkeep section is drawn last of the page's own reads). */
const settled = async (f: ReturnType<typeof mount>) => { await screen.findByRole("heading", { name: "Company settings" }); await waitFor(() => expect(asked(f).length).toBeGreaterThan(0)); await new Promise((resolve) => setTimeout(resolve, 30)); };

describe("Rovara's outbound addresses, on Company settings", () => {
  it("an owner sees the line with both addresses, the sharing sentence and the 30 days; the page has no accessibility violations (O5)", async () => {
    const f = mount("owner", () => ok(ADDRESSES));
    const line = await screen.findByTestId("outbound-addresses");
    expect(line.textContent).toBe("Rovara's outbound addresses: 44.235.136.195, 44.226.134.187. They're shared by all companies on this Rovara, and we give 30 days' notice before they change.");
    expect(EGRESS_NOTICE_DAYS).toBe(30);
    expect(screen.getByTestId("outbound-addresses-scope").textContent).toBe("These are the addresses the machines that run tasks connect from. A few calls, such as connector and sign-in checks, don't use them yet. Also add your host to the project's allowed websites.");
    expect(screen.getByRole("region", { name: "Rovara's outbound addresses" })).toBeTruthy();
    expect(Array.from(line.querySelectorAll("code")).map((node) => node.textContent)).toEqual(ADDRESSES);
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("an admin sees it too, and a second company on the same Rovara sees the SAME addresses", async () => {
    const admin = mount("admin", () => ok(ADDRESSES));
    const first = (await screen.findByTestId("outbound-addresses")).textContent;
    admin.close();
    const other = mount("owner", () => ok(ADDRESSES), B);
    expect((await screen.findByTestId("outbound-addresses")).textContent).toBe(first);
    other.close();
  });

  it("sends one bare GET and nothing else: no body, no company, no write (O6)", async () => {
    const f = mount("owner", () => ok(ADDRESSES));
    await screen.findByTestId("outbound-addresses");
    const sent = asked(f);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.body).toBeUndefined();
    expect(f.request.mock.calls.map(([request]) => request).filter((request) => request.method !== "GET" && request.path.includes("egress"))).toEqual([]);
    f.close();
  });

  it("a plain member never reaches the page, and nothing is asked (O1)", async () => {
    const f = mount("member", () => ok(ADDRESSES));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByTestId("outbound-addresses")).toBeNull();
    expect(asked(f)).toEqual([]);
    f.close();
  });

  it("draws nothing for an empty list (an older Rovara), and no error (O2)", async () => {
    const f = mount("owner", () => ok([]));
    await settled(f);
    expect(screen.queryByTestId("outbound-addresses")).toBeNull();
    expect(screen.queryByRole("region", { name: "Rovara's outbound addresses" })).toBeNull();
    f.close();
  });

  it("draws nothing and no error when the read fails or is not the contract; the server's text never shows (O3, O4, O8)", async () => {
    const bad: ApiResponse[] = [
      err(404, "NOT_FOUND", LEAK), err(403, "FORBIDDEN", LEAK), err(503, "RUNTIME_UNAVAILABLE", LEAK), err(501, "NOT_ON_CODE_YET", LEAK),
      ok(["10.0.0.1"]), ok(["44.235.136.195", "44.235.136.195"]), ok(["not-an-address"]), ok([LEAK]), ok("44.235.136.195"), ok(undefined),
      { status: 200, body: { addresses: ADDRESSES, company: LEAK } }, { status: 200, body: [ADDRESSES] },
    ];
    for (const response of bad) {
      const f = mount("owner", () => response);
      await settled(f);
      expect(screen.queryByTestId("outbound-addresses")).toBeNull();
      expect(document.body.textContent).not.toContain(LEAK);
      expect(screen.queryByText(/outbound address/iu)).toBeNull();
      f.close();
    }
  });

  it("one address reads in the singular (O7)", async () => {
    const f = mount("owner", () => ok(["44.235.136.195"]));
    expect((await screen.findByTestId("outbound-addresses")).textContent).toBe("Rovara's outbound address: 44.235.136.195. It's shared by all companies on this Rovara, and we give 30 days' notice before it changes.");
    f.close();
  });
});

describe("readEgressAddresses", () => {
  it("is total: a list of up to four distinct public addresses, or a throw", () => {
    expect(readEgressAddresses({ addresses: [] })).toEqual([]);
    expect(readEgressAddresses({ addresses: ADDRESSES })).toEqual(ADDRESSES);
    for (const bad of [null, undefined, [], "x", 1, {}, { addresses: null }, { addresses: ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5"] }, { addresses: ["01.1.1.1"] }, { addresses: ["1.1.1.1 "] },
      { addresses: ["192.168.1.1"] }, { addresses: ["172.20.0.1"] }, { addresses: ["100.100.0.1"] }, { addresses: ["224.0.0.1"] }, { addresses: ADDRESSES, extra: 1 }]) {
      expect(() => readEgressAddresses(bad), JSON.stringify(bad)).toThrow();
    }
  });
});
