// @vitest-environment jsdom
// Decisions D3/P7: decision cards on Home and the task page follow the card's friction, the Evidence tab shows the pack as text with safe links, and the plan shows on one screen.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewSchema, SessionViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { HomeScreen } from "../../packages/ui/src/screens/home/HomeScreen.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { projectDecisionCards, type DecisionItem, type ItemBase } from "../../packages/broker/src/decisions/project.js";
import { SWIPE_APPROVE_PX } from "../../packages/ui/src/design/DecisionCard.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const base = (id: string, extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: id, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-10-30T10:00:00.000Z", openPath: "/app/sessions/ses_" + "a".repeat(20), ...extra });
const lowItem: DecisionItem = { ...base("plan1"), kind: "approve_plan", path: "quick", files: ["src/retry.ts"], claims: 2, untestedClaims: 0 };
const mediumItem: DecisionItem = { ...base("dep1", { taskId: undefined }), kind: "approve_dependency", packages: 2, newInstallScripts: false };
const highItem: DecisionItem = { ...base("set1", { taskId: undefined }), kind: "approve_setting", settingLabel: "Allow video", secondPerson: true };
const viewOf = (items: DecisionItem[]) => { const p = projectDecisionCards(items); return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs }); };

function setupHome(items: DecisionItem[]) {
 let view = viewOf(items);
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/decisions") return { status: 200, body: view };
  if (request.path === "/v1/app/home") return { status: 200, body: { cards: [], total: 0 } };
  if (request.method === "POST" && request.path.endsWith("/evidence-opened")) return { status: 200, body: { cardId: "approve_dependency:dep1", opened: true, recorded: true } };
  if (request.method === "POST") return { status: 200, body: { cardId: "approve_plan:plan1", outcome: "approved", remainingTabs: [] } };
  return { status: 200, body: { notices: [], next: "settled" } };
 });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 return { ...f, ...ui, query, set(next: DecisionItem[]) { view = viewOf(next); } };
}
const posts = (f: ReturnType<typeof setupHome>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method === "POST");

it("shows a low card with one-tap Approve that posts once to the card's own route", async () => {
 const f = setupHome([lowItem]);
 await screen.findByRole("heading", { name: "Retry failed payments" });
 fireEvent.click(screen.getByRole("button", { name: "Approve" }));
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 expect(posts(f)[0]).toMatchObject({ method: "POST", path: "/v1/app/decisions/approve_plan/plan1/approve" });
 expect(typeof (posts(f)[0]!.body as { requestId: unknown }).requestId).toBe("string");
});
it("keeps Approve disabled on a medium card until the evidence panel was opened and recorded", async () => {
 const f = setupHome([mediumItem]);
 const approve = await screen.findByRole("button", { name: "Approve" });
 expect(approve.disabled).toBe(true);
 fireEvent.click(approve);
 expect(posts(f)).toHaveLength(0);
 const summary = screen.getByText("Open the evidence to approve");
 (summary.closest("details") as HTMLDetailsElement).open = true;
 fireEvent(summary.closest("details")!, new Event("toggle"));
 await waitFor(() => expect(posts(f).map(r => r.path)).toEqual(["/v1/app/decisions/approve_dependency/dep1/evidence-opened"]));
 await waitFor(() => expect((screen.getByRole("button", { name: "Approve" })).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button", { name: "Approve" }));
 await waitFor(() => expect(posts(f)).toHaveLength(2));
 expect(posts(f)[1]!.path).toBe("/v1/app/decisions/approve_dependency/dep1/approve");
});
it("gives a high card no Approve at all, only Open to decide", async () => {
 const f = setupHome([highItem]);
 await screen.findByRole("heading", { name: "Retry failed payments" });
 expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
 expect(screen.getByRole("link", { name: "Open to decide" }).getAttribute("href")).toBe("/app/sessions/ses_" + "a".repeat(20));
 expect(screen.getByText(/after you sign in again/)).toBeTruthy();
 expect(posts(f)).toHaveLength(0);
});
it("lists high first and offers no bulk control", async () => {
 setupHome([lowItem, mediumItem, highItem]);
 await screen.findByRole("heading", { name: "Needs you" });
 expect(screen.getAllByRole("article").map(a => a.getAttribute("data-risk"))).toEqual(["high", "medium", "low"]);
 expect(screen.queryByRole("button", { name: /all/i })).toBeNull();
});
it("rejects in one tap with a reason", async () => {
 const f = setupHome([lowItem]);
 await screen.findByRole("heading", { name: "Retry failed payments" });
 fireEvent.click(screen.getAllByText("Not now")[0]!);
 fireEvent.click(screen.getByRole("button", { name: "Too big" }));
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 expect(posts(f)[0]).toMatchObject({ path: "/v1/app/decisions/approve_plan/plan1/reject",  });
 expect(posts(f)[0]!.body).toMatchObject({ reason: "too_big" });
});
it("swipes to approve only a low card, only far enough and mostly sideways", async () => {
 const f = setupHome([lowItem, mediumItem]);
 const cards = await screen.findAllByRole("article");
 const medium = cards.find(c => c.getAttribute("data-risk") === "medium")!, low = cards.find(c => c.getAttribute("data-risk") === "low")!;
 const swipe = (el: HTMLElement, dx: number, dy = 0) => { fireEvent.touchStart(el, { touches: [{ clientX: 10, clientY: 10 }] });fireEvent.touchEnd(el, { changedTouches: [{ clientX: 10 + dx, clientY: 10 + dy }] }); };
 swipe(medium, SWIPE_APPROVE_PX + 50);
 swipe(low, SWIPE_APPROVE_PX - 10);
 swipe(low, SWIPE_APPROVE_PX + 50, 200);
 expect(posts(f)).toHaveLength(0);
 swipe(low, SWIPE_APPROVE_PX + 50);
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 expect(posts(f)[0]!.path).toBe("/v1/app/decisions/approve_plan/plan1/approve");
});
it("renders hostile titles as text and refuses to follow an address the card made up", async () => {
 const view = viewOf([lowItem]);
 const evil = { ...view, cards: view.cards.map(c => ({ ...c, title: "<img src=x onerror=alert(1)>", actions: c.actions.map(a => a.kind === "approve" ? { ...a, href: "/v1/app/decisions/approve_plan/other/approve" } : a) })) };
 const f = fakeHost(async request => request.path === "/v1/app/decisions" ? { status: 200, body: evil } : request.path === "/v1/app/home" ? { status: 200, body: { cards: [], total: 0 } } : { status: 200, body: {} });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 await screen.findByText("<img src=x onerror=alert(1)>");
 expect(ui.container.querySelector("img")).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Approve" }));
 await screen.findByRole("alert");
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
});
it("shows nothing extra when the server has no decisions or does not know the route", async () => {
 const f = fakeHost(async request => request.path === "/v1/app/decisions" ? { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } } : { status: 200, body: { cards: [], total: 0 } });
 const query = createQueryClient();
 renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 await screen.findByRole("heading", { name: "Nothing needs you right now" });
 expect(screen.queryByRole("heading", { name: "Needs you" })).toBeNull();
});
it("shows a Full pair as one card with two tabs, each its own approval", async () => {
 const f = setupHome([{ ...base("req1"), kind: "approve_requirements", claims: 3 }, { ...base("des1"), kind: "approve_design", files: [] }]);
 await screen.findByRole("tab", { name: "Requirements" });
 expect(screen.getAllByRole("article")).toHaveLength(1);
 fireEvent.click(screen.getByRole("button", { name: "Approve requirements" }));
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 expect(posts(f)[0]!.body).toMatchObject({ tab: "requirements" });
});
it("has no accessibility violations", async () => {
 const f = setupHome([lowItem, mediumItem, highItem]);
 await screen.findByRole("heading", { name: "Needs you" });
 await expectNoAxeViolations(f.container);
});

// ---- the task page: decision card, Evidence tab, one-screen plan
const sha = (c: string) => c.repeat(64);
const evidence = {
 schemaVersion: 1, candidateDigest: sha("a"),
 environment: { tier: "sandbox", envRevision: 3, services: [{ name: "partner-scorer", mode: "mocked", recordedAt: "2026-11-02T10:00:00.000Z" }], data: "synthetic", accounts: [{ profileId: "buyer", kind: "run_scoped" }] },
 checks: [{ checkId: "unit", kind: "test", label: "Unit tests", before: "failed", after: "passed", class: "fixed", durationMs: 4200,
  tests: { total: 3, passed: 2, failed: 0, skipped: 1, errored: 0, names: [{ name: "test_no_region", status: "passed", proof: "proves_change" }, { name: "<b>x</b>", status: "skipped" }], newTests: ["test_no_region"] },
  coverage: { linesChanged: 48, linesCovered: 41, files: [{ path: "src/match.py", uncovered: [10, 11] }] } }],
 selection: { method: "coverage_map", selected: 37, total: 1240, mapAgeHours: 14 },
 api: [{ scenarioId: "rank-top5", samples: [{ kind: "api_sample_json", sha256: sha("b"), bytes: 900, retentionClass: "evidence-std", state: "available", href: "/v1/app/tasks/t/evidence/" + sha("b") }], diff: "none", changedPaths: [] }],
 browser: [{ scenarioId: "checkout", strip: { before: [{ kind: "jpeg", sha256: sha("c"), bytes: 5000, retentionClass: "evidence-std", state: "available", href: "/v1/app/tasks/t/evidence/" + sha("c") }], after: [{ kind: "jpeg", sha256: sha("d"), bytes: 5000, retentionClass: "evidence-std", state: "expired" }] },
  trace: { kind: "trace_zip", sha256: sha("e"), bytes: 9000, retentionClass: "evidence-short", state: "available", href: "/v1/app/tasks/t/evidence/" + sha("e") }, consoleErrors: 2, withheld: [{ artifact: "video", reason: "account_not_run_scoped" }] }],
 notTested: [{ kind: "mocked_service", id: "partner-scorer", text: "SageMaker timeout", reason: "a mock cannot produce it" }, { kind: "not_selected", id: "sel", text: "1,203 tests not selected", reason: "judged unaffected" }],
};
function setupWorkspace(taskOverrides: Record<string, unknown>, hash: string) {
 const session = SessionViewReaderSchema.parse(workspaceFixture({}, taskOverrides)), f = fakeHost(async request => request.path === "/v1/app/decisions" ? { status: 200, body: viewOf([lowItem]) } : { status: 200, body: {} });
 const router = createMemoryRouter([{ path: "*", element: h("main", {}, h(Workspace, { session })) }], { initialEntries: ["/app/sessions/x" + hash] });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { ...ui, ...f };
}
it("shows the task's decision card on the task page (not on other tasks')", async () => {
 const { TaskDecisions } = await import("../../packages/ui/src/screens/home/NeedsYou.js");
 const f = fakeHost(async request => request.path === "/v1/app/decisions" ? { status: 200, body: viewOf([lowItem, { ...mediumItem, taskId: "22222222-2222-4222-8222-222222222222" }]) } : { status: 200, body: {} });
 const query = createQueryClient();
 renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(TaskDecisions, { taskId: TASK }) }) }) }));
 expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
 expect(screen.getAllByRole("article")).toHaveLength(1);
});
it("renders the Evidence tab from the pack: checks, tests, coverage, API, browser, environment, with safe links", async () => {
 const f = setupWorkspace({ evidence }, "#tests");
 expect(screen.getByRole("tab", { name: "Evidence" })).toBeTruthy();
 const checks = screen.getByRole("region", { name: "Tests" });
 expect(within(checks).getByText(/before: failed, after: passed, fixed/)).toBeTruthy();
 expect(screen.getByText("37 of 1240 tests selected (coverage map, 14 h old). 1203 not run.")).toBeTruthy();
 expect(screen.getByText("41 of 48 changed lines covered (85%).")).toBeTruthy();
 expect(screen.getByText(/uncovered lines: 10, 11/)).toBeTruthy();
 expect(screen.getAllByText("test_no_region", { selector: "li" }).length).toBe(2);
 expect(screen.getByText(/fails on the original code/)).toBeTruthy();
 expect(f.container.querySelector("b")).toBeNull();
 expect(screen.getByText("no difference from before")).toBeTruthy();
 expect(screen.getByRole("link", { name: /Sample 1/ }).getAttribute("href")).toBe("https://cell.example/v1/app/tasks/t/evidence/" + sha("b"));
 expect(f.container.querySelectorAll("img")).toHaveLength(1);
 expect(screen.getByText("Step 1 expired")).toBeTruthy();
 expect(screen.getByRole("link", { name: "Download the trace" }).getAttribute("href")).toContain("/v1/app/tasks/t/evidence/");
 expect(screen.getByText("Video not kept: an account is not single-use.")).toBeTruthy();
 expect(screen.getByText(/Sandbox, revision 3/)).toBeTruthy();
 expect(screen.getByText(/partner-scorer/, { selector: "li" })).toBeTruthy();
 expect(screen.getByText("SageMaker timeout (a mock cannot produce it)")).toBeTruthy();
 expect(f.container.querySelector("iframe,object,embed")).toBeNull();
});
it("never follows an artifact link that leaves this origin or this API", async () => {
 const bad = structuredClone(evidence);
 bad.api[0]!.samples[0]!.href = "/v1/app/tasks/t/evidence/" + sha("b");
 const f = setupWorkspace({ evidence: bad }, "#tests");
 expect(screen.getByRole("link", { name: /Sample 1/ }).getAttribute("href")?.startsWith("https://cell.example/")).toBe(true);
 f.unmount();
});
it("shows the plan on one screen and keeps the full plan behind Details", () => {
 const planOneScreen = { problem: "Retry failed payments: payments are dropped.", approach: ["Retry on timeout."], files: ["src/retry.ts"], filesMore: 2, risks: ["A slow gateway."], cost: "about $1.20 to $3.10", proof: [{ claim: "Retry on timeout.", how: "test" }], characters: 300, fullCharacters: 2100, tooBig: true };
 const f = setupWorkspace({ planOneScreen }, "#plan");
 const region = screen.getByRole("region", { name: "Plan on one screen" });
 expect(within(region).getByText("Retry on timeout.: a test")).toBeTruthy();
 expect(within(region).getByText("src/retry.ts and 2 more")).toBeTruthy();
 expect(screen.getByRole("status").textContent).toContain("too big for one screen");
 expect(screen.getByText("Details").closest("details")).toBeTruthy();
 expect(workspaceWorkflow().planContent).toBeDefined();
 f.unmount();
});
