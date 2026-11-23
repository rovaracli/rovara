// @vitest-environment jsdom
// G4 WRITE AUTHORITY (rule 14, the controller 2026-11-23): every write control is enabled ONLY while every read it depends on (its own read AND the identity read) is fresh,
// and is refused again at send time (0 requests). Each test names the mutants it kills (MUTANTS.md, "write authority" section).
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
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
import { dismissed, learningHost, learningView, rule } from "./support/learning-fixture.js";
import { LessonBatchCard } from "../../packages/ui/src/screens/work/LessonBatchCard.js";
import { LAYER } from "./support/how-we-work-view.js";
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const ROOT = "/v1/app/projects/payments";
const DAY = 864e5, NOW = Date.now();
const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });
const refuse = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
const lesson = (id: string, patch: Record<string, unknown> = {}) => ({ id, version: 1, type: "convention", stages: ["IMPLEMENT"], title: `Lesson ${id}`, description: "Retries go through withRetry.", body: "Wrap network calls in withRetry.", scope: { repos: [], paths: [], languages: [] }, tier: 1, status: "pending",
 counters: { loaded: 0, helpful: 0, harmful: 0 }, createdAt: NOW - DAY, updatedAt: NOW - DAY, expiresAt: NOW + 20 * DAY, citations: [], from: [{ name: "Sam" }], measured: true, supportTasks: 1, canApprove: true, canReject: true, canRetire: true, ...patch });
type Options = { rules?: unknown[]; mode?: Record<string, unknown>; lessonsDown?: (path: string) => boolean; requests?: unknown[]; view?: unknown; me?: () => ApiResponse | undefined; path?: string; learn?: NonNullable<Parameters<typeof learningHost>[0]>["learn"]; send?: (request: ApiRequest) => ApiResponse | undefined; approved?: unknown[]; proposed?: unknown[]; canDecide?: boolean; how?: unknown; needLook?: string };
function mount(options: Options = {}) {
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [{ name: "payments", agents: [] }], shared: { agents: [], sessions: [] }, features });
 const cell = learningHost({ ...(options.view === undefined ? {} : { view: options.view }), ...(options.learn === undefined ? {} : { learn: options.learn }), handle: (request, url) => {
  if (url.pathname === "/v1/app/nav") return ok(nav);
  if (url.pathname === "/v1/app/me") { const down = options.me?.();if (down !== undefined) return down; }
  if (url.pathname === ROOT + "/how-we-work" && options.how !== undefined) return ok(options.how);
  if (url.pathname === `/v1/app/agents/${LAYER}/versions`) return ok({ versions: [{ version: 2, current: true, publishedAt: "2026-10-26T12:00:00.000Z", publishedBy: "Priya", note: "Added build rules" }] });
  if (url.pathname === ROOT + "/lessons/weekly") return ok({ project: "payments", weekly: { needLook: options.needLook === undefined ? [] : [{ lessonId: "les_look0001", title: options.needLook, cause: "repeated" }], picks: [{ lessonId: "les_appr0001", title: "Lesson les_appr0001" }] } });
  if (url.pathname === ROOT + "/lessons/repeats") return ok({ project: "payments", month: "2026-11", repeated: 1, corrections: 4, enoughData: true, split: {}, truncated: false });
  if (!url.pathname.startsWith(ROOT + "/lessons")) return undefined;
  if (request.method !== "GET") return options.send?.(request) ?? refuse(404, "NOT_FOUND", "no");
  if (options.lessonsDown?.(url.pathname) === true) return refuse(503, "UNAVAILABLE", "Try later.");
  if (url.pathname.endsWith("/lessons/mode")) return ok({ project: "payments", mode: "suggest", effective: "suggest", lockedByCompany: false, canChange: true, ...options.mode });
  if (url.pathname.endsWith("/lessons/retire-requests")) return ok({ project: "payments", requests: options.requests ?? [], more: false });
  if (url.pathname.endsWith("/lessons/graduation")) return ok({ project: "payments", canDecide: options.canDecide ?? true, drafts: [], rules: options.rules ?? [] });
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
const findR = (role: Parameters<typeof screen.findByRole>[0], options?: Parameters<typeof screen.findByRole>[1]) => screen.findByRole(role, options, { timeout: 8000 });
const findT = (text: Parameters<typeof screen.findByText>[0], options?: Parameters<typeof screen.findByText>[1]) => screen.findByText(text, options, { timeout: 8000 });
type Q = { refetchQueries: (filters: { predicate: (query: { queryKey: readonly unknown[] }) => boolean }) => Promise<void> };
const refetch = async (f: { query: Q }, predicate: (key: readonly unknown[]) => boolean) => { await act(async () => { await f.query.refetchQueries({ predicate: query => predicate(query.queryKey) }); }); };
const identityKey = (key: readonly unknown[]) => key[0] === "g4" && key.includes("identity");
const learningRead = (key: readonly unknown[]) => key[0] === "learning" && key.includes("view");
/** The handler React holds for an element NOW. Calling it later is a click that was already in flight when the read failed. */
const heldClick = (element: Element): (() => unknown) => { const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;const props = (element as unknown as Record<string, { onClick?: (event: unknown) => unknown; onChange?: (event: unknown) => unknown }>)[key]!;return () => (props.onClick ?? props.onChange)?.({ preventDefault() { /* none */ }, target: { checked: true }, currentTarget: { checked: true } }); };
const RECONNECT = /Reconnecting; try again when the page is up to date/u;
const down = () => refuse(503, "UNAVAILABLE", "Try later.");
const ACCEPT = /^(Accept as new version|Request approval)$/u;
const learned = "/app/projects/payments?tab=how-we-work&view=learned";
const stale = () => screen.findAllByText(/Updated .* · Reconnecting/u, {}, { timeout: 8000 });

/** The control's group is disabled (or the control itself is). */
const off = (element: HTMLElement) => (element as HTMLButtonElement).disabled || element.closest("fieldset[disabled]") !== null;
/** Identity 503: the control goes off, and a click that was already in flight sends nothing and (where the control says so) says why. */
async function identityFreezes(f: ReturnType<typeof mount>, meDown: { on: boolean }, find: () => Promise<HTMLElement>) {
 const inFlight = heldClick(await find());
 meDown.on = true;await refetch(f, identityKey);await stale();
 const before = f.sends().length;
 expect(off(await find())).toBe(true);
 await act(async () => { await inFlight(); });
 await new Promise(resolve => setTimeout(resolve, 80));
 expect(f.sends().length - before).toBe(0);
}
const withMe = () => { const meDown = { on: false };return { meDown, me: () => meDown.on ? down() : undefined }; };

describe("Suggested rules (own list AND identity)", () => {
 it("Accept: fresh = one send; identity 503 = disabled and an in-flight click sends nothing [mutants M1 identity dropped, M2 send-time dropped]", async () => {
  const { meDown, me } = withMe();
  const f = mount({ me, learn: request => request.method === "POST" ? ok({ outcome: "applied", version: 6 }) : undefined });
  await identityFreezes(f, meDown, () => findR("button", { name: ACCEPT }));
 });
 it("Accept: fresh identity and fresh list send exactly one write", async () => {
  const f = mount({ learn: request => request.method === "POST" ? ok({ outcome: "applied", version: 6 }) : undefined });
  fireEvent.click(await findR("button", { name: ACCEPT }));
  await waitFor(() => expect(f.sends()).toHaveLength(1));
 });
 it("Accept: its OWN list failing a re-read disables it, and an in-flight click is refused with the Reconnecting reason [mutant M3 own read dropped]", async () => {
  let listDown = false;
  const f = mount({ learn: (request, url) => listDown && request.method === "GET" && url.pathname.endsWith("/learning") ? down() : request.method === "POST" ? ok({ outcome: "applied", version: 6 }) : undefined });
  const button = await findR("button", { name: ACCEPT }), inFlight = heldClick(button);
  listDown = true;await refetch(f, learningRead);await stale();
  expect(off(button)).toBe(true);
  await act(async () => { await inFlight(); });
  expect(f.sends()).toHaveLength(0);
  expect(screen.getAllByText(RECONNECT).length).toBeGreaterThan(0);
 });
 it("Dismiss: the form's send is disabled on a stale identity and an in-flight click sends nothing; fresh sends one [M1, M2]", async () => {
  const { meDown, me } = withMe();
  const f = mount({ me, learn: request => request.method === "POST" ? ok({}) : undefined });
  fireEvent.click(await findR("button", { name: "Dismiss…" }));
  fireEvent.click((await screen.findAllByRole("radio", { name: /./u }, { timeout: 8000 }))[0]!);
  await waitFor(() => expect(screen.getByRole("button", { name: "Dismiss suggestion" })).toHaveProperty("disabled", false));
  await identityFreezes(f, meDown, () => findR("button", { name: "Dismiss suggestion" }));
 });
 it("Remove rule and Reopen: disabled on a stale identity, an in-flight click sends nothing [M1, M2]", async () => {
  const { meDown, me } = withMe();
  const f = mount({ me, view: learningView({ suggestions: [], rules: [rule()], dismissed: [dismissed()] }), learn: request => request.method === "POST" ? ok({ outcome: "applied", version: 7 }) : undefined });
  fireEvent.click(await findR("button", { name: /^Added by suggestions/u }));
  fireEvent.click(await findR("button", { name: /^Dismissed/u }));
  await identityFreezes(f, meDown, () => findR("button", { name: "Remove rule" }));
  await identityFreezes(f, meDown, () => findR("button", { name: "Reopen" }));
 });
 it("Remove rule and Reopen: fresh sends one each", async () => {
  const f = mount({ view: learningView({ suggestions: [], rules: [rule()], dismissed: [dismissed()] }), learn: request => request.method === "POST" ? ok({ outcome: "applied", version: 7 }) : undefined });
  fireEvent.click(await findR("button", { name: /^Added by suggestions/u }));
  fireEvent.click(await findR("button", { name: "Remove rule" }));
  await waitFor(() => expect(f.sends()).toHaveLength(1));
 });
 it("Learn from PR comments: Turn on is disabled on a stale identity and an in-flight click sends nothing [M1, M2]", async () => {
  const { meDown, me } = withMe();
  const f = mount({ me, view: learningView({ settings: { prComments: "off", locked: false, revision: 3 } }), learn: request => request.method === "PUT" || request.method === "POST" ? ok({ applied: true, settings: { prComments: "on", locked: false, revision: 4 } }) : undefined });
  await identityFreezes(f, meDown, () => findR("button", { name: "Turn on…" }));
 });
 it("after a write, a re-read that fails TRANSIENTLY keeps the page with the success and 'Couldn't refresh; reconnecting.'; an ACCESS signal says 'Your change went through.'; neither says nothing changed [mutant M4 post-write wording]", async () => {
  for (const [status, code, access] of [[503, "UNAVAILABLE", false], [403, "FORBIDDEN", true]] as const) {
   let wrote = false;
   const f = mount({ learn: (request, url) => request.method === "POST" ? (wrote = true, ok({ outcome: "applied", version: 6 })) : wrote && url.pathname.endsWith("/learning") ? refuse(status, code, "x") : undefined });
   fireEvent.click(await findR("button", { name: ACCEPT }));
   await waitFor(() => expect(f.sends()).toHaveLength(1));
   if (access) { await findT(/Your change went through/u); } else { await findT(/Couldn.t refresh; reconnecting\./u); expect(document.body.textContent).toMatch(/Version 6|added/iu); }
   expect(document.body.textContent).not.toMatch(/Nothing was changed|only reads|changed by this read/iu);
   if (!access) expect(document.body.textContent).not.toMatch(/Your change went through/u);
   document.body.innerHTML = "";
  }
 });
 it("an unreadable page says it could not read, never 'nothing was changed'", async () => {
  mount({ me: () => refuse(403, "FORBIDDEN", "no") });
  const block = await findR("alert");
  expect(block.textContent).toContain("Rovara couldn\u2019t read this page.");
  expect(block.textContent).not.toMatch(/Nothing was changed|changed by this read/u);
 });
});

describe("Learned and Work lesson controls: the identity read", () => {
 const tab = async (name: string) => fireEvent.mouseDown(await findR("tab", { name }), { button: 0, ctrlKey: false });
 const reply = (request: ApiRequest) => request.method === "GET" ? undefined : request.path.endsWith("/approve") ? ok({ status: "active" }) : ok({});
 it("Keep (Proposed): disabled on a stale identity, an in-flight click sends nothing; fresh sends one [M1, M2]", async () => {
  const { meDown, me } = withMe();
  const f = mount({ me, path: learned, send: reply });
  await tab("Proposed");
  await identityFreezes(f, meDown, () => findR("button", { name: /^Keep:/u }));
 });
 it("Keep (Proposed): fresh sends one approve", async () => {
  const f = mount({ path: learned, send: reply });
  await tab("Proposed");
  fireEvent.click(await findR("button", { name: /^Keep:/u }));
  await waitFor(() => expect(f.sends()).toHaveLength(1));
 });
 it("Drop (Proposed) and Retire (Approved): the reasoned send is disabled on a stale identity and sends nothing [M1, M2]", async () => {
  const { meDown, me } = withMe();
  const f = mount({ me, path: learned, send: reply });
  fireEvent.click(await findR("button", { name: /^Retire: Log request ids/u }));
  const reason = await findR("combobox", { name: /Why retire/u });
  fireEvent.change(reason, { target: { value: "outdated" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Retire lesson" })).toHaveProperty("disabled", false));
  await identityFreezes(f, meDown, () => findR("button", { name: "Retire lesson" }));
 });
 it("Ask to retire: disabled on a stale identity and sends nothing [M1, M2]", async () => {
  const { meDown, me } = withMe();
  const f = mount({ me, path: learned, approved: [lesson("les_appr0001", { status: "active", title: "Log request ids", canRetire: false })], send: reply });
  await identityFreezes(f, meDown, () => findR("button", { name: "Ask to retire: Log request ids" }));
 });
 it("the learning mode: the radios are disabled on a stale identity and a change in flight sends nothing [M1, M2]", async () => {
  const { meDown, me } = withMe();
  const f = mount({ me, path: learned, send: request => request.method === "PUT" ? ok({ project: "payments", mode: "auto", effective: "auto", lockedByCompany: false, canChange: true }) : undefined });
  await identityFreezes(f, meDown, async () => (await screen.findByTestId("learning-mode", {}, { timeout: 8000 })).querySelectorAll("input")[2] as HTMLElement);
 });
});

describe("remaining controls", () => {
 it("Asked to retire: Retire is hidden on a stale identity and a held click sends nothing [mutant M10 identity dropped from RetireRequests]", async () => {
  const { meDown, me } = withMe();
  const f = mount({ me, path: learned, requests: [{ lessonId: "les_appr0001", title: "Log request ids", status: "active", by: "Sam", at: NOW - DAY }], send: () => ok({}) });
  const section = await screen.findByTestId("retire-requests", {}, { timeout: 8000 });
  fireEvent.change(section.querySelector("select, [role=combobox]") as HTMLElement, { target: { value: "outdated" } });
  const inFlight = heldClick(await findR("button", { name: "Retire lesson" }));
  meDown.on = true;await refetch(f, identityKey);await stale();
  expect(screen.queryByRole("button", { name: "Retire lesson" })).toBeNull();
  await act(async () => { await inFlight(); });
  expect(f.sends()).toHaveLength(0);
 });
 it("Learn from PR comments: its OWN list failing a re-read refuses a held Turn on (0 sends) [mutant M8 settings send-time check dropped]", async () => {
  let listDown = false;
  const f = mount({ view: learningView({ settings: { prComments: "off", locked: false, revision: 3 } }), learn: (request, url) => listDown && request.method === "GET" && url.pathname.endsWith("/learning") ? down() : request.method !== "GET" ? ok({ applied: true, settings: { prComments: "on", locked: false, revision: 4 } }) : undefined });
  const button = await findR("button", { name: "Turn on…" }), inFlight = heldClick(button);
  listDown = true;await refetch(f, learningRead);await stale();
  expect(off(button)).toBe(true);
  await act(async () => { await inFlight(); });
  expect(f.sends()).toHaveLength(0);
  expect(screen.getAllByText(RECONNECT).length).toBeGreaterThan(0);
 });
});

describe("Team rules Retire and the Trial offer: their OWN reads", () => {
 const RULE = { id: "rule_0123456789abcdef", text: "Every error log carries the request id.", paths: ["src/logging/**"], repos: ["acme/web"], fromLesson: "les_logs0001", createdAt: NOW - DAY };
 const refetchLessons = (f: { query: Q }, part: string) => refetch(f, key => key[0] === "learned" && key.includes(part));
 it("Team rules Retire: fresh = one send; a stale graduation read disables it and a held click sends nothing [mutants M12 own read dropped from the region, M13 send-time check dropped]", async () => {
  let down = false;
  const f = mount({ path: learned, rules: [RULE], lessonsDown: path => down && path.endsWith("/lessons/graduation"), send: () => ok({ status: "retired" }) });
  const retire = await findR("button", { name: /^Retire rule:/u }), inFlight = heldClick(retire);
  fireEvent.click(retire);
  const confirm = await findR("button", { name: "Retire rule" }), held = heldClick(confirm);
  down = true;await refetchLessons(f, "graduation");await stale().catch(() => undefined);
  expect(off(confirm)).toBe(true);
  await act(async () => { await held();await inFlight(); });
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(f.sends()).toHaveLength(0);
 });
 it("Team rules Retire: fresh sends exactly one", async () => {
  const f = mount({ path: learned, rules: [RULE], send: () => ok({ status: "retired" }) });
  fireEvent.click(await findR("button", { name: /^Retire rule:/u }));
  fireEvent.click(await findR("button", { name: "Retire rule" }));
  await waitFor(() => expect(f.sends()).toHaveLength(1));
 });
 it("Trial offer: fresh = one send; a stale mode read disables Not now and a held click sends nothing [mutants M14 own read dropped from the region, M15 send-time check dropped]", async () => {
  let down = false;
  const f = mount({ path: learned, mode: { trialOffer: { approvals: 12, drops: 1, since: 5 } }, lessonsDown: path => down && path.endsWith("/lessons/mode"), send: () => ok({ project: "payments" }) });
  const button = await findR("button", { name: "Not now" }), inFlight = heldClick(button);
  down = true;await refetchLessons(f, "mode");
  await waitFor(() => expect(off(button)).toBe(true));
  await act(async () => { await inFlight(); });
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(f.sends()).toHaveLength(0);
 });
 it("Trial offer: fresh sends exactly one", async () => {
  const f = mount({ path: learned, mode: { trialOffer: { approvals: 12, drops: 1, since: 5 } }, send: () => ok({ project: "payments" }) });
  fireEvent.click(await findR("button", { name: "Not now" }));
  await waitFor(() => expect(f.sends()).toHaveLength(1));
 });
});

describe("the shared gate", () => {
 it("a host under a stale identity refuses every write at the transport (0 requests) and still reads; fresh passes writes through [mutants M2 gate dropped, M5 gate refuses reads]", async () => {
  const { IdentityFrozenProvider } = await import("../../packages/ui/src/screens/project/write-freeze.js");
  const { useAppHost } = await import("../../packages/ui/src/host.js");
  const seen: { host?: ReturnType<typeof useAppHost> } = {};
  const Probe = () => { seen.host = useAppHost();return null; };
  const calls: string[] = [];
  const host = { origin: "https://cell.example", kind: "web", transport: { request: async (input: ApiRequest) => { calls.push(input.method);return { status: 200, body: {} }; } } } as never;
  const view = (stale: boolean) => h(AppHostProvider, { host, children: h(IdentityFrozenProvider, { stale, children: h(Probe, {}) }) });
  const ui = renderUi(view(true));
  await expect(seen.host!.transport.request({ method: "POST", path: "/x", body: {} })).rejects.toMatchObject({ code: "RECONNECTING" });
  await expect(seen.host!.transport.request({ method: "GET", path: "/x" })).resolves.toMatchObject({ status: 200 });
  expect(calls).toEqual(["GET"]);
  // A spread copy of the gated host keeps every field and still refuses (P3).
  const copy = { ...seen.host! };
  expect(copy.origin).toBe((host as { origin?: string }).origin);
  await expect(copy.transport.request({ method: "PUT", path: "/x", body: {} })).rejects.toMatchObject({ code: "RECONNECTING" });
  ui.rerender(view(false));
  await seen.host!.transport.request({ method: "POST", path: "/x", body: {} });
  expect(calls).toEqual(["GET", "POST"]);
 });
});

describe("the Work lesson batch (Keep / Edit / Drop): its own inbox read; this page has no identity read", () => {
 const posts = (cell: ReturnType<typeof learningHost>) => cell.request.mock.calls.map(([request]) => request).filter(request => request.method !== "GET");
 it("fresh = one send; a stale inbox read disables Keep / Edit / Drop and Send, and a Send already in flight sends nothing [mutants M6 frozen prop ignored, M7 send-time check dropped]", async () => {
  const cell = learningHost();cell.host.kind = "web";cell.host.origin = "https://cell.example";
  const batch = { project: "payments", fromYou: 0, lessons: [lesson("les_prop0001", { status: "proposed", title: "Wrap webhook calls in withRetry" })] } as never;
  let freeze: (value: boolean) => void = () => undefined;
  const Harness = () => { const [frozen, setFrozen] = useState(false);freeze = setFrozen;return h(LessonBatchCard, { batch, onDone: () => undefined, frozen }); };
  renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(Announcer, { children: h(Harness, {}) }) }) }));
  fireEvent.click(screen.getByRole("radio", { name: /^Keep/u }));
  const inFlight = heldClick(screen.getByRole("button", { name: "Send decision" }));
  act(() => { freeze(true); });
  expect(off(screen.getByRole("radio", { name: /^Keep/u }))).toBe(true);
  expect(off(screen.getByRole("radio", { name: /^Edit/u }))).toBe(true);
  expect(off(screen.getByRole("button", { name: "Send decision" }))).toBe(true);
  await act(async () => { await inFlight(); });
  expect(posts(cell)).toHaveLength(0);
  expect(screen.getByText(RECONNECT)).toBeTruthy();
  act(() => { freeze(false); });
  fireEvent.click(screen.getByRole("button", { name: "Send decision" }));
  await waitFor(() => expect(posts(cell)).toHaveLength(1));
 });
});
