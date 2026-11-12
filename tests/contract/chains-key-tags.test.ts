// Plan 4 Task 28: a key minted for a step of a chain run says which chain and which run it is for (its ledger lines carry both), and a key minted for a step of org B's run names
// B's own things only. The real broker, with the model proxy faked, mints for a step of A's run and of B's run through the route the worker asks.
import "../support/automations-on.js";
import { beforeAll, describe, expect, it } from "vitest";
import { call as callHandler, loadSlackBroker } from "../support/slack-broker.js";
import { OMAR } from "../support/developer-task-broker.js";
import { DANA, MAX, ORG_A, ORG_B, isolationWorld, type IsolationWorld, type Item } from "../support/chains-broker-world.js";

beforeAll(async () => { await loadSlackBroker(); });
type World = IsolationWorld;

describe("the model key of a step", () => {
  let x: World;
  beforeAll(async () => { x = await isolationWorld(); }, 120_000);

  it("carries no tag naming A's chain, run or project, and answers to B's org", async () => {
    // A's run gets a key first, so there is an A key to tell apart from B's.
    const aRun = (await x.w.api(MAX, "POST", `/v1/app/chains/${x.C}/runs`, { project: "web" })).body.run as { runId: string };
    const bStart = await x.w.api(OMAR, "POST", `/v1/app/chains/${x.BC}/runs`, { project: "web" });
    expect(bStart.status, JSON.stringify(bStart.body)).toBe(202);
    const bRun = (bStart.body.run as { runId: string }).runId;
    const mint = async (runId: string, stepId: string) => {
      const task = x.w.stepTask(runId, stepId)!;
      const prepare = (x.w.db.find((item) => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION") as Array<Item & { id: string; kind: string }>).find((operation) => operation.kind === "prepare")!;
      await x.w.h.finish(task.workspaceId, prepare.id, "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
      const active = String((x.w.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
      const invocation = (x.w.db.find((item) => item.entityType === "OUTBOX" && item.operationId === active)[0] as { invocation: { callbackCapability: string } }).invocation;
      const before = x.w.access.mintKey.mock.calls.length;
      const reply = await callHandler(x.w.h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": invocation.callbackCapability } });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      const calls = x.w.access.mintKey.mock.calls.slice(before);
      expect(calls).toHaveLength(1);
      return calls[0]![0];
    };
    const forA = await mint(aRun.runId, "investigate");
    const forB = await mint(bRun, "investigate");
    expect(forA).toMatchObject({ orgId: ORG_A, tags: { chainId: x.C, chainRunId: aRun.runId, project: "web" } });
    expect(forB).toMatchObject({ orgId: ORG_B, tags: { chainId: x.BC, chainRunId: bRun, project: "web", origin: "chain" } });
    const text = JSON.stringify(forB);
    for (const aThing of [x.C, x.P, x.R, aRun.runId, ORG_A, DANA.developerId, MAX.developerId, x.N, x.L, x.H, x.investigator]) expect(text.includes(aThing), `B's key names ${aThing}`).toBe(false);
  });
});

