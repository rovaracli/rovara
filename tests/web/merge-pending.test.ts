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
  return { ...ui, query, show(id: string, t: ReadTask) { ui.rerender(element(id, t)); } };
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

it("F1: a remount after a lost reply stays locked and sends ZERO new request ids; the one action re-sends the SAME id with the SAME body, and an answer ends it", async () => {
 const w = world({ readiness: () => ready(), press: () => lost });
 const first = w.tab(A);
 await press();
 await waitFor(() => expect(headline()).toBe(UNSURE));
 const original = w.posts()[0]!;
 first.unmount();
 // Reload, Back, sign-in return: the page is built again from nothing but storage.
 w.tab(A);
 await waitFor(() => expect(headline()).toBe(UNSURE));
 expect((await mergeButton()).hasAttribute("disabled")).toBe(true);
 expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
 fireEvent.click(await mergeButton());
 expect(screen.queryByRole("dialog")).toBeNull();
 expect(w.posts()).toHaveLength(1);
 // Check again: same id, same frozen body.
 const answers: Answer[] = [lost, merged];
 const script = w.request.getMockImplementation()!;
 w.request.mockImplementation(async request => request.method === "POST" ? answers.shift()! : script(request));
 fireEvent.click(screen.getByRole("button", { name: "Check again" }));
 await waitFor(() => expect(w.posts()).toHaveLength(2));
 expect(w.posts()[1]).toEqual(original);
 expect((await screen.findByRole("status", {}, { timeout: 3000 })).textContent).toContain("Still not confirmed");
 fireEvent.click(screen.getByRole("button", { name: "Check again" }));
 expect(await screen.findByText("Merged acme/payments #42.")).toBeTruthy();
 expect(w.posts().map(post => post.requestId)).toEqual([original.requestId, original.requestId, original.requestId]);
 expect(localStorage.length).toBe(0);
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

it("F1/clear rules: a moved head voids the record (never replayed), all merged on GitHub clears it, a definitive refusal clears it, 'still being made' and an unreadable answer keep it", async () => {
 const key = "rovara.merge.pending.v1:" + A;
 const save = () => localStorage.setItem(key, JSON.stringify({ v: 1, sessionId: A, requestId: "33333333-3333-4333-8333-333333333333", startedAt: new Date().toISOString(), heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }], risk: "low", sent: [] }));
 // Head moved: the old request cannot be replayed against new heads.
 save();
 const moved = world({ readiness: () => ready(HEAD_B), press: () => merged });
 const m = moved.tab(A, taskOf(A, { mergeTracking: [tracked({ headSha: HEAD_B })] }));
 await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
 expect(screen.getByRole("status").textContent).toContain("dropped because the pull request has a new head");
 expect(moved.posts()).toHaveLength(0);
 m.unmount();
 // Observed merged: cleared.
 save();
 const seen = world({});
 const s = seen.tab(A, taskOf(A, { mergeTracking: [tracked({ state: "merged" })] }));
 await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
 s.unmount();
 // Definitive refusal for that id: cleared, with Code's words. Still being made: kept.
 for (const [answer, kept] of [[{ status: 409, body: { error: { code: "MERGE_NOT_READY", message: "The pull request isn't open." } } }, false], [{ status: 409, body: { error: { code: "MERGE_NOT_READY", message: "A merge of this task is already being made. Reload the page in a moment." } } }, true], [{ status: 502, body: { error: { code: "INVALID_RESPONSE", message: "x" } } }, true]] as Array<[Answer, boolean]>) {
  save();
  const w = world({ readiness: () => ready(), press: () => answer });
  const t = w.tab(A);
  fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
  await waitFor(() => expect(w.posts()).toHaveLength(1));
  await waitFor(() => expect(localStorage.getItem(key) === null).toBe(!kept));
  expect(w.posts()[0]!.requestId).toBe("33333333-3333-4333-8333-333333333333");
  t.unmount();
 }
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
