// @vitest-environment jsdom
// L4-T1 (G1): a person on the project checklist can review and approve a proposed setup without leaving it. The Setup run row mounts the same "What Rovara found" and "Use this setup?" cards as the old Setup step, says
// "Needs you: review the setup" while a proposal waits, follows the same permission rules (Approve and Reject only for a person the read says may decide; "Use this setup" only for a person who may manage the run; everyone
// else reads one line), and links nowhere. These tests fake the reads (a ready run that is not approved) and watch what the page shows and asks.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ProjectChecklist } from "../../packages/ui/src/screens/setup/ProjectChecklist.js";
import { APPROVAL_WORDS as A, REVIEW_WORDS as R } from "../../packages/ui/src/screens/setup/words.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { navFixture } from "./support/fixtures.js";

afterEach(cleanup);
const ME = "a".repeat(64), DIGEST = "ab12".repeat(16), NONCE_KEY = "rovara.stepup.nonce", COMMIT = "a".repeat(40);
const LIMITS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
const file = (path: string, line: number, quote: string) => ({ kind: "file", repo: "web", path, commit: COMMIT, line, quote });
const item = <V,>(id: string, value: V, from: unknown[]) => ({ id, value, from, confidence: "high", risk: "safe" });
const PROPOSAL = {
  version: 2, basedOnRevision: 2, repositories: [],
  setup: [item("setup-web", { repo: "web", commands: ["npm ci"] }, [file("package.json", 3, "\"ci\": \"npm ci\"")])],
  tests: [item("tests-web", { repo: "web", commands: ["npm test"] }, [file("package.json", 4, "\"test\": \"npm test\"")])],
  checks: [], testEnvironment: [], knowledge: [], sources: [], intake: [], allowedDomains: [], secretsNeeded: [], flaggedCommands: [], foundNotUsed: [], notes: "",
};
const apply = (over: Record<string, unknown> = {}) => ({
  candidateRevision: 4, baseRevision: 3, setup: ["npm ci"], readiness: ["npm test"], check: { status: "ready" }, risk: "low",
  changes: [{ area: "setup_commands", risk: "low" }, { area: "test_commands", risk: "low" }], approver: "maintainer", canApprove: true, canReject: true,
  approval: { requestId: `setup-${DIGEST.slice(0, 40)}-4`, revision: 4, artifactDigest: DIGEST, kind: "setup", risk: "low" }, ...over,
});
const run = (over: Record<string, unknown> = {}) => ({ status: "ready", basedOnRevision: 3, limits: LIMITS, canManage: true, stop: "proposed", ...over });
/** The checklist read of a run that finished (L4-T2: Code says Needs you until the setup is approved and checked; "done" is that approved state). */
const checklist = (state = "needs_you") => ({
  project: "web", viewer: { companyRole: "owner", projectAdmin: false, canSkip: true }, progress: { done: 3, total: 8, percent: 37, nextRequired: "evalConfirm" },
  repos: { state: "done", count: 1, items: [{ name: "web", fullName: "acme/web", defaultBranch: "main" }] },
  setupRun: { state, status: "ready", approval: state === "done" ? "approved" : "none", ...(state === "done" ? { check: { status: "ready" }, approvedAt: "2026-11-12T10:00:00.000Z" } : {}), startedAt: "2026-11-17T10:00:00.000Z", elapsedMs: 300000, costCents: 31, commandsRun: 4, commandsFound: { setup: 1, tests: 1 }, testOutcome: "passed" },
  evalConfirm: { state: "needs_you", report: "none", blockedBy: "setupRun" }, aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
  slackChannel: { state: "optional", channels: [] }, linear: { state: "optional", team: null }, invites: { state: "optional" }, firstTask: { state: "needs_you", hasTask: false, canStart: false },
});

interface Options { read?: unknown; fresh?: boolean; decide?: { status: number; body: unknown }; agentGone?: boolean }
function mount(options: Options = {}) {
  let current: unknown = options.read ?? run({ apply: apply() });
  let list: unknown = checklist();
  let failing = false;
  const f = fakeHost(async request => {
    if (request.path === "/v1/app/projects/web/setup-status") return { status: 200, body: list };
    if (request.path === "/v1/app/projects/web/setup-agent" && request.method === "GET") return failing ? { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } } : options.agentGone === true ? { status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } } : { status: 200, body: { ...(current as object), requestId: "gw" } };
    if (request.path === "/v1/app/projects/web/setup-agent/journal") return { status: 200, body: { status: "ready", entries: [], hostAsks: [], requestId: "gw" } };
    if (request.path === "/v1/app/projects/web/setup-agent/decide") {
      const answer = options.decide ?? { status: 200, body: { project: "web", decision: "approved", risk: "low", revision: 4, replayed: false } };
      if (answer.status === 200) { current = run(); list = { ...checklist("done"), progress: { done: 4, total: 8, percent: 50, nextRequired: "evalConfirm" } }; }
      return { status: answer.status, body: answer.status === 200 ? { ...(answer.body as object), requestId: "gw" } : answer.body };
    }
    if (request.path === "/v1/app/projects/web") return { status: 200, body: { name: "web", status: "active", latestRevision: 7, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole: "maintainer", setup: { status: "ready" }, settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] }, createdAt: "2026-10-23T12:00:00.000Z", createdBy: { developerId: ME, name: "Maya" }, requestId: "gw" } };
    if (request.path === "/v1/app/nav") return { status: 200, body: { ...navFixture(), projects: [{ name: "web", agents: [] }] } };
    if (request.path === "/v1/app/github/connections") return { status: 200, body: { installations: [] } };
    if (request.path === "/v1/app/slack") return { status: 200, body: { workspace: null } };
    if (request.path === "/v1/app/linear") return { status: 200, body: { status: "disconnected" } };
    if (request.path === "/v1/app/projects/web/slack/channel") return { status: 200, body: { connected: false, channels: [] } };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  });
  if (options.fresh === true) f.storage.set(NONCE_KEY, JSON.stringify({ nonce: "n-1", at: Date.now() }));
  const query = createQueryClient();
  query.setQueryData(["nav"], { me: { developerId: ME, name: "Maya", orgRole: "owner" } });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/web" + (options.fresh === true ? "?confirmed=n-1" : "")], children: h(ProjectChecklist, { project: "web" }) }) }) }), { theme: "light" });
  return { ...f, query, setCurrent(value: unknown) { current = value; }, failReads(value: boolean) { failing = value; }, close() { ui.unmount(); query.clear(); } };
}
const row = () => screen.findByTestId("setup-run-row");
const rowItem = () => screen.getByTestId("checklist-row-setupRun");
const decides = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method === "POST" && r.path.endsWith("/setup-agent/decide"));
const checklistReads = (f: ReturnType<typeof mount>) => f.request.mock.calls.filter(([r]) => r.path === "/v1/app/projects/web/setup-status" && r.method === "GET").length;

describe("approving a setup from the checklist", () => {
  it("a ready run that is not approved shows the approve card inside the Setup run row, says Needs you, and links to no Setup step", async () => {
    const f = mount();
    const body = await row();
    const card = await within(body).findByTestId("setup-approval");
    expect(within(card).getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(within(body).getByTestId("setup-run-needs-you").textContent).toBe(R.approve);
    // The checklist's own pill no longer says Done while a setup waits, and the row is open.
    expect(rowItem().getAttribute("data-state")).toBe("needs_you");
    expect((rowItem().querySelector("details") as HTMLDetailsElement).open).toBe(true);
    expect(within(screen.getByTestId("project-checklist")).queryAllByRole("link").filter(link => (link.getAttribute("href") ?? "").includes("step=setup"))).toEqual([]);
    expect(within(body).queryByText("Rovara found how to set the project up.")).toBeNull();
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("a proposal that is not yet proposed for approval says to review it and shows What Rovara found with Use this setup", async () => {
    const f = mount({ read: run({ proposal: PROPOSAL, verified: true, verification: { "setup-web": "verified", "tests-web": "verified" } }) });
    const body = await row();
    const found = await within(body).findByRole("region", { name: "Use this setup" });
    expect(within(found).getByText("What Rovara found")).toBeTruthy();
    expect(within(found).getByRole("button", { name: "Use this setup" })).toBeTruthy();
    expect(within(body).getByTestId("setup-run-needs-you").textContent).toBe(R.review);
    expect(rowItem().getAttribute("data-state")).toBe("needs_you");
    expect(within(screen.getByTestId("project-checklist")).queryAllByRole("link").filter(link => (link.getAttribute("href") ?? "").includes("step=setup"))).toEqual([]);
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("while the candidate's check runs on a fresh machine the row says so, shows no decision and counts as Running", async () => {
    const f = mount({ read: run({ apply: apply({ check: { status: "checking" }, canApprove: false, canReject: false, approval: undefined }) }) });
    const body = await row();
    expect((await within(body).findByTestId("setup-run-needs-you")).textContent).toBe(R.checking);
    expect(within(body).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(rowItem().getAttribute("data-state")).toBe("running");
    f.close();
  });

  it("a person who may not decide sees the card read-only: no Approve, no Reject, no Discard, no Use this setup", async () => {
    const reader = mount({ read: run({ canManage: false, apply: apply({ risk: "high", approver: "admin", canApprove: false, canReject: false }) }) });
    const card = await within(await row()).findByTestId("setup-approval");
    expect(within(card).queryByRole("button")).toBeNull();
    expect(within(card).getByTestId("setup-approval-who").textContent).toBe(A.who.admin);
    reader.close(); cleanup();
    const proposal = mount({ read: run({ canManage: false, proposal: PROPOSAL, verified: true }) });
    const body = await row();
    expect((await within(body).findByTestId("setup-review-read-only")).textContent).toBe(R.readOnly);
    expect(within(body).queryByRole("button", { name: "Use this setup" })).toBeNull();
    expect(within(body).queryByRole("region", { name: "Use this setup" })).toBeNull();
    proposal.close();
  });

  it("after the fresh sign-in, Approve is sent bound to the read's revision and digest, and the row updates", async () => {
    const f = mount({ fresh: true });
    const card = await within(await row()).findByTestId("setup-approval");
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decides(f)).toHaveLength(1));
    expect(decides(f)[0]!.body).toEqual({ requestId: `setup-${DIGEST.slice(0, 40)}-4`, outcome: "approve", seen: { revision: 4, artifactDigest: DIGEST } });
    expect((await screen.findByTestId("setup-decided")).textContent).toBe(A.approved);
    await waitFor(() => expect(screen.queryByTestId("setup-approval")).toBeNull());
    expect(screen.queryByTestId("setup-run-needs-you")).toBeNull();
    // The checklist was read again, so the row and the progress follow what Code says now.
    await waitFor(() => expect(checklistReads(f)).toBeGreaterThan(1));
    expect(rowItem().getAttribute("data-state")).toBe("done");
    await waitFor(() => expect(screen.getByTestId("checklist-progress").textContent).toContain("50% done (4 of 8)"));
    f.close();
  });

  it("without a fresh sign-in Approve sends the person to confirm, and decides nothing", async () => {
    const f = mount();
    const card = await within(await row()).findByTestId("setup-approval");
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    expect(f.host.signIn).toHaveBeenCalledTimes(1);
    expect(decides(f)).toHaveLength(0);
    f.close();
  });

  it("a manager sees Discard on a candidate whose check failed; a reader does not", async () => {
    const failedCheck = { check: { status: "failed", failedStep: "npm test" }, canApprove: false, canReject: false, approval: undefined };
    const manager = mount({ read: run({ apply: apply(failedCheck) }) });
    const card = await within(await row()).findByTestId("setup-approval");
    expect(within(card).getByRole("button", { name: "Discard this setup" })).toBeTruthy();
    expect(within(card).getByRole("alert").textContent).toContain("npm test");
    expect(rowItem().getAttribute("data-state")).toBe("needs_you");
    manager.close(); cleanup();
    const reader = mount({ read: run({ canManage: false, apply: apply(failedCheck) }) });
    const readOnly = await within(await row()).findByTestId("setup-approval");
    expect(within(readOnly).queryByRole("button")).toBeNull();
    reader.close();
  });

  it("on the checklist Use this setup says the check starts by itself and the approval is here, not in a test environment below", async () => {
    const f = mount({ read: run({ proposal: PROPOSAL, verified: true, verification: { "setup-web": "verified", "tests-web": "verified" } }) });
    const found = await within(await row()).findByRole("region", { name: "Use this setup" });
    expect(found.textContent).toContain(R.confirmRule);
    expect(found.textContent).not.toContain("test environment below");
    f.close();
  });

  it("a failed re-read keeps the card that was shown (only 'not found' means nothing waits)", async () => {
    const f = mount();
    await within(await row()).findByTestId("setup-approval");
    f.failReads(true);
    await f.query.invalidateQueries({ queryKey: ["onboard", "setup-agent", "web"] });
    await new Promise(done => setTimeout(done, 100));
    expect(screen.queryByTestId("setup-approval")).toBeTruthy();
    f.close();
  });

  it("a decision is about one run: a later run's proposal is not hidden by an old decision", async () => {
    const f = mount({ fresh: true, read: run({ startedAt: "2026-11-17T10:00:00.000Z", apply: apply() }) });
    const card = await within(await row()).findByTestId("setup-approval");
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    expect((await screen.findByTestId("setup-decided")).textContent).toBe(A.approved);
    f.setCurrent(run({ startedAt: "2026-11-18T09:00:00.000Z", proposal: PROPOSAL, verified: true, verification: { "setup-web": "verified", "tests-web": "verified" } }));
    await f.query.invalidateQueries({ queryKey: ["onboard", "setup-agent", "web"] });
    expect(await within(await row()).findByRole("region", { name: "Use this setup" })).toBeTruthy();
    expect(screen.queryByTestId("setup-decided")).toBeNull();
    f.close();
  });

  it("Use this setup proposes against the project's current revision, not the run's older one", async () => {
    const f = mount({ read: run({ proposal: PROPOSAL, verified: true, verification: { "setup-web": "verified", "tests-web": "verified" } }) });
    const found = await within(await row()).findByRole("region", { name: "Use this setup" });
    await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/projects/web" && r.method === "GET")).toBe(true));
    fireEvent.click(within(found).getByRole("button", { name: "Use this setup" }));
    await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/setup-agent/confirm"))).toBe(true));
    const sent = f.request.mock.calls.map(([r]) => r).find(r => r.path.endsWith("/setup-agent/confirm"))!;
    expect(sent.body).toMatchObject({ expectedRevision: 7, itemIds: ["setup-web", "tests-web"] });
    f.close();
  });

  it("a failed run shows no review even if the run read still carries a candidate", async () => {
    const failed = fakeHost(async request => {
      if (request.path === "/v1/app/projects/web/setup-status") { const c = checklist("failed"); return { status: 200, body: { ...c, setupRun: { ...c.setupRun, status: "failed", failure: "A test command failed." } } }; }
      if (request.path === "/v1/app/projects/web/setup-agent") return { status: 200, body: { ...run({ status: "failed", failure: "A test command failed.", apply: apply() }), requestId: "gw" } };
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
    });
    const query = createQueryClient();
    const ui = renderUi(h(AppHostProvider, { host: failed.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/web"], children: h(ProjectChecklist, { project: "web" }) }) }) }), { theme: "light" });
    await row();
    await waitFor(() => expect(failed.request.mock.calls.some(([r]) => r.path === "/v1/app/projects/web/setup-agent")).toBe(true));
    await new Promise(done => setTimeout(done, 100));
    expect(screen.queryByTestId("setup-run-needs-you")).toBeNull();
    expect(screen.queryByTestId("setup-approval")).toBeNull();
    ui.unmount(); query.clear();
  });

  it("when the setup run can't be read (not found) the row stays as the checklist says and shows no card", async () => {
    const f = mount({ agentGone: true });
    const body = await row();
    expect(within(body).getByText("Rovara found how to set the project up.")).toBeTruthy();
    expect(screen.queryByTestId("setup-approval")).toBeNull();
    expect(rowItem().getAttribute("data-state")).toBe("needs_you");
    f.close();
  });
});
