import { fixtureActor } from "../support/money-authority.js";
// Plan 4 Task 20: an event starts paid work with no person watching, so dispatch re-checks everything at the moment of the event, reads it live and fails closed. These tests drive
// `dispatchTriggerEvent` over the trigger world (real stores, a recording stand-in for Plan 3's `startAgentRun`): matching by org, source, project and hook; the loop guard; the
// requirements; the per-trigger and per-org limits; one run per event; and what the log may hold.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentXError, spendCounterKey, triggerKey, type TriggerEvent } from "@agentx/contracts";
import type * as RosterModule from "../../packages/broker/src/agents/roster.js";
import { addToRoster, resolveAgentForAutonomousRun } from "../../packages/broker/src/agents/roster.js";
import { monthOf } from "../../packages/broker/src/org/trial.js";
import { dispatchTriggerEvent, rovaraActorIds, runOwnerFor, type TriggerDispatchDependencies } from "../../packages/broker/src/triggers/dispatch.js";
import { connectionKey, connectionsKey } from "../../packages/contracts/src/connections.js";
import { orgAutonomousKey, triggerRateKey } from "../../packages/contracts/src/org-scoped-keys.js";
import type { RecipeOverlay } from "../../packages/contracts/src/agent-recipe-node.js";
import type { ChainDefinitionInput } from "../../packages/contracts/src/chains.js";
import { DANA, HOOK_A, HOOK_A2, MAX, ORG_A, ORG_B, PRIYA, disposeGateWorlds, setupTriggerWorld, type TriggerWorld } from "../support/trigger-world.js";
import type { WorldOptions } from "../support/chain-run-world.js";

// A spy that still calls the real roster check, so the test can see what dispatch asked it.
vi.mock("../../packages/broker/src/agents/roster.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RosterModule>();
  return { ...actual, resolveAgentForAutonomousRun: vi.fn(actual.resolveAgentForAutonomousRun) };
});

afterEach(() => {
  disposeGateWorlds();
  vi.mocked(resolveAgentForAutonomousRun).mockClear();
});

const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 } };
const BUILTIN = { kind: "agent" as const, agentId: "code-reviewer" };
const PR = { kind: "event" as const, source: "github" as const, type: "pull_request.opened" };
let counter = 0;

/** A GitHub pull request event, as Task 21 hands it on. */
const prEvent = (over: Partial<TriggerEvent> = {}): TriggerEvent => {
  counter += 1;
  return {
    source: "github", type: "pull_request.opened", eventKey: `gh:pr:1:${String(counter)}:opened`, occurredAt: "2026-10-22T08:59:00.000Z", project: "web",
    // Each event is for a pull request of its own: one trigger does not start twice for the same subject within 30 minutes (the subject guard has its own tests).
    subject: { kind: "pull_request", id: String(counter), title: "Fix the login redirect", url: `https://github.com/acme/web/pull/${String(counter)}` },
    fields: { label: ["bug"], baseBranch: ["main"], authorAssociation: ["MEMBER"] }, actor: { kind: "external", id: "alice" }, ...over,
  };
};
const linearEvent = (hookId: string, over: Partial<TriggerEvent> = {}): TriggerEvent => prEvent({
  source: "linear", type: "issue.created", hookId, subject: { kind: "issue", id: "ENG-1", title: "Checkout fails" }, fields: { label: ["bug"] }, ...over,
});

function setup(options: WorldOptions = {}) {
  const v = setupTriggerWorld(options);
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  (v.routeDeps as { log?: unknown }).log = (event: string, fields: Record<string, unknown>) => logs.push({ event, fields });
  const deps = v.routeDeps as unknown as TriggerDispatchDependencies;
  const dispatch = (event: TriggerEvent, orgId = ORG_A) => dispatchTriggerEvent(deps, orgId, event);
  return { v, logs, deps, dispatch };
}
const activity = async (v: TriggerWorld, triggerId: string) => v.triggers.listActivity(ORG_A, triggerId, 500);
const hour = (v: TriggerWorld) => new Date(v.clock.now).toISOString().slice(0, 13);
const day = (v: TriggerWorld) => new Date(v.clock.now).toISOString().slice(0, 10);

/** A custom agent on web that allows `specs`, owned by `owner` (a project's, with an accountable maintainer, when `project`). */
async function customAgent(v: TriggerWorld, specs: NonNullable<RecipeOverlay["triggers"]>, owner: { member: string } | { project: string; accountable: string }) {
  const overlay: RecipeOverlay = { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }], triggers: specs };
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

describe("matching an event to triggers", () => {
  it("starts the trigger whose filter the event meets and skips the one it does not, with label values compared without case", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const bug = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { ...PR, filter: { label: ["BUG"] } } });
    const docs = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { ...PR, filter: { label: ["docs"] } } });
    const missingKey = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { ...PR, filter: { authorAssociation: ["OWNER"] } } });
    const wrongType = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { ...PR, type: "pull_request.ready_for_review" } });
    const outcomes = await dispatch(prEvent({ fields: { label: ["bug", "p1"], baseBranch: ["main"] }, subject: { kind: "pull_request", id: "42", title: "Fix the login redirect", url: "https://github.com/acme/web/pull/42" } }));
    expect(outcomes.map((entry) => [entry.triggerId, entry.outcome])).toEqual([[bug.triggerId, "started"]]);
    expect(outcomes[0]!.runId).toMatch(/^crn_[0-9a-z]{20}$/);
    for (const other of [docs, missingKey, wrongType]) expect(await activity(v, other.triggerId)).toEqual([]);
    const run = v.run(outcomes[0]!.runId!)!;
    expect(run).toMatchObject({ origin: "event", project: "web", startedBy: { kind: "event", triggerId: bug.triggerId, source: "github", type: "pull_request.opened", title: "Fix the login redirect", url: "https://github.com/acme/web/pull/42" } });
    expect(run.input).toBe("GitHub pull request opened: Fix the login redirect (https://github.com/acme/web/pull/42)");
  });

  it("never starts a disabled trigger, and records nothing for it", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const off = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, enabled: false });
    expect(await dispatch(prEvent())).toEqual([]);
    expect(await activity(v, off.triggerId)).toEqual([]);
    expect(v.starts).toEqual([]);
  });

  it("starts only the receiving hook's triggers: two Linear hooks of one project each start their own, and a trigger that names another hook under this one's index is not matched", async () => {
    const { v, dispatch } = setup();
    v.hook("linear", HOOK_A);
    v.hook("linear", HOOK_A2);
    v.connection("linear");
    const chain = await v.budgetedChain(ONE_STEP);
    const spec = { kind: "event" as const, source: "linear" as const, type: "issue.created" };
    const one = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec, hookId: HOOK_A });
    const two = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec, hookId: HOOK_A2 });
    expect((await dispatch(linearEvent(HOOK_A))).map((entry) => [entry.triggerId, entry.outcome])).toEqual([[one.triggerId, "started"]]);
    expect((await dispatch(linearEvent(HOOK_A2))).map((entry) => [entry.triggerId, entry.outcome])).toEqual([[two.triggerId, "started"]]);
    // A record that says H2 but sits in H1's index: the record is the truth.
    const stored = v.db.get(triggerKey(ORG_A, one.triggerId))!;
    v.db.set({ ...stored, hookId: HOOK_A2 });
    expect(await dispatch(linearEvent(HOOK_A))).toEqual([]);
  });

  it("matches a GitHub event only to triggers with no hook, and a hook event only to triggers of that hook", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const github = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    expect((await dispatch(prEvent({ hookId: HOOK_A }))).map((entry) => entry.triggerId)).toEqual([]);
    expect((await dispatch(prEvent())).map((entry) => entry.triggerId)).toEqual([github.triggerId]);
    // A hook event that carries no hook is refused, so it can't read the GitHub index under a source that has no hook-less triggers.
    expect(await dispatch(linearEvent(HOOK_A, { hookId: undefined }))).toEqual([]);
  });

  it("reads only the receiving org's keys: another org's trigger on a same-named project is never read or started", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const mine = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    await v.triggers.create({ record: { orgId: ORG_B, triggerId: "ctr_bbbbbbbbbbbbbbbbbbbb", target: { kind: "agent", agentId: "code-reviewer" }, project: "web", spec: PR, enabled: true, maxRunsPerHour: 30, createdBy: PRIYA } });
    const queried: string[] = [];
    const send = v.db.send.bind(v.db);
    v.db.send = (async (command: { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, unknown> } }) => {
      if (command.constructor.name === "QueryCommand") queried.push(String(command.input.ExpressionAttributeValues?.[":pk"]));
      return send(command);
    });
    expect((await dispatch(prEvent())).map((entry) => entry.triggerId)).toEqual([mine.triggerId]);
    expect(queried.length).toBeGreaterThan(0);
    for (const pk of queried) expect(pk.startsWith(`ORG#${ORG_A}#`), pk).toBe(true);
  });
});

describe("what dispatch refuses to read or trust", () => {
  it("answers nothing for an event that is not valid, and throws where no trigger store is set up so the vendor tries again", async () => {
    const { v, deps, dispatch } = setup();
    await v.seed({ target: BUILTIN, createdBy: DANA });
    expect(await dispatch({ ...prEvent(), type: "no.such.type" })).toEqual([]);
    await expect(dispatchTriggerEvent({ ...deps, triggers: undefined } as unknown as TriggerDispatchDependencies, ORG_A, prEvent())).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("reads a hook event only from the hook's index and a GitHub event only from GitHub's, even when a stored trigger says otherwise", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    // A Linear trigger stored with no hook sits in GitHub's index; a GitHub trigger stored with a hook sits in that hook's.
    await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "linear", type: "issue.created" } });
    await v.seed({ target: { kind: "chain", chainId: chain.chainId }, hookId: HOOK_A });
    expect(await dispatch(linearEvent(HOOK_A, { hookId: undefined }))).toEqual([]);
    expect(await dispatch(prEvent({ hookId: HOOK_A }))).toEqual([]);
  });

  it("believes the record over the index it was found under: a record of another project or source is not matched", async () => {
    const { v, dispatch } = setup();
    v.hook("linear", HOOK_A);
    v.connection("linear");
    const chain = await v.budgetedChain(ONE_STEP);
    const spec = { kind: "event" as const, source: "linear" as const, type: "issue.created" };
    const moved = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec, hookId: HOOK_A });
    v.db.set({ ...v.db.get(triggerKey(ORG_A, moved.triggerId))!, project: "api" });
    expect(await dispatch(linearEvent(HOOK_A))).toEqual([]);
    v.db.set({ ...v.db.get(triggerKey(ORG_A, moved.triggerId))!, project: "web", spec: { ...spec, source: "jira" } });
    expect(await dispatch(linearEvent(HOOK_A))).toEqual([]);
  });

  it("compares the event's values with the filter's without regard to case, whichever side is upper", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { ...PR, filter: { label: ["bug"] } } });
    expect((await dispatch(prEvent({ fields: { label: ["BuG"] } }))).map((entry) => entry.triggerId)).toEqual([trigger.triggerId]);
  });

  it("holds a stored allowance that is not a whole number to nothing", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer");
    const trigger = await v.seed({ target: BUILTIN, createdBy: DANA });
    v.db.set({ ...v.db.get(triggerKey(ORG_A, trigger.triggerId))!, maxRunsPerHour: 1.5 });
    expect((await dispatch(prEvent()))[0]).toMatchObject({ outcome: "skipped", reason: "rate_limited" });
    expect(v.starts).toEqual([]);
  });
});

describe("the agent target", () => {
  it("starts the built-in agent once as an event, paid by the agent, with the pull request as its context, at the version the roster check resolved", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer");
    const trigger = await v.seed({ target: BUILTIN, createdBy: DANA });
    const [outcome] = await dispatch(prEvent());
    expect(outcome).toEqual({ triggerId: trigger.triggerId, outcome: "started", taskId: "task-1" });
    expect(v.starts).toHaveLength(1);
    const request = v.starts[0]!;
    expect(request).toMatchObject({
      orgId: ORG_A, project: "web", origin: "event", owner: { developerId: DANA }, payer: { kind: "agent", agentId: "code-reviewer" },
      input: { text: "Do your job for this event.", context: [{ kind: "pull_request", title: "Fix the login redirect" }] },
    });
    expect(request.startedBy).toBeUndefined();
    const calls = vi.mocked(resolveAgentForAutonomousRun).mock.calls;
    expect(calls.at(-1)![1]).toEqual({ orgId: ORG_A, project: "web", agentId: "code-reviewer" });
    expect(calls.at(-1)![0]).toMatchObject({ store: v.routeDeps.store });
    const resolved = await vi.mocked(resolveAgentForAutonomousRun).mock.results.at(-1)!.value as { ref: { version: number } };
    expect(request.agent).toEqual({ agentId: "code-reviewer", version: resolved.ref.version });
    expect(await v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ lastFiredAt: "2026-10-22T09:00:00.000Z", lastTaskId: "task-1" });
    expect(await activity(v, trigger.triggerId)).toMatchObject([{ outcome: "started", taskId: "task-1" }]);
  });

  // Plan 5 (N6), a binding hand-off to Plan 4's dispatch: a run no person started names the trigger that started it, so its session says so.
  it("passes the trigger to Plan 3's run start, so the run's session names the event trigger as its starter", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer");
    const trigger = await v.seed({ target: BUILTIN, createdBy: DANA });
    await dispatch(prEvent());
    expect(v.starts[0]!.trigger).toEqual({ kind: "event", triggerId: trigger.triggerId });
    expect(v.starts[0]!.startedBy).toBeUndefined();
  });

  it("owns the run of a built-in by the maintainer who turned the trigger on, of a project's agent by its accountable maintainer, and of a member's agent by the member", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer");
    const builtin = await v.seed({ target: BUILTIN, createdBy: MAX });
    const project = await customAgent(v, [{ kind: "person" }, PR], { project: "web", accountable: MAX });
    const member = await customAgent(v, [{ kind: "person" }, PR], { member: PRIYA });
    await v.seed({ target: { kind: "agent", agentId: project.agentId }, createdBy: DANA });
    await v.seed({ target: { kind: "agent", agentId: member.agentId }, createdBy: PRIYA });
    await dispatch(prEvent());
    const ownerOf = (agentId: string) => v.starts.find((request) => request.agent.agentId === agentId)?.owner.developerId;
    expect(ownerOf("code-reviewer")).toBe(MAX);
    expect(ownerOf(project.agentId)).toBe(MAX);
    expect(ownerOf(member.agentId)).toBe(PRIYA);
    expect(builtin.createdBy).toBe(MAX);
  });

  it("refuses to pick an owner for a project's agent that has no accountable maintainer", async () => {
    const { deps } = setup();
    await expect(runOwnerFor(deps, { orgId: ORG_A, owner: { kind: "project", project: "web" } } as never)).rejects.toThrow(/no accountable maintainer/);
    expect(await runOwnerFor(deps, { orgId: ORG_A, owner: { kind: "member", developerId: PRIYA } } as never)).toEqual({ developerId: PRIYA });
    expect(await runOwnerFor(deps, { orgId: ORG_A, owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } } as never)).toEqual({ developerId: MAX });
  });

  it("cuts a 300-character title to 200 for the context and sorts the subject into the kind a context item has", async () => {
    const { v, dispatch } = setup();
    for (const source of ["sentry", "pagerduty", "vercel"] as const) v.hook(source, `hk_${source[0]!.repeat(26)}`);
    const agent = await customAgent(v, [{ kind: "person" }, { kind: "event", source: "sentry", type: "issue.created" }, { kind: "event", source: "pagerduty", type: "incident.triggered" }, { kind: "event", source: "vercel", type: "deployment.error" }], { member: PRIYA });
    const specs = [
      { source: "sentry", type: "issue.created", kind: "issue", expected: "ticket" },
      { source: "pagerduty", type: "incident.triggered", kind: "incident", expected: "alert" },
      { source: "vercel", type: "deployment.error", kind: "deployment", expected: "deploy" },
    ] as const;
    for (const spec of specs) {
      await v.seed({ target: { kind: "agent", agentId: agent.agentId }, spec: { kind: "event", source: spec.source, type: spec.type }, hookId: `hk_${spec.source[0]!.repeat(26)}`, createdBy: PRIYA });
      const [outcome] = await dispatch(prEvent({ source: spec.source, type: spec.type, hookId: `hk_${spec.source[0]!.repeat(26)}`, subject: { kind: spec.kind, id: "1", title: "T".repeat(300) }, fields: {} }));
      expect(outcome?.outcome, spec.source).toBe("started");
      const item = v.starts.at(-1)!.input.context![0]!;
      expect(item.kind).toBe(spec.expected);
      expect(item.title!.length).toBe(200);
    }
  });

  it("starts the version the roster check resolved for a custom agent that has a second version", async () => {
    const { v, dispatch } = setup();
    const agent = await customAgent(v, [{ kind: "person" }, PR], { member: PRIYA });
    await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: PRIYA });
    const draft = (await v.agents.getDraft(ORG_A, agent.agentId))!;
    await v.agents.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: { instructions: "y", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }], triggers: [{ kind: "person" }, PR] }, expectedRevision: draft.revision, by: PRIYA });
    const after = (await v.agents.getDraft(ORG_A, agent.agentId))!;
    await v.agents.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: after.revision, digest: "f".repeat(64), by: PRIYA });
    expect((await dispatch(prEvent()))[0]).toMatchObject({ outcome: "started" });
    expect(v.starts[0]!.agent).toEqual({ agentId: agent.agentId, version: 2 });
  });

  it("refuses to start a draft: an autonomous run uses a published version", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer");
    const trigger = await v.seed({ target: BUILTIN, createdBy: DANA });
    const real = (await vi.importActual<typeof RosterModule>("../../packages/broker/src/agents/roster.js")).resolveAgentForAutonomousRun;
    // The requirements read the roster once; dispatch's own read gets a draft.
    vi.mocked(resolveAgentForAutonomousRun).mockImplementationOnce(real).mockImplementationOnce(async (...args) => {
      const found = await real(...args);
      return { ...found, ref: { ...found.ref, version: "draft" } };
    });
    expect(await dispatch(prEvent())).toEqual([{ triggerId: trigger.triggerId, outcome: "failed", reason: "AGENT_UNAVAILABLE" }]);
    expect(v.starts).toEqual([]);
  });

  it("starts the same event once: a repeat of it is a duplicate and writes no second start or rate count", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer");
    const trigger = await v.seed({ target: BUILTIN, createdBy: DANA });
    const event = prEvent();
    expect((await dispatch(event))[0]).toMatchObject({ outcome: "started" });
    const second = await dispatch(event);
    expect(second).toEqual([{ triggerId: trigger.triggerId, outcome: "duplicate", taskId: "task-1" }]);
    expect(v.starts).toHaveLength(1);
    expect(v.db.get(triggerRateKey(ORG_A, trigger.triggerId, hour(v)))).toMatchObject({ count: 1 });
  });
});

describe("the chain target", () => {
  it("owns an event-started run of a member's chain by the member and of a project's chain by the trigger's creator", async () => {
    const { v, dispatch } = setup();
    const member = await v.budgetedChain(ONE_STEP);
    const project = await v.budgetedChain(ONE_STEP, { owner: { kind: "project", project: "web" } as never, accountable: { developerId: MAX } });
    await v.seed({ target: { kind: "chain", chainId: member.chainId }, createdBy: DANA });
    await v.seed({ target: { kind: "chain", chainId: project.chainId }, createdBy: MAX });
    const outcomes = await dispatch(prEvent());
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["started", "started"]);
    const runs = outcomes.map((entry) => v.run(entry.runId!)!);
    expect(new Map(runs.map((run) => [run.chainId, run.owner.developerId]))).toEqual(new Map([[member.chainId, PRIYA], [project.chainId, MAX]]));
  });

  it("notes the run on the trigger, for the no-overlap check", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    const [outcome] = await dispatch(prEvent());
    expect(await v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ lastRunId: outcome!.runId, lastFiredAt: "2026-10-22T09:00:00.000Z" });
  });

  it("starts one run for an event however often it is dispatched, with a run id derived from the trigger and the event", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    const event = prEvent();
    const first = await dispatch(event);
    const again = await Promise.all([dispatch(event), dispatch(event)]);
    expect(first[0]).toMatchObject({ outcome: "started" });
    for (const outcomes of again) expect(outcomes[0]).toMatchObject({ triggerId: trigger.triggerId, runId: first[0]!.runId });
    expect(v.db.find((item) => String(item["pk"]).includes("#CHAIN_RUN#") && item["sk"] === "META")).toHaveLength(1);
    const identity = createHash("sha256").update(`${trigger.triggerId}\0${event.eventKey}`).digest("hex");
    expect(first[0]!.runId).toBe(`crn_${BigInt(`0x${identity}`).toString(36).slice(-20).padStart(20, "0")}`);
    expect(v.starts.length).toBeLessThanOrEqual(1);
  });

  it("records a trigger whose chain budget is used up as failed with CHAIN_BUDGET_EXCEEDED and starts nothing", async () => {
    const { v, dispatch } = setup({ admission: true });
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    v.db.set({ ...spendCounterKey(ORG_A, monthOf(v.clock.now), `CHAIN#${chain.chainId}`), entityType: "SPEND_COUNTER", spentUsd: 50, committedUsd: 50 });
    expect(await dispatch(prEvent())).toEqual([{ triggerId: trigger.triggerId, outcome: "failed", reason: "CHAIN_BUDGET_EXCEEDED" }]);
    expect(v.starts).toEqual([]);
    expect(await activity(v, trigger.triggerId)).toMatchObject([{ outcome: "failed", reason: "CHAIN_BUDGET_EXCEEDED" }]);
  });

  it("says busy when the chain already has its most runs going", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    for (let index = 0; index < 5; index += 1) expect((await dispatch(prEvent()))[0]).toMatchObject({ outcome: "started" });
    expect(await dispatch(prEvent())).toEqual([{ triggerId: trigger.triggerId, outcome: "failed", reason: "busy" }]);
  });
});

describe("the requirements are read again at the event", () => {
  it("turns off a chain trigger whose version lost its run limit with no recheck, tells its owners, starts nothing and counts no rate", async () => {
    const { v, dispatch } = setup();
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    await v.publishAgain(chain.chainId, { ...ONE_STEP, limits: {} });
    expect((await v.triggers.get(ORG_A, trigger.triggerId))!.enabled).toBe(true);
    expect(await dispatch(prEvent())).toEqual([{ triggerId: trigger.triggerId, outcome: "failed", reason: "trigger_invalid" }]);
    expect(await v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ enabled: false });
    expect((await v.notices(DANA)).join("\n")).toContain("was turned off");
    expect(v.db.get(triggerRateKey(ORG_A, trigger.triggerId, hour(v)))).toBeUndefined();
    expect(v.db.get(orgAutonomousKey(ORG_A, day(v)))).toBeUndefined();
    expect(v.starts).toEqual([]);
    // Off now: the next event does not even look at it.
    expect(await dispatch(prEvent())).toEqual([]);
  });

  it("turns off an agent trigger whose recipe no longer allows events, and one whose budget was removed", async () => {
    const { v, dispatch } = setup();
    const agent = await customAgent(v, [{ kind: "person" }, PR], { member: PRIYA });
    const noBudget = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: PRIYA });
    await v.agents.setBudget(ORG_A, agent.agentId, { monthlyUsd: null }, fixtureActor(v.agents, ORG_A, PRIYA).developerId, undefined, { ...({}), actor: fixtureActor(v.agents, ORG_A, PRIYA) });
    expect(await dispatch(prEvent())).toEqual([{ triggerId: noBudget.triggerId, outcome: "failed", reason: "trigger_invalid" }]);
    expect((await v.triggers.get(ORG_A, noBudget.triggerId))!.enabled).toBe(false);
    const other = await customAgent(v, [{ kind: "person" }, PR], { member: PRIYA });
    const narrowed = await v.seed({ target: { kind: "agent", agentId: other.agentId }, createdBy: PRIYA });
    const draft = (await v.agents.getDraft(ORG_A, other.agentId))!;
    await v.agents.saveDraft({ orgId: ORG_A, agentId: other.agentId, overlay: { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }], triggers: [{ kind: "person" }] }, expectedRevision: draft.revision, by: PRIYA });
    const after = (await v.agents.getDraft(ORG_A, other.agentId))!;
    await v.agents.publish({ orgId: ORG_A, agentId: other.agentId, expectedDraftRevision: after.revision, digest: "e".repeat(64), by: PRIYA });
    expect(await dispatch(prEvent())).toEqual([{ triggerId: narrowed.triggerId, outcome: "failed", reason: "trigger_invalid" }]);
    expect(v.starts).toEqual([]);
  });

  it("never starts a trigger whose owner left the org, and says why", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer");
    const trigger = await v.seed({ target: BUILTIN, createdBy: "9".repeat(64) });
    expect(await dispatch(prEvent())).toEqual([{ triggerId: trigger.triggerId, outcome: "failed", reason: "trigger_invalid" }]);
    expect(v.starts).toEqual([]);
    expect(await v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ enabled: false });
  });
});

describe("the loop guard", () => {
  it("skips an event Rovara caused, with no requirement check, no rate count and no run", async () => {
    const { v, dispatch } = setup();
    v.hook("linear", HOOK_A);
    v.connection("linear", "rovara-linear-user");
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "linear", type: "issue.created" }, hookId: HOOK_A });
    expect(await dispatch(linearEvent(HOOK_A, { actor: { kind: "rovara", id: "rovara-linear-user" } }))).toEqual([{ triggerId: trigger.triggerId, outcome: "skipped", reason: "caused_by_rovara" }]);
    expect(v.db.get(triggerRateKey(ORG_A, trigger.triggerId, hour(v)))).toBeUndefined();
    expect(await activity(v, trigger.triggerId)).toMatchObject([{ outcome: "skipped", reason: "caused_by_rovara" }]);
    expect(v.starts).toEqual([]);
  });

  it("skips an event whose actor is Rovara's by the provider's word alone, with no account to compare", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer");
    await v.seed({ target: BUILTIN, createdBy: DANA });
    expect((await dispatch(prEvent({ actor: { kind: "rovara" } })))[0]).toMatchObject({ outcome: "skipped", reason: "caused_by_rovara" });
  });

  it("does not trust the sender's own classification: an event whose actor is the org's Rovara account is skipped even when the provider called it external", async () => {
    const { v, dispatch } = setup();
    v.hook("linear", HOOK_A);
    v.connection("linear", "rovara-linear-user");
    const chain = await v.budgetedChain(ONE_STEP);
    await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "linear", type: "issue.created" }, hookId: HOOK_A });
    expect((await dispatch(linearEvent(HOOK_A, { actor: { kind: "external", id: "rovara-linear-user" } })))[0]).toMatchObject({ outcome: "skipped", reason: "caused_by_rovara" });
    expect((await dispatch(linearEvent(HOOK_A, { actor: { kind: "external", id: "someone-else" } })))[0]).toMatchObject({ outcome: "started" });
  });

  it("skips a GitHub event from the app's own bot when the app's slug is known", async () => {
    const { v, deps } = setup();
    await v.builtinBudget("code-reviewer");
    await v.seed({ target: BUILTIN, createdBy: DANA });
    const withSlug = { ...deps, githubAppSlug: async () => "rovara-app" } as TriggerDispatchDependencies;
    const outcomes = await dispatchTriggerEvent(withSlug, ORG_A, prEvent({ actor: { kind: "external", id: "rovara-app[bot]" } }));
    expect(outcomes[0]).toMatchObject({ outcome: "skipped", reason: "caused_by_rovara" });
    expect(await rovaraActorIds(withSlug, ORG_A, "github")).toEqual(new Set(["rovara-app[bot]"]));
    expect(await rovaraActorIds(deps, ORG_A, "github")).toEqual(new Set());
    expect(await rovaraActorIds({ ...deps, githubAppSlug: async () => "" }, ORG_A, "github")).toEqual(new Set());
    expect(await rovaraActorIds(deps, ORG_A, "sentry")).toEqual(new Set());
  });

  it("reads the Linear and Jira actors from the org's own connections only", async () => {
    const { v, deps } = setup();
    v.connection("linear", "lin-1");
    v.connection("jira", "jira-1");
    expect(await rovaraActorIds(deps, ORG_A, "linear")).toEqual(new Set(["lin-1"]));
    expect(await rovaraActorIds(deps, ORG_A, "jira")).toEqual(new Set(["jira-1"]));
    expect(await rovaraActorIds(deps, ORG_B, "linear")).toEqual(new Set());
  });
});

describe("the actor guard applies only to a service identity (controller ruling, Task 22 review)", () => {
  it("counts only the accounts of connections marked as service identities as Rovara's own", async () => {
    const { v, deps } = setup();
    v.connection("linear", "lin-person", "personal");
    v.connection("jira", "jira-unmarked", "unmarked");
    expect(await rovaraActorIds(deps, ORG_A, "linear")).toEqual(new Set());
    expect(await rovaraActorIds(deps, ORG_A, "jira")).toEqual(new Set());
    // Two Linear connections: only the service one counts.
    v.db.set({ ...connectionsKey(ORG_A, `con_${"s".repeat(20)}`), entityType: "CONNECTION_DIRECTORY", connectionId: `con_${"s".repeat(20)}` });
    v.db.set({ ...connectionKey(ORG_A, `con_${"s".repeat(20)}`), entityType: "ORG_CONNECTION", orgId: ORG_A, connectionId: `con_${"s".repeat(20)}`, type: "linear", actorId: "lin-bot", identity: "service" });
    expect(await rovaraActorIds(deps, ORG_A, "linear")).toEqual(new Set(["lin-bot"]));
  });

  it("starts work for a ticket made by the person whose own key the org connected, and leaves the loop to the subject guard and the caps", async () => {
    const { v, dispatch } = setup();
    v.hook("linear", HOOK_A);
    v.connection("linear", "dana-linear", "personal");
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "linear", type: "issue.created" }, hookId: HOOK_A });
    expect((await dispatch(linearEvent(HOOK_A, { actor: { kind: "external", id: "dana-linear" } })))[0]).toMatchObject({ triggerId: trigger.triggerId, outcome: "started" });
    // The same ticket again (another event for the same subject) is the subject guard's, not the actor guard's.
    expect((await dispatch(linearEvent(HOOK_A, { eventKey: "linear:issue:again", actor: { kind: "external", id: "dana-linear" } })))[0]).toMatchObject({ outcome: "skipped", reason: "recent_subject" });
  });

  it("still skips an event made by a service identity", async () => {
    const { v, dispatch } = setup();
    v.hook("linear", HOOK_A);
    v.connection("linear", "lin-bot", "service");
    const chain = await v.budgetedChain(ONE_STEP);
    await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "linear", type: "issue.created" }, hookId: HOOK_A });
    expect((await dispatch(linearEvent(HOOK_A, { actor: { kind: "external", id: "lin-bot" } })))[0]).toMatchObject({ outcome: "skipped", reason: "caused_by_rovara" });
  });

  it("has no actor guard for PagerDuty or Sentry, which Rovara only reads: no account is Rovara's", async () => {
    const { deps } = setup();
    expect(await rovaraActorIds(deps, ORG_A, "pagerduty")).toEqual(new Set());
    expect(await rovaraActorIds(deps, ORG_A, "sentry")).toEqual(new Set());
  });
});

describe("limits", () => {
  it("starts exactly 30 of 200 concurrent events against maxRunsPerHour 30 and records the rest as rate_limited", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer", 500);
    const trigger = await v.seed({ target: BUILTIN, createdBy: DANA, maxRunsPerHour: 30 });
    const outcomes = (await Promise.all(Array.from({ length: 200 }, () => dispatch(prEvent())))).flat();
    expect(outcomes.filter((entry) => entry.outcome === "started")).toHaveLength(30);
    expect(outcomes.filter((entry) => entry.outcome === "skipped" && entry.reason === "rate_limited")).toHaveLength(170);
    expect(v.starts).toHaveLength(30);
    const items = await activity(v, trigger.triggerId);
    expect(items.filter((item) => item.reason === "rate_limited")).toHaveLength(170);
    // The next hour is a new allowance.
    v.clock.now += 3_600_000;
    expect((await dispatch(prEvent()))[0]).toMatchObject({ outcome: "started" });
  });

  it("holds a trigger whose stored allowance is not a positive number to nothing, and never above the platform's most", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer", 500);
    const trigger = await v.seed({ target: BUILTIN, createdBy: DANA });
    v.db.set({ ...v.db.get(triggerKey(ORG_A, trigger.triggerId))!, maxRunsPerHour: 0 });
    expect((await dispatch(prEvent()))[0]).toMatchObject({ outcome: "skipped", reason: "rate_limited" });
    v.db.set({ ...v.db.get(triggerKey(ORG_A, trigger.triggerId))!, maxRunsPerHour: 1000 });
    const outcomes = (await Promise.all(Array.from({ length: 80 }, () => dispatch(prEvent())))).flat();
    expect(outcomes.filter((entry) => entry.outcome === "started")).toHaveLength(60);
  });

  it("stops every trigger of the org at the day's cap with org_daily_limit, and starts again the next day", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer", 500);
    const trigger = await v.seed({ target: BUILTIN, createdBy: DANA });
    v.db.set({ ...orgAutonomousKey(ORG_A, day(v)), entityType: "ORG_AUTONOMOUS", count: 499 });
    expect((await dispatch(prEvent()))[0]).toMatchObject({ outcome: "started" });
    expect(await dispatch(prEvent())).toEqual([{ triggerId: trigger.triggerId, outcome: "skipped", reason: "org_daily_limit" }]);
    expect(v.starts).toHaveLength(1);
    v.clock.now += 86_400_000;
    expect((await dispatch(prEvent()))[0]).toMatchObject({ outcome: "started" });
  });

  it("gives the counters a time to live, so they clean themselves up", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer");
    const trigger = await v.seed({ target: BUILTIN, createdBy: DANA });
    await dispatch(prEvent());
    const seconds = Math.floor(v.clock.now / 1000);
    expect(v.db.get(triggerRateKey(ORG_A, trigger.triggerId, hour(v)))!["indexExpiresAt"]).toBe(seconds + 2 * 3600);
    expect(v.db.get(orgAutonomousKey(ORG_A, day(v)))!["indexExpiresAt"]).toBe(seconds + 2 * 86_400);
  });
});

describe("failures and what is logged", () => {
  it("records a busy system as busy, a refusal by its code, and a service that is away as an error to try again", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer");
    const trigger = await v.seed({ target: BUILTIN, createdBy: DANA });
    for (const code of ["WORKSPACE_BUSY", "TOO_MANY_REQUESTS"] as const) {
      v.hooks.refuse.push(agentXError(code, "wait"));
      expect(await dispatch(prEvent())).toEqual([{ triggerId: trigger.triggerId, outcome: "failed", reason: "busy" }]);
    }
    v.hooks.refuse.push(agentXError("AGENT_BUDGET_EXCEEDED", "the words are not stored"));
    expect(await dispatch(prEvent())).toEqual([{ triggerId: trigger.triggerId, outcome: "failed", reason: "AGENT_BUDGET_EXCEEDED" }]);
    expect(JSON.stringify(await activity(v, trigger.triggerId))).not.toContain("the words are not stored");
    v.hooks.refuse.push(agentXError("RUNTIME_UNAVAILABLE", "away"));
    await expect(dispatch(prEvent())).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("records a refusal by its code and not its words, leaves the others' starts alone, and lets a transient fault come back as an error so the vendor sends the event again", async () => {
    const { v, dispatch } = setup();
    await v.builtinBudget("code-reviewer");
    const first = await v.seed({ target: BUILTIN, createdBy: DANA });
    const second = await v.seed({ target: BUILTIN, createdBy: DANA });
    v.hooks.refuse.push(Object.assign(new Error("model said: top secret"), { name: "Boom" }));
    await expect(dispatch(prEvent())).rejects.toThrow();
    // The first trigger's failure did not stop the second from starting.
    expect(v.starts.map((request) => request.requestId).length).toBe(2);
    expect(first.triggerId).not.toBe(second.triggerId);
    expect((await activity(v, first.triggerId)).length + (await activity(v, second.triggerId)).length).toBe(1);
  });

  it("puts no payload text in any log line: not the title, the link, the event key, the actor or the words of an error", async () => {
    const { v, dispatch, logs } = setup();
    await v.builtinBudget("code-reviewer");
    await v.seed({ target: BUILTIN, createdBy: DANA, maxRunsPerHour: 1 });
    const marker = "PAYLOAD-MARKER-27182";
    const loud = (over: Partial<TriggerEvent> = {}) => prEvent({
      eventKey: `gh:${marker}:${String(++counter)}`, subject: { kind: "pull_request", id: marker, title: `${marker} title`, url: `https://example.com/${marker}` }, actor: { kind: "external", id: `${marker}-actor` }, ...over,
    });
    await dispatch(loud());
    await dispatch(loud());
    v.hooks.refuse.push(Object.assign(new Error(marker), { name: "Boom" }));
    v.clock.now += 3_600_000;
    await dispatch(loud()).catch(() => undefined);
    await dispatch(loud({ actor: { kind: "rovara", id: marker } }));
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(marker);
    expect(JSON.stringify(logs)).not.toContain("example.com");
  });
});
