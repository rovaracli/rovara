// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createCandidateManifest } from "@agentx/contracts";
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "2".repeat(40), treeSha: "3".repeat(40), baseCommitSha: "1".repeat(40) }]);
const decisions = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> };
function spendView() {
 const view = decisions.views["approve_spend"] as { cards: Array<Record<string, unknown>> };
 return { ...view, cards: [{ ...view.cards[0], actions: ["lower-tier", "raise-cap", "run-unpriced", "skip"].map(choice => ({ kind: "choose", method: "POST", href: `/v1/app/tasks/11111111-1111-4111-8111-111111111111/design-review/spend/${choice}`, label: choice })) }] };
}
function mount(decision?: string, pinned = true, hash = "", mode = "unknown") {
 let changed = false, settled = false, refused = false;
 const base = workspaceFixture(), session = workspaceFixture({ you: { ...base.you, actions: ["stop", "close", "share", "take_over", "retry"], live: { fix: true } }, errorRef: { kind: "operation_failed", code: "CHECK_FAILED", subject: { taskId: "11111111-1111-4111-8111-111111111111" }, at: base.updatedAt } }, { workflow: { ...workspaceWorkflow(), revision: 16, ...(pinned ? { candidate } : {}) }, secondReview: { lines: ["Second review did not run"], needsAcknowledgement: true, acknowledged: false, canAcknowledge: true }, unpublished: [{ repository: "acme/payments", reasons: ["worktree_changes"] }], testOffer: { capUsd: 1 }, designActions: { designFirst: true, skip: { allowed: true } } });
 let current = session;
 const f = fakeHost(async r => {
  const path = r.path.split("?")[0];
  if (r.method === "POST" && r.path.endsWith("/reject") && mode === "done") return { status: 200, body: { cardId: "fix_setup:fix1", outcome: "rejected", remainingTabs: [] } };
  if (r.method !== "GET" && !r.path.endsWith("/presence")) return { status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT", message: "Changed" } } };
  if (path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (path === "/v1/app/nav") return { status: 200, body: navFixture() };
  if (path === "/v1/app/sessions/" + session.sessionId) return { status: 200, body: { session: current } };
  if (path === "/v1/app/sessions") return { status: 200, body: { tasks: [] } };
  if (path === "/v1/app/decisions" && refused) return { status: 403, body: { error: { code: "FORBIDDEN", message: "Decision access ended" } } };
  if (path === "/v1/app/decisions") return { status: 200, body: decision === undefined ? { cards: [] } : decision === "approve_spend" ? spendView() : changed ? { ...(decisions.views[decision] as object), cards: [], total: 0 } : settled && decision === "fix_setup" ? { ...(decisions.views[decision] as object), cards: (decisions.views[decision] as {cards: object[]}).cards.map(card => ({ ...card, status: "rejected" })) } : decisions.views[decision] };
  if (path?.endsWith("/people")) return { status: 200, body: { people: { revision: 3, orphaned: false, canManage: true, canTakeOwnership: false, people: [{ personId: "22222222-2222-4222-8222-222222222222", name: "Ada", role: "owner", you: true, effectiveRole: "owner" }] }, sharedWith: [{ developerId: "d".repeat(64), name: "Dan", role: "viewer" }] } };
  if (path?.endsWith("/candidates")) return { status: 200, body: { candidates: [], complete: true } };
  if (path?.endsWith("/messages")) return { status: 200, body: { messages: [], hasMore: false } };
  if (path?.endsWith("/events")) return { status: 200, body: { events: [] } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + session.sessionId + hash] });
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) });
 let ui = renderUi(tree());
 return { f, query, remount() { ui.unmount();query.clear();ui = renderUi(tree()); }, refuse() { refused = true; }, change() { changed = true; }, settle() { settled = true; }, drift() { current = workspaceFixture({ ...session, revision: 2 }, { workflow: { ...workspaceWorkflow(), revision: 17, candidate } }); }, close() { ui.unmount();router.dispose();query.clear(); } };
}
// DEC366/367 action + authority coverage lives in task-page-action-complete.test.ts.
it("DEC283: unserved controls stay hidden even when the task advertises them", async () => {
 const s = mount();try {
  await screen.findByTestId("task-page");await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  for (const label of ["Fix with agent", "Continue as a normal task", "I've seen it"]) expect(screen.queryByRole("button", { name: label, hidden: true })).toBeNull();
  expect(s.f.request.mock.calls.filter(([r]) => r.method !== "GET" && !r.path.endsWith("/presence"))).toHaveLength(0);
 } finally { s.close(); }
});
it("DEC283: Stop remains live, says exactly what stops, and a 409 sends once", async () => {
 const s = mount();try {
  const trigger = await screen.findByRole<HTMLButtonElement>("button", { name: "Stop" });await waitFor(() => expect(trigger.disabled).toBe(false));fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");expect(dialog.textContent).toContain("Stop pauses this task. Its files are kept; Retry continues from them.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Stop session" }));
  await waitFor(() => expect(s.f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/stop"))).toHaveLength(1));
  const sent = s.f.request.mock.calls.find(([r]) => r.method === "POST" && r.path.endsWith("/stop"))![0];expect(sent.path).toMatch(/\/stop$/);expect(Object.keys(sent.body as object)).toEqual(["requestId"]);
 } finally { s.close(); }
});

it("DEC283 Retry pins the displayed workflow before the authority GET updates the cache", async () => {
 const s = mount();try {
  const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry" });await waitFor(() => expect(retry.disabled).toBe(false));s.drift();fireEvent.click(retry);
  await waitFor(() => expect(s.f.request.mock.calls.filter(([r]) => r.path.endsWith("/retry"))).toHaveLength(1));
  expect(s.f.request.mock.calls.find(([r]) => r.path.endsWith("/retry"))![0].body).toMatchObject({ expectedRevision: 16, candidateDigest: candidate.digest });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });expect(s.f.request.mock.calls.filter(([r]) => r.path.endsWith("/retry"))).toHaveLength(1);
 } finally { s.close(); }
});
it("DEC283 Retry without a served candidate is held without a send", async () => {
 const s = mount(undefined, false);try {
  const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry" });expect(retry.disabled).toBe(true);expect(retry.parentElement?.parentElement?.textContent).toContain("Cannot tell yet");fireEvent.click(retry);expect(s.f.request.mock.calls.filter(([r]) => r.path.endsWith("/retry"))).toHaveLength(0);
 } finally { s.close(); }
});
it("DEC283 unsupported dependency rejection is hidden because Code refuses it", async () => {
 const s = mount("approve_dependency");try {
  const card = await screen.findByRole("region", { name: "Your decision" });expect(within(card).queryByText("Not now")).toBeNull();expect(s.f.request.mock.calls.some(([r]) => r.path.endsWith("/reject"))).toBe(false);
 } finally { s.close(); }
});
for (const [reason, label] of [["wrong_problem", "Wrong problem"], ["wrong_approach", "Wrong approach"], ["too_big", "Too big"], ["missing_test", "Missing test"], ["not_now", "Not now"], ["other", "Other"]] as const) it(`DEC283 served fix-setup rejection sends its documented reason once: ${reason}`, async () => {
 const s = mount("fix_setup", true, "", "done");try {
  const card = await screen.findByRole("region", { name: "Your decision" });fireEvent.click(within(card).getByText("Not now", { selector: "summary" }));
  fireEvent.click(within(card).getByRole("button", { name: label }));
  await waitFor(() => expect(s.f.request.mock.calls.filter(([r]) => r.path.endsWith("/reject"))).toHaveLength(1));
  expect(s.f.request.mock.calls.find(([r]) => r.path.endsWith("/reject"))![0]).toMatchObject({ path: "/v1/app/decisions/fix_setup/fix1/reject", body: { reason }, retry: "never" });
  expect(typeof (s.f.request.mock.calls.find(([r]) => r.path.endsWith("/reject"))![0].body as { requestId?: unknown }).requestId).toBe("string");
 } finally { s.close(); }
});
it("DEC283 stale rejection loses authority before dispatch", async () => {
 const s = mount("fix_setup");try {
  const card = await screen.findByRole("region", { name: "Your decision" });fireEvent.click(within(card).getByText("Not now", { selector: "summary" }));s.change();
  fireEvent.click(within(card).getByRole("button", { name: "Wrong problem" }));await waitFor(() => expect(screen.queryByText("Not now", { selector: "summary" })).toBeNull());
  expect(s.f.request.mock.calls.filter(([r]) => r.path.endsWith("/reject"))).toHaveLength(0);
 } finally { s.close(); }
});
it("DEC283 design spend choices have no route and are hidden on the real decision card", async () => {
 const s = mount("approve_spend");try {
  const card = await screen.findByRole("region", { name: "Spend request" });
  for (const label of ["lower-tier", "raise-cap", "run-unpriced", "skip"]) expect(within(card).queryByRole("button", { name: label, hidden: true })).toBeNull();
  expect(s.f.request.mock.calls.filter(([r]) => r.path.includes("/design-review/spend/"))).toHaveLength(0);
 } finally { s.close(); }
});

it("DEC283 second-review acknowledgement stays hidden on the real Evidence route", async () => {
 const s = mount(undefined, true, "#tests");try {
  await screen.findByText("Second review did not run");expect(screen.queryByRole("button", { name: "I've seen it", hidden: true })).toBeNull();expect(s.f.request.mock.calls.some(([r]) => r.path.endsWith("/second-review-acknowledge"))).toBe(false);
 } finally { s.close(); }
});

it("DEC283 a refused authority read sends no rejection", async () => {
 const s = mount("fix_setup");try {
  const card = await screen.findByRole("region", { name: "Your decision" });fireEvent.click(within(card).getByText("Not now", { selector: "summary" }));s.refuse();
  fireEvent.click(within(card).getByRole("button", { name: "Wrong problem" }));await screen.findByText("Decision access ended");
  expect(s.f.request.mock.calls.filter(([r]) => r.path.endsWith("/reject"))).toHaveLength(0);
 } finally { s.close(); }
});
it("DEC283 unknown rejection stays locked after reload and Check settles only a served outcome", async () => {
 const s = mount("fix_setup");try {
  let card = await screen.findByRole("region", { name: "Your decision" });fireEvent.click(within(card).getByText("Not now", { selector: "summary" }));
  fireEvent.click(within(card).getByRole("button", { name: "Wrong problem" }));await screen.findByRole("button", { name: "Check" });
  const stored = [...s.f.storage.entries()].find(([key]) => key.startsWith("rv:decision-approval:") && !key.endsWith(":answer"));expect(stored?.[1]).toContain('"reason":"wrong_problem"');
  s.remount();card = await screen.findByRole("region", { name: "Your decision" });await within(card).findByRole("button", { name: "Check" });
  fireEvent.click(within(card).getByText("Not now", { selector: "summary" }));expect(within(card).getByRole<HTMLButtonElement>("button", { name: "Wrong problem" }).disabled).toBe(true);
  fireEvent.click(within(card).getByRole("button", { name: "Check" }));await screen.findByText(/still reads as pending/);
  expect(s.f.storage.get(stored![0])).toBe(stored![1]);s.settle();fireEvent.click(within(card).getByRole("button", { name: "Check" }));
  await waitFor(() => expect(s.f.storage.get(stored![0])).toBe(""));expect(s.f.request.mock.calls.filter(([r]) => r.path.endsWith("/reject"))).toHaveLength(1);
 } finally { s.close(); }
});
