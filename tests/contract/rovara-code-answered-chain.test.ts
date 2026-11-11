// Plan 6 Task 6 (owner ruling): in a chain, a Rovara Code step that ends Answered (it answered a question and changed no code) is not a success to move on from. The chain pauses
// at a gate, with the existing person-decision mechanism (a chain gate: Plan 3's step approval, decided on the confirmation page, by the starter, a maintainer or the chain's
// owner), asking "Step <name> answered instead of changing code. Continue or stop?". Continue goes on by the step's own edge; stop ends the run (cancelled, not failed); nothing
// is spent while it waits. A task that is not in a chain ends Answered as before (rovara-code-answered.test.ts).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { expireApprovals } from "../../packages/broker/src/agents/approvals.js";
import { chainSessionSource } from "../../packages/broker/src/chains/session-seam.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { GATE_DEFAULT_TIMEOUT_HOURS, type ChainDefinitionInput } from "@rovara-code/contracts";
import type { IntentAssessment } from "@rovara-code/contracts";
import { ARJUN, MAX, ORG_A, PRIYA, STRANGER, VIV, callerOf, disposeGateWorlds, setupGateWorld, type GateWorld } from "../support/chain-gate-world.js";

afterEach(() => disposeGateWorlds());

const gates = () => import("../../packages/broker/src/chains/gates.js");
const HOUR = 3_600_000;
const PROMPT = 'Step "Fix it" answered instead of changing code. Continue or stop?';
const answer = (): IntentAssessment => ({ kind: "answer", restatement: "What does the retry flag do?", answer: "It turns retries on, for the payment worker only.", sources: [{ repository: "demo", path: "src/retry.ts", line: 4 }] });

type Step = ChainDefinitionInput["steps"][number];
const agentStep = (id: string, name: string, agentId: string, next: unknown): Step => ({ kind: "agent", id, name, agent: { agentId, version: "current" }, next }) as Step;
/** Fix it (Rovara Code) then Review it. */
const FIX_THEN_REVIEW: ChainDefinitionInput = {
  start: "fix", limits: { maxRunUsd: 30 },
  steps: [agentStep("fix", "Fix it", "rovara-code", { kind: "go", to: "review" }), agentStep("review", "Review it", "code-reviewer", { kind: "end" })],
};
/** Fix it (Rovara Code), the last step. */
const FIX_ONLY: ChainDefinitionInput = { start: "fix", limits: { maxRunUsd: 30 }, steps: [agentStep("fix", "Fix it", "rovara-code", { kind: "end" })] };

/** The coding task of the latest step answered a question: its record holds the answer, and it ends `answered`. */
async function endAnswered(w: GateWorld, taskId = `task-${String(w.tasks.size)}`): Promise<void> {
  w.db.set({ ...(w.db.get(taskKey(taskId)) as Record<string, unknown>), workflow: { outcome: "ANSWERED", intent: { rounds: 0, pathFrom: "request", answers: [], assessment: answer() } } });
  await w.endLatest({ outcome: "answered" });
}
const answeredRun = async (definition: ChainDefinitionInput = FIX_THEN_REVIEW, startedBy: string = PRIYA) => {
  const w = setupGateWorld();
  const chain = await w.publish(definition);
  const run = await w.start(chain.chainId, startedBy);
  await endAnswered(w);
  const gate = w.attempts(run.runId).find((attempt) => attempt.kind === "gate")!;
  return { w, run, gate, approvalId: gate?.approvalId as string };
};

describe("a chain step that ends Answered pauses for a person", () => {
  it("does not go on: the run waits at a gate asking \"Step <name> answered instead of changing code. Continue or stop?\", and the answered step is kept with its answer as its report", async () => {
    const { w, run, gate, approvalId } = await answeredRun();
    expect(w.run(run.runId)).toMatchObject({ status: "waiting", currentSeq: 2 });
    expect(w.attempts(run.runId)[0]).toMatchObject({ seq: 1, stepId: "fix", status: "succeeded", answered: true });
    expect((w.attempts(run.runId)[0]!.result as { report: string }).report.split("\n")[0]).toBe("No code change is needed. Here's the answer:");
    expect(gate).toMatchObject({ seq: 2, kind: "gate", status: "waiting", approvalId });
    expect(await w.stepApproval(approvalId)).toMatchObject({ status: "PENDING", prompt: PROMPT, subject: { kind: "chain_gate", seq: 2 } });
    expect(w.events(run.runId).map((event) => event.text).find((text) => text.startsWith("Waiting for"))).toMatch(/ to continue or stop: "Fix it" answered instead of changing code\.$/u);
  });

  it("starts no second task and spends nothing while it waits", async () => {
    const { w, run } = await answeredRun();
    const spent = w.run(run.runId)!.spentUsd;
    expect(w.starts).toHaveLength(1);
    w.clock.now += 5 * 60_000;
    const { advanceChainRun } = await import("../../packages/broker/src/chains/runner.js");
    await advanceChainRun(w.deps, ORG_A, run.runId);
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.starts).toHaveLength(1);
    expect(w.run(run.runId)).toMatchObject({ status: "waiting", currentSeq: 2, spentUsd: spent });
    expect(w.attempts(run.runId)).toHaveLength(2);
  });

  it("Continue: the run goes on by the answered step's own edge, with the answer as the next step's input; the decision is in the log", async () => {
    const { w, run, approvalId } = await answeredRun();
    const decided = await w.decideAs(PRIYA, approvalId);
    expect(decided.statusCode).toBe(200);
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 3 });
    expect(w.attempts(run.runId).map((attempt) => [attempt.stepId, attempt.kind])).toEqual([["fix", "agent"], ["$answered:fix", "gate"], ["review", "agent"]]);
    expect(w.attempts(run.runId)[1]).toMatchObject({ decision: "approved" });
    expect(w.starts).toHaveLength(2);
    expect(JSON.stringify(w.starts[1]!.input)).toContain("It turns retries on");
    expect(w.decidedEvents(run.runId).map((event) => event.text)).toEqual([expect.stringMatching(/ chose to continue after "Fix it" answered instead of changing code\.$/u)]);
  });

  it("Continue on the last step ends the run as a success", async () => {
    const { w, run, approvalId } = await answeredRun(FIX_ONLY);
    expect(w.run(run.runId)).toMatchObject({ status: "waiting" });
    await w.decideAs(PRIYA, approvalId);
    expect(w.run(run.runId)).toMatchObject({ status: "succeeded" });
    expect(w.starts).toHaveLength(1);
  });

  it("Stop: the run ends cancelled, not failed, with the words, and nothing more starts", async () => {
    const { w, run, approvalId } = await answeredRun();
    const decided = await w.decideAs(PRIYA, approvalId, "decline");
    expect(decided.statusCode).toBe(200);
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled", failure: { reason: "answered_stop", message: 'Stopped after "Fix it" answered instead of changing code.' } });
    expect(w.run(run.runId)!.status).not.toBe("failed");
    expect(w.attempts(run.runId)[1]).toMatchObject({ decision: "declined", status: "succeeded" });
    expect(w.starts).toHaveLength(1);
    expect(w.decidedEvents(run.runId).map((event) => event.text)[0]).toMatch(/chose to stop after "Fix it" answered instead of changing code\.$/u);
  });

  it("is decided once: a second decision changes nothing", async () => {
    const { w, run, approvalId } = await answeredRun();
    await w.decideAs(PRIYA, approvalId);
    const after = w.run(run.runId);
    await w.decideAs(PRIYA, approvalId, "decline");
    expect(w.run(run.runId)).toEqual(after);
    expect(w.starts).toHaveLength(2);
  });

  it("is decided by the starter, a maintainer or the chain's owner, read now; a stranger, another org's member and a viewer cannot", async () => {
    const { w, approvalId } = await answeredRun();
    const { gateEligible } = await gates();
    const record = await w.stepApproval(approvalId);
    expect(await gateEligible(w.deps, record, callerOf(PRIYA))).toBe(true);
    expect(await gateEligible(w.deps, record, callerOf(MAX))).toBe(true);
    expect(await gateEligible(w.deps, record, callerOf(STRANGER))).toBe(false);
    expect(await gateEligible(w.deps, record, callerOf(VIV))).toBe(false);
    expect(await gateEligible(w.deps, record, callerOf(ARJUN))).toBe(false);
    expect((await w.decideAs(STRANGER, approvalId)).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("times out like any gate when no one decides: the run ends timed_out with its own words", async () => {
    const { w, run } = await answeredRun();
    w.clock.now += (GATE_DEFAULT_TIMEOUT_HOURS + 1) * HOUR;
    await expireApprovals(w.deps, w.clock.now);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", failure: { reason: "gate_timeout", message: `No one continued or stopped "Fix it" within ${String(GATE_DEFAULT_TIMEOUT_HOURS)} hours, so the chain stopped.` } });
    expect(w.starts).toHaveLength(1);
  });

  it("reads as a run waiting for a person in the session, naming who", async () => {
    const { w, run } = await answeredRun();
    const facts = await chainSessionSource(w.deps).read(ORG_A, run.runId);
    expect(facts).toMatchObject({ status: "gate" });
    expect(facts?.needsPeople?.length ?? 0).toBeGreaterThan(0);
  });

  it("is only for an Answered end: a step that merged, succeeded or failed behaves as it always did", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(FIX_THEN_REVIEW);
    const run = await w.start(chain.chainId);
    await w.endLatest({ outcome: "merged", pullRequests: [] });
    expect(w.attempts(run.runId).some((attempt) => attempt.kind === "gate")).toBe(false);
    expect(w.attempts(run.runId)[0]!.answered).toBeUndefined();
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 2, status: "running" });
    const failing = setupGateWorld();
    const other = await failing.publish(FIX_THEN_REVIEW);
    const second = await failing.start(other.chainId, PRIYA, randomUUID());
    await failing.endLatest({ outcome: "failed" });
    expect(failing.run(second.runId)!.status).toBe("failed");
  });

  it("an answered end told twice pauses once: one gate, one approval", async () => {
    const { w, run } = await answeredRun();
    await endAnswered(w, "task-1");
    expect(w.attempts(run.runId).filter((attempt) => attempt.kind === "gate")).toHaveLength(1);
    expect(w.run(run.runId)).toMatchObject({ status: "waiting", currentSeq: 2 });
  });
});
