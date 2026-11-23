// @vitest-environment jsdom
// G3 mount: the rebuilt Wiki, Skills and Ask pages on the REAL router (appRoutes + shell), with every live action the old pages had.
// Each action: allowed = exactly one send; refused / stale / no permission = zero extra sends, and Code's own sentence stays on screen.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { WIKI_CORRECTION_WORDS, type WikiCorrectionsResponse } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { projectFixture } from "./support/project-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { wikiIndex, wikiPage, wikiSearch, wikiSources } from "./support/wiki-fixture.js";

// The first test of a cold run loads the lazy page chunk: give finds more than the default second.
configure({ asyncUtilTimeout: 5000 });
// jsdom has no ResizeObserver, which the checkbox inside a form measures with.
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
const BILLING = "beacon-api--billing";
const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const refuse = (status: number, code: string, message: string) => json(status, { error: { code, message } });
type Role = "maintainer" | "contributor" | "viewer";
const corrections = (role: Role): WikiCorrectionsResponse => ({
 project: "payments", pageId: BILLING,
 you: { role, addNote: role !== "viewer", markWrong: role !== "viewer", approveNotes: role === "maintainer", resolveMarks: role === "maintainer", seeDisputed: role === "maintainer" },
 notes: [
  { noteId: "note-pending-1", mine: role === "contributor", canDelete: role !== "viewer", canApprove: role === "maintainer", canSuggestLesson: role !== "viewer", mayBeOutOfDate: role === "maintainer" },
  { noteId: "note-approved-1", mine: false, canDelete: role === "maintainer", canApprove: false, canSuggestLesson: false, mayBeOutOfDate: false },
 ],
});
const skillRow = (name: string, patch: Record<string, unknown> = {}) => ({ name, description: `About ${name}`, currentVersion: 1, approvals: 0, approvedByYou: false, retired: false, bytes: 400, ...patch });
const TEXT = "---\nname: add-queue\ndescription: Add a queue\n---\n\n## When to use\nadding a queue\n\n## Steps\n1. Create the queue.\n";
const FORM = { description: "Add a queue", when: "adding a queue", steps: ["Create the queue."] };

interface Options {
 role?: Role; initial?: string; canDecide?: boolean; answers?: boolean;
 corrections?: () => ApiResponse; disputed?: () => ApiResponse; write?: (request: ApiRequest) => ApiResponse | undefined; wikiRead?: (path: string) => ApiResponse | undefined; /** Reads of the page wait for this when it returns a promise. */ readGate?: () => Promise<void> | undefined; /** Every read waits for this when it returns a promise (the tab was left and is back: all reads run again, slowly). */ slow?: () => Promise<void> | undefined; /** A write waits for this before it is answered. */ writeGate?: () => Promise<void> | undefined; /** The index read waits for this when it returns a promise (a slow index re-read). */ indexGate?: () => Promise<void> | undefined; /** The corrections reads (the person's permission read among them) wait for this. */ correctionsGate?: () => Promise<void> | undefined; listRead?: () => ApiResponse | undefined; skillRead?: (name: string) => ApiResponse | undefined;
}
function mount(options: Options = {}) {
 const overview = projectFixture();
 overview.project.repositories = [{ name: "beacon-api", fullName: "acme/beacon-api", defaultBranch: "main" }] as unknown as typeof overview.project.repositories;
 const sends: ApiRequest[] = [];
 const skills = [skillRow("add-queue", { currentVersion: 2, activeVersion: 1, approvals: 1 }), skillRow("log-ids", { activeVersion: 1, approvals: 2 }), skillRow("old-one", { retired: true, activeVersion: 1, approvals: 2 })];
 const decide = options.canDecide !== false;
 const nav = navFixture({ features: { ...navFixture().features, answers: options.answers === true } });
 const f = fakeHost(async (request: ApiRequest) => {
  const url = new URL(request.path, "https://x.example"), path = url.pathname;
  if (request.method === "GET") await options.slow?.();
  if (request.method !== "GET") { sends.push(request); await options.writeGate?.(); return options.write?.(request) ?? json(404, { error: { code: "NOT_FOUND", message: "no" } }); }
  if (path === "/v1/app/me") return json(200, meFixture());
  if (path === "/v1/app/nav") return json(200, nav);
  if (path === "/v1/app/changes") return json(200, { notices: [], next: "settled" });
  const own = options.wikiRead?.(request.path); if (own !== undefined) return own;
  if (path === "/v1/app/projects/payments/overview") return json(200, overview);
  if (path === "/v1/app/projects/payments/wiki") { await options.indexGate?.(); return json(200, wikiIndex("payments")); }
  if (path === "/v1/app/projects/payments/wiki/search") return json(200, wikiSearch("payments", url.searchParams.get("q") ?? ""));
  if (path === "/v1/app/projects/payments/wiki/gaps") return json(200, { project: "payments", more: false, items: [] });
  if (path === "/v1/app/projects/payments/wiki/disputed") return options.disputed?.() ?? json(200, { project: "payments", more: false, items: [
   { flagId: "flag-0009", pageId: BILLING, pageTitle: "billing", claimId: "c-round", claimText: "Refunds round half up.", markedBy: "Priya", markedAt: "2026-11-17T10:00:00.000Z" },
   { flagId: "flag-0010", pageId: BILLING, pageTitle: "billing", markedBy: "Sam", markedAt: "2026-11-17T11:00:00.000Z" }] });
  const page = /^\/v1\/app\/projects\/payments\/wiki\/pages\/([^/]+)$/u.exec(path);
  if (page !== null) { await options.readGate?.(); const one = wikiPage("payments", page[1]!); return one === undefined ? refuse(404, "NOT_FOUND", "That wiki page is not there.") : json(200, one); }
  if (/\/corrections$/u.test(path)) { await options.correctionsGate?.(); return options.corrections?.() ?? json(200, corrections(options.role ?? "maintainer")); }
  const sources = /^\/v1\/app\/projects\/payments\/wiki\/pages\/([^/]+)\/sources$/u.exec(path);
  if (sources !== null) { const one = wikiSources("payments", sources[1]!); return one === undefined ? refuse(404, "NOT_FOUND", "x") : json(200, one); }
  const skill = /\/skills\/([^/]+)$/u.exec(path);
  if (skill !== null) {
   const name = decodeURIComponent(skill[1]!), row = skills.find(entry => entry["name"] === name);
   return options.skillRead?.(name) ?? (row === undefined ? refuse(404, "NOT_FOUND", "That skill is no longer there.") : json(200, { project: "payments", canDecide: decide, skill: { ...row, content: TEXT, form: FORM } }));
  }
  if (path === "/v1/app/projects/payments/skills") return options.listRead?.() ?? json(200, { project: "payments", canDecide: decide, skills });
  return refuse(404, "NOT_FOUND", "route not found");
 });
 f.storage.set("rovara.theme", "light");
 const query = createQueryClient();
 query.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
 query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [options.initial ?? `/app/projects/payments?tab=wiki&page=${BILLING}`] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }) }));
 return { ...f, ...ui, sends, router, query, close() { ui.unmount(); router.dispose(); query.clear(); } };
}
const body = (request: ApiRequest | undefined) => request?.body as Record<string, unknown> | undefined;
const getsOf = (f: { request: { mock: { calls: Array<[ApiRequest]> } } }, pattern: RegExp) => f.request.mock.calls.filter(([request]) => request.method === "GET" && pattern.test(request.path)).length;
const marks = () => screen.queryAllByRole("button", { name: /^Mark wrong/ });
afterEach(() => { vi.useRealTimers(); });

describe("mounted on the real routes", () => {
 it("?tab=wiki opens the rebuilt Wiki pages (own frame, query kept), not the old tab", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=wiki" });
  try {
   expect(await screen.findByRole("heading", { name: "What Rovara knows about payments" })).toBeTruthy();
   expect(screen.queryByTestId("wiki")).toBeNull();
   expect(screen.queryByRole("heading", { name: "Running now" })).toBeNull();
   fireEvent.click(await screen.findByRole("link", { name: "billing" }));
   await waitFor(() => expect(f.router.state.location.search).toBe(`?tab=wiki&page=${BILLING}`));
   expect(await screen.findByRole("heading", { name: "billing" })).toBeTruthy();
  } finally { f.close(); }
 });
 it("?tab=skills opens the rebuilt Skills page; a deep link to a page or a view keeps its query", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=skills" });
  try {
   expect(await screen.findByRole("heading", { name: "Skills in payments" })).toBeTruthy();
   expect(screen.queryByTestId("skills-tab")).toBeNull();
  } finally { f.close(); }
  const g = mount({ initial: `/app/projects/payments?tab=wiki&view=disputed` });
  try { expect(await screen.findByRole("heading", { name: "Corrections to decide" })).toBeTruthy(); } finally { g.close(); }
 });
 it("the Wiki and Skills tabs of the project page still open them (the tabs are the way in)", async () => {
  const f = mount({ initial: "/app/projects/payments" });
  try {
   const tab = await screen.findByRole("tab", { name: "Wiki" });
   fireEvent.mouseDown(tab); fireEvent.click(tab);
   expect(await screen.findByRole("heading", { name: "What Rovara knows about payments" })).toBeTruthy();
  } finally { f.close(); }
 });
 it("every link of the project frame goes to a real tab of the project page", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=wiki" });
  try {
   const tabs = within(await screen.findByRole("navigation", { name: "Project sections" }));
   for (const link of tabs.getAllByRole("link")) expect(link.getAttribute("href")).toMatch(/^\/app\/projects\/payments(\?tab=(how-we-work|settings))?$/u);
  } finally { f.close(); }
 });
});

describe("Mark wrong, page mark and notes", () => {
 it("a maintainer: Mark wrong on a section lists its unmarked claims to tick; one tick sends exactly one mark, ticking more sends one each", async () => {
  const f = mount({ write: request => json(200, { flagId: "flag-new-0001", pageId: BILLING, claimId: body(request)?.["claimId"] }) });
  try {
   await screen.findByRole("heading", { name: "What it does" });
   await waitFor(() => expect(marks().length).toBeGreaterThan(0));
   fireEvent.click(screen.getByRole("button", { name: "Mark wrong: What it does" }));
   const form = await screen.findByTestId("wiki-mark-form");
   // c-round already carries an open mark: it is not offered. Nothing is ticked at the start.
   const boxes = within(screen.getByTestId("wiki-mark-claims")).getAllByRole("checkbox");
   expect(boxes).toHaveLength(5);
   expect(boxes.every(box => box.getAttribute("aria-checked") === "false")).toBe(true);
   fireEvent.click(boxes[1]!);
   fireEvent.change(within(form).getByLabelText(WIKI_CORRECTION_WORDS_LABEL()), { target: { value: "moved to refund_v2.ts" } });
   fireEvent.click(within(form).getByRole("button", { name: "Mark wrong" }));
   await waitFor(() => expect(f.sends).toHaveLength(1));
   expect(f.sends[0]?.method === "POST" && f.sends[0].path.endsWith(`/wiki/pages/${BILLING}/flags`)).toBe(true);
   expect(typeof body(f.sends[0])?.["claimId"]).toBe("string");
   expect(body(f.sends[0])?.["reason"]).toBe("moved to refund_v2.ts");
   await waitFor(() => expect(screen.queryByTestId("wiki-mark-form")).toBeNull());
   expect(f.sends).toHaveLength(1);
  } finally { f.close(); }
 });
 it("Mark wrong with two claims ticked sends one mark for each ticked claim and no other", async () => {
  const f = mount({ write: request => json(200, { flagId: "flag-new-0001", pageId: BILLING, claimId: body(request)?.["claimId"] }) });
  try {
   await screen.findByRole("heading", { name: "What it does" });
   await waitFor(() => expect(marks().length).toBeGreaterThan(0));
   fireEvent.click(screen.getByRole("button", { name: "Mark wrong: What it does" }));
   const boxes = within(await screen.findByTestId("wiki-mark-claims")).getAllByRole("checkbox");
   fireEvent.click(boxes[0]!); fireEvent.click(boxes[3]!);
   const wanted = [boxes[0]!, boxes[3]!].map(box => box.closest(".rv-check-row")?.querySelector("label")?.textContent ?? "");
   fireEvent.click(within(screen.getByTestId("wiki-mark-form")).getByRole("button", { name: "Mark wrong" }));
   await waitFor(() => expect(f.sends).toHaveLength(2));
   await waitFor(() => expect(screen.queryByTestId("wiki-mark-form")).toBeNull());
   const claimIds = f.sends.map(request => String(body(request)?.["claimId"]));
   expect(new Set(claimIds).size).toBe(2);
   expect(wanted.every(text => text.length > 0)).toBe(true);
   expect(f.sends).toHaveLength(2);
  } finally { f.close(); }
 });
 it("Mark wrong with nothing ticked sends nothing and asks for a pick; ticking then unticking sends nothing either", async () => {
  const f = mount({ write: request => json(200, { flagId: "flag-new-0001", pageId: BILLING, claimId: body(request)?.["claimId"] }) });
  try {
   await screen.findByRole("heading", { name: "What it does" });
   await waitFor(() => expect(marks().length).toBeGreaterThan(0));
   fireEvent.click(screen.getByRole("button", { name: "Mark wrong: What it does" }));
   const form = await screen.findByTestId("wiki-mark-form");
   fireEvent.click(within(form).getByRole("button", { name: "Mark wrong" }));
   expect((await within(form).findByRole("alert")).textContent).toBe("Pick at least one statement to mark.");
   const box = within(screen.getByTestId("wiki-mark-claims")).getAllByRole("checkbox")[2]!;
   fireEvent.click(box); fireEvent.click(box);
   expect(box.getAttribute("aria-checked")).toBe("false");
   fireEvent.click(within(form).getByRole("button", { name: "Mark wrong" }));
   expect(await within(form).findByRole("alert")).toBeTruthy();
   expect(f.sends).toHaveLength(0);
  } finally { f.close(); }
 });
 it("a refused mark keeps the form open with Code's sentence, and sends nothing more", async () => {
  const f = mount({ write: () => refuse(403, "FORBIDDEN", WIKI_CORRECTION_WORDS.needsWorkingRole) });
  try {
   await screen.findByRole("heading", { name: "What it does" });
   await waitFor(() => expect(marks().length).toBeGreaterThan(0));
   fireEvent.click(screen.getByRole("button", { name: "Mark wrong: What it does" }));
   fireEvent.click(within(await screen.findByTestId("wiki-mark-claims")).getAllByRole("checkbox")[0]!);
   fireEvent.click(within(screen.getByTestId("wiki-mark-form")).getByRole("button", { name: "Mark wrong" }));
   await waitFor(() => expect(f.sends).toHaveLength(1));
   // The page is read again after a refusal; the open form and the sentence must survive it.
   await waitFor(() => expect(f.query.isFetching()).toBe(0));
   const form = screen.getByTestId("wiki-mark-form");
   expect(within(form).getByRole("alert").textContent).toBe(WIKI_CORRECTION_WORDS.needsWorkingRole);
   expect(f.sends).toHaveLength(1);
  } finally { f.close(); }
 });
 it("while our own re-read after a refused mark is still running, the page, the open form and Code's sentence stay on screen", async () => {
  let gated = false; let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = mount({ readGate: () => gated ? gate : undefined, write: () => { gated = true; return refuse(403, "FORBIDDEN", WIKI_CORRECTION_WORDS.needsWorkingRole); } });
  try {
   await screen.findByRole("heading", { name: "What it does" });
   await waitFor(() => expect(marks().length).toBeGreaterThan(0));
   fireEvent.click(screen.getByRole("button", { name: "Mark wrong: What it does" }));
   fireEvent.click(within(await screen.findByTestId("wiki-mark-claims")).getAllByRole("checkbox")[0]!);
   fireEvent.click(within(screen.getByTestId("wiki-mark-form")).getByRole("button", { name: "Mark wrong" }));
   await waitFor(() => expect(f.sends).toHaveLength(1));
   // The re-read of the page is held open: it is running now.
   await waitFor(() => expect(f.query.isFetching()).toBeGreaterThan(0));
   expect((await within(screen.getByTestId("wiki-mark-form")).findByRole("alert")).textContent).toBe(WIKI_CORRECTION_WORDS.needsWorkingRole);
   expect(screen.queryByText("Loading the latest read…")).toBeNull();
   expect(screen.getByText(/Wiki page · written/u)).toBeTruthy();
   release();
   await waitFor(() => expect(f.query.isFetching()).toBe(0));
   expect(within(screen.getByTestId("wiki-mark-form")).getByRole("alert").textContent).toBe(WIKI_CORRECTION_WORDS.needsWorkingRole);
   expect(f.sends).toHaveLength(1);
  } finally { release(); f.close(); }
 });
 it("a write that went through reads the page and its corrections again", async () => {
  const f = mount({ write: () => json(200, { flagId: "flag-new-0001", pageId: BILLING }) });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Mark this page wrong" }));
   await waitFor(() => expect(f.query.isFetching()).toBe(0));
   const before = getsOf(f, /\/wiki\/pages\/[^/]+$/u), beforeCorrections = getsOf(f, /\/corrections$/u);
   fireEvent.click(within(await screen.findByTestId("wiki-mark-form")).getByRole("button", { name: "Mark wrong" }));
   await waitFor(() => expect(f.sends).toHaveLength(1));
   await waitFor(() => expect(getsOf(f, /\/wiki\/pages\/[^/]+$/u)).toBeGreaterThan(before));
   await waitFor(() => expect(getsOf(f, /\/corrections$/u)).toBeGreaterThan(beforeCorrections));
  } finally { f.close(); }
 });
 it("Mark this page wrong, Add a note: one send each", async () => {
  const f = mount({ write: request => json(200, request.path.endsWith("/notes") ? { note: { noteId: "note-new-0001", text: "x", author: "Me", createdAt: "2026-11-17T10:00:00.000Z", approval: "pending" } } : { flagId: "flag-new-0001", pageId: BILLING }) });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Mark this page wrong" }));
   fireEvent.click(within(await screen.findByTestId("wiki-mark-form")).getByRole("button", { name: "Mark wrong" }));
   await waitFor(() => expect(f.sends).toHaveLength(1));
   expect(body(f.sends[0])?.["claimId"]).toBeUndefined();
   fireEvent.click(await screen.findByTestId("wiki-add-note"));
   fireEvent.change(within(await screen.findByTestId("wiki-note-form")).getByRole("textbox"), { target: { value: "Check the rounding rule." } });
   fireEvent.click(screen.getByRole("button", { name: "Pin note" }));
   await waitFor(() => expect(f.sends).toHaveLength(2));
   expect(f.sends[1]?.path).toMatch(/\/notes$/u);
   expect(body(f.sends[1])).toEqual({ text: "Check the rounding rule." });
  } finally { f.close(); }
 });
 it("a maintainer's note actions: Approve for agents, Remove, I've checked it, the lesson offer: each one send", async () => {
  const f = mount({ write: request => json(200, request.path.endsWith("/approve") ? { noteId: "note-pending-1", approval: "approved" } : { deleted: true }) });
  try {
   const approve = await screen.findByRole("button", { name: "Approve for agents" });
   fireEvent.click(approve);
   await waitFor(() => expect(f.sends).toHaveLength(1));
   expect(f.sends[0]?.path).toMatch(/\/notes\/note-pending-1\/approve$/u);
   fireEvent.click(screen.getAllByRole("button", { name: /^Remove/ })[0]!);
   await waitFor(() => expect(f.sends).toHaveLength(2));
   expect(f.sends[1]?.path).toMatch(/\/notes\/note-pending-1\/delete$/u);
  } finally { f.close(); }
 });
 it("when the page read itself starts failing after the page was shown, the controls go and nothing is sent", async () => {
  let failing = false;
  const f = mount({ wikiRead: path => failing && /\/wiki\/pages\/[^/?]+$/u.test(path) ? refuse(503, "RUNTIME_UNAVAILABLE", WIKI_CORRECTION_WORDS.unavailable) : undefined });
  try {
   await screen.findByRole("heading", { name: "What it does" });
   await waitFor(() => expect(marks().length).toBeGreaterThan(0));
   failing = true;
   await act(async () => { await f.query.refetchQueries({ queryKey: ["g3"] }); });
   await waitFor(() => expect(marks()).toHaveLength(0));
   expect(screen.queryByRole("button", { name: "Mark this page wrong" })).toBeNull();
   expect(screen.queryByTestId("wiki-add-note")).toBeNull();
   expect(f.sends).toHaveLength(0);
  } finally { f.close(); }
 });
 it("a viewer, or corrections that cannot be read, or a stale read: the page shows and there is no control at all", async () => {
  for (const options of [{ role: "viewer" as const }, { corrections: () => refuse(503, "RUNTIME_UNAVAILABLE", WIKI_CORRECTION_WORDS.unavailable) }]) {
   const f = mount(options);
   try {
    await screen.findByRole("heading", { name: "What it does" });
    await waitFor(() => expect(f.query.isFetching()).toBe(0));
    expect(marks()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Mark this page wrong" })).toBeNull();
    expect(screen.queryByTestId("wiki-add-note")).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Approve for agents|Remove|I've checked it)/ })).toBeNull();
    expect(f.sends).toHaveLength(0);
   } finally { f.close(); }
  }
 });
 it("when the corrections read starts failing after the page was shown, the controls go and nothing is sent", async () => {
  let failing = false;
  const f = mount({ corrections: () => failing ? refuse(503, "RUNTIME_UNAVAILABLE", WIKI_CORRECTION_WORDS.unavailable) : json(200, corrections("maintainer")) });
  try {
   await screen.findByRole("heading", { name: "What it does" });
   await waitFor(() => expect(marks().length).toBeGreaterThan(0));
   failing = true;
   await act(async () => { await f.query.refetchQueries({ queryKey: ["g3"] }); });
   await waitFor(() => expect(marks()).toHaveLength(0));
   expect(screen.queryByTestId("wiki-add-note")).toBeNull();
   expect(f.sends).toHaveLength(0);
  } finally { f.close(); }
 });
});

describe("disputed marks", () => {
 it("a maintainer closes the marks of a page: one send for the page, shown once for two marks", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=wiki&view=disputed", write: () => json(200, { resolved: 2 }) });
  try {
   const close = await screen.findByRole("button", { name: /Close the marks on this page/ });
   expect(screen.getAllByRole("button", { name: /Close the marks on this page/ })).toHaveLength(1);
   fireEvent.click(close);
   await waitFor(() => expect(f.sends).toHaveLength(1));
   expect(f.sends[0]?.path).toMatch(new RegExp(`/wiki/pages/${BILLING}/flags/resolve$`, "u"));
   expect((await screen.findByText(/Marks closed/)).getAttribute("role")).toBe("status");
  } finally { f.close(); }
 });
 it("a refused close keeps its sentence; a person Code does not let close marks gets no button", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=wiki&view=disputed", write: () => refuse(403, "FORBIDDEN", WIKI_CORRECTION_WORDS.needsMaintainer) });
  try {
   fireEvent.click(await screen.findByRole("button", { name: /Close the marks on this page/ }));
   await waitFor(() => expect(f.sends).toHaveLength(1));
   await waitFor(() => expect(f.query.isFetching()).toBe(0));
   expect(screen.getByRole("button", { name: /Close the marks on this page/ })).toBeTruthy();
   expect(f.sends).toHaveLength(1);
  } finally { f.close(); }
  const g = mount({ initial: "/app/projects/payments?tab=wiki&view=disputed", corrections: () => json(200, { ...corrections("maintainer"), you: { ...corrections("maintainer").you, resolveMarks: false } }) });
  try {
   expect(await screen.findByRole("heading", { name: "Corrections to decide" })).toBeTruthy();
   await waitFor(() => expect(g.query.isFetching()).toBe(0));
   expect(screen.queryByRole("button", { name: /Close the marks/ })).toBeNull();
   expect(g.sends).toHaveLength(0);
  } finally { g.close(); }
 });
});

describe("disputed marks: a read that starts failing", () => {
 it("takes the close button away and sends nothing", async () => {
  let failing = false;
  const f = mount({ initial: "/app/projects/payments?tab=wiki&view=disputed", disputed: () => failing ? refuse(503, "RUNTIME_UNAVAILABLE", WIKI_CORRECTION_WORDS.unavailable) : json(200, { project: "payments", more: false, items: [{ flagId: "flag-0009", pageId: BILLING, pageTitle: "billing", claimId: "c-round", claimText: "Refunds round half up.", markedBy: "Priya", markedAt: "2026-11-17T10:00:00.000Z" }] }) });
  try {
   await screen.findByRole("button", { name: /Close the marks on this page/ });
   failing = true;
   await act(async () => { await f.query.refetchQueries({ queryKey: ["g3"] }); });
   await waitFor(() => expect(screen.queryByRole("button", { name: /Close the marks/ })).toBeNull());
   expect(f.sends).toHaveLength(0);
  } finally { f.close(); }
 });
});

describe("search and source links", () => {
 it("from two characters Code's full-text search answers (page text too); one character filters titles locally", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=wiki" });
  try {
   const box = await screen.findByRole("searchbox", { name: "Search the wiki" });
   fireEvent.change(box, { target: { value: "refund" } });
   await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path === "/v1/app/projects/payments/wiki/search?q=refund")).toBe(true), { timeout: 2_000 });
   fireEvent.change(box, { target: { value: "r" } });
   expect(f.request.mock.calls.filter(([request]) => request.path === "/v1/app/projects/payments/wiki/search?q=r").length).toBe(0);
  } finally { f.close(); }
 });
 it("a cited file opens on the code host (the project's own repository), and the source fold has the same link", async () => {
  const f = mount();
  try {
   await screen.findByRole("heading", { name: "What it does" });
   const links = await screen.findAllByRole("link", { name: /Open on/ });
   expect(links.length).toBeGreaterThan(0);
   for (const link of links) { expect(link.getAttribute("href")).toMatch(/^https:\/\/github\.com\/acme\/beacon-api\/blob\/[0-9a-f]{40}\/src\//u); expect(link.getAttribute("rel")).toBe("noopener noreferrer"); }
  } finally { f.close(); }
 });
});

describe("Skills: approve, edit, retire", () => {
 const open = async (name: string) => { fireEvent.click((await screen.findAllByRole("button", { name: `Open ${name}` }))[0]!); return screen.findByRole("heading", { name: "Versions" }); };
 it("approve this version: one send naming the version shown", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=skills", write: () => json(200, { version: 2, approvals: 2, live: true }) });
  try {
   await open("add-queue");
   fireEvent.click(await screen.findByRole("button", { name: "Approve version 2 of add-queue" }));
   await waitFor(() => expect(f.sends).toHaveLength(1));
   expect(f.sends[0]?.method).toBe("POST");
   expect(f.sends[0]?.path).toMatch(/\/skills\/add-queue\/approve$/u);
   expect(body(f.sends[0])).toEqual({ version: 2 });
   expect((await screen.findByTestId("skill-done")).textContent).toContain("Approved");
  } finally { f.close(); }
 });
 it("shared policy: a read that fails AFTER a successful approve keeps the success, shows ONE Reconnecting line, never 'Nothing was changed'; a 403 then clears the facts", async () => {
  let failing: number | undefined;
  const f = mount({ initial: "/app/projects/payments?tab=skills", write: () => { failing = 503; return json(200, { version: 2, approvals: 2, live: true }); }, listRead: () => failing === undefined ? undefined : refuse(failing, failing === 503 ? "RUNTIME_UNAVAILABLE" : "FORBIDDEN", "x"), skillRead: () => failing === undefined ? undefined : refuse(failing, failing === 503 ? "RUNTIME_UNAVAILABLE" : "FORBIDDEN", "x") });
  try {
   await open("add-queue");
   fireEvent.click(await screen.findByRole("button", { name: "Approve version 2 of add-queue" }));
   expect((await screen.findByTestId("skill-done")).textContent).toContain("Approved");
   await waitFor(() => expect(f.query.isFetching()).toBe(0));
   await waitFor(() => expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1));
   expect(screen.getByTestId("skill-done").textContent).toContain("Approved");
   expect(screen.queryByText(/Nothing was changed/)).toBeNull();
   expect(screen.queryByRole("button", { name: /^(Approve|Edit|Retire)/ })).toBeNull();
   expect(f.sends).toHaveLength(1);
   failing = 403;
   await act(async () => { await f.query.refetchQueries({ queryKey: ["g3"] }); });
   await screen.findByRole("heading", { name: "Access ended" });
   expect(screen.queryByTestId("skill-done")).toBeNull();
   expect(screen.queryByText(/Reconnecting/)).toBeNull();
  } finally { f.close(); }
 });
 it("edit saves one new version with expectedVersion; retire asks first and then sends one", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=skills", write: request => request.method === "PUT" ? json(200, { version: 3 }) : json(200, { retired: true }) });
  try {
   await open("add-queue");
   fireEvent.click(await screen.findByRole("button", { name: "Edit add-queue" }));
   fireEvent.change(await screen.findByLabelText("When to use it"), { target: { value: "adding any queue" } });
   fireEvent.click(screen.getByRole("button", { name: "Save as a new version" }));
   await waitFor(() => expect(f.sends).toHaveLength(1));
   expect(f.sends[0]?.method).toBe("PUT");
   expect(body(f.sends[0])).toMatchObject({ expectedVersion: 2, when: "adding any queue", steps: ["Create the queue."] });
   fireEvent.click(await screen.findByRole("button", { name: "Retire add-queue" }));
   expect(f.sends).toHaveLength(1);
   fireEvent.click(await screen.findByRole("button", { name: "Retire skill" }));
   await waitFor(() => expect(f.sends).toHaveLength(2));
   expect(f.sends[1]?.path).toMatch(/\/skills\/add-queue\/retire$/u);
  } finally { f.close(); }
 });
 it("Approve, Edit and Retire need the list AND the skill to say canDecide: either one saying no draws none", async () => {
  const detail = (own: boolean) => (name: string) => json(200, { project: "payments", canDecide: own, skill: { ...skillRow(name, { currentVersion: 2, activeVersion: 1, approvals: 1 }), content: TEXT, form: FORM } });
  for (const [list, own] of [[true, false], [false, true]] as const) {
   const f = mount({ initial: "/app/projects/payments?tab=skills", canDecide: list, skillRead: detail(own) });
   try {
    await open("add-queue");
    await waitFor(() => expect(f.query.isFetching()).toBe(0));
    await screen.findByRole("heading", { name: "Versions" });
    expect(screen.queryByRole("button", { name: /^(Approve|Edit|Retire)/ })).toBeNull();
    expect(f.sends).toHaveLength(0);
   } finally { f.close(); }
  }
  const yes = mount({ initial: "/app/projects/payments?tab=skills", canDecide: true, skillRead: detail(true) });
  try { await open("add-queue"); expect(await screen.findByRole("button", { name: "Edit add-queue" })).toBeTruthy(); } finally { yes.close(); }
 });
 it("when the skills list read starts failing while a skill is open, Approve, Edit and Retire go and nothing is sent", async () => {
  let failing = false;
  const f = mount({ initial: "/app/projects/payments?tab=skills", listRead: () => failing ? refuse(503, "RUNTIME_UNAVAILABLE", "x") : undefined });
  try {
   await open("add-queue");
   await screen.findByRole("button", { name: "Edit add-queue" });
   failing = true;
   await act(async () => { await f.query.refetchQueries({ queryKey: ["g3"] }); });
   await waitFor(() => expect(screen.queryByRole("button", { name: /^(Approve|Edit|Retire)/ })).toBeNull());
   expect(f.sends).toHaveLength(0);
  } finally { f.close(); }
 });
 it("a stale approval is refused by Code: its sentence stays, the skill is read again, nothing else is sent", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=skills", write: () => refuse(409, "CONFLICT", "This skill changed since you opened it. Read it again before you decide.") });
  try {
   await open("add-queue");
   fireEvent.click(await screen.findByRole("button", { name: "Approve version 2 of add-queue" }));
   await waitFor(() => expect(f.sends).toHaveLength(1));
   await waitFor(() => expect(f.query.isFetching()).toBe(0));
   expect((await screen.findByTestId("skill-error")).textContent).toBe("This skill changed since you opened it. Read it again before you decide.");
   expect(f.sends).toHaveLength(1);
  } finally { f.close(); }
 });
 it("no permission (the list or the skill says canDecide is false) or a failed read: no Approve, Edit or Retire, zero sends", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=skills", canDecide: false });
  try {
   await open("add-queue");
   await waitFor(() => expect(f.query.isFetching()).toBe(0));
   expect(screen.queryByRole("button", { name: /^(Approve|Edit|Retire)/ })).toBeNull();
   expect(f.sends).toHaveLength(0);
  } finally { f.close(); }
  let failing = false;
  const g = mount({ initial: "/app/projects/payments?tab=skills", skillRead: name => failing ? refuse(503, "RUNTIME_UNAVAILABLE", "x") : name === "add-queue" ? json(200, { project: "payments", canDecide: true, skill: { ...skillRow("add-queue", { currentVersion: 2, activeVersion: 1, approvals: 1 }), content: TEXT, form: FORM } }) : undefined });
  try {
   await open("add-queue");
   await screen.findByRole("button", { name: "Edit add-queue" });
   failing = true;
   await act(async () => { await g.query.refetchQueries({ queryKey: ["g3"] }); });
   await waitFor(() => expect(screen.queryByRole("button", { name: /^(Approve|Edit|Retire)/ })).toBeNull());
   expect(g.sends).toHaveLength(0);
  } finally { g.close(); }
 });
});

describe("Ask", () => {
 it("where answers are offered, Ask a question opens the Ask box: one question = one send; a follow-up keeps the thread", async () => {
  const answer = { answerId: "ans_aaaaaaaaaaaaaaaaaaaa", threadId: "thr_aaaaaaaaaaaaaaaaaaaa", outcome: "answered", text: "Refunds are in refund.ts. [1]", sources: [{ n: 1, repo: "beacon-api", path: "src/billing/refund.ts", commit: "a".repeat(40), line: 10 }], wikiPages: [], unconfirmed: [] };
  const f = mount({ initial: "/app/projects/payments?tab=wiki", answers: true, write: () => json(200, answer) });
  try {
   fireEvent.click(await screen.findByRole("link", { name: "Ask a question" }));
   fireEvent.change(await screen.findByTestId("ask-box-text"), { target: { value: "Where are refunds?" } });
   fireEvent.click(screen.getByTestId("ask-box-submit"));
   await waitFor(() => expect(f.sends).toHaveLength(1));
   expect(f.sends[0]?.path).toBe("/v1/app/projects/payments/answers");
   expect(body(f.sends[0])).toMatchObject({ question: "Where are refunds?" });
   expect(await screen.findByTestId("answer")).toBeTruthy();
   expect(await screen.findByTestId("answer-not-right")).toBeTruthy();
  } finally { f.close(); }
 });
 it("where answers are not offered, the Ask page has no box and sends nothing", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=wiki&view=ask", answers: false });
  try {
   expect(await screen.findByText("Existing answer: Can't tell yet.")).toBeTruthy();
   expect(screen.queryByTestId("ask-box")).toBeNull();
   expect(f.sends).toHaveLength(0);
  } finally { f.close(); }
 });
});

describe("a slow re-read keeps the page on screen (last good read)", () => {
 const gateOf = () => { let release: () => void = () => undefined; const gate = new Promise<void>(resolve => { release = resolve; }); return { gate, release: () => { release(); } }; };
 const openMarkForm = async () => { fireEvent.click(await screen.findByRole("button", { name: "Mark wrong: What it does" })); fireEvent.click(within(await screen.findByTestId("wiki-mark-claims")).getAllByRole("checkbox")[0]!); };
 const idle = (f: { query: { isFetching: () => number } }) => waitFor(() => expect(f.query.isFetching()).toBe(0));
 it("a slow INDEX re-read after a refused mark keeps the open form, the ticked claim and Code's sentence", async () => {
  let gated = false; const { gate, release } = gateOf();
  const f = mount({ indexGate: () => gated ? gate : undefined, write: () => { gated = true; return refuse(403, "FORBIDDEN", WIKI_CORRECTION_WORDS.needsWorkingRole); } });
  try {
   await screen.findByRole("heading", { name: "What it does" });
   await waitFor(() => expect(marks().length).toBeGreaterThan(0));
   await openMarkForm();
   const before = getsOf(f, /\/wiki$/u);
   fireEvent.click(within(screen.getByTestId("wiki-mark-form")).getByRole("button", { name: "Mark wrong" }));
   await waitFor(() => expect(f.sends).toHaveLength(1));
   // The INDEX is being read again right now (and has not answered): the page is not replaced.
   await waitFor(() => expect(getsOf(f, /\/wiki$/u)).toBeGreaterThan(before));
   expect((await within(screen.getByTestId("wiki-mark-form")).findByRole("alert")).textContent).toBe(WIKI_CORRECTION_WORDS.needsWorkingRole);
   expect(screen.queryByText("Loading the latest read…")).toBeNull();
   const box = within(screen.getByTestId("wiki-mark-claims")).getAllByRole("checkbox")[0]!;
   expect(box.getAttribute("aria-checked") === "true" || (box as HTMLInputElement).checked).toBe(true);
   release(); await idle(f);
   expect(within(screen.getByTestId("wiki-mark-form")).getByRole("alert").textContent).toBe(WIKI_CORRECTION_WORDS.needsWorkingRole);
   expect(f.sends).toHaveLength(1);
  } finally { release(); f.close(); }
 });
 it("a slow index and permission re-read on the disputed view keeps the refusal sentence, the close button and the Marks closed notice", async () => {
  let gated = false, refused = true, round = gateOf();
  const f = mount({ initial: "/app/projects/payments?tab=wiki&view=disputed", indexGate: () => gated ? round.gate : undefined, correctionsGate: () => gated ? round.gate : undefined, write: () => { gated = true; return refused ? refuse(403, "FORBIDDEN", WIKI_CORRECTION_WORDS.needsMaintainer) : json(200, { resolved: 2 }); } });
  try {
   fireEvent.click(await screen.findByRole("button", { name: /Close the marks on this page/ }));
   await waitFor(() => expect(f.sends).toHaveLength(1));
   await waitFor(() => expect(f.query.isFetching()).toBeGreaterThan(0));
   // The index and the permission are being read again and have not answered: the sentence and the button stay.
   expect(screen.getByText(WIKI_CORRECTION_WORDS.needsMaintainer)).toBeTruthy();
   expect(screen.getByRole("button", { name: /Close the marks on this page/ })).toBeTruthy();
   expect(screen.queryByText("Loading the latest read…")).toBeNull();
   round.release(); await idle(f);
   expect(screen.getByText(WIKI_CORRECTION_WORDS.needsMaintainer)).toBeTruthy();
   // A close that went through: the notice also survives a slow re-read.
   refused = false; gated = false; round = gateOf();
   await act(async () => { gated = true; });
   fireEvent.click(screen.getByRole("button", { name: /Close the marks on this page/ }));
   await waitFor(() => expect(f.sends).toHaveLength(2));
   expect((await screen.findByText(/Marks closed/)).getAttribute("role")).toBe("status");
   await waitFor(() => expect(f.query.isFetching()).toBeGreaterThan(0));
   expect(screen.getByText(/Marks closed/)).toBeTruthy();
   round.release(); await idle(f);
   expect(screen.getByText(/Marks closed/)).toBeTruthy();
  } finally { round.release(); f.close(); }
 });
 it("while the index and the person's permission are read again the Disputed sections links stay", async () => {
  let gated = false; const { gate, release } = gateOf();
  const f = mount({ initial: "/app/projects/payments?tab=wiki", indexGate: () => gated ? gate : undefined, correctionsGate: () => gated ? gate : undefined });
  try {
   expect(await screen.findByRole("link", { name: "Disputed sections" })).toBeTruthy();
   await idle(f);
   gated = true;
   await act(async () => { void f.query.invalidateQueries({ queryKey: ["g3"] }); });
   await waitFor(() => expect(f.query.isFetching()).toBeGreaterThan(0));
   expect(screen.getByRole("link", { name: "Disputed sections" })).toBeTruthy();
   expect(screen.getByRole("heading", { name: "What Rovara knows about payments" })).toBeTruthy();
   release(); await idle(f);
   expect(screen.getByRole("link", { name: "Disputed sections" })).toBeTruthy();
  } finally { release(); f.close(); }
 });
 it("returning to the tab (a focus read) never replaces the page: the open forms and the typed draft stay", async () => {
  let gated = false; const { gate, release } = gateOf();
  const f = mount({ slow: () => gated ? gate : undefined });
  try {
   await screen.findByRole("heading", { name: "What it does" });
   await waitFor(() => expect(marks().length).toBeGreaterThan(0));
   await openMarkForm();
   fireEvent.change(within(screen.getByTestId("wiki-mark-form")).getByRole("textbox"), { target: { value: "My draft reason" } });
   gated = true;
   await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
   await waitFor(() => expect(f.query.isFetching()).toBeGreaterThan(0));
   expect(within(screen.getByTestId("wiki-mark-form")).getByRole<HTMLInputElement>("textbox").value).toBe("My draft reason");
   expect(screen.queryByText("Loading the latest read…")).toBeNull();
   release(); await idle(f);
   expect(within(screen.getByTestId("wiki-mark-form")).getByRole<HTMLInputElement>("textbox").value).toBe("My draft reason");
   expect(f.sends).toHaveLength(0);
  } finally { release(); focusManager.setFocused(undefined); f.close(); }
 });
 it("a page opened again from an earlier visit is not shown from the cache: it waits for the read (only what THIS screen already showed is kept)", async () => {
  let gated = false; const { gate, release } = gateOf();
  const f = mount({ readGate: () => gated ? gate : undefined });
  try {
   await screen.findByRole("heading", { name: "What it does" });
   await act(async () => { await f.router.navigate("/app/projects/payments?tab=wiki"); });
   await screen.findByRole("heading", { name: "What Rovara knows about payments" });
   await idle(f);
   gated = true;
   await act(async () => { await f.router.navigate(`/app/projects/payments?tab=wiki&page=${BILLING}`); });
   expect(await screen.findByText("Loading the latest read…")).toBeTruthy();
   expect(screen.queryByRole("heading", { name: "What it does" })).toBeNull();
   release(); await idle(f);
   expect(await screen.findByRole("heading", { name: "What it does" })).toBeTruthy();
  } finally { release(); f.close(); }
 });
 it("a read that FAILS on the re-read still takes the write controls away", async () => {
  let failing = false;
  const f = mount({ corrections: () => failing ? refuse(503, "RUNTIME_UNAVAILABLE", "offline") : json(200, corrections("maintainer")) });
  try {
   await screen.findByRole("heading", { name: "What it does" });
   await waitFor(() => expect(marks().length).toBeGreaterThan(0));
   failing = true;
   await act(async () => { await f.query.refetchQueries({ predicate: q => String(q.queryKey.at(-1)).startsWith("corrections:") }); });
   await waitFor(() => expect(marks()).toHaveLength(0));
   expect(f.sends).toHaveLength(0);
  } finally { f.close(); }
 });
});

describe("one page or skill that is gone is a local not-found; a refused scope is still scope-wide", () => {
 it("a deep link to a wiki page that is not there says so and the Wiki stays usable", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=wiki&page=no-such-page" });
  try {
   expect(await screen.findByText("That page isn't in this wiki.")).toBeTruthy();
   expect(screen.queryByRole("heading", { name: "Access ended" })).toBeNull();
   fireEvent.click(await screen.findByRole("link", { name: "Back to Wiki" }));
   expect(await screen.findByRole("heading", { name: "What Rovara knows about payments" })).toBeTruthy();
   expect(await screen.findByRole("link", { name: "billing" })).toBeTruthy();
   expect(screen.queryByRole("heading", { name: "Access ended" })).toBeNull();
  } finally { f.close(); }
 });
 it("a skill retired by someone else says so, and the Skills list stays usable", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=skills", skillRead: () => refuse(404, "NOT_FOUND", "That skill is no longer there.") });
  try {
   fireEvent.click((await screen.findAllByRole("button", { name: "Open add-queue" }))[0]!);
   expect(await screen.findByText("That skill is no longer there.")).toBeTruthy();
   expect(screen.queryByRole("heading", { name: "Access ended" })).toBeNull();
   fireEvent.click(await screen.findByRole("button", { name: "Back to Skills" }));
   expect(await screen.findByRole("heading", { name: "Skills in payments" })).toBeTruthy();
   expect(screen.queryByRole("heading", { name: "Access ended" })).toBeNull();
  } finally { f.close(); }
 });
 it("a 403 on a page read ends the access of the whole Wiki", async () => {
  const f = mount({ wikiRead: path => /\/wiki\/pages\/[^/]+$/u.test(path) ? refuse(403, "FORBIDDEN", "no") : undefined });
  try {
   expect(await screen.findByRole("heading", { name: "Access ended" })).toBeTruthy();
   expect(screen.queryByText("That page isn't in this wiki.")).toBeNull();
   expect(screen.queryByRole("link", { name: "billing" })).toBeNull();
  } finally { f.close(); }
 });
 it("a 403 on a skill read ends the access of the whole Skills page", async () => {
  const f = mount({ initial: "/app/projects/payments?tab=skills", skillRead: () => refuse(403, "FORBIDDEN", "no") });
  try {
   fireEvent.click((await screen.findAllByRole("button", { name: "Open add-queue" }))[0]!);
   expect(await screen.findByRole("heading", { name: "Access ended" })).toBeTruthy();
   expect(screen.queryByText("That skill is no longer there.")).toBeNull();
  } finally { f.close(); }
 });
});

describe("Mark wrong: a second send while the first is on its way", () => {
 it("two clicks and a second submit send ONE mark for one ticked claim", async () => {
  let release: () => void = () => undefined; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = mount({ writeGate: () => gate, write: () => json(200, { flagId: "flag-new-0001", pageId: BILLING }) });
  try {
   await screen.findByRole("heading", { name: "What it does" });
   await waitFor(() => expect(marks().length).toBeGreaterThan(0));
   fireEvent.click(screen.getByRole("button", { name: "Mark wrong: What it does" }));
   fireEvent.click(within(await screen.findByTestId("wiki-mark-claims")).getAllByRole("checkbox")[0]!);
   const form = screen.getByTestId("wiki-mark-form"), send = within(form).getByRole("button", { name: "Mark wrong" });
   fireEvent.click(send); fireEvent.click(send); fireEvent.submit(form);
   await waitFor(() => expect(f.sends).toHaveLength(1));
   release();
   await waitFor(() => expect(f.query.isFetching()).toBe(0));
   expect(f.sends).toHaveLength(1);
  } finally { release(); f.close(); }
 });
});

describe("the old screens are test-only (controller ruling R5)", () => {
 const LEGACY = ["WikiTab", "WikiPageView", "WikiBlocks", "SkillsTab", "SkillDetailView", "DisputedList", "GapsList"];
 const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/u.test(name) ? [path] : []; });
 it("no production file holds or imports an old Wiki / Skills screen, and they live only in the legacy test folder", () => {
  const source = walk(resolve("packages/ui/src"));
  for (const name of ["wiki/WikiTab", "wiki/WikiPageView", "wiki/WikiBlocks", "skills/SkillsTab", "skills/SkillDetailView"]) expect(existsSync(resolve("packages/ui/src/screens/project", name + ".tsx")), name).toBe(false);
  for (const file of source) {
   const text = readFileSync(file, "utf8");
   for (const name of LEGACY) expect(text, file + " uses " + name).not.toMatch(new RegExp("\\b(" + name + ")\\b"));
   expect(text, file).not.toMatch(/legacy-wiki-skills/u);
  }
  expect(existsSync(resolve("tests/web/support/legacy-wiki-skills/WikiTab.tsx"))).toBe(true);
 });
});

function WIKI_CORRECTION_WORDS_LABEL() { return /^What is wrong\?/u; }
