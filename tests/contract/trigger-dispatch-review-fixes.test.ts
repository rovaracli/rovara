import { fixtureActor } from "../support/money-authority.js";
// Plan 4 Task 20, review fixes: the run owner is read as whoever a merged developer became and is checked like the creator; one unreadable trigger no longer stops the hook's other
// triggers; a trigger is not turned off for a fault of ours; a subject a trigger just started a run for is not started again for 30 minutes; the run is noted on the trigger even
// when the activity item could not be written.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TriggerEvent } from "@agentx/contracts";
import { addToRoster } from "../../packages/broker/src/agents/roster.js";
import { dispatchTriggerEvent, type TriggerDispatchDependencies } from "../../packages/broker/src/triggers/dispatch.js";
import { ownerQualifies, triggerProblems } from "../../packages/broker/src/triggers/requirements.js";
import { triggerKey } from "../../packages/contracts/src/org-scoped-keys.js";
import type { RecipeOverlay } from "../../packages/contracts/src/agent-recipe-node.js";
import type { ChainDefinitionInput } from "../../packages/contracts/src/chains.js";
import { DANA, MAX, ORG_A, PRIYA, disposeGateWorlds, setupTriggerWorld, type TriggerWorld } from "../support/trigger-world.js";

afterEach(() => disposeGateWorlds());

const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 } };
const PR = { kind: "event" as const, source: "github" as const, type: "pull_request.opened" };
const DUPLICATE = "9".repeat(64);
let counter = 0;

const prEvent = (over: Partial<TriggerEvent> = {}): TriggerEvent => {
  counter += 1;
  return {
    source: "github", type: "pull_request.opened", eventKey: `gh:pr:1:${String(counter)}:opened`, occurredAt: "2026-10-22T08:59:00.000Z", project: "web",
    subject: { kind: "pull_request", id: "42", title: "Fix the login redirect", url: "https://github.com/acme/web/pull/42" },
    fields: { label: ["bug"] }, actor: { kind: "external", id: "alice" }, ...over,
  };
};

function setup() {
  const v = setupTriggerWorld();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  (v.routeDeps as { log?: unknown }).log = (event: string, fields: Record<string, unknown>) => logs.push({ event, fields });
  const deps = v.routeDeps as unknown as TriggerDispatchDependencies;
  return { v, logs, deps, dispatch: (event: TriggerEvent) => dispatchTriggerEvent(deps, ORG_A, event) };
}

/** A custom agent on web that allows pull request events. */
async function customAgent(v: TriggerWorld, owner: { member: string } | { project: string; accountable: string }) {
  const overlay: RecipeOverlay = { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }], triggers: [{ kind: "person" }, PR] };
  const by = "member" in owner ? owner.member : owner.accountable;
  const created = await v.agents.create({
    orgId: ORG_A, name: `Agent ${String(++counter)}`, owner: "member" in owner ? { kind: "member", developerId: owner.member } : { kind: "project", project: owner.project },
    ...("member" in owner ? {} : { accountable: { developerId: owner.accountable } }), overlay, createdBy: by,
  });
  await v.agents.publish({ orgId: ORG_A, agentId: created.agentId, expectedDraftRevision: created.draftRevision, digest: "d".repeat(64), by });
  await addToRoster(v.deps, { orgId: ORG_A, project: "web", agentId: created.agentId, by: DANA });
  await v.agents.setBudget(ORG_A, created.agentId, { monthlyUsd: 20 }, fixtureActor(v.agents, ORG_A, by).developerId, undefined, { ...({}), actor: fixtureActor(v.agents, ORG_A, by) });
  return created;
}

/** A stored item with one attribute missing, as a damaged or foreign record would be. */
const without = (item: Record<string, unknown>, field: string) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== field)) as typeof item & { pk: string; sk: string };

const merge = (v: TriggerWorld, duplicate: string, survivor: string) => v.db.set({ pk: `DEVELOPER#${duplicate}`, sk: "META", developerId: duplicate, mergedInto: survivor });

describe("I-1: the run owner", () => {
  it("runs a member's agent as whoever its merged owner became, and a built-in trigger as whoever its merged creator became", async () => {
    const { v, dispatch } = setup();
    merge(v, DUPLICATE, PRIYA);
    const agent = await customAgent(v, { member: DUPLICATE });
    await v.builtinBudget("code-reviewer");
    await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA });
    await v.seed({ target: { kind: "agent", agentId: "code-reviewer" }, createdBy: DUPLICATE });
    const outcomes = await dispatch(prEvent());
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["started", "started"]);
    const ownerOf = (agentId: string) => v.starts.find((request) => request.agent.agentId === agentId)?.owner.developerId;
    expect(ownerOf(agent.agentId)).toBe(PRIYA);
    expect(ownerOf("code-reviewer")).toBe(PRIYA);
  });

  it("runs a member's chain as the survivor of its merged owner", async () => {
    const { v, dispatch } = setup();
    merge(v, DUPLICATE, PRIYA);
    const chain = await v.budgetedChain(ONE_STEP, { owner: { kind: "member", developerId: DUPLICATE } });
    await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    const [outcome] = await dispatch(prEvent());
    expect(outcome).toMatchObject({ outcome: "started" });
    expect(v.run(outcome!.runId!)!.owner.developerId).toBe(PRIYA);
  });

  it("turns a trigger off, with the owner's reason, when the run owner of its agent can no longer start tasks on the project, though its creator still can", async () => {
    const { v, deps, dispatch } = setup();
    const agent = await customAgent(v, { member: PRIYA });
    const trigger = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA });
    expect(await triggerProblems(deps, trigger)).toEqual([]);
    v.projectMembers.revoke(ORG_A, "web", PRIYA);
    const problems = await triggerProblems(deps, trigger);
    expect(problems.map((problem) => problem.message)).toEqual([expect.stringContaining("run owner can no longer start tasks on web")]);
    expect(await dispatch(prEvent())).toEqual([{ triggerId: trigger.triggerId, outcome: "failed", reason: "trigger_invalid" }]);
    expect(v.starts).toEqual([]);
    expect(await v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ enabled: false });
  });

  it("turns off a trigger of a project's agent whose accountable maintainer lost the role, and of a chain whose member owner left the project", async () => {
    const { v, deps, dispatch } = setup();
    const agent = await customAgent(v, { project: "web", accountable: MAX });
    const chain = await v.budgetedChain(ONE_STEP);
    const agentTrigger = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA });
    const chainTrigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    expect(await triggerProblems(deps, agentTrigger)).toEqual([]);
    expect(await triggerProblems(deps, chainTrigger)).toEqual([]);
    v.projectMembers.revoke(ORG_A, "web", MAX);
    v.projectMembers.revoke(ORG_A, "web", PRIYA);
    expect((await triggerProblems(deps, agentTrigger)).map((problem) => problem.path)).toEqual(["owner"]);
    expect((await triggerProblems(deps, chainTrigger)).map((problem) => problem.path)).toEqual(["owner"]);
    expect((await dispatch(prEvent())).map((entry) => entry.reason)).toEqual(["trigger_invalid", "trigger_invalid"]);
    expect(v.starts).toEqual([]);
  });

  it("reports a project's agent with no accountable maintainer as a problem, not as a failure at every event", async () => {
    const { v, deps } = setup();
    const agent = await customAgent(v, { project: "web", accountable: MAX });
    const [record] = v.db.find((item) => item["agentId"] === agent.agentId && item["accountable"] !== undefined);
    v.db.set(without(record!, "accountable"));
    const trigger = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA });
    expect((await triggerProblems(deps, trigger)).map((problem) => problem.path)).toEqual(["owner"]);
  });
});

describe("I-1: what the run owner is held to, found by the mutation pass", () => {
  it("reports a chain step agent the chain's member owner may no longer use, though the trigger's creator may", async () => {
    const { v, deps } = setup();
    const private_ = await v.customAgent("Max's own", MAX);
    const chain = await v.publish({ start: "look", limits: { maxRunUsd: 5 }, steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: private_.agentId, version: "current" }, next: { kind: "end" } }] }, { owner: { kind: "member", developerId: MAX }, by: MAX, budgetUsd: 50 });
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    expect(await triggerProblems(deps, trigger)).toEqual([]);
    // The agent now belongs to Priya alone: Max, whom the chain runs as, can't use it; Dana, an admin, can.
    for (const item of v.db.find((entry) => entry["agentId"] === private_.agentId && typeof entry["owner"] === "object")) v.db.set({ ...item, owner: { kind: "member", developerId: PRIYA } });
    const problems = await triggerProblems(deps, trigger);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("its owner can no longer use it");
  });

  it("reads a merged developer as who they became when asking who could own a trigger", async () => {
    const { v, deps } = setup();
    merge(v, DUPLICATE, PRIYA);
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    expect(await ownerQualifies(deps, trigger, DUPLICATE)).toBe(true);
  });
});

describe("I-2: one unreadable trigger does not block the hook", () => {
  it("dispatches the other triggers when one record has no creation time or no spec, and logs the broken ones by id", async () => {
    const { v, logs, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const good = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    const noTime = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    const noSpec = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    v.db.set(without(v.db.get(triggerKey(ORG_A, noTime.triggerId))!, "createdAt"));
    v.db.set(without(v.db.get(triggerKey(ORG_A, noSpec.triggerId))!, "spec"));
    const outcomes = await dispatch(prEvent());
    expect(outcomes.map((entry) => [entry.triggerId, entry.outcome])).toEqual([[good.triggerId, "started"]]);
    const broken = logs.filter((entry) => entry.event === "trigger_dispatch.record_unreadable").map((entry) => entry.fields["triggerId"]);
    expect(broken.sort()).toEqual([noSpec.triggerId, noTime.triggerId].sort());
    expect(logs.find((entry) => entry.event === "trigger_dispatch.records_skipped")?.fields).toMatchObject({ orgId: ORG_A, count: 2 });
  });
});

describe("a fault of ours does not turn a trigger off for good", () => {
  it("skips the event and logs it when a problem is RUNTIME_UNAVAILABLE, leaving the trigger on with no notice", async () => {
    const { v, logs, dispatch } = setup();
    v.hook("linear", `hk_${"a".repeat(26)}`);
    v.connection("linear");
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "linear", type: "issue.created" }, hookId: `hk_${"a".repeat(26)}` });
    (v.routeDeps as { hooks?: unknown }).hooks = undefined;
    const event = prEvent({ source: "linear", type: "issue.created", hookId: `hk_${"a".repeat(26)}`, subject: { kind: "issue", id: "ENG-1", title: "Checkout fails" }, fields: {} });
    expect(await dispatch(event)).toEqual([{ triggerId: trigger.triggerId, outcome: "skipped", reason: "runtime_unavailable" }]);
    expect(await v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ enabled: true });
    expect(await v.notices(PRIYA)).toEqual([]);
    expect(logs.some((entry) => entry.event === "trigger_dispatch.runtime_unavailable" && entry.fields["triggerId"] === trigger.triggerId)).toBe(true);
  });
});

describe("the subject loop guard", () => {
  it("skips an event for a pull request this trigger started a run for in the last 30 minutes, for that trigger only, and starts again after", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const first = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    const [started] = await dispatch(prEvent());
    expect(started).toMatchObject({ outcome: "started" });
    // The same pull request, a new event (another key): the run this trigger started may have caused it.
    expect(await dispatch(prEvent())).toEqual([{ triggerId: first.triggerId, outcome: "skipped", reason: "recent_subject" }]);
    // Another pull request is another subject.
    expect((await dispatch(prEvent({ subject: { kind: "pull_request", id: "43", title: "Other", url: "https://github.com/acme/web/pull/43" } })))[0]).toMatchObject({ outcome: "started" });
    // Another trigger has not started a run for this subject.
    const second = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    const both = await dispatch(prEvent());
    expect(new Map(both.map((entry) => [entry.triggerId, entry.outcome]))).toEqual(new Map([[first.triggerId, "skipped"], [second.triggerId, "started"]]));
    // The same number in another repository is another subject.
    expect((await dispatch(prEvent({ subject: { kind: "pull_request", id: "42", title: "Same number", url: "https://github.com/acme/api/pull/42" } })))[0]).toMatchObject({ triggerId: first.triggerId, outcome: "started" });
  });

  it("starts again for the same subject once 30 minutes have passed", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    const subject = { kind: "pull_request" as const, id: "42", title: "Fix", url: "https://github.com/acme/web/pull/42" };
    expect((await dispatch(prEvent({ subject })))[0]).toMatchObject({ outcome: "started" });
    v.clock.now += 29 * 60_000;
    expect((await dispatch(prEvent({ subject })))[0]).toMatchObject({ outcome: "skipped", reason: "recent_subject" });
    v.clock.now += 2 * 60_000;
    expect((await dispatch(prEvent({ subject })))[0]).toMatchObject({ triggerId: trigger.triggerId, outcome: "started" });
  });

  it("does not count a skipped or refused event as a start, and uses no allowance for it", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, maxRunsPerHour: 1 });
    expect((await dispatch(prEvent()))[0]).toMatchObject({ outcome: "started" });
    for (let index = 0; index < 3; index += 1) expect((await dispatch(prEvent()))[0]).toMatchObject({ outcome: "skipped", reason: "recent_subject" });
    const hourKey = new Date(v.clock.now).toISOString().slice(0, 13);
    expect(v.db.get(`ORG#${ORG_A}#TRIGGER_RATE#${trigger.triggerId}`, hourKey)).toMatchObject({ count: 1 });
  });
});

describe("the run is noted on the trigger when its activity could not be written", () => {
  it("sets lastRunId after a start whose activity item failed, and still lets the event be sent again", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    const failing = vi.spyOn(v.triggers, "recordActivity").mockRejectedValueOnce(new Error("throttled"));
    const event = prEvent();
    await expect(dispatch(event)).rejects.toThrow("throttled");
    failing.mockRestore();
    const noted = await v.triggers.get(ORG_A, trigger.triggerId);
    expect(noted?.lastRunId).toMatch(/^crn_/);
    expect(noted?.lastFiredAt).toBeDefined();
    expect((await dispatch(event))[0]).toMatchObject({ outcome: "duplicate", runId: noted!.lastRunId });
  });
});
