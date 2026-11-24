// @vitest-environment jsdom
// CLOUD-WORDING (hosts): a setup run that stopped on websites (`stop: "hosts_waiting"`) says WHY in words true for that cause (rule #14). A website decision still open is "waiting for an administrator";
// a run that ended on a limit (too many website requests for one run, or the longest wait) has nothing waiting, and must not say it is. The cause is read from the run's website requests; with no readable list
// (an older Code, a failed read) the words are the ones true of every cause.
import { expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { SetupRunRow } from "../../packages/ui/src/screens/setup/SetupRunRow.js";
import { OnboardScreen } from "../../packages/ui/src/screens/onboarding/OnboardScreen.js";
import { HOSTS_STOP_WORDS, STOP_WORDS, hostsStopCause, hostsStopWords } from "../../packages/ui/src/screens/setup/words.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const OPEN = [{ host: "registry.example-build.io", status: "open", journalN: 1 }];
const DECIDED = [{ host: "registry.example-build.io", status: "approved", journalN: 1 }, { host: "cdn.example-files.net", status: "refused", journalN: 2 }];

it("each cause has its own sentence: an open decision, a limit reached, and the words true of both when the cause is unknown", () => {
  expect(hostsStopWords(OPEN)).toBe("A website decision is still open: allow it, then run the setup again to include it.");
  expect(hostsStopWords([...DECIDED, ...OPEN])).toBe(HOSTS_STOP_WORDS.decisionOpen);
  expect(hostsStopWords(DECIDED)).toBe(HOSTS_STOP_WORDS.limitReached);
  expect(HOSTS_STOP_WORDS.limitReached).toMatch(/reached its limit/u);
  expect(HOSTS_STOP_WORDS.limitReached).toMatch(/No website decision is open now/u);
  expect(HOSTS_STOP_WORDS.decisionOpen).not.toMatch(/limit/u);
  expect(new Set([HOSTS_STOP_WORDS.decisionOpen, HOSTS_STOP_WORDS.limitReached, HOSTS_STOP_WORDS.unknown]).size).toBe(3);
});
it("an older Code (no list of website requests), an empty list or an unreadable one gives the fallback, which claims neither cause", () => {
  expect(hostsStopCause(undefined)).toBe("unknown");
  expect(hostsStopCause([])).toBe("unknown");
  expect(hostsStopWords(undefined)).toBe(HOSTS_STOP_WORDS.unknown);
  expect(HOSTS_STOP_WORDS.unknown).toBe(STOP_WORDS.hosts_waiting);
  expect(HOSTS_STOP_WORDS.unknown).not.toMatch(/No website decision is open/u);
  expect(HOSTS_STOP_WORDS.unknown).not.toMatch(/is still open:/u);
});

const LIMITS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
const SUMMARY = { stop: "hosts_waiting", commandsRun: 4, spendCents: 20, elapsedMs: 180_000, hostAsks: 1, partial: true };
const me = { developer: { id: "a".repeat(64), name: "Maya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "cloud", nameIsDefault: false }, identities: [] };
const project = () => ({
  name: "web", description: "Customer fixes", status: "active", latestRevision: 2, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole: "maintainer",
  setup: { status: "unchecked" }, settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] }, createdAt: "2026-10-23T12:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya" },
});
function mount(run: Record<string, unknown>, journal: { status: number; body?: unknown }) {
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/me") return { status: 200, body: me };
    if (request.path === "/v1/app/github/installations") return { status: 200, body: { installations: [] } };
    if (request.path === "/v1/app/projects/web") return { status: 200, body: project() };
    if (request.path === "/v1/app/projects/web/setup-draft") return { status: 200, body: { status: "none", basedOnRevision: 2, requestId: "g" } };
    if (request.path === "/v1/app/projects/web/test-environment") return { status: 404, body: { error: { code: "NOT_FOUND", message: "This item wasn't found." } } };
    if (request.path === "/v1/app/projects/web/setup-agent" && request.method === "GET") return { status: 200, body: { status: "ready", basedOnRevision: 2, limits: LIMITS, ...run, requestId: "gw" } };
    if (request.path === "/v1/app/projects/web/setup-agent/journal") return journal.status === 200 ? { status: 200, body: { ...(journal.body as object), requestId: "gw" } } : { status: journal.status, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "The project's setup couldn't be read just now. Try again." } } };
    return { status: 200, body: { project: project(), warnings: [] } };
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/onboard?project=web&step=setup"], children: h(OnboardScreen) }) }) }));
  return { ...f, close() { ui.unmount(); query.clear(); } };
}
const region = async () => screen.findByRole("region", { name: "Set up with Rovara" });
const journal = (hostAsks: unknown[]) => ({ status: 200, body: { status: "ready", entries: [], hostAsks } });
const READY = { status: "ready", stop: "hosts_waiting", summary: SUMMARY };

it("the Setup screen: a run that stopped with a decision still open says it is waiting for that decision", async () => {
  const f = mount(READY, journal(OPEN));
  const section = await region();
  await waitFor(() => expect(within(section).getByTestId("hosts-stop").textContent).toBe(HOSTS_STOP_WORDS.decisionOpen));
  f.close();
});
it("the Setup screen: a run that ended on a limit, every request decided, says it hit a limit and that nothing is waiting", async () => {
  const f = mount(READY, journal(DECIDED));
  const section = await region();
  await waitFor(() => expect(within(section).getByTestId("hosts-stop").textContent).toBe(HOSTS_STOP_WORDS.limitReached));
  expect(within(section).queryByText(/still open:/u)).toBeNull();
  f.close();
});
it("the Setup screen: a failed run that stopped on websites uses the cause words, not Code's one sentence", async () => {
  const f = mount({ status: "failed", stop: "hosts_waiting", failure: "The setup run ended while waiting for a website decision (it waits at most 24 hours). Allow the website, then run the setup again.", summary: SUMMARY }, journal(DECIDED));
  const section = await region();
  await waitFor(() => expect(within(section).getByTestId("hosts-stop").textContent).toBe(HOSTS_STOP_WORDS.limitReached));
  expect(within(section).queryByText(/waiting for a website decision/u)).toBeNull();
  f.close();
});
it("the Setup screen: when the website requests cannot be read the words claim neither cause", async () => {
  const f = mount(READY, { status: 503 });
  const section = await region();
  await waitFor(() => expect(within(section).getByTestId("hosts-stop").textContent).toBe(HOSTS_STOP_WORDS.unknown));
  f.close();
});
it("the Setup screen: a run that stopped for any other reason keeps its own words", async () => {
  const f = mount({ status: "ready", stop: "time_used", summary: { ...SUMMARY, stop: "time_used" } }, journal(OPEN));
  const section = await region();
  expect(await within(section).findByText(STOP_WORDS.time_used)).toBeTruthy();
  expect(within(section).queryByTestId("hosts-stop")).toBeNull();
  f.close();
});

// ---- the project checklist's Setup run row says the same ----
function mountRow(row: Record<string, unknown>, journal: { status: number; body?: unknown }) {
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/projects/web/setup-agent") return { status: 200, body: { status: row["status"], basedOnRevision: 2, limits: LIMITS, canManage: false } };
    if (request.path === "/v1/app/projects/web/setup-agent/journal") return journal.status === 200 ? { status: 200, body: journal.body } : { status: journal.status, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "No." } } };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  });
  const query = createQueryClient();
  const run = { state: row["status"] === "failed" ? "failed" : "needs_you", approval: "none", ...row };
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(SetupRunRow, { project: "web", row: run as never, onChanged: () => undefined }) }) }) }), { theme: "light" });
  return { ...f, close() { ui.unmount(); query.clear(); } };
}
const CODE_SENTENCE = "The setup run ended: it needs websites an administrator has not allowed yet (it waits at most 2 hours for a decision). Allow them, then run the setup again.";
it("the checklist row: a failed run that stopped on websites says the cause, in place of Code's one sentence", async () => {
  const f = mountRow({ status: "failed", stop: "hosts_waiting", failure: CODE_SENTENCE }, journal(DECIDED));
  await waitFor(() => expect(screen.getByTestId("setup-run-hosts-stop").textContent).toBe(HOSTS_STOP_WORDS.limitReached));
  expect(screen.queryByTestId("setup-run-failure")).toBeNull();
  f.close();
  const open = mountRow({ status: "failed", stop: "hosts_waiting", failure: CODE_SENTENCE }, journal(OPEN));
  await waitFor(() => expect(screen.getByTestId("setup-run-hosts-stop").textContent).toBe(HOSTS_STOP_WORDS.decisionOpen));
  open.close();
});
it("the checklist row: a ready run with a partial setup that stopped on websites says the cause; an unreadable list gives the fallback", async () => {
  const f = mountRow({ status: "ready", stop: "hosts_waiting", partial: true }, journal(OPEN));
  await waitFor(() => expect(screen.getByTestId("setup-run-hosts-stop").textContent).toBe(HOSTS_STOP_WORDS.decisionOpen));
  f.close();
  const unknown = mountRow({ status: "ready", stop: "hosts_waiting", partial: true }, { status: 503 });
  await waitFor(() => expect(screen.getByTestId("setup-run-hosts-stop").textContent).toBe(HOSTS_STOP_WORDS.unknown));
  unknown.close();
});
it("the checklist row: any other failure keeps Code's own sentence and no website line", async () => {
  const f = mountRow({ status: "failed", stop: "time_used", failure: "Rovara ran out of time before the setup worked. It kept what it learned." }, journal(DECIDED));
  expect((await screen.findByTestId("setup-run-failure")).textContent).toContain("ran out of time");
  expect(screen.queryByTestId("setup-run-hosts-stop")).toBeNull();
  f.close();
});
