/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.stringMatching and parsed JSON are untyped */
// N6 fix round 1: the customer's side. `bundle approve` verifies, then places files and writes the approval record last; `bundle withdraw` removes it; and the Rovara
// operator's client sends the deployer a bundle id and nothing else. The deployer itself is tested in bundle-deployer.test.ts against records written by this code's shape.
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalRecordSchema, bundleApprovalKey, sha256OfBytes } from "@agentx/cloud-contracts";
import { approveBundle, withdrawApproval, type ApprovalStore } from "../../packages/cli/src/upgrade/bundle/approve.js";
import { MAX_DEPLOYER_CALLS, startApprovedDeployment } from "../../packages/cli/src/upgrade/bundle/deployer-client.js";
import { verifyBundle } from "../../packages/cli/src/upgrade/bundle/verify.js";
import { builtBundle, type BuiltBundle } from "../support/bundle-fixture.js";
import { World, T0 } from "../support/deployer-world.js";

const made: BuiltBundle[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((bundle) => bundle.cleanup())); });
const build = async () => { const bundle = await builtBundle(); made.push(bundle); return bundle; };

function storeOf(world: World): ApprovalStore & { puts: string[] } {
  const puts: string[] = [];
  return { puts, put: async (key, body) => { puts.push(key); return { versionId: world.putObject(key, body) }; }, remove: async (key) => { world.deleteObject(key); } };
}

describe("agentx bundle approve", () => {
  it("places the deployable files (never the images), pins their object versions, and writes the approval record last; the deployer then deploys exactly it", async () => {
    const bundle = await build();
    const verified = await verifyBundle({ dir: bundle.dir, trustedKeys: [bundle.key.publicKeyPem], approvedBundleSha256: bundle.bundleSha256 });
    const world = new World();
    world.seed({ key: bundle.key.publicKeyPem });
    const store = storeOf(world);
    const record = await approveBundle({ bundle: verified, approvedBy: "arn:aws:sts::123456789012:assumed-role/security/alice", parameters: { "control-plane": { BudgetMonthlyUsd: "300" } }, rollback: false, store, now: () => T0 });
    await verified.cleanup();
    expect(store.puts[store.puts.length - 1]).toBe(bundleApprovalKey(bundle.bundleSha256));
    expect(store.puts.some((key) => key.includes("images/") || key.includes("notes/"))).toBe(false);
    expect(store.puts).toEqual(expect.arrayContaining([`approved/${bundle.bundleSha256}/bundle.json`, `approved/${bundle.bundleSha256}/bundle.sig.json`, `approved/${bundle.bundleSha256}/release.json`]));
    expect(ApprovalRecordSchema.parse(record)).toMatchObject({ bundleId: bundle.bundleSha256, version: "1.4.0", rollback: false, parameters: { "control-plane": { BudgetMonthlyUsd: "300" } } });
    for (const entry of record.files) expect(entry.versionId).toMatch(/^v\d+$/);
    // The deployer reads this record as written. The fixture's control-plane template declares no parameters, so the pinned one is refused: the approval cannot set what the template lacks.
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/BudgetMonthlyUsd, which the control-plane template does not declare/) });
  });

  it("deploys what it approved when no parameters are pinned, and nothing after the approval is withdrawn", async () => {
    const bundle = await build();
    const verified = await verifyBundle({ dir: bundle.dir, trustedKeys: [bundle.key.publicKeyPem] });
    const world = new World();
    world.seed({ key: bundle.key.publicKeyPem });
    const store = storeOf(world);
    await approveBundle({ bundle: verified, approvedBy: "alice", parameters: undefined, rollback: false, store, now: () => T0 });
    await verified.cleanup();
    await withdrawApproval({ bundleId: bundle.bundleSha256, store });
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/withdrawn/) });
    expect(world.changeSets).toEqual([]);
  });

  it("refuses parameters that are not {part: {Name: value}} for a deployable part, and a malformed bundle id to withdraw", async () => {
    const bundle = await build();
    const verified = await verifyBundle({ dir: bundle.dir, trustedKeys: [bundle.key.publicKeyPem] });
    const world = new World();
    const store = storeOf(world);
    for (const bad of [{ access: { A: "b" } }, { "control-plane": { "bad name": "x" } }, { "control-plane": "x" }, [1]]) {
      await expect(approveBundle({ bundle: verified, approvedBy: "alice", parameters: bad, rollback: false, store, now: () => T0 }), JSON.stringify(bad)).rejects.toThrow(/parameters file must be/);
    }
    expect(store.puts).toEqual([]);
    await verified.cleanup();
    await expect(withdrawApproval({ bundleId: "nope", store })).rejects.toThrow(/64 hexadecimal/);
    void sha256OfBytes;
  });

  // Review M2 (0.5.17): `--rollback` meets the same floors as agentx upgrade --rollback-to, from the highest release the install ever ran, before anything is placed.
  it("a rollback approval is refused under a floor, without the install's versions, or for a newer bundle, placing nothing", async () => {
    const bundle = await build();
    const verified = await verifyBundle({ dir: bundle.dir, trustedKeys: [bundle.key.publicKeyPem] });
    const store = storeOf(new World());
    const floors = [{ release: "1.6.0", floor: "1.5.0", reason: "re-keyed every approval row" }];
    // Installed 1.5.0 now, but it ran 1.6.0: 1.6.0's floor still holds, and the 1.4.0 bundle is below it.
    await expect(approveBundle({ bundle: verified, approvedBy: "alice", parameters: undefined, rollback: true, store, now: () => T0, rollbackGuard: { env: "staging", installedVersion: "1.5.0", highWater: "1.6.0", floors, declaredThrough: "1.6.0" } }))
      .rejects.toThrow("release 1.6.0 re-keyed every approval row, so environment staging, which has run 1.6.0 (it runs 1.5.0 now), rolls back no lower than 1.5.0; 1.4.0 is below that floor");
    await expect(approveBundle({ bundle: verified, approvedBy: "alice", parameters: undefined, rollback: true, store, now: () => T0 })).rejects.toThrow("a rollback approval needs the install's recorded and highest versions");
    await expect(approveBundle({ bundle: verified, approvedBy: "alice", parameters: undefined, rollback: true, store, now: () => T0, rollbackGuard: { env: "staging", installedVersion: "1.3.0", highWater: undefined, floors: [], declaredThrough: "1.6.0" } })).rejects.toThrow("release 1.4.0 is newer than 1.3.0");
    expect(store.puts).toEqual([]);
    // Above every floor: approved as a rollback.
    const record = await approveBundle({ bundle: verified, approvedBy: "alice", parameters: undefined, rollback: true, store, now: () => T0, rollbackGuard: { env: "staging", installedVersion: "1.5.0", highWater: "1.6.0", floors: [], declaredThrough: "1.6.0" } });
    expect(record).toMatchObject({ version: "1.4.0", rollback: true, rollbackFrom: { installedVersion: "1.5.0", highWater: "1.6.0" } });
    await verified.cleanup();
  });
});

describe("the operator's client", () => {
  const ID = "a".repeat(64);
  it("sends the deployer exactly {bundleId}, repeats while it is in progress, and stops at the first answer that is not", async () => {
    const calls: Array<{ name: string; payload: unknown }> = [];
    const answers = [{ status: "in-progress", bundleId: ID, done: ["foundation"], remaining: ["identity"] }, { status: "done", bundleId: ID, done: ["foundation", "identity"], remaining: [] }];
    const lines: string[] = [];
    const result = await startApprovedDeployment({ env: "ent", bundleId: ID.toUpperCase(), write: (line) => lines.push(line), invoker: { invoke: async (name, payload) => { calls.push({ name, payload }); return answers.shift(); } } });
    expect(result.status).toBe("done");
    expect(calls).toEqual([{ name: "agentx-ent-bundle-deployer", payload: { bundleId: ID } }, { name: "agentx-ent-bundle-deployer", payload: { bundleId: ID } }]);
    expect(lines.join("\n")).toContain("to do: identity");
  });

  it("refuses a malformed id before any call, an answer it does not know, a failed invocation, and an endless in-progress", async () => {
    let called = 0;
    const invoker = (answer: () => unknown) => ({ invoke: async () => { called += 1; return answer(); } });
    await expect(startApprovedDeployment({ env: "ent", bundleId: "short", write: () => undefined, invoker: invoker(() => ({})) })).rejects.toThrow(/64 hexadecimal/);
    expect(called).toBe(0);
    await expect(startApprovedDeployment({ env: "ent", bundleId: ID, write: () => undefined, invoker: invoker(() => ({ status: "done", extra: 1 })) })).rejects.toThrow(/does not know/);
    await expect(startApprovedDeployment({ env: "ent", bundleId: ID, write: () => undefined, invoker: invoker(() => { throw new Error("AccessDenied"); }) })).rejects.toThrow(/could not be started/);
    called = 0;
    await expect(startApprovedDeployment({ env: "ent", bundleId: ID, write: () => undefined, invoker: invoker(() => ({ status: "in-progress", bundleId: ID })) })).rejects.toThrow(/still in progress/);
    expect(called).toBe(MAX_DEPLOYER_CALLS);
    // A refusal is returned, not retried.
    called = 0;
    expect(await startApprovedDeployment({ env: "ent", bundleId: ID, write: () => undefined, invoker: invoker(() => ({ status: "refused", reason: "not approved" })) })).toMatchObject({ status: "refused" });
    expect(called).toBe(1);
  });
});

describe("agentx bundle reset-deployment (review N8)", () => {
  it("clears a stuck progress record and lock, says which bundle it belonged to, and leaves everything else", async () => {
    const { MemoryParameterStore } = await import("../support/memory-parameter-store.js");
    const { resetDeployment } = await import("../../packages/cli/src/upgrade/bundle/reset-deployment.js");
    const { deployLockParameter, deployProgressParameter } = await import("@agentx/cloud-contracts");
    const store = new MemoryParameterStore();
    await store.put(deployProgressParameter("ent"), JSON.stringify({ schemaVersion: 1, bundleId: "b".repeat(64), startedAt: "2026-10-31T10:00:00.000Z", done: ["foundation"] }));
    await store.put(deployLockParameter("ent"), JSON.stringify({ startedAt: 1 }));
    await store.put("/agentx/ent/settings", "{}");
    expect(await resetDeployment({ store, env: "ent", now: 1 + 21 * 60_000 })).toEqual({ bundleId: "b".repeat(64), clearedProgress: true, clearedLock: true });
    expect([...store.values.keys()]).toEqual(["/agentx/ent/settings"]);
    expect(await resetDeployment({ store, env: "ent", now: 1 + 21 * 60_000 })).toEqual({ bundleId: undefined, clearedProgress: false, clearedLock: false });
  });

  it("refuses while a deployer run holds a live lock (it may still be working), clears an unreadable lock, and clears a stale one", async () => {
    const { MemoryParameterStore } = await import("../support/memory-parameter-store.js");
    const { resetDeployment } = await import("../../packages/cli/src/upgrade/bundle/reset-deployment.js");
    const { deployLockParameter, deployProgressParameter } = await import("@agentx/cloud-contracts");
    const store = new MemoryParameterStore();
    await store.put(deployProgressParameter("ent"), JSON.stringify({ schemaVersion: 1, bundleId: "b".repeat(64), startedAt: "2026-10-31T10:00:00.000Z", done: [] }));
    await store.put(deployLockParameter("ent"), JSON.stringify({ startedAt: 1_000_000, token: "x" }));
    await expect(resetDeployment({ store, env: "ent", now: 1_000_000 + 5 * 60_000 })).rejects.toThrow(/may still be working; nothing was cleared/);
    expect([...store.values.keys()].sort()).toEqual([deployLockParameter("ent"), deployProgressParameter("ent")].sort());
    expect(await resetDeployment({ store, env: "ent", now: 1_000_000 + 21 * 60_000 })).toMatchObject({ clearedProgress: true, clearedLock: true });
    await store.put(deployLockParameter("ent"), "garbage");
    expect(await resetDeployment({ store, env: "ent", now: 5 })).toMatchObject({ clearedLock: true });
  });
});
