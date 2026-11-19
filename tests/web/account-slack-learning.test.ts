// @vitest-environment jsdom
// "Don't learn from my Slack messages" on Your account (L4-SRC-SL): the person's own switch, read and set as the session's person with the one choice in the body, a fixed word for what was saved or failed,
// and nothing shown while Code serves no such route or the setting cannot be read.
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { LESSONS_SLACK_PATH, readLessonsSlackSwitch } from "../../packages/ui/src/api/lessons-slack.js";
import { SLACK_LEARNING_WORDS } from "../../packages/ui/src/screens/account/SlackLearningSwitch.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const NOT_ON_CODE = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } };
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const SIGN_INS = { signIns: [{ method: "github", primary: true }], linkable: ["slack", "github"] };
const seeded = new Map<string, string>();
beforeEach(() => { seeded.clear(); });

function mount(path: string, respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>) {
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : r.path === "/v1/app/me/sign-ins" ? ok(SIGN_INS) : respond(r)));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 for (const [key, value] of seeded) f.storage.set(key, value);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, router, query, close: () => { view.unmount(); router.dispose(); query.clear(); cleanup(); } };
}

const writes = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET");
const section = async () => within(await screen.findByTestId("slack-learning"));

describe("the Slack learning switch reader", () => {
 it("reads exactly { optOut: boolean } and drops anything else", () => {
  expect(readLessonsSlackSwitch({ optOut: true, token: "x" })).toEqual({ optOut: true });
  expect(readLessonsSlackSwitch({ optOut: false })).toEqual({ optOut: false });
  for (const bad of [{}, { optOut: "yes" }, { optOut: null }, [], "x", null, 4]) expect(() => readLessonsSlackSwitch(bad)).toThrow();
 });
});

describe("Don't learn from my Slack messages on Your account", () => {
 it("shows the person's own setting, off by default, with what it means", async () => {
  const f = mount("/app/account", r => (r.path === LESSONS_SLACK_PATH ? ok({ optOut: false }) : ok({})));
  try { const s = await section(); expect(s.getByRole("switch", { name: SLACK_LEARNING_WORDS.LABEL }).getAttribute("aria-checked")).toBe("false"); expect(s.getByText(/once, when its work ends/)).toBeTruthy(); } finally { f.close(); }
 });
 it("shows it on when the person turned it on", async () => {
  const f = mount("/app/account", r => (r.path === LESSONS_SLACK_PATH ? ok({ optOut: true }) : ok({})));
  try { const s = await section(); expect(s.getByRole("switch", { name: SLACK_LEARNING_WORDS.LABEL }).getAttribute("aria-checked")).toBe("true"); } finally { f.close(); }
 });
 it("sets it with the one choice as the body and nothing else, and says the fixed word for what was saved", async () => {
  let stored = false;
  const f = mount("/app/account", r => (r.method === "PUT" && r.path === LESSONS_SLACK_PATH ? (stored = (r.body as { optOut: boolean }).optOut, ok({ optOut: stored })) : r.path === LESSONS_SLACK_PATH ? ok({ optOut: stored }) : ok({})));
  try {
   const s = await section();
   fireEvent.click(s.getByRole("switch", { name: SLACK_LEARNING_WORDS.LABEL }));
   await waitFor(() => expect(s.getByRole("status").textContent).toBe(SLACK_LEARNING_WORDS.ON));
   expect(writes(f)).toEqual([expect.objectContaining({ method: "PUT", path: LESSONS_SLACK_PATH, body: { optOut: true } })]);
   await waitFor(() => expect(s.getByRole("switch", { name: SLACK_LEARNING_WORDS.LABEL }).getAttribute("aria-checked")).toBe("true"));
   fireEvent.click(s.getByRole("switch", { name: SLACK_LEARNING_WORDS.LABEL }));
   await waitFor(() => expect(s.getByRole("status").textContent).toBe(SLACK_LEARNING_WORDS.OFF));
  } finally { f.close(); }
 });
 it("says a fixed sentence when saving fails, never the server's words", async () => {
  const f = mount("/app/account", r => (r.method === "PUT" ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "SECRET words" } } } : r.path === LESSONS_SLACK_PATH ? ok({ optOut: false }) : ok({})));
  try {
   const s = await section();
   fireEvent.click(s.getByRole("switch", { name: SLACK_LEARNING_WORDS.LABEL }));
   await waitFor(() => expect(s.getByRole("alert")).toBeTruthy());
   expect(s.getByRole("alert").textContent).not.toContain("SECRET");
  } finally { f.close(); }
 });
 it("shows nothing while Code serves no such route, or the setting cannot be read", async () => {
  for (const answer of [NOT_ON_CODE, ok({ nope: 1 }), { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } }]) {
   const f = mount("/app/account", r => (r.path === LESSONS_SLACK_PATH ? answer : ok({})));
   try { await screen.findByRole("region", { name: "Your account" }); await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path === LESSONS_SLACK_PATH)).toBe(true)); await new Promise(resolve => setTimeout(resolve, 50)); expect(screen.queryByTestId("slack-learning")).toBeNull(); } finally { f.close(); }
  }
 });
 it("has no accessibility violations", async () => {
  const f = mount("/app/account", r => (r.path === LESSONS_SLACK_PATH ? ok({ optOut: false }) : ok({})));
  try { await section(); await expectNoAxeViolations(f.container); } finally { f.close(); }
 });
});
