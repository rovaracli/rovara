// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { EvidenceTab } from "../../packages/ui/src/screens/session/EvidenceTab.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { workspaceTask } from "../../packages/ui/src/screens/session/workspace-types.js";
import { pageProofFixture } from "./support/page-task-proof-fixture.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

it("F2 the current summary takes precedence over an optional legacy review-only receipt", () => {
 const base = workspaceTask(pageProofFixture())!;
 const task = workspaceTask(pageProofFixture({ workflow: { ...base.workflow!, verification: { ...base.workflow!.verification!, reviewOnly: true, results: [] } } }))!;
 const f = renderUi(h(AppHostProvider, { host: fakeHost().host, children: h(EvidenceTab, { task }) }));
 expect(within(screen.getByRole("article", { name: "Check outcome" })).getByRole("heading", { name: "Verified" })).toBeTruthy();
 expect(screen.queryByText("No checks were selected for this candidate.")).toBeNull();f.unmount();
});
it("F2 an unmatched review-only receipt cannot describe what ran for a missing current candidate", () => {
 const base = workspaceTask(pageProofFixture())!;
 const task = workspaceTask(pageProofFixture({ testing: undefined, workflow: { ...base.workflow!, candidate: undefined, verification: { ...base.workflow!.verification!, reviewOnly: true, results: [] } } }))!;
 const f = renderUi(h(AppHostProvider, { host: fakeHost().host, children: h(EvidenceTab, { task }) }));
 expect(screen.getByText("No check result is available for the current candidate.")).toBeTruthy();
 expect(screen.queryByText("No checks were selected for this candidate.")).toBeNull();f.unmount();
});
