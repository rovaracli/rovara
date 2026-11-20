// @vitest-environment jsdom
// Fix round 1 (Sol F1-F4; SCREEN-STATE-RULES R1-R5): an unresolved press survives close, remount, reload and a second tab; it is keyed by session; a failed refresh makes older "ready" data inert; the page announces what the
// server returned. Code's idempotency for the same request id: hosted-merge-routes.ts 168-173 (stored answer) and merge.ts 684/909 (merged pull requests are skipped and returned).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { MergeSection } from "../../packages/ui/src/screens/session/MergeSection.js";
import { workspaceTask, type ReadTask } from "../../packages/ui/src/screens/session/workspace-types.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";

type Answer = { status: number; body: unknown };
const A = "ses_aaaaaaaaaaaaaaaaaaaa", B = "ses_bbbbbbbbbbbbbbbbbbbb", HEAD_A = "a".repeat(40), HEAD_B = "b".repeat(40);
const PR = { repository: "acme/payments", number: 42, url: "https://github.com/acme/payments/pull/42", state: "open" as const };
const tracked = (over: Record<string, unknown> = {}) => ({ orgId: "org_aaaaaaaaaaaaaaaaaaaa", taskId: "11111111-1111-4111-8111-111111111111", repositoryId: "acme/payments", number: 42, version: 1, headSha: HEAD_A, draft: false, state: "open", baseBranch: "main", ci: "passing", ciBasis: "required", checksEverSeen: true, failingChecks: [], review: "approved", branch: "up_to_date", headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-10-23", count: 0 }, decisionDigest: "b".repeat(64), observedAt: "2026-10-23T12:00:00.000Z", ...over });
const taskOf = (sessionId: string, over: Record<string, unknown> = {}): ReadTask => workspaceTask(SessionViewReaderSchema.parse(workspaceFixture({ sessionId }, { pullRequests: [PR], mergeTracking: [tracked()], ...over })))!;
const ready = (headSha = HEAD_A): Answer => ({ status: 200, body: { mayMerge: true, ready: true, heads: [{ repositoryId: "acme/payments", number: 42, headSha }], pullRequests: [{ repositoryId: "acme/payments", number: 42 }] } });
const lost: Answer = { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "We couldn't confirm the result yet; checking GitHub. Reload this page in a moment." } } };
const merged: Answer = { status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "acme/payments", number: 42 }] } };
const notFound: Answer = { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };

interface Script { readiness?: (session: string) => Answer; press?: (body: { requestId: string; expectedHeads?: unknown; risk?: string }, session: string) => Answer | Promise<Answer> }
function world(script: Script) {
 const f = fakeHost(async request => {
  const match = /sessions\/([^/]+)\/merge$/u.exec(request.path);
  if (match === null) return notFound;
  if (request.method === "GET") return script.readiness?.(match[1]!) ?? notFound;
  return script.press?.(request.body as never, match[1]!) ?? notFound;
 });
 const posts = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST").map(request => request.body as { requestId: string; expectedHeads?: unknown; risk?: string });
 // One browser tab: its own query cache, the one shared localStorage.
 const tab = (sessionId: string, task = taskOf(sessionId)) => {
  const query = createQueryClient();
  const element = (id: string, t: ReadTask) => h("div", { "data-theme": "light" }, h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MergeSection, { sessionId: id, task: t }) }) }));
  const ui = renderUi(element(sessionId, task));
  return { ...ui, query, // Same wrapper depth as renderUi, so the tree is preserved (a real navigation within one mounted tree), not remounted.
  show(id: string, t: ReadTask) { ui.rerender(h("div", { "data-theme": "light" }, element(id, t))); } };
 };
 return { ...f, posts, tab };
}
const region = () => screen.getByRole("region", { name: "Merge" });
const headline = () => region().querySelector(".rv-merge-state")!.textContent;
const mergeButton = () => screen.findByRole("button", { name: /^Merge #42/u });
async function press() {
 fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
 fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Press Merge" }));
}
const UNSURE = "The result isn't confirmed yet";
beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear();vi.restoreAllMocks(); });

it("F1/B3: a remount after a lost reply stays locked and sends ZERO new POSTs; Check again only READS (more GETs, still exactly one POST), in this tab, after a remount and in a second tab", async () => {
 const w = world({ readiness: () => ready(), press: () => lost });
 const first = w.tab(A);
 await press();
 await waitFor(() => expect(headline()).toBe(UNSURE));
 const gets = () => w.request.mock.calls.filter(([request]) => request.method === "GET").length;
 let before = gets();
 fireEvent.click(screen.getByRole("button", { name: "Check again" }));
 await waitFor(() => expect(gets()).toBeGreaterThan(before));
 expect((await screen.findByRole("status", {}, { timeout: 3000 })).textContent).toMatch(/still not confirmed/u);
 expect(w.posts()).toHaveLength(1);
 first.unmount();
 // Reload, Back, sign-in return: the page is built again from nothing but storage.
 const again = w.tab(A);
 await waitFor(() => expect(headline()).toBe(UNSURE));
 expect((await mergeButton()).hasAttribute("disabled")).toBe(true);
 fireEvent.click(await mergeButton());
 expect(screen.queryByRole("dialog")).toBeNull();
 before = gets();
 fireEvent.click(screen.getByRole("button", { name: "Check again" }));
 await waitFor(() => expect(gets()).toBeGreaterThan(before));
 expect(w.posts()).toHaveLength(1);
 // A second tab (its own query cache, the shared localStorage).
 const second = w.tab(A);
 const checks = await screen.findAllByRole("button", { name: "Check again" });
 before = gets();
 fireEvent.click(checks[checks.length - 1]!);
 await waitFor(() => expect(gets()).toBeGreaterThan(before));
 expect(w.posts()).toHaveLength(1);
 expect(localStorage.getItem("rovara.merge.pending.v1:" + A)).not.toBeNull();
 second.unmount();again.unmount();
});

it("B2/B3: Check again after the readiness read is refused (403) sends no POST, drops Merge and shows the refusal; the lock stays", async () => {
 let refuse = false;
 const w = world({ readiness: () => refuse ? { status: 403, body: { error: { code: "FORBIDDEN", message: "You can't merge this task." } } } : ready(), press: () => lost });
 w.tab(A);
 await press();
 await waitFor(() => expect(headline()).toBe(UNSURE));
 refuse = true;
 fireEvent.click(screen.getByRole("button", { name: "Check again" }));
 await waitFor(() => expect(screen.queryByRole("button", { name: /^Merge #42/u })).toBeNull());
 expect(region().textContent).toContain("The latest read failed: You can't merge this task. Merge stays locked.");
 expect(headline()).toBe(UNSURE);
 expect(w.posts()).toHaveLength(1);
});

it("F1/R3: closing and reopening the confirmation sends one request; Escape and a second open never mint another id while one is unresolved", async () => {
 const w = world({ readiness: () => ready(), press: () => lost });
 w.tab(A);
 fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
 fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
 await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
 await press();
 await waitFor(() => expect(headline()).toBe(UNSURE));
 expect(screen.queryByRole("dialog")).toBeNull();
 fireEvent.click(await mergeButton());
 expect(screen.queryByRole("dialog")).toBeNull();
 expect(w.posts()).toHaveLength(1);
});

it("F1/second tab: tab A's lost press locks tab B at once (storage event) and B never mints a new id", async () => {
 const w = world({ readiness: () => ready(), press: () => lost });
 const b = w.tab(A);
 await screen.findByRole("button", { name: /^Merge #42/u });
 b.unmount();
 const a = w.tab(A);
 await press();
 await waitFor(() => expect(headline()).toBe(UNSURE));
 a.unmount();
 // A separate render sharing localStorage: tab B opened afterwards.
 w.tab(A);
 await waitFor(() => expect(headline()).toBe(UNSURE));
 fireEvent.click(await mergeButton());
 expect(screen.queryByRole("dialog")).toBeNull();
 expect(w.posts()).toHaveLength(1);
 expect((JSON.parse(localStorage.getItem("rovara.merge.pending.v1:" + A)!) as { requestId: string }).requestId).toBe(w.posts()[0]!.requestId);
});

it("F1/second tab, live: a record another tab writes (storage event) locks an open page immediately, and Press Merge in an already open confirmation sends nothing", async () => {
 const w = world({ readiness: () => ready(), press: () => merged });
 w.tab(A);
 fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
 const dialog = await screen.findByRole("dialog");
 const key = "rovara.merge.pending.v1:" + A;
 localStorage.setItem(key, JSON.stringify({ v: 1, sessionId: A, requestId: "22222222-2222-4222-8222-222222222222", startedAt: new Date().toISOString(), heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }], risk: undefined, sent: ["acme/payments #42 at aaaaaaa"] }));
 window.dispatchEvent(new StorageEvent("storage", { key }));
 fireEvent.click(within(dialog).getByRole("button", { name: "Press Merge" }));
 await waitFor(() => expect(headline()).toBe(UNSURE));
 expect(w.posts()).toHaveLength(0);
});

it("F1/storage: a press that cannot be saved is not sent, and storage that cannot be read locks Merge and says why", async () => {
 const w = world({ readiness: () => ready(), press: () => merged });
 w.tab(A);
 fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
 const dialog = await screen.findByRole("dialog");
 vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
 fireEvent.click(within(dialog).getByRole("button", { name: "Press Merge" }));
 expect((await screen.findByRole("alert")).textContent).toContain("couldn't save this merge request in this browser, so it wasn't sent");
 expect(w.posts()).toHaveLength(0);
 vi.restoreAllMocks();
 vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
 const again = world({ readiness: () => ready(), press: () => merged });
 document.body.innerHTML = "";
 again.tab(B);
 await waitFor(() => expect(headline()).toBe("Merge is locked in this browser"));
 expect(region().textContent).toContain("Locked: this browser's storage can't be read");
 expect((await mergeButton()).hasAttribute("disabled")).toBe(true);
 expect(again.posts()).toHaveLength(0);
});

const key = "rovara.merge.pending.v1:" + A, STARTED = "2026-11-20T08:00:00.000Z";
const record = (over: Record<string, unknown> = {}) => JSON.stringify({ v: 1, sessionId: A, requestId: "33333333-3333-4333-8333-333333333333", startedAt: STARTED, heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }], risk: "low", sent: [], ...over });

it("F1/clear rules: a tracking read taken AFTER the press that shows a moved head voids the record (never replayed); GitHub showing every PR merged clears it", async () => {
 localStorage.setItem(key, record());
 const moved = world({ readiness: () => ready(HEAD_B), press: () => merged });
 const m = moved.tab(A, taskOf(A, { mergeTracking: [tracked({ headSha: HEAD_B, observedAt: "2026-11-20T08:05:00.000Z" })] }));
 await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
 expect(screen.getByRole("status").textContent).toContain("dropped because the pull request has a new head");
 expect(moved.posts()).toHaveLength(0);
 m.unmount();
 localStorage.setItem(key, record());
 const seen = world({});
 const s = seen.tab(A, taskOf(A, { mergeTracking: [tracked({ state: "merged" })] }));
 await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
 s.unmount();
});

it("B1: a stale tab never deletes another tab's newer record: older tracking or a different head in a readiness answer does not void it, and a stale clear (other startedAt) removes nothing", async () => {
 // This tab still shows head A, observed BEFORE the other tab's press; the other tab saved a request for head B.
 localStorage.setItem(key, record({ heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_B }], startedAt: STARTED }));
 const w = world({ readiness: () => ready(HEAD_A), press: () => merged });
 const stale = w.tab(A, taskOf(A, { mergeTracking: [tracked({ headSha: HEAD_A, observedAt: "2026-11-20T07:00:00.000Z" })] }));
 await waitFor(() => expect(headline()).toBe(UNSURE));
 await new Promise(resolve => setTimeout(resolve, 60));
 expect(localStorage.getItem(key)).not.toBeNull();
 expect(screen.queryByText(/dropped because/u)).toBeNull();
 expect(w.posts()).toHaveLength(0);
 stale.unmount();
 // The same rule at the storage seam: a clear for another request id or another startedAt removes nothing.
 const { clearPending } = await import("../../packages/ui/src/screens/session/merge-pending.js");
 clearPending({ sessionId: A, requestId: "33333333-3333-4333-8333-333333333333", startedAt: "2026-11-20T07:59:00.000Z" });
 clearPending({ sessionId: A, requestId: "44444444-4444-4444-8444-444444444444", startedAt: STARTED });
 expect(localStorage.getItem(key)).not.toBeNull();
 clearPending({ sessionId: A, requestId: "33333333-3333-4333-8333-333333333333", startedAt: STARTED });
 expect(localStorage.getItem(key)).toBeNull();
});

it("F2: one session's lock never shows on another; the first session's record is untouched and locks again when it comes back", async () => {
 const w = world({ readiness: () => ready(), press: () => lost });
 const t = w.tab(A);
 await press();
 await waitFor(() => expect(headline()).toBe(UNSURE));
 t.show(B, taskOf(B));
 await waitFor(() => expect(headline()).toBe("Ready to merge"));
 expect((await mergeButton()).hasAttribute("disabled")).toBe(false);
 expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
 expect(localStorage.getItem("rovara.merge.pending.v1:" + A)).not.toBeNull();
 expect(localStorage.getItem("rovara.merge.pending.v1:" + B)).toBeNull();
 t.show(A, taskOf(A));
 await waitFor(() => expect(headline()).toBe(UNSURE));
 expect(w.posts()).toHaveLength(1);
});

it("F3/R1: after one good 'ready' read, a refetch that fails makes the older data inert: no Merge button, the read-failed state, and Read again", async () => {
 let fail = false;
 const w = world({ readiness: () => fail ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } } : ready(), press: () => merged });
 const t = w.tab(A);
 await screen.findByRole("button", { name: /^Merge #42/u });
 fail = true;
 await t.query.invalidateQueries({ queryKey: ["session", A, "merge"] });
 await waitFor(() => expect(headline()).toBe("Rovara couldn't read this from GitHub just now"));
 expect(screen.queryByRole("button", { name: /^Merge #42/u })).toBeNull();
 expect(screen.getByRole("button", { name: "Read again" })).toBeTruthy();
 expect(w.posts()).toHaveLength(0);
 await expectNoAxeViolations(region());
 // Still locked while the read after the failure is under way and until one works.
 fireEvent.click(screen.getByRole("button", { name: "Read again" }));
 await waitFor(() => expect(headline()).toBe("Rovara couldn't read this from GitHub just now"));
 fail = false;
 fireEvent.click(await screen.findByRole("button", { name: "Read again" }));
 expect(await screen.findByRole("button", { name: /^Merge #42/u })).toBeTruthy();
});

it("F3/R1: a later refusal (403) removes the Merge button at once, even with an earlier ready answer in the cache", async () => {
 let refuse = false;
 const w = world({ readiness: () => refuse ? { status: 403, body: { error: { code: "FORBIDDEN", message: "No." } } } : ready() });
 const t = w.tab(A);
 await screen.findByRole("button", { name: /^Merge #42/u });
 refuse = true;
 await t.query.invalidateQueries({ queryKey: ["session", A, "merge"] });
 await waitFor(() => expect(screen.queryByRole("button", { name: /^Merge #42/u })).toBeNull());
 expect(headline()).toBe("Merge it on GitHub");
});

it("R2: the page announces what the server returned, not what was asked", async () => {
 const web = { ...tracked(), repositoryId: "acme/web", number: 7 };
 const w = world({ readiness: () => ({ status: 200, body: { mayMerge: true, ready: true, heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }, { repositoryId: "acme/web", number: 7, headSha: HEAD_A }], pullRequests: [{ repositoryId: "acme/payments", number: 42 }, { repositoryId: "acme/web", number: 7 }] } }), press: () => merged });
 w.tab(A, taskOf(A, { pullRequests: [PR, { ...PR, repository: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7" }], mergeTracking: [tracked(), web] }));
 fireEvent.click(await screen.findByRole("button", { name: "Merge 2 pull requests" }));
 fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Press Merge" }));
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
 expect(region().textContent).not.toContain("Merged acme/payments #42, acme/web #7");
 expect(screen.queryByText(/Merged .*web #7/u)).toBeNull();
});

it("R5: the unresolved state, the locked storage state and the check-again state are accessible", async () => {
 const w = world({ readiness: () => ready(), press: () => lost });
 w.tab(A);
 await press();
 await waitFor(() => expect(headline()).toBe(UNSURE));
 await expectNoAxeViolations(region());
});

it("B4/R2: a saved 'Merged' answer retires when a later task read disagrees (the pull request open again, observed after the answer)", async () => {
 const w = world({ readiness: () => ready(), press: () => merged });
 const t = w.tab(A);
 await press();
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
 expect(headline()).toBe("Merged");
 // A task read from before the answer does not retire it ...
 t.show(A, taskOf(A));
 expect(headline()).toBe("Merged");
 // ... one observed after it, showing the pull request open at another head, does.
 t.show(A, taskOf(A, { mergeTracking: [tracked({ headSha: HEAD_B, observedAt: new Date(Date.now() + 60_000).toISOString() })] }));
 await waitFor(() => expect(headline()).not.toBe("Merged"));
 expect(screen.queryByText("Merged acme/payments #42.")).toBeNull();
 expect(region().textContent).toContain("A later read shows a pull request open again, so the earlier answer no longer applies.");
 expect(w.posts()).toHaveLength(1);
});

it("B5/R4: the readiness answer's arrival is never shown as a fresh GitHub observation; tracking time and the answer's time are labelled for what they are", async () => {
 const w = world({ readiness: () => ready(), press: () => merged });
 w.tab(A);
 await screen.findByRole("button", { name: /^Merge #42/u });
 const text = region().textContent;
 expect(text).not.toMatch(/looked just now|Head on GitHub|Rovara read GitHub at|GitHub would merge/u);
 expect(text).toContain("Read by Rovara at");
 expect(text).toContain("Head in Rovara's latest read");
 expect(text).toContain("Tracked from GitHub");
});
