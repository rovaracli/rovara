// @vitest-environment jsdom
// Route gaps on hosted Rovara (live test run 2, 2026-11-18): a company admin page whose read Cloud does not serve on this install (Cloud's fixed 501 NOT_ON_CODE_YET) says
// "Not available on this Rovara yet." as a calm status, with no alert and no Retry, instead of "Couldn't load this information. Try again."; and the Second opinion link is
// hidden when its probe answers 501, as it already was for 404. Any other failure keeps the alert and Retry.
import { expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";


import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const member = { developerId: "b".repeat(64), name: "Maya", role: "member", identities: ["github"], joinedAt: "2026-10-01T00:00:00Z" };
function mount(options: { path?: string; role?: "owner" | "admin" | "member"; theme?: "light" | "dark"; enabled?: boolean; kind?: "web" | "desktop"; state?: unknown; width?: number; respond?: (r: ApiRequest) => Promise<ApiResponse> } = {}) {
 const role = options.role ?? "owner", nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { ...features, admin: options.enabled ?? true } });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => options.respond?.(r) ?? { status: 200, body: r.path === "/v1/app/nav" ? nav : r.path === "/v1/app/me" ? me : r.path === "/v1/app/home" ? { cards: [], total: 0 } : { members: [member] } });
 f.host.kind = options.kind ?? "web";
 f.host.viewport = { width: () => options.width ?? 1280, subscribe: () => () => undefined };
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", options.theme ?? "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [{ pathname: options.path ?? "/app/admin/people", state: options.state }] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, query, router, me, close: () => { view.unmount();router.dispose();query.clear(); } };
}


const ME = { developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] };
// Cloud's own fallback answer for a route it does not serve (packages/cloud-server/src/handler.ts), byte for byte.
const notOnCode = (path: string) => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: `${path} isn't connected to Rovara Code yet.` } } });
const installations = { installations: [{ installationId: 7, accountLogin: "Example", status: "active" }] };
function answering(missing: readonly string[], other: Record<string, ApiResponse> = {}) {
 return async (r: ApiRequest): Promise<ApiResponse> => other[r.path] ?? (missing.includes(r.path.split("?")[0]!) ? notOnCode(r.path.split("?")[0]!) : { status: 200, body: r.path === "/v1/app/me" ? ME : r.path === "/v1/app/github/installations" ? installations : r.path === "/v1/app/models" ? { models: [] } : {} });
}
const NOT_HERE = "Not available on this Rovara yet.";
function calm(region: HTMLElement) {
 expect(within(region).getByRole("status").textContent).toBe(NOT_HERE);
 expect(within(region).queryByRole("alert")).toBeNull();
 expect(within(region).queryByRole("button")).toBeNull();
 expect(region.textContent).not.toContain("isn't connected to Rovara Code yet");
}

it("AI models: company model sources not on this Rovara read as a calm status, never an alert or Retry", async () => {
 const f = mount({ path: "/app/admin/models/sources", respond: answering(["/v1/app/org/model-sources"]) });
 const region = await screen.findByRole("region", { name: "Model sources" });
 await waitFor(() => calm(region));
 expect(screen.queryByText(/Couldn't load/)).toBeNull();
 f.close();
});

it("Connections: the registry and GitHub install requests not on this Rovara are calm; GitHub's own read still shows", async () => {
 const f = mount({ path: "/app/admin/connections", respond: answering(["/v1/app/connections", "/v1/app/github/requests"]) });
 await screen.findAllByText(/Example/);
 const regions = screen.getAllByRole("status").filter((node) => node.textContent === NOT_HERE);
 expect(regions.length).toBeGreaterThanOrEqual(2);
 expect(screen.queryByText(/Couldn't load/)).toBeNull();
 expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
 f.close();
});

for (const [label, answer] of [
 ["a 501 with another code", { status: 501, body: { error: { code: "SOMETHING_ELSE", message: "x" } } }],
 ["a 400", { status: 400, body: { error: { code: "CONFIG_INVALID", message: "x" } } }],
 ["NOT_ON_CODE_YET with a status other than 501", { status: 400, body: { error: { code: "NOT_ON_CODE_YET", message: "x" } } }],
 ["a 409", { status: 409, body: { error: { code: "CONFLICT", message: "x" } } }],
] as const) it(`AI models: ${label} still shows the alert and Retry`, async () => {
 const f = mount({ path: "/app/admin/models/sources", respond: answering([], { "/v1/app/org/model-sources": answer }) });
 const region = await screen.findByRole("region", { name: "Model sources" });
 expect((await within(region).findByRole("alert")).textContent).toContain("Couldn't load this information");
 expect(within(region).getByRole("button", { name: "Retry model sources" })).toBeTruthy();
 expect(within(region).queryByText(NOT_HERE)).toBeNull();
 f.close();
});

for (const [status, code, shown] of [[501, "NOT_ON_CODE_YET", false], [404, "NOT_FOUND", false], [200, "", true]] as const) it(`the Second opinion link is ${shown ? "shown" : "hidden"} when its probe answers ${String(status)}`, async () => {
 const f = mount({ path: "/app/admin/people", respond: answering([], { "/v1/app/org/second-review": status === 200 ? { status, body: {} } : { status, body: { error: { code, message: "/v1/app/org/second-review isn't connected to Rovara Code yet." } } } }) });
 await screen.findByRole("link", { name: "People" });
 await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/org/second-review")).toBe(true));
 await waitFor(() => expect(screen.queryByRole("link", { name: "Second opinion" }) !== null).toBe(shown));
 f.close();
});
