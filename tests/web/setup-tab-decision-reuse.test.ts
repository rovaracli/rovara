// @vitest-environment jsdom
// Reviewer-written (REVIEW-SONNET-CODE-6b2f041ca): a decision made earlier in the same Setup tab view must not hold back the next setup's Approve button.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { apply, DEFAULTS, failedRow, mountSetupTab } from "./support/setup-tab-world.js";

afterEach(cleanup);
const ready = { status: "ready", basedOnRevision: 3, canManage: true, stop: "proposed", startedAt: "2026-11-24T10:00:00.000Z" };
const candidateRow = () => failedRow({ state: "needs_you", status: "ready", approval: "candidate", failure: undefined, failedCommand: undefined, check: { status: "ready" } });

describe("one decision then a new candidate in the same view", () => {
  it("Don't use it, then Run setup again, then a new checked setup: Approve this setup is pressable", async () => {
    const f = mountSetupTab({
      run: { ...ready, apply: apply() }, row: candidateRow(),
      write: (request, world) => {
        if (request.path.endsWith("/setup-agent/decide")) { world.run = { ...ready, proposal: undefined }; world.row = failedRow({ state: "needs_you", status: "ready", approval: "none", failure: undefined, failedCommand: undefined }); return { status: 200, body: { project: "payments", decision: "rejected", risk: "low", revision: 4, replayed: false } }; }
        if (request.method === "POST" && request.path.endsWith("/setup-agent")) { world.run = { ...ready, startedAt: "2026-11-24T11:00:00.000Z", apply: apply({ approval: { requestId: "setup-second-5", revision: 5, artifactDigest: "cd34".repeat(16), kind: "setup", risk: "low" } }) }; world.row = candidateRow(); return { status: 200, body: { status: "running", basedOnRevision: 3, canManage: true, limits: DEFAULTS, startedAt: "2026-11-24T11:00:00.000Z" } }; }
        return undefined;
      },
    });
    const c = within(await screen.findByTestId("setup-status-card"));
    fireEvent.click(await c.findByRole("button", { name: "Don't use it" }));
    await waitFor(() => expect(screen.getByTestId("setup-status-card").textContent).toContain("Not used"));
    fireEvent.click(await within(screen.getByTestId("setup-status-card")).findByRole("button", { name: "Run setup again" }));
    await waitFor(() => expect(screen.getByTestId("setup-status-card").getAttribute("data-state")).toBe("approve"));
    const approve = await within(screen.getByTestId("setup-status-card")).findByRole("button", { name: "Approve this setup" });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    f.close();
  });
});
