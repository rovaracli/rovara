// @vitest-environment jsdom
import { inViewerZones, VIEWER_INSTANT } from "./support/viewer-zones.js";
// PRODUCT-LEARNING-CONNECT-ROUTE: the Learning AI key page in the Hybrid 1 admin area (company admins). The key is write-only (sent once, never
// shown, never in the page after), every change is sent at once (no step-up since owner DEC 254zzz73), writes carry the provider, a request id and the revision read;
// the learning cap and the lessons-paused reasons are shown; "not connected yet" when Cloud has no product AI settings.
import { beforeEach, describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
// LEGACY HARNESS (WIRING-1B): this pinned test drives the screen that used to be mounted at /app/admin/{money/report,ai-spending,product-ai}; see support/legacy-admin-routes.ts.
import { appRoutes } from "./support/legacy-admin-routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { readLearningAi } from "../../packages/ui/src/api/admin-learning-ai.js";
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
const reasons = [{ reason: "lessons_off", message: "Lessons are switched off for this company, so no learning call is made." }, { reason: "no_provider", message: "Learning calls need the company's own connected AI provider account, and none is usable." }];
const view = (connected: boolean) => ({ revision: connected ? 3 : 2, canChange: true, accounts: { anthropic: connected ? { connected: true, updatedAt: Date.UTC(2026, 10, 15) } : { connected: false }, openai: { connected: false }, gemini: { connected: false } }, removed: [], learningCap: { monthlyUsdMicros: 20_000_000, companyMonthlyUsdMicros: 500_000_000 }, lessonsOn: true, pausedNow: connected ? [] : ["no_provider"], pauseReasons: reasons });

describe("learning AI key page", () => {
 it("uses the single AI and spending navigation home", () => {
  expect(visibleAdminGroups("owner", false).find(group => group.id === "ai")!.links.map(link => link.label)).toContain("AI and spending");
  expect(visibleAdminGroups("admin", false).find(group => group.id === "ai")?.links.map(link => link.label) ?? []).toContain("AI and spending");
  expect(visibleAdminGroups("owner", false).find(group => group.id === "ai")!.links.map(link => link.label)).not.toContain("Learning AI key");
 });
 it("reads only the shape it expects", () => {
  expect(readLearningAi({ ...view(true), accounts: { anthropic: { connected: true, updatedAt: "x" }, mistral: { connected: true } }, pausedNow: ["<b>", "no_provider"], removed: [{ provider: "mistral", recoverUntil: 1 }] }))
   .toMatchObject({ accounts: { anthropic: { connected: true }, openai: { connected: false } }, pausedNow: ["no_provider"], removed: [] });
  expect(() => readLearningAi({ accounts: {} })).toThrow();
  // DEC 254t: OpenRouter is listed only when Cloud lists it (its kind is switched on).
  expect(readLearningAi(view(true)).listed).toEqual(["anthropic", "openai", "gemini"]);
  expect(readLearningAi({ ...view(true), accounts: { ...view(true).accounts, openrouter: { connected: true } } }).listed).toEqual(["anthropic", "openai", "gemini", "openrouter"]);
 });
 it("shows the cap and why lessons are paused; the key field is there at once (no step-up)", async () => {
  const f = mount("/app/admin/learning-ai", () => ({ status: 200, body: view(false) }));
  try {
   expect(await screen.findByText(/a month on learning/u)).toBeTruthy();
   expect((await screen.findByTestId("paused-now")).textContent).toMatch(/none is usable/u);
   expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
   expect(screen.getByLabelText("Paste the Anthropic key")).toBeTruthy();
  } finally { f.close(); }
 });
 it("sends the key once with the provider, a request id and the revision read, and never shows it back", async () => {
  const sent: ApiRequest[] = [];
  let connected = false;
  const f = mount("/app/admin/learning-ai", (r) => { if (r.method === "PUT") { sent.push(r); connected = true; } return { status: 200, body: view(connected) }; });
  try {
   fireEvent.click(await screen.findByText("Connect company AI", { selector: "summary" }));
   const field = await screen.findByLabelText("Paste the Anthropic key");
   const secret = ["sk", "ant", "x".repeat(32)].join("-");
   fireEvent.change(field, { target: { value: secret } });
   fireEvent.click(screen.getAllByRole("button", { name: "Connect key" })[0]!);
   await waitFor(() => { expect(sent).toHaveLength(1); });
   expect(sent[0]!.path).toBe("/v1/app/org/learning-ai/key");
   const body = sent[0]!.body as Record<string, unknown>;
   expect(body).toMatchObject({ expectedRevision: 2, provider: "anthropic", key: secret });
   expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/u);
   await screen.findByText(/A key is connected/u);
   expect(document.body.innerHTML).not.toContain(secret);
  } finally { f.close(); }
 });
 it("says not connected yet when Cloud has no learning AI settings", async () => {
  const f = mount("/app/admin/learning-ai", () => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } }));
  try { expect(await screen.findByTestId("not-connected")).toBeTruthy(); } finally { f.close(); }
 });
});

it("renders the learning key's update time in both viewer zones", async () => {
 await inViewerZones(async expected => {
  const f = mount("/app/admin/learning-ai", () => ({ status: 200, body: { ...view(true), accounts: { ...view(true).accounts, anthropic: { connected: true, updatedAt: Date.parse(VIEWER_INSTANT) } } } }));
  try { expect(await screen.findByText(`last changed ${expected.short}`, { exact: false })).toBeTruthy(); } finally { f.close(); }
 });
});
