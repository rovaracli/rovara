// @vitest-environment jsdom
// The PR feedback card (CLOUD-HALF "Private app implementation", F1, F2, "F2 and screen evidence"). Every reply is parsed by the production readers;
// Code's feedback bodies are its real complete and failed shapes (tests/web/support/pr-feedback-fixture.ts).
import { createCandidateManifest } from "@agentx/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { createTaskSessionApi, useSession } from "../../packages/ui/src/api/sessions.js";
import { PrFeedbackCard } from "../../packages/ui/src/screens/session/PrFeedbackCard.js";
import { TaskSlotsProvider } from "../../packages/ui/src/screens/session/task-slots.js";
import { FIX_SELECTION_MAX, FeedbackReviewReader, isCompleteReview, feedbackPhase, fixableFinding, prFeedbackPageChip, prFeedbackRail, KEEP_NOTE, decisionRecorded, feedbackBindings, feedbackWorkflowOf, fixBody, keepBody, retryResolved, selectionProblem, feedbackReviewRounds, FEEDBACK_REVIEW_ROUNDS_MAX } from "../../packages/ui/src/api/pr-feedback.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { FIXTURE_CANDIDATE, PRF, approveRecord, completeReview, decisionRecord, failedReview, feedbackSession, ownerMoney, type FeedbackKind, type FeedbackSessionOptions } from "./support/pr-feedback-fixture.js";

afterEach(() => { vi.useRealTimers(); });
const anyString: unknown = expect.any(String), uuid: unknown = expect.stringMatching(/^[0-9a-f-]{36}$/u);
const ME = (id = PRF.owner, org = "o-aaaaaaaaaaaaaaaaaaaa") => ({ status: 200, body: { developer: { id, name: id === PRF.owner ? "Priya" : "Ana", orgRole: "member" }, org: { orgId: org, name: "Example", plan: "starter" }, identities: [] } });
const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const refusal = (status: number, code: string, message: string) => json(status, { error: { code, message } });
type Deferred = { promise: Promise<ApiResponse>; resolve: (value: ApiResponse) => void };
const deferred = (): Deferred => { let resolve!: (value: ApiResponse) => void;return { promise: new Promise<ApiResponse>(done => { resolve = done; }), resolve }; };

interface Setup { kind: FeedbackKind; options?: FeedbackSessionOptions; review?: () => ApiResponse | Promise<ApiResponse>; post?: (request: ApiRequest) => ApiResponse | Promise<ApiResponse>; storage?: Map<string, string>; storageBroken?: boolean; readFailed?: { value: boolean }; me?: () => ApiResponse; sessionRead?: () => ApiResponse | Promise<ApiResponse> | undefined }
function setup(input: Setup) {
 let session: unknown = feedbackSession(input.kind, { money: ownerMoney(), ...input.options }), sessionFailure: ApiResponse | undefined;
 const posts: ApiRequest[] = [], gets: string[] = [];
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0]!;
  if (request.method !== "GET") { posts.push(request);return input.post?.(request) ?? json(500, {}); }
  gets.push(path);
  if (path === "/v1/app/me") return input.me?.() ?? ME();
  if (path === "/v1/app/sessions/" + PRF.sessionId) return input.sessionRead?.() ?? sessionFailure ?? json(200, { session });
  if (path === "/v1/app/sessions/" + PRF.sessionId + "/feedback") return input.review?.() ?? json(200, input.kind === "failed" ? failedReview() : completeReview());
  return refusal(404, "NOT_FOUND", "no");
 });
 if (input.storageBroken === true) f.host.storage = { get: key => key.endsWith(":request") ? "{}" : undefined, set: () => undefined };  // a saved request that does not read back
 if (input.storage !== undefined) { f.host.storage = { get: key => input.storage!.get(key), set: (key, value) => { input.storage!.set(key, value); } }; }
 const Harness = () => {
  const read = useSession(PRF.sessionId);
  if (read.data === undefined) return h("p", { role: "status" }, "Loading the task");
  return h(PrFeedbackCard, { sessionId: PRF.sessionId, session: read.data, readFailed: read.isError || read.failureCount > 0 || input.readFailed?.value === true, onCheck: () => { void read.refetch(); } });
 };
 let query = createQueryClient();
 const mount = () => renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(TaskSlotsProvider, { children: h(Harness) }) }) }));
 let ui = mount();
 return { ...f, posts, gets, query,
  setSession(next: FeedbackKind, options: FeedbackSessionOptions = {}) { session = feedbackSession(next, { money: ownerMoney(), ...options }); },
  failSession(response: ApiResponse | undefined) { sessionFailure = response; },
  async reread() { await act(async () => { await query.invalidateQueries(); }); },
  remount() { ui.unmount();query.clear();query = createQueryClient();ui = mount(); },
 };
}
const button = (name: string | RegExp) => screen.findByRole("button", { name });
const decisionPosts = (posts: ApiRequest[]) => posts.filter(request => request.path.endsWith("/feedback-decision"));
const bodyOf = (request: ApiRequest) => request.body as Record<string, unknown>;

// ---- F1: failed-review Keep, unchanged wire contract ----
it("failed review Keep binds proposalDigest from the matching full task read when feedback omits it", async () => {
 const f = setup({ kind: "failed", post: () => json(200, { session: feedbackSession("kept", { decisions: [decisionRecord()] }) }) });
 expect(FeedbackReviewReader.parse(failedReview()).review).not.toHaveProperty("proposalDigest");
 fireEvent.click(await button("Keep the pull request as it is"));
 await waitFor(() => expect(decisionPosts(f.posts)).toHaveLength(1));
 const body = bodyOf(decisionPosts(f.posts)[0]!);
 expect(Object.keys(body).sort()).toEqual(["bundleDigests", "decision", "expectedRevision", "ownerNote", "proposalDigest", "requestId", "reviewDigest", "selectedFindingIds"]);
 expect(body).toEqual({ requestId: uuid, expectedRevision: PRF.revision, reviewDigest: PRF.review, proposalDigest: PRF.proposal, bundleDigests: [PRF.bundleA], decision: "DISMISS", selectedFindingIds: [], ownerNote: "The owner kept the pull request as it is." });
 // The bindings came from a fresh full task read made at the press, after the card's own reads.
 expect(f.gets.filter(path => path === "/v1/app/sessions/" + PRF.sessionId).length).toBeGreaterThanOrEqual(2);
});

it("failed review Keep succeeds with a missing report blob", async () => {
 // Code's failed read carries no report: no proposal, no findings, no candidates. Keep needs none of them.
 const f = setup({ kind: "failed", review: () => json(200, failedReview({ candidates: [], findings: [], checks: [] })), post: () => json(200, { session: feedbackSession("kept", { decisions: [decisionRecord()] }) }) });
 fireEvent.click(await button("Keep the pull request as it is"));
 await waitFor(() => expect(decisionPosts(f.posts)).toHaveLength(1));
 f.setSession("kept", { decisions: [decisionRecord()] });
 await f.reread();
 expect(await screen.findByText("You kept the pull request as it is")).toBeTruthy();
 expect(decisionPosts(f.posts)).toHaveLength(1);
 expect(f.gets.some(path => path.includes("report") || path.includes("artifact"))).toBe(false);
});

it("failed review Keep records DISMISS and exits to watching without paid work", async () => {
 const f = setup({ kind: "failed", post: () => json(200, { session: feedbackSession("kept", { decisions: [decisionRecord()] }) }) });
 fireEvent.click(await button("Keep the pull request as it is"));
 await waitFor(() => expect(decisionPosts(f.posts)).toHaveLength(1));
 f.setSession("kept", { decisions: [decisionRecord()] });
 await f.reread();
 const kept = await screen.findByTestId("prf-kept");
 expect(kept.textContent).toContain("No fix runs and nothing is spent.");
 expect(kept.textContent).toContain("You can't reopen this choice. New comments start a new review.");
 expect(kept.textContent).toContain("Rovara keeps watching pull request #42.");
 expect(within(kept).queryByRole("button")).toBeNull();
 expect(f.posts.map(request => request.path)).toEqual(["/v1/app/sessions/" + PRF.sessionId + "/feedback-decision"]);
 expect(bodyOf(f.posts[0]!)["decision"]).toBe("DISMISS");
 expect(f.posts.some(request => request.path.endsWith("/feedback-retry") || request.path.endsWith("/retry"))).toBe(false);
});

it("lost failed review Keep response reconciles the original decision through the full task read", async () => {
 const f = setup({ kind: "failed", post: () => json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code didn't answer." } }) });
 fireEvent.click(await button("Keep the pull request as it is"));
 const lost = await screen.findByTestId("prf-no-reply");
 expect(lost.textContent).toContain("Your choice is kept here: keep the pull request as it is.");
 expect(screen.queryByRole("button", { name: "Keep the pull request as it is" })).toBeNull();
 const sent = bodyOf(decisionPosts(f.posts)[0]!);
 // A conflicting record (another request) proves nothing: the lock stays and nothing is sent again.
 f.setSession("failed", { decisions: [decisionRecord({ requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })] });
 fireEvent.click(await button("Check my choice"));
 expect(await screen.findByText(/Rovara hasn't recorded it yet/u)).toBeTruthy();
 expect(screen.getByTestId("prf-no-reply")).toBeTruthy();
 // The original decision, matched field by field, while a later round is already active: proven; the card shows the current state.
 f.setSession("collecting", { decisions: [decisionRecord({ requestId: sent["requestId"] })] });
 fireEvent.click(await button("Check my choice"));
 expect(await screen.findByText(/Reading new comments on pull request #42/u)).toBeTruthy();
 expect(decisionPosts(f.posts)).toHaveLength(1);
});

// ---- F2: retry keeps exactly { reviewDigest } and reads { task, started } ----
it("retry review sends exactly { reviewDigest } and shows the started round Code answered", async () => {
 const f = setup({ kind: "failed", post: () => json(200, { session: feedbackSession("collecting"), started: true }) });
 fireEvent.click(await button("Retry review"));
 await waitFor(() => expect(f.posts).toHaveLength(1));
 expect(f.posts[0]!.path).toBe("/v1/app/sessions/" + PRF.sessionId + "/feedback-retry");
 expect(f.posts[0]!.body).toEqual({ reviewDigest: PRF.review });
 f.setSession("collecting");
 await f.reread();
 expect(await screen.findByTestId("prf-collecting")).toBeTruthy();
});
it("a duplicate retry answering started false shows the served state, not a new round", async () => {
 const f = setup({ kind: "failed", post: () => json(200, { session: feedbackSession("failed"), started: false }) });
 fireEvent.click(await button("Retry review"));
 await waitFor(() => expect(f.posts).toHaveLength(1));
 await f.reread();
 expect(await screen.findByTestId("prf-failed")).toBeTruthy();
 expect(screen.queryByText(/Reading new comments/u)).toBeNull();
});
it("a retry with no answer stays locked until a read shows a new round; Check never resends", async () => {
 const f = setup({ kind: "failed", post: () => json(502, { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code didn't answer." } }) });
 fireEvent.click(await button("Retry review"));
 expect((await screen.findByTestId("prf-no-reply")).textContent).toContain("You pressed Retry review");
 fireEvent.click(await button("Check my choice"));
 expect(await screen.findByText(/Rovara hasn't recorded it yet/u)).toBeTruthy();
 f.setSession("reviewing");
 fireEvent.click(await button("Check my choice"));
 expect(await screen.findByTestId("prf-reviewing")).toBeTruthy();
 expect(f.posts).toHaveLength(1);
});

// ---- Fix: the selection and its exact body ----
it("Fix sends APPROVE with exactly the selected fixable findings and the full task read's bindings", async () => {
 const f = setup({ kind: "pending", post: () => json(200, { session: feedbackSession("fixing", { decisions: [approveRecord()] }) }) });
 const pending = await screen.findByTestId("prf-pending");
 expect(pending.textContent).toContain("2 selected. Fixing is paid work, charged to Priya (you). Keeping costs nothing.");
 expect(pending.textContent).toContain("About $3.60 left");
 expect(pending.textContent).toContain("Not known until it finishes");
 fireEvent.click(await button("Fix selected findings"));
 await waitFor(() => expect(f.posts).toHaveLength(1));
 expect(f.posts[0]!.body).toEqual({ requestId: anyString, expectedRevision: PRF.revision, reviewDigest: PRF.review, proposalDigest: PRF.proposal, bundleDigests: [PRF.bundleA], decision: "APPROVE", selectedFindingIds: ["f1", "f2"] });
});
it("shows the fixing state the server answered after Fix, never an optimistic fixed or pushed claim", async () => {
 const f = setup({ kind: "pending", post: () => json(200, { session: feedbackSession("fixing", { decisions: [approveRecord()] }) }) });
 fireEvent.click(await button("Fix selected findings"));
 await waitFor(() => expect(f.posts).toHaveLength(1));
 f.setSession("fixing", { decisions: [approveRecord()] });
 await f.reread();
 const fixing = await screen.findByTestId("prf-fixing");
 expect(fixing.textContent).toContain("Fixing 2 findings from the pull request comments");
 expect(fixing.textContent).toContain("Nothing is pushed until the checks and reviews pass.");
 expect(document.body.textContent).not.toMatch(/fixed|pushed to/iu);
});
it("an empty selection has no paid-start authority", async () => {
 setup({ kind: "pending" });
 const pending = await screen.findByTestId("prf-pending");
 for (const box of within(pending).getAllByRole("checkbox")) if (box.getAttribute("aria-checked") === "true") fireEvent.click(box);
 expect(pending.textContent).toContain("Select at least one finding to fix.");
 expect(pending.textContent).not.toContain("Locked");
 expect((await button("Fix selected findings")).hasAttribute("disabled")).toBe(true);
 // A finding with nothing to fix (already done) has no box at all.
 expect(within(pending).getAllByRole("checkbox")).toHaveLength(3);
});
it("oversized, duplicate and unfixable selections have no paid-start authority", () => {
 const review = FeedbackReviewReader.parse(completeReview()).review;
 expect(selectionProblem([], review)).toBe("empty");
 expect(selectionProblem(Array.from({ length: FIX_SELECTION_MAX + 1 }, (_, index) => "f" + String(index)), review)).toBe("too_many");
 expect(selectionProblem(["f1", "f1"], review)).toBe("duplicate");
 expect(selectionProblem(["f4"], review)).toBe("not_fixable");
 expect(selectionProblem(["zz"], review)).toBe("not_fixable");
 expect(selectionProblem(["f1", "f3"], review)).toBeUndefined();
 const bindings = feedbackBindings(feedbackWorkflowOf(feedbackSession("pending")), review)!;
 expect(() => fixBody(bindings, "x", [], review)).toThrow();
 expect(() => fixBody(bindings, "x", ["f4"], review)).toThrow();
});
it("a finding Rovara doesn't recommend is open by default with its note", async () => {
 setup({ kind: "pending" });
 const pending = await screen.findByTestId("prf-pending");
 const third = pending.querySelector("[data-finding=f3]")!;
 expect(third.textContent).toContain("Rovara has no recommendation. Tick this only if you want the change below.");
 expect(third.querySelector("details")!.hasAttribute("open")).toBe(true);
 expect(pending.querySelector("[data-finding=f4]")!.textContent).not.toContain("priority");
});

// ---- Bindings and read-back proof, field by field ----
it("binds only when the feedback read and the full task read agree on revision, report, proposal and the exact bundle set", () => {
 const workflow = feedbackWorkflowOf(feedbackSession("pending"));
 const read = (overrides: Record<string, unknown>) => FeedbackReviewReader.parse(completeReview(overrides)).review;
 expect(feedbackBindings(workflow, read({}))).toEqual({ expectedRevision: PRF.revision, reviewDigest: PRF.review, proposalDigest: PRF.proposal, bundleDigests: [PRF.bundleA] });
 expect(feedbackBindings(workflow, read({ revision: PRF.revision - 1 }))).toBeUndefined();
 expect(feedbackBindings(workflow, read({ reviewDigest: PRF.nextReview }))).toBeUndefined();
 expect(feedbackBindings(workflow, read({ proposalDigest: PRF.nextReview }))).toBeUndefined();
 expect(feedbackBindings(workflow, read({ bundleDigests: [PRF.bundleB] }))).toBeUndefined();
 expect(feedbackBindings(workflow, read({ bundleDigests: [PRF.bundleA, PRF.bundleB] }))).toBeUndefined();
 expect(feedbackBindings(workflow, read({ status: "DISMISSED" }))).toBeUndefined();
 // A failed report never binds against a complete read, nor the reverse.
 expect(feedbackBindings(feedbackWorkflowOf(feedbackSession("failed")), read({}))).toBeUndefined();
 expect(feedbackBindings(workflow, FeedbackReviewReader.parse(failedReview()).review)).toBeUndefined();
 expect(feedbackBindings(feedbackWorkflowOf(feedbackSession("kept")), read({}))).toBeUndefined();
});
it("proves an unknown decision only by the full record: request, revision, decision, digests, bundles, selection and note; never by who chose", () => {
 const bindings = feedbackBindings(feedbackWorkflowOf(feedbackSession("failed")), FeedbackReviewReader.parse(failedReview()).review)!;
 const body = keepBody(bindings, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
 const proven = (record: Record<string, unknown>) => decisionRecorded(feedbackWorkflowOf(feedbackSession("collecting", { decisions: [decisionRecord(record)] })), body);
 expect(proven({})).toBe(true);
 // Code stores a per-task SHA-256 owner key as the actor, never a person id: any actor key proves the same request (P1-1).
 expect(proven({ actorId: PRF.coOwnerKey })).toBe(true);
 expect(proven({ actorId: PRF.ownerKey })).toBe(true);
 expect(PRF.ownerKey).not.toBe(PRF.owner);expect(PRF.ownerKey).toMatch(/^[a-f0-9]{64}$/u);
 for (const wrong of [{ requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { workflowRevision: PRF.revision + 1 }, { decision: "APPROVE", selectedFindingIds: ["f1"], selectedCommentIds: ["1101"], ownerNote: undefined, candidates: [{ repositoryId: "payments", number: 42, headSha: "c".repeat(40), candidateDigest: "d".repeat(64), commentSetDigest: "8".repeat(64), bundleDigest: PRF.bundleA }] }, { reviewDigest: PRF.nextReview }, { proposalDigest: PRF.nextReview }, { bundleDigests: [PRF.bundleB] }, { bundleDigests: [PRF.bundleA, PRF.bundleB] }, { ownerNote: "Another note." }]) {
  expect(proven(wrong)).toBe(false);
 }
 expect(decisionRecorded(undefined, body)).toBe(false);
 // A Keep is DISMISS with no selection at all: a record that also carries selected comments (a shape Code's own schema refuses to store, so patched in after parsing) is not the Keep that was sent.
 const withComments = feedbackSession("collecting", { decisions: [decisionRecord()] }) as unknown as { body: { task: { workflow: { feedbackDecisions: Array<Record<string, unknown>> } } } };
 withComments.body.task.workflow.feedbackDecisions[0]!["selectedCommentIds"] = ["1101"];
 expect(decisionRecorded(feedbackWorkflowOf(withComments as never), body)).toBe(false);
 expect(retryResolved(feedbackWorkflowOf(feedbackSession("failed")), PRF.review)).toBe(false);
 expect(retryResolved(feedbackWorkflowOf(feedbackSession("collecting")), PRF.review)).toBe(true);
 expect(retryResolved(undefined, PRF.review)).toBe(false);
 expect(body.ownerNote).toBe(KEEP_NOTE);
});

// ---- Screen evidence ----
it("a failed feedback read removes every control and says nothing was sent", async () => {
 const f = setup({ kind: "pending", review: () => refusal(503, "RUNTIME_UNAVAILABLE", "Rovara Code didn't answer.") });
 expect((await screen.findByTestId("prf-read-failed")).textContent).toContain("Couldn't read the feedback");
 expect(screen.queryByRole("button", { name: /Fix selected|Keep the pull request/u })).toBeNull();
 expect(f.posts).toHaveLength(0);
});
it("a report that fails Code's integrity check is a failed read, never a choice", async () => {
 setup({ kind: "pending", review: () => refusal(502, "RUNTIME_UNAVAILABLE", "the feedback review record failed its integrity check") });
 expect(await screen.findByTestId("prf-read-failed")).toBeTruthy();
 expect(screen.queryByRole("checkbox")).toBeNull();
});
it("a stale feedback read (another revision) offers no choice until the reads match", async () => {
 setup({ kind: "pending", review: () => json(200, completeReview({ revision: PRF.revision - 1 })) });
 expect((await screen.findByTestId("prf-read-failed")).textContent).toContain("The feedback changed");
 expect(screen.queryByRole("button", { name: "Fix selected findings" })).toBeNull();
});
it("a later read failure revokes the authority an earlier read gave", async () => {
 let fail = false;
 const f = setup({ kind: "pending", review: () => fail ? refusal(503, "RUNTIME_UNAVAILABLE", "down") : json(200, completeReview()) });
 await button("Fix selected findings");
 fail = true;
 await f.reread();
 expect(await screen.findByTestId("prf-read-failed")).toBeTruthy();
 expect(screen.queryByRole("button", { name: "Fix selected findings" })).toBeNull();
});
it("revocation while the card is open stops the press: the fresh read at send says no, and nothing is sent", async () => {
 const f = setup({ kind: "pending" });
 const fix = await button("Fix selected findings");
 f.setSession("pending", { you: { owner: false, level: "view" } });
 fireEvent.click(fix);
 expect(await screen.findByText(/The feedback or your permissions changed/u)).toBeTruthy();
 expect(f.posts).toHaveLength(0);
});
it("a double click sends once", async () => {
 const hold = deferred();
 const f = setup({ kind: "pending", post: () => hold.promise });
 const fix = await button("Fix selected findings");
 fireEvent.click(fix);fireEvent.click(fix);
 await waitFor(() => expect(f.posts).toHaveLength(1));
 fireEvent.click(fix);
 hold.resolve(json(200, { session: feedbackSession("fixing") }));
 await waitFor(() => expect(f.posts).toHaveLength(1));
});
it("a 503 stays locked through a remount and a reload with the same browser storage, and never sends a new request id", async () => {
 const storage = new Map<string, string>();
 const f = setup({ kind: "pending", storage, post: () => refusal(503, "RUNTIME_UNAVAILABLE", "Rovara Code didn't answer.") });
 fireEvent.click(await button("Fix selected findings"));
 await screen.findByTestId("prf-no-reply");
 f.remount();
 expect(await screen.findByTestId("prf-no-reply")).toBeTruthy();
 expect(screen.queryByRole("button", { name: "Fix selected findings" })).toBeNull();
 // A reload: a new host on the same storage.
 const g = setup({ kind: "pending", storage });
 expect((await screen.findAllByTestId("prf-no-reply")).length).toBeGreaterThan(0);
 expect(f.posts).toHaveLength(1);expect(g.posts).toHaveLength(0);
});
it("an older feedback read that answers after the press can never settle as current", async () => {
 let slow: Deferred | undefined;
 const f = setup({ kind: "pending", review: () => slow?.promise ?? json(200, completeReview()), post: () => refusal(503, "RUNTIME_UNAVAILABLE", "down") });
 const keep = await button("Keep the pull request as it is");
 const old = slow = deferred();
 void f.query.refetchQueries({ queryKey: ["session", PRF.sessionId, "pr-feedback"] });
 await waitFor(() => expect(f.gets.filter(path => path.endsWith("/feedback"))).toHaveLength(2));
 slow = undefined;
 fireEvent.click(keep);
 await waitFor(() => expect(f.posts).toHaveLength(1));
 await screen.findByTestId("prf-no-reply");
 // The read issued before the press answers now, with the waiting review: the shared fence refuses it.
 old.resolve(json(200, completeReview()));
 await waitFor(() => expect(f.query.getQueryCache().findAll({ queryKey: ["session", PRF.sessionId, "pr-feedback"] }).some(entry => (entry.state.error as { code?: string } | null)?.code === "READ_SUPERSEDED")).toBe(true));
 expect(screen.queryByRole("button", { name: /Fix selected findings|Keep the pull request/u })).toBeNull();
 expect(f.posts).toHaveLength(1);
});
it("with browser storage unavailable nothing is sent", async () => {
 const f = setup({ kind: "pending" });
 await button("Fix selected findings");
 f.host.storage = { get: () => undefined, set: () => { throw new Error("blocked"); } };
 fireEvent.click(await button("Fix selected findings"));
 await waitFor(() => expect(screen.queryByText(/can't be made safely in this browser|Check this task before changing it|can't safely claim/u)).not.toBeNull());
 expect(f.posts).toHaveLength(0);
});
it("an identity or company switch hides another person's lock, and keeps it for its owner", async () => {
 const storage = new Map<string, string>();
 let me = ME();
 const f = setup({ kind: "pending", storage, me: () => me, post: () => refusal(503, "RUNTIME_UNAVAILABLE", "down") });
 fireEvent.click(await button("Fix selected findings"));
 await screen.findByTestId("prf-no-reply");
 f.remount();
 me = ME(PRF.owner, "o-bbbbbbbbbbbbbbbbbbbb");
 const other = setup({ kind: "pending", storage, me: () => me });
 await waitFor(() => expect(screen.getAllByTestId(/^prf-/u).some(node => node.getAttribute("data-testid") === "prf-pending")).toBe(true));
 expect(other.posts).toHaveLength(0);
 me = ME();
 setup({ kind: "pending", storage, me: () => me });
 await waitFor(() => expect(screen.getAllByTestId("prf-no-reply").length).toBeGreaterThan(0));
});
it("a stale CSRF answer is not a refusal: nothing was sent, identity is read again, and the choice stays available", async () => {
 const f = setup({ kind: "pending", post: () => refusal(403, "CSRF_INVALID", "Your session token is stale.") });
 fireEvent.click(await button("Fix selected findings"));
 expect(await screen.findByText("Couldn't change that. Nothing was sent. Rovara is reading the page again.")).toBeTruthy();
 expect(screen.queryByText(/only the task owner/iu)).toBeNull();
 expect(screen.queryByTestId("prf-no-reply")).toBeNull();
 expect(f.posts).toHaveLength(1);
});
it("a refused body is a definitive answer: the lock is released and the server's words are shown", async () => {
 const f = setup({ kind: "pending", post: () => refusal(402, "BUDGET_EXCEEDED", "The task limit is reached.") });
 fireEvent.click(await button("Fix selected findings"));
 const refused = await screen.findByTestId("prf-fix-refused");
 expect(refused.textContent).toContain("Reason: The task limit is reached.");
 expect(refused.textContent).toContain("Nothing was spent on this fix and nothing changed.");
 expect(within(refused).queryByRole("button")).toBeNull();
 expect(f.posts).toHaveLength(1);
});
it("Cloud's own invalid-body refusal releases the press without a lock", async () => {
 setup({ kind: "failed", post: () => refusal(400, "CONFIG_INVALID", "Send the choice exactly as the feedback card made it.") });
 fireEvent.click(await button("Keep the pull request as it is"));
 expect(await screen.findByText("Send the choice exactly as the feedback card made it.")).toBeTruthy();
 expect(screen.queryByTestId("prf-no-reply")).toBeNull();
});
it("feedback that changed since the card starts the out-of-date state; the earlier ticks were not sent", async () => {
 const f = setup({ kind: "pending", post: () => refusal(400, "CONFIG_INVALID", "The feedback changed since this card; a new review is starting.") });
 fireEvent.click(await button("Fix selected findings"));
 f.setSession("reviewing");
 expect((await screen.findByTestId("prf-changed")).textContent).toContain("Your earlier ticks were not sent.");
});

// ---- Who may choose, and who pays ----
it("a co-owner may choose; the card names the task's payer (Code's served money), not the person pressing", async () => {
 const f = setup({ kind: "pending", options: { you: { owner: false, coOwner: true, level: "view" } }, me: () => ME(PRF.coOwner) });
 const pending = await screen.findByTestId("prf-pending");
 expect(pending.textContent).toContain("charged to Priya.");
 expect(pending.textContent).not.toContain("(you)");
 fireEvent.click(await button("Fix selected findings"));
 await waitFor(() => expect(f.posts).toHaveLength(1));
});
// Controller ruling 2026-11-23: money comes ONLY from the money Code served on the task read. Where it was not served there is no strip and no payer: never Cloud's own cost.payer.
it("a co-owner sees the same money strip as the owner when the money was served, and only 'Cost details aren't available here.' when it was not", async () => {
 const coOwner = { you: { owner: false, coOwner: true, level: "view" } };
 setup({ kind: "pending" });
 const ownerStrip = (await screen.findByTestId("prf-pending")).querySelector(".rv-prf-money")!.textContent.replace(" (you)", "");
 cleanup();
 setup({ kind: "pending", options: coOwner, me: () => ME(PRF.coOwner) });
 expect((await screen.findByTestId("prf-pending")).querySelector(".rv-prf-money")!.textContent).toBe(ownerStrip);  // the payer is Priya for both; only the "(you)" mark differs
 cleanup();
 setup({ kind: "pending", options: { ...coOwner, money: undefined }, me: () => ME(PRF.coOwner) });
 const unserved = await screen.findByTestId("prf-pending");
 expect(unserved.querySelector(".rv-prf-money")).toBeNull();
 expect(unserved.textContent).toContain("Cost details aren't available here.");
});
it("never names a payer from Cloud's own cost.payer: without served money the paid buttons say the task's payer, not the person Cloud guessed", async () => {
 // The fixture's session carries Cloud's legacy cost.payer { member, Priya }; Code served no money.
 for (const kind of ["pending", "failed", "fix_stopped"] as const) {
  setup({ kind, options: { money: undefined, you: { owner: false, coOwner: true, level: "view" } }, me: () => ME(PRF.coOwner) });
  const card = await screen.findByTestId(kind === "pending" ? "prf-pending" : kind === "failed" ? "prf-failed" : "prf-fix-stopped");
  expect(card.textContent).toContain("charged to the task's payer");
  expect(card.textContent).not.toContain("Priya");
  cleanup();
 }
});
it("someone who can't choose is shown no money strip, even when the money was served", async () => {
 const viewer = { you: { owner: false, level: "view" } };
 for (const [kind, id] of [["pending", "prf-viewer"], ["failed", "prf-viewer"], ["reviewing", "prf-reviewing"], ["fixing", "prf-fixing"], ["fix_finished", "prf-fix-finished"], ["fix_stopped", "prf-fix-stopped"]] as const) {
  setup({ kind, options: viewer });
  const card = await screen.findByTestId(id);
  expect(card.querySelector(".rv-prf-money")).toBeNull();
  expect(card.textContent).not.toContain("Cost details aren't available here.");
  expect(card.textContent).not.toMatch(/Spent on this task|Task limit/u);
  cleanup();
 }
 // The owner, same card, same served money: the strip is there.
 setup({ kind: "reviewing" });
 expect((await screen.findByTestId("prf-reviewing")).querySelector(".rv-prf-money")).not.toBeNull();
});
it("an owner with no served money sees one plain line instead of a strip", async () => {
 setup({ kind: "reviewing", options: { money: undefined } });
 const reviewing = await screen.findByTestId("prf-reviewing");
 expect(reviewing.querySelector(".rv-prf-money")).toBeNull();
 expect(reviewing.textContent).toContain("Cost details aren't available here.");
});
it("someone who is neither the owner nor a co-owner sees who decides and has no controls; the feedback read is not asked", async () => {
 const f = setup({ kind: "pending", options: { you: { owner: false, level: "view" } } });
 const viewer = await screen.findByTestId("prf-viewer");
 expect(viewer.textContent).toContain("Only the task owner can choose. Waiting for Priya.");
 expect(viewer.querySelector(".rv-prf-money")).toBeNull();
 expect(within(viewer).queryByRole("button")).toBeNull();
 expect(f.gets.some(path => path.endsWith("/feedback"))).toBe(false);
});
it("a stopped fix offers Retry fix with the revision it was pressed at, through the existing retry route", async () => {
 const f = setup({ kind: "fix_stopped", options: { decisions: [approveRecord()] }, post: () => json(200, { session: feedbackSession("fixing") }) });
 const stopped = await screen.findByTestId("prf-fix-stopped");
 expect(stopped.textContent).toContain("Reason: You stopped it.");
 fireEvent.click(await button("Retry fix"));
 await waitFor(() => expect(f.posts).toHaveLength(1));
 expect(f.posts[0]!.path).toBe("/v1/app/sessions/" + PRF.sessionId + "/retry");
 expect(f.posts[0]!.body).toEqual({ requestId: anyString, expectedRevision: PRF.revision });
});
it("a fix stopped at the task limit keeps Retry fix off and says why", async () => {
 setup({ kind: "fix_stopped", options: { money: ownerMoney(6_000_000), blockReason: "The task limit was reached." } });
 const stopped = await screen.findByTestId("prf-fix-stopped");
 expect(stopped.textContent).toContain("The task limit is reached, so Retry fix can't start.");
 expect((await button("Retry fix")).hasAttribute("disabled")).toBe(true);
});
it("shows the collecting, reviewing, finished and kept states from the full task read alone", async () => {
 for (const [kind, id] of [["collecting", "prf-collecting"], ["reviewing", "prf-reviewing"], ["fix_finished", "prf-fix-finished"], ["kept", "prf-kept"]] as const) {
  const f = setup({ kind });
  expect(await screen.findByTestId(id)).toBeTruthy();
  expect(f.gets.some(path => path.endsWith("/feedback"))).toBe(false);
  document.body.innerHTML = "";
 }
});
it("the fixture's candidate is the real manifest Code computes", () => {
 expect(FIXTURE_CANDIDATE).toEqual(createCandidateManifest([{ repositoryId: "payments", commitSha: "c".repeat(40), treeSha: "d".repeat(40), baseCommitSha: "e".repeat(40) }]));
});
it("the page chip and the rail line follow the same read: running work, a stop, the limit, a refusal, the merge wait and the owner's turn", () => {
 const read = (kind: FeedbackKind, options: FeedbackSessionOptions = {}) => feedbackSession(kind, { money: ownerMoney(), ...options });
 expect(prFeedbackPageChip(read("collecting"))).toBe("running");
 expect(prFeedbackPageChip(read("reviewing"))).toBe("running");
 expect(prFeedbackPageChip(read("fixing"))).toBe("running");
 expect(prFeedbackPageChip(read("fix_stopped"))).toBe("stopped");
 expect(prFeedbackPageChip(read("fix_stopped", { money: ownerMoney(6_000_000) }))).toBe("blocked");
 expect(prFeedbackPageChip(read("pending"), true)).toBe("blocked");
 expect(prFeedbackPageChip(read("kept"))).toBe("waiting_for_merge");
 expect(prFeedbackPageChip(read("fix_finished"))).toBe("waiting_for_merge");
 expect(prFeedbackPageChip(read("pending"))).toBeUndefined();
 expect(prFeedbackPageChip(read("pending", { you: { owner: false, level: "view" } }))).toBe("waiting_for_owner");
 expect(prFeedbackPageChip(read("pending", { you: { owner: false, coOwner: true, level: "view" } }))).toBeUndefined();
 expect(prFeedbackRail(read("pending"), false, true)?.detail).toBe("The fix didn't start");
 expect(prFeedbackRail(read("pending"), true)?.detail).toBe("Your choice is not confirmed");
 expect(prFeedbackRail(read("fix_stopped", { money: ownerMoney(6_000_000) }))?.detail).toBe("The fix stopped at the task limit");
 expect(prFeedbackRail(read("pending"))?.detail).toBe("Choose which comments to fix");
});
it("the reviewing card counts the collected comments Code recorded", async () => {
 setup({ kind: "reviewing" });
 expect((await screen.findByTestId("prf-reviewing")).textContent).toContain("Reviewing 2 comments on pull request #42");
});

// ---- Mutation-proof additions (MUTANTS.md): the pure rules, field by field, and the guards behind the render guards ----
const withFindings = (findings: unknown[]) => {
 const review = FeedbackReviewReader.parse(completeReview({ findings: [...(completeReview().review.findings as unknown[]), ...findings] })).review;
 if (!isCompleteReview(review)) throw new Error("a complete review was expected");
 return review;
};
const extra = (id: string, assessment: string, fileChanges: unknown[]) => ({ ...(completeReview().review.findings[0] as object), id, assessment, fixProposal: { summary: "Do " + id, fileChanges, tests: [] } });
const oneChange = [{ repositoryId: "payments", path: "src/a.py", operation: "MODIFY", change: "Change it." }];
it("a mixed selection of a fixable and an unfixable finding is not fixable", () => {
 const review = FeedbackReviewReader.parse(completeReview()).review;
 expect(selectionProblem(["f1", "f4"], review)).toBe("not_fixable");
 expect(selectionProblem(["f4", "f1"], review)).toBe("not_fixable");
 expect(selectionProblem(["f1", "f2", "f3"], review)).toBeUndefined();
 expect(selectionProblem(["f1"], undefined)).toBe("not_fixable");
});
it("a finding is fixable only with a proposal that changes a file and is not already addressed: no box, and no selection", async () => {
 const noChange = extra("f5", "ACTIONABLE", []), done = extra("f6", "ALREADY_ADDRESSED", oneChange), real = extra("f7", "ACTIONABLE", oneChange);
 const review = withFindings([noChange, done, real]);
 expect(fixableFinding(review.findings.find(finding => finding.id === "f5")!)).toBe(false);
 expect(fixableFinding(review.findings.find(finding => finding.id === "f6")!)).toBe(false);
 expect(fixableFinding(review.findings.find(finding => finding.id === "f7")!)).toBe(true);
 expect(selectionProblem(["f5"], review)).toBe("not_fixable");
 expect(selectionProblem(["f6"], review)).toBe("not_fixable");
 expect(selectionProblem(["f1", "f7"], review)).toBeUndefined();
 setup({ kind: "pending", review: () => json(200, { review: review }) });
 const pending = await screen.findByTestId("prf-pending");
 for (const id of ["f5", "f6"]) expect(pending.querySelector(`[data-finding=${id}] [role=checkbox]`)).toBeNull();
 for (const id of ["f1", "f7"]) expect(pending.querySelector(`[data-finding=${id}] [role=checkbox]`)).not.toBeNull();
});
it("a decision record that differs from the sent one in only the decision, or only the selection, proves nothing", () => {
 const review = FeedbackReviewReader.parse(completeReview()).review, id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
 const workflowOf = (record: Record<string, unknown>) => feedbackWorkflowOf(feedbackSession("collecting", { decisions: [record] }));
 const bindings = feedbackBindings(feedbackWorkflowOf(feedbackSession("pending")), review)!;
 const keep = keepBody(bindings, id), fix = fixBody(bindings, id, ["f1"], review);
 // Keep: the same note and empty selection, but another decision.
 expect(decisionRecorded(workflowOf(decisionRecord()), keep)).toBe(true);
 expect(decisionRecorded(workflowOf(decisionRecord({ decision: "REQUEST_CHANGES" })), keep)).toBe(false);
 // Fix: the same everything, but another selection (and then another decision).
 expect(decisionRecorded(workflowOf(approveRecord({ selectedFindingIds: ["f1"] })), fix)).toBe(true);
 expect(decisionRecorded(workflowOf(approveRecord({ selectedFindingIds: ["f2"] })), fix)).toBe(false);
 expect(decisionRecorded(workflowOf(approveRecord({ selectedFindingIds: ["f1", "f2"] })), fix)).toBe(false);
 // A Fix has no owner note: a record that carries one is not the Fix that was sent.
 expect(decisionRecorded(workflowOf(approveRecord({ selectedFindingIds: ["f1"], ownerNote: "Extra." })), fix)).toBe(false);
});
it("every report status that is not COMPLETE is the failed state", () => {
 for (const status of ["FAILED", "BLOCKED", "INTERRUPTED", "UNKNOWN"] as const) {
  const read = feedbackSession("failed", { ref: { status } });
  expect(feedbackPhase(feedbackWorkflowOf(read))).toBe("failed");
  expect(prFeedbackRail(read)?.detail).toBe("The comment review didn't finish");
 }
 expect(feedbackPhase(feedbackWorkflowOf(feedbackSession("pending")))).toBe("pending");
});
// The render guards below are what make the authority terms in `authority` unreachable from a button (MUTANTS.md argues each equivalence from these).
it("a failed session read, a failed feedback read, a mismatched read and a held lock each leave no enabled control, and nothing is sent", async () => {
 const failed = { value: false }, f = setup({ kind: "pending", readFailed: failed });
 await button("Fix selected findings");
 // The latest full task read failed while the data on screen is still the last good one (the app's `readFailed`).
 failed.value = true;
 await f.reread();
 expect(await screen.findByTestId("prf-read-failed")).toBeTruthy();
 expect(screen.queryByRole("button", { name: /Fix selected findings|Keep the pull request/u })).toBeNull();
 expect(f.posts).toHaveLength(0);
});
it("a lock that cannot be read in this browser leaves Fix and Keep disabled, and a press sends nothing", async () => {
 const f = setup({ kind: "pending", storageBroken: true });
 const fix = await button("Fix selected findings"), keepButton = await button("Keep the pull request as it is");
 expect(fix.hasAttribute("disabled")).toBe(true);expect(keepButton.hasAttribute("disabled")).toBe(true);
 fireEvent.click(fix);fireEvent.click(keepButton);
 expect(f.posts).toHaveLength(0);
});
it("the same press twice in one moment makes one send and one set of fresh reads", async () => {
 const hold = deferred();
 const f = setup({ kind: "pending", post: () => hold.promise });
 const fix = await button("Fix selected findings");
 const before = f.gets.filter(path => path.endsWith("/feedback")).length;
 await act(async () => { fix.click();fix.click(); });
 await waitFor(() => expect(f.posts).toHaveLength(1));
 expect(f.gets.filter(path => path.endsWith("/feedback")).length - before).toBe(1);
 hold.resolve(json(200, { session: feedbackSession("fixing") }));
});
it("a new round with another report and the same revision, proposal and bundles is still out of date at the press", async () => {
 let review: ApiResponse = json(200, completeReview());
 const f = setup({ kind: "pending", review: () => review });
 const fix = await button("Fix selected findings");
 f.setSession("pending", { ref: { sha256: PRF.nextReview } });
 review = json(200, completeReview({ reviewDigest: PRF.nextReview }));
 fireEvent.click(fix);
 expect(await screen.findByText(/The feedback or your permissions changed/u)).toBeTruthy();
 expect(f.posts).toHaveLength(0);
});
it("a workflow that moved on to a later revision with the same report is out of date at the press", async () => {
 let review: ApiResponse = json(200, completeReview());
 const f = setup({ kind: "pending", review: () => review });
 const fix = await button("Fix selected findings");
 f.setSession("pending", { revision: PRF.revision + 1 });
 review = json(200, completeReview({ revision: PRF.revision + 1 }));
 fireEvent.click(fix);
 expect(await screen.findByText(/The feedback or your permissions changed/u)).toBeTruthy();
 expect(f.posts).toHaveLength(0);
});
it("a selected finding that the fresh read at the press no longer offers a fix for is not sent", async () => {
 let review: ApiResponse = json(200, completeReview());
 const f = setup({ kind: "pending", review: () => review });
 const fix = await button("Fix selected findings");
 const changed = completeReview();
 changed.review.findings = changed.review.findings.map(finding => { if (finding.id !== "f2") return finding;const copy: Record<string, unknown> = { ...finding };delete copy["fixProposal"];return copy as typeof finding; });
 review = json(200, changed);
 fireEvent.click(fix);
 expect(await screen.findByText(/The feedback or your permissions changed/u)).toBeTruthy();
 expect(f.posts).toHaveLength(0);
});
// ---- Retry fix and Retry review: the controls and the fresh check at the press ----
it("Retry fix is disabled for a failed task read, an unreadable lock, and someone who is neither owner nor co-owner; nothing is sent", async () => {
 const failed = { value: false }, f = setup({ kind: "fix_stopped", readFailed: failed });
 expect((await button("Retry fix")).hasAttribute("disabled")).toBe(false);
 failed.value = true;
 await f.reread();
 await waitFor(() => expect(screen.getByRole("button", { name: "Retry fix" }).hasAttribute("disabled")).toBe(true));
 fireEvent.click(screen.getByRole("button", { name: "Retry fix" }));
 expect(f.posts).toHaveLength(0);
 cleanup();
 const locked = setup({ kind: "fix_stopped", storageBroken: true });
 const retry = await button("Retry fix");
 expect(retry.hasAttribute("disabled")).toBe(true);
 fireEvent.click(retry);
 expect(locked.posts).toHaveLength(0);
 cleanup();
 const viewer = setup({ kind: "fix_stopped", options: { you: { owner: false, level: "view" } } });
 const stoppedViewer = await screen.findByTestId("prf-fix-stopped");
 expect(within(stoppedViewer).getByRole("button", { name: "Retry fix" }).hasAttribute("disabled")).toBe(true);
 fireEvent.click(within(stoppedViewer).getByRole("button", { name: "Retry fix" }));
 expect(viewer.posts).toHaveLength(0);
});
it("Retry fix is not sent when the fresh read at the press shows the fix running again, or a later revision", async () => {
 for (const moved of [{ kind: "fixing" as const, options: {} }, { kind: "fix_stopped" as const, options: { revision: PRF.revision + 1 } }]) {
  const f = setup({ kind: "fix_stopped" });
  const retry = await button("Retry fix");
  f.setSession(moved.kind, moved.options);
  fireEvent.click(retry);
  expect(await screen.findByText(/The feedback or your permissions changed/u)).toBeTruthy();
  expect(f.posts).toHaveLength(0);
  cleanup();
 }
});
it("Retry review is not sent when the fresh read at the press shows a finished review", async () => {
 let review: ApiResponse = json(200, failedReview());
 const f = setup({ kind: "failed", review: () => review });
 const retry = await button("Retry review");
 f.setSession("pending");
 review = json(200, completeReview());
 fireEvent.click(retry);
 expect(await screen.findByText(/The feedback or your permissions changed/u)).toBeTruthy();
 expect(f.posts).toHaveLength(0);
});


// ---- Controller rulings 2026-11-23 (Opus FAIL 4b6e6c5bf) ----
// P1: Check reconciles by the request id and the bindings, never by who acted: Code's actorId is a per-task SHA-256 owner key, not the person's id.
it("a lost Fix reconciles by the request id and bindings when Code's actor is its own SHA-256 key, as the owner and as a co-owner", async () => {
 for (const [who, key, me] of [["owner", PRF.ownerKey, () => ME()], ["co-owner", PRF.coOwnerKey, () => ME(PRF.coOwner)]] as const) {
  const you = who === "owner" ? {} : { owner: false, coOwner: true, level: "view" };
  const f = setup({ kind: "pending", options: { you }, me, post: () => json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code didn't answer." } }) });
  fireEvent.click(await button("Fix selected findings"));
  await screen.findByTestId("prf-no-reply");
  const sent = bodyOf(decisionPosts(f.posts)[0]!);
  expect(key).not.toBe(who === "owner" ? PRF.owner : PRF.coOwner);
  // Another request's record proves nothing; a record of the sent selection at another revision proves nothing.
  f.setSession("fixing", { you, decisions: [approveRecord({ actorId: key, requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })] });
  fireEvent.click(await button("Check my choice"));
  expect(await screen.findByText(/Rovara hasn't recorded it yet/u)).toBeTruthy();
  f.setSession("fixing", { you, decisions: [approveRecord({ actorId: key, requestId: sent["requestId"], workflowRevision: PRF.revision + 1 })] });
  fireEvent.click(await button("Check my choice"));
  await waitFor(() => expect(screen.getByTestId("prf-no-reply")).toBeTruthy());
  f.setSession("fixing", { you, decisions: [approveRecord({ actorId: key, requestId: sent["requestId"] })] });
  fireEvent.click(await button("Check my choice"));
  const fixing = await screen.findByTestId("prf-fixing");
  expect(fixing.textContent).toContain("Chosen by the owner or a co-owner");
  expect(decisionPosts(f.posts)).toHaveLength(1);
  cleanup();
 }
});
it("who chose is never guessed: the card says 'Chosen by the owner or a co-owner', not You or a name", async () => {
 for (const you of [{}, { owner: false, coOwner: true, level: "view" }, { owner: false, level: "view" }]) {
  for (const [kind, id] of [["fixing", "prf-fixing"], ["fix_stopped", "prf-fix-stopped"], ["fix_finished", "prf-fix-finished"]] as const) {
   setup({ kind, options: { you, decisions: [approveRecord()] } });
   const card = await screen.findByTestId(id);
   expect(card.textContent).toContain("Chosen by the owner or a co-owner at ");
   expect(card.textContent).not.toMatch(/You chose this|A co-owner chose this/u);
   cleanup();
  }
 }
});

// P2 (DEC 254zzz285): three unknown Checks or ten minutes, then "We couldn't confirm this. Open the task to check"; Check stays, nothing is ever resent.
const sessionReads = (f: { gets: string[] }) => f.gets.filter(path => path === "/v1/app/sessions/" + PRF.sessionId).length;
async function checkOnce(f: { gets: string[] }) {
 const before = sessionReads(f);
 fireEvent.click(await button("Check my choice"));
 await waitFor(() => expect(sessionReads(f)).toBeGreaterThan(before));
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
}
it("after three Checks that prove nothing the card links to the task; Check stays and nothing is ever resent", async () => {
 const f = setup({ kind: "pending", post: () => json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code didn't answer." } }) });
 fireEvent.click(await button("Fix selected findings"));
 await screen.findByTestId("prf-no-reply");
 expect(screen.queryByText(/We couldn't confirm this/u)).toBeNull();
 await checkOnce(f);await checkOnce(f);
 expect(screen.queryByText(/We couldn't confirm this/u)).toBeNull();
 await checkOnce(f);
 const exit = await screen.findByText(/We couldn't confirm this\./u);
 expect(exit.textContent).toContain("Open the task to check");
 expect(within(exit).getByRole("link", { name: "Open the task to check" }).getAttribute("href")).toBe("/s/" + PRF.sessionId);
 expect(screen.getByRole("button", { name: "Check my choice" })).toBeTruthy();
 expect(screen.queryByRole("button", { name: /Fix selected findings|Keep the pull request|Retry/u })).toBeNull();
 await checkOnce(f);
 expect(decisionPosts(f.posts)).toHaveLength(1);expect(f.posts).toHaveLength(1);
});
it("Checks that could not read the task count toward the same exit, and still resend nothing", async () => {
 const f = setup({ kind: "pending", post: () => json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code didn't answer." } }) });
 fireEvent.click(await button("Fix selected findings"));
 await screen.findByTestId("prf-no-reply");
 f.failSession(refusal(503, "RUNTIME_UNAVAILABLE", "down"));
 await checkOnce(f);await checkOnce(f);
 expect(screen.queryByText(/We couldn't confirm this/u)).toBeNull();
 await checkOnce(f);
 expect((await screen.findByText(/We couldn't confirm this\./u)).textContent).toContain("Open the task to check");
 expect(screen.getByText(/Couldn't read the task just now/u)).toBeTruthy();
 expect(f.posts).toHaveLength(1);
});
it("ten minutes after the press the card links to the task even after a single Check", async () => {
 vi.useFakeTimers({ toFake: ["Date"] });
 const start = Date.now();
 const f = setup({ kind: "failed", post: () => json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code didn't answer." } }) });
 fireEvent.click(await button("Retry review"));
 await screen.findByTestId("prf-no-reply");
 vi.setSystemTime(start + 9 * 60_000);
 await checkOnce(f);
 expect(screen.queryByText(/We couldn't confirm this/u)).toBeNull();
 vi.setSystemTime(start + 10 * 60_000 + 1_000);
 await checkOnce(f);
 expect((await screen.findByText(/We couldn't confirm this\./u)).textContent).toContain("Open the task to check");
 expect(f.posts).toHaveLength(1);
});
it("a Check that proves the choice recorded settles the card and shows no exit", async () => {
 const f = setup({ kind: "pending", post: () => json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code didn't answer." } }) });
 fireEvent.click(await button("Fix selected findings"));
 await screen.findByTestId("prf-no-reply");
 const sent = bodyOf(decisionPosts(f.posts)[0]!);
 await checkOnce(f);await checkOnce(f);
 f.setSession("fixing", { decisions: [approveRecord({ requestId: sent["requestId"] })] });
 fireEvent.click(await button("Check my choice"));
 expect(await screen.findByTestId("prf-fixing")).toBeTruthy();
 expect(screen.queryByText(/We couldn't confirm this/u)).toBeNull();
});

// P3-a: the fresh read at the press must be the latest accepted one for this task (isCurrentSessionRead), not only the right identity.
it("a fresh read that a newer failed read superseded (the shared read fence) sends nothing and says the feedback changed", async () => {
 const hold = deferred();
 let slow = false;
 const f = setup({ kind: "pending", sessionRead: () => slow ? hold.promise : undefined });
 const fix = await button("Fix selected findings");
 slow = true;
 fireEvent.click(fix);
 await waitFor(() => expect(sessionReads(f)).toBeGreaterThanOrEqual(2));
 slow = false;
 // A newer direct read fails while the press's read is still in flight; the press's (older) answer must not count as the current read.
 f.failSession(refusal(503, "RUNTIME_UNAVAILABLE", "down"));
 await expect(createTaskSessionApi(f.host).read(PRF.sessionId)).rejects.toBeTruthy();
 hold.resolve(json(200, { session: feedbackSession("pending", { money: ownerMoney() }) }));
 expect(await screen.findByText(/The feedback or your permissions changed/u)).toBeTruthy();
 expect(f.posts).toHaveLength(0);
});

// STATE (l), DEC 254zzz398 (1): the review limit. Rounds = distinct bundle-digest sets across feedbackReviewHistory and the current feedbackReview.
const OTHER_BUNDLES = [[PRF.bundleB], ["e".repeat(64)], ["f".repeat(64)]];
const LIMIT_WORDS = "Rovara has reviewed this pull request's comments 3 times, the limit for a task. New comments won't start another review. Choose Retry review to run it again (paid), or Keep the pull request as it is.";
it("counts review rounds as distinct bundle sets across the history and the current review", () => {
 const rounds = (history?: string[][]) => feedbackReviewRounds(feedbackWorkflowOf(feedbackSession("failed", history === undefined ? {} : { history })));
 expect(FEEDBACK_REVIEW_ROUNDS_MAX).toBe(3);
 expect(rounds()).toBe(1);
 expect(rounds(OTHER_BUNDLES.slice(0, 1))).toBe(2);
 expect(rounds(OTHER_BUNDLES.slice(0, 2))).toBe(3);
 expect(rounds(OTHER_BUNDLES)).toBe(4);
 // The same bundles reviewed again (a retry) are the same round, in any order; the current set that is already in the history adds nothing.
 expect(rounds([[PRF.bundleB, "e".repeat(64)], ["e".repeat(64), PRF.bundleB]])).toBe(2);
 expect(rounds([[PRF.bundleA], [PRF.bundleA]])).toBe(1);
 // The current review's bundles are compared as a set too: the same two bundles in another order are the round already in the history.
 expect(feedbackReviewRounds(feedbackWorkflowOf(feedbackSession("failed", { ref: { bundles: [PRF.bundleB, PRF.bundleA] }, history: [[PRF.bundleA, PRF.bundleB]] })))).toBe(1);
 expect(feedbackReviewRounds(undefined)).toBe(0);
});
it("a failed review shows the review-limit card with the controller's words at 3 and 4 rounds, and the ordinary failed card at 2", async () => {
 setup({ kind: "failed", options: { history: OTHER_BUNDLES.slice(0, 1) } });
 expect(await screen.findByTestId("prf-failed")).toBeTruthy();
 expect(screen.queryByTestId("prf-review-limit")).toBeNull();
 cleanup();
 for (const count of [2, 3]) {
  setup({ kind: "failed", options: { history: OTHER_BUNDLES.slice(0, count) } });
  const limit = await screen.findByTestId("prf-review-limit");
  expect(within(limit).getByRole("heading", { name: "Rovara has reviewed this pull request's comments 3 times" })).toBeTruthy();
  expect(limit.textContent).toContain(LIMIT_WORDS);
  expect(screen.queryByTestId("prf-failed")).toBeNull();
  expect((await within(limit).findByRole("button", { name: "Retry review" })).hasAttribute("disabled")).toBe(false);
  expect(within(limit).getByRole("button", { name: "Keep the pull request as it is" }).hasAttribute("disabled")).toBe(false);
  cleanup();
 }
});
it("the review-limit card still sends exactly the two choices Code offers: Retry review { reviewDigest } and Keep", async () => {
 const f = setup({ kind: "failed", options: { history: OTHER_BUNDLES.slice(0, 2) }, post: () => json(200, { session: feedbackSession("collecting"), started: true }) });
 fireEvent.click(await button("Retry review"));
 await waitFor(() => expect(f.posts).toHaveLength(1));
 expect(f.posts[0]!.path).toBe("/v1/app/sessions/" + PRF.sessionId + "/feedback-retry");
 expect(f.posts[0]!.body).toEqual({ reviewDigest: PRF.review });
 cleanup();
 const g = setup({ kind: "failed", options: { history: OTHER_BUNDLES.slice(0, 2) }, post: () => json(200, { session: feedbackSession("kept", { decisions: [decisionRecord()] }) }) });
 fireEvent.click(await button("Keep the pull request as it is"));
 await waitFor(() => expect(g.posts).toHaveLength(1));
 expect(bodyOf(g.posts[0]!)["decision"]).toBe("DISMISS");
});
it("the review-limit card is only for someone who can choose, only for a failed review, and the rail names it", async () => {
 setup({ kind: "failed", options: { history: OTHER_BUNDLES.slice(0, 2), you: { owner: false, level: "view" } } });
 expect(await screen.findByTestId("prf-viewer")).toBeTruthy();
 expect(screen.queryByTestId("prf-review-limit")).toBeNull();
 cleanup();
 // A complete review waiting for the owner's choice is the ordinary choice card at any round count.
 setup({ kind: "pending", options: { history: OTHER_BUNDLES.slice(0, 2) } });
 expect(await screen.findByTestId("prf-pending")).toBeTruthy();
 expect(screen.queryByTestId("prf-review-limit")).toBeNull();
 expect(prFeedbackRail(feedbackSession("failed", { history: OTHER_BUNDLES.slice(0, 2) }))?.detail).toBe("Review limit reached");
 expect(prFeedbackRail(feedbackSession("failed", { history: OTHER_BUNDLES.slice(0, 1) }))?.detail).toBe("The comment review didn't finish");
 // Someone who can't choose keeps the waiting line, not the limit line.
 expect(prFeedbackRail(feedbackSession("failed", { history: OTHER_BUNDLES.slice(0, 2), you: { owner: false, level: "view" } }))?.detail).toBe("Waiting for Priya to choose");
 // Any other phase, at any round count, keeps its own rail line.
 expect(prFeedbackRail(feedbackSession("pending", { history: OTHER_BUNDLES }))?.detail).toBe("Choose which comments to fix");
 expect(prFeedbackRail(feedbackSession("kept", { history: OTHER_BUNDLES }))?.detail).toBe("Waiting for the merge on GitHub");
});

// Controller ruling 2026-11-23: at 3+ rounds the ordinary Fix / Keep card (complete phase) also carries one quiet line; the failed-phase (l) card is unchanged.
const LIMIT_NOTE = "New comments won't start another review (limit reached).";
it("the complete-phase Fix / Keep card shows the one-line review-limit note at 3 rounds and 4, not at 2", async () => {
 // History of 1 earlier set plus the current review is 2 rounds: no line.
 setup({ kind: "pending", options: { history: OTHER_BUNDLES.slice(0, 1) } });
 const two = await screen.findByTestId("prf-pending");
 expect(screen.queryByTestId("prf-review-limit-note")).toBeNull();
 expect(two.textContent).not.toContain(LIMIT_NOTE);
 cleanup();
 for (const count of [2, 3]) {
  setup({ kind: "pending", options: { history: OTHER_BUNDLES.slice(0, count) } });
  const card = await screen.findByTestId("prf-pending");
  const notes = within(card).getAllByTestId("prf-review-limit-note");
  expect(notes).toHaveLength(1);
  expect(notes[0]!.textContent).toBe(LIMIT_NOTE);
  expect(card.textContent?.split(LIMIT_NOTE).length).toBe(2);
  // It is not the failed-phase limit card, and Fix / Keep stay as they were.
  expect(screen.queryByTestId("prf-review-limit")).toBeNull();
  expect(within(card).getByRole("button", { name: "Fix selected findings" })).toBeTruthy();
  cleanup();
 }
});
it("the failed-phase review-limit card is unchanged at 3 rounds: its own words, and no extra note line", async () => {
 setup({ kind: "failed", options: { history: OTHER_BUNDLES.slice(0, 2) } });
 const limit = await screen.findByTestId("prf-review-limit");
 expect(limit.textContent).toContain(LIMIT_WORDS);
 expect(screen.queryByTestId("prf-review-limit-note")).toBeNull();
 expect(limit.textContent).not.toContain(LIMIT_NOTE);
});

// 9d (Code half's Opus review): Code serves decidedByYou on feedbackDecisions in the full task read (computed server-side). true: "You chose this"; false or absent: "Chosen by the owner or a co-owner".
it("who chose follows Code's decidedByYou on the full task read: true is 'You chose this', false or absent is 'Chosen by the owner or a co-owner'", async () => {
 for (const [served, words] of [[{ decidedByYou: true }, "You chose this at "], [{ decidedByYou: false }, "Chosen by the owner or a co-owner at "], [{}, "Chosen by the owner or a co-owner at "]] as const) {
  for (const [kind, id] of [["fixing", "prf-fixing"], ["fix_stopped", "prf-fix-stopped"], ["fix_finished", "prf-fix-finished"]] as const) {
   setup({ kind, options: { decisions: [approveRecord(served)] } });
   const card = await screen.findByTestId(id);
   expect(card.textContent).toContain(words);
   expect(card.textContent).not.toContain(words.startsWith("You") ? "Chosen by the owner or a co-owner" : "You chose this");
   cleanup();
  }
 }
 // The latest Fix decision decides, never an earlier one or a Keep's flag.
 setup({ kind: "fixing", options: { decisions: [approveRecord({ decidedByYou: true, requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), approveRecord({ decidedByYou: false }), decisionRecord({ decidedByYou: true })] } });
 expect((await screen.findByTestId("prf-fixing")).textContent).toContain("Chosen by the owner or a co-owner at ");
});

// 9d (Code half's Opus review): COMMITTED_REFRESH_NEEDED means the choice COMMITTED but Code's follow-up read failed: it is UNKNOWN on all three actions (the lock stays, Check reads, nothing is ever resent), whatever the status.
it("COMMITTED_REFRESH_NEEDED on Fix, Keep and Retry review is an unknown outcome: locked, Check settles it from the full task read, and nothing is resent", async () => {
 const committed = (status: number) => refusal(status, "COMMITTED_REFRESH_NEEDED", "Your choice was recorded, but Rovara couldn't read it back.");
 const cases = [
  { name: "Fix", kind: "pending" as const, press: "Fix selected findings", path: "/feedback-decision", settled: (sent: Record<string, unknown>) => ({ next: "fixing" as const, options: { decisions: [approveRecord({ requestId: sent["requestId"] })] }, testId: "prf-fixing" }) },
  { name: "Keep", kind: "pending" as const, press: "Keep the pull request as it is", path: "/feedback-decision", settled: (sent: Record<string, unknown>) => ({ next: "kept" as const, options: { decisions: [decisionRecord({ requestId: sent["requestId"] })] }, testId: "prf-kept" }) },
  { name: "Retry review", kind: "failed" as const, press: "Retry review", path: "/feedback-retry", settled: () => ({ next: "reviewing" as const, options: {}, testId: "prf-reviewing" }) },
 ];
 for (const status of [409, 500, 502]) {
  for (const one of cases) {
   const f = setup({ kind: one.kind, post: () => committed(status) });
   fireEvent.click(await button(one.press));
   const lost = await screen.findByTestId("prf-no-reply");
   expect(screen.queryByTestId("prf-fix-refused")).toBeNull();
   expect(screen.queryByRole("button", { name: /Fix selected findings|Keep the pull request|Retry review/u })).toBeNull();
   const sent = (f.posts[0]!.body ?? {}) as Record<string, unknown>;
   expect(f.posts[0]!.path.endsWith(one.path)).toBe(true);
   expect(lost).toBeTruthy();
   // Still unknown until the full task read shows it (nothing recorded yet): the lock stays.
   fireEvent.click(await button("Check my choice"));
   expect(await screen.findByText(/Rovara hasn't recorded it yet/u)).toBeTruthy();
   const next = one.settled(sent);
   f.setSession(next.next, next.options);
   fireEvent.click(await button("Check my choice"));
   expect(await screen.findByTestId(next.testId)).toBeTruthy();
   expect(f.posts).toHaveLength(1);
   cleanup();
  }
 }
});
