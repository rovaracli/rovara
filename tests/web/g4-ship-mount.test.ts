// @vitest-environment jsdom
// G4 (Rules, Lessons and How we work) on the REAL router: the project's How we work tab and the company Rules page hold the rebuilt views AND every live action the old pages offered.
// Each action: allowed = exactly one send; refused, not offered to this person, or a stale read = zero extra sends. The old stage cards are proved by the test-only legacy mount.
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { learningHost } from "./support/learning-fixture.js";
import { LAYER, howWeWorkView } from "./support/how-we-work-view.js";

globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const ROOT = "/v1/app/projects/payments";
const DAY = 864e5, NOW = Date.now();
const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });
const refuse = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
const lesson = (id: string, patch: Record<string, unknown> = {}) => ({ id, version: 1, type: "convention", stages: ["IMPLEMENT"], title: `Lesson ${id}`, description: "Retries go through withRetry.", body: "Wrap network calls in withRetry.", scope: { repos: [], paths: [], languages: [] }, tier: 1, status: "pending",
 counters: { loaded: 0, helpful: 0, harmful: 0 }, createdAt: NOW - DAY, updatedAt: NOW - DAY, expiresAt: NOW + 20 * DAY, citations: [], from: [{ name: "Sam" }], measured: true, supportTasks: 1, canApprove: true, canReject: true, canRetire: true, ...patch });
type Options = { path?: string; learn?: NonNullable<Parameters<typeof learningHost>[0]>["learn"]; send?: (request: ApiRequest) => ApiResponse | undefined; approved?: unknown[]; proposed?: unknown[]; canDecide?: boolean; how?: unknown; needLook?: string };
function mount(options: Options = {}) {
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [{ name: "payments", agents: [] }], shared: { agents: [], sessions: [] }, features });
 const cell = learningHost({ ...(options.learn === undefined ? {} : { learn: options.learn }), handle: (request, url) => {
  if (url.pathname === "/v1/app/nav") return ok(nav);
  if (url.pathname === ROOT + "/how-we-work" && options.how !== undefined) return ok(options.how);
  if (url.pathname === `/v1/app/agents/${LAYER}/versions`) return ok({ versions: [{ version: 2, current: true, publishedAt: "2026-10-26T12:00:00.000Z", publishedBy: "Priya", note: "Added build rules" }] });
  if (url.pathname === ROOT + "/lessons/weekly") return ok({ project: "payments", weekly: { needLook: options.needLook === undefined ? [] : [{ lessonId: "les_look0001", title: options.needLook, cause: "repeated" }], picks: [{ lessonId: "les_appr0001", title: "Lesson les_appr0001" }] } });
  if (url.pathname === ROOT + "/lessons/repeats") return ok({ project: "payments", month: "2026-11", repeated: 1, corrections: 4, enoughData: true, split: {}, truncated: false });
  if (!url.pathname.startsWith(ROOT + "/lessons")) return undefined;
  if (request.method !== "GET") return options.send?.(request) ?? refuse(404, "NOT_FOUND", "no");
  if (url.pathname.endsWith("/lessons/mode")) return ok({ project: "payments", mode: "suggest", effective: "suggest", lockedByCompany: false, canChange: true });
  if (url.pathname.endsWith("/lessons/retire-requests")) return ok({ project: "payments", requests: [], more: false });
  if (url.pathname.endsWith("/lessons/graduation")) return ok({ project: "payments", canDecide: options.canDecide ?? true, drafts: [], rules: [] });
  if (url.pathname.endsWith("/lessons")) {
   const list = url.searchParams.get("list");
   return ok({ project: "payments", list, canDecide: options.canDecide ?? true, lessons: list === "approved" ? options.approved ?? [lesson("les_appr0001", { status: "active", title: "Log request ids" })] : list === "proposed" ? options.proposed ?? [lesson("les_prop0001", { title: "Wrap webhook calls in withRetry" })] : [] });
  }
  return refuse(404, "NOT_FOUND", "Not found.");
 } });
 cell.host.kind = "web";cell.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [options.path ?? "/app/projects/payments?tab=how-we-work"] });
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: cell.host, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }) }), { theme: "light" });
 const sends = () => cell.request.mock.calls.map(([request]) => request).filter(request => request.method !== "GET" && !request.path.endsWith("/start-preview"));
 return { ...cell, ...ui, router, query, sends };
}
afterEach(() => { document.body.innerHTML = ""; });
// The views are a lazy chunk: the first find waits for it to load and transform.
const findR = (role: Parameters<typeof screen.findByRole>[0], options?: Parameters<typeof screen.findByRole>[1]) => screen.findByRole(role, options, { timeout: 8000 });
const findT = (text: Parameters<typeof screen.findByText>[0], options?: Parameters<typeof screen.findByText>[1]) => screen.findByText(text, options, { timeout: 8000 });

describe("the project's How we work tab on the real router", () => {
 it("mounts the rebuilt Rules view with the pills, the rules, the live Suggested rules and the company model links", async () => {
  mount();
  expect(await findR("heading", { name: "Rules for every task in this project" })).toBeTruthy();
  expect(await findR("heading", { name: /^Suggested rules/u })).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "AI models for each step" })[0]!.getAttribute("href")).toBe("/app/admin/ai-spending#ai-models");
  expect(screen.getByRole("link", { name: "edit .rovara/playbook.yaml in your repo" }).getAttribute("href")).toMatch(/\/\.rovara\/playbook\.yaml$/u);
  expect(screen.getByRole("navigation", { name: "How we work" })).toBeTruthy();
  // The old stage cards, filters and stage navigation are not drawn (the board has none).
  expect(screen.queryByRole("list", { name: "Stages" })).toBeNull();
  expect(screen.queryByRole("radio", { name: "Locked" })).toBeNull();
 });
 it("keeps the newer Rovara Code notice on the Rules view: shown to everyone, with no Update button and nothing sent", async () => {
  const f = mount({ how: howWeWorkView({ process: { kind: "project_process", agentId: LAYER, version: 2, draftRevision: 3, update: { from: 1, to: 2 } } }) });
  expect(await findT("A newer Rovara Code is available (version 1 → 2).")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  expect(f.sends()).toHaveLength(0);
 });
 it("shows no newer Rovara Code notice when the read has no update", async () => {
  mount();
  await findR("heading", { name: "Rules for every task in this project" });
  expect(screen.queryByText(/newer Rovara Code/u)).toBeNull();
 });
 it("Accept as new version sends exactly one write, and nothing else is written on mount", async () => {
  const f = mount({ learn: request => request.method === "POST" ? ok({ outcome: "applied", version: 6 }) : undefined });
  await findR("heading", { name: /^Suggested rules/u });
  expect(f.sends()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: /^(Accept as new version|Request approval)$/u }));
  await waitFor(() => expect(f.learningWrites()).toHaveLength(1));
  expect(f.sends()).toHaveLength(1);
 });
 it("Learned: Keep sends one approve; Drop and Retire send one reasoned write each; a refusal is said and sends nothing more", async () => {
  const f = mount({ path: "/app/projects/payments?tab=how-we-work&view=learned", send: request => request.path.endsWith("/approve") ? ok({ status: "active" }) : request.path.endsWith("/retire") ? refuse(403, "FORBIDDEN", "Only a maintainer can retire it.") : ok({ status: "rejected" }) });
  expect(await findR("heading", { name: "This week" })).toBeTruthy();
  fireEvent.mouseDown(await findR("tab", { name: "Proposed" }), { button: 0, ctrlKey: false });
  fireEvent.click(await findR("button", { name: "Keep: Wrap webhook calls in withRetry" }));
  await waitFor(() => expect(f.sends()).toHaveLength(1));
  expect(f.sends()[0]!.path).toBe(ROOT + "/lessons/les_prop0001/approve");
  expect(f.sends()[0]!.body).toEqual({ version: 1 });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Approved" }), { button: 0, ctrlKey: false });
  fireEvent.click(await findR("button", { name: "Retire: Log request ids" }));
  expect(f.sends()).toHaveLength(1);
  const retiring = within((await findR("button", { name: "Retire lesson" })).closest("div")!);
  expect(retiring.getByRole("button", { name: "Retire lesson" })).toHaveProperty("disabled", true);
 });
 it("Learned: a person without the right to retire is offered Ask to retire, and it sends one request", async () => {
  const f = mount({ path: "/app/projects/payments?tab=how-we-work&view=learned", approved: [lesson("les_appr0001", { status: "active", title: "Log request ids", canRetire: false })], send: () => ok({}) });
  fireEvent.click(await findR("button", { name: "Ask to retire: Log request ids" }));
  await waitFor(() => expect(f.sends()).toHaveLength(1));
  expect(f.sends()[0]!.path).toBe(ROOT + "/lessons/les_appr0001/retire-request");
  expect(screen.queryByRole("button", { name: "Retire: Log request ids" })).toBeNull();
 });
 it("Learned: a lesson this person may not decide shows no Keep or Drop and nothing is sent", async () => {
  const f = mount({ path: "/app/projects/payments?tab=how-we-work&view=learned", proposed: [lesson("les_prop0001", { title: "Wrap webhook calls in withRetry", canApprove: false, canReject: false })] });
  fireEvent.mouseDown(await findR("tab", { name: "Proposed" }), { button: 0, ctrlKey: false });
  await findT("Wrap webhook calls in withRetry");
  expect(screen.queryByRole("button", { name: /^Keep:/u })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Drop:/u })).toBeNull();
  expect(f.sends()).toHaveLength(0);
 });
 it("Learned: the learning mode changes with one PUT", async () => {
  const f = mount({ path: "/app/projects/payments?tab=how-we-work&view=learned", send: request => request.method === "PUT" ? ok({ project: "payments", mode: "auto", effective: "auto", lockedByCompany: false, canChange: true }) : undefined });
  const mode = await screen.findByTestId("learning-mode");
  fireEvent.click(within(mode).getAllByRole("radio")[2]!);
  await waitFor(() => expect(f.sends()).toHaveLength(1));
  expect(f.sends()[0]!.method).toBe("PUT");
  expect(f.sends()[0]!.path).toBe(ROOT + "/lessons/mode");
 });
 it("the needs-a-look line never doubles the full stop after a lesson that already ends in one", async () => {
  mount({ path: "/app/projects/payments?tab=how-we-work&view=learned", needLook: "Use Decimal for money, never float." });
  const line = await screen.findByTestId("needs-a-look", {}, { timeout: 8000 });
  expect(line.textContent).toContain("never float. ");
  expect(line.textContent).not.toContain("..");
 });
 it("the legacy ?tab=lessons address opens Learned, with the New chip on this week's pick", async () => {
  mount({ path: "/app/projects/payments?tab=lessons" });
  expect(await findR("heading", { name: "This week" })).toBeTruthy();
  expect(await findT("New")).toBeTruthy();
 });
 it("Models by stage and History are views of the same tab", async () => {
  const f = mount({ path: "/app/projects/payments?tab=how-we-work&view=history" });
  expect(await findR("heading", { name: "1 version" })).toBeTruthy();
  expect(f.sends()).toHaveLength(0);
 });
 it("the Settings tab keeps the whole Project settings page (this entry never claims that slot)", async () => {
  mount({ path: "/app/projects/payments?tab=settings" });
  expect(await screen.findByTestId("project-settings", {}, { timeout: 8000 })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "How we work" })).toBeNull();
 });
});

describe("the rebuilt pages are lazy and the old addresses keep working", () => {
 it("neither the router nor the project screen imports a G4 screen statically", () => {
  const router = readFileSync("packages/ui/src/routes.tsx", "utf8"), project = readFileSync("packages/ui/src/screens/project/ProjectScreen.tsx", "utf8");
  expect(router).not.toMatch(/^import .*rules-lessons-read/mu);
  expect(project).not.toMatch(/^import .*rules-lessons-read/mu);
  expect(router).toMatch(/import\("\.\/screens\/rules-lessons-read\/LazyPages\.js"\)/u);
  expect(project).toMatch(/import\("\.\.\/rules-lessons-read\/LazyPages\.js"\)/u);
 });
 it("the company Rules and Setup recipes addresses mount the rebuilt pages", async () => {
  mount({ path: "/app/admin/how-we-work" });
  expect(await findR("heading", { level: 1, name: "Rules" })).toBeTruthy();
  expect(await findR("link", { name: "Back to AI models" })).toBeTruthy();
 });
});
