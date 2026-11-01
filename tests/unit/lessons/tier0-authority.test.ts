// The production Tier0Authority: it asks the shared second-person evidence reader and hands back its commit conditions as the fence.
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.fn();
let result: unknown;
let failNext = false;
vi.mock("../../../packages/broker/src/org/second-person-evidence.js", () => ({ readSecondPersonApprovalEvidence: async (...args: unknown[]) => { read(...args); if (failNext) throw new Error("FORBIDDEN"); return result; } }));
const { secondPersonTier0Authority } = await import("../../../packages/broker/src/lessons/tier0-authority.js");

const deps = { documentClient: { send: async () => ({}) }, tableName: "t", signInTableName: "s", now: () => 1 };
const id = (c: string): string => c.repeat(64);

describe("secondPersonTier0Authority", () => {
  beforeEach(() => { read.mockReset(); failNext = false; });
  it("maps the evidence to the group and carries the conditions as the fence", async () => {
    const conditions = [{ ConditionCheck: { TableName: "t" } }];
    result = ({ decisionInput: { proposerId: id("a"), approverId: id("b"), nowMs: 1, complete: true, membershipVersion: 7, ownerIds: [id("a")], eligibleIds: [id("a"), id("b")], lastEligibleLossAtMs: 5 }, conditions });
    const authority = secondPersonTier0Authority(deps);
    expect(await authority.eligibility({ kind: "project", workspaceId: "org_aaaaaaaaaaaaaaaaaaaa", project: "web" }, { proposerId: id("a"), approverId: id("b") }))
      .toEqual({ complete: true, membershipVersion: 7, ownerIds: [id("a")], eligibleIds: [id("a"), id("b")], lastEligibleLossAtMs: 5, fence: conditions });
    expect(read).toHaveBeenCalledWith(deps, { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "web", proposerId: id("a"), approverId: id("b") });
  });
  it("a company scope sends no project; a refusal from the reader passes through (the caller fails closed)", async () => {
    failNext = true;
    const authority = secondPersonTier0Authority(deps);
    let thrown: unknown;
    try { await authority.eligibility({ kind: "company", workspaceId: "org_aaaaaaaaaaaaaaaaaaaa" }, { proposerId: id("a"), approverId: id("a") }); } catch (error) { thrown = error; }
    expect((thrown as Error).message).toBe("FORBIDDEN");
    expect(read).toHaveBeenCalledWith(deps, { orgId: "org_aaaaaaaaaaaaaaaaaaaa", proposerId: id("a"), approverId: id("a") });
  });
});
