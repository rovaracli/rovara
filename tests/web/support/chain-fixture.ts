// A run view that meets Plan 4's contract (`ChainRunViewSchema`), for the tests of Plan 5 that stand in for Plan 4's reads.
import type { ChainRunView } from "@rovara-code/contracts";

const AT = "2026-10-22T09:00:00.000Z";
const HEX = "a".repeat(64);

export function chainRunViewOf(runId: string, extra: Partial<ChainRunView> = {}): ChainRunView {
  return {
    contractVersion: 1, sessionId: runId, kind: "chain", chain: { chainId: `chn_${"b".repeat(20)}`, name: "Investigate", version: 1 }, project: "web",
    chainOwner: { kind: "member", id: HEX, name: "Priya" }, owner: { developerId: HEX, name: "Priya" }, startedBy: { kind: "member", developerId: HEX, name: "Priya" },
    status: "running", currentSeq: 1, createdAt: AT, updatedAt: AT, cost: { spentUsd: 0, runLimitUsd: 30 },
    sections: [{ seq: 1, stepId: "investigate", name: "investigate", kind: "agent", status: "running", attempt: 1, startedAt: AT }], ...extra,
  };
}
