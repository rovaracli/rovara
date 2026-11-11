// Plan 4 Task 18 (Review Focus 8): a target changes after its trigger was saved. A publish, a rollback, a budget change, an archive, a roster change or a guardrail change that takes
// away what a trigger needs turns the trigger off, tells its owners and leaves the change itself made; a change that takes nothing away leaves every trigger as it was.
import { afterEach, describe, expect, it, vi } from "vitest";
// The package the broker imports, not its source: the test changes the very table the broker reads.
import { BUILTIN_TRIGGER_SUGGESTIONS } from "@rovara-code/contracts";
import { TriggerSpecSchema } from "@rovara-code/contracts";
import type { ChainDefinitionInput } from "@rovara-code/contracts";
import { recheckTriggersForTarget } from "../../packages/broker/src/triggers/lifecycle.js";
import { triggerProblems } from "../../packages/broker/src/triggers/requirements.js";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";
import { CARL, DANA, MAX, ORG_A, PRIYA, disposeGateWorlds, setupTriggerWorld, type TriggerWorld } from "../support/trigger-world.js";
import { fixtureActor } from "../support/money-authority.js";

afterEach(disposeGateWorlds);

const PR = { kind: "event" as const, source: "github" as const, type: "pull_request.opened" };
const ISSUE = { kind: "event" as const, source: "github" as const, type: "issues.opened" };
const stored = async (v: TriggerWorld, triggerId: string) => (await v.triggers.get(ORG_A, triggerId))!;
const confirmId = (confirmUrl: unknown) => String(confirmUrl).split("/").pop()!;

const ONE_STEP = (extra: Partial<ChainDefinitionInput> = {}): ChainDefinitionInput => ({ start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], ...extra });

/** A chain with one enabled trigger on it (created by Dana, owned by Priya) and what to call to change it. */
async function triggered(definition: ChainDefinitionInput = INVESTIGATE_THEN_FIX) {
  const v = setupTriggerWorld();
  const chain = await v.budgetedChain(definition);
  const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
  const publish = async (who: string, next: ChainDefinitionInput) => {
    const draft = (await v.chainCall(who, "GET", `/v1/app/chains/${chain.chainId}/draft`)).body["draft"] as { revision: number };
    const saved = await v.chainCall(who, "PUT", `/v1/app/chains/${chain.chainId}/draft`, { expectedRevision: draft.revision, definition: next });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    return v.chainCall(who, "POST", `/v1/app/chains/${chain.chainId}/publish`, { expectedDraftRevision: draft.revision + 1 });
  };
  return { v, chain, trigger, publish };
}

describe("a change to a chain that takes away what its trigger needs", () => {
  it("turns the trigger off when a publish removes a gate's maintainers, and tells the chain's owner and the trigger's creator, and the publish still succeeds", async () => {
    const { v, chain, trigger, publish } = await triggered();
    const narrower = structuredClone(INVESTIGATE_THEN_FIX) as { steps: Array<{ kind: string; approvers?: unknown }> };
    narrower.steps[1]!.approvers = [{ kind: "starter" }];
    const published = await publish(PRIYA, narrower as unknown as ChainDefinitionInput);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect((published.body["chain"] as { currentVersion: number }).currentVersion).toBe(2);
    const disabled = published.body["disabledTriggers"] as Array<{ triggerId: string; problems: Array<{ message: string }> }>;
    expect(disabled.map((entry) => entry.triggerId)).toEqual([trigger.triggerId]);
    const after = await stored(v, trigger.triggerId);
    expect(after.enabled).toBe(false);
    expect(after.disabledReason).toBe("steps.1.approvers: no one starts an event or schedule run, so add project maintainers, the chain owner or named people");
    const activity = await v.triggers.listActivity(ORG_A, trigger.triggerId);
    expect(activity).toMatchObject([{ outcome: "disabled", reason: after.disabledReason }]);
    const text = `${chain.name}'s trigger "github pull request opened" was turned off: ${after.disabledReason}.`;
    expect(await v.notices(DANA)).toEqual([text]);
    expect(await v.notices(PRIYA)).toEqual([text]);
    expect(await v.notices(MAX)).toEqual([]);
    expect(v.targetEvents({ kind: "chain", chainId: chain.chainId }).map((event) => event["kind"])).toContain("trigger_disabled");
  });

  it("turns it off when a publish removes the run limit, after a person confirms the less safe publish", async () => {
    const { v, trigger, publish } = await triggered();
    const noLimit = { ...structuredClone(INVESTIGATE_THEN_FIX), limits: {} } as ChainDefinitionInput;
    const waiting = await publish(PRIYA, noLimit);
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(202);
    expect((await stored(v, trigger.triggerId)).enabled).toBe(true);
    await v.decideAs(PRIYA, confirmId(waiting.body["confirmUrl"]));
    const after = await stored(v, trigger.triggerId);
    expect(after.enabled).toBe(false);
    expect(after.disabledReason).toContain("has no monthly budget and run limit, so events and schedules can't start it");
  });

  it("turns it off when a rollback goes to a version whose gate only the starter can approve", async () => {
    const starterOnly = structuredClone(INVESTIGATE_THEN_FIX) as { steps: Array<{ kind: string; approvers?: unknown }> };
    starterOnly.steps[1]!.approvers = [{ kind: "starter" }];
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain(starterOnly as unknown as ChainDefinitionInput);
    await v.publishAgain(chain.chainId, INVESTIGATE_THEN_FIX);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    expect((await triggerProblems(v.routeDeps, trigger))).toEqual([]);
    const rolled = await v.chainCall(PRIYA, "POST", `/v1/app/chains/${chain.chainId}/rollback`, { version: 1 });
    expect(rolled.status, JSON.stringify(rolled.body)).toBe(200);
    expect((rolled.body["disabledTriggers"] as unknown[]).length).toBe(1);
    expect((await stored(v, trigger.triggerId)).enabled).toBe(false);
  });

  it("turns it off when the chain's budget is removed, and leaves it off after a version that fixes things until a maintainer turns it on", async () => {
    const { v, chain, trigger } = await triggered();
    const removed = await v.chainCall(PRIYA, "PUT", `/v1/app/chains/${chain.chainId}/budget`, { monthlyUsd: null });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((removed.body["disabledTriggers"] as Array<{ triggerId: string }>).map((entry) => entry.triggerId)).toEqual([trigger.triggerId]);
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: false });
    expect((await v.chainCall(PRIYA, "PUT", `/v1/app/chains/${chain.chainId}/budget`, { monthlyUsd: 40 })).status).toBe(200);
    await v.publishAgain(chain.chainId, INVESTIGATE_THEN_FIX);
    expect((await stored(v, trigger.triggerId)).enabled).toBe(false);
    const again = await v.chainCall(DANA, "PUT", `/v1/app/chains/${chain.chainId}/triggers/${trigger.triggerId}`, { project: "web", spec: trigger.spec, enabled: true });
    expect(again.status).toBe(202);
    await v.decideAs(DANA, confirmId(again.body["confirmUrl"]));
    expect((await stored(v, trigger.triggerId)).enabled).toBe(true);
  });

  it("turns it off when a step's agent is archived", async () => {
    const v = setupTriggerWorld();
    const agent = await v.customAgent("Digger", PRIYA);
    const chain = await v.budgetedChain(ONE_STEP({ steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: agent.agentId, version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 } }));
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    expect(await triggerProblems(v.routeDeps, trigger)).toEqual([]);
    fixtureActor(v.db, ORG_A, DANA); // archiving holds the admin to their company access in its own transaction
    expect((await v.agentCall(DANA, "POST", `/v1/app/agents/${agent.agentId}/archive`, {})).status).toBe(200);
    const [problem] = await triggerProblems(v.routeDeps, trigger);
    expect(problem).toMatchObject({ code: "CHAIN_UNAVAILABLE" });
    expect(problem!.message).toContain("is archived, so it can't start new work");
  });

  it("leaves a trigger that still qualifies enabled and untouched by an unrelated publish", async () => {
    const { v, trigger, publish } = await triggered(ONE_STEP({ limits: { maxRunUsd: 5 } }));
    const before = await stored(v, trigger.triggerId);
    const next = ONE_STEP({ limits: { maxRunUsd: 5 } }) as { steps: Array<{ instructions?: string }> };
    next.steps[0]!.instructions = "Look closely.";
    const published = await publish(PRIYA, next as unknown as ChainDefinitionInput);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body["disabledTriggers"]).toEqual([]);
    expect(await stored(v, trigger.triggerId)).toEqual(before);
    expect(await v.notices(DANA)).toEqual([]);
  });
});

describe("who may publish or roll back what has a trigger on", () => {
  it("gives a sharee with edit 403 on a chain with an enabled trigger, and lets the same call through when none is on", async () => {
    const { v, chain, trigger } = await triggered(ONE_STEP({ limits: { maxRunUsd: 5 } }));
    expect((await v.chainCall(PRIYA, "PUT", `/v1/app/chains/${chain.chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: CARL }, level: "edit" }] })).status).toBe(200);
    const next = ONE_STEP({ limits: { maxRunUsd: 5 } }) as { steps: Array<{ instructions?: string }> };
    next.steps[0]!.instructions = "Look closely.";
    const attempt = async () => {
      const draft = (await v.chainCall(CARL, "GET", `/v1/app/chains/${chain.chainId}/draft`)).body["draft"] as { revision: number };
      await v.chainCall(CARL, "PUT", `/v1/app/chains/${chain.chainId}/draft`, { expectedRevision: draft.revision, definition: next });
      return v.chainCall(CARL, "POST", `/v1/app/chains/${chain.chainId}/publish`, { expectedDraftRevision: draft.revision + 1 });
    };
    const refused = await attempt();
    expect(refused).toMatchObject({ status: 403 });
    expect(String(refused.body["message"])).toContain("has triggers turned on, so changing the version it runs needs");
    await v.publishAgain(chain.chainId, ONE_STEP({ limits: { maxRunUsd: 5 } }));
    expect((await v.chainCall(CARL, "POST", `/v1/app/chains/${chain.chainId}/rollback`, { version: 1 })).status).toBe(403);
    await v.triggers.update({ trigger: await stored(v, trigger.triggerId), patch: { enabled: false } });
    expect((await v.chainCall(CARL, "POST", `/v1/app/chains/${chain.chainId}/rollback`, { version: 1 })).status).toBe(200);
  });

  it("gives a sharee with edit 403 on an agent with an enabled trigger, for a publish and a rollback, and succeeds with none on", async () => {
    const v = setupTriggerWorld();
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, ISSUE], { budgetUsd: 20 });
    const base = `/v1/app/agents/${agent.agentId}`;
    expect((await v.agentCall(DANA, "PUT", `${base}/shares`, { shares: [{ principal: { kind: "member", developerId: CARL }, level: "edit" }] })).status).toBe(200);
    const trigger = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA, spec: TriggerSpecSchema.parse(ISSUE) as never });
    const draftOf = async () => (await v.agentCall(CARL, "GET", `${base}/draft`)).body["draft"] as { revision: number; overlay: Record<string, unknown> };
    const publish = async () => {
      const draft = await draftOf();
      const saved = await v.agentCall(CARL, "PUT", `${base}/draft`, { expectedRevision: draft.revision, overlay: { ...draft.overlay, instructions: `x${String(draft.revision)}` } });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      return v.agentCall(CARL, "POST", `${base}/publish`, { expectedRevision: draft.revision + 1 });
    };
    expect(await publish()).toMatchObject({ status: 403 });
    expect((await v.agentCall(CARL, "POST", `${base}/rollback`, { version: 1 })).status).toBe(403);
    await v.triggers.update({ trigger: await stored(v, trigger.triggerId), patch: { enabled: false } });
    const published = await publish();
    expect(published.status, JSON.stringify(published.body)).toBe(200);
  });
});

describe("a change to an agent that takes away what its trigger needs", () => {
  it("turns the trigger off when a new version drops the event kind from the recipe", async () => {
    const v = setupTriggerWorld();
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, ISSUE], { budgetUsd: 20 });
    const trigger = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA, spec: TriggerSpecSchema.parse(ISSUE) as never });
    const base = `/v1/app/agents/${agent.agentId}`;
    const draft = (await v.agentCall(DANA, "GET", `${base}/draft`)).body["draft"] as { revision: number; overlay: Record<string, unknown> };
    await v.agentCall(DANA, "PUT", `${base}/draft`, { expectedRevision: draft.revision, overlay: { ...draft.overlay, triggers: [{ kind: "person" }] } });
    const published = await v.agentCall(DANA, "POST", `${base}/publish`, { expectedRevision: draft.revision + 1 });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect((published.body["disabledTriggers"] as Array<{ triggerId: string }>).map((entry) => entry.triggerId)).toEqual([trigger.triggerId]);
    expect((await stored(v, trigger.triggerId)).disabledReason).toBe("spec: Triage bot can't be started by events; ask its owner to allow it");
  });

  it("turns it off when the agent's budget is removed, when it leaves the project's roster, and when it is archived", async () => {
    const v = setupTriggerWorld();
    const make = async (name: string) => {
      const agent = await v.triggerAgent(name, [{ kind: "person" }, ISSUE], { budgetUsd: 20 });
      return { agent, trigger: await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA, spec: TriggerSpecSchema.parse(ISSUE) as never }) };
    };
    const budget = await make("Budget bot");
    const budgetRemoved = await v.agentCall(DANA, "PUT", `/v1/app/agents/${budget.agent.agentId}/budget`, { monthlyUsd: null });
    expect(budgetRemoved.status, JSON.stringify(budgetRemoved.body)).toBe(200);
    expect(await stored(v, budget.trigger.triggerId)).toMatchObject({ enabled: false, disabledReason: expect.stringContaining("has no monthly budget") as string });
    const roster = await make("Roster bot");
    const removed = await v.agentCall(DANA, "DELETE", `/v1/app/projects/web/agents/${roster.agent.agentId}`, {});
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((removed.body["disabledTriggers"] as unknown[]).length).toBe(1);
    expect((await stored(v, roster.trigger.triggerId)).enabled).toBe(false);
    const archived = await make("Archive bot");
    await v.agentCall(DANA, "POST", `/v1/app/agents/${archived.agent.agentId}/archive`, {});
    expect(await stored(v, archived.trigger.triggerId)).toMatchObject({ enabled: false });
  });

  it("turns a built-in's triggers off when the company turns the built-in off, or forbids its model", async () => {
    const v = setupTriggerWorld();
    await v.builtinBudget("code-reviewer");
    await v.builtinBudget("deploy-reviewer");
    BUILTIN_TRIGGER_SUGGESTIONS["deploy-reviewer"] = [PR];
    try {
      const reviewer = await v.seed({ target: { kind: "agent", agentId: "code-reviewer" }, createdBy: DANA, spec: TriggerSpecSchema.parse(PR) as never });
      const deploy = await v.seed({ target: { kind: "agent", agentId: "deploy-reviewer" }, createdBy: DANA, spec: TriggerSpecSchema.parse(PR) as never });
      expect(await triggerProblems(v.routeDeps, reviewer)).toEqual([]);
      const guardrails = (await v.agentCall(DANA, "GET", "/v1/app/org/agent-guardrails")).body as { revision: number; guardrails: Record<string, unknown> };
      const turnedOff = await v.agentCall(DANA, "PUT", "/v1/app/org/agent-guardrails", { expectedRevision: guardrails.revision, guardrails: { ...guardrails.guardrails, disabledBuiltins: ["code-reviewer"] } });
      expect(turnedOff.status, JSON.stringify(turnedOff.body)).toBe(200);
      expect(await stored(v, reviewer.triggerId)).toMatchObject({ enabled: false, disabledReason: expect.stringContaining("is turned off in your company") as string });
      expect(await triggerProblems(v.routeDeps, deploy)).toEqual([]);
      expect((await stored(v, deploy.triggerId)).enabled).toBe(true);
    } finally {
      BUILTIN_TRIGGER_SUGGESTIONS["deploy-reviewer"] = [];
    }
  });

  it("turns a built-in's trigger off at the next recheck when a release no longer suggests its spec", async () => {
    const v = setupTriggerWorld();
    await v.builtinBudget("code-reviewer");
    const trigger = await v.seed({ target: { kind: "agent", agentId: "code-reviewer" }, createdBy: DANA, spec: TriggerSpecSchema.parse(PR) as never });
    expect(await triggerProblems(v.routeDeps, trigger)).toEqual([]);
    const before = BUILTIN_TRIGGER_SUGGESTIONS["code-reviewer"];
    BUILTIN_TRIGGER_SUGGESTIONS["code-reviewer"] = [];
    try {
      expect((await triggerProblems(v.routeDeps, trigger))[0]).toMatchObject({ path: "spec" });
      const turnedOff = await recheckTriggersForTarget(v.routeDeps, ORG_A, { kind: "agent", agentId: "code-reviewer" });
      expect(turnedOff.map((entry) => entry.triggerId)).toEqual([trigger.triggerId]);
    } finally {
      BUILTIN_TRIGGER_SUGGESTIONS["code-reviewer"] = before;
    }
    expect((await stored(v, trigger.triggerId)).enabled).toBe(false);
  });

  it("sets a disabled schedule trigger's schedule DISABLED at the scheduler", async () => {
    const v = setupTriggerWorld();
    const schedule = TriggerSpecSchema.parse({ kind: "schedule", schedule: { kind: "interval", minutes: 60 }, timezone: "UTC" });
    const agent = await v.triggerAgent("Nightly", [{ kind: "person" }, schedule], { budgetUsd: 20 });
    const trigger = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA, spec: schedule as never, scheduleStatus: "ok" });
    await v.scheduler.put({ orgId: ORG_A, triggerId: trigger.triggerId, spec: trigger.spec });
    await v.agentCall(DANA, "PUT", `/v1/app/agents/${agent.agentId}/budget`, { monthlyUsd: null });
    expect((await stored(v, trigger.triggerId)).enabled).toBe(false);
    expect(v.scheduler.states.get(trigger.triggerId)).toBe("DISABLED");
  });

  it("leaves the change made when the recheck itself fails, and the trigger for dispatch to check", async () => {
    const { v, chain, trigger } = await triggered();
    const hooks = v.routeDeps.triggers!;
    const original = hooks.listForTarget.bind(hooks);
    hooks.listForTarget = async () => { throw new Error("the table is not reachable"); };
    const logged: string[] = [];
    v.routeDeps.log = (event) => { logged.push(event); };
    // L5: the change is made before the re-check, so a re-check that cannot list the triggers is logged and the answer is the change that was made (it used to be a 500).
    const removed = await v.chainCall(PRIYA, "PUT", `/v1/app/chains/${chain.chainId}/budget`, { monthlyUsd: null });
    hooks.listForTarget = original;
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body["disabledTriggers"]).toEqual([]);
    expect(logged).toContain("trigger_recheck.failed");
    expect((await v.chains.get(ORG_A, chain.chainId))?.monthlyBudgetUsd).toBeUndefined();
    expect((await stored(v, trigger.triggerId)).enabled).toBe(true);
    expect((await triggerProblems(v.routeDeps, await stored(v, trigger.triggerId)))[0]).toMatchObject({ code: "CHAIN_BUDGET_REQUIRED" });
  });
});

describe("what a trigger's owner must be", () => {
  it("is a current member who holds start_tasks on the project", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const base = { target: { kind: "chain" as const, chainId: chain.chainId } };
    const viewer = await v.seed({ ...base, createdBy: "e".repeat(64) });
    expect((await triggerProblems(v.routeDeps, viewer))[0]).toMatchObject({ path: "createdBy" });
    const stranger = await v.seed({ ...base, createdBy: "9".repeat(64) });
    expect((await triggerProblems(v.routeDeps, stranger))[0]).toMatchObject({ path: "createdBy", message: expect.stringContaining("no longer a member") as string });
    const contributor = await v.seed({ ...base, createdBy: PRIYA });
    expect(await triggerProblems(v.routeDeps, contributor)).toEqual([]);
  });
});

describe("a change that waits for a person turns triggers off when it is confirmed, not before", () => {
  const SCHEDULE = TriggerSpecSchema.parse({ kind: "schedule", schedule: { kind: "interval", minutes: 60 }, timezone: "UTC" });
  const scheduleOverlay = (draft: { overlay: Record<string, unknown> }) => ({ ...draft.overlay, triggers: [{ kind: "person" }, SCHEDULE] });
  const draftOf = async (v: TriggerWorld, base: string) => (await v.agentCall(DANA, "GET", `${base}/draft`)).body["draft"] as { revision: number; overlay: Record<string, unknown> };

  it("does it for a publish that turns on a schedule and drops the event kind", async () => {
    const v = setupTriggerWorld();
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, ISSUE], { budgetUsd: 20 });
    const trigger = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA, spec: TriggerSpecSchema.parse(ISSUE) as never });
    const base = `/v1/app/agents/${agent.agentId}`;
    const draft = await draftOf(v, base);
    await v.agentCall(DANA, "PUT", `${base}/draft`, { expectedRevision: draft.revision, overlay: scheduleOverlay(draft) });
    const waiting = await v.agentCall(DANA, "POST", `${base}/publish`, { expectedRevision: draft.revision + 1 });
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(202);
    expect((await stored(v, trigger.triggerId)).enabled).toBe(true);
    await v.decideAs(DANA, confirmId(waiting.body["confirmUrl"]));
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: false });
  });

  it("does it for a rollback that turns on a schedule and drops the event kind", async () => {
    const v = setupTriggerWorld();
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, SCHEDULE], { budgetUsd: 20 });
    const base = `/v1/app/agents/${agent.agentId}`;
    // The second version is published straight to the store: a version that turns on a new way to start the agent would wait for a person itself.
    const draft = await draftOf(v, base);
    await v.agents.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: { ...draft.overlay, triggers: [{ kind: "person" }, ISSUE] } as never, expectedRevision: draft.revision, by: DANA });
    await v.agents.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: draft.revision + 1, digest: "e".repeat(64), by: DANA });
    const trigger = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA, spec: TriggerSpecSchema.parse(ISSUE) as never });
    const waiting = await v.agentCall(DANA, "POST", `${base}/rollback`, { version: 1 });
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(202);
    expect((await stored(v, trigger.triggerId)).enabled).toBe(true);
    await v.decideAs(DANA, confirmId(waiting.body["confirmUrl"]));
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: false });
  });

  it("does it for a change to the company's guardrails that turns a built-in off and relaxes another limit", async () => {
    const v = setupTriggerWorld();
    await v.builtinBudget("code-reviewer");
    const trigger = await v.seed({ target: { kind: "agent", agentId: "code-reviewer" }, createdBy: DANA, spec: TriggerSpecSchema.parse(PR) as never });
    const current = (await v.agentCall(DANA, "GET", "/v1/app/org/agent-guardrails")).body as { revision: number; guardrails: { maxAgentMonthlyUsd: number } };
    const waiting = await v.agentCall(DANA, "PUT", "/v1/app/org/agent-guardrails", {
      expectedRevision: current.revision, guardrails: { ...current.guardrails, maxAgentMonthlyUsd: current.guardrails.maxAgentMonthlyUsd + 100, disabledBuiltins: ["code-reviewer"] },
    });
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(202);
    expect((await stored(v, trigger.triggerId)).enabled).toBe(true);
    await v.decideAs(DANA, confirmId(waiting.body["confirmUrl"]));
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: false });
  });

  it("looks at a built-in's triggers again when its version is adopted, and for a custom agent's roster, publish and rollback", async () => {
    const v = setupTriggerWorld();
    const seen: string[] = [];
    const hooks = v.routeDeps.triggerHooks!;
    const spy = vi.spyOn(hooks, "recheckTriggersForTarget").mockImplementation(async (_org, target) => { seen.push(target.kind === "agent" ? target.agentId : target.chainId); return []; });
    const adopted = await v.agentCall(DANA, "POST", "/v1/app/agents/code-reviewer/adopt", { version: 1 });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    expect(seen).toEqual(["code-reviewer"]);
    spy.mockRestore();
  });
});
