// @vitest-environment jsdom
// Review tests (lead 4 Opus, WIRING-2+3 at 2fb988b47): pins three guards whose single-line mutants survived the lane's suites.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createDecisionsApi, readDecisions } from "../../packages/ui/src/api/decisions.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { ID, TASKS, PLAN, PROOF, EVENTS, decisionsView } from "./support/work-fixture.js";
import { sessionFixture, SESSION_FIXTURE_ID, taskFixture } from "./support/session-fixture.js";

const fixture = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> };
const confirmUrl = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
const decisionFor = (operation: "approve" | "changes" | "reject") => readDecisions(DecisionCardsViewReaderSchema.parse(fixture.views[operation === "reject" ? "approve_dependency" : "approve_plan_with_choices"]))[0]!;
function press(host: ReturnType<typeof fakeHost>["host"], operation: "approve" | "changes" | "reject", decision: ReturnType<typeof decisionFor>) {
 const me = meFixture(), identity = { orgId: me.org.orgId, developerId: me.developer.id }, api = createDecisionsApi(host);
 return operation === "approve" ? api.approve(decision, undefined, undefined, undefined, identity) : operation === "changes" ? api.requestChanges(decision, "Please add a regression") : api.reject(decision, "not_now");
}

// 202 needs_confirmation keeps THE SAME request: the frozen decision lock holds exactly the requestId that went on the wire (a fresh id would orphan the server's pending confirmation).
it.each(["approve", "changes", "reject"] as const)("a 202 confirmation to %s keeps the sent requestId in the shared decision lock", async operation => {
 const decision = decisionFor(operation), me = meFixture();
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : { status: 202, body: { cardId: decision.card.id, outcome: "needs_confirmation", confirmUrl } });
 expect(await press(f.host, operation, decision)).toMatchObject({ kind: "needs_confirmation", confirmUrl });
 const posts = f.request.mock.calls.filter(([r]) => r.method === "POST");
 expect(posts).toHaveLength(1);
 const sent = (posts[0]![0].body as { requestId: string }).requestId;
 const lock = f.storage.get(`rv:decision-approval:${me.org.orgId}:${me.developer.id}:${decision.card.id}`);
 expect(lock).toBeTruthy();
 expect((JSON.parse(lock!) as { requestId: string; body: { requestId: string } }).requestId).toBe(sent);
 expect((JSON.parse(lock!) as { requestId: string; body: { requestId: string } }).body.requestId).toBe(sent);
});

// The decision catches use the ROUTE-BOUND classifier: a 4xx that is not an audited final refusal for THIS route stays unknown with the lock kept.
// IDEMPOTENCY_CONFLICT is final on no decision route; CHANGE_STALE is final on the document gate but NOT on a dependency card's reject.
it.each([["approve", "IDEMPOTENCY_CONFLICT"], ["changes", "IDEMPOTENCY_CONFLICT"], ["reject", "CHANGE_STALE"]] as const)("a non-final 4xx (%s, %s) is APPROVAL_UNKNOWN with the lock kept, never the server's refusal", async (operation, code) => {
 const decision = decisionFor(operation), me = meFixture(), identity = { orgId: me.org.orgId, developerId: me.developer.id };
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : { status: 409, body: { error: { code, message: "Server words" } } });
 await expect(press(f.host, operation, decision)).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
 expect(await createDecisionsApi(f.host).hasUnknownApproval(decision, identity)).toBe(true);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
});

// DEC 254zzz374: Continue is refused AT SEND TIME when the fresh task read says the plan now waits, even though the shown read offered it.
it("Continue re-reads the task before sending and sends nothing once the plan waits for approval", async () => {
 const nav = navFixture();
 let waiting = false;
 const tasks = () => TASKS.map(task => task.taskId === ID.plan ? { ...task, workflow: { ...task.workflow, stage: waiting ? "PLAN_REVIEW" : "IMPLEMENT", state: waiting ? "WAITING" : "RUNNING" } } : task);
 const session = sessionFixture({ body: { kind: "task", task: taskFixture() } });
 const f = fakeHost(async request => {
  const url = request.path.split("?")[0]!;
  if (request.method !== "GET") return url.endsWith("/presence") ? { status: 200, body: { viewingNow: [] } } : { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Not connected yet" } } };
  if (url === "/v1/app/me") return { status: 200, body: meFixture() };
  if (url === "/v1/app/nav") return { status: 200, body: nav };
  if (url === "/v1/app/sessions") return { status: 200, body: { tasks: tasks() } };
  if (url === "/v1/app/decisions") return { status: 200, body: decisionsView() };
  if (url === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session } };
  if (url.endsWith("/people")) return { status: 200, body: { people: { revision: 1, orphaned: false, canManage: true, canTakeOwnership: false, people: [{ personId: "22222222-2222-4222-8222-222222222222", name: "Priya", role: "owner", you: true, effectiveRole: "owner" }] }, sharedWith: [] } };
  if (url.endsWith("/candidates")) return { status: 200, body: { candidates: [], complete: true } };
  if (url.endsWith("/documents/plan")) return { status: 200, body: PLAN };
  if (url.endsWith("/evidence")) return { status: 200, body: PROOF };
  if (url.endsWith("/events")) return { status: 200, body: EVENTS };
  if (url.endsWith("/comments")) return { status: 200, body: { comments: [] } };
  if (url.endsWith("/lessons")) return { status: 200, body: { lessons: [] } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const routes = appRoutes(nav.features), leaf = routes.find(route => route.path === "/app")!.children!.find(route => route.path === "sessions/:id")!;
 const router = createMemoryRouter([{ path: "/app/sessions/:id", lazy: leaf.lazy! }], { initialEntries: ["/app/sessions/" + ID.plan] });
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 try {
  fireEvent.keyDown(await screen.findByRole("button", { name: "Task actions" }, { timeout: 15_000 }), { key: "ArrowDown" });
  const entry = await screen.findByRole("menuitem", { name: "Continue in my tool" });
  waiting = true;
  fireEvent.click(entry);
  expect((await screen.findByTestId("continue-message")).textContent).toContain("Approve the plan first.");
  expect(f.request.mock.calls.filter(([r]) => r.method !== "GET" && !r.path.endsWith("/presence"))).toHaveLength(0);
 } finally { ui.unmount();router.dispose();query.clear(); }
});
