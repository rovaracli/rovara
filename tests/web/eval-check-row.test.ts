// @vitest-environment jsdom
// L4-EVCI2: "Eval check from your CI", one more row of the project's setup checklist. Rovara proposes the jobs of the customer's workflow files that look like an eval; a person who manages the setup presses "Use this
// one" (or "None"); the row shows the confirmed name and the one line "Rovara shows this check's result on its pull requests." A reader sees what was chosen and no button. Code decides everything (who may, which
// checks were proposed); these tests watch what the page asks and says.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ProjectChecklist } from "../../packages/ui/src/screens/setup/ProjectChecklist.js";
import { EVAL_CHECK_ROW_WORDS as W } from "../../packages/ui/src/screens/setup/EvalCheckRow.js";
import { EvalCheckViewSchema } from "../../packages/contracts/src/eval-check-web.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

afterEach(cleanup);
const ME = "a".repeat(64), UUID_TEXT = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u) as string;
const ACTIONS = "15368";
const item = (over: Record<string, unknown> = {}) => ({ name: "evals", source: ACTIONS, workflow: ".github/workflows/ci.yml", repository: "web", basis: "name", ...over });
const view = (over: Record<string, unknown> = {}) => ({ project: "web", canManage: true, confirmed: null, proposals: { verdict: "proposals", items: [item(), item({ name: "Quality gate", basis: "commands" })], cut: false }, explanation: W.explanation, ...over });
const checklist = (percent = 38, canSkip = true) => ({
  project: "web", viewer: { companyRole: canSkip ? "owner" : "member", projectAdmin: false, canSkip }, progress: { done: percent >= 100 ? 8 : 3, total: 8, percent, nextRequired: percent >= 100 ? null : "evalConfirm" },
  repos: { state: "done", count: 1, items: [{ name: "web", fullName: "acme/web", defaultBranch: "main" }] },
  setupRun: { state: "done", status: "ready", approval: "approved", check: { status: "ready" }, startedAt: "2026-11-18T10:00:00.000Z", elapsedMs: 300000, costCents: 31, commandsRun: 4, commandsFound: { setup: 1, tests: 1 }, testOutcome: "passed" },
  evalConfirm: percent >= 100 ? { state: "done", report: "confirmed", confirmedSelection: "npm test" } : { state: "needs_you", report: "none" },
  aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
  slackChannel: { state: "optional", channels: [] }, linear: { state: "optional", team: null }, invites: { state: "optional" }, firstTask: percent >= 100 ? { state: "done", hasTask: true, canStart: false } : { state: "needs_you", hasTask: false, canStart: false },
});

interface Options { read?: () => ApiResponse; put?: (request: ApiRequest) => ApiResponse; percent?: number; canSkip?: boolean }
function mount(options: Options = {}) {
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/projects/web/setup-status") return { status: 200, body: checklist(options.percent, options.canSkip) };
    if (request.path === "/v1/app/projects/web/ci-eval-check" && request.method === "GET") return options.read?.() ?? { status: 200, body: view() };
    if (request.path === "/v1/app/projects/web/ci-eval-check" && request.method === "PUT") return options.put?.(request) ?? { status: 200, body: view({ confirmed: { name: "evals", source: ACTIONS } }) };
    if (request.path === "/v1/app/projects/web/setup-agent") return { status: 200, body: { status: "ready", basedOnRevision: 3, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, canManage: true } };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  });
  const query = createQueryClient();
  query.setQueryData(["nav"], { me: { developerId: ME, name: "Maya", orgRole: "owner" } });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/web"], children: h(ProjectChecklist, { project: "web" }) }) }) }), { theme: "light" });
  return { ...f, close() { ui.unmount(); query.clear(); } };
}
const puts = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter((r) => r.method === "PUT" && r.path.endsWith("/ci-eval-check"));
/** The row once it has read: not while it still says it is loading. */
const row = async () => {
  await screen.findByTestId("checklist-row-evalCheck");
  await waitFor(() => expect(screen.getByTestId("checklist-row-evalCheck").textContent).not.toContain(W.loading), { timeout: 5000 });
  return screen.getByTestId("checklist-row-evalCheck");
};

describe("the row", () => {
  it("is one more row of the checklist with the title and the one-line explanation, and lists what Rovara proposed with Use this one beside each", async () => {
    const f = mount();
    const r = await row();
    expect(within(r).getByText(W.title)).toBeTruthy();
    expect(within(r).getByTestId("eval-check-explanation").textContent).toBe("Rovara shows this check's result on its pull requests.");
    const proposals = within(r).getAllByTestId("eval-check-proposal");
    expect(proposals.map((one) => one.textContent)).toEqual([
      expect.stringContaining("evals"), expect.stringContaining("Quality gate"),
    ]);
    expect(proposals[0]!.textContent).toContain(".github/workflows/ci.yml in web");
    expect(proposals[0]!.textContent).toContain(W.basisName);
    expect(proposals[1]!.textContent).toContain(W.basisCommands);
    expect(within(r).getAllByRole("button", { name: W.use })).toHaveLength(2);
    expect(within(r).getByRole("button", { name: W.none })).toBeTruthy();
    expect(puts(f)).toHaveLength(0);
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("Use this one sends ONE PUT with a request id and exactly the proposed name and app, then shows the confirmed name and Saved", async () => {
    const f = mount();
    const r = await row();
    fireEvent.click(within(r).getAllByRole("button", { name: W.use })[0]!);
    await waitFor(() => expect(puts(f)).toHaveLength(1));
    const sent = puts(f)[0]!;
    expect(sent.body).toEqual({ requestId: UUID_TEXT, check: { name: "evals", source: ACTIONS } });
    expect(sent.retry).toBe("never");
    expect((await within(await row()).findByTestId("eval-check-confirmed")).textContent).toBe("Chosen: evals");
    expect(within(await row()).getByTestId("eval-check-saved").textContent).toBe(W.saved);
    expect((await row()).getAttribute("data-state")).toBe("done");
    expect(screen.getByTestId("checklist-row-evalCheck").querySelector("details")?.open).toBe(true);
    expect(within(await row()).getByRole("button", { name: W.clear })).toBeTruthy();
    f.close();
  });

  it("None sends null and the row says nothing is chosen any more", async () => {
    let confirmed: unknown = { name: "evals", source: ACTIONS };
    const f = mount({ read: () => ({ status: 200, body: view({ confirmed }) }), put: () => { confirmed = null; return { status: 200, body: view({ confirmed: null }) }; } });
    const r = await row();
    expect(within(r).getByTestId("eval-check-confirmed").textContent).toBe("Chosen: evals");
    fireEvent.click(within(r).getByRole("button", { name: W.clear }));
    await waitFor(() => expect(puts(f)).toHaveLength(1));
    expect(puts(f)[0]!.body).toEqual({ requestId: UUID_TEXT, check: null });
    await waitFor(() => expect(within(screen.getByTestId("checklist-row-evalCheck")).queryByTestId("eval-check-confirmed")).toBeNull());
    expect((await row()).getAttribute("data-state")).toBe("optional");
    f.close();
  });

  it("a second press while the first is still going sends nothing more; a retry after a failure repeats the SAME request id", async () => {
    let attempts = 0;
    const f = mount({ put: () => { attempts += 1; return attempts === 1 ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } } : { status: 200, body: view({ confirmed: { name: "evals", source: ACTIONS } }) }; } });
    const r = await row();
    const button = within(r).getAllByRole("button", { name: W.use })[0]!;
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(puts(f).length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(within(screen.getByTestId("checklist-row-evalCheck")).getByTestId("eval-check-error").textContent).toBe(W.sendError));
    expect(puts(f)).toHaveLength(1);
    fireEvent.click(within(await row()).getAllByRole("button", { name: W.use })[0]!);
    await waitFor(() => expect(puts(f)).toHaveLength(2));
    expect((puts(f)[1]!.body as { requestId: string }).requestId).toBe((puts(f)[0]!.body as { requestId: string }).requestId);
    f.close();
  });

  it("a refusal shows only Rovara's fixed sentence, never other text of the server's", async () => {
    const f = mount({ put: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only company owners and admins, or this project's admins, can choose the eval check." } } }) });
    fireEvent.click(within(await row()).getAllByRole("button", { name: W.use })[0]!);
    await waitFor(() => expect(screen.getByTestId("eval-check-error").textContent).toContain("can choose the eval check"));
    f.close(); cleanup();
    const g = mount({ put: () => ({ status: 500, body: { error: { code: "INTERNAL", message: "SECRET-SERVER-DETAIL" } } }) });
    fireEvent.click(within(await row()).getAllByRole("button", { name: W.use })[0]!);
    await waitFor(() => expect(screen.getByTestId("eval-check-error").textContent).toBe(W.sendError));
    expect(document.body.textContent).not.toContain("SECRET-SERVER-DETAIL");
    g.close();
  });
});

describe("who and what Code said", () => {
  it("a person who may not choose sees what was chosen (or that nothing was), who chooses, and no button", async () => {
    const f = mount({ read: () => ({ status: 200, body: view({ canManage: false, proposals: null }) }) });
    const r = await row();
    expect(within(r).queryByRole("button")).toBeNull();
    expect(within(r).getByTestId("eval-check-none-chosen").textContent).toBe(W.noneChosen);
    expect(within(r).getByTestId("eval-check-who").textContent).toBe(W.noOne);
    f.close(); cleanup();
    const g = mount({ read: () => ({ status: 200, body: view({ canManage: false, proposals: null, confirmed: { name: "evals" } }) }) });
    const s = await row();
    expect(within(s).getByTestId("eval-check-confirmed").textContent).toBe("Chosen: evals");
    expect(within(s).queryByRole("button")).toBeNull();
    g.close();
  });

  it("even if an answer gave a person who may not choose a list, no button is drawn for it", async () => {
    const f = mount({ read: () => ({ status: 200, body: view({ canManage: false }) }) });
    const r = await row();
    expect(within(r).queryByRole("button")).toBeNull();
    expect(within(r).queryAllByTestId("eval-check-proposal")).toHaveLength(0);
    f.close();
  });

  it("no eval-looking check in the workflow files says so; unreadable files say so with Try again; neither offers a button to choose", async () => {
    const none = mount({ read: () => ({ status: 200, body: view({ proposals: { verdict: "none_found", items: [], cut: false } }) }) });
    expect((await within(await row()).findByTestId("eval-check-none-found")).textContent).toBe(W.noneFound);
    expect(within(await row()).queryByRole("button", { name: W.use })).toBeNull();
    none.close(); cleanup();
    const unknown = mount({ read: () => ({ status: 200, body: view({ proposals: { verdict: "unknown", items: [], cut: false } }) }) });
    expect((await within(await row()).findByTestId("eval-check-unknown")).textContent).toContain(W.unknown);
    expect(within(await row()).queryByRole("button", { name: W.use })).toBeNull();
    unknown.close();
  });

  it("a list that was cut says so", async () => {
    const f = mount({ read: () => ({ status: 200, body: view({ proposals: { verdict: "proposals", items: [item()], cut: true } }) }) });
    expect((await within(await row()).findByTestId("eval-check-cut")).textContent).toBe(W.cut);
    f.close();
  });

  it("a name or path with markup is shown as text, never as markup", async () => {
    const f = mount({ read: () => ({ status: 200, body: view({ proposals: { verdict: "proposals", items: [item({ name: "<img src=x onerror=alert(1)>", workflow: ".github/workflows/<b>x</b>.yml" })], cut: false } }) }) });
    const r = await row();
    expect(r.querySelector("img")).toBeNull();
    expect(r.querySelector("b")).toBeNull();
    expect(r.textContent).toContain("<img src=x onerror=alert(1)>");
    f.close();
  });

  it("Code (or Cloud) not serving the card yet leaves no row at all; any other read failure says so with Try again", async () => {
    for (const read of [() => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "x" } } }), () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } })]) {
      const f = mount({ read });
      await screen.findByTestId("project-checklist");
      await waitFor(() => expect(screen.queryByTestId("checklist-row-evalCheck")).toBeNull());
      expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/ci-eval-check"))).toBe(true);
      f.close(); cleanup();
    }
    const f = mount({ read: () => ({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "SECRET" } } }) });
    expect((await within(await row()).findByTestId("eval-check-read-error")).textContent).toBe(W.readError);
    expect(document.body.textContent).not.toContain("SECRET");
    f.close();
  });

  it("an answer that does not match the contract is not drawn", async () => {
    expect(EvalCheckViewSchema.safeParse(view()).success).toBe(true);
    expect(EvalCheckViewSchema.safeParse(view({ extra: 1 })).success).toBe(false);
    const f = mount({ read: () => ({ status: 200, body: view({ proposals: { verdict: "proposals", items: [item({ basis: "other" })], cut: false } }) }) });
    expect((await within(await row()).findByTestId("eval-check-read-error")).textContent).toBe(W.readError);
    f.close();
  });

  it("a finished checklist still shows the row for a person who can change the project, and nothing for one who cannot", async () => {
    const f = mount({ percent: 100 });
    expect(await screen.findByTestId("project-eval-check-only")).toBeTruthy();
    expect(await row()).toBeTruthy();
    f.close(); cleanup();
    const g = mount({ percent: 100, canSkip: false });
    await waitFor(() => expect(g.request.mock.calls.some(([r]) => r.path.endsWith("/setup-status"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("checklist-row-evalCheck")).toBeNull();
    g.close();
  });
});
