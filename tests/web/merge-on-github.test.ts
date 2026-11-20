// @vitest-environment jsdom
// L4-TA5 + DEC 254zzz94: each open pull request keeps an "Open on GitHub" link. The Merge button shows only when Code says this person may merge (the readiness read); with no readiness (a Code
// without the route, the default fake below) there is no button and nothing is ever pressed.
import { afterEach, beforeEach, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
import { changedSince, pullRowsOf, shownOf } from "../../packages/ui/src/screens/session/merge-facts.js";
import { expectNoAxeViolations } from "./support/axe.js";

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); });
type Pull = { repository: string; number: number; url: string; state: "open" | "closed" | "merged" };
const PR: Pull = { repository: "acme/payments", number: 42, url: "https://github.com/acme/payments/pull/42", state: "open" };
type Answer = { status: number; body: unknown };
function setup(task: Record<string, unknown>, answers: { readiness?: Answer | (() => Answer); press?: Answer | (() => Promise<Answer>) } = {}) {
  const session = SessionViewReaderSchema.parse(workspaceFixture({}, task));
  const notFound = { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
  const f = fakeHost(async (request) => {
    if (/\/merge$/u.test(request.path) && request.method === "GET") return typeof answers.readiness === "function" ? answers.readiness() : answers.readiness ?? notFound;
    if (/\/merge$/u.test(request.path) && request.method === "POST") return typeof answers.press === "function" ? answers.press() : answers.press ?? notFound;
    return notFound;
  }), query = createQueryClient();
  const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, "Fix duplicate refunds"), h(Workspace, { session })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
  return { ...f, ...ui, query, router, close() { ui.unmount(); router.dispose(); query.clear(); } };
}
const mergeCalls = (f: ReturnType<typeof setup>) => f.request.mock.calls.map(([request]) => request).filter(request => /\/merge$/u.test(request.path) && request.method === "POST");

it("with no readiness from Code: no Merge button, the open pull request linked on GitHub, even when Code's view says it is ready", async () => {
  const f = setup({ pullRequests: [PR], merge: { ready: true } });
  const region = screen.getByRole("region", { name: "Merge" });
  expect(screen.queryByRole("button", { name: /merge/iu })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  const link = screen.getByRole("link", { name: /Open on GitHub: acme\/payments #42/u });
  expect(link.getAttribute("href")).toBe(PR.url);
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(region.textContent).toContain("Ready to merge on GitHub");
  expect(mergeCalls(f)).toHaveLength(0);
  await expectNoAxeViolations(f.container);
  f.close();
});

it("shows the section for a hosted task whose view carries no merge field at all (the case today) and names the not-ready words when Code sends them", () => {
  const a = setup({ pullRequests: [PR] });
  expect(screen.getByRole("region", { name: "Merge" }).textContent).toContain("Merge it on GitHub");
  expect(screen.getByRole("link", { name: /Open on GitHub/u })).toBeTruthy();
  a.close();
  const b = setup({ pullRequests: [PR], merge: { ready: false, message: "Checks haven't passed on the latest code." } });
  expect(screen.getByRole("region", { name: "Merge" }).textContent).toContain("Not ready to merge.");
  expect(screen.getByText("Checks haven't passed on the latest code.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /merge/iu })).toBeNull();
  b.close();
});

it("offers one link per open pull request, none for merged or closed ones, and no section at all when nothing is open", () => {
  const a = setup({ pullRequests: [PR, { ...PR, repository: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7" }, { ...PR, number: 9, url: "https://github.com/acme/payments/pull/9", state: "merged" }, { ...PR, number: 10, url: "https://github.com/acme/payments/pull/10", state: "closed" }] });
  expect(screen.getAllByRole("link", { name: /Open on GitHub/u }).map(link => link.getAttribute("href"))).toEqual([PR.url, "https://github.com/acme/web/pull/7"]);
  a.close();
  const b = setup({ pullRequests: [{ ...PR, state: "merged" }] });
  expect(screen.queryByRole("region", { name: "Merge" })).toBeNull();
  b.close();
  const c = setup({ pullRequests: [] });
  expect(screen.queryByRole("region", { name: "Merge" })).toBeNull();
  c.close();
});

const tracked = (state: "open" | "merged") => ({ orgId: "org_aaaaaaaaaaaaaaaaaaaa", taskId: "11111111-1111-4111-8111-111111111111", repositoryId: "acme/payments", number: 42, version: 1, headSha: "a".repeat(40), draft: false, state, baseBranch: "main", ci: "passing", ciBasis: "required", checksEverSeen: true, failingChecks: [], review: "approved", branch: "up_to_date", headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-10-23", count: 0 }, decisionDigest: "b".repeat(64), observedAt: "2026-10-23T12:00:00.000Z" });

it("says Merged, and offers no link, once Code's own tracking shows every pull request merged; an open tracked one keeps its words and link", () => {
  const done = setup({ pullRequests: [PR], mergeTracking: [tracked("merged")] });
  expect(screen.getByRole("region", { name: "Merge" }).querySelector(".rv-merge-state")!.textContent).toBe("Merged");
  expect(screen.queryByRole("link", { name: /Open on GitHub/u })).toBeNull();
  done.close();
  const open = setup({ pullRequests: [PR], mergeTracking: [tracked("open")] });
  const text = screen.getByRole("region", { name: "Merge" }).textContent;
  for (const words of ["Checks", "Passed", "Approved", "Up to date with its base", "aaaaaaa"]) expect(text).toContain(words);
  expect(screen.getByRole("link", { name: /Open on GitHub/u }).getAttribute("href")).toBe(PR.url);
  open.close();
});

it("never makes a link of an address that is not github.com (a pull request url Code sent that is something else shows as text)", () => {
  const f = setup({ pullRequests: [{ ...PR, url: "https://evil.example/acme/payments/pull/42" }] });
  expect(screen.queryByRole("link", { name: /Open on GitHub/u })).toBeNull();
  expect(screen.getByRole("region", { name: "Merge" }).textContent).toContain("acme/payments #42");
  f.close();
});

// DEC 254zzz94: the Merge button.
const READY = { mayMerge: true, ready: true, pullRequests: [{ repositoryId: "payments", number: 42, url: PR.url }] };

it("a person who may merge sees an enabled Merge button when Code says ready; pressing asks once and sends one request with one request id", async () => {
  const f = setup({ pullRequests: [PR] }, { readiness: { status: 200, body: READY }, press: { status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "payments", number: 42 }] } } });
  const button = await screen.findByRole("button", { name: /^Merge #42/u });
  expect(button.hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("link", { name: /Open on GitHub: acme\/payments #42/u })).toBeTruthy();
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "Press Merge" });
  fireEvent.click(confirm);fireEvent.click(confirm);
  expect(await screen.findByText("Merged payments #42.")).toBeTruthy();
  const presses = mergeCalls(f);
  expect(presses).toHaveLength(1);
  expect(Object.keys(presses[0]!.body as object)).toEqual(["requestId"]);
  expect((presses[0]!.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(screen.queryByRole("button", { name: /^Merge #42/u })).toBeNull();
  await expectNoAxeViolations(f.container);
  f.close();
});

it("not ready: the button is there but disabled, with Code's words; nothing is pressed", async () => {
  const f = setup({ pullRequests: [PR] }, { readiness: { status: 200, body: { ...READY, ready: false, message: "Checks haven't passed on the latest code." } } });
  const button = await screen.findByRole("button", { name: /^Merge #42/u });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Checks haven't passed on the latest code.")).toBeTruthy();
  expect(mergeCalls(f)).toHaveLength(0);
  f.close();
});

it("a person who may not merge sees no button, only the GitHub link", async () => {
  const f = setup({ pullRequests: [PR] }, { readiness: { status: 200, body: { mayMerge: false, ready: false, pullRequests: READY.pullRequests } } });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => /\/merge$/u.test(request.path))).toBe(true));
  // Let the answer render before looking for the button.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("button", { name: /^Merge #42/u })).toBeNull();
  expect(screen.getByRole("link", { name: /Open on GitHub/u })).toBeTruthy();
  f.close();
});

it("a refused press shows Code's words and the next press uses a fresh request id", async () => {
  const f = setup({ pullRequests: [PR] }, { readiness: { status: 200, body: READY }, press: { status: 403, body: { error: { code: "FORBIDDEN", message: "GitHub isn't allowing this merge yet." } } } });
  for (let round = 0; round < 2; round += 1) {
    fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Press Merge" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(mergeCalls(f)).toHaveLength(round + 1));
  }
  expect(screen.getByRole("alert").textContent).toContain("GitHub isn't allowing this merge yet.");
  const ids = mergeCalls(f).map(call => (call.body as { requestId: string }).requestId);
  expect(new Set(ids).size).toBe(2);
  f.close();
});

it("the press carries the heads and risk Code showed, frozen when the confirmation opened", async () => {
  const HEAD = { repositoryId: "payments", number: 42, headSha: "a".repeat(40) };
  const f = setup({ pullRequests: [PR] }, { readiness: { status: 200, body: { ...READY, risk: "medium", heads: [HEAD] } }, press: { status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "payments", number: 42 }] } } });
  fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("payments #42 at aaaaaaa");
  fireEvent.click(within(dialog).getByRole("button", { name: "Press Merge" }));
  expect(await screen.findByText("Merged payments #42.")).toBeTruthy();
  const bodies = mergeCalls(f).map(call => call.body as { requestId: string; expectedHeads?: unknown; risk?: string });
  expect(bodies).toEqual([{ requestId: bodies[0]!.requestId, expectedHeads: [HEAD], risk: "medium" }]);
  f.close();
});

// Lifecycle UI (boards 3e-3i, 9a, 12j, 15j): per-pull-request facts, head drift, an unresolved original request, and observation versus receipt.
const HEAD_A = "a".repeat(40), HEAD_B = "b".repeat(40);
const ready = (heads: Array<{ repositoryId: string; number: number; headSha: string }>): Answer => ({ status: 200, body: { mayMerge: true, ready: true, heads, pullRequests: heads.map(({ repositoryId, number }) => ({ repositoryId, number })) } });
const headOf = (headSha: string) => ({ repositoryId: "acme/payments", number: 42, headSha });
const region = () => screen.getByRole("region", { name: "Merge" });

it("head drift: when GitHub's head is not the head every check ran on, Merge is locked, the page says why and nothing can be sent", async () => {
  const f = setup({ pullRequests: [PR], mergeTracking: [tracked("open")] }, { readiness: ready([headOf(HEAD_B)]) });
  const button = await screen.findByRole("button", { name: /^Merge #42/u });
  expect(region().querySelector(".rv-merge-state")!.textContent).toBe("The pull request changed after it was checked");
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(region().textContent).toContain("Locked: Rovara's latest read shows a different head than the one that was checked.");
  expect(region().textContent).toContain("different from the checked head");
  expect(region().textContent).not.toMatch(/looked just now|Head on GitHub/u);
  fireEvent.click(button);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mergeCalls(f)).toHaveLength(0);
  await expectNoAxeViolations(f.container);
  f.close();
});

it("the same head on both sides is ready: one authorization line names the head and base, and what is not included", async () => {
  const f = setup({ pullRequests: [PR], mergeTracking: [tracked("open")] }, { readiness: ready([headOf(HEAD_A)]) });
  const button = await screen.findByRole("button", { name: "Merge #42 into main" });
  expect(button.hasAttribute("disabled")).toBe(false);
  expect(region().querySelector(".rv-merge-state")!.textContent).toBe("Ready to merge");
  expect(region().textContent).toContain("merging head aaaaaaa of acme/payments #42 into main");
  expect(region().textContent).toContain("Not included: deploying");
  await expectNoAxeViolations(f.container);
  f.close();
});

it("a head that moves while the confirmation is open is not pressed: the page says it changed and zero requests are sent", async () => {
  let heads = [headOf(HEAD_A)];
  const f = setup({ pullRequests: [PR], mergeTracking: [tracked("open")] }, { readiness: () => ready(heads), press: { status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "acme/payments", number: 42 }] } } });
  fireEvent.click(await screen.findByRole("button", { name: "Merge #42 into main" }));
  const dialog = await screen.findByRole("dialog");
  heads = [headOf(HEAD_B)];
  await f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID, "merge"] });
  expect((await within(dialog).findByRole("alert")).textContent).toContain("What you were shown has changed");
  const confirm = within(dialog).getByRole("button", { name: "Press Merge" });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  fireEvent.click(confirm);
  expect(mergeCalls(f)).toHaveLength(0);
  f.close();
});

it("changedSince also reads the review digest: same head, different digest is a change", () => {
  const readiness = { mayMerge: true, ready: true, heads: [headOf(HEAD_A)], pullRequests: [{ repositoryId: "acme/payments", number: 42 }] };
  const task = (digest: string) => ({ pullRequests: [PR], mergeTracking: [{ ...tracked("open"), decisionDigest: digest }] }) as unknown as Parameters<typeof pullRowsOf>[0];
  const before = shownOf(pullRowsOf(task("b".repeat(64)), readiness), readiness);
  expect(changedSince(before, pullRowsOf(task("b".repeat(64)), readiness), readiness)).toBe(false);
  expect(changedSince(before, pullRowsOf(task("c".repeat(64)), readiness), readiness)).toBe(true);
  expect(changedSince(before, pullRowsOf(task("b".repeat(64)), { ...readiness, heads: [headOf(HEAD_B)] }), { ...readiness, heads: [headOf(HEAD_B)] })).toBe(true);
});

it("a reply that never arrives leaves the original request unresolved: Merge locks, nothing is sent again, and the page says what is safe", async () => {
  const f = setup({ pullRequests: [PR], mergeTracking: [tracked("open")] }, { readiness: ready([headOf(HEAD_A)]), press: async () => ({ status: 503, body: { error: { code: "MERGE_FAILED", message: "private provider text" } } }) });
  fireEvent.click(await screen.findByRole("button", { name: "Merge #42 into main" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Press Merge" }));
  await waitFor(() => expect(region().querySelector(".rv-merge-state")!.textContent).toBe("The result isn't confirmed yet"));
  const text = region().textContent;
  for (const words of ["What happened", "acme/payments #42 at aaaaaaa", "no reply was seen", "won't send a second one", "Nothing was deployed", "Check again only reads: it never sends the merge again", "MERGE-RESULT-UNKNOWN"]) expect(text).toContain(words);
  expect(text).not.toContain("private provider text");
  const button = screen.getByRole("button", { name: /^Merge #42/u });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(region().textContent).toContain("Locked: the result of your earlier merge isn't confirmed");
  expect(region().textContent).toContain("Result unknown");
  expect(region().textContent).not.toMatch(/Ready(?! to merge)/u);
  fireEvent.click(button);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mergeCalls(f)).toHaveLength(1);
  await expectNoAxeViolations(f.container);
  f.close();
});

it("a network failure and an unreadable pending answer are both unresolved, never a second request", async () => {
  for (const press of [async (): Promise<Answer> => { throw new Error("offline"); }, async (): Promise<Answer> => ({ status: 202, body: { status: "PENDING" } })]) {
    localStorage.clear();
    const f = setup({ pullRequests: [PR] }, { readiness: { status: 200, body: READY }, press });
    fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Press Merge" }));
    await waitFor(() => expect(region().querySelector(".rv-merge-state")!.textContent).toBe("The result isn't confirmed yet"));
    expect(screen.getByRole("button", { name: /^Merge #42/u }).hasAttribute("disabled")).toBe(true);
    expect(mergeCalls(f)).toHaveLength(1);
    f.close();
  }
});

it("a pull request GitHub shows merged is an observation: 'Merged on GitHub', never 'merged by' or 'on your request'; each pull request keeps its own facts", () => {
  const web = { ...tracked("merged"), repositoryId: "acme/web", number: 7 };
  const f = setup({ pullRequests: [PR, { repository: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7", state: "merged" }], mergeTracking: [tracked("open"), web] });
  expect(region().querySelector(".rv-merge-state")!.textContent).toBe("1 of 2 pull requests is merged on GitHub");
  const text = region().textContent;
  expect(text).toContain("Merged on GitHub");
  expect(text).toContain("it doesn't say who merged what");
  expect(text).not.toMatch(/merged by|on your request|You pressed/iu);
  expect(screen.getAllByRole("link", { name: /Open on GitHub/u })).toHaveLength(1);
  const rows = within(region()).getAllByRole("heading", { level: 3 }).map(node => node.textContent);
  expect(rows).toEqual(["acme/payments #42", "acme/web #7"]);
  f.close();
});

it("missing, failed and still-running checks are three different words, and 'none to wait for' is not a pass", () => {
  const f = setup({ pullRequests: [PR], mergeTracking: [{ ...tracked("open"), ci: "none", review: "not_requested", branch: "unknown" }] });
  expect(region().textContent).toContain("None to wait for");
  expect(region().textContent).not.toMatch(/Checks.{0,12}Passed/u);
  expect(region().textContent).toContain("Not reviewed yet");
  f.close();
  const g = setup({ pullRequests: [PR], mergeTracking: [{ ...tracked("open"), ci: "failing", failingChecks: ["integration"], approval: { githubUserId: "1", login: "sam", commitId: HEAD_B } }] });
  expect(region().textContent).toContain("Failed: integration");
  expect(region().textContent).toContain("Approved by sam on an earlier head; GitHub decides whether it still counts");
  expect(region().textContent).toContain("Blocked");
  g.close();
  const h2 = setup({ pullRequests: [PR], mergeTracking: [{ ...tracked("open"), ci: "pending" }] });
  expect(region().textContent).toContain("Still running, not in yet");
  h2.close();
});

it("a readiness read that could not answer is 'could not read', not 'not allowed': Merge stays locked and Read again asks once more", async () => {
  const f = setup({ pullRequests: [PR] }, { readiness: { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara couldn't reach Code." } } } });
  await waitFor(() => expect(region().querySelector(".rv-merge-state")!.textContent).toBe("Rovara couldn't read this from GitHub just now"));
  expect(region().textContent).toContain("not a pass and not a failure");
  expect(screen.queryByRole("button", { name: /^Merge #42/u })).toBeNull();
  const reads = () => f.request.mock.calls.filter(([request]) => /\/merge$/u.test(request.path) && request.method === "GET").length;
  const before = reads();
  fireEvent.click(screen.getByRole("button", { name: "Read again" }));
  await waitFor(() => expect(reads()).toBe(before + 1));
  expect(mergeCalls(f)).toHaveLength(0);
  expect(screen.getByRole("link", { name: /Open on GitHub: acme\/payments #42/u })).toBeTruthy();
  await expectNoAxeViolations(f.container);
  f.close();
});

it("keyboard and route: the confirmation opens from the focused button, Escape returns focus to it, and nothing navigates", async () => {
  const f = setup({ pullRequests: [PR] }, { readiness: { status: 200, body: READY } });
  const where = () => f.router.state.location.pathname + f.router.state.location.search + f.router.state.location.hash;
  const start = where();
  const button = await screen.findByRole("button", { name: /^Merge #42/u });
  button.focus();
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog");
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(button));
  fireEvent.click(button);
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Not now" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(where()).toBe(start);
  expect(mergeCalls(f)).toHaveLength(0);
  f.close();
});

it("two pull requests: one authorization names both, in order, and says what happens if one is refused", async () => {
  const web = { ...tracked("open"), repositoryId: "acme/web", number: 7, headSha: HEAD_B };
  const heads = [headOf(HEAD_A), { repositoryId: "acme/web", number: 7, headSha: HEAD_B }];
  const f = setup({ pullRequests: [PR, { ...PR, repository: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7" }], mergeTracking: [tracked("open"), web] }, { readiness: ready(heads) });
  fireEvent.click(await screen.findByRole("button", { name: "Merge 2 pull requests" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getAllByRole("listitem").map(item => item.textContent)).toEqual(["acme/payments #42 at aaaaaaa", "acme/web #7 at bbbbbbb"]);
  expect(dialog.textContent).toContain("If one is refused, the ones after it are not tried");
  await expectNoAxeViolations(document.body);
  f.close();
});
