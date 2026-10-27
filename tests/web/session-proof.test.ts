// @vitest-environment jsdom
// Playbook P3: the Tests tab shows the proof table above the recorded checks: Requirement, Evidence and Result; the test-proof lines; and "What wasn't tested", always visible.
import { expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { createCandidateManifest } from "@agentx/contracts";
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
const candidate = manifest("1"), digest = candidate.digest, other = manifest("2").digest;
const proofTable = {
 rows: [
  { claimId: "1", requirement: "Payments that time out are retried.", evidence: [{ kind: "check", label: "Unit tests", state: "proven" }], result: "proven" },
  { claimId: "2", requirement: "A payment is never charged twice.", evidence: [{ kind: "check", label: "Lint", state: "passed" }, { kind: "scenario", label: "Checkout flow", state: "failed" }], result: "failed" },
  { claimId: "3", requirement: "The retry count is shown.", evidence: [], result: "not_tested" },
  { claimId: "4", requirement: "The retry stops after five tries.", evidence: [{ kind: "check", label: "Unit tests", state: "passed" }, { kind: "check", label: "Smoke run", state: "not_checked" }], result: "partly_tested" },
 ],
 notTested: [{ kind: "claim", id: "3", text: "The retry count is shown.", reason: "no check or scenario names it" }, { kind: "check", id: "e2e", text: "Smoke run", reason: "it could not run" }],
 testProofLines: ["Test proof: 1 check fails on the original code and passes now"],
};
const verification = (candidateDigest: string) => ({ candidateDigest, producer: "check-runner", environmentId: "fixture-worker", recordedAt: "2026-10-23T12:00:00.000Z", results: [{ checkId: "unit", status: "PASS" }] });
const withProof = (verifiedDigest: string, extra: Record<string, unknown> = {}) => fixture({ body: { kind: "task", task: taskFixture({ workflow: { ...workflow(), candidate, verification: verification(verifiedDigest) }, proofTable, ...extra }) } });

it("shows the proof table with each requirement, its evidence and its result in words", () => {
 const f = setup(withProof(digest));
 const table = screen.getByRole("table", { name: "Proof" });
 expect(within(table).getAllByRole("columnheader").map(cell => cell.textContent)).toEqual(["Requirement", "Evidence", "Result"]);
 const rows = within(table).getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell").map(cell => cell.textContent));
 expect(rows[0]).toEqual(["1: Payments that time out are retried.", "Unit tests (passed, fails on the original code)", "Proven"]);
 expect(rows[1]).toEqual(["2: A payment is never charged twice.", "Lint (passed); Scenario: Checkout flow (failed)", "Failed"]);
 expect(rows[2]).toEqual(["3: The retry count is shown.", "None", "Not tested"]);
 expect(rows[3]).toEqual(["4: The retry stops after five tries.", "Unit tests (passed); Smoke run (not checked)", "Partly tested"]);
 expect(screen.getByText("Test proof: 1 check fails on the original code and passes now")).toBeTruthy();
 f.close();
});
it("lists what wasn't tested in plain view, never collapsed", () => {
 const f = setup(withProof(digest));
 const heading = screen.getByRole("heading", { name: "What wasn't tested" });
 const list = heading.nextElementSibling as HTMLElement;
 expect(list.tagName).toBe("UL");
 expect(within(list).getAllByRole("listitem").map(item => item.textContent)).toEqual(["Requirement 3: The retry count is shown. (no check or scenario names it)", "Check Smoke run (it could not run)"]);
 expect(document.querySelector("details")).toBeNull();
 expect(heading.closest("[hidden]")).toBeNull();
 f.close();
});
it("puts the proof above the recorded checks", () => {
 const f = setup(withProof(digest));
 const proof = screen.getByRole("table", { name: "Proof" }), checks = screen.getByRole("heading", { name: "Recorded checks" });
 expect(proof.compareDocumentPosition(checks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 f.close();
});
it("labels the proof as earlier results when the checks were recorded for older code", () => {
 const f = setup(withProof(other));
 expect(screen.getByRole("heading", { name: "Earlier check results" })).toBeTruthy();
 expect(screen.queryByRole("table", { name: "Proof" })).toBeNull();
 expect(screen.getByRole("table", { name: "Proof from earlier check results" })).toBeTruthy();
 f.close();
});
it("shows no proof section when the view has none, and is accessible in the page", async () => {
 const f = setup(fixture({ body: { kind: "task", task: taskFixture({ workflow: { ...workflow(), candidate, verification: verification(digest) } }) } }));
 expect(screen.queryByRole("table", { name: /Proof/u })).toBeNull();
 expect(screen.queryByRole("heading", { name: "What wasn't tested" })).toBeNull();
 f.close();
 const g = setup(withProof(digest));
 await expectNoAxeViolations(g.container);
 g.close();
});
it("shows hostile requirement text as text and makes hidden characters visible", () => {
 const hostile = { ...proofTable, rows: [{ ...proofTable.rows[0]!, requirement: "<img src=x onerror=alert(1)> a‮b" }] };
 const f = setup(withProof(digest, { proofTable: hostile }));
 expect(f.container.querySelector("img")).toBeNull();
 expect(screen.getByText(/<img src=x onerror=alert\(1\)> a\[U\+202E\]b/u)).toBeTruthy();
 f.close();
});
