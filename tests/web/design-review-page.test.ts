// @vitest-environment jsdom
// Design review (DR11): the Design tab appears only for a task whose view has a design review; the Design first and Skip actions, the hint on a Quick plan's card, the choices on the cost card
// and the one-line reason on a design with an open blocker.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewSchema, SessionViewReaderSchema } from "@agentx/contracts/web";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { projectDecisionCards, type DecisionItem, type ItemBase } from "../../packages/broker/src/decisions/project.js";
import { designSpendCardItem } from "../../packages/broker/src/design-review/spend-card.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { designReviewFixture, designTaskSession, HOSTILE } from "./support/design-review-fixture.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const base = (id: string): ItemBase => ({ subjectId: id, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-11-03T10:00:00.000Z", contentVersion: "v1", openPath: "/app/sessions/ses_" + "a".repeat(20) });
const planItem: DecisionItem = { ...base("plan1"), kind: "approve_plan", path: "quick", files: ["src/retry.ts"], claims: 2, untestedClaims: 0 };
const designItem = (blockers: number): DecisionItem => ({ ...base("design1"), kind: "approve_design", files: ["src/retry.ts"], review: {
 reasons: ["new_api"], touches: [], reviewers: { planned: 3, verified: 3 }, blockers: Array.from({ length: blockers }, (_, index) => ({ section: "§3", text: "Blocker " + String(index + 1) })), majors: 0, disagreements: [], costUsd: 0.96 } });
const spendItem: DecisionItem = designSpendCardItem({ taskId: TASK, subjectId: "spend1", project: "payments", title: "Retry failed payments", createdAt: "2026-11-03T10:00:00.000Z", openPath: "/app/sessions/ses_" + "a".repeat(20), contentVersion: "v1", capUsd: 10,
 gate: { kind: "ask", why: "over_cap", estimateUsd: 12.5, choices: [{ choice: "lower_tier", tier: "light", estimateUsd: 2 }, { choice: "raise_cap", newCapUsd: 13 }, { choice: "skip" }] } as never });
const viewOf = (items: DecisionItem[]) => { const p = projectDecisionCards(items); return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped }); };

function screenSetup(session: ReturnType<typeof designTaskSession>, items: DecisionItem[] = []) {
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/decisions") return { status: 200, body: viewOf(items) };
  if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (request.method === "POST" && request.path.endsWith("/evidence-opened")) return { status: 200, body: { cardId: request.path.split("/").slice(-3, -1).join(":"), opened: true, recorded: true } };
  if (request.method === "POST" && request.path.includes("/decisions/")) return { status: 200, body: { cardId: "approve_design:design1", outcome: "approved", remainingTabs: [] } };
  if (request.method === "POST") return { status: 202, body: { ok: true } };
  return { status: 200, body: { session } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 const posts = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST" && !request.path.endsWith("/presence"));
 return { ...f, ...ui, posts, close() { ui.unmount();router.dispose();query.clear(); } };
}
function workspaceSetup(session: ReturnType<typeof designTaskSession>, hash = "") {
 const f = fakeHost(), parsed = SessionViewReaderSchema.parse(session);
 const router = createMemoryRouter([{ path: "*", element: h("main", {}, h(Workspace, { session: parsed })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID + hash] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(RouterProvider, { router }) }));
 return { ...ui, close() { ui.unmount();router.dispose(); } };
}

it("adds a Design tab only when the task view has a design review, and leaves every other task page as it was", () => {
 const without = workspaceSetup(workspaceFixture());
 expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Pipeline", "Plan", "Evidence", "Changes", "Pull request"]);
 without.close();
 const absent = workspaceSetup(designTaskSession(undefined));
 expect(screen.queryByRole("tab", { name: "Design" })).toBeNull();
 absent.close();
 const withReview = workspaceSetup(designTaskSession(designReviewFixture()));
 expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toContain("Design");
 withReview.close();
});

it("shows the review on the Design tab, with model words as text", async () => {
 const f = workspaceSetup(designTaskSession(designReviewFixture()), "#design");
 const region = await screen.findByRole("region", { name: "Design review" });
 expect(within(region).getByText("Design review: needed. Reason: adds a new API; changes the data model (Rovara's reading of the request).")).toBeTruthy();
 expect(within(region).getByText("$0.96")).toBeTruthy();
 expect(region.querySelector("script,img,a")).toBeNull();
 expect(region.textContent).toContain("[U+202E]");
 expect(within(region).getByRole("heading", { name: "Disagreements" })).toBeTruthy();
 f.close();
});

it("says a review this version cannot read is unreadable, and shows nothing it guessed", async () => {
 const session = designTaskSession(designReviewFixture());
 const task = (session.body as { task: { workflow: Record<string, unknown> } }).task;
 task.workflow.designReview = { ...(task.workflow.designReview as object), status: "brand_new_status" };
 const f = workspaceSetup(session, "#design");
 expect(await screen.findByText(/can't be shown by this version of the app/u)).toBeTruthy();
 expect(screen.queryByText("Done")).toBeNull();
 f.close();
});

it("offers Design first and Skip as the broker decided, and says why a Skip is refused", async () => {
 const session = designTaskSession(undefined, { designActions: { designFirst: true, skip: { allowed: true } } });
 const f = screenSetup(session);
 const strip = await screen.findByRole("region", { name: "Design review actions" });
 fireEvent.click(within(strip).getByRole("button", { name: "Design first" }));
 await waitFor(() => expect(f.posts().map(request => request.path)).toEqual(["/v1/app/tasks/" + TASK + "/design-review/first"]));
 expect(typeof (f.posts()[0]!.body as { requestId: unknown }).requestId).toBe("string");
 fireEvent.click(within(strip).getByRole("button", { name: "Skip design review" }));
 fireEvent.click(within(await screen.findByRole("group", { name: "Confirm skipping design review" })).getByRole("button", { name: "Skip design review" }));
 await waitFor(() => expect(f.posts().map(request => request.path)).toContain("/v1/app/tasks/" + TASK + "/design-review/skip"));
 f.close();
 const refused = screenSetup(designTaskSession(designReviewFixture({ status: "waiting_cost", rounds: [] }), { designActions: { designFirst: false, skip: { allowed: false, because: "needs_high_risk_approver", approverName: "Priya" } } }));
 expect(await screen.findByText("Ask Priya to skip: this design is high risk.")).toBeTruthy();
 expect(screen.queryByRole("button", { name: "Skip design review" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Design first" })).toBeNull();
 refused.close();
 const off = screenSetup(designTaskSession(designReviewFixture({ status: "waiting_cost", rounds: [] }), { designActions: { designFirst: false, skip: { allowed: false, because: "skip_off" } } }));
 expect(await screen.findByText("This project does not allow skipping design review.")).toBeTruthy();
 off.close();
});

it("says a design is not needed and offers Design first, and shows no actions when the broker offered none", async () => {
 const intent = { rounds: 0, pathFrom: "understand", answers: [], assessment: { kind: "ready", path: "QUICK", restatement: "Fix the typo.", assumptions: [], design: { needed: false, reasons: ["bug_fix"], note: "One module." } } };
 const f = screenSetup(designTaskSession(undefined, { designActions: { designFirst: true } }, { intent }));
 expect(await screen.findByText("Design review: not needed. Reason: a bug fix inside one module. Design first is available.")).toBeTruthy();
 f.close();
 const plain = screenSetup(designTaskSession(undefined));
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });
 expect(screen.queryByRole("region", { name: "Design review actions" })).toBeNull();
 plain.close();
});

it("puts a hint chip and Design first on a Quick plan's card, and never starts a review by itself", async () => {
 const f = screenSetup(designTaskSession(undefined, { designActions: { designFirst: true, hint: true } }), [planItem]);
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 expect(within(card).getByText("This may need design review.")).toBeTruthy();
 expect(f.posts()).toHaveLength(0);
 fireEvent.click(within(card).getByRole("button", { name: "Design first" }));
 await waitFor(() => expect(f.posts().map(request => request.path)).toEqual(["/v1/app/tasks/" + TASK + "/design-review/first"]));
 f.close();
 const quiet = screenSetup(designTaskSession(undefined), [planItem]);
 const plain = await screen.findByRole("article", { name: "Retry failed payments" });
 expect(within(plain).queryByRole("button", { name: "Design first" })).toBeNull();
 expect(within(plain).queryByText("This may need design review.")).toBeNull();
 quiet.close();
});

it("asks for a one-line reason on a design with an open blocker, requires it, and sends it only there", async () => {
 const f = screenSetup(designTaskSession(designReviewFixture()), [designItem(1)]);
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 // Medium cards need their evidence opened first.
 const summary = within(card).queryByText("Open the evidence to approve");
 if (summary !== null) { const details = summary.closest("details") as HTMLDetailsElement;details.open = true;fireEvent(details, new Event("toggle"));await waitFor(() => expect(f.posts().some(request => request.path.endsWith("/evidence-opened"))).toBe(true)); }
 const approve = within(card).getByRole("button", { name: "Approve with a reason" });
 const reason = within(card).getByRole("textbox", { name: "Why approve with an open blocker?" });
 await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(true));
 fireEvent.change(reason, { target: { value: "  Known gap‮,   fixed next week  " } });
 await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
 fireEvent.click(approve);
 await waitFor(() => expect(f.posts().some(request => request.path.endsWith("/approve"))).toBe(true));
 expect(f.posts().find(request => request.path.endsWith("/approve"))!.body).toMatchObject({ reason: "Known gap , fixed next week" });
 f.close();
 const clean = screenSetup(designTaskSession(designReviewFixture()), [designItem(0)]);
 const none = await screen.findByRole("article", { name: "Retry failed payments" });
 expect(within(none).queryByRole("textbox", { name: "Why approve with an open blocker?" })).toBeNull();
 clean.close();
 const plan = screenSetup(designTaskSession(undefined), [planItem]);
 const planCard = await screen.findByRole("article", { name: "Retry failed payments" });
 fireEvent.click(within(planCard).getByRole("button", { name: "Approve" }));
 await waitFor(() => expect(plan.posts().some(request => request.path.endsWith("/approve"))).toBe(true));
 expect(Object.keys(plan.posts().find(request => request.path.endsWith("/approve"))!.body as object)).not.toContain("reason");
 plan.close();
});

it("shows the cost card's choices as the card's own actions and posts the choice with what was shown", async () => {
 const f = screenSetup(designTaskSession(designReviewFixture({ status: "waiting_cost", rounds: [] })), [spendItem]);
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 const raise = within(card).queryByRole("button", { name: "Raise the limit to $13.00" });
 expect(raise).toBeTruthy();
 expect(within(card).getByRole("button", { name: /^Run Light/u })).toBeTruthy();
 expect(within(card).getByRole("button", { name: "Skip design review" })).toBeTruthy();
 const summary = within(card).queryByText("Open the evidence to approve") ?? within(card).queryByText("More evidence");
 if (summary !== null && summary.textContent === "Open the evidence to approve") { const details = summary.closest("details") as HTMLDetailsElement;details.open = true;fireEvent(details, new Event("toggle"));await waitFor(() => expect(raise!.hasAttribute("disabled")).toBe(false)); }
 fireEvent.click(raise!);
 await waitFor(() => expect(f.posts().some(request => request.path === "/v1/app/tasks/" + TASK + "/design-review/spend/raise-cap")).toBe(true));
 const sent = f.posts().find(request => request.path.endsWith("/spend/raise-cap"))!.body as Record<string, unknown>;
 expect(Object.keys(sent).sort()).toEqual(["requestId", "shownDigest"]);
 expect(sent.shownDigest).toMatch(/^[a-f0-9]{64}$/u);
 f.close();
});

it("keeps hostile finding text out of the page's links and scripts even on the task page", async () => {
 const f = screenSetup(designTaskSession(designReviewFixture()));
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });
 fireEvent.mouseDown(screen.getByRole("tab", { name: "Design" }), { button: 0, ctrlKey: false });
 await screen.findByRole("region", { name: "Design review" });
 expect(document.querySelector("main script, [onerror], img[src='x']")).toBeNull();
 expect(Array.from(document.querySelectorAll("a")).some(link => link.getAttribute("href")?.includes("evil.example"))).toBe(false);
 expect(HOSTILE.length).toBeGreaterThan(0);
 f.close();
});
