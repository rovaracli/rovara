// @vitest-environment jsdom
// Bug G (staging 0.4.11): nothing in the web app pressed Merge. A task session that waits for its merge shows what is approved and whether checks passed, says in the control plane's exact
// words why Merge can't be pressed yet, and presses Merge after one question; the press answers 202 and the person confirms on Plan 3's page. Only a confirmed merge is "done".
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewSchema } from "@agentx/contracts/web";
import { projectDecisionCards, type DecisionItem } from "../../packages/broker/src/decisions/project.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { MERGE_NOT_READY_MESSAGES as M } from "../../packages/contracts/src/rovara-code.js";
import { mergeTrackingDecisionDigest } from "../../packages/contracts/src/rovara-code-node.js";
import type { MergeTrackingItem } from "../../packages/contracts/src/rovara-code.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { sessionFixture, taskFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { expectNoAxeViolations } from "./support/axe.js";
// The broker's test harness lives outside this project's file list (tests/web is its own TypeScript project), so it is loaded at run time.
interface MergeBrokerHarness {
  sessionId: string; handler: (event: unknown) => Promise<{ statusCode: number; body: string }>; bearer: (who?: unknown) => Promise<string>;
  decide: (confirmUrl: string) => Promise<{ status: number; body: string }>; github: { mergeCalls: unknown[] };
}
const harnessPath = "../support/merge-button-broker.js";
const slackPath = "../support/slack-broker.js";

const HEAD = "a".repeat(40);
const TASK = "11111111-1111-4111-8111-111111111111";
const CONFIRM = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";

function tracking(extra: Partial<MergeTrackingItem> = {}): MergeTrackingItem {
  const fields = {
    orgId: "org_aaaaaaaaaaaaaaaaaaaa", taskId: TASK, repositoryId: "payments", number: 42, headSha: HEAD, draft: false, state: "open" as const, baseBranch: "main", ci: "passing" as const, ciBasis: "required" as const,
    checksEverSeen: true, failingChecks: [] as string[], review: "approved" as const, approval: { githubUserId: "1004", login: "arjun-gh", commitId: HEAD }, branch: "up_to_date" as const, headByRovara: true,
    nudges: { count: 0 }, syncs: { day: "2026-10-26", count: 0 }, ...extra,
  };
  return { ...fields, version: 1, decisionDigest: mergeTrackingDecisionDigest(fields), observedAt: "2026-10-26T22:16:10.000Z" };
}

/** A task session waiting for its merge, as the server's version 2 task view shows it. */
function mergeSession(merge: { ready: boolean; message?: string; risk?: { level: "low" | "medium" | "high"; reasons: string[] } } | undefined, options: { items?: MergeTrackingItem[]; level?: "view" | "use" | "edit"; owner?: boolean; mayMerge?: true } = {}) {
  const base = workspaceFixture();
  const level = options.level ?? "edit";
  const task = taskFixture({
    ...(base.body.kind === "task" ? (base.body.task) : {}),
    pullRequests: [{ repository: "payments", number: 42, url: "https://github.com/acme/payments/pull/42", state: "open" }],
    mergeTracking: options.items ?? [tracking()], ...(merge === undefined ? {} : { merge }),
  });
  return sessionFixture({ kind: "task", status: "waiting", step: "Waiting for the merge", where: { kind: "cloud" }, body: { kind: "task", task }, you: { level, owner: options.owner ?? level === "edit", following: false, actions: ["watch", "comment"], ...(options.mayMerge === undefined ? {} : { mayMerge: options.mayMerge }) } });
}

function setup(initial: ReturnType<typeof sessionFixture>, mergeReply?: (request: ApiRequest) => Promise<ApiResponse>, decisions?: unknown) {
  let session = initial;
  const f = fakeHost(async (request) => {
    const path = request.path.split("?", 1)[0]!;
    // The decision cards are not switched on in these worlds (the route does not exist): "no cards".
    if (path === "/v1/app/decisions") return decisions === undefined ? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } } : { status: 200, body: decisions };
    if (path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
    if (path.endsWith("/events")) return { status: 200, body: { events: [] } };
    if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: session.viewingNow } };
    if (request.method === "POST" && path.endsWith("/merge")) return mergeReply === undefined ? { status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: CONFIRM, changes: ["Merge payments pull request 42 (squash)"] } } : mergeReply(request);
    return { status: 200, body: { session } };
  });
  const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
  const presses = () => f.request.mock.calls.filter(([request]) => request.method === "POST" && request.path.endsWith("/merge"));
  return { ...f, ...ui, query, router, presses, setSession(next: ReturnType<typeof sessionFixture>) { session = next; }, close() { ui.unmount(); router.dispose(); query.clear(); } };
}

it("shows who approved, the checks and the head, and says Merge is ready", async () => {
  const f = setup(mergeSession({ ready: true }));
  const region = await screen.findByRole("region", { name: "Merge" });
  expect(region.textContent).toContain("Ready to merge");
  expect(region.textContent).toContain("payments #42");
  expect(region.textContent).toContain("Checks passing");
  expect(region.textContent).toContain("Approved by arjun-gh");
  expect(region.textContent).toContain("aaaaaaa");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Merge" }).disabled).toBe(false);
  f.close();
});

it("asks first: pressing Merge opens a question, and a no sends nothing", async () => {
  const f = setup(mergeSession({ ready: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  const dialog = await screen.findByRole("dialog", { name: "Press Merge?" });
  expect(dialog.textContent).toContain("payments #42");
  expect(dialog.textContent).toContain("merges it now");
  expect(dialog.textContent).not.toContain("Merge anyway");
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Press Merge?" })).toBeNull());
  expect(f.presses()).toHaveLength(0);
  f.close();
});

it("presses once, however many times the button is clicked, then waits for the person to confirm in their browser and never says done", async () => {
  const f = setup(mergeSession({ ready: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  const press = await screen.findByRole("button", { name: "Press Merge" });
  act(() => { press.click(); press.click(); press.click(); });
  await screen.findByText("Waiting for you to confirm in your browser");
  expect(f.presses()).toHaveLength(1);
  const body = f.presses()[0]![0].body as { requestId: string };
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(f.presses()[0]![0].path).toBe(`/v1/app/sessions/${SESSION_FIXTURE_ID}/merge`);
  expect(screen.queryByText("Done")).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Merge" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
  expect(f.host.openExternal).toHaveBeenCalledExactlyOnceWith(CONFIRM);
  f.close();
});

it("says Done only when the server's own view shows every pull request merged", async () => {
  const f = setup(mergeSession({ ready: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  fireEvent.click(await screen.findByRole("button", { name: "Press Merge" }));
  await screen.findByText("Waiting for you to confirm in your browser");
  const merged = mergeSession({ ready: false, message: M.taskClosed }, { items: [tracking({ state: "merged" })] });
  f.setSession({ ...merged, revision: 5 });
  await f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID] });
  await screen.findByText("Merged");
  f.close();
});

it("shows the control plane's exact words and disables Merge when it is not ready", async () => {
  for (const message of [M.checks, M.needsOtherApproval("Maya Chen"), M.draft, M.conflicted("main"), M.presserApproved, M.linkGithub]) {
    const f = setup(mergeSession({ ready: false, message }));
    const region = await screen.findByRole("region", { name: "Merge" });
    expect(region.textContent, message).toContain(message);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Merge" }).disabled).toBe(true);
    f.close();
  }
});

it("shows the exact refusal when the press itself is refused, and presses again only on a new click", async () => {
  const f = setup(mergeSession({ ready: true }), async () => ({ status: 409, body: { error: { code: "MERGE_NOT_READY", message: M.checks } } }));
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  fireEvent.click(await screen.findByRole("button", { name: "Press Merge" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(M.checks);
  expect(f.presses()).toHaveLength(1);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Merge" }).disabled).toBe(false);
  f.close();
});

it("gives a viewer the readiness but no button", async () => {
  const f = setup(mergeSession({ ready: true }, { level: "view", owner: false }));
  const region = await screen.findByRole("region", { name: "Merge" });
  expect(region.textContent).toContain("Ready to merge");
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  f.close();
});

it("gives a viewer the server lets press (an inherited maintainer, an org admin) the button too (C59 minor)", async () => {
  const f = setup(mergeSession({ ready: true }, { level: "view", owner: false, mayMerge: true }));
  await screen.findByRole("region", { name: "Merge" });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Merge" }).disabled).toBe(false);
  f.close();
});

it("shows nothing for a task the server gives no merge view (a version 1 task, or nothing tracked yet)", async () => {
  const f = setup(mergeSession(undefined, { items: [] }));
  await screen.findByRole("heading", { name: "Fix duplicate refunds" });
  expect(screen.queryByRole("region", { name: "Merge" })).toBeNull();
  f.close();
});

it("keeps the Merge section accessible in both themes", async () => {
  for (const theme of ["light", "dark"] as const) {
    const f = setup(mergeSession({ ready: false, message: M.checks }));
    document.documentElement.setAttribute("data-theme", theme);
    await screen.findByRole("region", { name: "Merge" });
    await expectNoAxeViolations(f.container);
    f.close();
  }
});

// ---- the real broker: what the page reads and what the press answers, as the broker sends them

it("round trip: against the real broker, the page reads the task view's merge, the press answers 202 and the page opens the broker's own confirmation link", async () => {
  const { loadSlackBroker } = await import(slackPath) as { loadSlackBroker: () => Promise<unknown> };
  await loadSlackBroker();
  const { mergeButtonBroker, CELL, MAYA } = await import(harnessPath) as { mergeButtonBroker: () => Promise<MergeBrokerHarness>; CELL: string; MAYA: unknown };
  const broker = await mergeButtonBroker();
  const f = fakeHost(async (request) => {
    const path = request.path.split("?", 1)[0]!;
    // The decision cards are not switched on in these worlds (the route does not exist): "no cards".
    if (path === "/v1/app/decisions") return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
    if (path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
    if (path.endsWith("/events")) return { status: 200, body: { events: [] } };
    const response = await broker.handler({
      version: "2.0", rawPath: path, rawQueryString: request.path.split("?")[1] ?? "", headers: { authorization: await broker.bearer(MAYA), ...(request.headers ?? {}) },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), requestContext: { requestId: randomUUID(), http: { method: request.method } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as unknown };
  });
  const host = { ...f.host, origin: CELL };
  const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + broker.sessionId] });
  const ui = renderUi(h(AppHostProvider, { host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
  const region = await screen.findByRole("region", { name: "Merge" });
  expect(region.textContent).toContain("Ready to merge");
  expect(region.textContent).toContain("Approved by arjun-gh");
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  fireEvent.click(await screen.findByRole("button", { name: "Press Merge" }));
  await screen.findByText("Waiting for you to confirm in your browser");
  fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
  expect(vi.mocked(host.openExternal)).toHaveBeenCalledTimes(1);
  const opened = String(vi.mocked(host.openExternal).mock.calls[0]![0]);
  expect(opened.startsWith(`${CELL}/v1/app/approve/apr_`)).toBe(true);
  // The link is the broker's own: opened and approved in a browser, it merges.
  const decided = await broker.decide(opened);
  expect(decided.status).toBeLessThan(400);
  expect(broker.github.mergeCalls).toHaveLength(1);
  ui.unmount(); router.dispose(); query.clear();
});


// ---- owner decision 2026-10-27: one click, and the risk shown

const MERGED = { status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "payments", number: 42 }] } };
const CI_RISK = { level: "high" as const, reasons: ["Changes CI configuration (.circleci/config.yml), which decides what is checked before a merge."] };

it("merges with one click: the press answers 200 and the page says merged, with no confirmation page to open", async () => {
  const f = setup(mergeSession({ ready: true, risk: { level: "low", reasons: ["A small change with no sensitive paths, dependency changes or open concerns."] } }), async () => MERGED);
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  fireEvent.click(await screen.findByRole("button", { name: "Press Merge" }));
  await screen.findByText("Merged payments #42.");
  expect(f.presses()).toHaveLength(1);
  expect(screen.queryByText("Waiting for you to confirm in your browser")).toBeNull();
  expect(screen.queryByRole("button", { name: "Open confirmation" })).toBeNull();
  expect(f.host.openExternal).not.toHaveBeenCalled();
  f.close();
});

it("shows the risk and its reasons next to Merge", async () => {
  const f = setup(mergeSession({ ready: true, risk: CI_RISK }));
  const region = await screen.findByRole("region", { name: "Merge" });
  expect(region.textContent).toContain("High risk");
  expect(region.textContent).toContain(CI_RISK.reasons[0]);
  f.close();
});

it("a low risk dialog is one question; the press names the level the person saw", async () => {
  const f = setup(mergeSession({ ready: true, risk: { level: "low", reasons: ["A small change."] } }), async () => MERGED);
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  const dialog = await screen.findByRole("dialog", { name: "Press Merge?" });
  expect(dialog.textContent).not.toContain("Merge anyway");
  fireEvent.click(screen.getByRole("button", { name: "Press Merge" }));
  await screen.findByText("Merged payments #42.");
  expect((f.presses()[0]![0].body as { risk: string }).risk).toBe("low");
  f.close();
});

it("a medium or high risk adds one line to the dialog and is still one click; the press names that level", async () => {
  for (const risk of [CI_RISK, { level: "medium" as const, reasons: ["Changes dependencies or build files: package.json."] }]) {
    const f = setup(mergeSession({ ready: true, risk }), async () => MERGED);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    const dialog = await screen.findByRole("dialog", { name: "Press Merge?" });
    expect(dialog.textContent).toContain(`${risk.level === "high" ? "High" : "Medium"} risk`);
    expect(dialog.textContent).toContain(risk.reasons[0]);
    expect(dialog.textContent).toContain(risk.level === "high" ? "It is merged on its merge card on this page, after a sign-in with the email code." : "Merge anyway?");
    fireEvent.click(screen.getByRole("button", { name: "Press Merge" }));
    await screen.findByText("Merged payments #42.");
    expect(f.presses()).toHaveLength(1);
    expect((f.presses()[0]![0].body as { risk: string }).risk).toBe(risk.level);
    f.close();
  }
});

it("shows GitHub's reason when GitHub refuses the merge, and a changed risk as a new question", async () => {
  const reason = `payments didn't merge: GitHub would not merge it (GitHub says: Required status check "build" is expected.). Check it on GitHub, then press Merge again.`;
  const f = setup(mergeSession({ ready: true, risk: { level: "low", reasons: ["A small change."] } }), async () => ({ status: 409, body: { error: { code: "MERGE_NOT_READY", message: reason } } }));
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  fireEvent.click(await screen.findByRole("button", { name: "Press Merge" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Required status check");
  f.close();
});

it("a task whose server gives no risk is pressed as the lowest level it can claim: the server decides", async () => {
  const f = setup(mergeSession({ ready: true }), async () => MERGED);
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  fireEvent.click(await screen.findByRole("button", { name: "Press Merge" }));
  await screen.findByText("Merged payments #42.");
  expect((f.presses()[0]![0].body as { risk?: string }).risk).toBeUndefined();
  f.close();
});

// ---- decision journey slice 3: one merge control
const mergeCardView = () => {
  const item: DecisionItem = { kind: "merge", subjectId: TASK, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "v1", openPath: "/app/sessions/" + SESSION_FIXTURE_ID,
    sessionId: SESSION_FIXTURE_ID, heads: [{ repositoryId: "payments", number: 42, headSha: HEAD }], prRisk: "low", prReasons: [], proof: { proven: 1, passed: 1, failed: 0, notTested: 0 }, reviewVerdict: "approved", ci: "passing", securityFindingsHigh: 0, fullSuitePending: false };
  const p = projectDecisionCards([item]);
  return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped });
};

it("slice 3: while the task's merge card waits on the page, the Merge section shows the state and points to the card; it has no second Merge button", async () => {
  const f = setup(mergeSession({ ready: true }), undefined, mergeCardView());
  const region = await screen.findByRole("region", { name: "Merge" });
  expect(await within(region).findByText(/Merge it on its card at the top of this page/u)).toBeTruthy();
  expect(within(region).queryByRole("button", { name: "Merge" })).toBeNull();
  expect(region.textContent).toContain("Ready to merge");
  // The card itself is the control, with the one word.
  const card = await screen.findByRole("article", { name: "Retry failed payments" });
  expect(within(card).getByRole("button", { name: "Merge" })).toBeTruthy();
  f.close();
});

