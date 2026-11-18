// @vitest-environment jsdom
// DEC 254zzz63 (Code #1075): "Lessons learning model" in Company settings, AI. It shows what lessons learn with now and whose choice that is (the company's, or this Rovara's default,
// Claude Haiku 5.5 unless the install says otherwise); an owner or admin picks from the offered Claude models or goes back to the default; everyone else reads it. The answers here are
// Cloud's (the real Code answers, passed through Cloud's handler, are in tests/unit/learning-model-routes.test.ts). Refusals shown are the server's fixed sentences.
import { describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { LEARNING_MODEL_PATH, learningModelLabel, readLearningModel } from "../../packages/ui/src/api/learning-model.js";
import { LEARNING_MODEL_CARD_WORDS as W, LearningModelCard } from "../../packages/ui/src/screens/admin/ai-spending/LearningModelCard.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const me = "a".repeat(64);
const SONNET = "claude-sonnet-5-5", HAIKU = "claude-haiku-5-5";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
type Respond = (r: ApiRequest) => ApiResponse | Promise<ApiResponse>;
const view = (model: string | null, source: "company" | "install", over: Record<string, unknown> = {}) => {
 const offered = (over["offered"] as string[] | undefined) ?? [SONNET, HAIKU];
 return { model, source, offered, preselect: model !== null && offered.includes(model) ? model : offered[0] ?? null, canChange: true, ...over };
};

/** Cloud's two routes as a store: a read, and a save that applies the same rules the server does. */
function cloud(state: { model: string | null }, options: { canChange?: boolean; offered?: string[]; refuse?: ApiResponse } = {}) {
 const writes: ApiRequest[] = [];
 const reads: ApiRequest[] = [];
 const offered = options.offered ?? [SONNET, HAIKU];
 const answer = () => ({ status: 200, body: view(state.model ?? HAIKU, state.model === null ? "install" : "company", { offered, canChange: options.canChange ?? true }) });
 const respond: Respond = (r) => {
  if (r.path !== LEARNING_MODEL_PATH) return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  if (r.method === "GET") { reads.push(r); return options.refuse ?? answer(); }
  writes.push(r);
  if (options.refuse !== undefined) return options.refuse;
  state.model = (r.body as { model: string | null }).model;
  return answer();
 };
 return { respond, writes, reads, state };
}
function mountCard(role: string, respond: Respond) {
 const f = fakeHost(async r => respond(r));
 const query = createQueryClient();
 const router = createMemoryRouter([{ path: "/app/admin/ai-spending", element: h(LearningModelCard, { developerId: me, role }) }], { initialEntries: ["/app/admin/ai-spending"] });
 const rendered = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { ...f, close: () => { rendered.unmount(); router.dispose(); query.clear(); } };
}
/** The API client retries a failing read (1 s, then 2 s) before the card gives up, so a failed read is waited for. */
const FAILED_READ = [{}, { timeout: 8000 }] as const;
/** The whole Company settings page for an owner, to show the card sits on it. */
function mountPage(respond: Respond) {
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : respond(r)));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/ai-spending"] });
 const rendered = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, close: () => { rendered.unmount(); router.dispose(); query.clear(); } };
}

describe("readers", () => {
 it("read only the shape Cloud sends, and name Claude models readably", () => {
  expect(readLearningModel(view(HAIKU, "install"))).toEqual({ model: HAIKU, source: "install", offered: [SONNET, HAIKU], preselect: HAIKU, canChange: true });
  expect(readLearningModel(view(null, "install", { offered: [] }))).toMatchObject({ model: null, offered: [], preselect: null });
  const good = view(HAIKU, "install");
  for (const bad of [{ ...good, preselect: "other" }, { ...good, preselect: null }, { ...good, offered: [], preselect: HAIKU }, { ...good, offered: [HAIKU, HAIKU] }, { ...good, canChange: "yes" }, { ...good, source: "x" }, { ...good, model: 4 }, { ...good, offered: ["<b>"], preselect: "<b>" }, null, []]) expect(() => readLearningModel(bad)).toThrow();
  expect([learningModelLabel(HAIKU), learningModelLabel("claude-fable-5-2"), learningModelLabel("zai.glm-5"), learningModelLabel("claude-haiku-4-5")]).toEqual(["Claude Haiku 5.5", "Claude Fable 5.2", "zai.glm-5", "Claude Haiku 4.5"]);
 });
});

describe("Company settings, AI", () => {
 it("the card sits on the page beside the engine model card", async () => {
  const c = cloud({ model: null });
  const f = mountPage(c.respond);
  try {
   expect((await screen.findByTestId("learning-model-card")).textContent).toContain(W.title);
   expect(c.reads.length).toBeGreaterThan(0);
  } finally { f.close(); }
 });
});

describe("an owner or admin", () => {
 it("sees the default (Claude Haiku 5.5), the offered models with the preselected one picked, and no Use the default while on the default", async () => {
  const c = cloud({ model: null });
  const f = mountCard("owner", c.respond);
  try {
   expect((await screen.findByTestId("learning-model-current")).textContent).toBe(`Model: Claude Haiku 5.5 (${W.installDefault})`);
   const select = screen.getByLabelText<HTMLSelectElement>(W.pick);
   expect(select.value).toBe(HAIKU);
   expect([...select.options].map(o => o.value).filter(Boolean)).toEqual([SONNET, HAIKU]);
   expect(screen.queryByRole("button", { name: W.useDefault })).toBeNull();
   expect(screen.getByRole("button", { name: W.save }).hasAttribute("disabled")).toBe(false);
  } finally { f.close(); }
 });

 it("picks another model and saves exactly { model }: the card then shows the company's choice and offers Use the default", async () => {
  const c = cloud({ model: null });
  const f = mountCard("admin", c.respond);
  try {
   await screen.findByTestId("learning-model-current");
   fireEvent.change(screen.getByLabelText(W.pick), { target: { value: SONNET } });
   fireEvent.click(screen.getByRole("button", { name: W.save }));
   expect((await screen.findByTestId("learning-model-saved")).textContent).toBe(W.saved);
   expect(c.writes.map(w => [w.method, w.path, w.body])).toEqual([["PUT", LEARNING_MODEL_PATH, { model: SONNET }]]);
   await waitFor(() => { expect(screen.getByTestId("learning-model-current").textContent).toBe(`Model: Claude Sonnet 5.5 (${W.companyChoice})`); });
   // Already the company's choice: nothing to save until another is picked.
   expect(screen.getByRole("button", { name: W.save }).hasAttribute("disabled")).toBe(true);
   fireEvent.click(screen.getByRole("button", { name: W.useDefault }));
   await waitFor(() => { expect(screen.getByTestId("learning-model-saved").textContent).toBe(W.savedDefault); });
   expect(c.writes.map(w => w.body)).toEqual([{ model: SONNET }, { model: null }]);
   await waitFor(() => { expect(screen.getByTestId("learning-model-current").textContent).toBe(`Model: Claude Haiku 5.5 (${W.installDefault})`); });
  } finally { f.close(); }
 });

 it("keeping the default but choosing it explicitly is a save (it becomes the company's own choice)", async () => {
  const c = cloud({ model: null });
  const f = mountCard("owner", c.respond);
  try {
   await screen.findByTestId("learning-model-current");
   fireEvent.click(screen.getByRole("button", { name: W.save }));
   await screen.findByTestId("learning-model-saved");
   expect(c.writes.map(w => w.body)).toEqual([{ model: HAIKU }]);
   await waitFor(() => { expect(screen.getByTestId("learning-model-current").textContent).toContain(W.companyChoice); });
  } finally { f.close(); }
 });

 it("a refusal shows the server's fixed sentence, and the card reads again", async () => {
  const c = cloud({ model: null }, {});
  const refuse: ApiResponse = { status: 400, body: { error: { code: "MODEL_NOT_OFFERED", message: "That model isn't offered to this company now. Pick one from the list." } } };
  const f = mountCard("owner", r => (r.method === "PUT" ? refuse : c.respond(r)));
  try {
   await screen.findByTestId("learning-model-current");
   const before = c.reads.length;
   fireEvent.click(screen.getByRole("button", { name: W.save }));
   expect((await screen.findByTestId("learning-model-error")).textContent).toBe("That model isn't offered to this company now. Pick one from the list.");
   await waitFor(() => { expect(c.reads.length).toBeGreaterThan(before); });
  } finally { f.close(); }
 });

 it("a model the company holds but the gateway no longer offers says so, and no Claude model offered disables the choice", async () => {
  const stale = mountCard("owner", () => ({ status: 200, body: view(HAIKU, "company", { offered: [SONNET] }) }));
  try {
   expect((await screen.findByTestId("learning-model-stale")).textContent).toBe(W.notOffered);
   expect(screen.getByLabelText<HTMLSelectElement>(W.pick).value).toBe(SONNET);
  } finally { stale.close(); }
  const none = mountCard("owner", () => ({ status: 200, body: view(HAIKU, "install", { offered: [] }) }));
  try {
   expect((await screen.findByTestId("learning-model-none-offered")).textContent).toBe(W.noneOffered);
   expect(screen.queryByRole("button", { name: W.save })).toBeNull();
   expect(screen.queryByLabelText(W.pick)).toBeNull();
  } finally { none.close(); }
 });

 it("says plainly when this Rovara has no default", async () => {
  const f = mountCard("owner", () => ({ status: 200, body: view(null, "install", { offered: [SONNET] }) }));
  try { expect((await screen.findByTestId("learning-model-current")).textContent).toBe(`Model: ${W.noDefault} (${W.installDefault})`); } finally { f.close(); }
 });
});

describe("everyone else", () => {
 it("a plain member reads what lessons learn with and whose choice it is, with nothing to change and no write", async () => {
  const c = cloud({ model: SONNET }, { canChange: false });
  const f = mountCard("member", c.respond);
  try {
   expect((await screen.findByTestId("learning-model-current")).textContent).toBe(`Model: Claude Sonnet 5.5 (${W.companyChoice})`);
   expect(screen.getByTestId("learning-model-read-only").textContent).toBe(W.readOnly);
   expect(screen.queryByLabelText(W.pick)).toBeNull();
   expect(screen.queryByRole("button", { name: W.save })).toBeNull();
   expect(screen.queryByRole("button", { name: W.useDefault })).toBeNull();
   expect(f.request.mock.calls.map(([r]) => `${r.method} ${r.path}`)).toEqual([`GET ${LEARNING_MODEL_PATH}`]);
  } finally { f.close(); }
 });

 it("the server decides who may change: a member the page believes is an owner still gets no controls when the server says canChange false", async () => {
  const f = mountCard("owner", () => ({ status: 200, body: view(HAIKU, "install", { canChange: false }) }));
  try {
   await screen.findByTestId("learning-model-read-only");
   expect(screen.queryByRole("button", { name: W.save })).toBeNull();
  } finally { f.close(); }
 });
});

describe("a read that fails says fixed words, never the server's", () => {
 it.each([
  [501, W.notYet, false],
  [503, W.unavailable, true],
  [500, W.failed, true],
  [403, W.failed, true],
  [404, W.failed, true],
 ] as const)("%i", async (status, words, retry) => {
  const f = mountCard("owner", () => ({ status, body: { error: { code: "X", message: "private canary" } } }));
  try {
   expect((await screen.findByTestId("learning-model-read-error", ...FAILED_READ)).textContent).toBe(words);
   expect(document.body.textContent).not.toContain("private canary");
   expect(screen.queryByRole("button", { name: "Try again" }) !== null).toBe(retry);
  } finally { f.close(); }
 }, 15_000);

 it("Try again reads once more and the card then draws", async () => {
  let failing = true;
  const c = cloud({ model: null });
  const f = mountCard("owner", r => (failing ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } } : c.respond(r)));
  try {
   await screen.findByTestId("learning-model-read-error", ...FAILED_READ);
   failing = false;
   fireEvent.click(screen.getByRole("button", { name: "Try again" }));
   await screen.findByTestId("learning-model-current");
  } finally { f.close(); }
 }, 15_000);

 it("a body that is not the view is an unreadable answer, not a half-drawn card", async () => {
  const f = mountCard("owner", () => ({ status: 200, body: { model: HAIKU, source: "install", offered: [SONNET], preselect: SONNET, canChange: true, extra: 1 } }));
  try { expect(await screen.findByTestId("learning-model-current")).toBeTruthy(); } finally { f.close(); }
  const bad = mountCard("owner", () => ({ status: 200, body: { model: HAIKU, source: "install", offered: [SONNET], preselect: "other", canChange: true } }));
  try { expect((await screen.findByTestId("learning-model-read-error")).textContent).toBe(W.failed); } finally { bad.close(); }
 });
});
