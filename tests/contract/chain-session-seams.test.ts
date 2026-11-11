// Plan 4's side of Plan 5's chain seams (chains/session-seam.ts), on Plan 4's own records: what a message to a chain is for, who may stop and retry a run through its session, and the
// move of a run's owner and payer to the person who took its session over. Every one is bound to the org it is asked for.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onStepTaskEnded, recordGateDecision, startChainRun } from "../../packages/broker/src/chains/runner.js";
import { chainControlFor, chainOwnerMoverFor, chainSteerReadsFor } from "../../packages/broker/src/chains/session-seam.js";
import type { ChainDefinitionInput } from "@rovara-code/contracts";
import { chainRunKey } from "@rovara-code/contracts";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";
import { ARJUN, CARL, DANA, MAX, ORG_A, ORG_B, PRIYA, STRANGER, callerOf, decisionBy, setupWorld, type ChainWorld } from "../support/chain-run-world.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });
afterAll(async () => { (await loadSlackBroker() as unknown as { uninstallChainRunner(): void }).uninstallChainRunner(); });

const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 30 } };
const actor = (developerId: string) => ({ kind: "session" as const, developerId });
const start = (w: ChainWorld, who: string, chainId: string, extra: Record<string, unknown> = {}) =>
  startChainRun(w.deps, callerOf(who), { orgId: ORG_A, chainId, project: "web", origin: "app", startedBy: { kind: "member", developerId: who }, requestId: randomUUID(), ...extra } as never);

describe("what a message to a chain is for", () => {
  it("is the running step's task, the gate while the run waits at one, and nothing once it is over or for another org", async () => {
    const w = setupWorld();
    const steer = chainSteerReadsFor(w.deps);
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await start(w, PRIYA, chain.chainId);
    expect(await steer.current(ORG_A, run.runId)).toEqual({ kind: "step", taskId: "task-1" });
    expect(await steer.current(ORG_B, run.runId)).toEqual({ kind: "none" });
    expect(await steer.current(ORG_A, "not-a-run")).toEqual({ kind: "none" });
    await onStepTaskEnded(w.deps, w.endEvent("task-1", { finalReport: "Bug in refund retry", branch: "fix" }));
    expect(w.run(run.runId)).toMatchObject({ status: "waiting" });
    expect(await steer.current(ORG_A, run.runId)).toEqual({ kind: "gate" });
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2));
    expect(await steer.current(ORG_A, run.runId)).toEqual({ kind: "step", taskId: "task-2" });
    await chainControlFor(w.deps).cancel(ORG_A, actor(PRIYA), run.runId, randomUUID());
    expect(w.run(run.runId)?.status).toBe("cancelled");
    expect(await steer.current(ORG_A, run.runId)).toEqual({ kind: "none" });
  });
});

describe("stopping and retrying a chain run through its session", () => {
  it("stops a run for a person Plan 5 judged, who is not the starter or a maintainer, and refuses the same person on Plan 4's own rule", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await start(w, PRIYA, chain.chainId);
    const { cancelChainRun } = await import("../../packages/broker/src/chains/lifecycle.js");
    await expect(cancelChainRun(w.deps, callerOf(CARL), run.runId, { requestId: randomUUID() })).rejects.toBeDefined();
    expect(w.run(run.runId)?.status).toBe("running");
    await chainControlFor(w.deps).cancel(ORG_A, actor(CARL), run.runId, randomUUID());
    expect(w.run(run.runId)).toMatchObject({ status: "cancelled", cancelledBy: CARL });
  });

  it("reaches no run of another org, and no run for a person who is not a member of the org it is asked for", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await start(w, PRIYA, chain.chainId);
    const control = chainControlFor(w.deps);
    await expect(control.cancel(ORG_B, actor(STRANGER), run.runId, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(control.cancel(ORG_A, actor(STRANGER), run.runId, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(control.retry(ORG_B, actor(PRIYA), run.runId, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(w.run(run.runId)?.status).toBe("running");
  });

  it("retries a run as a new run of the same chain, project and input started by the retrier, once for one request, and applies the chain's use rule", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await start(w, PRIYA, chain.chainId, { input: "Why did checkout fail?" });
    const control = chainControlFor(w.deps);
    const requestId = randomUUID();
    const first = await control.retry(ORG_A, actor(DANA), run.runId, requestId);
    const again = await control.retry(ORG_A, actor(DANA), run.runId, requestId);
    expect(again).toEqual(first);
    expect(first.sessionId).not.toBe(run.runId);
    expect(w.run(first.sessionId)).toMatchObject({ chainId: chain.chainId, project: "web", input: "Why did checkout fail?", startedBy: { kind: "member", developerId: DANA }, owner: { developerId: DANA } });
    // A person with no role on the project can't start it, however the retry was reached.
    await expect(control.retry(ORG_A, actor(ARJUN), run.runId, randomUUID())).rejects.toBeDefined();
    expect(w.db.find((item) => item.entityType === "CHAIN_RUN")).toHaveLength(2);
  });
});

describe("taking a chain session over moves its run", () => {
  const apply = (w: ChainWorld, items: unknown[]) => w.db.send(new TransactWriteCommand({ TransactItems: items as never }));

  it("reads who pays and the version, and moves the owner and a member's payer to the taker, only from the version it read", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await start(w, PRIYA, chain.chainId);
    const mover = chainOwnerMoverFor(w.deps);
    const read = await mover.read(ORG_A, run.runId);
    expect(read).toEqual({ payer: { kind: "member", developerId: PRIYA }, fence: w.run(run.runId)!.version, runningStepTaskId: "task-1" });
    expect(await mover.read(ORG_B, run.runId)).toBeUndefined();
    const items = mover.ownerItems({ orgId: ORG_A, chainRunId: run.runId, to: { developerId: MAX, name: "Max" }, payer: read!.payer, fence: read!.fence });
    await apply(w, items);
    expect(w.run(run.runId)).toMatchObject({ owner: { developerId: MAX }, payer: { kind: "member", developerId: MAX }, version: read!.fence! + 1 });
    // The same items again, from a version the run is no longer at, change nothing.
    await expect(apply(w, items)).rejects.toBeDefined();
    expect(w.run(run.runId)).toMatchObject({ owner: { developerId: MAX } });
  });

  it("keeps a payer that is not a member, refuses a run that moved since it was read, and refuses to move one with no version", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await start(w, PRIYA, chain.chainId);
    const mover = chainOwnerMoverFor(w.deps);
    const read = (await mover.read(ORG_A, run.runId))!;
    const project = { kind: "project" as const, project: "web" };
    await apply(w, mover.ownerItems({ orgId: ORG_A, chainRunId: run.runId, to: { developerId: MAX, name: "Max" }, payer: project, fence: read.fence }));
    expect(w.run(run.runId)).toMatchObject({ owner: { developerId: MAX }, payer: { kind: "member", developerId: PRIYA } });
    const stale = mover.ownerItems({ orgId: ORG_A, chainRunId: run.runId, to: { developerId: CARL, name: "Carl" }, payer: project, fence: read.fence });
    await expect(apply(w, stale)).rejects.toBeDefined();
    expect(() => mover.ownerItems({ orgId: ORG_A, chainRunId: run.runId, to: { developerId: CARL, name: "Carl" }, payer: project })).toThrow();
    expect(w.db.get(chainRunKey(ORG_A, run.runId, "META").pk, "META")).toMatchObject({ owner: { developerId: MAX } });
  });

  it("reads nothing of a run that is over", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await start(w, PRIYA, chain.chainId);
    await onStepTaskEnded(w.deps, w.endEvent("task-1", { finalReport: "Done" }));
    expect(w.run(run.runId)?.status).toBe("succeeded");
    expect(await chainOwnerMoverFor(w.deps).read(ORG_A, run.runId)).toBeUndefined();
  });
});
