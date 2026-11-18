// @vitest-environment jsdom
// L4-EVW2 (DEC 254zzz20 D2): the setup flow's eval card with Rovara's proposed wrapper file: the one line ("Rovara proposed a small file so it can read your eval results: review PR #n") with a link to the pull request,
// an eval whose results Rovara cannot read yet (no Approve, Code's own words), and "Try again" for a proposal that failed. Code's sentences are shown as they come; the page works nothing out.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { EvalCardViewSchema } from "@agentx/contracts/web";
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
const LEAK = "SENSITIVE-SERVER-DETAIL";
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
const wrapper = (over: Record<string, unknown> = {}) => ({ repository: "web", language: "python", state: "open", line: "Rovara proposed a small file so it can read your eval results: review PR #12", number: "12", url: "https://github.com/acme/web/pull/12", ...over });
const NEEDS = "Rovara can't read this eval's results yet. Rovara proposed a small file so it can: review and merge that pull request, then set up again.";

describe("the proposed file", () => {
  it("shows Code's line, links to the pull request and says Rovara never merges it; the eval cannot be approved until its results are readable", async () => {
    const f = mount({ read: () => ({ status: 200, body: card({ suites: [suite({ readable: false, needsFile: NEEDS })], wrappers: [wrapper()] }) }) });
    const c = await theCard();
    const line = await within(c).findByTestId("eval-wrapper");
    expect(line.textContent).toContain("Rovara proposed a small file so it can read your eval results: review PR #12");
    const link = within(c).getByTestId("eval-wrapper-link");
    expect([link.href, link.rel, link.target]).toEqual(["https://github.com/acme/web/pull/12", "noopener noreferrer", "_blank"]);
    expect(c.textContent).toContain("Rovara never merges it");
    expect(within(c).getByTestId("eval-needs-file").textContent).toBe(NEEDS);
    expect(within(c).queryByTestId("eval-approve")).toBeNull();
    expect(within(c).queryByTestId("eval-sentence")).toBeNull();
    expect(within(c).queryByTestId("eval-fresh")).toBeNull();
    expect(posts(f)).toEqual([]);
  });

  it("links only to an https address, and shows a merged file's line without one", async () => {
    mount({ read: () => ({ status: 200, body: card({ wrappers: [wrapper({ url: "javascript:alert(1)" }), wrapper({ language: "node", state: "merged", line: "PR #12 is merged. Set up again so Rovara reads your eval through it.", url: undefined, rediscover: true })] }) }) });
    const c = await theCard();
    await within(c).findAllByTestId("eval-wrapper");
    expect(within(c).queryAllByTestId("eval-wrapper-link")).toHaveLength(0);
    expect(c.textContent).toContain("PR #12 is merged. Set up again so Rovara reads your eval through it.");
    expect(c.innerHTML).not.toContain("javascript:");
  });

  it("an eval that is readable keeps its Approve, and an older Code (no wrappers, no readable flag) reads as it did", async () => {
    mount({ read: () => ({ status: 200, body: card({ wrappers: [wrapper({ state: "merged", line: "PR #12 is merged. Set up again so Rovara reads your eval through it." })], suites: [suite({ readable: true })] }) }) });
    const c = await theCard();
    expect(await within(c).findByTestId("eval-approve")).toBeTruthy();
    cleanup();
    mount();
    const old = await theCard();
    expect(await within(old).findByTestId("eval-approve")).toBeTruthy();
    expect(within(old).queryByTestId("eval-wrappers")).toBeNull();
  });

  it("a failed proposal offers Try again to a person who may approve; it sends exactly one request id, needs no fresh sign-in, and a double press sends one", async () => {
    let reads = 0;
    const f = mount({ read: () => { reads += 1; return { status: 200, body: card({ suites: [suite({ readable: false, needsFile: NEEDS })], wrappers: [wrapper({ state: "failed", line: "The code host refused the proposed file.", url: undefined, number: undefined })] }) }; },
      post: () => ({ status: 200, body: { project: "web", proposals: [{ selection: "npm run evals", state: "open", number: "12" }] } }) });
    const c = await theCard();
    const retry = await within(c).findByTestId("eval-wrapper-retry");
    fireEvent.click(retry); fireEvent.click(retry);
    await waitFor(() => { expect(posts(f, "eval-wrapper")).toHaveLength(1); });
    const sent = posts(f, "eval-wrapper")[0]!;
    expect(sent.path).toBe("/v1/app/projects/web/setup-agent/eval-wrapper");
    expect(Object.keys(sent.body as object)).toEqual(["requestId"]);
    expect((sent.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/u);
    await waitFor(() => { expect(reads).toBeGreaterThan(1); });
  });

  it("shows no Try again to a person who may not approve, and shows Code's words when the retry is refused", async () => {
    mount({ read: () => ({ status: 200, body: card({ canApprove: false, wrappers: [wrapper({ state: "failed", line: "The code host refused the proposed file." })] }) }) });
    const c = await theCard();
    await within(c).findByTestId("eval-wrapper");
    expect(within(c).queryByTestId("eval-wrapper-retry")).toBeNull();
    cleanup();
    mount({ read: () => ({ status: 200, body: card({ wrappers: [wrapper({ state: "failed", line: "The code host refused the proposed file." })] }) }), post: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: `Only a company owner, admin or project maintainer can ask. ${LEAK}` } } }) });
    const again = await theCard();
    fireEvent.click(await within(again).findByTestId("eval-wrapper-retry"));
    const problem = await within(again).findByTestId("eval-problem");
    expect(problem.textContent).toContain("Only a company owner, admin or project maintainer can ask.");
  });

  it("has no accessibility violations with the proposal shown", async () => {
    mount({ read: () => ({ status: 200, body: card({ suites: [suite({ readable: false, needsFile: NEEDS })], wrappers: [wrapper(), wrapper({ language: "node", state: "failed", line: "The code host refused the proposed file.", url: undefined })] }) }) });
    const c = await theCard();
    await within(c).findAllByTestId("eval-wrapper");
    await expectNoAxeViolations(c);
  });

  it("the contract accepts Code's card with and without the proposal fields", () => {
    expect(EvalCardViewSchema.safeParse(card({ wrappers: [wrapper()], suites: [suite({ readable: false, needsFile: NEEDS })] })).success).toBe(true);
    expect(EvalCardViewSchema.safeParse(card()).success).toBe(true);
    expect(EvalCardViewSchema.safeParse(card({ wrappers: [wrapper({ state: "weird" })] })).success).toBe(false);
  });
});
