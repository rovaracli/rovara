// @vitest-environment jsdom
// Setup and test health SH19: the Tests tab shows the four test results with one row per check, in fixed words, above the proof table.
import { expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionViewReaderSchema } from "@agentx/cloud-contracts/web";
import { createCandidateManifest } from "@rovara-code/contracts";
import { workspaceFixture as fixture, workspaceWorkflow as workflow } from "./support/workspace-fixture.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { taskFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
function setup(value: unknown, hash = "#tests") {
 const session = SessionViewReaderSchema.parse(value), f = fakeHost();const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(Workspace, { session })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID + hash] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(RouterProvider, { router }) }));
 return { ...ui, close() { ui.unmount();router.dispose(); } };
}
const manifest = (letter: string) => createCandidateManifest([{ repositoryId: "payments", commitSha: letter.repeat(40), treeSha: letter.repeat(40), baseCommitSha: "e".repeat(40) }]);
const candidate = manifest("1"), digest = candidate.digest;
const verification = (candidateDigest: string) => ({ candidateDigest, producer: "check-runner", environmentId: "fixture-worker", recordedAt: "2026-10-23T12:00:00.000Z", results: [{ checkId: "unit", status: "PASS" }] });

const testing = (over: Record<string, unknown> = {}) => ({
 schemaVersion: 1, result: "blocked_by_environment", reasons: ["check_runner_failed"],
 rows: [
  { label: "Unit tests", command: "pytest -q", status: "passed", passedTests: 37 },
  { label: "Integration", command: "pytest tests/integration", status: "blocked", reason: "check_runner_failed" },
  { label: "Full test suite", command: "all tests", status: "pending", reason: "full_suite_pending" },
 ], ...over,
});
const withTesting = (value: Record<string, unknown> | undefined) => fixture({ body: { kind: "task", task: taskFixture({ workflow: { ...workflow(), candidate, verification: verification(digest) }, ...(value === undefined ? {} : { testing: value }) }) } });

it("shows the result in fixed words with one row per check and its command", () => {
 const f = setup(withTesting(testing()));
 expect(screen.getByRole("heading", { name: "Testing: Blocked by environment" })).toBeTruthy();
 expect(screen.getByText("Result: 1 check could not give a result because of the test environment.")).toBeTruthy();
 const table = screen.getByRole("table", { name: "Checks and their results" });
 expect(within(table).getAllByRole("columnheader").map(cell => cell.textContent)).toEqual(["Check", "Command", "Result"]);
 const rows = within(table).getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell").map(cell => cell.textContent));
 expect(rows).toEqual([
  ["Unit tests", "pytest -q", "passed (37 tests)"],
  ["Integration", "pytest tests/integration", "blocked: the check runner failed"],
  ["Full test suite", "all tests", "pending: the full suite has not finished yet"],
 ]);
 f.close();
});

it("shows nothing about results when the view is absent (the switch is off)", () => {
 const f = setup(withTesting(undefined));
 expect(screen.queryByRole("heading", { name: /^Testing:/u })).toBeNull();
 expect(screen.queryByRole("table", { name: "Checks and their results" })).toBeNull();
 f.close();
});

it("is accessible", async () => {
 const f = setup(withTesting(testing()));
 await expectNoAxeViolations(document.body);
 f.close();
});
