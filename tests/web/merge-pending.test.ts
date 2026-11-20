// @vitest-environment jsdom
// Fix round 1 (Sol F1-F4; SCREEN-STATE-RULES R1-R5): an unresolved press survives close, remount, reload and a second tab; it is keyed by session; a failed refresh makes older "ready" data inert; the page announces what the
// server returned. Code's idempotency for the same request id: hosted-merge-routes.ts 168-173 (stored answer) and merge.ts 684/909 (merged pull requests are skipped and returned).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { fencedRead, fenceFor } from "../../packages/ui/src/screens/session/merge-fence.js";
import { useSession } from "../../packages/ui/src/api/sessions.js";
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
const sessionOf = (sessionId: string, over: Record<string, unknown> = {}) => SessionViewReaderSchema.parse(workspaceFixture({ sessionId }, { pullRequests: [PR], mergeTracking: [tracked()], ...over }));
const taskOf = (sessionId: string, over: Record<string, unknown> = {}): ReadTask => workspaceTask(sessionOf(sessionId, over))!;
const ready = (headSha = HEAD_A): Answer => ({ status: 200, body: { mayMerge: true, ready: true, heads: [{ repositoryId: "acme/payments", number: 42, headSha }], pullRequests: [{ repositoryId: "acme/payments", number: 42 }] } });
const lost: Answer = { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "We couldn't confirm the result yet; checking GitHub. Reload this page in a moment." } } };
const merged: Answer = { status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "acme/payments", number: 42 }] } };
const ORG = "org_aaaaaaaaaaaaaaaaaaaa", DEV = "a1".repeat(32), OTHER_DEV = "b2".repeat(32);
const meOf = (developerId: string, orgId = ORG): Answer => ({ status: 200, body: { developer: { id: developerId, name: "Ana", orgRole: "owner" }, org: { orgId, name: "Acme", plan: "team" }, identities: [] } });
const subjectOf = (session: string, developerId = DEV, orgId = ORG): string => orgId + "|" + developerId + "|" + session;
const SUBJECT = subjectOf(A);
const notFound: Answer = { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };

interface Script { session?: (id: string) => Record<string, unknown> | undefined; me?: () => Answer | Promise<Answer>; readiness?: (session: string) => Answer | Promise<Answer>; press?: (body: { requestId: string; expectedHeads?: unknown; risk?: string }, session: string) => Answer | Promise<Answer> }
function world(script: Script) {
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/me") return script.me?.() ?? meOf(DEV);
  // The section's own task read (a GET of the session). Unless a test says what the page reads, the read fails, so nothing is resolved by accident.
  const own = /sessions\/([^/]+)$/u.exec(request.path);
  if (own !== null && request.method === "GET") { const over = script.session?.(own[1]!); return over === undefined ? { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } } : { status: 200, body: { session: sessionOf(own[1]!, over) } }; }
  const match = /sessions\/([^/]+)\/merge$/u.exec(request.path);
  if (match === null) return notFound;
  if (request.method === "GET") return script.readiness?.(match[1]!) ?? notFound;
  return script.press?.(request.body as never, match[1]!) ?? notFound;
 });
 const posts = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST").map(request => request.body as { requestId: string; expectedHeads?: unknown; risk?: string });
 // One browser tab: its own query cache, the one shared localStorage.
 const tab = (sessionId: string, task = taskOf(sessionId), client?: ReturnType<typeof createQueryClient>) => {
  const query = client ?? createQueryClient();
  const element = (id: string, t: ReadTask) => h("div", { "data-theme": "light" }, h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MergeSection, { sessionId: id, task: t }) }) }));
  const ui = renderUi(element(sessionId, task));
  return { ...ui, query, // Same wrapper depth as renderUi, so the tree is preserved (a real navigation within one mounted tree), not remounted.
  show(id: string, t: ReadTask) { ui.rerender(h("div", { "data-theme": "light" }, element(id, t))); },
  /** A real task read ISSUED now, made through the fence exactly as the section makes its own (issue number at the start, stored with that call's own body), and shown with the task it returned. */
  async read(id: string, over: Record<string, unknown> = {}) { const session = sessionOf(id, over); await fencedRead(fenceFor(query, subjectOf(id)), async () => session); ui.rerender(h("div", { "data-theme": "light" }, element(id, workspaceTask(session)!))); },
  /** A real task read that is ISSUED now but answers only when `deliver()` is called (a slow read). */
  slowRead(id: string) { let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let answer: ReturnType<typeof sessionOf> | undefined; const pending = fencedRead(fenceFor(query, subjectOf(id)), async () => { await gate; return answer!; }); return { async deliver(over: Record<string, unknown> = {}) { answer = sessionOf(id, over); release(); await pending; ui.rerender(h("div", { "data-theme": "light" }, element(id, workspaceTask(answer)!))); } }; },
  };
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
 expect((await screen.findByRole("status", {}, { timeout: 3000 })).textContent).toMatch(/couldn't read this just now/u);
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
 expect(localStorage.getItem("rovara.merge.pending.v1:" + SUBJECT)).not.toBeNull();
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
 expect((JSON.parse(localStorage.getItem("rovara.merge.pending.v1:" + SUBJECT)!) as { requestId: string }).requestId).toBe(w.posts()[0]!.requestId);
});

it("F1/second tab, live: a record another tab writes (storage event) locks an open page immediately, and Press Merge in an already open confirmation sends nothing", async () => {
 const w = world({ readiness: () => ready(), press: () => merged });
 w.tab(A);
 fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
 const dialog = await screen.findByRole("dialog");
 const key = "rovara.merge.pending.v1:" + SUBJECT;
 localStorage.setItem(key, JSON.stringify({ v: 1, sessionId: SUBJECT, requestId: "22222222-2222-4222-8222-222222222222", startedAt: new Date().toISOString(), heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }], risk: undefined, sent: ["acme/payments #42 at aaaaaaa"] }));
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

const key = "rovara.merge.pending.v1:" + SUBJECT, STARTED = "2026-11-20T08:00:00.000Z";
const record = (over: Record<string, unknown> = {}) => JSON.stringify({ v: 1, sessionId: SUBJECT, requestId: "33333333-3333-4333-8333-333333333333", startedAt: STARTED, heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }], risk: "low", sent: [], ...over });

it("F1/clear rules: a task read issued AFTER the press that shows a moved head voids the record (never replayed); one that shows every PR merged clears it", async () => {
 localStorage.setItem(key, record());
 const moved = world({ readiness: () => ready(HEAD_B), press: () => merged });
 const m = moved.tab(A);
 await waitFor(() => expect(headline()).toBe(UNSURE));
 await m.read(A, { mergeTracking: [tracked({ headSha: HEAD_B })] });
 await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
 expect(screen.getByRole("status").textContent).toContain("dropped because the pull request has a new head");
 expect(moved.posts()).toHaveLength(0);
 m.unmount();
 localStorage.setItem(key, record());
 const seen = world({});
 const s = seen.tab(A);
 await waitFor(() => expect(headline()).toBe(UNSURE));
 await s.read(A, { mergeTracking: [tracked({ state: "merged" })] });
 await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
 s.unmount();
});

it("B1/N2: a stale tab never deletes another tab's newer record: data of unknown order, a read ISSUED BEFORE the press arriving later, and a readiness answer void nothing; a stale clear removes nothing", async () => {
 const w = world({ readiness: () => ready(HEAD_A), press: () => merged });
 // This tab shows head A and has a slow task read in flight, issued before the other tab's press.
 const stale = w.tab(A, taskOf(A, { mergeTracking: [tracked({ headSha: HEAD_A })] }));
 await screen.findByRole("button", { name: /^Merge #42/u });
 const slow = stale.slowRead(A);
 // The other tab then presses for head B and the storage event reaches this tab: this tab first OBSERVES the record only now, after its read was issued.
 localStorage.setItem(key, record({ heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_B }] }));
 window.dispatchEvent(new StorageEvent("storage", { key }));
 await waitFor(() => expect(headline()).toBe(UNSURE));
 // The slow read now answers, with a tracking time that is far in the future (another clock): it was issued before the press, so it voids nothing.
 await slow.deliver({ mergeTracking: [tracked({ headSha: HEAD_A, observedAt: "2099-01-01T00:00:00.000Z" })] });
 await new Promise(resolve => setTimeout(resolve, 60));
 expect(localStorage.getItem(key)).not.toBeNull();
 expect(screen.queryByText(/dropped because/u)).toBeNull();
 expect(w.posts()).toHaveLength(0);
 stale.unmount();
 // The same rule at the storage seam: a clear for another request id or another startedAt removes nothing.
 const { clearPending } = await import("../../packages/ui/src/screens/session/merge-pending.js");
 clearPending({ sessionId: SUBJECT, requestId: "33333333-3333-4333-8333-333333333333", startedAt: "2026-11-20T07:59:00.000Z" });
 clearPending({ sessionId: SUBJECT, requestId: "44444444-4444-4444-8444-444444444444", startedAt: STARTED });
 expect(localStorage.getItem(key)).not.toBeNull();
 clearPending({ sessionId: SUBJECT, requestId: "33333333-3333-4333-8333-333333333333", startedAt: STARTED });
 expect(localStorage.getItem(key)).toBeNull();
});

it("B1/N2: an older saved answer in one tab never settles ANOTHER request's record", async () => {
 const w = world({ readiness: () => ready(), press: () => merged });
 const a = w.tab(A);
 await press();
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
 // Another tab's newer unresolved request arrives by storage event: this tab still holds its own older answer.
 localStorage.setItem(key, record({ requestId: "55555555-5555-4555-8555-555555555555" }));
 window.dispatchEvent(new StorageEvent("storage", { key }));
 await new Promise(resolve => setTimeout(resolve, 60));
 expect(localStorage.getItem(key)).not.toBeNull();
 a.unmount();
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
 expect(localStorage.getItem("rovara.merge.pending.v1:" + SUBJECT)).not.toBeNull();
 expect(localStorage.getItem("rovara.merge.pending.v1:" + subjectOf(B))).toBeNull();
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
 await t.query.invalidateQueries({ queryKey: ["session", A, "merge", SUBJECT] });
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
 await t.query.invalidateQueries({ queryKey: ["session", A, "merge", SUBJECT] });
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

it("B4/N2: a saved 'Merged' answer retires, for good, only to a task read ISSUED AFTER the answer arrived that shows the pull request open; a read issued before it, answering later, does not", async () => {
 const w = world({ readiness: () => ready(), press: () => merged });
 const t = w.tab(A);
 await screen.findByRole("button", { name: /^Merge #42/u });
 const slow = t.slowRead(A);                      // issued BEFORE the answer
 await press();
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
 // It answers late with a disagreeing task whose tracking time is far in the future: issued before the answer, so it cannot contradict it.
 await slow.deliver({ mergeTracking: [tracked({ headSha: HEAD_B, observedAt: "2099-01-01T00:00:00.000Z" })] });
 expect(headline()).toBe("Merge accepted");
 // A read issued after the answer that shows the pull request open does.
 await t.read(A, { mergeTracking: [tracked({ headSha: HEAD_B, observedAt: "2000-01-01T00:00:00.000Z" })] });
 await waitFor(() => expect(headline()).not.toBe("Merge accepted"));
 expect(screen.queryByText("Merged acme/payments #42.")).toBeNull();
 expect(region().textContent).toContain("A later read shows a different head for a pull request this merge covered, so the earlier answer no longer applies.");
 // Older facts delivered afterwards do not bring it back.
 t.show(A, taskOf(A));
 await new Promise(resolve => setTimeout(resolve, 40));
 expect(screen.queryByText("Merged acme/payments #42.")).toBeNull();
 expect(w.posts()).toHaveLength(1);
});

it("N1/R6a: 408, 429, 401 and any unlisted 4xx are UNKNOWN and keep the lock; only the pre-dispatch refusals clear it; MERGE_NOT_READY (which Code also returns after a provider call) keeps the lock and shows Code's words", async () => {
 const answer = (status: number, code: string): Answer => ({ status, body: { error: { code, message: "Code's words." } } });
 for (const [reply, locked] of [[answer(408, "REQUEST_TIMEOUT"), true], [answer(429, "RATE_LIMITED"), true], [answer(418, "TEAPOT"), true], [answer(401, "UNAUTHENTICATED"), true], [answer(409, "SOMETHING_ELSE"), true], [answer(409, "MERGE_NOT_READY"), true], [answer(500, "MERGE_FAILED"), true], [answer(409, "IDEMPOTENCY_CONFLICT"), false], [answer(403, "FORBIDDEN"), false], [answer(404, "TASK_NOT_FOUND"), false], [answer(404, "SESSION_NOT_FOUND"), false], [answer(400, "CONFIG_INVALID"), false]] as Array<[Answer, boolean]>) {
  localStorage.clear();
  const w = world({ readiness: () => ready(), press: () => reply });
  const t = w.tab(A);
  await press();
  await waitFor(() => expect(w.posts()).toHaveLength(1));
  if (locked) { await waitFor(() => expect(headline()).toBe(UNSURE)); expect(localStorage.getItem(key)).not.toBeNull(); expect((await mergeButton()).hasAttribute("disabled")).toBe(true); }
  else { expect((await screen.findByRole("alert")).textContent).toContain("Code's words."); expect(localStorage.getItem(key)).toBeNull(); expect(headline()).not.toBe(UNSURE); }
  expect(w.posts()).toHaveLength(1);
  t.unmount();
 }
});

it("N3/R6c: Press Merge checks the LATEST state at send time: a denial or not-ready answer already in the query cache but not yet rendered sends ZERO POSTs", async () => {
 for (const latest of [{ mayMerge: false, ready: false, pullRequests: [{ repositoryId: "acme/payments", number: 42 }] }, { mayMerge: true, ready: false, message: "Checks haven't passed on the latest code.", heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }], pullRequests: [{ repositoryId: "acme/payments", number: 42 }] }]) {
  const w = world({ readiness: () => ready(), press: () => merged });
  const t = w.tab(A);
  fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
  const dialog = await screen.findByRole("dialog");
  // The read lands in the cache; React has not re-rendered yet.
  t.query.setQueryData(["session", A, "merge", SUBJECT], latest);
  fireEvent.click(within(dialog).getByRole("button", { name: "Press Merge" }));
  expect(w.posts()).toHaveLength(0);
  expect((await screen.findByRole("alert")).textContent).toContain("Nothing was sent");
  t.unmount();
  localStorage.clear();
 }
});

it("N3/R6c: an already open confirmation becomes inert and says why when the latest read drops the authority (rendered), and a failed latest read sends nothing", async () => {
 let state: "ok" | "no" | "fail" = "ok";
 const w = world({ readiness: () => state === "fail" ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } } : state === "no" ? { status: 200, body: { mayMerge: true, ready: false, message: "Not ready now.", heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }], pullRequests: [{ repositoryId: "acme/payments", number: 42 }] } } : ready(), press: () => merged });
 const t = w.tab(A);
 fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
 const dialog = await screen.findByRole("dialog");
 state = "no";
 await t.query.invalidateQueries({ queryKey: ["session", A, "merge", SUBJECT] });
 expect((await within(dialog).findByRole("alert")).textContent).toContain("Not ready now.");
 expect(within(dialog).getByRole("button", { name: "Press Merge" }).hasAttribute("disabled")).toBe(true);
 state = "fail";
 await t.query.invalidateQueries({ queryKey: ["session", A, "merge", SUBJECT] });
 await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("latest read failed"));
 fireEvent.click(within(dialog).getByRole("button", { name: "Press Merge" }));
 expect(w.posts()).toHaveLength(0);
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

it("N1: a 409 MERGE_NOT_READY after a press keeps the lock and shows Code's words without claiming nothing was merged", async () => {
 const w = world({ readiness: () => ready(), press: () => ({ status: 409, body: { error: { code: "MERGE_NOT_READY", message: "The pull request isn't open." } } }) });
 w.tab(A);
 await press();
 await waitFor(() => expect(headline()).toBe(UNSURE));
 expect(region().textContent).toContain("Code answered: The pull request isn't open. That doesn't say nothing was merged");
 expect(localStorage.getItem(key)).not.toBeNull();
 expect(w.posts()).toHaveLength(1);
});

it("N2a: a presence update (a manual cache write) is NOT a completed task read: it neither voids the record nor retires a saved answer while the real read is still in flight", async () => {
 // An unresolved press for head B (another tab); this tab shows head A and issues a new task read, which has not answered.
 const w = world({ readiness: () => ready(HEAD_A), press: () => merged });
 const t = w.tab(A, taskOf(A, { mergeTracking: [tracked({ headSha: HEAD_A })] }));
 await screen.findByRole("button", { name: /^Merge #42/u });
 localStorage.setItem(key, record({ heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_B }] }));
 window.dispatchEvent(new StorageEvent("storage", { key }));
 await waitFor(() => expect(headline()).toBe(UNSURE));
 const slow = t.slowRead(A);
 // The session screen's presence heartbeat writes the cached session; the same cached task facts (head A) are handed to the section again.
 t.query.setQueryData(["session", A], { viewingNow: [] });
 t.show(A, taskOf(A, { mergeTracking: [tracked({ headSha: HEAD_A })] }));
 await new Promise(resolve => setTimeout(resolve, 80));
 expect(localStorage.getItem(key)).not.toBeNull();
 expect(screen.queryByText(/dropped because/u)).toBeNull();
 expect(headline()).toBe(UNSURE);
 // The real read answers (issued after the press, showing head A): only now may it resolve.
 await slow.deliver({ mergeTracking: [tracked({ headSha: HEAD_A })] });
 await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
 t.unmount();
 // A saved answer is not retired by a presence update either.
 localStorage.clear();
 const w2 = world({ readiness: () => ready(), press: () => merged });
 const t2 = w2.tab(A);
 await press();
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
 const slow2 = t2.slowRead(A);
 t2.query.setQueryData(["session", A], { viewingNow: [] });
 t2.show(A, taskOf(A, { mergeTracking: [tracked({ headSha: HEAD_B })] }));
 await new Promise(resolve => setTimeout(resolve, 80));
 expect(screen.queryByText("Merged acme/payments #42.")).not.toBeNull();
 await slow2.deliver({ mergeTracking: [tracked({ headSha: HEAD_B })] });
 await waitFor(() => expect(screen.queryByText("Merged acme/payments #42.")).toBeNull());
});

it("R6b per-tab observation rule: a read issued in tab B before B observed A's record can NOT void it; after B observes it, B's new read can", async () => {
 const w = world({ readiness: () => ready(HEAD_A), press: () => merged });
 const b = w.tab(A, taskOf(A, { mergeTracking: [tracked({ headSha: HEAD_A })] }));
 await screen.findByRole("button", { name: /^Merge #42/u });
 const early = b.slowRead(A);                       // issued before B has seen any record
 localStorage.setItem(key, record({ heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_B }] }));
 window.dispatchEvent(new StorageEvent("storage", { key }));   // B observes it now
 await waitFor(() => expect(headline()).toBe(UNSURE));
 await early.deliver({ mergeTracking: [tracked({ headSha: HEAD_A })] });
 await new Promise(resolve => setTimeout(resolve, 60));
 expect(localStorage.getItem(key)).not.toBeNull();
 expect(screen.queryByText(/dropped because/u)).toBeNull();
 // A read B issues AFTER observing the record may resolve it.
 await b.read(A, { mergeTracking: [tracked({ headSha: HEAD_A })] });
 await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
 expect(screen.getByRole("status").textContent).toContain("dropped because the pull request has a new head");
});

it("N2a: a manual setQueryData is not a read and never settles a record, however much it shows (merged pull request), until a real read says so", async () => {
 localStorage.setItem(key, record());
 const w = world({ readiness: () => ready(HEAD_A), press: () => merged });
 const t = w.tab(A);
 await waitFor(() => expect(headline()).toBe(UNSURE));
 const mergedSession = sessionOf(A, { mergeTracking: [tracked({ state: "merged" })] });
 t.query.setQueryData(["session", A], mergedSession);
 t.show(A, workspaceTask(mergedSession)!);
 await new Promise(resolve => setTimeout(resolve, 80));
 expect(localStorage.getItem(key)).not.toBeNull();
 await t.read(A, { mergeTracking: [tracked({ state: "merged" })] });
 await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
});

it("R6e: the fence outlives the component: a read issued after the tab observed the record, and answered while the view was unmounted, still resolves it on remount", async () => {
 localStorage.setItem(key, record());
 const w = world({ readiness: () => ready(HEAD_A), press: () => merged });
 const client = createQueryClient();
 const first = w.tab(A, taskOf(A), client);
 await waitFor(() => expect(headline()).toBe(UNSURE));
 first.unmount();
 // While nothing is mounted, a real task read (issued after the observation) answers with a moved head.
 const session = sessionOf(A, { mergeTracking: [tracked({ headSha: HEAD_B })] });
 await fencedRead(fenceFor(client, SUBJECT), async () => session);
 w.tab(A, workspaceTask(session), client);
 await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
 expect(w.posts()).toHaveLength(0);
});

it("R6e: a refusal of the readiness read survives remount and a manual cache write does not restore authority; only a later successful read does", async () => {
 let mode: "ok" | "refuse" | "hold" = "ok", open!: () => void;
 const gate = new Promise<void>(resolve => { open = resolve; });
 const w = world({ readiness: async () => mode === "refuse" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "No." } } } : mode === "hold" ? (await gate, ready()) : ready(), press: () => merged });
 const client = createQueryClient();
 const first = w.tab(A, taskOf(A), client);
 await screen.findByRole("button", { name: /^Merge #42/u });
 mode = "refuse";
 await client.invalidateQueries({ queryKey: ["session", A, "merge", SUBJECT] });
 await waitFor(() => expect(screen.queryByRole("button", { name: /^Merge #42/u })).toBeNull());
 first.unmount();
 // Back again: the cache is handed a "ready" answer by a manual write, and the new read is still in flight.
 client.setQueryData(["session", A, "merge", SUBJECT], ready().body);
 mode = "hold";
 w.tab(A, taskOf(A), client);
 await new Promise(resolve => setTimeout(resolve, 80));
 expect(screen.queryByRole("button", { name: /^Merge #42/u })).toBeNull();
 open();
 expect(await screen.findByRole("button", { name: /^Merge #42/u })).toBeTruthy();
});

it("R6g: the record and the fence are keyed by company + person + session: a lock for one identity is invisible to another, and visible again to the first", async () => {
 let dev = DEV;
 const w = world({ readiness: () => ready(), press: () => lost, me: () => meOf(dev) });
 const first = w.tab(A);
 await press();
 await waitFor(() => expect(headline()).toBe(UNSURE));
 // The record is stored under org|person|session, never under the session alone.
 expect(localStorage.getItem("rovara.merge.pending.v1:" + A)).toBeNull();
 expect(Object.keys(localStorage).filter(k => k.startsWith("rovara.merge.pending")).map(k => k.split(":")[1])).toEqual([ORG + "|" + DEV + "|" + A]);
 first.unmount();
 // Another person on the same browser profile (same session id): no lock, Merge is available, nothing of the first person's shows.
 dev = OTHER_DEV;
 const other = w.tab(A);
 await waitFor(() => expect(headline()).toBe("Ready to merge"));
 expect((await mergeButton()).hasAttribute("disabled")).toBe(false);
 expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
 expect(w.posts()).toHaveLength(1);
 other.unmount();
 dev = DEV;
 w.tab(A);
 await waitFor(() => expect(headline()).toBe(UNSURE));
});

it("R6g: nothing is offered or sent while identity is unread; once it reads, Merge works", async () => {
 let me: Answer = { status: 403, body: { error: { code: "FORBIDDEN", message: "x" } } };
 const w = world({ readiness: () => ready(), press: () => merged, me: () => me });
 const t = w.tab(A);
 await waitFor(() => expect(t.query.getQueryState(["session", A, "identity"])?.status).toBe("error"));
 await new Promise(resolve => setTimeout(resolve, 80));
 // No identity, no readiness read, no Merge control, no lock lookup.
 expect(screen.queryByRole("button", { name: /^Merge #42/u })).toBeNull();
 expect(screen.queryByRole("dialog")).toBeNull();
 expect(w.request.mock.calls.some(([request]) => /\/merge$/u.test(request.path))).toBe(false);
 expect(w.posts()).toHaveLength(0);
 me = meOf(DEV);
 await t.query.invalidateQueries({ queryKey: ["session", A, "identity"] });
 await waitFor(async () => expect((await mergeButton()).hasAttribute("disabled")).toBe(false));
 await press();
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
});

it("R6h/M1: Cloud's 403 CSRF_INVALID (and CSRF_STALE) is not a refusal of authority: it says Couldn't merge that, clears nothing-was-sent, re-reads identity and never says only an admin", async () => {
 for (const code of ["CSRF_INVALID", "CSRF_STALE"]) {
 localStorage.clear();
 const w = world({ readiness: () => ready(), press: () => ({ status: 403, body: { error: { code, message: "Your sign-in changed." } } }) });
 w.tab(A);
 const meReads = () => w.request.mock.calls.filter(([request]) => request.path === "/v1/app/me").length;
 await press();
 await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Couldn't merge that. Your sign-in changed, so nothing was sent."));
 expect(region().textContent).not.toMatch(/admin|isn't allowed|permission/iu);
 await waitFor(() => expect(meReads()).toBeGreaterThan(1));
 expect(localStorage.getItem("rovara.merge.pending.v1:" + SUBJECT)).toBeNull();
 expect(headline()).not.toBe(UNSURE);
 expect(w.posts()).toHaveLength(1);
 screen.getByRole("region", { name: "Merge" });
 document.body.innerHTML = "";
 }
});

it("N2a/body: a GET whose own body lacks a fact an earlier manual cache write added does NOT settle; the facts that resolve come from that GET's body, never from the cache", async () => {
 localStorage.setItem(key, record());
 let body: Record<string, unknown> = { mergeTracking: [tracked({ headSha: HEAD_A })] };   // what the GET really returns: head A, still open
 const w = world({ readiness: () => ready(HEAD_A), press: () => merged, session: () => body });
 const t = w.tab(A);
 await waitFor(() => expect(headline()).toBe(UNSURE));
 // An earlier manual write left a merged session in the cache; the shared session adapter could hand it back as the "accepted" task of a later GET.
 t.query.setQueryData(["session", A], sessionOf(A, { mergeTracking: [tracked({ state: "merged" })] }));
 await new Promise(resolve => setTimeout(resolve, 100));
 fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
 await new Promise(resolve => setTimeout(resolve, 120));
 expect(localStorage.getItem(key)).not.toBeNull();
 expect(headline()).toBe(UNSURE);
 // When the GET itself says merged, the record is settled.
 body = { mergeTracking: [tracked({ state: "merged" })] };
 fireEvent.click(screen.getByRole("button", { name: "Check again" }));
 await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
 expect(w.posts()).toHaveLength(0);
});

it("N5: identity is read from the query state AT SEND: a changed or failed identity read between render and press means zero POSTs", async () => {
 for (const change of ["other", "failed"] as const) {
  localStorage.clear();
  const w = world({ readiness: () => ready(), press: () => merged });
  const t = w.tab(A);
  fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
  const dialog = await screen.findByRole("dialog");
  // The identity query changes in the cache; React has not re-rendered yet.
  if (change === "other") t.query.setQueryData(["session", A, "identity"], meOf(OTHER_DEV).body);
  else await t.query.fetchQuery({ queryKey: ["session", A, "identity"], queryFn: async () => { throw new Error("identity read failed"); }, staleTime: 0 }).catch(() => undefined);
  fireEvent.click(within(dialog).getByRole("button", { name: "Press Merge" }));
  expect(w.posts()).toHaveLength(0);
  expect(Object.keys(localStorage).filter(k => k.startsWith("rovara.merge.pending"))).toHaveLength(0);
  t.unmount();
 }
});

it("N5: a different company for the same person gets its OWN authority: A's cached readiness never makes Merge available in B before B's readiness is read", async () => {
 let org = ORG, hold = false, open!: () => void;
 const gate = new Promise<void>(resolve => { open = resolve; });
 const w = world({ readiness: async () => { if (hold) await gate; return ready(); }, press: () => lost, me: () => meOf(DEV, org) });
 const t = w.tab(A);
 await press();
 await waitFor(() => expect(headline()).toBe(UNSURE));
 // The same person is now in another company on the same page and client.
 org = "org_bbbbbbbbbbbbbbbbbbbb";hold = true;
 await t.query.invalidateQueries({ queryKey: ["session", A, "identity"] });
 await waitFor(() => expect(headline()).not.toBe(UNSURE));
 await new Promise(resolve => setTimeout(resolve, 60));
 // B's readiness has not answered: no enabled Merge button on A's cached authority, and A's record is invisible to B yet intact.
 const buttons = screen.queryAllByRole("button", { name: /^Merge #42/u });
 for (const button of buttons) expect(button.hasAttribute("disabled")).toBe(true);
 expect(localStorage.getItem("rovara.merge.pending.v1:" + subjectOf(A))).not.toBeNull();
 open();
 await waitFor(async () => expect((await mergeButton()).hasAttribute("disabled")).toBe(false));
 expect(w.posts()).toHaveLength(1);
});

it("N6: a different person never inherits the previous person's accepted-success attribution or its answer line", async () => {
 let dev = DEV;
 const w = world({ readiness: () => ready(), press: () => merged, me: () => meOf(dev) });
 const t = w.tab(A);
 await press();
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
 expect(region().textContent).toContain("Code answered that these are merged");
 dev = OTHER_DEV;
 await t.query.invalidateQueries({ queryKey: ["session", A, "identity"] });
 await waitFor(() => expect(region().textContent).not.toContain("Code answered that these are merged"));
 expect(screen.queryByText("Merged acme/payments #42.")).toBeNull();
 expect(screen.queryByText(/dropped because|A later read shows/u)).toBeNull();
 expect(w.posts()).toHaveLength(1);
});

function lagPage(w: ReturnType<typeof world>, query: ReturnType<typeof createQueryClient>) {
 function Page() { const s = useSession(A); const task = s.data === undefined ? undefined : workspaceTask(s.data); return task === undefined ? null : h(MergeSection, { sessionId: A, task }); }
 renderUi(h(AppHostProvider, { host: w.host, children: h(QueryClientProvider, { client: query, children: h(Page) }) }));
}
async function lagRounds(query: ReturnType<typeof createQueryClient>, w: ReturnType<typeof world>) {
 const readinessReads = () => w.request.mock.calls.filter(([request]) => /\/merge$/u.test(request.path) && request.method === "GET").length;
 const before = readinessReads();
 // Real refetches (and the section's own reads) all say: open, same head. The lag must not retire the answer or offer Merge.
 for (let round = 0; round < 3; round += 1) { await query.invalidateQueries({ queryKey: ["session", A] });await new Promise(resolve => setTimeout(resolve, 120)); }
 expect(screen.queryByText("Merged acme/payments #42.")).not.toBeNull();
 expect(headline()).toBe("Merge accepted");
 expect(region().textContent).toContain("Rovara's tracking hasn't recorded it yet");
 expect(screen.queryAllByRole("button", { name: /^Merge #42/u })).toHaveLength(0);
 expect(readinessReads()).toBe(before);
 expect(w.posts()).toHaveLength(1);
}

it("H1/B4 (production path): Code's tracking LAGS after an accepted answer: reads still show the PR open at the same head, Merge stays locked, readiness stays off, the answer is never retired on that; new commits (a different head) retire it", async () => {
 let over: Record<string, unknown> = {}, pressed = false;
 // Before the press the page reads head A open. Code's success path only WAKES the tracker (hosted-merge-routes.ts:212), so right after the answer reads STILL say open at the same head.
 const w = world({ readiness: () => ready(), press: () => { pressed = true;return merged; }, session: () => pressed ? over : {} });
 const query = createQueryClient();
 lagPage(w, query);
 await press();
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
 await lagRounds(query, w);
 over = { mergeTracking: [tracked({ headSha: HEAD_B })], pullRequests: [PR] };
 await query.invalidateQueries({ queryKey: ["session", A] });
 await waitFor(() => expect(screen.queryByText("Merged acme/payments #42.")).toBeNull());
 expect(region().textContent).toContain("A later read shows a different head for a pull request this merge covered");
 expect(localStorage.getItem("rovara.merge.accepted.v1:" + SUBJECT)).toBeNull();
 expect(w.posts()).toHaveLength(1);
});

it("H1: when Code's tracking catches up, a read that shows the pull requests merged ends the waiting state: 'Merged', still no Merge control", async () => {
 let over: Record<string, unknown> = {}, pressed = false;
 const w = world({ readiness: () => ready(), press: () => { pressed = true;return merged; }, session: () => pressed ? over : {} });
 const query = createQueryClient();
 lagPage(w, query);
 await press();
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
 await lagRounds(query, w);
 over = { mergeTracking: [tracked({ state: "merged" })], pullRequests: [{ ...PR, state: "merged" }] };
 await query.invalidateQueries({ queryKey: ["session", A] });
 await waitFor(() => expect(headline()).toBe("Merged"));
 expect(screen.queryAllByRole("button", { name: /^Merge #42/u })).toHaveLength(0);
 expect(w.posts()).toHaveLength(1);
});

it("H1: an accepted answer also yields to a read that shows the pull request CLOSED without a merge, never to 'open at the same head'", async () => {
 let over: Record<string, unknown> = {}, pressed = false;
 const w = world({ readiness: () => ready(), press: () => { pressed = true;return merged; }, session: () => pressed ? over : {} });
 const query = createQueryClient();
 function Page() { const s = useSession(A); const task = s.data === undefined ? undefined : workspaceTask(s.data); return task === undefined ? null : h(MergeSection, { sessionId: A, task }); }
 renderUi(h(AppHostProvider, { host: w.host, children: h(QueryClientProvider, { client: query, children: h(Page) }) }));
 await press();
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
 await query.invalidateQueries({ queryKey: ["session", A] });
 await new Promise(resolve => setTimeout(resolve, 120));
 expect(screen.queryByText("Merged acme/payments #42.")).not.toBeNull();
 over = { mergeTracking: [tracked({ state: "closed" })], pullRequests: [{ ...PR, state: "closed" }] };
 await query.invalidateQueries({ queryKey: ["session", A] });
 await waitFor(() => expect(screen.queryByText("Merged acme/payments #42.")).toBeNull());
 expect(region().textContent).toContain("closed without a merge, so the earlier answer no longer applies");
});

it("L1: 400 CONFIG_INVALID is final only for a single-PR press; for a multi-PR press (it can arrive after an earlier PR merged) it stays unknown and keeps the lock", async () => {
 const web = { ...tracked(), repositoryId: "acme/web", number: 7 };
 const twoReady: Answer = { status: 200, body: { mayMerge: true, ready: true, heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }, { repositoryId: "acme/web", number: 7, headSha: HEAD_A }], pullRequests: [{ repositoryId: "acme/payments", number: 42 }, { repositoryId: "acme/web", number: 7 }] } };
 const w = world({ readiness: () => twoReady, press: () => ({ status: 400, body: { error: { code: "CONFIG_INVALID", message: "Code's words." } } }) });
 w.tab(A, taskOf(A, { pullRequests: [PR, { ...PR, repository: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7" }], mergeTracking: [tracked(), web] }));
 fireEvent.click(await screen.findByRole("button", { name: "Merge 2 pull requests" }));
 fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Press Merge" }));
 await waitFor(() => expect(headline()).toBe(UNSURE));
 expect(localStorage.getItem(key)).not.toBeNull();
 expect(w.posts()).toHaveLength(1);
});

it("H1/reload: the accepted answer survives a reload and a second tab during Code's tracking lag: still 'Merge accepted', Merge locked, no readiness read, ONE POST in total", async () => {
 let pressed = false;
 const w = world({ readiness: () => ready(), press: () => { pressed = true;return merged; }, session: () => pressed ? {} : undefined });
 const first = w.tab(A);
 await press();
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
 first.unmount();
 const readinessReads = () => w.request.mock.calls.filter(([request]) => /\/merge$/u.test(request.path) && request.method === "GET").length;
 const before = readinessReads();
 // Reload (a fresh QueryClient) and a second tab: Code's reads still say open at the same head.
 const reloaded = w.tab(A), second = w.tab(A);
 await waitFor(() => expect(screen.getAllByRole("region", { name: "Merge" })).toHaveLength(2));
 await new Promise(resolve => setTimeout(resolve, 200));
 for (const section of screen.getAllByRole("region", { name: "Merge" })) { expect(section.querySelector(".rv-merge-state")!.textContent).toBe("Merge accepted");expect(within(section).queryAllByRole("button", { name: /^Merge #42/u })).toHaveLength(0); }
 expect(readinessReads()).toBe(before);
 expect(w.posts()).toHaveLength(1);
 reloaded.unmount();second.unmount();
});

const acceptedKey = "rovara.merge.accepted.v1:" + SUBJECT;
const acceptedRecord = (): string => JSON.stringify({ v: 1, subject: SUBJECT, requestId: "66666666-6666-4666-8666-666666666666", acceptedAt: new Date().toISOString(), words: "Merged acme/payments #42.", keys: ["acme/payments#42"], heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }] });

it("M2: a confirmation already OPEN in a second tab cannot send once the first tab's press was accepted: zero new POSTs, with or without the storage event; the dialog goes inert and says why", async () => {
 for (const withEvent of [true, false]) {
  localStorage.clear();
  const w = world({ readiness: () => ready(), press: () => merged });
  const b = w.tab(A);
  fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
  const dialog = await screen.findByRole("dialog");
  // Tab A's press was accepted: its accepted answer (written exactly as the press writes it) is in storage. Two Radix modals cannot be driven in one jsdom document, so tab A's press itself is exercised by the H1 tests.
  localStorage.setItem(acceptedKey, acceptedRecord());
  if (withEvent) { window.dispatchEvent(new StorageEvent("storage", { key: acceptedKey }));await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("Code has already answered that these are merged")); }
  fireEvent.click(within(dialog).getByRole("button", { name: "Press Merge" }));
  expect(w.posts()).toHaveLength(0);
  expect(Object.keys(localStorage).filter(k => k.startsWith("rovara.merge.pending"))).toHaveLength(0);
  b.unmount();
 }
});

it("L4: when storage refuses the accepted-answer write, the in-memory state says so ('this browser couldn't save it'), Merge stays locked, and one POST was sent", async () => {
 const realSet = Storage.prototype.setItem.bind(localStorage);
 vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => { if (key.startsWith("rovara.merge.accepted")) throw new Error("quota"); realSet(key, value); });
 const w = world({ readiness: () => ready(), press: () => merged });
 w.tab(A);
 await press();
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
 expect(headline()).toBe("Merge accepted (this browser couldn't save it)");
 expect(screen.queryAllByRole("button", { name: /^Merge #42/u })).toHaveLength(0);
 expect(localStorage.getItem(acceptedKey)).toBeNull();
 expect(w.posts()).toHaveLength(1);
});

it("B1: Check announces what its OWN task read returned: a failed or refused read says 'couldn't read this just now' and changes nothing else; never 'read again' or 'tracking hasn't recorded'", async () => {
 for (const state of ["unresolved", "accepted"] as const) {
  localStorage.clear();
  // The section's own task read always fails (default: 404); the readiness answer is fine and cached.
  const w = world({ readiness: () => ready(), press: () => state === "accepted" ? merged : lost });
  const t = w.tab(A);
  await press();
  await waitFor(() => expect(headline()).toBe(state === "accepted" ? "Merge accepted" : UNSURE));
  fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
  const note = await waitFor(() => { const status = screen.getAllByRole("status").map(node => node.textContent ?? "").find(text => /couldn't read this just now/u.test(text)); expect(status).toBeDefined();return status!; });
  expect(note).toContain("Nothing else changed.");
  expect(region().textContent).not.toMatch(/Rovara read again|hasn't recorded the merge yet/u);
  expect(headline()).toBe(state === "accepted" ? "Merge accepted" : UNSURE);
  expect(w.posts()).toHaveLength(1);
  t.unmount();
 }
});

it("B1: when its own task read succeeds Check says it read again; the lock is unchanged unless that body resolves it", async () => {
 const w = world({ readiness: () => ready(), press: () => lost, session: () => ({ mergeTracking: [tracked({ headSha: HEAD_A })] }) });
 w.tab(A);
 await press();
 await waitFor(() => expect(headline()).toBe(UNSURE));
 fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
 await waitFor(() => expect(screen.getAllByRole("status").some(node => /Rovara read again at/u.test(node.textContent ?? ""))).toBe(true));
 expect(headline()).toBe(UNSURE);
});

it("B2: a newer REFUSED task read fences an older response: the older success arriving afterwards (even with a different head) cannot erase the unknown lock; only a read issued after the refusal that succeeds can", async () => {
 localStorage.setItem(key, record());
 const w = world({ readiness: () => ready(HEAD_A), press: () => merged });
 const t = w.tab(A);
 await waitFor(() => expect(headline()).toBe(UNSURE));
 const older = t.slowRead(A);                                  // issued first, still in flight
 const { fencedRead: read, fenceFor: fenceOf } = await import("../../packages/ui/src/screens/session/merge-fence.js");
 await read(fenceOf(t.query, SUBJECT), async () => { throw new ApiError(403, "FORBIDDEN", "No."); }).catch(() => undefined);   // issued later, refused
 expect(fenceOf(t.query, SUBJECT).taskFailed).toBeDefined();
 await older.deliver({ mergeTracking: [tracked({ headSha: HEAD_B })] });   // the older response now arrives: a different head
 await new Promise(resolve => setTimeout(resolve, 80));
 expect(localStorage.getItem(key)).not.toBeNull();
 expect(screen.queryByText(/dropped because/u)).toBeNull();
 // A read issued AFTER the refusal that succeeds clears the failure and may resolve.
 await t.read(A, { mergeTracking: [tracked({ headSha: HEAD_B })] });
 await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
 expect(fenceOf(t.query, SUBJECT).taskFailed).toBeUndefined();
});

it("B2/R6e: the refusal outlives the component: after a remount on the same client an older success still cannot resolve anything", async () => {
 localStorage.setItem(key, record());
 const w = world({ readiness: () => ready(HEAD_A), press: () => merged });
 const client = createQueryClient();
 const first = w.tab(A, taskOf(A), client);
 await waitFor(() => expect(headline()).toBe(UNSURE));
 const { fencedRead: read, fenceFor: fenceOf } = await import("../../packages/ui/src/screens/session/merge-fence.js");
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const olderPending = read(fenceOf(client, SUBJECT), async () => { await gate; return sessionOf(A, { mergeTracking: [tracked({ headSha: HEAD_B })] }); });
 await read(fenceOf(client, SUBJECT), async () => { throw new ApiError(404, "NOT_FOUND", "x"); }).catch(() => undefined);
 first.unmount();
 w.tab(A, taskOf(A), client);
 await waitFor(() => expect(headline()).toBe(UNSURE));
 release();await olderPending;
 await new Promise(resolve => setTimeout(resolve, 80));
 expect(localStorage.getItem(key)).not.toBeNull();
 expect(fenceOf(client, SUBJECT).latestRead).toBeUndefined();
});

it("F1/R6b: an older FAILED task read arriving after a newer success never supersedes it: no failure is recorded, the newer read stays the latest, and authority is not dropped", async () => {
 const w = world({ readiness: () => ready(HEAD_A), press: () => merged });
 const t = w.tab(A);
 await screen.findByRole("button", { name: /^Merge #42/u });
 const fence = fenceFor(t.query, SUBJECT);
 let fail!: () => void;
 const gate = new Promise<void>(resolve => { fail = resolve; });
 // Issued first, still in flight; it will fail after a newer read has succeeded.
 const older = fencedRead(fence, async () => { await gate; throw new ApiError(503, "RUNTIME_UNAVAILABLE", "x"); }).catch(() => "failed");
 await t.read(A, { mergeTracking: [tracked({ headSha: HEAD_A })] });
 const newer = fence.latestRead!;
 expect(newer).toBeDefined();
 fail();
 expect(await older).toBe("failed");
 expect(fence.taskFailed).toBeUndefined();
 expect(fence.latestRead).toBe(newer);
 // A failure issued AFTER the latest success is still recorded (and an older success after it is dropped).
 await fencedRead(fence, async () => { throw new ApiError(403, "FORBIDDEN", "No."); }).catch(() => undefined);
 expect(fence.taskFailed).toBeDefined();
});
