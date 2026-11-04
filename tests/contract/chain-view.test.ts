// Plan 4 Task 10: the one-session view data of a chain run (the Plan 5 contract). The view, its event log, the chain-scoped read of a step's task and the list of runs;
// who reads each (the starter, the run's owner, `view` on the chain and the project, org owners and admins; the step task needs `start_tasks` too); and the seams
// Plan 5's sessions read through (the facts of a run, which record is about which session, who may read, and the internal session actor).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setChainShares } from "../../packages/broker/src/chains/access.js";
import { routeChainRequest } from "../../packages/broker/src/chains/routes.js";
import type { ChainViewPorts } from "../../packages/broker/src/chains/view.js";
import { chainRunEvents, chainRunView, chainStepTask, listChainRuns } from "../../packages/broker/src/chains/view.js";
import { chainReadAccessFor, chainSessionReads, chainSessionSource } from "../../packages/broker/src/chains/session-seam.js";
import { onStepTaskEnded, startChainRun } from "../../packages/broker/src/chains/runner.js";
import { sweepChainRuns } from "../../packages/broker/src/chains/lifecycle.js";
import { ChainRunViewSchema } from "../../packages/contracts/src/chain-session.js";
import { ChainRunEventPageSchema, ChainRunListSchema, ChainRunViewReaderSchema, ChainStepTaskViewSchema } from "../../packages/contracts/src/chain-session.js";
import type { ChainDefinitionInput } from "../../packages/contracts/src/chains.js";
import { approvalKey, chainKey, chainRunKey, chainRunsByChainKey, chainRunsByProjectKey, runEventSk, stepSk } from "../../packages/contracts/src/org-scoped-keys.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { orgMemberKey } from "../../packages/contracts/src/org-node.js";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";
import { ARJUN, CARL, DANA, MAX, ORG_A, ORG_B, PRIYA, STRANGER, VIV, callerOf, disposeGateWorlds, setupGateWorld, type GateWorld } from "../support/chain-gate-world.js";

afterEach(() => disposeGateWorlds());

const TRIGGER_ID = `ctr_${"t".repeat(20)}`;
const TASK_UUID = "7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d";
const MIN = 60_000;
const NOBODY = "9".repeat(64);

type Step = ChainDefinitionInput["steps"][number];
const agentStep = (id: string, name: string, agentId: string, next: unknown, extra: Record<string, unknown> = {}): Step => ({ kind: "agent", id, name, agent: { agentId, version: "current" }, next, ...extra }) as Step;
const twoSteps = (first: Record<string, unknown> = {}): ChainDefinitionInput => ({
  start: "look", limits: { maxRunUsd: 30 },
  steps: [agentStep("look", "Look into it", "root-cause-analyst", { kind: "go", to: "act" }, first), agentStep("act", "Act on it", "code-reviewer", { kind: "end" })],
});

/** What the port gives for a task: a task view that parses, with a run, an event and no approval arguments, and what each call asked. */
interface FakePorts extends ChainViewPorts {
  views: string[];
  facts: string[];
  spend: Map<string, number>;
  pending: Map<string, number>;
  failFacts: boolean;
  taskExtra: Record<string, unknown>;
}
function fakePorts(): FakePorts {
  const ports: FakePorts = {
    views: [], facts: [], spend: new Map(), pending: new Map(), failFacts: false, taskExtra: {},
    taskView: async (task) => {
      ports.views.push(String(task.taskId));
      return {
        taskId: TASK_UUID, title: "Fix it", project: "web", status: "RUNNING", startingRevision: 1, client: "app", shared: false, createdAt: "2026-10-22T09:00:00.000Z", updatedAt: "2026-10-22T09:00:00.000Z",
        events: [{ at: "2026-10-22T09:00:01.000Z", kind: "status", text: "Working." }],
        run: { state: "RUNNING", steps: [], pendingApprovals: [{ approvalId: `apr_${"a".repeat(20)}`, kind: "write", text: "Push the branch?", ...ports.taskExtra }] },
      } as never;
    },
    taskFacts: async (_orgId, taskId) => {
      ports.facts.push(taskId);
      if (ports.failFacts) throw new Error("the ledger is not reachable");
      return { spentUsd: ports.spend.get(taskId) ?? 0, pendingApprovals: ports.pending.get(taskId) ?? 0 };
    },
  };
  return ports;
}

interface ViewWorld { w: GateWorld; ports: FakePorts; deps: GateWorld["deps"] & { chainView: ChainViewPorts } }
const world = (): ViewWorld => {
  const w = setupGateWorld();
  const ports = fakePorts();
  return { w, ports, deps: { ...w.deps, chainView: ports } };
};
const end = async (w: GateWorld, taskId: string, extra: Record<string, unknown> = {}) => onStepTaskEnded(w.deps, w.endEvent(taskId, { finalReport: "the report", ...extra }));
/** What a call said when it was refused: its code. */
const refused = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code);
const share = async (v: ViewWorld, chainId: string, developerId: string, level: "view" | "use" | "edit" = "view") =>
  setChainShares({ ...v.deps, store: v.w.chains }, { orgId: ORG_A, chainId, shares: [{ principal: { kind: "member", developerId }, level }], by: PRIYA });

/** The example, run to its review step: started by `startedBy`, `fix` chosen, the gate approved by Max, the fix done; the review (seq 4) runs. */
async function reachReview(v: ViewWorld, startedBy: string = PRIYA, fixEnd: Record<string, unknown> = {}) {
  const { chain, run, approvalId } = await v.w.runAtGate(startedBy);
  await v.w.decideAs(MAX, approvalId);
  await end(v.w, "task-2", fixEnd);
  return { chain, run, approvalId };
}
const eventRun = async (v: ViewWorld, chainId: string, owner: string = PRIYA) => startChainRun(v.deps, { system: "event", owner: { developerId: owner } }, {
  orgId: ORG_A, chainId, project: "web", origin: "event",
  startedBy: { kind: "event", triggerId: TRIGGER_ID, eventKey: "sentry:evt-1", source: "sentry", type: "issue.created", title: "Refund errors", url: "https://sentry.example.com/issues/1" },
  trigger: { eventKey: "sentry:evt-1", source: "sentry", type: "issue.created", subject: { kind: "alert", title: "Refund errors", url: "https://sentry.example.com/issues/1" } },
  requestId: randomUUID(),
} as never);

describe("the view of a run", () => {
  it("shows the four sections of INVESTIGATE_THEN_FIX in seq order, with the gate's exact words and the fix as a Rovara Code task", async () => {
    const v = world();
    const { chain, run, approvalId } = await reachReview(v);
    const shown = await chainRunView(v.deps, callerOf(PRIYA), run.runId);
    expect(ChainRunViewSchema.parse(shown)).toEqual(shown);
    expect(shown).toMatchObject({
      contractVersion: 1, sessionId: run.runId, kind: "chain", chain: { chainId: chain.chainId, name: chain.name, version: 1 }, project: "web", status: "running", currentSeq: 4,
      owner: { developerId: PRIYA, name: "Priya" }, chainOwner: { kind: "member", id: PRIYA, name: "Priya" }, startedBy: { kind: "member", developerId: PRIYA, name: "Priya" },
      cost: { runLimitUsd: 30 },
    });
    expect(shown.sections.map((section) => [section.seq, section.stepId, section.kind, section.status])).toEqual([
      [1, "investigate", "agent", "succeeded"], [2, "approve_fix", "gate", "succeeded"], [3, "fix", "agent", "succeeded"], [4, "review", "agent", "running"],
    ]);
    expect(shown.sections[1]!.gate).toEqual({
      prompt: "Should Rovara Code fix this?", status: "APPROVED", approvers: "the person who started this run or a maintainer of web",
      confirmUrl: `https://cell.example.com/v1/app/approve/${approvalId}`, decidedBy: { developerId: MAX, name: "Max" }, decidedAt: (expect.any(String) as string),
    });
    expect(shown.sections[2]).toMatchObject({ name: "Fix it", detail: { kind: "task", taskId: "task-2", rovaraCode: true }, agent: { agentId: "rovara-code", name: "Rovara Code", version: (expect.any(Number) as number) } });
    expect(shown.sections[0]).toMatchObject({ detail: { kind: "task", taskId: "task-1", rovaraCode: false }, report: "the report", branchTaken: { id: "fix", description: "The cause is in our code and a code change fixes it", fellBack: false } });
    expect(shown.sections[1]).not.toHaveProperty("detail");
    expect(shown.sections[0]).not.toHaveProperty("gate");
    expect(shown.sections[0]!.endedAt).toEqual(expect.any(String));
    expect(shown.sections[3]).not.toHaveProperty("endedAt");
    expect(shown.sections[3]).not.toHaveProperty("report");
  });

  it("parses with the reader schema too, and a gate that is still waiting is PENDING with no decision", async () => {
    const v = world();
    const { run } = await v.w.runAtGate(PRIYA);
    const shown = await chainRunView(v.deps, callerOf(PRIYA), run.runId);
    expect(ChainRunViewReaderSchema.parse(shown)).toMatchObject({ status: "waiting" });
    expect(shown.sections[1]!.gate).toMatchObject({ status: "PENDING" });
    expect(shown.sections[1]!.gate).not.toHaveProperty("decidedBy");
    expect(shown.sections[1]).toMatchObject({ status: "waiting" });
  });

  it("shows a declined and an expired gate as such", async () => {
    const v = world();
    const declined = await v.w.runAtGate(PRIYA);
    await v.w.decideAs(MAX, declined.approvalId, "decline");
    expect((await chainRunView(v.deps, callerOf(PRIYA), declined.run.runId)).sections[1]!.gate).toMatchObject({ status: "DECLINED", decidedBy: { developerId: MAX } });
    const second = await v.w.runAtGate(PRIYA);
    v.w.clock.now += 80 * 60 * MIN;
    const { expireApprovals } = await import("../../packages/broker/src/agents/approvals.js");
    await expireApprovals(v.deps, v.w.clock.now);
    expect((await chainRunView(v.deps, callerOf(PRIYA), second.run.runId)).sections[1]!.gate).toMatchObject({ status: "EXPIRED" });
  });

  it("shows the start of an event run with its trigger, and of a schedule run with its trigger and time", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await eventRun(v, chain.chainId, CARL);
    const shown = await chainRunView(v.deps, callerOf(CARL), run.runId);
    expect(shown.startedBy).toEqual({ kind: "event", triggerId: TRIGGER_ID, source: "sentry", type: "issue.created", title: "Refund errors", url: "https://sentry.example.com/issues/1" });
    expect(shown.owner).toEqual({ developerId: CARL, name: "Carl" });
    const scheduled = await startChainRun(v.deps, { system: "schedule", owner: { developerId: PRIYA } }, {
      orgId: ORG_A, chainId: chain.chainId, project: "web", origin: "schedule", startedBy: { kind: "schedule", triggerId: TRIGGER_ID, scheduledAt: "2026-10-22T08:00:00.000Z" }, requestId: randomUUID(),
    } as never);
    expect((await chainRunView(v.deps, callerOf(PRIYA), scheduled.runId)).startedBy).toEqual({ kind: "schedule", triggerId: TRIGGER_ID, scheduledAt: "2026-10-22T08:00:00.000Z" });
    expect(JSON.stringify(shown)).not.toContain("eventKey");
  });

  it("shows a retried step as two sections, attempts 1 and 2", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps({ retries: 1 }));
    const run = await v.w.start(chain.chainId);
    await end(v.w, "task-1", { outcome: "failed" });
    const shown = await chainRunView(v.deps, callerOf(PRIYA), run.runId);
    expect(shown.sections.map((section) => [section.seq, section.stepId, section.attempt, section.status])).toEqual([[1, "look", 1, "failed"], [2, "look", 2, "running"]]);
  });

  it("shows a run's failure and end, and its cost and limit", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    await end(v.w, "task-1", { outcome: "failed", spentUsd: 1.25 });
    const shown = await chainRunView(v.deps, callerOf(PRIYA), run.runId);
    expect(shown).toMatchObject({ status: "failed", cost: { spentUsd: 1.25, runLimitUsd: 30 }, failure: { reason: "step_failed", message: (expect.stringContaining("Look into it") as string) }, endedAt: (expect.any(String) as string) });
    expect(shown.failure).not.toHaveProperty("seq");
    expect(ChainRunViewSchema.parse(shown)).toEqual(shown);
  });

  it("shows a section's cost and open approvals from the task, leaves them out when the task can't say, and never fails the view for it", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    v.ports.spend.set("task-1", 0.4);
    v.ports.pending.set("task-1", 2);
    const shown = await chainRunView(v.deps, callerOf(PRIYA), run.runId);
    expect(shown.sections[0]).toMatchObject({ costUsd: 0.4, pendingApprovals: 2, stopAtUsd: 2 });
    v.ports.failFacts = true;
    const again = await chainRunView(v.deps, callerOf(PRIYA), run.runId);
    expect(again.sections[0]).not.toHaveProperty("costUsd");
    expect(again.sections[0]).not.toHaveProperty("pendingApprovals");
    expect(again.sections[0]).toMatchObject({ status: "running", detail: { taskId: "task-1" } });
    const bare = await chainRunView({ ...v.w.deps }, callerOf(PRIYA), run.runId);
    expect(bare.sections[0]).not.toHaveProperty("costUsd");
  });

  it("refuses to show a stored run that does not satisfy the contract, rather than sending it", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    v.w.db.set({ ...v.w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, spentUsd: -1 });
    await expect(chainRunView(v.deps, callerOf(PRIYA), run.runId)).rejects.toThrow();
  });

  it("neutralises a name that carries control characters", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    v.w.db.set({ pk: `DEVELOPER#${PRIYA}`, sk: "META", developerId: PRIYA, provider: "oidc", displayName: "Priya‮evil\u0007", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const shown = await chainRunView(v.deps, callerOf(PRIYA), run.runId);
    expect(shown.owner.name).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });
});

describe("who reads a run", () => {
  it("lets the starter, the run's owner, org admins and people with view on the chain and the project read it, and nobody else", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId, PRIYA);
    const read = (who: string) => refused(chainRunView(v.deps, callerOf(who), run.runId));
    expect(await read(PRIYA)).toBeUndefined();
    expect(await read(DANA)).toBeUndefined();
    expect(await read(CARL)).toBe("NOT_FOUND");
    expect(await read(MAX)).toBe("NOT_FOUND");
    await share(v, chain.chainId, CARL, "view");
    expect(await read(CARL)).toBeUndefined();
    await share(v, chain.chainId, VIV, "view");
    expect(await read(VIV)).toBeUndefined();
    await share(v, chain.chainId, ARJUN, "view");
    expect(await read(ARJUN)).toBe("NOT_FOUND");
    expect(await refused(chainRunView(v.deps, callerOf(STRANGER, ORG_B), run.runId))).toBe("NOT_FOUND");
  });

  it("lets the owner of an event-started run read it without having started it, and not the chain's owner who has no view", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps(), { owner: { kind: "member", developerId: PRIYA } });
    const run = await eventRun(v, chain.chainId, CARL);
    expect(await refused(chainRunView(v.deps, callerOf(CARL), run.runId))).toBeUndefined();
    expect(await refused(chainRunView(v.deps, callerOf(PRIYA), run.runId))).toBeUndefined();
    expect(await refused(chainRunView(v.deps, callerOf(MAX), run.runId))).toBe("NOT_FOUND");
  });

  it("answers 404 for a run id that is not one, a run that does not exist and a run of another org, and reads under the caller's org", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    expect(await refused(chainRunView(v.deps, callerOf(PRIYA), "nope"))).toBe("NOT_FOUND");
    expect(await refused(chainRunView(v.deps, callerOf(PRIYA), `crn_${"z".repeat(20)}`))).toBe("NOT_FOUND");
    expect(await refused(chainRunView(v.deps, { ...callerOf(PRIYA), orgId: ORG_B }, run.runId))).toBe("NOT_FOUND");
    expect(await refused(chainRunEvents(v.deps, callerOf(STRANGER, ORG_B), run.runId, 0))).toBe("NOT_FOUND");
  });

  it("never puts a confirmation link in the event log, which a reader who may not decide the gate reads too (review I-1)", async () => {
    const v = world();
    const { run, approvalId } = await v.w.runAtGate(PRIYA);
    await share(v, run.chainId, CARL, "view");
    for (const who of [CARL, PRIYA]) {
      const page = await chainRunEvents(v.deps, callerOf(who), run.runId, 0);
      const waiting = page.events.filter((event) => event.type === "gate_waiting");
      expect(waiting, who).toHaveLength(1);
      for (const event of page.events) expect(event.text, `${who} ${event.type}`).not.toMatch(/https?:|\/approve\/|apr_/i);
      expect(JSON.stringify(page)).not.toContain(approvalId);
    }
  });

  it("takes the live chain: a chain that is gone leaves only the starter, the owner and admins", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId, PRIYA);
    await share(v, chain.chainId, CARL, "view");
    expect(await refused(chainRunView(v.deps, callerOf(CARL), run.runId))).toBeUndefined();
    v.w.db.delete(chainKey(ORG_A, chain.chainId, "META"));
    expect(await refused(chainRunView(v.deps, callerOf(CARL), run.runId))).toBe("NOT_FOUND");
    expect(await refused(chainRunView(v.deps, callerOf(PRIYA), run.runId))).toBeUndefined();
  });
});

describe("the event log", () => {
  it("reads seq 1..n with no gaps, and nothing after the last", async () => {
    const v = world();
    const { run } = await reachReview(v);
    const page = await chainRunEvents(v.deps, callerOf(PRIYA), run.runId, 0);
    expect(ChainRunEventPageSchema.parse(page)).toEqual(page);
    const seqs = page.events.map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    expect(seqs.length).toBeGreaterThanOrEqual(8);
    expect(page.events[0]).toMatchObject({ type: "started" });
    expect(page.events[1]).toMatchObject({ type: "step_started", stepSeq: 1 });
    expect(page.events[0]).not.toHaveProperty("stepSeq");
    expect(page).not.toHaveProperty("next");
    expect(v.w.run(run.runId)!.eventSeq).toBe(seqs.length);
    expect((await chainRunEvents(v.deps, callerOf(PRIYA), run.runId, seqs.length)).events).toEqual([]);
    expect((await chainRunEvents(v.deps, callerOf(PRIYA), run.runId, seqs.length - 2)).events.map((event) => event.seq)).toEqual(seqs.slice(-2));
  });

  it("pages at 200 with `next` the last seq of the page, and the second page ends it", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    const have = v.w.events(run.runId).length;
    for (let seq = have + 1; seq <= 205; seq += 1) v.w.db.set({ ...chainRunKey(ORG_A, run.runId, runEventSk(seq)), entityType: "CHAIN_RUN_EVENT", orgId: ORG_A, runId: run.runId, seq, at: "2026-10-22T09:00:00.000Z", type: "step_started", text: `event ${String(seq)}` });
    const first = await chainRunEvents(v.deps, callerOf(PRIYA), run.runId, 0);
    expect(first.events).toHaveLength(200);
    expect(first.next).toBe(200);
    const second = await chainRunEvents(v.deps, callerOf(PRIYA), run.runId, first.next!);
    expect(second.events.map((event) => event.seq)).toEqual([201, 202, 203, 204, 205]);
    expect(second).not.toHaveProperty("next");
  });

  it("is org-scoped: an event row that names another org is left out", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    const have = v.w.events(run.runId).length;
    v.w.db.set({ ...chainRunKey(ORG_A, run.runId, runEventSk(have + 1)), entityType: "CHAIN_RUN_EVENT", orgId: ORG_B, runId: run.runId, seq: have + 1, at: "2026-10-22T09:00:00.000Z", type: "step_started", text: "foreign" });
    expect((await chainRunEvents(v.deps, callerOf(PRIYA), run.runId, 0)).events.map((event) => event.text)).not.toContain("foreign");
  });

  it("refuses an `after` that is not a whole number from 0", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    for (const bad of [-1, 1.5, Number.NaN, 1_000_000, 10_000_000]) expect(await refused(chainRunEvents(v.deps, callerOf(PRIYA), run.runId, bad))).toBe("CONFIG_INVALID");
    expect((await chainRunEvents(v.deps, callerOf(PRIYA), run.runId, 999_999)).events).toEqual([]);
  });
});

describe("the chain-scoped read of a step's task", () => {
  it("lets a contributor with view on the chain read the fix section's task, with its run and events", async () => {
    const v = world();
    const { chain, run } = await reachReview(v);
    await share(v, chain.chainId, CARL, "view");
    const shown = await chainStepTask(v.deps, callerOf(CARL), run.runId, 3);
    expect(ChainStepTaskViewSchema.parse(shown)).toEqual(shown);
    expect(shown).toMatchObject({ seq: 3, taskId: "task-2", rovaraCode: true, task: { run: { state: "RUNNING" }, events: [{ text: "Working." }] } });
    expect(v.ports.views).toEqual(["task-2"]);
    expect(JSON.stringify(shown)).not.toContain("arguments");
  });

  it("gives a project viewer with view on the chain 404 for the task and keeps the section summary", async () => {
    const v = world();
    const { chain, run } = await reachReview(v);
    await share(v, chain.chainId, VIV, "view");
    expect(await refused(chainStepTask(v.deps, callerOf(VIV), run.runId, 3))).toBe("NOT_FOUND");
    expect(v.ports.views).toEqual([]);
    expect((await chainRunView(v.deps, callerOf(VIV), run.runId)).sections[2]).toMatchObject({ detail: { taskId: "task-2" } });
  });

  it("lets the starter, a maintainer with view on the chain and an org admin read it, and refuses a reader with no project role", async () => {
    const v = world();
    const { chain, run } = await reachReview(v, PRIYA);
    expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, 1))).toBeUndefined();
    expect(await refused(chainStepTask(v.deps, callerOf(DANA), run.runId, 1))).toBeUndefined();
    expect(await refused(chainStepTask(v.deps, callerOf(MAX), run.runId, 1))).toBe("NOT_FOUND");
    await share(v, chain.chainId, MAX, "view");
    expect(await refused(chainStepTask(v.deps, callerOf(MAX), run.runId, 1))).toBeUndefined();
    await share(v, chain.chainId, ARJUN, "view");
    expect(await refused(chainStepTask(v.deps, callerOf(ARJUN), run.runId, 1))).toBe("NOT_FOUND");
  });

  it("answers 404 for a seq that is no step's, a gate's, a task of another run, another org's run and a task the record puts in another org", async () => {
    const v = world();
    const { run } = await reachReview(v);
    expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, 99))).toBe("NOT_FOUND");
    expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, 0))).toBe("NOT_FOUND");
    expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, 2))).toBe("NOT_FOUND");
    expect(await refused(chainStepTask(v.deps, callerOf(STRANGER, ORG_B), run.runId, 1))).toBe("NOT_FOUND");
    const other = `crn_${"q".repeat(20)}`;
    v.w.db.set({ ...v.w.db.get(taskKey("task-2"))!, chain: { chainRunId: other, stepId: "fix" } });
    expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, 3))).toBe("NOT_FOUND");
    v.w.db.set({ ...v.w.db.get(taskKey("task-2"))!, chain: { chainRunId: run.runId, stepId: "fix" }, orgId: ORG_B });
    expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, 3))).toBe("NOT_FOUND");
    expect(v.ports.views).toEqual([]);
  });

  it("answers 404 for an attempt with no task yet and for a task record that is gone", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    v.w.db.delete(taskKey("task-1").pk, taskKey("task-1").sk);
    expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, 1))).toBe("NOT_FOUND");
    v.w.db.set({ ...v.w.db.get(chainRunKey(ORG_A, run.runId, stepSk(1)))!, taskId: undefined });
    expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, 1))).toBe("NOT_FOUND");
  });

  it("fails closed when the task view would carry an approval's arguments or a credential", async () => {
    const v = world();
    const { run } = await reachReview(v);
    v.ports.taskExtra = { arguments: { token: "ghp_secret" } };
    const failure = await chainStepTask(v.deps, callerOf(PRIYA), run.runId, 3).then(() => undefined, (error: { code?: string; message: string }) => error);
    expect(failure?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(JSON.stringify(failure)).not.toContain("ghp_secret");
  });

  it("answers RUNTIME_UNAVAILABLE where no task read is wired", async () => {
    const v = world();
    const { run } = await reachReview(v);
    expect(await refused(chainStepTask({ ...v.w.deps }, callerOf(PRIYA), run.runId, 3))).toBe("RUNTIME_UNAVAILABLE");
  });
});

describe("the routes", () => {
  const call = (v: ViewWorld, who: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}, caller = callerOf(who)) =>
    routeChainRequest(v.deps, caller, { method: init.method ?? "GET", path: path.split("?")[0]!, requestId: "r", headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }, new URL(`https://cell.example.com${path}`));

  it("serves the view, the events, a step's task and the list, each parsing with its schema", async () => {
    const v = world();
    const { chain, run } = await reachReview(v);
    const shown = await call(v, PRIYA, `/v1/app/chain-runs/${run.runId}`);
    expect(ChainRunViewSchema.parse(shown)).toEqual(shown);
    expect((shown as { sections: unknown[] }).sections).toHaveLength(4);
    const events = await call(v, PRIYA, `/v1/app/chain-runs/${run.runId}/events?after=0`);
    expect(ChainRunEventPageSchema.parse(events).events.length).toBeGreaterThan(5);
    const tail = await call(v, PRIYA, `/v1/app/chain-runs/${run.runId}/events?after=${String((events as { events: unknown[] }).events.length)}`);
    expect((tail as { events: unknown[] }).events).toEqual([]);
    const task = await call(v, PRIYA, `/v1/app/chain-runs/${run.runId}/sections/3/task`);
    expect(ChainStepTaskViewSchema.parse(task)).toEqual(task);
    const list = await call(v, PRIYA, `/v1/app/chain-runs?chain=${chain.chainId}`);
    expect(ChainRunListSchema.parse(list)).toEqual(list);
    expect((list as { runs: Array<{ sessionId: string }> }).runs.map((entry) => entry.sessionId)).toEqual([run.runId]);
  });

  it("defaults `after` to 0 and refuses a malformed one, a path that is not a run and a method that is not GET", async () => {
    const v = world();
    const { run } = await reachReview(v);
    expect((await call(v, PRIYA, `/v1/app/chain-runs/${run.runId}/events`) as { events: Array<{ seq: number }> }).events[0]!.seq).toBe(1);
    for (const bad of ["after=abc", "after=-1", "after=1.5", "after=1&after=2", "after=99999999"]) {
      expect(await refused(call(v, PRIYA, `/v1/app/chain-runs/${run.runId}/events?${bad}`))).toBe("CONFIG_INVALID");
    }
    expect(await refused(call(v, PRIYA, "/v1/app/chain-runs/nope"))).toBe("NOT_FOUND");
    expect(await refused(call(v, PRIYA, `/v1/app/chain-runs/${run.runId}/sections/x/task`))).toBe("NOT_FOUND");
    expect(await refused(call(v, PRIYA, `/v1/app/chain-runs/${run.runId}`, { method: "DELETE" }))).toBe("NOT_FOUND");
    expect(await refused(call(v, PRIYA, `/v1/app/chain-runs/${run.runId}/events`, { method: "POST", body: { requestId: randomUUID() } }))).toBe("NOT_FOUND");
  });

  it("can't be given the session actor or a reader flag over HTTP: a query parameter, a header or a body field changes nothing", async () => {
    const v = world();
    const { chain, run } = await reachReview(v);
    await share(v, chain.chainId, VIV, "view");
    const tries = [
      "?asChainReader=true", "?actor=session", "?actor[kind]=session&actor[developerId]=" + VIV, "?asChainReader=true&developerId=" + PRIYA,
    ];
    for (const query of tries) {
      expect(await refused(call(v, VIV, `/v1/app/chain-runs/${run.runId}/sections/3/task${query}`, { headers: { "x-agentx-actor": "session", "x-as-chain-reader": "true" } }))).toBe("NOT_FOUND");
      expect(await refused(call(v, ARJUN, `/v1/app/chain-runs/${run.runId}${query}`, { headers: { "x-agentx-actor": "session" } }))).toBe("NOT_FOUND");
    }
    expect(await refused(call(v, VIV, `/v1/app/chain-runs/${run.runId}/sections/3/task`, { method: "GET", body: { asChainReader: true, actor: { kind: "session", developerId: VIV } } }))).toBe("NOT_FOUND");
    expect(v.ports.views).toEqual([]);
  });

  it("lists by chain or by project, newest first, only what the caller reads, filtered by status, and refuses a list that names neither", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const first = await v.w.start(chain.chainId, PRIYA);
    v.w.clock.now += MIN;
    const second = await v.w.start(chain.chainId, PRIYA);
    await end(v.w, "task-1", { outcome: "failed" });
    const ids = async (who: string, query: string) => ((await call(v, who, `/v1/app/chain-runs?${query}`)) as { runs: Array<{ sessionId: string }> }).runs.map((entry) => entry.sessionId);
    expect(await ids(PRIYA, `chain=${chain.chainId}`)).toEqual([second.runId, first.runId]);
    expect(await ids(PRIYA, "project=web")).toEqual([second.runId, first.runId]);
    expect(await ids(PRIYA, `project=web&chain=${chain.chainId}&status=failed`)).toEqual([first.runId]);
    expect(await ids(PRIYA, "project=api")).toEqual([]);
    expect(await ids(CARL, `chain=${chain.chainId}`)).toEqual([]);
    expect(await ids(DANA, "project=web")).toEqual([second.runId, first.runId]);
    expect(await ids(PRIYA, `chain=${chain.chainId}&status=succeeded`)).toEqual([]);
    expect(await refused(call(v, PRIYA, "/v1/app/chain-runs"))).toBe("CONFIG_INVALID");
    expect(await refused(call(v, PRIYA, "/v1/app/chain-runs?chain=nope"))).toBe("CONFIG_INVALID");
    expect(await refused(call(v, PRIYA, "/v1/app/chain-runs?project=Bad Name"))).toBe("CONFIG_INVALID");
    expect(await refused(call(v, PRIYA, `/v1/app/chain-runs?chain=${chain.chainId}&status=frozen`))).toBe("CONFIG_INVALID");
    expect(await refused(call(v, PRIYA, `/v1/app/chain-runs?chain=${chain.chainId}&cursor=%00%00`))).toBe("CONFIG_INVALID");
    const other = (await call(v, STRANGER, `/v1/app/chain-runs?chain=${chain.chainId}`, {}, callerOf(STRANGER, ORG_B))) as { runs: unknown[] };
    expect(other.runs).toEqual([]);
  });

  it("pages a list with an opaque cursor, 50 to a page, with no run twice and none missing", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const original = await v.w.start(chain.chainId, PRIYA);
    const meta = v.w.db.get(chainRunKey(ORG_A, original.runId, "META"))!;
    const made: string[] = [original.runId];
    for (let index = 1; index <= 54; index += 1) {
      const runId = `crn_${String(index).padStart(20, "0")}`;
      const createdAt = new Date(Date.parse("2026-10-22T08:00:00.000Z") + index * 1000).toISOString();
      v.w.db.set({ ...meta, ...chainRunKey(ORG_A, runId, "META"), runId, createdAt });
      v.w.db.set({ ...chainRunsByChainKey(ORG_A, chain.chainId, createdAt, runId), entityType: "CHAIN_RUN_INDEX", orgId: ORG_A, runId, chainId: chain.chainId, project: "web", createdAt });
      made.push(runId);
    }
    const first = (await call(v, PRIYA, `/v1/app/chain-runs?chain=${chain.chainId}`)) as { runs: Array<{ sessionId: string }>; next?: string };
    expect(first.runs).toHaveLength(50);
    expect(first.next).toEqual((expect.any(String) as string));
    const second = (await call(v, PRIYA, `/v1/app/chain-runs?chain=${chain.chainId}&cursor=${encodeURIComponent(first.next!)}`)) as { runs: Array<{ sessionId: string }>; next?: string };
    expect(second).not.toHaveProperty("next");
    const all = [...first.runs, ...second.runs].map((entry) => entry.sessionId);
    expect(new Set(all).size).toBe(55);
    expect([...all].sort()).toEqual([...made].sort());
  });

  it("skips an index row whose run is gone or belongs to another org, and a project index row of another chain's run", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId, PRIYA);
    const at = "2026-10-22T07:00:00.000Z";
    v.w.db.set({ ...chainRunsByChainKey(ORG_A, chain.chainId, at, `crn_${"g".repeat(20)}`), entityType: "CHAIN_RUN_INDEX", orgId: ORG_A, runId: `crn_${"g".repeat(20)}`, chainId: chain.chainId, project: "web", createdAt: at });
    const foreign = `crn_${"f".repeat(20)}`;
    v.w.db.set({ ...chainRunsByProjectKey(ORG_A, "web", at, foreign), entityType: "CHAIN_RUN_INDEX", orgId: ORG_A, runId: foreign, chainId: chain.chainId, project: "web", createdAt: at });
    v.w.db.set({ ...v.w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, ...chainRunKey(ORG_A, foreign, "META"), runId: foreign, orgId: ORG_B });
    const list = await listChainRuns(v.deps, callerOf(PRIYA), { chain: chain.chainId });
    expect(list.runs.map((entry) => entry.sessionId)).toEqual([run.runId]);
    expect((await listChainRuns(v.deps, callerOf(PRIYA), { project: "web" })).runs.map((entry) => entry.sessionId)).toEqual([run.runId]);
  });
});

describe("the internal session actor", () => {
  it("lets Plan 5 read a run it has already checked the level of, in the org it names, and nothing across orgs", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId, PRIYA);
    expect(await refused(chainRunView(v.deps, callerOf(ARJUN), run.runId))).toBe("NOT_FOUND");
    const shown = await chainRunView(v.deps, callerOf(ARJUN), run.runId, { actor: { kind: "session", developerId: ARJUN } });
    expect(shown.sessionId).toBe(run.runId);
    expect((await chainRunEvents(v.deps, callerOf(ARJUN), run.runId, 0, { actor: { kind: "session", developerId: ARJUN } })).events.length).toBeGreaterThan(0);
    expect(await refused(chainRunView(v.deps, callerOf(STRANGER, ORG_B), run.runId, { actor: { kind: "session", developerId: STRANGER } }))).toBe("NOT_FOUND");
  });

  it("keeps the step task's project-role requirement for the actor", async () => {
    const v = world();
    const { run } = await reachReview(v);
    const actor = (developerId: string) => ({ actor: { kind: "session" as const, developerId } });
    expect(await refused(chainStepTask(v.deps, callerOf(ARJUN), run.runId, 3, actor(ARJUN)))).toBe("NOT_FOUND");
    expect(await refused(chainStepTask(v.deps, callerOf(VIV), run.runId, 3, actor(VIV)))).toBe("NOT_FOUND");
    expect(await refused(chainStepTask(v.deps, callerOf(CARL), run.runId, 3, actor(CARL)))).toBeUndefined();
    expect(await refused(chainStepTask(v.deps, callerOf(NOBODY), run.runId, 3, actor(NOBODY)))).toBe("NOT_FOUND");
  });
});

/** What Plan 5's sessions check a chain's facts against (branch feat/sessions-plan5 @ 3a49b24e, `packages/broker/src/agent-sessions/summary.ts`, `ChainFactsSchema`). */
const Plan5ChainFactsSchema = z.object({
  orgId: z.string(),
  status: z.enum(["running", "gate", "paused", "succeeded", "failed", "timed_out", "cancelled"]),
  stepName: z.string().max(2_000).optional(),
  spentUsd: z.number().finite().min(0),
  stepTaskId: z.string().max(200).optional(),
  needsPeople: z.array(z.string().max(2_000)).max(200).optional(),
  endedAt: z.string().datetime().optional(),
}).strict();

describe("the seams Plan 5's sessions read a chain through", () => {
  it("gives the facts of a running run, with the org, the current step's name and its task", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId, PRIYA);
    const facts = await chainSessionSource(v.deps).read(ORG_A, run.runId);
    expect(Plan5ChainFactsSchema.parse(facts)).toEqual({ orgId: ORG_A, status: "running", stepName: "Look into it", spentUsd: 0, stepTaskId: "task-1" });
  });

  it("calls a waiting gate `gate`, names who it waits for, and has no task", async () => {
    const v = world();
    const { run } = await v.w.runAtGate(PRIYA);
    const facts = await chainSessionSource(v.deps).read(ORG_A, run.runId);
    expect(Plan5ChainFactsSchema.parse(facts)).toEqual({ orgId: ORG_A, status: "gate", stepName: "Approve the fix", spentUsd: 0.5, needsPeople: ["Priya", "a maintainer of web"] });
  });

  it("maps a paused run, keeps its task and every end", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId, PRIYA);
    const { onStepTaskPaused } = await import("../../packages/broker/src/chains/runner.js");
    await onStepTaskPaused(v.deps, v.w.pauseEvent("task-1"));
    expect(await chainSessionSource(v.deps).read(ORG_A, run.runId)).toMatchObject({ status: "paused", stepTaskId: "task-1" });
    await end(v.w, "task-1", { outcome: "failed", spentUsd: 0.75 });
    const failed = await chainSessionSource(v.deps).read(ORG_A, run.runId);
    expect(Plan5ChainFactsSchema.parse(failed)).toMatchObject({ status: "failed", spentUsd: 0.75, endedAt: (expect.any(String) as string) });
    expect(failed).not.toHaveProperty("stepTaskId");
  });

  it("maps cancelled and timed_out, and names the task of a stopped run only while its spend is still to be added", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId, PRIYA);
    const { cancelChainRun } = await import("../../packages/broker/src/chains/lifecycle.js");
    await cancelChainRun(v.deps, callerOf(PRIYA), run.runId, { requestId: randomUUID() });
    expect(await chainSessionSource(v.deps).read(ORG_A, run.runId)).toMatchObject({ status: "cancelled", stepTaskId: "task-1" });
    await end(v.w, "task-1", { outcome: "cancelled", spentUsd: 0.5 });
    const settled = await chainSessionSource(v.deps).read(ORG_A, run.runId);
    expect(settled).toMatchObject({ status: "cancelled", spentUsd: 0.5 });
    expect(settled).not.toHaveProperty("stepTaskId");
    const timed = await v.w.publish(twoSteps({ timeoutMinutes: 1440 }));
    const slow = await v.w.start(timed.chainId, PRIYA);
    v.w.clock.now += 169 * 60 * MIN;
    await sweepChainRuns(v.deps, v.w.clock.now);
    expect(await chainSessionSource(v.deps).read(ORG_A, slow.runId)).toMatchObject({ status: "timed_out" });
  });

  it("answers nothing for another org's run, an unknown run and an id that is not a run's, and never reads across orgs", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId, PRIYA);
    expect(await chainSessionSource(v.deps).read(ORG_B, run.runId)).toBeUndefined();
    expect(await chainSessionSource(v.deps).read(ORG_A, `crn_${"z".repeat(20)}`)).toBeUndefined();
    expect(await chainSessionSource(v.deps).read(ORG_A, "nope")).toBeUndefined();
  });

  it("says which session a stream record is about: the run's META and its attempts, in the org the key names, and no other record", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId, PRIYA);
    const source = chainSessionSource(v.deps);
    const meta = v.w.db.get(chainRunKey(ORG_A, run.runId, "META"))!;
    const attempt = v.w.db.get(chainRunKey(ORG_A, run.runId, stepSk(1)))!;
    expect(source.targetOf(meta)).toEqual({ orgId: ORG_A, sessionId: run.runId });
    expect(source.targetOf(attempt)).toEqual({ orgId: ORG_A, sessionId: run.runId });
    expect(source.targetOf({ ...meta, orgId: ORG_B })).toBeUndefined();
    const { orgId: _drop, ...noOrg } = meta;
    void _drop;
    expect(source.targetOf(noOrg)).toBeUndefined();
    expect(source.targetOf(v.w.db.get(chainRunKey(ORG_A, run.runId, runEventSk(1)))!)).toBeUndefined();
    expect(source.targetOf({ pk: `ORG#${ORG_A}#CHAIN#${chain.chainId}`, sk: "META", orgId: ORG_A })).toBeUndefined();
    expect(source.targetOf({ pk: `ORG#${ORG_A}#CHAIN_RUN#nope`, sk: "META", orgId: ORG_A })).toBeUndefined();
    expect(source.targetOf({ pk: "OPEN_CHAIN_RUNS", sk: "x", orgId: ORG_A })).toBeUndefined();
    expect(source.targetOf({ pk: 7, sk: "META" })).toBeUndefined();
  });

  it("answers Plan 5's read check: the readers of a run are in, the others are out, an unreadable run is out", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId, PRIYA);
    const allowed = chainReadAccessFor(v.deps);
    const session = { subject: { kind: "chain" as const, chainRunId: run.runId } };
    expect(await allowed({ orgId: ORG_A, developerId: PRIYA }, session)).toBe(true);
    expect(await allowed({ orgId: ORG_A, developerId: DANA }, session)).toBe(true);
    expect(await allowed({ orgId: ORG_A, developerId: CARL }, session)).toBe(false);
    expect(await allowed({ orgId: ORG_A, developerId: NOBODY }, session)).toBe(false);
    expect(await allowed({ orgId: ORG_B, developerId: STRANGER }, session)).toBe(false);
    expect(await allowed({ orgId: ORG_A, developerId: PRIYA }, { subject: { kind: "task" as const } })).toBe(false);
    expect(await allowed({ orgId: ORG_A, developerId: PRIYA }, { subject: { kind: "chain" as const, chainRunId: `crn_${"z".repeat(20)}` } })).toBe(false);
    await share(v, chain.chainId, CARL, "view");
    expect(await allowed({ orgId: ORG_A, developerId: CARL }, session)).toBe(true);
  });

  it("serves Plan 5's two reads for one org, with the session actor", async () => {
    const v = world();
    const { run } = await reachReview(v);
    const reads = chainSessionReads(v.deps, ORG_A);
    const actor = { kind: "session" as const, developerId: CARL };
    const shown = await reads.runView(actor, run.runId);
    expect(ChainRunViewSchema.parse(shown).sessionId).toBe(run.runId);
    const task = await reads.stepTask(actor, run.runId, 3);
    expect(task).toMatchObject({ taskId: TASK_UUID, run: { state: "RUNNING" } });
    expect(await refused(reads.stepTask({ kind: "session", developerId: VIV }, run.runId, 3))).toBe("NOT_FOUND");
    expect(await refused(chainSessionReads(v.deps, ORG_B).runView(actor, run.runId))).toBe("NOT_FOUND");
  });
});

// ---- what the first mutation pass found unpinned

const seedEvents = (v: ViewWorld, runId: string, total: number) => {
  for (let seq = v.w.events(runId).length + 1; seq <= total; seq += 1) v.w.db.set({ ...chainRunKey(ORG_A, runId, runEventSk(seq)), entityType: "CHAIN_RUN_EVENT", orgId: ORG_A, runId, seq, at: "2026-10-22T09:00:00.000Z", type: "step_started", text: `event ${String(seq)}` });
};
const gone = (v: ViewWorld, chainId: string) => v.w.db.delete(chainKey(ORG_A, chainId, "META"));

describe("who reads, when the chain can't say", () => {
  it("keeps the starter reading after the run's owner changed, and an owner or admin reading when the chain is gone", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId, PRIYA);
    v.w.db.set({ ...v.w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, owner: { developerId: CARL } });
    gone(v, chain.chainId);
    expect(await refused(chainRunView(v.deps, callerOf(PRIYA), run.runId))).toBeUndefined();
    expect(await refused(chainRunView(v.deps, callerOf(CARL), run.runId))).toBeUndefined();
    expect(await refused(chainRunView(v.deps, callerOf(DANA), run.runId))).toBeUndefined();
    expect(await refused(chainRunView(v.deps, { ...callerOf(ARJUN), orgRole: "owner" }, run.runId))).toBeUndefined();
    expect(await refused(chainRunView(v.deps, callerOf(MAX), run.runId))).toBe("NOT_FOUND");
  });

  it("names a project-owned chain's owner by its project", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps(), { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: MAX });
    const run = await v.w.start(chain.chainId, PRIYA);
    expect((await chainRunView(v.deps, callerOf(PRIYA), run.runId)).chainOwner).toEqual({ kind: "project", id: "web", name: "web" });
  });

  it("takes the person from the actor and not from the caller, and treats a developer who is not in the org as nobody", async () => {
    const v = world();
    const { run } = await reachReview(v);
    expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, 3, { actor: { kind: "session", developerId: VIV } }))).toBe("NOT_FOUND");
    expect(await refused(chainStepTask(v.deps, callerOf(VIV), run.runId, 3, { actor: { kind: "session", developerId: PRIYA } }))).toBeUndefined();
    expect(await refused(chainRunView(v.deps, callerOf(PRIYA), run.runId, { actor: { kind: "session", developerId: NOBODY } }))).toBe("NOT_FOUND");
    expect(await refused(chainRunEvents(v.deps, callerOf(PRIYA), run.runId, 0, { actor: { kind: "session", developerId: NOBODY } }))).toBe("NOT_FOUND");
  });
});

describe("a section, when what it rests on is missing or odd", () => {
  it("shows the gate from the attempt when its approval record is gone, and leaves the gate out when the attempt has no approval", async () => {
    const v = world();
    const waiting = await v.w.runAtGate(PRIYA);
    v.w.db.delete(approvalKey(ORG_A, waiting.approvalId));
    expect((await chainRunView(v.deps, callerOf(PRIYA), waiting.run.runId)).sections[1]!.gate).toMatchObject({ status: "PENDING", prompt: "Should Rovara Code fix this?" });
    const approved = await v.w.runAtGate(PRIYA);
    await v.w.decideAs(MAX, approved.approvalId);
    v.w.db.delete(approvalKey(ORG_A, approved.approvalId));
    const shown = (await chainRunView(v.deps, callerOf(PRIYA), approved.run.runId)).sections[1]!.gate;
    expect(shown).toMatchObject({ status: "APPROVED" });
    expect(shown).not.toHaveProperty("decidedBy");
    const declined = await v.w.runAtGate(PRIYA);
    await v.w.decideAs(MAX, declined.approvalId, "decline");
    v.w.db.delete(approvalKey(ORG_A, declined.approvalId));
    expect((await chainRunView(v.deps, callerOf(PRIYA), declined.run.runId)).sections[1]!.gate).toMatchObject({ status: "DECLINED" });
    const stopped = await v.w.runAtGate(PRIYA);
    const { cancelChainRun } = await import("../../packages/broker/src/chains/lifecycle.js");
    await cancelChainRun(v.deps, callerOf(PRIYA), stopped.run.runId, { requestId: randomUUID() });
    v.w.db.delete(approvalKey(ORG_A, stopped.approvalId));
    expect((await chainRunView(v.deps, callerOf(PRIYA), stopped.run.runId)).sections[1]!.gate).toMatchObject({ status: "EXPIRED" });
    const bare = await v.w.runAtGate(PRIYA);
    const attempt = v.w.db.get(chainRunKey(ORG_A, bare.run.runId, stepSk(2)))!;
    const { approvalId: _dropped, ...without } = attempt;
    void _dropped;
    v.w.db.delete(chainRunKey(ORG_A, bare.run.runId, stepSk(2)));
    v.w.db.set(without);
    expect((await chainRunView(v.deps, callerOf(PRIYA), bare.run.runId)).sections[1]).not.toHaveProperty("gate");
  });

  it("does not fail the view when the approval can't be read, and shows no decider without a decision time", async () => {
    const v = world();
    const { run, approvalId } = await v.w.runAtGate(PRIYA);
    v.w.db.injectFault({ command: "GetCommand", match: (input) => JSON.stringify(input).includes("APPROVAL#"), error: { name: "ProvisionedThroughputExceededException" }, times: 1 });
    expect((await chainRunView(v.deps, callerOf(PRIYA), run.runId)).sections[1]!.gate).toMatchObject({ status: "PENDING" });
    await v.w.decideAs(MAX, approvalId);
    const { decidedAt: _removed, ...record } = v.w.db.get(approvalKey(ORG_A, approvalId))!;
    void _removed;
    v.w.db.delete(approvalKey(ORG_A, approvalId));
    v.w.db.set(record);
    const gate = (await chainRunView(v.deps, callerOf(PRIYA), run.runId)).sections[1]!.gate;
    expect(gate).toMatchObject({ status: "APPROVED" });
    expect(gate).not.toHaveProperty("decidedBy");
    expect(gate).not.toHaveProperty("decidedAt");
  });

  it("shows the branch taken, from the step's own choices, and says when it was the default", async () => {
    const v = world();
    const chain = await v.w.publish(INVESTIGATE_THEN_FIX);
    const run = await v.w.start(chain.chainId);
    await end(v.w, "task-1");
    expect((await chainRunView(v.deps, callerOf(PRIYA), run.runId)).sections[0]!.branchTaken).toEqual({ id: "no_fix", description: "Not a code problem, or not enough evidence", fellBack: true });
    const chosen = await v.w.start(chain.chainId);
    await end(v.w, "task-2", { branch: "no_fix" });
    expect((await chainRunView(v.deps, callerOf(PRIYA), chosen.runId)).sections[0]!.branchTaken).toMatchObject({ id: "no_fix", fellBack: false });
  });

  it("shows a step's links, and none when it left none", async () => {
    const v = world();
    const { run } = await reachReview(v, PRIYA, { pullRequests: [{ repository: "web", number: 12, url: "https://github.com/acme/web/pull/12" }] });
    const shown = await chainRunView(v.deps, callerOf(PRIYA), run.runId);
    expect(shown.sections[2]!.links).toEqual([{ label: "Pull request web#12", url: "https://github.com/acme/web/pull/12" }]);
    expect(shown.sections[0]).not.toHaveProperty("links");
    const none = await reachReview(v, PRIYA, { outcome: "failed" });
    expect((await chainRunView(v.deps, callerOf(PRIYA), none.run.runId)).sections[2]).not.toHaveProperty("links");
  });
});

describe("the edges of the event log and the step task read", () => {
  it("ends a page of exactly 200 without `next`, and a page of 201 with it", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    seedEvents(v, run.runId, 200);
    const exact = await chainRunEvents(v.deps, callerOf(PRIYA), run.runId, 0);
    expect(exact.events).toHaveLength(200);
    expect(exact).not.toHaveProperty("next");
    seedEvents(v, run.runId, 201);
    expect((await chainRunEvents(v.deps, callerOf(PRIYA), run.runId, 0)).next).toBe(200);
  });

  it("answers 404 for a seq that is not a step number at all, before it reads anything", async () => {
    const v = world();
    const { run } = await reachReview(v);
    for (const bad of [1.5, -1, 0, 10_000, Number.NaN]) expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, bad)), String(bad)).toBe("NOT_FOUND");
    expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, 9999))).toBe("NOT_FOUND");
  });

  it("answers 404 for a gate's seq and for an attempt that has no task, though the caller reads both", async () => {
    const v = world();
    const { run } = await v.w.runAtGate(PRIYA);
    expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, 2))).toBe("NOT_FOUND");
    const gateAttempt = v.w.db.get(chainRunKey(ORG_A, run.runId, stepSk(2)))!;
    v.w.db.set({ ...gateAttempt, taskId: "task-1" });
    expect(await refused(chainStepTask(v.deps, callerOf(PRIYA), run.runId, 2))).toBe("NOT_FOUND");
  });
});

describe("the list's edges", () => {
  /** Index rows of `count` clones of the run, oldest first from `from`; each is a run of the chain unless `missing` (then no run is behind it). */
  const seedRuns = (v: ViewWorld, chainId: string, original: string, count: number, options: { from?: number; missing?: boolean } = {}) => {
    const meta = v.w.db.get(chainRunKey(ORG_A, original, "META"))!;
    const made: string[] = [];
    for (let index = options.from ?? 1; index < (options.from ?? 1) + count; index += 1) {
      const runId = `crn_${String(index).padStart(20, "0")}`;
      const createdAt = new Date(Date.parse("2026-10-22T08:00:00.000Z") + index * 1000).toISOString();
      if (options.missing !== true) v.w.db.set({ ...meta, ...chainRunKey(ORG_A, runId, "META"), runId, createdAt });
      v.w.db.set({ ...chainRunsByChainKey(ORG_A, chainId, createdAt, runId), entityType: "CHAIN_RUN_INDEX", orgId: ORG_A, runId, chainId, project: "web", createdAt });
      made.push(runId);
    }
    return made;
  };
  const ids = (list: { runs: Array<{ sessionId: string }> }) => list.runs.map((entry) => entry.sessionId);

  it("ends a list of exactly 50 without a cursor", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    seedRuns(v, chain.chainId, run.runId, 49);
    const list = await listChainRuns(v.deps, callerOf(PRIYA), { chain: chain.chainId });
    expect(list.runs).toHaveLength(50);
    expect(list).not.toHaveProperty("next");
  });

  it("gives a cursor when the 50th run is the last of a page of index rows and more rows follow", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    // Newest first: 50 rows with no run behind them, then the original run, then its 54 clones. 105 rows in all: a page of 100 ends with the 50th run.
    const visible = seedRuns(v, chain.chainId, run.runId, 54, { from: 1 });
    seedRuns(v, chain.chainId, run.runId, 50, { from: 100_000, missing: true });
    const first = await listChainRuns(v.deps, callerOf(PRIYA), { chain: chain.chainId });
    expect(first.runs).toHaveLength(50);
    expect(first.next).toEqual(expect.any(String));
    const second = await listChainRuns(v.deps, callerOf(PRIYA), { chain: chain.chainId, cursor: first.next! });
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(55);
    expect([...ids(first), ...ids(second)].sort()).toEqual([run.runId, ...visible].sort());
    expect(second).not.toHaveProperty("next");
  });

  it("stops looking after 200 index rows and gives a cursor to go on from, even when it found nothing yet", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    seedRuns(v, chain.chainId, run.runId, 230, { from: 100_000, missing: true });
    const first = await listChainRuns(v.deps, callerOf(PRIYA), { chain: chain.chainId });
    expect(first.runs).toEqual([]);
    expect(first.next).toEqual(expect.any(String));
    const second = await listChainRuns(v.deps, callerOf(PRIYA), { chain: chain.chainId, cursor: first.next! });
    expect(ids(second)).toEqual([run.runId]);
    expect(second).not.toHaveProperty("next");
  });

  it("refuses a cursor that is too long, has other characters, is not JSON, or does not hold a sort key of this index", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    await v.w.start(chain.chainId);
    const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
    const good = `2026-10-22T08:00:00.000Z#crn_${"0".repeat(20)}`;
    expect(await refused(listChainRuns(v.deps, callerOf(PRIYA), { chain: chain.chainId, cursor: encode(JSON.stringify({ sk: good })) }))).toBeUndefined();
    const long = encode(JSON.stringify({ sk: good, pad: "x".repeat(400) }));
    for (const bad of [long, "a b", "a+b/c=", encode("not json"), encode(JSON.stringify({ sk: "x" })), encode(JSON.stringify({ sk: 1 })), encode(JSON.stringify({}))]) {
      expect(await refused(listChainRuns(v.deps, callerOf(PRIYA), { chain: chain.chainId, cursor: bad })), bad.slice(0, 20)).toBe("CONFIG_INVALID");
    }
  });

  it("leaves out an index row that points at a run of another chain or another project", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const other = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId);
    const stranger = await v.w.start(other.chainId);
    const at = "2026-10-22T07:00:00.000Z";
    v.w.db.set({ ...chainRunsByChainKey(ORG_A, chain.chainId, at, stranger.runId), entityType: "CHAIN_RUN_INDEX", orgId: ORG_A, runId: stranger.runId, chainId: chain.chainId, project: "web", createdAt: at });
    expect(ids(await listChainRuns(v.deps, callerOf(PRIYA), { chain: chain.chainId }))).toEqual([run.runId]);
    const apiRun = `crn_${"p".repeat(20)}`;
    v.w.db.set({ ...v.w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, ...chainRunKey(ORG_A, apiRun, "META"), runId: apiRun, project: "api" });
    v.w.db.set({ ...chainRunsByProjectKey(ORG_A, "web", at, apiRun), entityType: "CHAIN_RUN_INDEX", orgId: ORG_A, runId: apiRun, chainId: chain.chainId, project: "web", createdAt: at });
    expect(ids(await listChainRuns(v.deps, callerOf(DANA), { project: "web" })).sort()).toEqual([run.runId, stranger.runId].sort());
  });
});

describe("the seams, edge by edge", () => {
  it("lists who a gate waits for by name, once each, whatever the rules", async () => {
    const v = world();
    const definition: ChainDefinitionInput = {
      start: "look", limits: { maxRunUsd: 30 },
      steps: [
        agentStep("look", "Look into it", "root-cause-analyst", { kind: "go", to: "ask" }),
        { kind: "gate", id: "ask", name: "Ask", prompt: "Go on?", approvers: [{ kind: "starter" }, { kind: "members", developerIds: [MAX, CARL, PRIYA] }, { kind: "chain_owner" }], onApprove: { to: "$end" }, onReject: { to: "$end" } },
      ],
    };
    const chain = await v.w.publish(definition);
    const run = await v.w.start(chain.chainId, PRIYA);
    await end(v.w, "task-1");
    const facts = await chainSessionSource(v.deps).read(ORG_A, run.runId);
    expect(facts).toMatchObject({ status: "gate", needsPeople: ["Priya", "Max", "Carl", `${chain.name}'s owner`] });
  });

  it("names the project's maintainers for a gate of an event-started run, which has no starter to name", async () => {
    const v = world();
    const definition: ChainDefinitionInput = {
      start: "look", limits: { maxRunUsd: 30 },
      steps: [
        agentStep("look", "Look into it", "root-cause-analyst", { kind: "go", to: "ask" }),
        { kind: "gate", id: "ask", name: "Ask", prompt: "Go on?", approvers: [{ kind: "project_maintainers" }], onApprove: { to: "$end" }, onReject: { to: "$end" } },
      ],
    };
    const chain = await v.w.publish(definition);
    const run = await eventRun(v, chain.chainId, CARL);
    await end(v.w, "task-1");
    expect((await chainSessionSource(v.deps).read(ORG_A, run.runId))?.needsPeople).toEqual(["a maintainer of web"]);
  });

  it("refuses a read to a developer who is no longer in the org, though they started the run", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await v.w.start(chain.chainId, PRIYA);
    const session = { subject: { kind: "chain" as const, chainRunId: run.runId } };
    expect(await chainReadAccessFor(v.deps)({ orgId: ORG_A, developerId: PRIYA }, session)).toBe(true);
    v.w.db.delete(orgMemberKey(ORG_A, PRIYA));
    expect(await chainReadAccessFor(v.deps)({ orgId: ORG_A, developerId: PRIYA }, session)).toBe(false);
  });
});


// ---- Task 18 step 0: a session viewer never gets a confirm link

describe("no confirm link reaches a session viewer", () => {
  const LINK = `https://cell.example.com/v1/app/approve/apr_${"a".repeat(20)}`;
  const call = (v: ViewWorld, who: string, path: string) =>
    routeChainRequest(v.deps, callerOf(who), { method: "GET", path, requestId: "r", headers: {} }, new URL(`https://cell.example.com${path}`));

  it("drops the confirmUrl of a step task's open approvals at the source, for the route, the function and Plan 5's read alike", async () => {
    const v = world();
    v.ports.taskExtra = { confirmUrl: LINK };
    const { chain, run } = await reachReview(v);
    await share(v, chain.chainId, CARL, "view");
    const direct = await chainStepTask(v.deps, callerOf(CARL), run.runId, 3);
    expect(direct.task.run?.pendingApprovals).toEqual([{ approvalId: `apr_${"a".repeat(20)}`, kind: "write", text: "Push the branch?" }]);
    const viaRoute = await call(v, PRIYA, `/v1/app/chain-runs/${run.runId}/sections/3/task`);
    expect(JSON.stringify(viaRoute)).not.toContain("confirmUrl");
    expect(JSON.stringify(viaRoute)).not.toContain("/approve/");
    const viaSession = await chainSessionReads(v.deps, ORG_A).stepTask({ kind: "session", developerId: CARL }, run.runId, 3);
    expect(JSON.stringify(viaSession)).not.toContain("confirmUrl");
    expect(JSON.stringify(viaSession)).not.toContain("/approve/");
  });

  it("gives a gate's confirm link only to a reader who may decide that gate, never to the session actor", async () => {
    const v = world();
    const { chain, run, approvalId } = await v.w.runAtGate(PRIYA);
    await setChainShares({ ...v.deps, store: v.w.chains }, { orgId: ORG_A, chainId: chain.chainId, shares: [CARL, MAX].map((developerId) => ({ principal: { kind: "member" as const, developerId }, level: "view" as const })), by: PRIYA });
    const link = `https://cell.example.com/v1/app/approve/${approvalId}`;
    const gateFor = async (who: string) => (await chainRunView(v.deps, callerOf(who), run.runId)).sections.find((section) => section.kind === "gate")!.gate!;
    expect((await gateFor(PRIYA)).confirmUrl).toBe(link);
    expect((await gateFor(MAX)).confirmUrl).toBe(link);
    const outsider = await gateFor(CARL);
    expect(outsider).toMatchObject({ status: "PENDING", prompt: "Should Rovara Code fix this?" });
    expect(outsider).not.toHaveProperty("confirmUrl");
    expect(JSON.stringify(await call(v, CARL, `/v1/app/chain-runs/${run.runId}`))).not.toContain("/approve/");
    const asSession = await chainSessionReads(v.deps, ORG_A).runView({ kind: "session", developerId: PRIYA }, run.runId);
    expect(ChainRunViewSchema.parse(asSession).sections.find((section) => section.kind === "gate")!.gate).not.toHaveProperty("confirmUrl");
    expect(JSON.stringify(asSession)).not.toContain("/approve/");
    const viaActorFunction = await chainRunView(v.deps, callerOf(MAX), run.runId, { actor: { kind: "session", developerId: MAX } });
    expect(viaActorFunction.sections.find((section) => section.kind === "gate")!.gate).not.toHaveProperty("confirmUrl");
  });

  it("neutralises an event start's title and link like any other vendor text", async () => {
    const v = world();
    const chain = await v.w.publish(twoSteps());
    const run = await eventRun(v, chain.chainId, CARL);
    const meta = v.w.db.get(chainRunKey(ORG_A, run.runId, "META"))!;
    const at = (url: string) => v.w.db.set({ ...meta, startedBy: { ...(meta["startedBy"] as object), title: "Refund\u202e errors\u0007\n  now", url } });
    at("https://sentry.example.com/issues/1");
    expect((await chainRunView(v.deps, callerOf(CARL), run.runId)).startedBy).toMatchObject({ title: "Refund errors now", url: "https://sentry.example.com/issues/1" });
    const long = `https://sentry.example.com/issues/${"a".repeat(150)}`;
    at(long);
    expect((await chainRunView(v.deps, callerOf(CARL), run.runId)).startedBy).toMatchObject({ url: long });
    // S3-L4: the link is not run through the email rule: an at sign in its query or path is part of the link, which stays whole (the title beside it is still hidden).
    for (const keep of ["https://sentry.example.com/issues?user=maya@example.test&x=1", "https://sentry.example.com/u/maya@example.test/issues"]) {
      at(keep);
      expect((await chainRunView(v.deps, callerOf(CARL), run.runId)).startedBy).toMatchObject({ url: keep });
    }
    v.w.db.set({ ...meta, startedBy: { ...(meta["startedBy"] as object), title: "Reply to maya@example.test", url: "https://sentry.example.com/issues/1" } });
    expect((await chainRunView(v.deps, callerOf(CARL), run.runId)).startedBy).toMatchObject({ title: "Reply to [email removed]", url: "https://sentry.example.com/issues/1" });
    at("https://sentry.example.com/issues/1");
    for (const bad of ["https://sentry.example.com/issues/1?x=\u0007y", "not a link", "https://user:hunter2@sentry.example.com/issues/1", `https://sentry.example.com/${"a".repeat(2100)}`]) {
      at(bad);
      expect((await chainRunView(v.deps, callerOf(CARL), run.runId)).startedBy).not.toHaveProperty("url");
    }
  });
});
