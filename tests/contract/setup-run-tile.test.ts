// The Live wall tile of a setup run (SH13): a running setup run reads in fixed words with how many commands it has run; a run that is over reads as any ended session. A task that is not a
// setup run is not touched.
import { describe, expect, it } from "vitest";
import { projectorWorld } from "../support/agent-session-projector-world.js";

describe("a setup run's tile", () => {
  it("says what it is doing, and how far it has got, in fixed words", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    p.patchTask(s.taskId, { purpose: "setup_agent" });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "running", step: "Setting up the project" });
    p.patchTask(s.taskId, { setupAgentProgress: { commands: 1, at: "2026-11-02T10:00:00.000Z" } });
    p.w.clock.now += 5000;
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.step).toBe("Setting up the project: 1 command run");
    p.patchTask(s.taskId, { setupAgentProgress: { commands: 7, at: "2026-11-02T10:01:00.000Z" } });
    p.w.clock.now += 5000;
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.step).toBe("Setting up the project: 7 commands run");
  });

  it("is not shown for a task that is not a setup run", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    p.patchTask(s.taskId, { setupAgentProgress: { commands: 7, at: "2026-11-02T10:01:00.000Z" } });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.step ?? "").not.toContain("Setting up");
  });

  it("a run that is over reads as an ended session, not as setting up", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { purpose: "setup_agent", agentRunEnd: { state: "COMPLETE", at: "2026-11-02T10:05:00.000Z" }, setupAgentProgress: { commands: 7, at: "2026-11-02T10:01:00.000Z" } });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.status).toBe("succeeded");
    expect(p.sessionOf(s.sessionId).summary.step ?? "").not.toContain("Setting up");
  });
});
