// @vitest-environment jsdom
// Experience lane exp/continue-loop: the continue-loop server features on the task page and in the "Continue in your own tool" panel (feat/0515-continue-loop): the branch from `continueLoop`,
// Publish working branch, "Changed outside Rovara · checks needed" with Last pushed by, and Recheck (only where the server sets canRecheck).
import { afterEach, expect, it, vi } from "vitest";
import { act, screen, within, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { CHANGED_OUTSIDE_LABEL, OUTSIDE_RECHECK_WORKER_MISSING, PUBLISHED_BRANCH_NOTE, RECHECK_NEEDS_PULL_REQUEST_NOTE, type SessionView } from "@agentx/cloud-contracts/web";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { CONTINUE_STORAGE_KEY } from "../../packages/ui/src/screens/session/continue-flags.js";
import { NO_BRANCH_PUBLISH, NO_BRANCH_YET, PUSH_EXPLAINER, PUSH_EXPLAINER_RECHECK, RECHECK_UNAVAILABLE, continueOffer, loadPrompt, pushExplainer } from "../../packages/ui/src/screens/session/continue-in-tool.js";
import { agoShort, pushedByWords } from "../../packages/ui/src/screens/session/continue-outside.js";
import { leadStatus, plainState, taskLead } from "../../packages/ui/src/screens/session/task-plain-state.js";
import { forceTaskPageFlags } from "../../packages/ui/src/screens/session/task-page-flags.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

afterEach(() => { vi.unstubAllGlobals();vi.useRealTimers();forceTaskPageFlags(undefined); });
const TASK = "11111111-1111-4111-8111-111111111111", BRANCH = "agentx/" + TASK, HEAD = "b".repeat(40), BASE = "a".repeat(40);
const UUID: unknown = expect.stringMatching(/^[0-9a-f-]{36}$/u);
const PUBLISH_PATH = "/v1/app/tasks/" + TASK + "/continue/publish-branch", RECHECK_PATH = "/v1/app/tasks/" + TASK + "/continue/recheck";
type Loop = Record<string, unknown>;
const loopOf = (over: Loop = {}): Loop => ({ branches: [], outside: [], canPublishBranch: false, canRecheck: false, ...over });
const outsideRow = (over: Loop = {}) => ({ repository: "demo", number: 7, headSha: HEAD, lastPushedBy: { login: "octocat", at: new Date(Date.now() - 5 * 60_000).toISOString() }, canRecheck: false, ...over });
const prBranch = { repository: "demo", branch: BRANCH, source: "pull_request", headSha: BASE, pullRequest: { number: 7, url: "https://github.com/acme/demo/pull/7" } };
/** A task with no pull request yet, carrying the continue loop. */
const publishable = [{ repository: "demo", baseSha: BASE }];
const session = (loop: Loop | undefined, over: { pullRequests?: unknown; display?: unknown; you?: Partial<SessionView["you"]> } = {}) => {
 const base = workspaceFixture({ ...(over.display === undefined ? {} : { display: over.display } ) } as never, {
  pullRequests: over.pullRequests ?? undefined, ...(loop === undefined ? {} : { continueLoop: loop }),
  workflow: workspaceWorkflow(),
 });
 return over.you === undefined ? base : { ...base, you: { ...base.you, ...over.you } } as typeof base;
};
interface Options { on?: boolean; api?: (request: ApiRequest) => ApiResponse | undefined; lead?: boolean }
function setup(source: SessionView | (() => SessionView), options: Options = {}) {
 let reads = 0;
 const current = () => typeof source === "function" ? source() : source, view = current();
 const f = fakeHost(async request => {
  const path = request.path.split("?", 1)[0]!, custom = options.api?.(request);
  if (custom !== undefined) return custom;
  if (path.endsWith("/lessons/local-tools")) return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  if (path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
  if (path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: view.viewingNow } };
  reads += 1;
  return { status: 200, body: { session: current() } };
 });
 if (options.on !== false) f.storage.set(CONTINUE_STORAGE_KEY, "v2");
 if (options.lead === true) forceTaskPageFlags({ leadingHeader: true });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, reads: () => reads, calls: (path: string) => f.request.mock.calls.map(([request]) => request).filter(request => request.path === path), close() { ui.unmount();router.dispose();query.clear(); } };
}
const open = async () => { await userEvent.click(await screen.findByRole("button", { name: "Continue in your own tool" }));return screen.findByRole("dialog", { name: "Continue in your own tool" }); };
const prompt = (dialog: HTMLElement) => within(dialog).getByLabelText("Prompt to paste into your tool").textContent;
const error = (code: string, message: string, status = 400): ApiResponse => ({ status, body: { error: { code, message } } });

// ---- 1. the branch, from the new field

it("shows the branch from continueLoop before any pull request exists, and puts it in the prompt", async () => {
 const f = setup(session(loopOf({ branches: [{ repository: "demo", branch: BRANCH, source: "published", headSha: BASE }] })));
 const dialog = await open();
 expect(within(dialog).getByText(BRANCH)).toBeTruthy();
 expect(dialog.textContent).toContain("made by Rovara, no pull request yet");
 expect(dialog.textContent).not.toContain(NO_BRANCH_YET);expect(dialog.textContent).not.toContain("Its page names the branch");
 expect(prompt(dialog)).toBe(loadPrompt({ taskId: TASK, branch: BRANCH }));
 expect(prompt(dialog)).toContain("on branch " + BRANCH + ".");
 f.close();
});
it("a pull request's own branch shows with its link, and no longer says its page names the branch", async () => {
 const f = setup(session(loopOf({ branches: [prBranch] }), { pullRequests: [{ repository: "demo", number: 7, url: "https://github.com/acme/demo/pull/7", state: "open" }] }));
 const dialog = await open();
 expect(within(dialog).getByText(BRANCH)).toBeTruthy();
 expect(within(dialog).getByRole("link", { name: "demo #7" }).getAttribute("href")).toBe("https://github.com/acme/demo/pull/7");
 expect(dialog.textContent).not.toContain("Its page names the branch");
 f.close();
});
it("two repositories with different branches: each is listed with its name, and the prompt names each", async () => {
 const other = "agentx/22222222-2222-4222-8222-222222222222";
 const f = setup(session(loopOf({ branches: [{ repository: "demo", branch: BRANCH, source: "published" }, { repository: "api", branch: other, source: "published" }] })));
 const dialog = await open();
 expect(within(dialog).getByText(BRANCH)).toBeTruthy();expect(within(dialog).getByText(other)).toBeTruthy();
 expect(prompt(dialog)).toContain("on these branches: demo: " + BRANCH + ", api: " + other + ".");
 expect(loadPrompt({ taskId: TASK, branch: undefined, branches: [{ repository: "x; rm -rf /", branch: BRANCH }, { repository: "api", branch: other }] })).not.toContain("rm -rf");
 f.close();
});
it("a server with no continueLoop reads as before: the run's branch, or when it appears", async () => {
 const f = setup(session(undefined));
 const dialog = await open();
 expect(dialog.textContent).toContain(NO_BRANCH_YET);expect(within(dialog).queryByRole("button", { name: /Publish working branch/u })).toBeNull();
 expect(continueOffer(session(undefined))?.loop).toBeUndefined();
 f.close();
});

// ---- 2. publish working branch

it("offers Publish working branch where the server allows it; one press sends the repository once, then shows the branch and puts it in the prompt", async () => {
 const f = setup(session(loopOf({ canPublishBranch: true, publishable })), { api: request => request.path === PUBLISH_PATH ? { status: 200, body: { repository: "demo", branch: BRANCH, commit: BASE, created: true } } : undefined });
 const dialog = await open();
 expect(dialog.textContent).toContain(NO_BRANCH_PUBLISH);expect(prompt(dialog)).not.toContain("branch");
 const readsBefore = f.reads();
 await userEvent.click(within(dialog).getByRole("button", { name: "Publish working branch" }));
 await within(dialog).findByText(BRANCH);
 const calls = f.calls(PUBLISH_PATH);
 expect(calls).toHaveLength(1);
 expect(calls[0]!.method).toBe("POST");
 expect(calls[0]!.body).toEqual({ requestId: UUID, repository: "demo" });
 expect(within(dialog).queryByRole("button", { name: "Publish working branch" })).toBeNull();
 expect(prompt(dialog)).toContain("on branch " + BRANCH + ".");
 // The task view is read again, so the branch is the server's from then on.
 await waitFor(() => expect(f.reads()).toBeGreaterThan(readsBefore));
 f.close();
});
it("no Publish button when the server does not allow it (a reader who may not), and none for a repository that has a branch", async () => {
 const f = setup(session(loopOf({ canPublishBranch: false }), { you: { owner: false, actions: ["watch", "comment", "steer"] } }));
 const dialog = await open();
 expect(within(dialog).queryByRole("button", { name: /Publish working branch/u })).toBeNull();
 expect(dialog.textContent).toContain(NO_BRANCH_YET);
 f.close();
 const g = setup(session(loopOf({ canPublishBranch: true, publishable, branches: [prBranch] })));
 const second = await open();
 expect(within(second).queryByRole("button", { name: /Publish working branch/u })).toBeNull();
 g.close();
});
it("Publish is driven by publishable only: a flag with no listed repository, or a repository not listed, gets no button", async () => {
 const f = setup(session(loopOf({ canPublishBranch: true })));
 const dialog = await open();
 expect(within(dialog).queryByRole("button", { name: /Publish working branch/u })).toBeNull();
 f.close();
 const g = setup(session(loopOf({ canPublishBranch: true, publishable: [{ repository: "api", baseSha: BASE }] }), { pullRequests: [{ repository: "demo", number: 7, url: "https://github.com/acme/demo/pull/7", state: "open" }] }));
 const second = await open();
 expect(within(second).getByRole("button", { name: "Publish working branch in api" })).toBeTruthy();
 expect(within(second).queryByRole("button", { name: "Publish working branch in demo" })).toBeNull();
 g.close();
});
it("a refusal shows the server's sentence word for word, and the next press is a new request", async () => {
 const words = "A branch with that name already exists in the repository and is not at the task's base commit. Rovara won't change it.";
 const f = setup(session(loopOf({ canPublishBranch: true, publishable })), { api: request => request.path === PUBLISH_PATH ? error("CONFIG_INVALID", words) : undefined });
 const dialog = await open();
 await userEvent.click(within(dialog).getByRole("button", { name: "Publish working branch" }));
 expect((await within(dialog).findByRole("alert")).textContent).toBe(words);
 expect(within(dialog).getByRole("button", { name: "Publish working branch" })).toBeTruthy();
 await userEvent.click(within(dialog).getByRole("button", { name: "Publish working branch" }));
 await waitFor(() => expect(f.calls(PUBLISH_PATH)).toHaveLength(2));
 const [one, two] = f.calls(PUBLISH_PATH);
 expect((one!.body as { requestId: string }).requestId).not.toBe((two!.body as { requestId: string }).requestId);
 f.close();
});
it("REAUTH_REQUIRED offers Sign in again, which goes to the host's sign-in", async () => {
 const f = setup(session(loopOf({ canPublishBranch: true, publishable })), { api: request => request.path === PUBLISH_PATH ? error("REAUTH_REQUIRED", "Sign in again to do this.", 401) : undefined });
 const dialog = await open();
 await userEvent.click(within(dialog).getByRole("button", { name: "Publish working branch" }));
 expect((await within(dialog).findByRole("alert")).textContent).toBe("Sign in again to do this.");
 await userEvent.click(within(dialog).getByRole("button", { name: "Sign in again" }));
 expect(f.host.signIn).toHaveBeenCalledWith("/app/live");
 f.close();
});

// ---- 3. changed outside Rovara

it("the task page's plain state reads Changed outside Rovara · checks needed (the outside-change chip), with Last pushed by", async () => {
 const f = setup(session(loopOf({ label: CHANGED_OUTSIDE_LABEL, outside: [outsideRow()] }), { display: { state: "ready_to_merge" } }), { lead: true });
 const lead = await screen.findByRole("region", { name: "Where this task stands" });
 const chip = within(lead).getByText(CHANGED_OUTSIDE_LABEL);
 expect(chip.className).toContain("rv-chip-outside-change");
 expect(chip.querySelector("svg")).toBeTruthy();
 expect(lead.getAttribute("data-tone")).toBe("info");
 expect(within(lead).getByText("Last pushed by octocat 5m ago")).toBeTruthy();
 expect(within(lead).queryByText("Ready to merge")).toBeNull();
 expect(lead.textContent).toContain("Check the new code yourself before it merges");
 f.close();
});
it("switch off: the task page's lead is exactly as before, with no chip, no Last pushed by and the ordinary state, whatever the task view says", async () => {
 const f = setup(session(loopOf({ label: CHANGED_OUTSIDE_LABEL, outside: [outsideRow()] }), { display: { state: "ready_to_merge" } }), { lead: true, on: false });
 const lead = await screen.findByRole("region", { name: "Where this task stands" });
 expect(within(lead).getAllByText("Ready to merge").length).toBeGreaterThan(0);
 expect(lead.textContent).not.toContain(CHANGED_OUTSIDE_LABEL);expect(lead.textContent).not.toContain("Last pushed by");
 expect(lead.querySelector(".rv-chip")).toBeNull();expect(lead.getAttribute("data-tone")).toBe("success");
 f.close();
});
it("the lead's Last pushed by ages while the page stays open", async () => {
 vi.useFakeTimers({ shouldAdvanceTime: true });
 const f = setup(session(loopOf({ label: CHANGED_OUTSIDE_LABEL, outside: [outsideRow({ lastPushedBy: { login: "octocat", at: new Date(Date.now() - 20_000).toISOString() } })] }), { display: { state: "ready_to_merge" } }), { lead: true });
 const lead = await screen.findByRole("region", { name: "Where this task stands" });
 expect(within(lead).getByText("Last pushed by octocat just now")).toBeTruthy();
 await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60_000); });
 await waitFor(() => expect(within(lead).getByText("Last pushed by octocat 6m ago")).toBeTruthy());
 f.close();
});
it("says someone outside Rovara where the host named nobody, and tells rows apart with their place when there are several", () => {
 const now = Date.parse("2026-11-11T12:00:00.000Z");
 expect(pushedByWords(outsideRow({ lastPushedBy: undefined }) as never, now, false)).toBe("Last pushed by someone outside Rovara");
 expect(pushedByWords(outsideRow({ lastPushedBy: { login: "octocat", at: "2026-11-11T09:30:00.000Z" } }) as never, now, true)).toBe("demo #7: Last pushed by octocat 2h ago");
 expect(pushedByWords(outsideRow({ number: undefined, lastPushedBy: { login: "octocat[bot]", at: "2026-11-08T12:00:00.000Z" } }) as never, now, true)).toBe("demo: Last pushed by octocat[bot] 3d ago");
 expect(agoShort("not a time", now)).toBeUndefined();expect(agoShort("2026-11-11T12:00:30.000Z", now)).toBe("just now");
});
it("the state is the server's words word for word, tone info; merged and closed work are never called changed outside; nothing outside leaves every state as it was", () => {
 const task = (loop: Loop | undefined) => ({ continueLoop: loop }) as never, outside = loopOf({ outside: [outsideRow()] });
 expect(CHANGED_OUTSIDE_LABEL).toBe("Changed outside Rovara · checks needed");
 expect(plainState({ state: "ready_to_merge" }, task(outside))).toEqual({ label: CHANGED_OUTSIDE_LABEL, tone: "info" });
 expect(plainState({ state: "checking" }, task(outside)).label).toBe(CHANGED_OUTSIDE_LABEL);
 for (const state of ["merged", "closed", "failed"]) expect(plainState({ state }, task(outside)).label, state).not.toBe(CHANGED_OUTSIDE_LABEL);
 expect(plainState({ state: "ready_to_merge" }, task(loopOf())).label).toBe("Ready to merge");
 expect(plainState({ state: "ready_to_merge" }, task(undefined)).label).toBe("Ready to merge");
 const lead = taskLead({ session: session(outside), task: task(outside), status: leadStatus(session(outside)), cards: [], now: Date.now() });
 expect(lead.outside?.label).toBe(CHANGED_OUTSIDE_LABEL);expect(lead.outside?.lines).toEqual(["Last pushed by octocat 5m ago"]);
 const none = taskLead({ session: session(loopOf()), task: task(loopOf()), status: { state: "ready_to_merge" }, cards: [] });
 expect(none.outside).toBeUndefined();
});
it("the panel shows the same chip and the Last pushed by line", async () => {
 const f = setup(session(loopOf({ label: CHANGED_OUTSIDE_LABEL, outside: [outsideRow()] })));
 const dialog = await open();
 const region = within(dialog).getByLabelText(CHANGED_OUTSIDE_LABEL);
 expect(within(region).getByText(CHANGED_OUTSIDE_LABEL).className).toContain("rv-chip-outside-change");
 expect(within(region).getByText("Last pushed by octocat 5m ago")).toBeTruthy();
 f.close();
 const g = setup(session(loopOf()));
 const quiet = await open();
 expect(within(quiet).queryByLabelText(CHANGED_OUTSIDE_LABEL)).toBeNull();
 g.close();
});

it("the panel's Last pushed by ages while the sheet stays open, and the group has a role for its label", async () => {
 vi.useFakeTimers({ shouldAdvanceTime: true });
 const f = setup(session(loopOf({ label: CHANGED_OUTSIDE_LABEL, outside: [outsideRow({ lastPushedBy: { login: "octocat", at: new Date(Date.now() - 20_000).toISOString() } })] })));
 const dialog = await open();
 const group = within(dialog).getByRole("group", { name: CHANGED_OUTSIDE_LABEL });
 expect(within(group).getByText("Last pushed by octocat just now")).toBeTruthy();
 await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60_000); });
 await waitFor(() => expect(within(group).getByText("Last pushed by octocat 6m ago")).toBeTruthy());
 f.close();
});

// ---- 4. Recheck

it("Recheck is hidden while canRecheck is false (the top flag and the row's own), and nothing is sent", async () => {
 for (const loop of [loopOf({ outside: [outsideRow()] }), loopOf({ canRecheck: false, outside: [outsideRow({ canRecheck: true })] }), loopOf({ canRecheck: true, outside: [outsideRow({ canRecheck: false })] }), loopOf({ canRecheck: true, outside: [outsideRow({ canRecheck: true, number: undefined })] })]) {
  const f = setup(session(loop));
  const dialog = await open();
  expect(within(dialog).queryByRole("button", { name: /Recheck/u })).toBeNull();
  expect(f.request.mock.calls.some(([request]) => request.path === RECHECK_PATH)).toBe(false);
  f.close();
 }
});
it("Recheck shows when the server sets canRecheck and sends the head the person saw, once; then the server's own row says Re-checking, with no button", async () => {
 let started = false;
 const f = setup(() => session(started ? loopOf({ canRecheck: false, outside: [outsideRow({ rechecking: true })] }) : loopOf({ canRecheck: true, outside: [outsideRow({ canRecheck: true })] })), { api: request => { if (request.path !== RECHECK_PATH) return undefined;started = true;return { status: 200, body: { status: "started" } }; } });
 const dialog = await open();
 await userEvent.click(within(dialog).getByRole("button", { name: "Recheck demo #7" }));
 await within(dialog).findByText("Re-checking");
 const calls = f.calls(RECHECK_PATH);
 expect(calls).toHaveLength(1);
 expect(calls[0]!.body).toEqual({ requestId: UUID, repository: "demo", number: 7, headSha: HEAD });
 expect(within(dialog).queryByRole("button", { name: /Recheck/u })).toBeNull();
 f.close();
});
it("Re-checking comes from the row alone: a row with rechecking shows it and no button even where canRecheck is true; its lead says so", async () => {
 const loop = loopOf({ label: CHANGED_OUTSIDE_LABEL, canRecheck: true, outside: [outsideRow({ canRecheck: true, rechecking: true })] });
 const f = setup(session(loop, { display: { state: "ready_to_merge" } }), { lead: true });
 const lead = await screen.findByRole("region", { name: "Where this task stands" });
 expect(lead.textContent).toContain("Rovara is re-checking the new code");
 const dialog = await open();
 expect(within(dialog).getByText("Re-checking")).toBeTruthy();
 expect(within(dialog).queryByRole("button", { name: /Recheck/u })).toBeNull();
 f.close();
});
it("a published branch's row shows the server's recheckNote word for word, and its branch shows publishedBranchNote; the push words do not say commits show up on a pull request", async () => {
 const f = setup(session(loopOf({ label: CHANGED_OUTSIDE_LABEL, publishedBranchNote: PUBLISHED_BRANCH_NOTE, branches: [{ repository: "demo", branch: BRANCH, source: "published", headSha: BASE }], outside: [outsideRow({ number: undefined, recheckNote: RECHECK_NEEDS_PULL_REQUEST_NOTE })] })));
 const dialog = await open();
 expect(within(dialog).getByText(RECHECK_NEEDS_PULL_REQUEST_NOTE)).toBeTruthy();
 expect(within(dialog).getByText(PUBLISHED_BRANCH_NOTE)).toBeTruthy();
 expect(within(dialog).queryByRole("button", { name: /Recheck/u })).toBeNull();
 const push = within(dialog).getByRole("region", { name: "When you push" });
 expect(push.textContent).not.toContain("show up on its pull request");
 expect(push.textContent).toContain(pushExplainer(loopOf() as never, true));
 f.close();
 // Without a published branch the pull-request sentence stays.
 const g = setup(session(loopOf({ branches: [prBranch] })));
 const second = await open();
 expect(within(second).getByRole("region", { name: "When you push" }).textContent).toContain("show up on its pull request");
 expect(within(second).queryByText(PUBLISHED_BRANCH_NOTE)).toBeNull();
 g.close();
});
it("a branch published a moment ago shows the note before the task is read again, and the push words drop the pull-request sentence", async () => {
 const f = setup(session(loopOf({ canPublishBranch: true, publishable })), { api: request => request.path === PUBLISH_PATH ? { status: 200, body: { repository: "demo", branch: BRANCH, commit: BASE, created: true } } : undefined });
 const dialog = await open();
 await userEvent.click(within(dialog).getByRole("button", { name: "Publish working branch" }));
 await within(dialog).findByText(PUBLISHED_BRANCH_NOTE);
 expect(within(dialog).getByRole("region", { name: "When you push" }).textContent).not.toContain("show up on its pull request");
 f.close();
});
it("a 503 says the server's own sentence, is asked once (no retry loop) and the button stays off", async () => {
 vi.useFakeTimers({ shouldAdvanceTime: true });
 const words = OUTSIDE_RECHECK_WORKER_MISSING;
 const f = setup(session(loopOf({ canRecheck: true, outside: [outsideRow({ canRecheck: true })] })), { api: request => request.path === RECHECK_PATH ? error("RUNTIME_UNAVAILABLE", words, 503) : undefined });
 const dialog = await open();
 await userEvent.click(within(dialog).getByRole("button", { name: "Recheck demo #7" }));
 expect((await within(dialog).findByRole("alert")).textContent).toBe(words);
 await vi.advanceTimersByTimeAsync(30_000);
 expect(f.calls(RECHECK_PATH)).toHaveLength(1);
 const button = within(dialog).getByRole("button", { name: "Recheck demo #7" });
 expect(button.getAttribute("aria-disabled")).toBe("true");expect(button).toHaveProperty("disabled", false);
 // A press while it is off sends nothing, and the button can still be focused.
 button.focus();expect(document.activeElement).toBe(button);
 await userEvent.click(button);expect(f.calls(RECHECK_PATH)).toHaveLength(1);
 f.close();
});
it("a 503 with no readable body says Recheck isn't available yet", async () => {
 const f = setup(session(loopOf({ canRecheck: true, outside: [outsideRow({ canRecheck: true })] })), { api: request => request.path === RECHECK_PATH ? { status: 503, body: "<html>bad gateway</html>" } : undefined });
 const dialog = await open();
 await userEvent.click(within(dialog).getByRole("button", { name: "Recheck demo #7" }));
 expect((await within(dialog).findByRole("alert")).textContent).toBe(RECHECK_UNAVAILABLE);
 expect(RECHECK_UNAVAILABLE).toBe("Recheck isn't available yet");
 f.close();
});
it("a refusal because the head moved shows the server's sentence, reads the task again, and keeps the sentence when the row comes back with the new head", async () => {
 const words = "The pull request changed again since you looked. Reload and check the new code.", NEW = "c".repeat(40);
 let moved = false;
 const f = setup(() => session(loopOf({ canRecheck: true, outside: [outsideRow({ canRecheck: true, headSha: moved ? NEW : HEAD })] })), { api: request => { if (request.path !== RECHECK_PATH) return undefined;moved = true;return error("STALE_FENCE", words, 409); } });
 const dialog = await open();
 const before = f.reads();
 await userEvent.click(within(dialog).getByRole("button", { name: "Recheck demo #7" }));
 await waitFor(() => expect(f.reads()).toBeGreaterThan(before));
 // The row was read again with the new head, and the same component still shows the refusal.
 expect((await within(dialog).findByRole("alert")).textContent).toBe(words);
 expect(within(dialog).getByRole("button", { name: "Recheck demo #7" }).getAttribute("aria-disabled")).toBeNull();
 // The next press is for the head the page now has.
 await userEvent.click(within(dialog).getByRole("button", { name: "Recheck demo #7" }));
 await waitFor(() => expect(f.calls(RECHECK_PATH)).toHaveLength(2));
 expect((f.calls(RECHECK_PATH)[1]!.body as { headSha: string }).headSha).toBe(NEW);
 f.close();
});

// ---- 5. the push explanation

it("the push wording keeps the honest sentence while canRecheck is false, and says what Rovara does once it is true", async () => {
 expect(pushExplainer(undefined)).toBe(PUSH_EXPLAINER);
 expect(pushExplainer(loopOf() as never)).toBe(PUSH_EXPLAINER);
 expect(pushExplainer(loopOf({ canRecheck: true }) as never)).toBe(PUSH_EXPLAINER_RECHECK);
 expect(PUSH_EXPLAINER_RECHECK).toContain("Rovara will mark the work 'Changed outside Rovara · checks needed'; press Recheck when you're ready.");
 expect(PUSH_EXPLAINER_RECHECK).not.toContain("doesn't re-run");
 const off = setup(session(loopOf()));
 let dialog = await open();
 expect(dialog.textContent).toContain(PUSH_EXPLAINER);expect(dialog.textContent).not.toContain("press Recheck");
 off.close();
 const on = setup(session(loopOf({ canRecheck: true, outside: [outsideRow({ canRecheck: true })] })));
 dialog = await open();
 expect(dialog.textContent).toContain("Rovara will mark the work 'Changed outside Rovara · checks needed'; press Recheck when you're ready.");
 expect(dialog.textContent).not.toContain("doesn't re-run its checks");
 on.close();
});

// ---- 6. off state and access

it("switch off: no button, no panel, no continue request, whatever the task view says", async () => {
 const f = setup(session(loopOf({ canPublishBranch: true, canRecheck: true, branches: [prBranch], outside: [outsideRow({ canRecheck: true })] })), { on: false });
 await screen.findByRole("button", { name: "Conversation" });
 expect(screen.queryByRole("button", { name: /Continue in your own tool/u })).toBeNull();
 expect(f.request.mock.calls.some(([request]) => request.path.includes("/continue/"))).toBe(false);
 f.close();
});
it("a reader who may only steer sees the panel, the chip and the line, but neither button (the server sends both flags false)", async () => {
 const f = setup(session(loopOf({ outside: [outsideRow()], branches: [] }), { you: { owner: false, actions: ["watch", "comment", "steer"] } }));
 const dialog = await open();
 expect(within(dialog).getByText("Last pushed by octocat 5m ago")).toBeTruthy();
 expect(within(dialog).queryByRole("button", { name: /Recheck|Publish/u })).toBeNull();
 f.close();
});
it("axe finds nothing with the branch row, Publish, the chip and Recheck all showing", async () => {
 const f = setup(session(loopOf({ canPublishBranch: true, publishable, canRecheck: true, label: CHANGED_OUTSIDE_LABEL, outside: [outsideRow({ canRecheck: true })] })));
 const dialog = await open();
 expect(within(dialog).getByRole("button", { name: "Publish working branch" })).toBeTruthy();expect(within(dialog).getByRole("button", { name: "Recheck demo #7" })).toBeTruthy();
 await expectNoAxeViolations(document.body);
 f.close();
});
