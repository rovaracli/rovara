// @vitest-environment jsdom
// Delta re-check of f73eabdea (reviewer-written): the decision's done/problem follow the approval they were for.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { apply, DEFAULTS, failedRow, mountSetupTab } from "./support/setup-tab-world.js";

afterEach(cleanup);
const ready = { status: "ready", basedOnRevision: 3, canManage: true, stop: "proposed", startedAt: "2026-11-24T10:00:00.000Z" };
const candidateRow = () => failedRow({ state: "needs_you", status: "ready", approval: "candidate", failure: undefined, failedCommand: undefined, check: { status: "ready" } });
const noneRow = () => failedRow({ state: "needs_you", status: "ready", approval: "none", failure: undefined, failedCommand: undefined });
const second = () => apply({ approval: { requestId: "setup-second-5", revision: 5, artifactDigest: "cd34".repeat(16), kind: "setup", risk: "low" } });
const card = () => within(screen.getByTestId("setup-status-card"));
const cardReady = async () => { await screen.findByTestId("setup-status-card"); return card(); };

describe("the decision follows its approval (UI)", () => {
  it("the SAME approval stays disabled after success even if the read still shows it, and a double click sends once", async () => {
    const f = mountSetupTab({ run: { ...ready, apply: apply() }, row: candidateRow(), write: request => request.path.endsWith("/setup-agent/decide") ? { status: 200, body: { project: "payments", decision: "approved", risk: "low", revision: 4, replayed: false } } : undefined });
    const approve = await (await cardReady()).findByRole("button", { name: "Approve this setup" });
    fireEvent.click(approve); fireEvent.click(approve);
    await waitFor(() => expect(f.sent("POST", "/setup-agent/decide")).toHaveLength(1));
    await new Promise(r => setTimeout(r, 100));
    expect((screen.getByTestId("setup-status-card").querySelector("[data-testid=setup-approve]") as HTMLButtonElement).disabled).toBe(true);
    expect(f.sent("POST", "/setup-agent/decide")).toHaveLength(1);
    f.close();
  });
  it("Approve, then Run setup again with a new approval: the new Approve is pressable and sends the NEW id, revision and digest", async () => {
    const f = mountSetupTab({
      run: { ...ready, apply: apply() }, row: candidateRow(),
      write: (request, world) => {
        if (request.path.endsWith("/setup-agent/decide")) { world.run = { ...ready }; world.row = failedRow({ state: "needs_you", status: "ready", approval: "none", failure: undefined, failedCommand: undefined }); return { status: 200, body: { project: "payments", decision: "approved", risk: "low", revision: 4, replayed: false } }; }
        if (request.method === "POST" && request.path.endsWith("/setup-agent")) { world.run = { ...ready, startedAt: "2026-11-24T11:00:00.000Z", apply: second() }; world.row = candidateRow(); return { status: 200, body: { status: "running", basedOnRevision: 3, canManage: true, limits: DEFAULTS, startedAt: "2026-11-24T11:00:00.000Z" } }; }
        return undefined;
      },
    });
    fireEvent.click(await (await cardReady()).findByRole("button", { name: "Approve this setup" }));
    await waitFor(() => expect(f.sent("POST", "/setup-agent/decide")).toHaveLength(1));
    fireEvent.click(await card().findByRole("button", { name: "Run setup again" }));
    await waitFor(() => expect(screen.getByTestId("setup-status-card").getAttribute("data-state")).toBe("approve"));
    const approve = await card().findByRole("button", { name: "Approve this setup" });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(f.sent("POST", "/setup-agent/decide")).toHaveLength(2));
    expect(f.sent("POST", "/setup-agent/decide")[1]!.body).toEqual({ requestId: "setup-second-5", outcome: "approve", seen: { revision: 5, artifactDigest: "cd34".repeat(16) } });
    f.close();
  });
  it("Discard (failed check), then Run setup again with a new approval: Approve and Don't use it are pressable", async () => {
    const f = mountSetupTab({
      run: { ...ready, apply: apply({ check: { status: "failed", failedStep: "npm test" }, approval: undefined, canApprove: false, canReject: false }) }, row: failedRow({ state: "needs_you", status: "ready", approval: "candidate", failure: undefined, failedCommand: undefined, check: { status: "failed", failedStep: "npm test" } }),
      write: (request, world) => {
        if (request.path.endsWith("/setup-agent/discard")) { world.run = { ...ready }; world.row = noneRow(); return { status: 200, body: { discarded: true } }; }
        if (request.method === "POST" && request.path.endsWith("/setup-agent")) { world.run = { ...ready, startedAt: "2026-11-24T11:00:00.000Z", apply: second() }; world.row = candidateRow(); return { status: 200, body: { status: "running", basedOnRevision: 3, canManage: true, limits: DEFAULTS, startedAt: "2026-11-24T11:00:00.000Z" } }; }
        return undefined;
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Don't use it" }));
    await waitFor(() => expect(f.sent("POST", "/setup-agent/discard")).toHaveLength(1));
    fireEvent.click(await card().findByRole("button", { name: "Run setup again" }));
    await waitFor(() => expect(screen.getByTestId("setup-status-card").getAttribute("data-state")).toBe("approve"));
    expect((await card().findByRole("button", { name: "Approve this setup" })).hasAttribute("disabled")).toBe(false);
    expect((await card().findByRole("button", { name: "Don't use it" })).hasAttribute("disabled")).toBe(false);
    f.close();
  });
  it("a failed decision shows its problem and the buttons stay pressable (retry sends again)", async () => {
    let n = 0;
    const f = mountSetupTab({ run: { ...ready, apply: apply() }, row: candidateRow(), write: request => request.path.endsWith("/setup-agent/decide") ? (++n === 1 ? { status: 500, body: { error: { code: "INTERNAL", message: "Boom." } } } : { status: 200, body: { project: "payments", decision: "approved", risk: "low", revision: 4, replayed: false } }) : undefined });
    fireEvent.click(await (await cardReady()).findByRole("button", { name: "Approve this setup" }));
    expect(await screen.findByTestId("setup-approval-problem")).toBeTruthy();
    const again = await card().findByRole("button", { name: "Approve this setup" });
    expect((again as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(again);
    await waitFor(() => expect(f.sent("POST", "/setup-agent/decide")).toHaveLength(2));
    f.close();
  });
});

