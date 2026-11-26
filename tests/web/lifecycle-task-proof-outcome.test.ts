// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { DeveloperTaskViewReaderSchema, DeveloperTaskViewSchema } from "@agentx/contracts/web";
import { createCandidateManifest } from "@agentx/contracts";
import { TaskCheckOutcomeView } from "../../packages/ui/src/screens/session/TaskCheckOutcomeView.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
import { taskFixture } from "./support/session-fixture.js";
import { workspaceWorkflow } from "./support/workspace-fixture.js";

const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const verification = (candidateDigest = candidate.digest, status = "PASS") => ({ candidateDigest, producer: "check-runner", environmentId: "fixture-worker", recordedAt: "2026-10-23T12:00:00.000Z", results: status === "UNKNOWN" ? [{ checkId: "unit", status }] : [{ checkId: "unit", status }] });
const testing = (result: string, rowStatus: string, reason?: string) => ({ schemaVersion: 1, result, reasons: reason === undefined ? [] : [reason], rows: rowStatus === "none" ? [] : [{ label: "Unit tests", command: "npm test", status: rowStatus, ...(reason === undefined ? {} : { reason }) }] });
function mount(overrides: Record<string, unknown> = {}) {
 const workflow = { ...workspaceWorkflow(), candidate, verification: verification() };
 const task = DeveloperTaskViewReaderSchema.parse({ ...taskFixture({ workflow }), ...overrides });
 return renderUi(h(TaskCheckOutcomeView, { task }));
}

it("shows a real check failure as a code failure with its served proof", () => {
 const f = mount({ testing: testing("code_failed", "failed", "new_failing_test"), verificationReport: { reviewOnly: false, failed: [{ label: "Unit tests", summary: "Refund retry assertion failed" }], passed: [], notChecked: [], testsAdded: [] }, proofTable: { rows: [{ claimId: "R1", requirement: "Retries do not charge twice.", evidence: [], result: "failed" }], notTested: [], testProofLines: ["The retry test fails on this code."] } });
 expect(screen.getByRole("heading", { name: "Code failed" })).toBeTruthy();
 expect(screen.getByText("Refund retry assertion failed")).toBeTruthy();
 expect(screen.queryByText(/couldn't run/i)).toBeNull();
 f.unmount();
});

it("keeps an unavailable runner distinct from a failing customer test", () => {
 const f = mount({ testing: testing("blocked_by_environment", "blocked", "check_runner_failed"), workflow: { ...workspaceWorkflow(), candidate, verification: verification(candidate.digest, "UNKNOWN") } });
 expect(screen.getByRole("heading", { name: "Couldn't run" })).toBeTruthy();
 expect(screen.queryByRole("heading", { name: "Code failed" })).toBeNull();
 expect(screen.getByText("the check runner failed")).toBeTruthy();
 f.unmount();
});

it("says browser checks did not run for want of a browser runner, and does not call it passed or failed (Code BROWSER-SKIP-HONESTY)", () => {
 const view = testing("blocked_by_environment", "blocked", "browser_runner_missing");
 expect(DeveloperTaskViewSchema.shape.testing.safeParse(view).success).toBe(true);
 const f = mount({ testing: view, workflow: { ...workspaceWorkflow(), candidate, verification: verification(candidate.digest, "UNKNOWN") } });
 expect(screen.getByRole("heading", { name: "Couldn't run" })).toBeTruthy();
 expect(screen.getByText("browser checks did not run: there is no browser runner")).toBeTruthy();
 expect(screen.queryByText("Reason unavailable")).toBeNull();
 expect(screen.queryByRole("heading", { name: "Code failed" })).toBeNull();
 expect(screen.queryByRole("heading", { name: /^(Passed|Verified)$/u })).toBeNull();
 f.unmount();
});

it("uses per-check verification when the task reader has no summary result", () => {
 const f = mount({ testing: undefined, workflow: { ...workspaceWorkflow(), candidate, verification: verification(candidate.digest, "UNKNOWN") } });
 expect(screen.getByRole("heading", { name: "Couldn't run" })).toBeTruthy();
 expect(screen.queryByRole("heading", { name: "Code failed" })).toBeNull();
 f.unmount();
});

it("does not call legacy checks current when the task has no current candidate", () => {
 const workflow = { ...workspaceWorkflow(), verification: verification() };
 delete (workflow as { candidate?: unknown }).candidate;
 const f = mount({ testing: undefined, workflow });
 expect(screen.getByRole("heading", { name: "Check results unavailable" })).toBeTruthy();
 expect(screen.queryByRole("heading", { name: "Verified" })).toBeNull();
 f.unmount();
});

it("says no checks ran when the served result names an empty check set", () => {
 const f = mount({ testing: testing("partially_verified", "none", "no_checks_ran"), workflow: { ...workspaceWorkflow(), candidate, verification: { ...verification(), reviewOnly: true, results: [] } } });
 expect(screen.getByRole("heading", { name: "No checks ran" })).toBeTruthy();
 expect(screen.queryByRole("heading", { name: "Verified" })).toBeNull();
 f.unmount();
});

it("shows a verified result only for checks reported on the current candidate", () => {
 const f = mount({ testing: testing("verified", "passed") });
 expect(screen.getByRole("heading", { name: "Verified" })).toBeTruthy();
 expect(screen.getByText("Every required check passed.")).toBeTruthy();
 f.unmount();
});

it("labels mismatched candidate results as earlier without carrying them forward", () => {
 const f = mount({ testing: undefined, workflow: { ...workspaceWorkflow(), candidate, verification: verification("f".repeat(64), "FAILED") } });
 expect(screen.getByRole("heading", { name: "Earlier check results" })).toBeTruthy();
 expect(screen.getByText(/not matched to the current code/i)).toBeTruthy();
 expect(screen.queryByRole("heading", { name: "Couldn't run" })).toBeNull();
 f.unmount();
});

it("uses the current summary instead of a mismatched optional legacy verification record", () => {
 const f = mount({ testing: testing("verified", "passed"), workflow: { ...workspaceWorkflow(), candidate, verification: verification("f".repeat(64), "FAILED") } });
 expect(screen.getByRole("heading", { name: "Verified" })).toBeTruthy();
 expect(screen.queryByRole("heading", { name: "Earlier check results" })).toBeNull();
 f.unmount();
});

it("keeps partial proof and not-tested facts visible", () => {
 const f = mount({ testing: { schemaVersion: 1, result: "partially_verified", reasons: ["claim_not_tested"], rows: [{ label: "Unit tests", command: "npm test", status: "passed" }] }, proofTable: { rows: [{ claimId: "R1", requirement: "Retries do not charge twice.", evidence: [], result: "partly_tested" }], notTested: [{ kind: "claim", id: "R2", text: "Refunds are idempotent.", reason: "no check names this claim" }], testProofLines: [] } });
 expect(screen.getByRole("heading", { name: "Partially verified" })).toBeTruthy();
 expect(screen.getByText("Refunds are idempotent. (no check names this claim)")).toBeTruthy();
 f.unmount();
});

it("does not turn an outcome or reason unknown to this reader into a test failure", () => {
 const f = mount({ testing: testing("future_result", "future_status", "future_reason") });
 expect(screen.getByRole("heading", { name: "Check results unavailable" })).toBeTruthy();
 expect(screen.queryByRole("heading", { name: "Code failed" })).toBeNull();
 expect(screen.getAllByText("Status unavailable")).toHaveLength(2);
 expect(screen.getByText("Reason unavailable")).toBeTruthy();
 f.unmount();
});
