// @vitest-environment jsdom
// 0.5.16: the default-branch gate on the setup step. Before anything of the setup is offered the branch is read: an empty one with code elsewhere asks "main is empty; use <branch> instead?", a repository with no code says to push
// code first, GitHub that cannot answer says so and goes on, a branch with files shows only a "Default branch" line. Nothing that spends (the setup draft, the setup run, a check) is sent until the question is answered.
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppProjectDetailSchema, BranchCheckResponseSchema, type BranchCheckResponse } from "@agentx/cloud-contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { DefaultBranchGate } from "../../packages/ui/src/screens/onboarding/steps/DefaultBranchGate.js";
import { branchNotices } from "../../packages/ui/src/screens/onboarding/steps/default-branch-text.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";

const project = (branch = "main", revision = 1) => AppProjectDetailSchema.parse({ name: "mobile", description: "Pay in the app.", status: "active", latestRevision: revision, repositories: [{ fullName: "acme/checkout-api", defaultBranch: branch }], myRole: "maintainer", setup: { status: "unchecked" }, settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] }, createdAt: "2026-11-01T12:00:00.000Z", createdBy: { developerId: "d".repeat(64), name: "Maya" } });
const row = (over: Record<string, unknown> = {}) => ({ repository: "checkout-api", fullName: "acme/checkout-api", branch: "main", state: "empty", alternatives: [{ name: "001-dag-orchestrator", lastCommitAt: "2026-11-10T09:30:00Z" }, { name: "feature/search" }, { name: "old" }], searchedAll: true, continued: false, ...over });
const answer = (rows: Array<Record<string, unknown>>, revision = 1): BranchCheckResponse => BranchCheckResponseSchema.parse({ revision, blocked: rows.some(entry => ["empty", "missing", "no_code"].includes(String(entry.state)) && entry.continued !== true), repositories: rows });

/** The page above the gate: it holds the project and takes the new one the gate hands up, as the onboarding screen does. */
function Host({ start, onProject, children }: { start: ReturnType<typeof project>; onProject: (value: ReturnType<typeof project>) => void; children: ReturnType<typeof h> }) {
 const [current, setCurrent] = useState(start);
 return h(DefaultBranchGate, { project: current, onProject: value => { setCurrent(value);onProject(value); }, children });
}
function mount(options: { checks: Array<BranchCheckResponse | "fail">; onProject?: (value: ReturnType<typeof project>) => void; current?: ReturnType<typeof project> }) {
 let given = 0;
 const f = fakeHost(async request => {
  if (request.path.endsWith("/branch-check") && request.method === "GET") { const next = options.checks[Math.min(given, options.checks.length - 1)]!;given += 1;return next === "fail" ? { status: 502, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "GitHub is down" } } } : { status: 200, body: next }; }
  if (request.path.endsWith("/default-branch") && request.method === "PUT") { const body = request.body as { branch: string };return { status: 200, body: { project: project(body.branch, 2), check: answer([row({ branch: body.branch, state: "has_files", alternatives: [] })], 2) } }; }
  if (request.path.endsWith("/branch-check/continue")) return { status: 200, body: answer([row({ continued: true })]) };
  return { status: 200, body: { notices: [], next: "settled" } };
 });
 const query = createQueryClient(), spent = vi.fn();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Host, { start: options.current ?? project(), onProject: options.onProject ?? vi.fn(), children: h("button", { onClick: spent }, "Ask Rovara to propose the setup") }) }) }) }));
 return { ...f, ...ui, spent, close() { ui.unmount();query.clear(); } };
}
const calls = (f: ReturnType<typeof mount>, method: string, suffix: string) => f.request.mock.calls.map(call => call[0]).filter(request => request.method === method && request.path.endsWith(suffix));

it("words each repository's answer, and holds back only empty, missing and no-code branches the person has not gone on with", () => {
 const notices = branchNotices(answer([row(), row({ repository: "b", state: "missing" }), row({ repository: "c", state: "no_code", alternatives: [] }), row({ repository: "d", state: "has_files", alternatives: [] }), row({ repository: "e", state: "unchecked", alternatives: [] }), row({ repository: "f", continued: true })]));
 expect(notices.map(notice => notice.kind)).toEqual(["empty", "missing", "no_code", "fine", "unchecked", "continued"]);
});

it("an empty main with code elsewhere asks to use the newest branch, lists the others, and shows nothing of the setup", async () => {
 const f = mount({ checks: [answer([row()])] });
 const group = await screen.findByRole("group", { name: "Default branch of acme/checkout-api" });
 expect(within(group).getByRole("heading").textContent).toBe("main is empty; use 001-dag-orchestrator instead?");
 expect(within(group).getAllByRole("radio").map(radio => (radio as HTMLInputElement).value)).toEqual(["feature/search", "old"]);
 expect(screen.queryByRole("button", { name: "Ask Rovara to propose the setup" })).toBeNull();
 expect(f.spent).not.toHaveBeenCalled();
 f.close();
});

it("accepting the suggestion sends the choice with the revision the person saw, hands the project up, and then the setup is offered (nothing started)", async () => {
 const onProject = vi.fn<(value: ReturnType<typeof project>) => void>(), f = mount({ checks: [answer([row()])], onProject });
 fireEvent.click(await screen.findByRole("button", { name: "Use 001-dag-orchestrator" }));
 expect(await screen.findByRole("button", { name: "Ask Rovara to propose the setup" })).toBeTruthy();
 const put = calls(f, "PUT", "/default-branch");
 expect(put).toHaveLength(1);expect(put[0]!.body).toMatchObject({ repository: "checkout-api", branch: "001-dag-orchestrator", expectedRevision: 1 });
 expect(onProject).toHaveBeenCalledTimes(1);expect(onProject.mock.calls[0]![0].repositories[0]!.defaultBranch).toBe("001-dag-orchestrator");
 expect(f.spent).not.toHaveBeenCalled();expect(calls(f, "POST", "/setup-draft")).toHaveLength(0);
 f.close();
});

it("a repository with no code says so plainly and offers no branch; Continue anyway is an explicit choice that then opens the setup", async () => {
 const f = mount({ checks: [answer([row({ state: "no_code", alternatives: [] })])] });
 expect(await screen.findByRole("heading", { name: "This repository has no code yet. Push code first." })).toBeTruthy();
 expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();expect(screen.queryByRole("button", { name: "Ask Rovara to propose the setup" })).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
 expect(await screen.findByRole("button", { name: "Ask Rovara to propose the setup" })).toBeTruthy();
 expect(calls(f, "POST", "/branch-check/continue")[0]!.body).toEqual({ repository: "checkout-api", branch: "main" });
 expect(screen.getByText(/it has no files yet/u)).toBeTruthy();
 f.close();
});

it("a branch with files shows the setup at once and only a Default branch line; Check again re-reads", async () => {
 const f = mount({ checks: [answer([row({ state: "has_files", alternatives: [] })])] });
 expect(await screen.findByRole("button", { name: "Ask Rovara to propose the setup" })).toBeTruthy();
 expect(screen.queryByRole("group", { name: /Default branch of/u })).toBeNull();
 expect(screen.getByText(/Default branch:/u).textContent).toContain("main");
 f.close();
});

it("GitHub that cannot answer says so, offers the setup anyway and starts nothing; Check the branch again can find it empty", async () => {
 const f = mount({ checks: ["fail", answer([row()])] });
 expect(await screen.findByText("We couldn't check the branch; draft the setup when ready.")).toBeTruthy();
 expect(screen.getByRole("button", { name: "Ask Rovara to propose the setup" })).toBeTruthy();
 expect(f.spent).not.toHaveBeenCalled();expect(calls(f, "POST", "/setup-draft")).toHaveLength(0);
 fireEvent.click(screen.getByRole("button", { name: "Check the branch again" }));
 expect(await screen.findByRole("heading", { name: "main is empty; use 001-dag-orchestrator instead?" })).toBeTruthy();
 await waitFor(() => { expect(screen.queryByRole("button", { name: "Ask Rovara to propose the setup" })).toBeNull(); });
 f.close();
});

it("an empty branch with no other branch found asks for a branch by name, and Check again is there", async () => {
 const f = mount({ checks: [answer([row({ alternatives: [], searchedAll: false })])] });
 expect(await screen.findByRole("heading", { name: "main is empty." })).toBeTruthy();
 expect(screen.getByLabelText("Use another branch of acme/checkout-api")).toBeTruthy();expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
 f.close();
});

it("a refusal from the server is shown and the question stays", async () => {
 const f = fakeHost(async request => request.method === "PUT" ? { status: 400, body: { error: { code: "CONFIG_INVALID", message: "branch: is not a branch of this repository" } } } : { status: 200, body: answer([row()]) });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(DefaultBranchGate, { project: project(), onProject: vi.fn(), children: h("p", null, "setup") }) }) }) }));
 fireEvent.click(await screen.findByRole("button", { name: "Use 001-dag-orchestrator" }));
 expect((await screen.findByRole("alert")).textContent).toContain("is not a branch of this repository");
 expect(screen.queryByText("setup")).toBeNull();
 ui.unmount();query.clear();
});
