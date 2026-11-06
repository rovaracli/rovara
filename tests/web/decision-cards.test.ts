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
const base = (id: string, extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: id, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-10-30T10:00:00.000Z", contentVersion: "v1", openPath: "/app/sessions/ses_" + "a".repeat(20), ...extra });
const lowItem: DecisionItem = { ...base("plan1"), kind: "approve_plan", path: "quick", files: ["src/retry.ts"], claims: 2, untestedClaims: 0 };
const mediumItem: DecisionItem = { ...base("dep1", { taskId: undefined }), kind: "approve_dependency", packages: 2, newInstallScripts: false };
const highItem: DecisionItem = { ...base("set1", { taskId: undefined }), kind: "approve_setting", settingLabel: "Allow video", secondPerson: true };
const viewOf = (items: DecisionItem[]) => { const p = projectDecisionCards(items); return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped }); };

function setupHome(items: DecisionItem[], respond?: (request: { method: string; path: string }) => { status: number; body: unknown } | undefined) {
 let view = viewOf(items);
 const f = fakeHost(async request => {
  const custom = respond?.(request);if (custom) return custom;
  if (request.path === "/v1/app/decisions") return { status: 200, body: view };
  if (request.path === "/v1/app/home") return { status: 200, body: { cards: [], total: 0 } };
  if (request.method === "POST" && request.path.endsWith("/evidence-opened")) return { status: 200, body: { cardId: "approve_dependency:dep1", opened: true, recorded: true } };
  if (request.method === "POST") return { status: 200, body: { cardId: "approve_plan:plan1", outcome: "approved", remainingTabs: [] } };
  return { status: 200, body: { notices: [], next: "settled" } };
 });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 return { ...f, ...ui, query, set(next: DecisionItem[]) { view = viewOf(next); }, view: () => view };
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
 expect(approve.hasAttribute("disabled")).toBe(true);
 fireEvent.click(approve);
 expect(posts(f)).toHaveLength(0);
 const summary = screen.getByText("Show the evidence");
 (summary.closest("details") as HTMLDetailsElement).open = true;
 fireEvent(summary.closest("details")!, new Event("toggle"));
 await waitFor(() => expect(posts(f).map(r => r.path)).toEqual(["/v1/app/decisions/approve_dependency/dep1/evidence-opened"]));
 await waitFor(() => expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(false));
 fireEvent.click(screen.getByRole("button", { name: "Approve" }));
 await waitFor(() => expect(posts(f)).toHaveLength(2));
 expect(posts(f)[1]!.path).toBe("/v1/app/decisions/approve_dependency/dep1/approve");
});
it("gives a high card no Approve at all, only Open (the card on its task page)", async () => {
 const f = setupHome([highItem]);
 await screen.findByRole("heading", { name: "Retry failed payments" });
 expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
 expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/app/sessions/ses_" + "a".repeat(20));
 expect(screen.getByText("This decision is made on its own page.")).toBeTruthy();
 expect(screen.queryByText(/sign in again/)).toBeNull();
 expect(posts(f)).toHaveLength(0);
});
it("lists high first and offers no bulk control", async () => {
 setupHome([lowItem, mediumItem, highItem]);
 await screen.findByRole("heading", { name: "Needs you" });
 expect(screen.getAllByRole("article").map(a => a.getAttribute("data-risk"))).toEqual(["high", "medium", "low"]);
 expect(screen.queryByRole("button", { name: /all/i })).toBeNull();
});
it("rejects in one tap with a reason (a kind that can be put off; a document is sent back with Request changes instead)", async () => {
 const f = setupHome([{ ...base("fb1"), kind: "review_feedback", comments: 2, touchesSensitivePaths: false }]);
 await screen.findByRole("heading", { name: "Retry failed payments" });
 fireEvent.click(screen.getAllByText("Not now")[0]!);
 fireEvent.click(screen.getByRole("button", { name: "Too big" }));
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 expect(posts(f)[0]).toMatchObject({ path: "/v1/app/decisions/review_feedback/fb1/reject",  });
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
const failing = (status: number, body: unknown) => fakeHost(async request => request.path === "/v1/app/decisions" ? { status, body } : { status: 200, body: { cards: [], total: 0 } });
const renderHome = (f: ReturnType<typeof fakeHost>) => renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
it("WEB-1: a failed read of the decisions says so with a Try again (it used to be swallowed as 'no cards'), and the older Home cards still show", async () => {
 for (const [status, body] of [[403, { error: { code: "FORBIDDEN", message: "You can't see these." } }], [200, { cards: "nope" }]] as const) {
  const f = failing(status, body);
  const ui = renderHome(f);
  const alert = await screen.findByText(status === 403 ? "You can't see these." : /unreadable|Reload/);
  expect(alert.closest("[role=alert]")).not.toBeNull();
  expect(screen.getByRole("heading", { name: "Nothing needs you right now" })).toBeTruthy();
  const reads = () => f.request.mock.calls.filter(([r]) => r.path === "/v1/app/decisions").length;
  const before = reads();
  fireEvent.click(within(alert.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(reads()).toBeGreaterThan(before));
  ui.unmount();
 }
});
it("WEB-1: a server error on the decisions read says so too (after the client's own retries)", async () => {
 renderHome(failing(500, { error: { code: "INTERNAL", message: "The cards broke." } }));
 expect(await screen.findByText("The cards broke.", {}, { timeout: 8000 })).toBeTruthy();
}, 15000);
it("WEB-1: the task page says so when its decisions cannot be read", async () => {
 const { TaskDecisions } = await import("../../packages/ui/src/screens/home/NeedsYou.js");
 const f = failing(403, { error: { code: "FORBIDDEN", message: "You can't see these." } });
 renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(MemoryRouter, { children: h(TaskDecisions, { taskId: TASK }) }) }) }));
 expect(await screen.findByText("You can't see these.")).toBeTruthy();
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

it("I1: evidence-opened and approve send back the digest the card was shown with", async () => {
 const f = setupHome([mediumItem]);
 const digest = f.view().digests["approve_dependency:dep1"]!;
 const summary = await screen.findByText("Show the evidence");
 (summary.closest("details") as HTMLDetailsElement).open = true;
 fireEvent(summary.closest("details")!, new Event("toggle"));
 await waitFor(() => expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(false));
 fireEvent.click(screen.getByRole("button", { name: "Approve" }));
 await waitFor(() => expect(posts(f)).toHaveLength(2));
 expect(posts(f).map(r => (r.body as { shownDigest: string }).shownDigest)).toEqual([digest, digest]);
});
it("I4: the medium panel shows evidence that is not on the front", async () => {
 setupHome([{ ...mediumItem, details: [{ title: "Packages", lines: ["left-pad 1.3.0", "is-odd 3.0.1"] }] }]);
 await screen.findByText("Show the evidence");
 const front = screen.getByRole("article").querySelector(".rv-decision-evidence")!.textContent;
 expect(front).not.toContain("left-pad");
 expect(screen.getByText("left-pad 1.3.0")).toBeTruthy();
 expect(screen.getByRole("region", { name: "Why this needs a look", hidden: true }) ).toBeTruthy();
});
it("I3: on a stale answer the card forgets what was opened, loads the cards again and shows the new version needing a new opening", async () => {
 let stale = false;
 const f = setupHome([mediumItem], request => {
  if (stale && request.method === "POST" && request.path.endsWith("/approve")) { stale = false;return { status: 409, body: { error: { code: "CHANGE_STALE", message: "This changed since you loaded it. Reload to see the current version." } } }; }
  return undefined;
 });
 const open = async () => { const summary = await screen.findByText("Show the evidence");(summary.closest("details") as HTMLDetailsElement).open = true;fireEvent(summary.closest("details")!, new Event("toggle")); };
 await open();
 await waitFor(() => expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(false));
 // The item changes on the server; the approve is refused as stale.
 f.set([{ ...mediumItem, contentVersion: "v2" }]);
 const digestNow = f.view().digests["approve_dependency:dep1"];
 stale = true;
 const getsBefore = f.request.mock.calls.filter(([r]) => r.path === "/v1/app/decisions").length;
 fireEvent.click(screen.getByRole("button", { name: "Approve" }));
 await screen.findByRole("alert");
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.path === "/v1/app/decisions").length).toBeGreaterThan(getsBefore));
 // Approve is disabled again until the new version is opened.
 await waitFor(() => expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true));
 const opensBefore = posts(f).filter(r => r.path.endsWith("/evidence-opened")).length;
 const details = screen.getByText("Show the evidence").closest("details") as HTMLDetailsElement;
 details.open = false;fireEvent(details, new Event("toggle"));
 await open();
 await waitFor(() => expect(posts(f).filter(r => r.path.endsWith("/evidence-opened")).length).toBe(opensBefore + 1));
 expect((posts(f).at(-1)!.body as { shownDigest: string }).shownDigest).toBe(digestNow);
 await waitFor(() => expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(false));
});
it("I3: a card whose digest changes on a refetch must be opened again even without an error", async () => {
 const f = setupHome([mediumItem]);
 const summary = await screen.findByText("Show the evidence");
 (summary.closest("details") as HTMLDetailsElement).open = true;
 fireEvent(summary.closest("details")!, new Event("toggle"));
 await waitFor(() => expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(false));
 f.set([{ ...mediumItem, contentVersion: "v2" }]);
 await f.query.invalidateQueries({ queryKey: ["decisions"] });
 await waitFor(() => expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true));
});
it("I7: a 202 needs-confirmation answer is not shown as done: the card says nothing is decided and offers the confirmation page", async () => {
 const url = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
 const f = setupHome([lowItem], request => request.method === "POST" && request.path.endsWith("/approve") ? { status: 202, body: { cardId: "approve_plan:plan1", outcome: "needs_confirmation", confirmUrl: url } } : undefined);
 await screen.findByRole("heading", { name: "Retry failed payments" });
 fireEvent.click(screen.getByRole("button", { name: "Approve" }));
 await screen.findByText(/Nothing is decided yet/);
 fireEvent.click(screen.getByRole("button", { name: "Confirm on the next page" }));
 expect(f.host.openExternal).toHaveBeenCalledWith(url);
});
const MERGE_URL = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
const mergeItem: DecisionItem = { ...base("pr1"), kind: "merge", sessionId: "ses_" + "a".repeat(20), heads: [{ repositoryId: "payments", number: 7, headSha: "a".repeat(40) }], targets: [{ repositoryId: "payments", number: 7, baseBranch: "main" }], prRisk: "low", prReasons: [], proof: { proven: 1, passed: 0, failed: 0, notTested: 0 }, reviewVerdict: "approved", ci: "passing", securityFindingsHigh: 0, fullSuitePending: false };
const mergeAnswer = (merging: unknown) => (request: { method: string; path: string }) => request.method === "POST" && /\/approve(\?|$)/.test(request.path) ? { status: 202, body: { cardId: "merge:pr1", outcome: "needs_confirmation", confirmUrl: MERGE_URL, ...(merging === undefined ? {} : { merging }) } } : undefined;
it("WEB-1: a Merge press asks 'Merge #N into <branch>?' with Confirm and Cancel before anything is confirmed; Confirm opens the confirmation page, Cancel opens nothing", async () => {
 const f = setupHome([mergeItem], mergeAnswer([{ repositoryId: "payments", number: 7, baseBranch: "main" }]));
 await screen.findByRole("heading", { name: "Retry failed payments" });
 fireEvent.click(screen.getByRole("button", { name: "Review and merge" }));
 const group = await screen.findByRole("group", { name: "Confirm merge" });
 expect(within(group).getByText("Merge #7 into main? This can't be undone from Rovara.")).toBeTruthy();
 expect(f.host.openExternal).not.toHaveBeenCalled();
 fireEvent.click(within(group).getByRole("button", { name: "Cancel" }));
 expect(screen.queryByRole("group", { name: "Confirm merge" })).toBeNull();
 expect(f.host.openExternal).not.toHaveBeenCalled();
 expect(screen.getByText(/Nothing was merged/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Review and merge" }));
 fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
 expect(f.host.openExternal).toHaveBeenCalledTimes(1);
 expect(f.host.openExternal).toHaveBeenCalledWith(MERGE_URL);
 expect(screen.queryByRole("group", { name: "Confirm merge" })).toBeNull();
 expect(screen.queryByText(/Approved|Merged/)).toBeNull();
});
it("WEB-1: a Merge approve asks for the pull requests it names (?merging=1); another card's approve does not", async () => {
 const f = setupHome([mergeItem], mergeAnswer([{ repositoryId: "payments", number: 7, baseBranch: "main" }]));
 await screen.findByRole("heading", { name: "Retry failed payments" });
 fireEvent.click(screen.getByRole("button", { name: "Review and merge" }));
 await screen.findByRole("group", { name: "Confirm merge" });
 expect(posts(f)[0]!.path).toBe("/v1/app/decisions/merge/pr1/approve?merging=1");
});
it("WEB-1 S1: Approve, Cancel, Approve sends the same requestId, so the server makes one pending change; a changed card sends a new one", async () => {
 const f = setupHome([mergeItem], mergeAnswer([{ repositoryId: "payments", number: 7, baseBranch: "main" }]));
 await screen.findByRole("heading", { name: "Retry failed payments" });
 fireEvent.click(screen.getByRole("button", { name: "Review and merge" }));
 fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
 fireEvent.click(screen.getByRole("button", { name: "Review and merge" }));
 await screen.findByRole("group", { name: "Confirm merge" });
 const ids = posts(f).map(r => (r.body as { requestId: string }).requestId);
 expect(ids).toHaveLength(2);
 expect(ids[0]).toBe(ids[1]);
 expect(typeof ids[0]).toBe("string");
});
it("WEB-1 S2: the app reads an answer that carries a field it does not know yet", async () => {
 setupHome([mergeItem], request => request.method === "POST" && request.path.includes("/approve") ? { status: 202, body: { cardId: "merge:pr1", outcome: "needs_confirmation", confirmUrl: MERGE_URL, merging: [{ repositoryId: "payments", number: 7, baseBranch: "main" }], somethingNewer: { a: 1 } } } : undefined);
 await screen.findByRole("heading", { name: "Retry failed payments" });
 fireEvent.click(screen.getByRole("button", { name: "Review and merge" }));
 expect(await screen.findByRole("group", { name: "Confirm merge" })).toBeTruthy();
});
it("WEB-1: several pull requests are named with their repository and branch, and a hostile branch name is plain text", async () => {
 setupHome([mergeItem], mergeAnswer([{ repositoryId: "payments", number: 7, baseBranch: "main" }, { repositoryId: "billing", number: 8, baseBranch: "<img src=x onerror=alert(1)>" }]));
 await screen.findByRole("heading", { name: "Retry failed payments" });
 fireEvent.click(screen.getByRole("button", { name: "Review and merge" }));
 const group = await screen.findByRole("group", { name: "Confirm merge" });
 expect(group.textContent).toContain("Merge payments #7 into main and billing #8 into <img src=x onerror=alert(1)>? This can't be undone from Rovara.");
 expect(group.querySelector("img")).toBeNull();
});
it("WEB-1: a confirmation with nothing to name keeps the earlier wording and link (nothing is merged)", async () => {
 const f = setupHome([lowItem], mergeAnswer(undefined));
 await screen.findByRole("heading", { name: "Retry failed payments" });
 fireEvent.click(screen.getByRole("button", { name: "Approve" }));
 await screen.findByText(/Nothing is decided yet/);
 expect(screen.queryByRole("group", { name: "Confirm merge" })).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Confirm on the next page" }));
 expect(f.host.openExternal).toHaveBeenCalledWith(MERGE_URL);
});
it("WEB-1: a confirmation link that is not this app's own is never opened, even from Confirm", async () => {
 const f = setupHome([mergeItem], request => request.method === "POST" && /\/approve(\?|$)/.test(request.path) ? { status: 202, body: { cardId: "merge:pr1", outcome: "needs_confirmation", confirmUrl: "https://evil.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", merging: [{ repositoryId: "payments", number: 7, baseBranch: "main" }] } } : undefined);
 await screen.findByRole("heading", { name: "Retry failed payments" });
 fireEvent.click(screen.getByRole("button", { name: "Review and merge" }));
 await screen.findByText(/Nothing is decided yet/);
 expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
 expect(f.host.openExternal).not.toHaveBeenCalled();
});
it("WEB-1: the confirm panel has no accessibility violations", async () => {
 const f = setupHome([mergeItem], mergeAnswer([{ repositoryId: "payments", number: 7, baseBranch: "main" }]));
 await screen.findByRole("heading", { name: "Retry failed payments" });
 fireEvent.click(screen.getByRole("button", { name: "Review and merge" }));
 await screen.findByRole("group", { name: "Confirm merge" });
 await expectNoAxeViolations(f.container);
});
it("Q7: a high card that (wrongly) carries an approve action shows no Approve and cannot post one, because the client reader drops the card's refinements", async () => {
 const view = viewOf([highItem]);
 const wrong = { ...view, cards: view.cards.map(c => ({ ...c, actions: [{ kind: "approve", label: "Approve", href: "/v1/app/decisions/approve_setting/set1/approve", method: "POST" }, ...c.actions] })) };
 // The strict schema refuses this card (the server could never send it) ...
 expect(DecisionCardsViewSchema.safeParse(wrong).success).toBe(false);
 // ... but the reader the client uses accepts it, so the client's own guard is what stops the control.
 const f = fakeHost(async request => request.path === "/v1/app/decisions" ? { status: 200, body: wrong } : request.path === "/v1/app/home" ? { status: 200, body: { cards: [], total: 0 } } : { status: 200, body: {} });
 const query = createQueryClient();
 renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 await screen.findByRole("heading", { name: "Retry failed payments" });
 expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
});
it("Q7: the client's api refuses to post an approve for a high card, whatever its actions say", async () => {
 const { createDecisionsApi, readDecisions, mayApproveHere } = await import("../../packages/ui/src/api/decisions.js");
 const { DecisionCardsViewReaderSchema } = await import("@agentx/contracts/web");
 const view = viewOf([highItem]);
 const wrong = DecisionCardsViewReaderSchema.parse({ ...view, cards: view.cards.map(c => ({ ...c, actions: [{ kind: "approve", label: "Approve", href: "/v1/app/decisions/approve_setting/set1/approve", method: "POST" }, ...c.actions] })) });
 const [decision] = readDecisions(wrong);
 expect(mayApproveHere(decision!.card)).toBe(false);
 const f = fakeHost(async () => ({ status: 200, body: {} }));
 await expect(createDecisionsApi(f.host).approve(decision!, undefined)).rejects.toMatchObject({ code: "FORBIDDEN" });
 expect(f.request).not.toHaveBeenCalled();
});
it("I3: a stale answer clears what was opened even when the refetched card has the same digest", async () => {
 let stale = false;
 const f = setupHome([mediumItem], request => stale && request.method === "POST" && request.path.endsWith("/approve") ? ((stale = false), { status: 409, body: { error: { code: "CHANGE_STALE", message: "Reload." } } }) : undefined);
 const summary = await screen.findByText("Show the evidence");
 (summary.closest("details") as HTMLDetailsElement).open = true;
 fireEvent(summary.closest("details")!, new Event("toggle"));
 await waitFor(() => expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(false));
 stale = true;
 fireEvent.click(screen.getByRole("button", { name: "Approve" }));
 await screen.findByRole("alert");
 await waitFor(() => expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true));
 expect(posts(f).filter(r => r.path.endsWith("/approve"))).toHaveLength(1);
});
it("a card with no valid digest is not shown (a server that cannot say what it shows)", async () => {
 const view = viewOf([lowItem]);
 const f = fakeHost(async request => request.path === "/v1/app/decisions" ? { status: 200, body: { ...view, digests: {} } } : { status: 200, body: { cards: [], total: 0 } });
 const query = createQueryClient();
 renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 await screen.findByRole("heading", { name: "Nothing needs you right now" });
});
it("a high card says 'sign in again' only when it opens the confirmation page", async () => {
 setupHome([{ ...highItem, confirmPath: "/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" }]);
 await screen.findByText(/after you sign in again/);
 expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
});
it("the design tab's Approve waits for the requirements", async () => {
 const f = setupHome([{ ...base("req1"), kind: "approve_requirements", claims: 3 }, { ...base("des1"), kind: "approve_design", files: [] }]);
 await screen.findByRole("tab", { name: "Design" });
 fireEvent.mouseDown(screen.getByRole("tab", { name: "Design" }), { button: 0 });fireEvent.click(screen.getByRole("tab", { name: "Design" }));
 await waitFor(() => expect(screen.getByRole("button", { name: "Approve design" }).hasAttribute("disabled")).toBe(true));
 expect(posts(f)).toHaveLength(0);
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
