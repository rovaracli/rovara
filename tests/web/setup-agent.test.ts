// @vitest-environment jsdom
// Meta repo lane B, task B4: onboarding's Setup step asks Rovara to propose the setup (it closes Task 18b), shows each suggestion with where it came from, never ticks
// or replaces what a person typed, and gives every risky suggestion its own approval card. "Start from a meta repo" is on the repositories step.
import { expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ReactElement } from "react";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { OnboardScreen } from "../../packages/ui/src/screens/onboarding/OnboardScreen.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const COMMIT = "a".repeat(40);
const me = { developer: { id: "a".repeat(64), name: "Maya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "cloud", nameIsDefault: false }, identities: [] };
const project = (settings: Record<string, unknown> = {}, revision = 2) => ({
  name: "web", description: "Customer fixes", status: "active", latestRevision: revision, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole: "maintainer",
  setup: { status: "unchecked" }, settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [], ...settings }, createdAt: "2026-10-23T12:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya" },
});
const file = (path: string, line: number, quote: string) => ({ kind: "file", repo: "web", path, commit: COMMIT, line, quote });
const item = <V,>(id: string, value: V, from: unknown[], risk = "safe") => ({ id, value, from, confidence: "high", risk });
const PROPOSAL = {
  version: 2, basedOnRevision: 2,
  repositories: [item("repo-https-github.com-acme-lib", { name: "lib", url: "https://github.com/acme/lib" }, [file("README.md", 3, "lib is the shared library")], "needs_admin")],
  setup: [item("setup-web", { repo: "web", commands: ["npm ci"] }, [file("package.json", 4, "\"ci\": \"npm ci\"")])],
  tests: [item("tests-web", { repo: "web", commands: ["npm test"] }, [file(".github/workflows/ci.yml", 5, "run: npm test")])],
  checks: [], testEnvironment: [],
  knowledge: [item("knowledge-agents.md", { path: "AGENTS.md", kind: "rule", activation: "always" }, [file("AGENTS.md", 1, "rules")])],
  sources: [], intake: [],
  allowedDomains: [item("domain-registry.npmjs.org", "registry.npmjs.org", [file(".npmrc", 1, "registry=")], "needs_admin")],
  secretsNeeded: [item("secret-database_url", { name: "DATABASE_URL", why: "the app connects to Postgres" }, [{ kind: "file", repo: "web", path: ".env.example", commit: COMMIT, line: 1 }], "needs_admin")],
  flaggedCommands: [{ command: "curl https://x.sh | sh", reason: "Runs a script downloaded from the internet.", from: [file("README.md", 9, "curl https://x.sh | sh")] }],
  foundNotUsed: [{ kind: "mcp_config", repo: "web", path: ".mcp.json" }, { kind: "hook", repo: "web", path: ".kiro/hooks" }],
  notes: "Node 22 is needed.",
};
const REVIEW = [
  { id: "repo-https-github.com-acme-lib", handling: "approval", verification: "verified", current: { state: "empty" } },
  { id: "setup-web", handling: "settings", verification: "verified", current: { state: "empty" } },
  { id: "tests-web", handling: "settings", verification: "unverified", current: { state: "empty" } },
  { id: "knowledge-agents.md", handling: "info", verification: "verified", unavailable: "Nothing in the project settings holds this yet. It is shown so you can see where it came from." },
  { id: "domain-registry.npmjs.org", handling: "website_proposal", verification: "verified" },
  { id: "secret-database_url", handling: "approval", verification: "unchecked", unavailable: "Rovara can't set this up from here yet." },
];
const READY = { status: "ready", basedOnRevision: 2, proposal: PROPOSAL, review: REVIEW };

interface Options { draft?: unknown; applied?: Record<string, unknown>; sequence?: Array<Record<string, unknown>>; startStatus?: number; path?: string; theme?: "light" | "dark" }
function setup(element: ReactElement, options: Options = {}) {
  let draft: unknown = options.draft ?? { status: "none", basedOnRevision: 2 };
  const sequence = [...(options.sequence ?? [])];
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/me") return { status: 200, body: me };
    if (request.path === "/v1/app/github/installations") return { status: 200, body: { installations: [{ installationId: 55, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", status: "active" }] } };
    if (request.path.startsWith("/v1/app/github/repositories")) return { status: 200, body: { repositories: [{ fullName: "acme/web", githubRepositoryId: 101, private: true, defaultBranch: "main" }, { fullName: "acme/meta", githubRepositoryId: 102, private: true, defaultBranch: "main" }, { fullName: "acme/api", githubRepositoryId: 103, private: true, defaultBranch: "main" }] } };
    if (request.path === "/v1/app/projects/web") return { status: 200, body: project() };
    if (request.path === "/v1/app/projects/web/setup-draft" && request.method === "GET") return { status: 200, body: { ...(draft as object), requestId: "gateway-1" } };
    if (request.path === "/v1/app/projects/web/setup-draft" && request.method === "POST") { draft = { status: "drafting", basedOnRevision: 2 }; return { status: options.startStatus ?? 202, body: { ...(draft as object), requestId: "gateway-2" } }; }
    if (request.path === "/v1/app/projects/web/setup-draft/apply") return { status: 200, body: { project: project({ setupCommands: ["npm ci"] }, 3), warnings: [], setupCheck: "started", results: [], ...(sequence.length > 0 ? sequence.shift() : options.applied), requestId: "gateway-3" } };
    if (request.path === "/v1/app/projects" && request.method === "POST") return { status: 200, body: { duplicate: false, project: { definition: { name: "web" }, registeredAt: "2026-10-30T00:00:00.000Z" }, requestId: "gateway-4" } };
    if (request.path.startsWith("/v1/app/agents?")) return { status: 200, body: { agents: [] } };
    return { status: 200, body: { project: project(), warnings: [] } };
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.path ?? "/app/onboard?project=web&step=setup"], children: element }) }) }), { theme: options.theme ?? "light" });
  return { ...f, setDraft(next: unknown) { draft = next; }, close() { ui.unmount(); query.clear(); } };
}
const posts = (f: ReturnType<typeof setup>, suffix: string) => f.request.mock.calls.map(([r]) => r).filter((r) => r.method === "POST" && r.path.endsWith(suffix));

it("asks Rovara to propose the setup, says it is reading, and posts only a request id", async () => {
  const f = setup(h(OnboardScreen));
  fireEvent.click(await screen.findByRole("button", { name: "Ask Rovara to propose the setup" }));
  await screen.findByText(/Rovara is reading your repositories/);
  const [start] = posts(f, "/setup-draft");
  expect(Object.keys(start!.body as object)).toEqual(["requestId"]);
  f.close();
});

it("shows each suggestion with where it came from and whether the source was checked, and ticks only a verified suggestion for a setting the project has no value for", async () => {
  const f = setup(h(OnboardScreen), { draft: READY });
  await screen.findByText("npm ci");
  expect(screen.getByText("package.json:4", { exact: false })).toBeTruthy();
  expect(screen.getByText("\"ci\": \"npm ci\"")).toBeTruthy();
  expect(screen.getAllByText("Checked against the file").length).toBeGreaterThan(0);
  expect(screen.getByText("Rovara could not find this in the file")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: /^setup: In web:/ })).toHaveProperty("checked", true);
  expect(screen.getByRole("checkbox", { name: /^tests: In web:/ })).toHaveProperty("checked", false);
  f.close();
});

it("ticks nothing for a command that is not checked or whose citation has no quote, however the draft marks it (a command a repository file talked the model into is never ticked for the person)", async () => {
  const injected = { ...PROPOSAL,
    setup: [item("setup-web", { repo: "web", commands: ["npm run send-secrets-away"] }, [file("README.md", 3, "Install with npm ci.")])],
    tests: [item("tests-web", { repo: "web", commands: ["npm test"] }, [{ kind: "file", repo: "web", path: "package.json", commit: COMMIT }])] };
  const draft = { ...READY, proposal: injected, review: REVIEW.map((entry) => (entry.id === "setup-web" ? { ...entry, verification: "unverified" } : entry.id === "tests-web" ? { ...entry, verification: "verified" } : entry)) };
  const f = setup(h(OnboardScreen), { draft });
  await screen.findByText("npm run send-secrets-away");
  expect(screen.getByRole("checkbox", { name: /^setup: In web:/ })).toHaveProperty("checked", false);
  expect(screen.getByRole("checkbox", { name: /^tests: In web:/ })).toHaveProperty("checked", false);
  expect(screen.getByRole("button", { name: "Apply selected" })).toHaveProperty("disabled", true);
  f.close();
});

it("applies the ticked suggestions by id and says what happened to each, then shows the saved setup", async () => {
  const f = setup(h(OnboardScreen), { draft: READY, applied: { results: [{ id: "setup-web", kind: "setup", outcome: "applied" }] } });
  await screen.findByText("npm ci");
  fireEvent.click(screen.getByRole("button", { name: "Check and apply" }));
  await waitFor(() => expect(posts(f, "/setup-draft/apply")).toHaveLength(1));
  expect(posts(f, "/setup-draft/apply")[0]!.body).toMatchObject({ expectedRevision: 2, items: [{ id: "setup-web" }] });
  expect(JSON.stringify(posts(f, "/setup-draft/apply")[0]!.body)).not.toContain("useSuggestion");
  await screen.findByText("Applied.");
  await waitFor(() => expect(screen.getByLabelText("Setup commands")).toHaveProperty("value", "npm ci"));
  f.close();
});

const CHECKING = { id: "setup-web", kind: "setup", outcome: "checking", message: "Rovara is running these commands on a fresh machine. Nothing is saved until they pass." };

/** The page asks again every ten seconds while a check runs; a test does not wait for that. */
function quickPolling() {
  const real = globalThis.setTimeout;
  return vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => real(handler, ms === 10_000 ? 0 : ms, ...args)) as typeof setTimeout);
}

it("Check and apply: says the commands are being checked on a fresh machine, saves nothing meanwhile, asks again with the same request until the check has finished, then shows the saved setup", async () => {
  const quick = quickPolling();
  const f = setup(h(OnboardScreen), { draft: READY, sequence: [{ results: [CHECKING] }, { results: [CHECKING] }, { project: project({ setupCommands: ["npm ci"] }, 3), results: [{ id: "setup-web", kind: "setup", outcome: "applied" }] }] });
  await screen.findByText("npm ci");
  fireEvent.click(screen.getByRole("button", { name: "Check and apply" }));
  await screen.findByText("Rovara is running these commands on a fresh machine. Nothing is saved until they pass.");
  expect(screen.getByLabelText("Setup commands")).toHaveProperty("value", "");
  await screen.findByText("Applied.");
  const sent = posts(f, "/setup-draft/apply");
  expect(sent).toHaveLength(3);
  expect(new Set(sent.map((request) => (request.body as { requestId: string }).requestId)).size).toBe(1);
  expect(new Set(sent.map((request) => JSON.stringify((request.body as { items: unknown }).items))).size).toBe(1);
  await waitFor(() => expect(screen.getByLabelText("Setup commands")).toHaveProperty("value", "npm ci"));
  quick.mockRestore();
  f.close();
});

it("Check and apply: a check that fails shows the reason, saves nothing, stops asking, and a new press is a new request", async () => {
  const quick = quickPolling();
  const failed = { id: "setup-web", kind: "setup", outcome: "check_failed", message: "These commands did not pass the check on a fresh machine, so nothing was saved.", reason: "setup: npm ci - exited 1: boom" };
  const f = setup(h(OnboardScreen), { draft: READY, sequence: [{ project: project({}, 2), results: [CHECKING] }, { project: project({}, 2), results: [failed] }, { project: project({}, 2), results: [failed] }, { project: project({}, 2), results: [CHECKING] }] });
  await screen.findByText("npm ci");
  fireEvent.click(screen.getByRole("button", { name: "Check and apply" }));
  await screen.findByText("These commands did not pass the check on a fresh machine, so nothing was saved.");
  expect((await screen.findByRole("alert")).textContent).toContain("setup: npm ci - exited 1: boom");
  expect(screen.getByLabelText("Setup commands")).toHaveProperty("value", "");
  await waitFor(() => expect(screen.getByRole("button", { name: "Check and apply" })).toHaveProperty("disabled", false));
  expect(posts(f, "/setup-draft/apply")).toHaveLength(2);
  // Pressing the main button again is not a new check; "Check again" is, and says so.
  fireEvent.click(screen.getByRole("button", { name: "Check and apply" }));
  await waitFor(() => expect(posts(f, "/setup-draft/apply").length).toBeGreaterThanOrEqual(3));
  expect(JSON.stringify(posts(f, "/setup-draft/apply")[2]!.body)).not.toContain("checkAgain");
  fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
  await waitFor(() => expect(posts(f, "/setup-draft/apply").length).toBeGreaterThanOrEqual(4));
  const sent = posts(f, "/setup-draft/apply");
  expect(sent[3]!.body).toMatchObject({ checkAgain: true });
  expect((sent[3]!.body as { requestId: string }).requestId).not.toBe((sent[0]!.body as { requestId: string }).requestId);
  quick.mockRestore();
  f.close();
});

it("never ticks or replaces a value the person typed: it says what they have, and replaces it only with that item's own tick", async () => {
  const typed = { ...READY, review: REVIEW.map((entry) => (entry.id === "tests-web" ? { ...entry, verification: "verified", current: { state: "differs", yours: ["make old-test"] } } : entry)) };
  const f = setup(h(OnboardScreen), { draft: typed });
  await screen.findByText("You have: make old-test");
  expect(screen.getByText("Rovara suggests: npm test")).toBeTruthy();
  const tests = screen.getByRole("checkbox", { name: /^tests: In web:/ });
  expect(tests).toHaveProperty("checked", false);
  fireEvent.click(screen.getByRole("checkbox", { name: /^Use Rovara's for tests/ }));
  expect(tests).toHaveProperty("checked", true);
  fireEvent.click(screen.getByRole("button", { name: "Check and apply" }));
  await waitFor(() => expect(posts(f, "/setup-draft/apply")).toHaveLength(1));
  expect(posts(f, "/setup-draft/apply")[0]!.body).toMatchObject({ items: [{ id: "setup-web" }, { id: "tests-web", useSuggestion: true }] });
  f.close();
});

it("says a value Rovara suggested earlier is its own (no \"Use Rovara's\" tick is needed), and offers no tick for a setting the meta repo's file manages", async () => {
  const review = REVIEW.map((entry) => (entry.id === "tests-web" ? { ...entry, verification: "verified", current: { state: "differs", yours: ["make old-test"], setBy: "agent" } }
    : entry.id === "setup-web" ? { ...entry, current: { state: "managed_by_file", yours: ["make old-setup"] }, unavailable: "The meta repo's config file manages this setting. Change it there." } : entry));
  const f = setup(h(OnboardScreen), { draft: { ...READY, review } });
  await screen.findByText("Rovara suggested this earlier: make old-test");
  expect(screen.queryByRole("checkbox", { name: /^Use Rovara's for tests/ })).toBeNull();
  expect(screen.queryByText("You have: make old-test")).toBeNull();
  expect(screen.getByText("The meta repo's config file manages this setting. Change it there.")).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: /^setup: In web:/ })).toBeNull();
  f.close();
});

it("gives a risky suggestion its own approval card with its own button, and sends only that item", async () => {
  const f = setup(h(OnboardScreen), { draft: READY, applied: { results: [{ id: "repo-https-github.com-acme-lib", kind: "repository", outcome: "approval_needed", approval: { approvalId: "apr_1", confirmUrl: "https://cell.example/v1/app/approve/apr_1" } }] } });
  const card = await screen.findByRole("group", { name: /^Approval for repository:/ });
  fireEvent.click(within(card).getByRole("button", { name: "Ask for approval" }));
  await waitFor(() => expect(posts(f, "/setup-draft/apply")).toHaveLength(1));
  expect(posts(f, "/setup-draft/apply")[0]!.body).toMatchObject({ items: [{ id: "repo-https-github.com-acme-lib" }] });
  expect((posts(f, "/setup-draft/apply")[0]!.body as { items: unknown[] }).items).toHaveLength(1);
  await screen.findByText("Waiting for an administrator to approve it.");
  f.close();
});

it("opens an approval link only when it is this cell's confirmation page, and offers Apply now once approved", async () => {
  const waiting = { ...READY, review: REVIEW.map((entry) => (entry.id === "repo-https-github.com-acme-lib" ? { ...entry, approval: { approvalId: "apr_1", state: "pending" } } : entry)) };
  const good = setup(h(OnboardScreen), { draft: waiting, applied: { results: [{ id: "repo-https-github.com-acme-lib", kind: "repository", outcome: "approval_needed", approval: { approvalId: "apr_1", confirmUrl: "https://cell.example/v1/app/approve/apr_1" } }] } });
  const card = await screen.findByRole("group", { name: /^Approval for repository:/ });
  expect(within(card).queryByRole("button", { name: "Open approval" })).toBeNull();
  fireEvent.click(within(card).getByRole("button", { name: "Check approval" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open approval" }));
  expect(good.host.openExternal).toHaveBeenCalledWith("https://cell.example/v1/app/approve/apr_1");
  good.close();
  const bad = setup(h(OnboardScreen), { draft: waiting, applied: { results: [{ id: "repo-https-github.com-acme-lib", kind: "repository", outcome: "approval_needed", approval: { approvalId: "apr_1", confirmUrl: "https://evil.example/v1/app/approve/apr_1" } }] } });
  const badCard = await screen.findByRole("group", { name: /^Approval for repository:/ });
  fireEvent.click(within(badCard).getByRole("button", { name: "Check approval" }));
  await screen.findByText("Waiting for an administrator to approve it.");
  expect(screen.queryByRole("button", { name: "Open approval" })).toBeNull();
  bad.close();
  const approved = setup(h(OnboardScreen), { draft: { ...READY, review: REVIEW.map((entry) => (entry.id === "repo-https-github.com-acme-lib" ? { ...entry, approval: { approvalId: "apr_1", state: "approved" } } : entry)) } });
  fireEvent.click(await screen.findByRole("button", { name: "Apply now" }));
  await waitFor(() => expect(posts(approved, "/setup-draft/apply")).toHaveLength(1));
  approved.close();
});

it("sends a website to website access instead of widening it, shows what cannot be set up from here without a control, and lists what it will not propose", async () => {
  const f = setup(h(OnboardScreen), { draft: READY });
  await screen.findByText("npm ci");
  // UX-4b: websites go to the project page's own Allowed websites (a maintainer can open it), not an admin page.
  const link = screen.getByRole("link", { name: "Open Allowed websites on the project page" });
  expect(link.getAttribute("href")).toBe("/app/projects/web#allowed-websites");
  expect(screen.queryByRole("checkbox", { name: /allowed domain/ })).toBeNull();
  expect(screen.getByText("Rovara can't set this up from here yet.")).toBeTruthy();
  expect(screen.queryByRole("group", { name: /^Approval for secret/ })).toBeNull();
  expect(screen.getByText("curl https://x.sh | sh")).toBeTruthy();
  expect(screen.getByText(/cannot be applied/)).toBeTruthy();
  expect(screen.getByText(/found, not connected/)).toBeTruthy();
  expect(screen.getByText(/found, not run/)).toBeTruthy();
  // The knowledge Rovara found is shown with no control.
  expect(screen.getByText("rule: AGENTS.md")).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: /^knowledge/ })).toBeNull();
  f.close();
});

it("shows a hidden character in a repository's text instead of hiding it", async () => {
  const sneaky = { ...READY, proposal: { ...PROPOSAL, setup: [item("setup-web", { repo: "web", commands: ["npm ci‮"] }, [file("package.json", 4, "ci")])] } };
  const f = setup(h(OnboardScreen), { draft: sneaky });
  await screen.findByText(/npm ci\[U\+202E\]/);
  f.close();
});

it("says a draft that failed and lets the person ask again; says nothing was found when there is no proposal yet", async () => {
  const failed = setup(h(OnboardScreen), { draft: { status: "failed", basedOnRevision: 2, failure: "The draft reached its spending limit before it finished. Try again." } });
  await screen.findByText("The draft reached its spending limit before it finished. Try again.");
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  failed.close();
  const none = setup(h(OnboardScreen));
  await screen.findByRole("button", { name: "Ask Rovara to propose the setup" });
  expect(screen.queryByRole("button", { name: "Apply selected" })).toBeNull();
  none.close();
});

it("keeps setting it up by hand available beside the suggestions", async () => {
  const f = setup(h(OnboardScreen), { draft: READY });
  expect(await screen.findByLabelText("Setup commands")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Or set it up yourself" })).toBeTruthy();
  f.close();
});

it("refuses an answer in words it does not know instead of guessing", async () => {
  const strange = { ...READY, proposal: { ...PROPOSAL, setup: [{ ...PROPOSAL.setup[0]!, confidence: "certain" }] } };
  const f = setup(h(OnboardScreen), { draft: strange });
  await screen.findByLabelText("Setup commands");
  expect(screen.queryByText("npm ci")).toBeNull();
  expect(screen.queryByRole("button", { name: "Apply selected" })).toBeNull();
  f.close();
});

it("starts a project from a meta repo with the code repositories it covers, or with the meta repo alone", async () => {
  const f = setup(h(OnboardScreen), { path: "/app/onboard?github=connected" });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Start from a meta repo" }));
  fireEvent.click(await screen.findByRole("radio", { name: "acme/meta" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "acme/api" }));
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(posts(f, "/v1/app/projects")).toHaveLength(1));
  expect(posts(f, "/v1/app/projects")[0]!.body).toMatchObject({ metaRepository: "acme/meta", codeRepositories: ["acme/api"] });
  f.close();
  const alone = setup(h(OnboardScreen), { path: "/app/onboard?github=connected" });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Start from a meta repo" }));
  fireEvent.click(await screen.findByRole("radio", { name: "acme/meta" }));
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(posts(alone, "/v1/app/projects")).toHaveLength(1));
  expect(posts(alone, "/v1/app/projects")[0]!.body).not.toHaveProperty("codeRepositories");
  expect(posts(alone, "/v1/app/projects")[0]!.body).toMatchObject({ metaRepository: "acme/meta" });
  alone.close();
});

it("keeps choosing one repository as it was", async () => {
  const f = setup(h(OnboardScreen), { path: "/app/onboard?github=connected" });
  fireEvent.click(await screen.findByLabelText("acme/web"));
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(posts(f, "/v1/app/projects")).toHaveLength(1));
  expect(posts(f, "/v1/app/projects")[0]!.body).toMatchObject({ repository: "acme/web" });
  expect(posts(f, "/v1/app/projects")[0]!.body).not.toHaveProperty("metaRepository");
  f.close();
});

for (const theme of ["light", "dark"] as const) it("keeps the proposal page accessible in " + theme, async () => {
  const f = setup(h(OnboardScreen), { draft: READY, theme });
  await screen.findByText("npm ci");
  await expectNoAxeViolations(document.body);
  f.close();
});

vi.setConfig({ testTimeout: 20_000 });

// UX-4b: a proposal written for an earlier version of the settings is said to be old before anything is pressed, with "Look again"; and an item that can't be applied here says where it does.
it("says a proposal is stale before the press and offers Look again, which asks for a new one", async () => {
  const f = setup(h(OnboardScreen), { draft: { ...READY, basedOnRevision: 1, proposal: { ...PROPOSAL, basedOnRevision: 1 } } });
  expect(await screen.findByText(/Rovara wrote this proposal for an earlier version of the project's settings/u)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Check and apply" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Look again" }));
  await waitFor(() => { expect(posts(f, "/setup-draft")).toHaveLength(1); });
  f.close();
});

it("an applied proposal at the current revision is not called stale", async () => {
  const f = setup(h(OnboardScreen), { draft: { ...READY, basedOnRevision: 1, appliedRevision: 2, proposal: { ...PROPOSAL, basedOnRevision: 1 } } });
  await screen.findByText("npm ci");
  expect(screen.queryByText(/earlier version of the project's settings/u)).toBeNull();
  f.close();
});

it("says where an item that can't be applied here does apply, with a link", async () => {
  const f = setup(h(OnboardScreen), { draft: READY });
  await screen.findByText("npm ci");
  // The knowledge Rovara found is set on the project's Sources tab.
  expect(screen.getByRole("link", { name: "Open the project's sources" }).getAttribute("href")).toBe("/app/projects/web?tab=sources");
  f.close();
});

it("points commands for another repository to the test environment", async () => {
  const review = REVIEW.map((entry) => entry.id === "setup-web" ? { ...entry, unavailable: "Project settings run setup and test commands in the project's first repository. Commands for another repository can't be saved there yet." } : entry);
  const f = setup(h(OnboardScreen), { draft: { ...READY, review } });
  await screen.findByText("npm ci");
  expect(screen.getAllByRole("link", { name: "Go to the test environment" })[0]!.getAttribute("href")).toBe("#test-environment");
  f.close();
});

// Owner decision 11 (one apply path): "Check and apply" sends the commands to the test environment as its proposal; the page says so and points there, and nothing reads as saved.
it("says the commands went to the test environment for their check, Prove and approval, and points there", async () => {
  const proposed = (id: string, kind: string) => ({ id, kind, outcome: "proposed", message: "Sent to the test environment as its proposal. Run its check, prove it, then approve it there: nothing is saved until it is approved." });
  const f = setup(h(OnboardScreen), { draft: READY, applied: { results: [proposed("setup-web", "setup")], project: project({}, 2), setupCheck: "not_needed" } });
  await screen.findByText("npm ci");
  fireEvent.click(screen.getByRole("button", { name: "Check and apply" }));
  expect(await screen.findByText(/Sent to the test environment as its proposal/u)).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "Go to the test environment" }).some((link) => link.getAttribute("href") === "#test-environment")).toBe(true);
  expect(screen.queryByText("Applied.")).toBeNull();
  // The anchor lands on the test environment section of this same page.
  expect(document.getElementById("test-environment")).not.toBeNull();
  f.close();
});
