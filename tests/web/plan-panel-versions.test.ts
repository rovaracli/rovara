// @vitest-environment jsdom
// UX2C-LATER: the plan panel browses older saved versions of a document (read-only, with that version's own comments, a clear "older version" label and a way back), and the PR feedback view
// retries a review that did not finish with the same retry Slack's button uses.
import { expect, it } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import PlanPanel from "../../packages/ui/src/screens/session/PlanPanel.js";
import FeedbackView from "../../packages/ui/src/screens/session/FeedbackView.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const TASK = "11111111-1111-4111-8111-111111111111", C1 = "22222222-2222-4222-8222-222222222222", C2 = "33333333-3333-4333-8333-333333333333";
/** The chosen option of a select. */
const selected = (select: HTMLElement): string => (select as unknown as { value: string }).value;
const base = "/v1/app/tasks/" + TASK;
const versions = [{ version: 1, current: false, approved: true }, { version: 2, current: true, approved: false }];
const content = (version: number, claim: string) => ({ version, approved: version === 1, format: "structured", title: "Retry v" + String(version), why: [], decisions: [], risks: [], notChanging: [], claims: [{ id: "1", text: claim }] });
const full = { access: { canComment: true, canSuggest: true, canDecide: true, canAsk: true } };
const none = { access: { canComment: false, canSuggest: false, canDecide: false, canAsk: false } };
const comment = (id: string, version: number, text: string) => ({ id, document: "plan", version, target: { kind: "claim", id: "1" }, author: { kind: "person", name: "Sam Lee", owner: false, you: true }, text, edited: false, deleted: false, sent: false, rev: 1 });

function mountPanel() {
 const f = fakeHost(async (request: ApiRequest): Promise<ApiResponse> => {
  if (request.path === base + "/documents/plan") return { status: 200, body: { document: "plan", versions, current: content(2, "Second claim"), checks: [{ id: "unit", label: "Unit tests" }], unverified: false, waiting: true, ...full } };
  if (request.path === base + "/documents/plan?version=1") return { status: 200, body: { document: "plan", versions, current: content(1, "First claim"), older: { currentVersion: 2 }, checks: [], unverified: false, waiting: false, ...none } };
  if (request.path === base + "/comments") return { status: 200, body: { comments: [comment(C1, 1, "Name the file."), comment(C2, 2, "Looks better now.")], suggestions: [], canRemember: true } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found" } } };
 });
 const query = createQueryClient();
 renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(PlanPanel, { taskId: TASK, document: "plan", onClose: () => undefined, footer: h("button", null, "Approve this plan") }) }) }));
 return { ...f, paths: () => f.request.mock.calls.map(([request]) => request.path) };
}

it("browses an older version read-only with its own comments and a way back to the current version", async () => {
 const f = mountPanel();
 const dialog = await screen.findByRole("dialog", { name: "Coding plan v2" });
 await within(dialog).findByText("Second claim");
 await within(dialog).findByText("Looks better now.");
 // The current version: a picker listing both versions, no older label, the card's Approve, and the comments of every version (older ones labelled).
 const picker = within(dialog).getByRole("combobox", { name: "Version" });
 expect(within(picker).getAllByRole("option").map(option => option.textContent)).toEqual(["v2 (current)", "v1, approved"]);
 expect(selected(picker)).toBe("2");
 expect(within(dialog).queryByText(/Older version\./u)).toBeNull();
 expect(within(dialog).getByRole("button", { name: "Approve this plan" })).toBeTruthy();
 expect(within(dialog).getByText("Name the file.")).toBeTruthy();
 expect(within(dialog).getByRole("button", { name: "Comment on point 1" })).toBeTruthy();
 // Pick v1: it is read from the same route with ?version=1.
 fireEvent.change(picker, { target: { value: "1" } });
 await screen.findByRole("dialog", { name: "Coding plan v1 (older)" });
 expect(f.paths()).toContain(base + "/documents/plan?version=1");
 await within(dialog).findByText("First claim");
 expect(within(dialog).getByText(/Older version\./u).parentElement?.textContent).toContain("You're reading v1 read-only. The current version is v2.");
 expect(within(dialog).getByText(/^Version 1 \(older\), approved/u)).toBeTruthy();
 // Only v1's comment shows; nothing can be written, replied to, edited, deleted, suggested or decided; no checks.
 expect(within(dialog).getByText("Name the file.")).toBeTruthy();
 expect(within(dialog).queryByText("Looks better now.")).toBeNull();
 expect(within(dialog).queryByText("Second claim")).toBeNull();
 for (const name of [/^Comment on/u, /^Reply$/u, /^Edit$/u, /^Delete$/u, /Remember/u, /Approve this plan/u]) expect(within(dialog).queryByRole("button", { name }), String(name)).toBeNull();
 expect(within(dialog).queryByText("Unit tests")).toBeNull();
 // Back to the current version.
 fireEvent.click(within(dialog).getByRole("button", { name: "Back to the current version" }));
 await screen.findByRole("dialog", { name: "Coding plan v2" });
 await within(dialog).findByText("Second claim");
 expect(within(dialog).queryByText(/Older version\./u)).toBeNull();
 expect(within(dialog).getByRole("button", { name: "Approve this plan" })).toBeTruthy();
 expect(selected(within(dialog).getByRole("combobox", { name: "Version" }))).toBe("2");
});

it("shows no picker for a document with one version, and says so when an older version cannot be read", async () => {
 const single = fakeHost(async request => request.path === base + "/documents/plan"
  ? { status: 200, body: { document: "plan", versions: [{ version: 1, current: true, approved: false }], current: content(1, "Only claim"), checks: [], unverified: false, waiting: false, ...full } }
  : { status: 200, body: { comments: [], suggestions: [], canRemember: false } });
 renderUi(h(AppHostProvider, { host: single.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(PlanPanel, { taskId: TASK, document: "plan", onClose: () => undefined }) }) }));
 await screen.findByText("Only claim");
 expect(screen.queryByRole("combobox", { name: "Version" })).toBeNull();
});

it("keeps the picker and a way back when an older version cannot be read", async () => {
 const f = fakeHost(async request => {
  if (request.path === base + "/documents/plan") return { status: 200, body: { document: "plan", versions, current: content(2, "Second claim"), checks: [], unverified: false, waiting: false, ...full } };
  if (request.path.endsWith("?version=1")) return { status: 404, body: { error: { code: "NOT_FOUND", message: "That version isn't available." } } };
  return { status: 200, body: { comments: [], suggestions: [], canRemember: false } };
 });
 renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(PlanPanel, { taskId: TASK, document: "plan", onClose: () => undefined, footer: h("button", null, "Approve this plan") }) }) }));
 const dialog = await screen.findByRole("dialog");
 await within(dialog).findByText("Second claim");
 fireEvent.change(within(dialog).getByRole("combobox", { name: "Version" }), { target: { value: "1" } });
 await within(dialog).findByText("That version isn't available.");
 expect(within(dialog).queryByRole("button", { name: "Approve this plan" })).toBeNull();
 fireEvent.change(within(dialog).getByRole("combobox", { name: "Version" }), { target: { value: "2" } });
 await within(dialog).findByText("Second claim");
 expect(within(dialog).getByRole("button", { name: "Approve this plan" })).toBeTruthy();
});

const DIGEST = "b".repeat(64);
const failedReview = { taskId: TASK, title: "Retry failed payments", revision: 9, status: "PENDING", reportStatus: "TIMED_OUT", workflowStatus: "WAITING", workflowStage: "WAIT_FOR_MERGE", reviewDigest: DIGEST, bundleDigests: [],
 candidates: [], findings: [], recommendedFindingIds: [], checks: [], nextAction: "Retry the review from the Slack thread of this task." };
function mountFeedback(review: Record<string, unknown>, retry: () => ApiResponse) {
 const f = fakeHost(async request => request.method === "GET" ? { status: 200, body: { review } } : request.path === base + "/workflow/feedback-retry" ? retry() : { status: 404, body: {} });
 renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(FeedbackView, { taskId: TASK, onClose: () => undefined }) }) }));
 return { ...f, posts: () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST") };
}

it("a review that did not finish has Retry review, which sends the review's digest once and says it started", async () => {
 const f = mountFeedback(failedReview, () => ({ status: 200, body: { started: true } }));
 const dialog = await screen.findByRole("dialog", { name: /PR feedback/u });
 await within(dialog).findByText("The review didn't finish.");
 // The page no longer points to Slack for this.
 expect(dialog.textContent).not.toContain("Slack");
 const button = within(dialog).getByRole("button", { name: "Retry review" });
 fireEvent.click(button);
 await within(dialog).findByText("Reviewing the feedback again. A new proposal shows here when it is ready.");
 expect(f.posts().map(request => [request.path, request.body])).toEqual([[base + "/workflow/feedback-retry", { reviewDigest: DIGEST }]]);
 // Pressed once: no second press from this view.
 await waitFor(() => expect(within(dialog).getByRole("button", { name: "Retry review" }).hasAttribute("disabled")).toBe(true));
 fireEvent.click(within(dialog).getByRole("button", { name: "Retry review" }));
 expect(f.posts()).toHaveLength(1);
});

it("a refused retry shows the server's words and can be pressed again; an already-retried review says so", async () => {
 let answer: ApiResponse = { status: 400, body: { error: { code: "CONFIG_INVALID", message: "AgentX is busy on this task; try Retry review again in a minute." } } };
 const f = mountFeedback(failedReview, () => answer);
 const dialog = await screen.findByRole("dialog", { name: /PR feedback/u });
 fireEvent.click(await within(dialog).findByRole("button", { name: "Retry review" }));
 await within(dialog).findByText("AgentX is busy on this task; try Retry review again in a minute.");
 expect(within(dialog).getByRole("button", { name: "Retry review" }).hasAttribute("disabled")).toBe(false);
 answer = { status: 200, body: { started: false } };
 fireEvent.click(within(dialog).getByRole("button", { name: "Retry review" }));
 await within(dialog).findByText("This review was already retried. A new proposal shows here when it is ready.");
 expect(f.posts()).toHaveLength(2);
});

it("a finished review has no Retry review", async () => {
 mountFeedback({ ...failedReview, reportStatus: "COMPLETE", findings: [{ id: "f1", priority: "SHOULD_FIX", assessment: "ACTIONABLE", rationale: "Trim it.", proposedDisposition: "IMPLEMENT" }], recommendedFindingIds: ["f1"], nextAction: "" }, () => ({ status: 200, body: {} }));
 const dialog = await screen.findByRole("dialog", { name: /PR feedback/u });
 await within(dialog).findByText(/Trim it\./u);
 expect(within(dialog).queryByRole("button", { name: "Retry review" })).toBeNull();
});
