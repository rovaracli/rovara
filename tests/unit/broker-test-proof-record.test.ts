// Track record: the structured read of the test proof for one candidate. A fault or a missing proof is "unavailable", never an empty list of verdicts.
import { describe, expect, it } from "vitest";
import type { TestProof } from "../../packages/contracts/src/index.js";
import { readTestProofForCandidate } from "../../packages/broker/src/developer/test-proof-lines.js";

const DIGEST = "a".repeat(64);
const OTHER = "b".repeat(64);
const item = (verdict: TestProof["items"][number]["verdict"]): TestProof["items"][number] => ({
  checkId: "readiness:0", label: "npm test", granularity: "check", verdict,
  reason: verdict === "proves_change" ? "assertion_failed_on_old" : verdict === "does_not_prove" ? "passed_on_old" : "not_a_test_check",
});
const proof = (items: TestProof["items"], digest = DIGEST, status: TestProof["status"] = "checked"): TestProof => ({
  schemaVersion: 1, candidateDigest: digest, status, note: "completed", changedTests: { added: items.length, changed: 0, deleted: 0 }, items, durationMs: 10,
});
const task = { ownerKey: "owner", workspaceId: "ws" };
const actionsFor = (objects: Map<string, string>) => ({
  operations: async () => [
    { id: "op-1", kind: "task", status: "SUCCEEDED", createdAt: "2026-10-27T01:00:00.000Z" },
    { id: "op-2", kind: "task", status: "SUCCEEDED", createdAt: "2026-10-27T02:00:00.000Z" },
    { id: "op-3", kind: "task", status: "SUCCEEDED", createdAt: "2026-10-27T03:00:00.000Z" },
  ],
  artifacts: async (_ws: string, operationId: string) => [{ name: "test-proof.json", objectKey: `private/${operationId === "op-3" ? "other" : "owner"}/ws/${operationId}/a${operationId.slice(-1)}` }],
  readArtifact: async (key: string) => objects.get(key) ?? "",
});

describe("readTestProofForCandidate", () => {
  it("gives the verdicts and the digest of the newest proof bound to the candidate, from the task's own operations only", async () => {
    const actions = actionsFor(new Map([
      ["private/owner/ws/op-1/a1", JSON.stringify(proof([item("does_not_prove")], OTHER))],
      ["private/owner/ws/op-2/a2", JSON.stringify(proof([item("proves_change"), item("not_applicable")]))],
      ["private/other/ws/op-3/a3", JSON.stringify(proof([item("does_not_prove")]))],
    ]));
    expect(await readTestProofForCandidate(actions, task, DIGEST)).toEqual({ verdicts: ["proves_change", "not_applicable"], candidateDigest: DIGEST });
  });

  it("is unavailable when no proof is bound to the candidate, or the candidate is unknown", async () => {
    const stale = JSON.stringify(proof([item("proves_change")], OTHER));
    const actions = actionsFor(new Map([["private/owner/ws/op-1/a1", stale], ["private/owner/ws/op-2/a2", stale], ["private/other/ws/op-3/a3", stale]]));
    expect(await readTestProofForCandidate(actions, task, DIGEST)).toEqual({ unavailable: "not_found" });
    expect(await readTestProofForCandidate(actions, task, undefined)).toEqual({ unavailable: "not_found" });
  });

  it("is unavailable, not an empty list, when reading storage or the operations fails", async () => {
    const objects = new Map([["private/owner/ws/op-2/a2", JSON.stringify(proof([item("proves_change")]))]]);
    const actions = actionsFor(objects);
    expect(await readTestProofForCandidate({ ...actions, readArtifact: async () => { throw new Error("S3 down"); } }, task, DIGEST)).toEqual({ unavailable: "read_failed" });
    expect(await readTestProofForCandidate({ ...actions, operations: async () => { throw new Error("db down"); } }, task, DIGEST)).toEqual({ unavailable: "read_failed" });
    expect(await readTestProofForCandidate({ ...actions, readArtifact: async () => "{not json" }, task, DIGEST)).toEqual({ unavailable: "read_failed" });
  });

  it("gives no verdicts for a proof that did not run, so no claim can be made from it", async () => {
    const actions = actionsFor(new Map([["private/owner/ws/op-2/a2", JSON.stringify(proof([], DIGEST, "not_checked"))]]));
    expect(await readTestProofForCandidate(actions, task, DIGEST)).toEqual({ verdicts: [], candidateDigest: DIGEST });
  });
});
