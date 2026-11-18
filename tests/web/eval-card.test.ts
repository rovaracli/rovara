// @vitest-environment jsdom
// L4-EVC (DEC 254zzz20 D5, D6, D8): the setup flow's ONE eval card, in plain dollars, on the checklist's "Confirm how work is checked" row. It shows what was found with Code's own sentence and ONE Approve
// (after a fresh sign-in); a changed eval set that grew past the approved dollars asks again (Approve / Not now); once approved it says what a PR costs and offers the OPT-IN health check, which is
// never sent without a click. The dollars a person saw (`seen`) are copied from the read, never worked out here. No tokens, counts or micro-dollar words reach the page. The server decides everything;
// these tests watch what the page asks and says.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { EvalCardViewSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ProjectChecklist } from "../../packages/ui/src/screens/setup/ProjectChecklist.js";
import { EVAL_CARD_WORDS, EVAL_HEALTH_POLL_MS, EVAL_HEALTH_WORDS, evalHealthPollMs } from "../../packages/ui/src/screens/setup/EvalCard.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

afterEach(cleanup);
const ME = "a".repeat(64), NONCE_KEY = "rovara.stepup.nonce";
const TASK = "task_0123-abc", DIGEST = "ab12".repeat(16), OFFER_DIGEST = "cd34".repeat(16), OFFER_ID = `eval-${"e".repeat(40)}-3`;
const LEAK = "SENSITIVE-SERVER-DETAIL";
// Whole-number figures chosen so that no formula in the page could reproduce them by accident.
const SEEN = { perCheckHighMicros: 1_234_567, monthlyCapMicros: 41_000_000 };
const SENTENCE = "Running your evals on each AI change will cost about $0.50-$1.20 per PR, at most $41.00 a month. Approve?";
const suite = (over: Record<string, unknown> = {}) => ({ selection: "npm run evals", files: ["evals/a.yaml", "evals/b.yaml"], cases: 12, sentence: SENTENCE, perPr: "$0.50-$1.20", monthly: "$41.00", seen: SEEN, ...over });
const card = (over: Record<string, unknown> = {}) => ({ project: "web", state: "propose", canApprove: true, report: { taskId: TASK, reportDigest: DIGEST }, suites: [suite()], ...over });
const offer = { requestId: OFFER_ID, revision: 3, artifactDigest: OFFER_DIGEST };
const waiting = (over: Record<string, unknown> = {}) => card({ state: "waiting", suites: [], spend: { state: "waiting", perPr: "$0.90-$2.40", monthly: "$41.00", needsApproval: "Needs approval: your eval set grew past the approved $1.20", approval: offer }, ...over });
const health = (state: "none" | "requested" | "running" | "finished" | "not_run", extra: Record<string, unknown> = {}) => ({ state, label: "Check my evals now (about $2.40)", cost: "$2.40", seenCostMicros: 2_400_777, ...extra });
const finishedResult = (over: Record<string, unknown> = {}) => ({ at: "2026-11-18T05:00:00.000Z", questionCount: 3, passedAnswers: 5, totalAnswers: 9, differing: 1, saved: true, reused: false, cases: [{ id: "refund-window", passes: 3 }, { id: "tone", passes: 2 }, { id: "leak", passes: 0 }], ...over });
const approved = (over: Record<string, unknown> = {}) => card({ state: "approved", suites: [], spend: { state: "approved", perPr: "$0.50-$1.20", monthly: "$41.00" }, health: health("none"), ...over });
const checklist = () => ({
  project: "web", viewer: { companyRole: "owner", projectAdmin: false, canSkip: true }, progress: { done: 3, total: 8, percent: 38, nextRequired: "evalConfirm" },
  repos: { state: "done", count: 1, items: [{ name: "web", fullName: "acme/web", defaultBranch: "main" }] },
  setupRun: { state: "done", status: "ready", approval: "approved", check: { status: "ready" }, startedAt: "2026-11-18T10:00:00.000Z", elapsedMs: 300000, costCents: 31, commandsRun: 4, commandsFound: { setup: 1, tests: 1 }, testOutcome: "passed" },
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
const evalReads = (f: ReturnType<typeof mount>) => f.request.mock.calls.filter(([r]) => r.method === "GET" && r.path.endsWith("/setup-agent/eval")).length;
const theCard = async () => screen.findByTestId("eval-card");
/** Everything a person or a screen reader gets from the card: its text and every accessible name and title on it. */
function readable(root: HTMLElement): string {
  const names = [...root.querySelectorAll("[aria-label],[title],[alt]")].map(node => `${node.getAttribute("aria-label") ?? ""} ${node.getAttribute("title") ?? ""} ${node.getAttribute("alt") ?? ""}`);
  return [root.textContent ?? "", root.getAttribute("aria-label") ?? "", ...names].join(" ");
}

describe("what was found (state propose)", () => {
  it("shows the suite's name and case count, Code's own dollar sentence and ONE Approve; no figure that is not in dollars", async () => {
    const f = mount();
    const c = await theCard();
    const found = within(c).getByTestId("eval-suite");
    expect(found.textContent).toContain("npm run evals");
    expect(found.textContent).toContain("12 eval cases");
    expect(within(c).getByTestId("eval-sentence").textContent).toBe(SENTENCE);
    expect(within(c).getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(c.textContent).not.toMatch(/\d{6,}/u);
    expect(posts(f)).toHaveLength(0);
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("shows Code's words for an eval set that grew past the approved dollars, or still stands inside them", async () => {
    const grew = "Needs approval: your eval set grew past the approved $4.00";
    const f = mount({ read: () => ({ status: 200, body: card({ suites: [suite({ versusApproved: { within: false, words: grew } })] }) }) });
    const c = await theCard();
    expect(within(c).getByTestId("eval-versus").textContent).toBe(grew);
    expect(within(c).getByTestId("eval-versus").getAttribute("data-within")).toBe("false");
    f.close(); cleanup();
    const still = "Still inside what you approved: no new approval needed";
    const g = mount({ read: () => ({ status: 200, body: card({ suites: [suite({ versusApproved: { within: true, words: still } })] }) }) });
    expect(within(await theCard()).getByTestId("eval-versus").textContent).toBe(still);
    g.close();
  });

  it("a person who may not approve sees no button and who does", async () => {
    const f = mount({ read: () => ({ status: 200, body: card({ canApprove: false }) }) });
    const c = await theCard();
    expect(within(c).queryByRole("button")).toBeNull();
    expect(within(c).getByTestId("eval-who").textContent).toBe(EVAL_CARD_WORDS.noOne);
    expect(within(c).getByTestId("eval-sentence").textContent).toBe(SENTENCE);
    f.close();
  });

  it("Approve without a fresh sign-in sends the person to confirm it's them, and sends nothing", async () => {
    const f = mount();
    const c = await theCard();
    expect(within(c).getByTestId("eval-fresh").textContent).toBe(EVAL_CARD_WORDS.stepUp);
    fireEvent.click(within(c).getByRole("button", { name: "Approve" }));
    expect(f.host.signIn).toHaveBeenCalledTimes(1);
    const [path, options] = (f.host.signIn as unknown as { mock: { calls: Array<[string, { stepUp?: boolean }]> } }).mock.calls[0]!;
    expect(path).toMatch(/confirmed=[0-9a-f-]{36}/u);
    expect(options).toEqual({ stepUp: true });
    expect(posts(f)).toHaveLength(0);
    f.close();
  });

  it("after the fresh sign-in, Approve posts eval-approve with the report, the files and `seen` exactly as the read sent them (never worked out here)", async () => {
    const f = mount({ fresh: true });
    const c = await theCard();
    expect(within(c).getByTestId("eval-fresh").textContent).toBe(EVAL_CARD_WORDS.stepUpDone);
    fireEvent.click(within(c).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts(f, "eval-approve")).toHaveLength(1));
    const sent = posts(f, "eval-approve")[0]!;
    expect(sent.path).toBe("/v1/app/projects/web/setup-agent/eval-approve");
    expect(sent.body).toEqual({ taskId: TASK, reportDigest: DIGEST, selection: "npm run evals", paths: ["evals/a.yaml", "evals/b.yaml"], approve: true, seen: SEEN });
    expect(sent.retry).toBe("never");
    expect(f.host.signIn).not.toHaveBeenCalled();
    f.close();
  });

  it("each suite carries its own `seen`: a second suite's Approve sends the second suite's figures", async () => {
    const other = { perCheckHighMicros: 7_654_321, monthlyCapMicros: 99_000_000 };
    const f = mount({ fresh: true, read: () => ({ status: 200, body: card({ suites: [suite(), suite({ selection: "pytest evals", files: ["evals/c.py"], cases: 1, seen: other })] }) }) });
    const c = await theCard();
    const suites = within(c).getAllByTestId("eval-suite");
    expect(suites[1]!.textContent).toContain("1 eval case");
    fireEvent.click(within(suites[1]!).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts(f, "eval-approve")).toHaveLength(1));
    expect(posts(f, "eval-approve")[0]!.body).toMatchObject({ selection: "pytest evals", paths: ["evals/c.py"], seen: other });
    f.close();
  });

  it("a second press while the answer is being read does not send a second approval", async () => {
    const f = mount({ fresh: true });
    const approve = within(await theCard()).getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    await waitFor(() => expect(posts(f, "eval-approve")).toHaveLength(1));
    await waitFor(() => expect(evalReads(f)).toBeGreaterThan(1));
    expect(posts(f, "eval-approve")).toHaveLength(1);
    f.close();
  });

  it("a sign-in the server finds too old asks again: the next press goes to the sign-in", async () => {
    const f = mount({ fresh: true, post: () => ({ status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Confirm it's you again, then try once more." } } }) });
    const c = await theCard();
    fireEvent.click(within(c).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(within(c).getByTestId("eval-fresh").textContent).toBe(EVAL_CARD_WORDS.stepUpOld));
    fireEvent.click(within(c).getByRole("button", { name: "Approve" }));
    expect(f.host.signIn).toHaveBeenCalledTimes(1);
    expect(posts(f, "eval-approve")).toHaveLength(1);
    f.close();
  });

  it("a refusal is shown as it comes; a moved eval offers a Refresh that reads the card again", async () => {
    const f = mount({ fresh: true, post: () => ({ status: 409, body: { error: { code: "CHANGE_STALE", message: "Your evals changed. Look again." } } }) });
    const c = await theCard();
    fireEvent.click(within(c).getByRole("button", { name: "Approve" }));
    const problem = await screen.findByTestId("eval-problem");
    expect(problem.textContent).toContain("Your evals changed. Look again.");
    const before = evalReads(f);
    fireEvent.click(within(problem).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(evalReads(f)).toBeGreaterThan(before));
    f.close();
    cleanup();
    const g = mount({ fresh: true, post: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only an owner approves." } } }) });
    fireEvent.click(within(await theCard()).getByRole("button", { name: "Approve" }));
    const other = await screen.findByTestId("eval-problem");
    expect(other.textContent).toContain("Only an owner approves.");
    expect(within(other).queryByRole("button", { name: "Refresh" })).toBeNull();
    g.close();
  });
});

describe("a changed eval that needs approval again (state waiting)", () => {
  it("shows Code's exact words and the dollars, with Approve and Not now for a person who may approve", async () => {
    const f = mount({ read: () => ({ status: 200, body: waiting() }) });
    const c = await theCard();
    expect(within(c).getByTestId("eval-needs-approval").textContent).toBe("Needs approval: your eval set grew past the approved $1.20");
    expect(within(c).getByTestId("eval-spend-line").textContent).toBe("About $0.90-$2.40 per PR, at most $41.00 a month.");
    expect(within(c).getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(within(c).getByRole("button", { name: "Not now" })).toBeTruthy();
    f.close();
  });

  it("Approve and Not now post eval-decide with the offer's id, revision and digest copied from the read, after a fresh sign-in", async () => {
    const f = mount({ fresh: true, read: () => ({ status: 200, body: waiting() }) });
    const c = await theCard();
    fireEvent.click(within(c).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts(f, "eval-decide")).toHaveLength(1));
    expect(posts(f, "eval-decide")[0]!.body).toEqual({ requestId: OFFER_ID, outcome: "approve", seen: { revision: 3, artifactDigest: OFFER_DIGEST } });
    expect(posts(f, "eval-decide")[0]!.retry).toBe("never");
    f.close();
    cleanup();
    const g = mount({ fresh: true, read: () => ({ status: 200, body: waiting() }) });
    fireEvent.click(within(await theCard()).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(posts(g, "eval-decide")).toHaveLength(1));
    expect(posts(g, "eval-decide")[0]!.body).toEqual({ requestId: OFFER_ID, outcome: "reject", seen: { revision: 3, artifactDigest: OFFER_DIGEST } });
    g.close();
  });

  it("without a fresh sign-in the buttons send the person to confirm, and nothing is posted; a person who may not approve gets no buttons", async () => {
    const f = mount({ read: () => ({ status: 200, body: waiting() }) });
    const c = await theCard();
    fireEvent.click(within(c).getByRole("button", { name: "Not now" }));
    expect(f.host.signIn).toHaveBeenCalledTimes(1);
    expect(posts(f)).toHaveLength(0);
    f.close();
    cleanup();
    const g = mount({ read: () => ({ status: 200, body: waiting({ canApprove: false }) }) });
    const d = await theCard();
    expect(within(d).queryByRole("button")).toBeNull();
    expect(within(d).getByTestId("eval-who").textContent).toBe(EVAL_CARD_WORDS.noOne);
    g.close();
  });

  it("an approval that needs renewing says so, and offers the buttons only when Code sent an offer", async () => {
    const f = mount({ read: () => ({ status: 200, body: waiting({ state: "renew", spend: { state: "approval needs renewing", perPr: "$0.50-$1.20", monthly: "$41.00" } }) }) });
    const c = await theCard();
    expect(c.textContent).toContain(EVAL_CARD_WORDS.renew);
    expect(within(c).queryByRole("button")).toBeNull();
    f.close();
  });
});

describe("approved", () => {
  it("says what a PR costs in dollars; says so when the cases changed inside the approved limit", async () => {
    const f = mount({ read: () => ({ status: 200, body: approved() }) });
    const c = await theCard();
    expect(within(c).getByTestId("eval-approved").textContent).toContain("Rovara runs your evals on each AI change: about $0.50-$1.20 per PR, at most $41.00 a month.");
    expect(within(c).queryByTestId("eval-carried")).toBeNull();
    f.close();
    cleanup();
    const g = mount({ read: () => ({ status: 200, body: approved({ spend: { state: "approved", perPr: "$0.50-$1.20", monthly: "$41.00", carried: true } }) }) });
    expect(within(await theCard()).getByTestId("eval-carried").textContent).toBe("Your eval cases changed and stayed inside what you approved.");
    g.close();
  });

  it("a rejected cost says the evals do not run", async () => {
    const f = mount({ read: () => ({ status: 200, body: card({ state: "rejected", suites: [], spend: { state: "rejected", perPr: "$0.50-$1.20", monthly: "$41.00" } }) }) });
    expect((await screen.findByTestId("eval-rejected")).textContent).toBe(EVAL_CARD_WORDS.rejected);
    f.close();
  });
});

describe("the opt-in health check", () => {
  it("is never sent on render, on load or after the card settles (mutant: post health on render)", async () => {
    const f = mount({ fresh: true, read: () => ({ status: 200, body: approved() }) });
    const c = await theCard();
    expect(within(c).getByRole("button", { name: "Check my evals now (about $2.40)" })).toBeTruthy();
    await waitFor(() => expect(evalReads(f)).toBeGreaterThanOrEqual(1));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(posts(f)).toHaveLength(0);
    f.close();
  });

  it("a click posts eval-health with a uuid and the cost Code showed, copied from the read", async () => {
    const f = mount({ read: () => ({ status: 200, body: approved() }) });
    fireEvent.click(await within(await theCard()).findByRole("button", { name: "Check my evals now (about $2.40)" }));
    await waitFor(() => expect(posts(f, "eval-health")).toHaveLength(1));
    const sent = posts(f, "eval-health")[0]!;
    const body = sent.body as { requestId: string; seenCostMicros: number };
    expect(Object.keys(body).sort()).toEqual(["requestId", "seenCostMicros"]);
    expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(body.seenCostMicros).toBe(2_400_777);
    expect(sent.retry).toBe("never");
    expect(f.host.signIn).not.toHaveBeenCalled();
    f.close();
  });

  it("a press that failed and is pressed again repeats the same request id (Code keeps one request per id)", async () => {
    let attempt = 0;
    const f = mount({ read: () => ({ status: 200, body: approved() }), post: () => (++attempt === 1 ? { status: 400, body: { error: { code: "CONFIG_INVALID", message: "try again" } } } : { status: 200, body: { project: "web", requested: true, duplicate: false, cost: "$2.40" } }) });
    const button = await within(await theCard()).findByRole("button", { name: "Check my evals now (about $2.40)" });
    fireEvent.click(button);
    await waitFor(() => expect(posts(f, "eval-health")).toHaveLength(1));
    await screen.findByTestId("eval-problem");
    fireEvent.click(await within(await theCard()).findByRole("button", { name: "Check my evals now (about $2.40)" }));
    await waitFor(() => expect(posts(f, "eval-health")).toHaveLength(2));
    const ids = posts(f, "eval-health").map(r => (r.body as { requestId: string }).requestId);
    expect(ids[0]).toBe(ids[1]);
    f.close();
  });

  it("is shown only to a person who may approve, and says the check is queued or ran", async () => {
    const f = mount({ read: () => ({ status: 200, body: approved({ canApprove: false }) }) });
    const c = await theCard();
    expect(within(c).queryByRole("button")).toBeNull();
    expect(within(c).queryByTestId("eval-health-state")).toBeNull();
    f.close();
    cleanup();
    const g = mount({ read: () => ({ status: 200, body: approved({ health: health("requested") }) }) });
    const queued = await theCard();
    expect(within(queued).getByTestId("eval-health-state").textContent).toBe("Your eval check is queued");
    expect(within(queued).queryByRole("button")).toBeNull();
    g.close();
    cleanup();
    const k = mount({ read: () => ({ status: 200, body: approved({ health: health("finished"), canApprove: false }) }) });
    expect((await within(await theCard()).findByTestId("eval-health-state")).textContent).toBe("Your eval check ran");
    k.close();
  });
});

describe("the health check's answer (L4-EVH)", () => {
  it("a check that is running says so, with no button, and the card reads again by itself", async () => {
    const f = mount({ read: () => ({ status: 200, body: approved({ health: health("running") }) }) });
    const c = await theCard();
    expect(within(c).getByTestId("eval-health-state").textContent).toBe("Your eval check is running");
    expect(within(c).queryByRole("button")).toBeNull();
    f.close();
  });
  it("a finished check tells pass or fail per case, how many answers passed and which cases differed; never an answer", async () => {
    const f = mount({ read: () => ({ status: 200, body: approved({ health: health("finished", { result: finishedResult() }) }) }) });
    const c = await theCard();
    expect(within(c).getByTestId("eval-health-state").textContent).toBe("Your eval check ran");
    expect(within(c).getByTestId("eval-health-summary").textContent).toBe("Checked 3 eval cases: 5 of 9 answers passed.");
    expect(within(c).getByTestId("eval-health-differing").textContent).toBe("1 eval case gave different answers on different runs.");
    expect([...within(c).getByTestId("eval-health-cases").querySelectorAll("li")].map(li => li.textContent)).toEqual(["refund-window: Passed", "tone: Passed 2 of 3 times", "leak: Failed"]);
    expect(within(c).queryByTestId("eval-health-not-saved")).toBeNull();
    expect(within(c).queryByRole("button")).toBeNull();
    f.close();
  });
  it("says when the baseline could not be saved and when nothing was run because the results were already saved", async () => {
    const f = mount({ read: () => ({ status: 200, body: approved({ health: health("finished", { result: finishedResult({ saved: false, differing: 0 }) }) }) }) });
    expect((await within(await theCard()).findByTestId("eval-health-not-saved")).textContent).toBe("Measured, but the result could not be saved as your baseline.");
    f.close(); cleanup();
    const g = mount({ read: () => ({ status: 200, body: approved({ health: health("finished", { result: finishedResult({ reused: true, differing: 0 }) }) }) }) });
    expect((await within(await theCard()).findByTestId("eval-health-reused")).textContent).toBe("Rovara already had these results saved, so nothing was run.");
    g.close();
  });
  it("a check that did not run says why in Code's own words and offers the button again, with a fresh request id after an earlier press", async () => {
    let reply: ApiResponse = { status: 200, body: approved() };
    const notRun: ApiResponse = { status: 200, body: approved({ health: health("not_run", { words: "Not run: your yes is more than a day old. Say yes again to run it." }) }) };
    const f = mount({ read: () => reply, post: () => { reply = notRun; return { status: 200, body: { project: "web", requested: true, duplicate: false, cost: "$2.40" } }; } });
    fireEvent.click(await within(await theCard()).findByRole("button", { name: "Check my evals now (about $2.40)" }));
    await waitFor(() => expect(posts(f, "eval-health")).toHaveLength(1));
    expect((await screen.findByTestId("eval-health-words")).textContent).toBe("Not run: your yes is more than a day old. Say yes again to run it.");
    fireEvent.click(await within(await theCard()).findByRole("button", { name: "Check my evals now (about $2.40)" }));
    await waitFor(() => expect(posts(f, "eval-health")).toHaveLength(2));
    const ids = posts(f, "eval-health").map(r => (r.body as { requestId: string }).requestId);
    expect(ids[0]).not.toBe(ids[1]);
    f.close();
  });
  it("reads again by itself only while a check waits or runs, and never posts (the poll only reads)", () => {
    expect(EVAL_HEALTH_POLL_MS).toBe(15_000);
    for (const state of ["requested", "running"]) expect(evalHealthPollMs(state)).toBe(15_000);
    for (const state of ["none", "finished", "not_run", undefined]) expect(evalHealthPollMs(state)).toBe(false);
  });
  it("a running card is read again after the poll interval, with no post", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const f = mount({ read: () => ({ status: 200, body: approved({ health: health("running") }) }) });
      await theCard();
      const before = evalReads(f);
      await vi.advanceTimersByTimeAsync(EVAL_HEALTH_POLL_MS + 500);
      await waitFor(() => expect(evalReads(f)).toBeGreaterThan(before));
      expect(posts(f)).toHaveLength(0);
      f.close();
    } finally { vi.useRealTimers(); }
  });
  it("a card that read once keeps showing its last answer when a later read fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let ok = true;
      const f = mount({ read: () => (ok ? { status: 200, body: approved({ health: health("running") }) } : { status: 500, body: { error: { code: "INTERNAL", message: "down" } } }) });
      await theCard();
      const before = evalReads(f);
      ok = false;
      await vi.advanceTimersByTimeAsync(EVAL_HEALTH_POLL_MS + 500);
      await waitFor(() => expect(evalReads(f)).toBeGreaterThan(before));
      expect(screen.queryByTestId("eval-card-read-error")).toBeNull();
      expect(screen.getByTestId("eval-health-state").textContent).toBe("Your eval check is running");
      f.close();
    } finally { vi.useRealTimers(); }
  });
  it("a second press before Code's answer settles repeats the same request id (a double press is one request)", async () => {
    const f = mount({ read: () => ({ status: 200, body: approved() }) });
    const label = { name: "Check my evals now (about $2.40)" };
    fireEvent.click(await within(await theCard()).findByRole("button", label));
    await waitFor(() => expect(posts(f, "eval-health")).toHaveLength(1));
    fireEvent.click(await within(await theCard()).findByRole("button", label));
    await waitFor(() => expect(posts(f, "eval-health")).toHaveLength(2));
    const ids = posts(f, "eval-health").map(r => (r.body as { requestId: string }).requestId);
    expect(ids[0]).toBe(ids[1]);
    f.close();
  });
  it("a person who may not approve sees the answer but no button", async () => {
    const f = mount({ read: () => ({ status: 200, body: approved({ canApprove: false, health: health("not_run", { words: "Not run: the monthly AI spending limit cannot fit these runs." }) }) }) });
    const c = await theCard();
    expect(within(c).getByTestId("eval-health-words").textContent).toBe("Not run: the monthly AI spending limit cannot fit these runs.");
    expect(within(c).queryByRole("button")).toBeNull();
    f.close();
  });
});

describe("when there is no card", () => {
  it("Code's `unavailable` sentence stands in place of the card", async () => {
    const words = "This install has no eval budget, so an eval can't be approved here yet.";
    const f = mount({ read: () => ({ status: 200, body: card({ suites: [], unavailable: words }) }) });
    expect((await screen.findByTestId("eval-card-unavailable")).textContent).toBe(words);
    expect(screen.queryByTestId("eval-card")).toBeNull();
    f.close();
  });

  it("a Code that does not serve the card yet (501 NOT_ON_CODE_YET or its unknown-route 404) leaves the checklist's own line; no button", async () => {
    for (const reply of [{ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "The eval card isn't connected to Rovara Code yet." } } }, { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } }]) {
      const f = mount({ read: () => reply });
      expect((await screen.findByTestId("checklist-eval-not-yet")).textContent).toContain("isn't connected yet");
      expect(screen.queryByTestId("eval-card")).toBeNull();
      f.close();
      cleanup();
    }
  });

  it("state none leaves the checklist's own line; another failure says so and offers Try again", async () => {
    const f = mount({ read: () => ({ status: 200, body: card({ state: "none", suites: [], report: undefined }) }) });
    await screen.findByTestId("checklist-eval-not-yet");
    f.close();
    cleanup();
    const g = mount({ read: () => ({ status: 400, body: { error: { code: "CONFIG_INVALID", message: LEAK } } }) });
    const failed = await screen.findByTestId("eval-card-read-error");
    expect(failed.textContent).toContain(EVAL_CARD_WORDS.readError);
    expect(document.body.textContent).not.toContain(LEAK);
    g.close();
  });
});

describe("dollars only", () => {
  const states: Array<[string, Record<string, unknown>, boolean]> = [
    ["propose", card(), false],
    ["propose, grew past", card({ suites: [suite({ versusApproved: { within: false, words: "Needs approval: your eval set grew past the approved $4.00" } })] }), false],
    ["propose, still inside", card({ suites: [suite({ versusApproved: { within: true, words: "Still inside what you approved: no new approval needed" } })] }), false],
    ["propose, reader", card({ canApprove: false }), false],
    ["waiting", waiting(), false],
    ["waiting, reader", waiting({ canApprove: false }), false],
    ["renew", waiting({ state: "renew" }), false],
    ["approved", approved(), false],
    ["approved, carried", approved({ spend: { state: "approved", perPr: "$0.50-$1.20", monthly: "$41.00", carried: true } }), false],
    ["approved, health queued", approved({ health: health("requested") }), false],
    ["approved, health ran", approved({ health: health("finished") }), false],
    ["rejected", card({ state: "rejected", suites: [], spend: { state: "rejected", perPr: "$0.50-$1.20", monthly: "$41.00" } }), false],
    ["propose, fresh", card(), true],
  ];
  for (const [name, body, fresh] of states) {
    it(`${name}: no token, call or micro-dollar word and no raw whole-number figure in the card's text or accessible names`, async () => {
      expect(() => EvalCardViewSchema.parse(body)).not.toThrow();
      const f = mount({ fresh, read: () => ({ status: 200, body }) });
      const c = await theCard();
      const said = readable(c);
      expect(said.trim().length).toBeGreaterThan(20);
      expect(said).not.toMatch(/token|call|micro/iu);
      expect(said).not.toMatch(/\d{6,}/u);
      if (!name.startsWith("rejected")) expect(said).toContain("$");
      f.close();
    });
  }
  it("the words the page itself says hold no token, call or micro-dollar word", () => {
    const words = [...Object.values(EVAL_CARD_WORDS).map(value => typeof value === "function" ? value("$1.00", "$2.00") : value), EVAL_HEALTH_WORDS.resultLine({ questionCount: 3, passedAnswers: 5, totalAnswers: 9 } as never), EVAL_HEALTH_WORDS.differing(2), EVAL_HEALTH_WORDS.caseMixed(2)].join(" ");
    expect(words).not.toMatch(/token|call|micro/iu);
  });
});

describe("two projects", () => {
  it("asks only for the project it is on and shows nothing from another project's card", async () => {
    const f = mount();
    await theCard();
    const paths = f.request.mock.calls.map(([r]) => r.path).filter(path => path.includes("/setup-agent/eval"));
    expect(paths).toEqual(["/v1/app/projects/web/setup-agent/eval"]);
    f.close();
  });
});
