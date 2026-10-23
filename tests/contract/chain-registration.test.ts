// Plan 4 Task 8: what exists as soon as the chain code is loaded, before anything at broker start runs. A gate made while nothing could decide it would wait for nothing, and
// an approval that names the autonomous write rule must be decidable wherever it is read, so both rules and the gate's handler are registered on import. The selector that names
// the write rule is not: it is registered with the rule at broker start (`registerChainRunner`), which `chain-write-approvers.test.ts` covers.
import { describe, expect, it, vi } from "vitest";

describe("what is registered when the code loads", () => {
  it("has the gate's rule and handler, and the autonomous write rule, with the broker not started", async () => {
    vi.resetModules();
    const approvals = await import("../../packages/broker/src/agents/approvals.js");
    expect(approvals.getApproverRule("chain_gate")).toBeUndefined();
    expect(approvals.getApprovalSubjectHandler("chain_gate")).toBeUndefined();
    expect(approvals.getApproverRule("chain_autonomous_writer")).toBeUndefined();
    await import("../../packages/broker/src/chains/gates.js");
    expect(approvals.getApproverRule("chain_gate")).toBeTypeOf("function");
    expect(approvals.getApprovalSubjectHandler("chain_gate")).toBeTypeOf("function");
    expect(approvals.getApproverRule("chain_autonomous_writer")).toBeUndefined();
    await import("../../packages/broker/src/chains/write-approvers.js");
    expect(approvals.getApproverRule("chain_autonomous_writer")).toBeTypeOf("function");
  });
});
