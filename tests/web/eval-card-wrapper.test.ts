// @vitest-environment jsdom
// L4-EVW4 (DEC 254zzz43): the setup flow's ONE wrapper card, "Rovara can't read the results of <eval> yet", with [View the file] [I'll add it myself] [Let Rovara open a pull request] [Not now]; the role-less view (view and copy
// only); Check now; the set-aside row. Code's sentences and file are shown as they come; the page works nothing out and never opens a pull request by itself.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { EvalCardViewSchema, EvalWrapperActionRequestSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ProjectChecklist } from "../../packages/ui/src/screens/setup/ProjectChecklist.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

afterEach(cleanup);
const ME = "a".repeat(64), NONCE_KEY = "rovara.stepup.nonce";
const TASK = "task_0123-abc", DIGEST = "ab12".repeat(16);
// Whole-number figures chosen so that no formula in the page could reproduce them by accident.
const SEEN = { perCheckHighMicros: 1_234_567, monthlyCapMicros: 41_000_000 };
const SENTENCE = "Running your evals on each AI change will cost about $0.50-$1.20 per PR, at most $41.00 a month. Approve?";
const suite = (over: Record<string, unknown> = {}) => ({ selection: "npm run evals", files: ["evals/a.yaml", "evals/b.yaml"], cases: 12, sentence: SENTENCE, perPr: "$0.50-$1.20", monthly: "$41.00", seen: SEEN, ...over });
const card = (over: Record<string, unknown> = {}) => ({ project: "web", state: "propose", canApprove: true, report: { taskId: TASK, reportDigest: DIGEST }, suites: [suite()], ...over });
const checklist = () => ({
  project: "web", viewer: { companyRole: "owner", projectAdmin: false, canSkip: true }, progress: { done: 3, total: 8, percent: 38, nextRequired: "evalConfirm" },
  repos: { state: "done", count: 1, items: [{ name: "web", fullName: "acme/web", defaultBranch: "main" }] },
  setupRun: { state: "done", status: "ready", startedAt: "2026-11-18T10:00:00.000Z", elapsedMs: 300000, costCents: 31, commandsRun: 4, commandsFound: { setup: 1, tests: 1 }, testOutcome: "passed" },
  evalConfirm: { state: "needs_you", report: "reported", suites: [{ selection: "npm run evals", questions: 12 }] },
  aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
  slackChannel: { state: "optional", channels: [] }, linear: { state: "optional", team: null }, invites: { state: "optional" }, firstTask: { state: "needs_you", hasTask: false, canStart: false },
});

interface Options { read?: () => ApiResponse; post?: (request: ApiRequest) => ApiResponse; fresh?: boolean }
function mount(options: Options = {}) {
  let current: ApiResponse = options.read?.() ?? { status: 200, body: card() };
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/projects/web/setup-status") return { status: 200, body: checklist() };
    if (request.path === "/v1/app/projects/web/setup-agent/eval" && request.method === "GET") return options.read === undefined ? current : options.read();
    if (request.path.startsWith("/v1/app/projects/web/setup-agent/eval-") && request.method === "POST") return options.post?.(request) ?? { status: 200, body: { project: "web", state: "approved", decision: "approved", requested: true, requestId: "gw" } };
    if (request.path === "/v1/app/projects/web/setup-agent") return { status: 200, body: { status: "ready", basedOnRevision: 3, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, canManage: true } };
    if (request.path.startsWith("/v1/app/projects/web/setup-agent/journal")) return { status: 200, body: { status: "ready", entries: [], hostAsks: [] } };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  });
  if (options.fresh === true) f.storage.set(NONCE_KEY, JSON.stringify({ nonce: "n-1", at: Date.now() }));
  const query = createQueryClient();
  query.setQueryData(["nav"], { me: { developerId: ME, name: "Maya", orgRole: "owner" } });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/web" + (options.fresh === true ? "?confirmed=n-1" : "")], children: h(ProjectChecklist, { project: "web" }) }) }) }), { theme: "light" });
  return { ...f, setRead(value: ApiResponse) { current = value; }, close() { ui.unmount(); query.clear(); } };
}
const posts = (f: ReturnType<typeof mount>, tail?: string) => f.request.mock.calls.map(([r]) => r).filter(r => r.method === "POST" && (tail === undefined ? r.path.includes("/setup-agent/eval-") : r.path.endsWith(`/setup-agent/${tail}`)));
const theCard = async () => screen.findByTestId("eval-card");
const FILE = "#!/usr/bin/env python3\n# Made by Rovara so it can read the results of your eval.\n# rovara-eval-wrapper-template: 1\nimport json\n";
const wrapper = (over: Record<string, unknown> = {}) => ({
  selection: "npm run evals", repository: "web", language: "python", kind: "template", path: "rovara/eval-wrapper.py", content: FILE, title: "Rovara can't read the results of npm run evals yet", step: "needs_file",
  line: "Rovara needs a small file in your repository to read this eval's results. Add it yourself, or let Rovara open a pull request for it.", offered: true, canOpenPullRequest: true, dismissed: false, ...over,
});
const NEEDS = "Rovara can't read this eval's results yet. It needs a small file in your repository. Add it yourself or let Rovara open a pull request for it; once the file is on your default branch, approve a test run.";
const unreadable = (...wrappers: Array<Record<string, unknown>>) => ({ status: 200, body: card({ suites: [suite({ readable: false, needsFile: NEEDS })], wrappers }) });
const answer = (...wrappers: Array<Record<string, unknown>>) => ({ status: 200, body: { project: "web", action: "check", wrappers } });
const click = async (c: HTMLElement, id: string) => { fireEvent.click(await within(c).findByTestId(id)); };

describe("the one card", () => {
  it("says it in Code's words with the four choices; nothing is sent until a person chooses; the eval cannot be approved yet", async () => {
    const f = mount({ read: () => unreadable(wrapper()) });
    const c = await theCard();
    expect((await within(c).findByTestId("eval-wrapper")).textContent).toContain("Rovara can't read the results of npm run evals yet");
    expect(within(c).getByTestId("eval-wrapper-line").textContent).toContain("Add it yourself, or let Rovara open a pull request for it.");
    for (const id of ["eval-wrapper-view", "eval-wrapper-add", "eval-wrapper-open", "eval-wrapper-dismiss"]) expect(within(c).getByTestId(id)).toBeTruthy();
    expect(within(c).getByTestId("eval-wrapper-open").textContent).toBe("Let Rovara open a pull request");
    expect(within(c).getByTestId("eval-wrapper-dismiss").textContent).toBe("Not now");
    expect(within(c).getByTestId("eval-needs-file").textContent).toBe(NEEDS);
    expect(within(c).queryByTestId("eval-approve")).toBeNull();
    expect(within(c).queryByTestId("eval-wrapper-file")).toBeNull();
    expect(posts(f)).toEqual([]);
  });

  it("View the file shows where it goes and its text (as text), and I'll add it myself adds Copy, Download and Check now", async () => {
    const f = mount({ read: () => unreadable(wrapper({ content: `${FILE}print("<img src=x onerror=alert(1)>")\u202E\n` })) });
    const c = await theCard();
    await click(c, "eval-wrapper-view");
    const file = within(c).getByTestId("eval-wrapper-file");
    expect(within(c).getByTestId("eval-wrapper-path").textContent).toBe("rovara/eval-wrapper.py");
    expect(file.textContent).toContain("rovara-eval-wrapper-template: 1");
    expect(file.querySelector("img")).toBeNull();
    expect(file.textContent?.toLowerCase()).toContain("[u+202e]");
    expect(within(c).queryByTestId("eval-wrapper-check")).toBeNull();
    await click(c, "eval-wrapper-add");
    expect(within(c).getByTestId("eval-wrapper-add-panel").textContent).toContain("Add this file as rovara/eval-wrapper.py on your default branch.");
    for (const id of ["eval-wrapper-copy", "eval-wrapper-download", "eval-wrapper-check"]) expect(within(c).getByTestId(id)).toBeTruthy();
    expect(posts(f)).toEqual([]);
  });

  it("Copy puts the file on the clipboard", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { written.push(text); } }, configurable: true });
    mount({ read: () => unreadable(wrapper()) });
    const c = await theCard();
    await click(c, "eval-wrapper-view");
    await click(c, "eval-wrapper-copy");
    await waitFor(() => { expect(written).toEqual([FILE]); });
  });

  it("Let Rovara open a pull request sends exactly the request id, the act and the eval; a double press sends one; it needs no fresh sign-in", async () => {
    let reads = 0;
    const f = mount({ read: () => { reads += 1; return unreadable(wrapper()); }, post: () => ({ status: 200, body: { project: "web", action: "open_pull_request", outcome: { selection: "npm run evals", state: "open", number: "12" }, wrappers: [wrapper({ step: "pull_request_open" })] } }) });
    const c = await theCard();
    const open = await within(c).findByTestId("eval-wrapper-open");
    fireEvent.click(open); fireEvent.click(open);
    await waitFor(() => { expect(posts(f, "eval-wrapper")).toHaveLength(1); });
    const sent = posts(f, "eval-wrapper")[0]!;
    expect(sent.path).toBe("/v1/app/projects/web/setup-agent/eval-wrapper");
    expect(Object.keys(sent.body as object).sort()).toEqual(["action", "requestId", "selection"]);
    expect(sent.body).toMatchObject({ action: "open_pull_request", selection: "npm run evals" });
    expect((sent.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/u);
    await waitFor(() => { expect(reads).toBeGreaterThan(1); });
  });

  it("Not now sends the dismiss act and nothing else; Code's refusal is shown in Code's own words", async () => {
    const f = mount({ read: () => unreadable(wrapper()), post: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only a company owner, admin or project maintainer can ask Rovara to open a pull request." } } }) });
    const c = await theCard();
    await click(c, "eval-wrapper-dismiss");
    await waitFor(() => { expect(posts(f, "eval-wrapper")).toHaveLength(1); });
    expect(posts(f, "eval-wrapper")[0]!.body).toMatchObject({ action: "dismiss" });
    expect(Object.keys(posts(f, "eval-wrapper")[0]!.body as object).sort()).toEqual(["action", "requestId"]);
    expect((await within(c).findByTestId("eval-wrapper-problem")).textContent).toContain("Only a company owner, admin or project maintainer can ask Rovara to open a pull request.");
  });
});

describe("a person who may only look (the role-less view)", () => {
  it("sees the title, the file and Copy, has no pull request and no Not now, is told who can, and can still Check now", async () => {
    const f = mount({ read: () => ({ status: 200, body: card({ canApprove: false, suites: [suite({ readable: false, needsFile: NEEDS })], wrappers: [wrapper({ canOpenPullRequest: false })] }) }), post: () => answer(wrapper({ canOpenPullRequest: false })) });
    const c = await theCard();
    await click(c, "eval-wrapper-view");
    expect(within(c).getByTestId("eval-wrapper-file").textContent).toContain("rovara-eval-wrapper-template: 1");
    expect(within(c).getByTestId("eval-wrapper-copy")).toBeTruthy();
    for (const id of ["eval-wrapper-open", "eval-wrapper-dismiss", "eval-wrapper-reopen", "eval-approve"]) expect(within(c).queryByTestId(id)).toBeNull();
    expect(within(c).getByTestId("eval-wrapper-who").textContent).toContain("A company owner, admin or this project's maintainer");
    await click(c, "eval-wrapper-add");
    await click(c, "eval-wrapper-check");
    await waitFor(() => { expect(posts(f, "eval-wrapper")).toHaveLength(1); });
    expect(posts(f, "eval-wrapper")[0]!.body).toMatchObject({ action: "check" });
  });
});

describe("where it stands", () => {
  it("a pull request that is open links to it (https only) and offers Check now; Code says the rest", async () => {
    mount({ read: () => unreadable(wrapper({ step: "pull_request_open", canOpenPullRequest: false, line: "Rovara opened PR #12 with the file. Review and merge it; Rovara notices it on your default branch by itself.", pullRequest: { state: "open", number: "12", url: "https://github.com/acme/web/pull/12" } })) });
    const c = await theCard();
    const link = (await within(c).findByTestId("eval-wrapper-link"));
    expect([link.getAttribute("href"), link.getAttribute("rel"), link.getAttribute("target")]).toEqual(["https://github.com/acme/web/pull/12", "noopener noreferrer", "_blank"]);
    expect(within(c).getByTestId("eval-wrapper-check")).toBeTruthy();
    expect(within(c).queryByTestId("eval-wrapper-open")).toBeNull();
    cleanup();
    mount({ read: () => unreadable(wrapper({ step: "pull_request_open", canOpenPullRequest: false, pullRequest: { state: "open", number: "12", url: "javascript:alert(1)" } })) });
    const bad = await theCard();
    await within(bad).findByTestId("eval-wrapper");
    expect(within(bad).queryByTestId("eval-wrapper-link")).toBeNull();
    expect(bad.innerHTML).not.toContain("javascript:");
  });

  it("an AI-written file is copy-only (Code says so); a file that was not offered shows no file; an existing or closed one says why", async () => {
    mount({ read: () => unreadable(wrapper({ kind: "custom", canOpenPullRequest: false, copyOnly: { reason: "custom", text: "A file Rovara's setup agent wrote itself is copy-only: copy it into your repository." } })) });
    const c = await theCard();
    expect((await within(c).findByTestId("eval-wrapper-copy-only")).textContent).toContain("copy-only");
    expect(within(c).queryByTestId("eval-wrapper-open")).toBeNull();
    expect(within(c).getByTestId("eval-wrapper-view")).toBeTruthy();
    cleanup();
    mount({ read: () => unreadable(wrapper({ step: "not_offered", offered: false, content: "", canOpenPullRequest: false, line: "Rovara could not check a file for this eval, so it is not offering one." })) });
    const none = await theCard();
    expect((await within(none).findByTestId("eval-wrapper-line")).textContent).toContain("not offering one");
    for (const id of ["eval-wrapper-view", "eval-wrapper-add", "eval-wrapper-open", "eval-wrapper-file"]) expect(within(none).queryByTestId(id)).toBeNull();
    expect(within(none).getByTestId("eval-wrapper-dismiss")).toBeTruthy();
  });

  it("Not now leaves a quiet row (the Evals row); a manager can Set up now, a member only sees it", async () => {
    const f = mount({ read: () => unreadable(wrapper({ step: "dismissed", dismissed: true, canOpenPullRequest: false })), post: () => answer(wrapper()) });
    const c = await theCard();
    expect((await within(c).findByTestId("eval-wrapper-dismissed")).textContent).toContain("Pull requests will say the eval was not read");
    await click(c, "eval-wrapper-reopen");
    await waitFor(() => { expect(posts(f, "eval-wrapper")[0]?.body).toMatchObject({ action: "reopen" }); });
    cleanup();
    mount({ read: () => ({ status: 200, body: card({ canApprove: false, suites: [suite({ readable: false, needsFile: NEEDS })], wrappers: [wrapper({ step: "dismissed", dismissed: true, canOpenPullRequest: false })] }) }) });
    const member = await theCard();
    await within(member).findByTestId("eval-wrapper-dismissed");
    expect(within(member).queryByTestId("eval-wrapper-reopen")).toBeNull();
  });

  it("once the file is on the default branch the eval is readable: Approve (the test run with its dollars) comes back; an older Code reads as it did", async () => {
    mount({ read: () => ({ status: 200, body: card({ suites: [suite({ readable: true })], wrappers: [wrapper({ step: "file_found", canOpenPullRequest: false, line: "The file is on your default branch. Approve a test run (its cost is shown) so Rovara can check it reads your results." })] }) }) });
    const c = await theCard();
    expect(await within(c).findByTestId("eval-approve")).toBeTruthy();
    expect(within(c).getByTestId("eval-wrapper-line").textContent).toContain("Approve a test run");
    expect(within(c).queryByTestId("eval-wrapper-open")).toBeNull();
    cleanup();
    mount();
    const old = await theCard();
    expect(await within(old).findByTestId("eval-approve")).toBeTruthy();
    expect(within(old).queryByTestId("eval-wrappers")).toBeNull();
  });

  it("has no accessibility violations with the card, its file and the set-aside row shown", async () => {
    mount({ read: () => unreadable(wrapper(), wrapper({ selection: "npm run other", step: "dismissed", dismissed: true, canOpenPullRequest: false, title: "Rovara can't read the results of npm run other yet" })) });
    const c = await theCard();
    await within(c).findAllByTestId("eval-wrapper");
    await click(c, "eval-wrapper-add");
    await expectNoAxeViolations(c);
  });
});

describe("the contract", () => {
  it("accepts Code's card with and without the wrapper fields, and refuses a step or reason that is not Code's", () => {
    expect(EvalCardViewSchema.safeParse(card({ wrappers: [wrapper()], suites: [suite({ readable: false, needsFile: NEEDS })] })).success).toBe(true);
    expect(EvalCardViewSchema.safeParse(card()).success).toBe(true);
    expect(EvalCardViewSchema.safeParse(card({ wrappers: [wrapper({ step: "weird" })] })).success).toBe(false);
    expect(EvalCardViewSchema.safeParse(card({ wrappers: [wrapper({ copyOnly: { reason: "weird", text: "x" } })] })).success).toBe(false);
  });
  it("the act is exactly a request id, one of four acts and (to open a pull request) the eval", () => {
    const requestId = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";
    expect(EvalWrapperActionRequestSchema.safeParse({ requestId, action: "check" }).success).toBe(true);
    expect(EvalWrapperActionRequestSchema.safeParse({ requestId, action: "open_pull_request", selection: "x" }).success).toBe(true);
    for (const body of [{ requestId, action: "open_pull_request" }, { requestId, action: "merge" }, { requestId, action: "check", repository: "other" }, { requestId: "x", action: "check" }, { action: "check" }]) expect(EvalWrapperActionRequestSchema.safeParse(body).success).toBe(false);
  });
});
