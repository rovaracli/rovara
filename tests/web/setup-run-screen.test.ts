// @vitest-environment jsdom
// SH15: the Setup step's run of Rovara's own. Nothing at all while the feature is off; start and stop; the journal and the websites it asked for; steer and a command; and "Use this setup", which PROPOSES the ticked
// commands and says nothing is applied until they pass on a fresh machine and are approved in the test environment. An item that does not match the code cannot be used.
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { OnboardScreen } from "../../packages/ui/src/screens/onboarding/OnboardScreen.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const COMMIT = "a".repeat(40);
const TASK = "11111111-1111-4111-8111-111111111111";
const me = { developer: { id: "a".repeat(64), name: "Maya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "cloud", nameIsDefault: false }, identities: [] };
const project = () => ({
  name: "web", description: "Customer fixes", status: "active", latestRevision: 2, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole: "maintainer",
  setup: { status: "unchecked" }, settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] }, createdAt: "2026-10-23T12:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya" },
});
const file = (path: string, line: number, quote: string) => ({ kind: "file", repo: "web", path, commit: COMMIT, line, quote });
const item = <V,>(id: string, value: V, from: unknown[]) => ({ id, value, from, confidence: "high", risk: "safe" });
const PROPOSAL = {
  version: 2, basedOnRevision: 2, repositories: [],
  setup: [item("setup-web", { repo: "web", commands: ["npm ci"] }, [file("package.json", 3, "\"ci\": \"npm ci\"")])],
  tests: [item("tests-web", { repo: "web", commands: ["npm test"] }, [file("package.json", 4, "\"test\": \"npm test\"")])],
  checks: [], testEnvironment: [], knowledge: [], sources: [], intake: [], allowedDomains: [], secretsNeeded: [], flaggedCommands: [], foundNotUsed: [], notes: "",
};
const LIMITS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
const view = (over: Record<string, unknown> = {}) => ({ status: "none", basedOnRevision: 2, limits: LIMITS, ...over });
const SUMMARY = { stop: "proposed", commandsRun: 9, spendCents: 120, elapsedMs: 480_000, hostAsks: 0, partial: false };
const ENTRY = { n: 1, source: "agent", command: "npm ci", exitCode: 1, durationMs: 4_000, timedOut: false, flagged: false, blockedHosts: ["registry.example-build.io"], tail: "ERR! network", startedAt: "2026-11-02T12:00:00.000Z" };

interface Options { read?: { status: number; body: unknown }; journal?: unknown; answers?: Record<string, { status: number; body: unknown }> }
function setup(options: Options = {}) {
  let current = options.read ?? { status: 200, body: view() };
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/me") return { status: 200, body: me };
    if (request.path === "/v1/app/github/installations") return { status: 200, body: { installations: [] } };
    if (request.path === "/v1/app/projects/web") return { status: 200, body: project() };
    if (request.path === "/v1/app/projects/web/setup-draft") return { status: 200, body: { status: "none", basedOnRevision: 2, requestId: "g" } };
    if (request.path === "/v1/app/projects/web/test-environment") return { status: 404, body: { error: { code: "NOT_FOUND", message: "This item wasn't found." } } };
    if (request.path === "/v1/app/projects/web/setup-agent" && request.method === "GET") return { status: current.status, body: current.status === 200 ? { ...(current.body as object), requestId: "gw" } : current.body };
    if (request.path === "/v1/app/projects/web/setup-agent/journal") return { status: 200, body: { ...((options.journal ?? { status: "running", entries: [], hostAsks: [] })), requestId: "gw" } };
    const answer = options.answers?.[request.path.replace("/v1/app/projects/web/setup-agent", "") || "/"];
    if (answer !== undefined) {
      if (answer.status === 200 && request.path.endsWith("/setup-agent") || request.path.endsWith("/stop")) current = { status: 200, body: answer.body };
      return { status: answer.status, body: answer.status === 200 ? { ...(answer.body as object), requestId: "gw2" } : answer.body };
    }
    if (request.path.startsWith("/v1/app/sessions/")) return { status: 200, body: { requestId: "x" } };
    return { status: 200, body: { project: project(), warnings: [] } };
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/onboard?project=web&step=setup"], children: h(OnboardScreen) }) }) }));
  return { ...f, close() { ui.unmount(); query.clear(); } };
}
const posts = (f: ReturnType<typeof setup>, suffix: string) => f.request.mock.calls.map(([r]) => r).filter((r) => r.method === "POST" && r.path.endsWith(suffix));
const region = async () => screen.findByRole("region", { name: "Set up with Rovara" });

it("shows nothing at all while the feature is off (the server answers not found)", async () => {
  const f = setup({ read: { status: 404, body: { error: { code: "NOT_FOUND", message: "This item wasn't found." } } } });
  await screen.findByRole("heading", { name: "Setup" });
  await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/setup-agent"))).toBe(true));
  expect(screen.queryByRole("region", { name: "Set up with Rovara" })).toBeNull();
  expect(screen.queryByText("Set up with Rovara")).toBeNull();
  f.close();
});

it("offers to run the setup, and starts it with a request id of its own", async () => {
  const f = setup({ answers: { "/": { status: 200, body: view({ status: "running", taskId: TASK, startedAt: "2026-11-02T12:00:00.000Z" }) } } });
  const section = await region();
  fireEvent.click(within(section).getByRole("button", { name: "Let Rovara run the setup" }));
  await waitFor(() => expect(posts(f, "/setup-agent")).toHaveLength(1));
  expect(Object.keys(posts(f, "/setup-agent")[0]!.body as object)).toEqual(["requestId"]);
  expect(await within(section).findByRole("button", { name: "Stop" })).toBeTruthy();
  f.close();
});

it("while it runs: shows the journal as quoted text, the websites it asked for, steer and a command box, and stops on request", async () => {
  const f = setup({
    read: { status: 200, body: view({ status: "running", taskId: TASK, sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", startedAt: "2026-11-02T12:00:00.000Z" }) },
    journal: { status: "running", entries: [ENTRY], hostAsks: [{ host: "registry.example-build.io", status: "open", journalN: 1 }] },
    answers: { "/stop": { status: 200, body: view({ status: "failed", stop: "stopped_by_person", failure: "You stopped this run.", taskId: TASK }) }, "/command": { status: 200, body: { seq: 1, state: "queued" } } },
  });
  const section = await region();
  expect(await within(section).findByText("npm ci")).toBeTruthy();
  expect(within(section).getByText("Exit 1")).toBeTruthy();
  expect(within(section).getByText(/Waiting for an administrator to decide/u)).toBeTruthy();
  expect(within(section).getAllByText("registry.example-build.io").length).toBeGreaterThan(0);
  fireEvent.change(within(section).getByLabelText("Run a command in the sandbox"), { target: { value: "ls -la" } });
  fireEvent.click(within(section).getByRole("button", { name: "Run" }));
  await waitFor(() => expect(posts(f, "/setup-agent/command")).toHaveLength(1));
  expect(posts(f, "/setup-agent/command")[0]!.body).toMatchObject({ command: "ls -la" });
  fireEvent.change(within(section).getByLabelText("Tell Rovara how to set it up"), { target: { value: "Use pnpm, not npm" } });
  fireEvent.click(within(section).getByRole("button", { name: "Send to Rovara" }));
  await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.method === "POST" && r.path === "/v1/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa/messages")).toBe(true));
  const steer = f.request.mock.calls.map(([r]) => r).find((r) => r.path.endsWith("/messages"))!;
  expect(steer.body).toMatchObject({ kind: "steer", text: "Use pnpm, not npm" });
  fireEvent.click(within(section).getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(posts(f, "/setup-agent/stop")).toHaveLength(1));
  await expectNoAxeViolations(section);
  f.close();
});

it("with no session there is no steer box, and the command box is only for a run that is going", async () => {
  const f = setup({ read: { status: 200, body: view({ status: "running", taskId: TASK }) } });
  const section = await region();
  expect(within(section).queryByLabelText("Tell Rovara how to set it up")).toBeNull();
  expect(within(section).getByLabelText("Run a command in the sandbox")).toBeTruthy();
  f.close();
  const done = setup({ read: { status: 200, body: view({ status: "ready", stop: "proposed", summary: SUMMARY, proposal: PROPOSAL, verified: true, verification: { "setup-web": "verified", "tests-web": "verified" }, taskId: TASK }) } });
  const finished = await region();
  expect(within(finished).queryByLabelText("Run a command in the sandbox")).toBeNull();
  done.close();
});

const READY = view({ status: "ready", stop: "proposed", summary: SUMMARY, proposal: PROPOSAL, verified: true, taskId: TASK, verification: { "setup-web": "verified", "tests-web": "unverified" } });
const REPLY = { digest: "b".repeat(64), used: ["setup-web"], unchecked: [], left: [], proved: false, next: "apply_commands" };

it("Use this setup: an item that does not match the code cannot be ticked; the rest is proposed, nothing is applied, and the page says what must happen first", async () => {
  const f = setup({ read: { status: 200, body: READY }, answers: { "/confirm": { status: 200, body: REPLY } } });
  const section = await region();
  const card = await within(section).findByRole("region", { name: "Use this setup" });
  expect(within(card).getByText(/saves it as a proposal in the test environment below; it does not change the project's settings/u)).toBeTruthy();
  expect(within(card).queryByText(/Nothing is saved until/u)).toBeNull();
  expect(within(card).getByText("Does not match the code")).toBeTruthy();
  const boxes = within(card).getAllByRole<HTMLInputElement>("checkbox");
  expect(boxes).toHaveLength(2);
  expect(boxes[0]!.checked).toBe(true);
  expect(boxes[1]!.disabled).toBe(true);
  expect(boxes[1]!.checked).toBe(false);
  fireEvent.click(within(card).getByRole("button", { name: "Use this setup" }));
  await waitFor(() => expect(posts(f, "/setup-agent/confirm")).toHaveLength(1));
  expect(posts(f, "/setup-agent/confirm")[0]!.body).toMatchObject({ expectedRevision: 2, itemIds: ["setup-web"] });
  expect(await within(card).findByText(/Saved as a proposal\. Approve it in the test environment below, after a passing proof/u)).toBeTruthy();
  // Nothing was applied by it: no settings save, no setup check, no draft apply.
  expect(f.request.mock.calls.map(([r]) => r).filter((r) => r.method !== "GET" && !r.path.endsWith("/setup-agent/confirm"))).toEqual([]);
  await expectNoAxeViolations(section);
  f.close();
});

it("only what the code host confirmed is ticked to begin with: an item that could not be checked against a file waits for the person to tick it", async () => {
  const unchecked = { ...READY, verification: { "setup-web": "verified", "tests-web": "unchecked" } };
  const f = setup({ read: { status: 200, body: unchecked }, answers: { "/confirm": { status: 200, body: { ...REPLY, used: ["setup-web", "tests-web"] } } } });
  const card = await within(await region()).findByRole("region", { name: "Use this setup" });
  const boxes = within(card).getAllByRole<HTMLInputElement>("checkbox");
  expect([boxes[0]!.checked, boxes[1]!.checked]).toEqual([true, false]);
  expect(boxes[1]!.disabled).toBe(false);
  fireEvent.click(boxes[1]!);
  fireEvent.click(within(card).getByRole("button", { name: "Use this setup" }));
  await waitFor(() => expect(posts(f, "/setup-agent/confirm")).toHaveLength(1));
  expect(posts(f, "/setup-agent/confirm")[0]!.body).toMatchObject({ itemIds: ["setup-web", "tests-web"] });
  f.close();
});

it("Use this setup waits for the re-read of the citations: it can't be pressed until the server says they are checked", async () => {
  const f = setup({ read: { status: 200, body: { ...READY, verified: false } } });
  const card = await within(await region()).findByRole("region", { name: "Use this setup" });
  expect(within(card).getByText(/still checking where each suggestion came from/u)).toBeTruthy();
  expect(within(card).getByRole<HTMLButtonElement>("button", { name: "Use this setup" }).disabled).toBe(true);
  f.close();
});

it("says what the server refused in its own words", async () => {
  const f = setup({ read: { status: 200, body: READY }, answers: { "/confirm": { status: 400, body: { error: { code: "CONFIG_INVALID", message: "None of the suggestions can be used." } } } } });
  const card = await within(await region()).findByRole("region", { name: "Use this setup" });
  fireEvent.click(within(card).getByRole("button", { name: "Use this setup" }));
  expect(await within(card).findByText("None of the suggestions can be used.")).toBeTruthy();
  f.close();
});
