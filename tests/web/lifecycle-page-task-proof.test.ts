// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { workspaceTask } from "../../packages/ui/src/screens/session/workspace-types.js";
import { fakeHost } from "./support/fake-host.js";
import { pageProofFixture, proofArtifact, proofCandidate } from "./support/page-task-proof-fixture.js";
import { h } from "./support/h.js";

afterEach(cleanup);
function setup(overrides: Record<string, unknown> = {}) {
 const session = pageProofFixture(overrides), f = fakeHost(), query = createQueryClient();
 const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(Workspace, { session })) }], { initialEntries: ["/app/sessions/" + session.sessionId + "#tests"] });
 const element = h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) });
 const ui = render(element);
 return { ...ui, element, session, close: () => { ui.unmount();router.dispose();query.clear(); } };
}
function evidenceWith(overrides: Record<string, unknown>) {
 return { ...workspaceTask(pageProofFixture())!.evidence!, ...overrides };
}
it("F1 delivers the mounted viewer stylesheet in the production CSS copy list", () => {
 expect(readFileSync("scripts/ui-copy-assets.mjs", "utf8")).toContain('"screens/session/task-capture-view.css"');
});
it.each([
 ["code_failed", "failed", "Code failed"], ["blocked_by_environment", "blocked", "Couldn't run"], ["verified", "passed", "Verified"], ["partially_verified", "passed", "Partially verified"], ["future_result", "future_status", "Check results unavailable"],
])("F2 mounts the %s check outcome from the full task read", (result, status, title) => {
 const f = setup({ testing: { schemaVersion: 1, result, reasons: [], rows: [{ label: "Unit tests", command: "npm test", status }] } });
 expect(within(screen.getByRole("article", { name: "Check outcome" })).getByRole("heading", { name: title })).toBeTruthy();
 expect(screen.queryByRole("heading", { name: "Recorded checks" })).toBeNull();
 f.close();
});
it("F2 reaches no-checks, earlier-head and absent-current states without claiming verification", () => {
 for (const [overrides, title] of [
  [{ testing: { schemaVersion: 1, result: "partially_verified", reasons: ["no_checks_ran"], rows: [] } }, "No checks ran"],
  [{ testing: undefined, workflow: { ...workspaceTask(pageProofFixture())!.workflow!, verification: { ...workspaceTask(pageProofFixture())!.workflow!.verification!, candidateDigest: "f".repeat(64) } } }, "Earlier check results"],
  [{ testing: undefined, workflow: { ...workspaceTask(pageProofFixture())!.workflow!, candidate: undefined } }, "Check results unavailable"],
 ] as const) {
  const f = setup(overrides);
  expect(within(screen.getByRole("article", { name: "Check outcome" })).getByRole("heading", { name: title })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Verified" })).toBeNull();f.close();
 }
});
it("F3 opens the exact Before capture, returns selection/focus and retains it across tab remount", async () => {
 const f = setup();
 fireEvent.click(screen.getByRole("button", { name: "checkout · before" }));
 const opener = screen.getByRole("button", { name: "Open selected screenshot" });opener.focus();fireEvent.click(opener);
 const viewer = screen.getByRole("region", { name: "Screenshot viewer" });
 expect(within(viewer).getByRole("img", { name: /before screenshot/u }).getAttribute("src")).toContain("/v1/app/evidence/a.jpg");
 expect(viewer.textContent).toContain(proofCandidate.digest);
 fireEvent.click(within(viewer).getByRole("button", { name: /Back to the screenshots/u }));
 await waitFor(() => expect(document.activeElement).toBe(opener));
 fireEvent.mouseDown(screen.getByRole("tab", { name: "Plan" }), { button: 0, ctrlKey: false });
 await screen.findByRole("heading", { name: "Refund investigation" });
 fireEvent.mouseDown(screen.getByRole("tab", { name: "Evidence" }), { button: 0, ctrlKey: false });
 expect((await screen.findByRole("button", { name: "checkout · before" })).getAttribute("aria-pressed")).toBe("true");
 expect(screen.getByRole("img", { name: "checkout, before screenshot" }).getAttribute("src")).toContain("/v1/app/evidence/a.jpg");f.close();
});
it("F4 keeps screenshot, sample, recording and trace expiry beside the exact artifact", () => {
 const expired = proofArtifact("expired");
 const f = setup({ evidence: evidenceWith({ api: [{ scenarioId: "refund-api", diff: "none", changedPaths: [], samples: [expired] }], browser: [{ scenarioId: "checkout", strip: { before: [], after: [expired] }, video: expired, trace: expired }] }) });
 expect(screen.getAllByText(/This evidence link expired\./u)).toHaveLength(4);
 expect(screen.queryByText(/Not captured/u)).toBeNull();
 expect(screen.queryByRole("button", { name: "Request a new link" })).toBeNull();
 expect(f.container.querySelector("img,video,a[download]")).toBeNull();f.close();
});
it("F4/F5 preserves withheld screenshots in both page and viewer without inventing a timeout", () => {
 const f = setup({ evidence: evidenceWith({ browser: [{ scenarioId: "checkout", strip: { before: [], after: [proofArtifact("withheld")] } }] }) });
 expect(screen.getByText(/This evidence artifact was not kept\./u)).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Open selected screenshot" }));
 expect(within(screen.getByRole("region", { name: "Screenshot viewer" })).getByText(/This evidence artifact was not kept\./u)).toBeTruthy();
 expect(document.body.textContent).not.toMatch(/timed out|Not captured/u);f.close();
});
it("F6 renders a claim-only gap count bound to the served evidence, distinct from other gaps", () => {
 const f = setup();
 const gaps = screen.getByRole("region", { name: "What wasn't tested" });
 expect(gaps.textContent).toContain("1 requirement was not tested: R1: Refund retries are idempotent.");
 expect(gaps.textContent).toContain("No passing result is claimed for them. Review the missing evidence.");
 expect(gaps.textContent).not.toContain("Browser check");
 expect(gaps.getAttribute("data-evidence-head")).toBe(proofCandidate.digest);f.close();
});
it("F6 mounts refused live dependency and unreadable dependency evidence without a code-failure claim", () => {
 const f = setup({ evidence: evidenceWith({ environment: { ...workspaceTask(pageProofFixture())!.evidence!.environment, dependencies: undefined, services: [{ name: "payments", mode: "live-forbidden" }] } }) });
 expect(screen.getByRole("region", { name: "Live dependency access refused" }).textContent).toContain("The evidence does not prove the live integration.");
 expect(screen.getByRole("region", { name: "Dependency evidence unavailable" }).textContent).toContain("This is not proof that the code failed.");f.close();
});
