// @vitest-environment jsdom
import { expect, it } from "vitest";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { EvidenceViewReaderSchema } from "@agentx/contracts/web";
import { EvidenceTab } from "../../packages/ui/src/screens/session/EvidenceTab.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { workspaceTask } from "../../packages/ui/src/screens/session/workspace-types.js";
import { fakeHost } from "./support/fake-host.js";
import { expectNoAxeViolations } from "./support/axe.js";

function evidence(artifact: "video" | "trace", reason: "upload_failed" | "revocation_not_confirmed") {
  return EvidenceViewReaderSchema.parse({
    schemaVersion: 1,
    candidateDigest: "a".repeat(64),
    environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
    checks: [],
    selection: { method: "full", selected: 0, total: 0 },
    api: [],
    browser: [{ scenarioId: "checkout", strip: { before: [], after: [] }, withheld: [{ artifact, reason }] }],
    notTested: [],
  });
}

function renderEvidence(artifact: "video" | "trace", reason: "upload_failed" | "revocation_not_confirmed") {
  const session = workspaceFixture({}, { evidence: evidence(artifact, reason) });
  const task = workspaceTask(session);
  if (!task) throw new Error("The real task reader rejected the evidence fixture");
  return render(createElement(AppHostProvider, { host: fakeHost().host, children: createElement(EvidenceTab, { task }) }));
}

it("uses the F331 upload-failure copy in browser evidence and keeps the check result separate", async () => {
  const view = renderEvidence("video", "upload_failed");

  expect(screen.getByText("Video")).toBeTruthy();
  expect(screen.getByText("This evidence artifact was not kept because its upload failed. The check result is separate from this missing artifact. Run the evidence capture again.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Browser checks" })).toBeTruthy();
  expect(view.container.querySelector("a, video, img")).toBeNull();
  await expectNoAxeViolations(view.container);
});

it("preserves the distinct revocation uncertainty wording for a withheld trace", () => {
  renderEvidence("trace", "revocation_not_confirmed");

  expect(screen.getByText("Trace")).toBeTruthy();
  expect(screen.getByText("Trace not kept: the test accounts could not be confirmed closed.")).toBeTruthy();
});
