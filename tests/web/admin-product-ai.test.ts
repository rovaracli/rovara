// @vitest-environment jsdom
// B7: the Product AI keys page in the Hybrid 1 admin area. The key is write-only (sent once, never shown, never in the page after), every change waits
// for the fresh sign-in step, writes carry a request id and the revision read, and "not connected yet" when Cloud has no product AI settings.
import { beforeEach, describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { readProductAi, usdToMicros } from "../../packages/ui/src/api/admin-product-ai.js";
import { visibleAdminGroups } from "../../packages/ui/src/screens/admin/admin-nav.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const seeded = new Map<string, string>();
beforeEach(() => { seeded.clear(); });
function mount(path: string, respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>) {
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : respond(r)));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 for (const [key, value] of seeded) f.storage.set(key, value);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}
function confirmedPath(path: string, nonce = "n-1"): string { seeded.set("rovara.stepup.nonce", JSON.stringify({ nonce, at: Date.now() })); return `${path}?confirmed=${nonce}`; }
const view = (connected: boolean) => ({ project: "web", revision: 3, canChange: true, key: connected ? { connected: true, updatedAt: Date.UTC(2026, 10, 15) } : { connected: false }, removedUntil: null, evalBudget: { calls: 400, costMicros: 4_000_000 }, evalApproval: null });
async function open(project = "web") {
 fireEvent.change(await screen.findByLabelText("Project"), { target: { value: project } });
 fireEvent.click(screen.getByRole("button", { name: "Open" }));
}

describe("product AI keys page", () => {
 it("is a link in AI and connections", () => {
  expect(visibleAdminGroups("owner", false).find(group => group.id === "ai")!.links.map(link => link.label)).toContain("Product AI keys");
 });
 it("reads only the shape it expects", () => {
  expect(readProductAi({ ...view(true), key: { connected: true, updatedAt: "x" }, evalBudget: "nope" })).toMatchObject({ key: { connected: true }, evalBudget: { calls: 400, costMicros: 4_000_000 } });
  expect(() => readProductAi({ project: "web" })).toThrow();
  expect(usdToMicros("4.5")).toBe(4_500_000); expect(usdToMicros("x")).toBeUndefined(); expect(usdToMicros("1.1234567")).toBeUndefined();
 });
 it("asks for the fresh sign-in before any change, and shows no key field until then", async () => {
  const f = mount("/app/admin/product-ai", () => ({ status: 200, body: view(false) }));
  try {
   await open();
   expect(await screen.findByText(/No key is connected/u)).toBeTruthy();
   expect(screen.getByTestId("fresh-sign-in")).toBeTruthy();
   expect(screen.queryByLabelText("Paste the AI Studio key")).toBeNull();
  } finally { f.close(); }
 });
 it("sends the key once with a request id and the revision read, and never shows it back", async () => {
  const sent: ApiRequest[] = [];
  let connected = false;
  const f = mount(confirmedPath("/app/admin/product-ai"), (r) => { if (r.method === "PUT") { sent.push(r); connected = true; } return { status: 200, body: view(connected) }; });
  try {
   await open();
   const field = await screen.findByLabelText("Paste the AI Studio key");
   const secret = ["AI", "za"].join("") + "x".repeat(35);
   fireEvent.change(field, { target: { value: secret } });
   fireEvent.click(screen.getByRole("button", { name: "Connect key" }));
   await waitFor(() => { expect(sent).toHaveLength(1); });
   expect(sent[0]!.path).toBe("/v1/app/projects/web/product-ai/key");
   const body = sent[0]!.body as Record<string, unknown>;
   expect(body).toMatchObject({ expectedRevision: 3, key: secret });
   expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/u);
   await screen.findByText(/A key is connected/u);
   expect(document.body.innerHTML).not.toContain(secret);
  } finally { f.close(); }
 });
 it("says not connected yet when Cloud has no product AI settings", async () => {
  const f = mount("/app/admin/product-ai", () => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } }));
  try { await open(); expect(await screen.findByTestId("not-connected")).toBeTruthy(); } finally { f.close(); }
 });
});
