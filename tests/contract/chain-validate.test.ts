import { fixtureActor } from "../support/money-authority.js";
// Plan 4 Task 2: chain graph validation, agent pinning at publish and the requirements of an event or schedule trigger.
import { describe, expect, it } from "vitest";
import type { AgentAccessDeps, AgentCaller } from "../../packages/broker/src/agents/access.js";
import { AgentStore, type BuiltinSource } from "../../packages/broker/src/agents/store.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import {
  autonomousTriggerProblems,
  chainGraphProblems,
  formatChainProblem,
  validateChainForPublish,
} from "../../packages/broker/src/chains/validate.js";
import { DEFAULT_AGENT_GUARDRAILS } from "../../packages/contracts/src/agent-guardrails.js";
import { BUILTIN_AGENTS, builtinDefaultPin, builtinRecipe, currentBuiltinVersion } from "../../packages/contracts/src/agent-templates.js";
import type { AgentId } from "../../packages/contracts/src/agent.js";
import type { RecipeOverlay } from "../../packages/contracts/src/agent-recipe-node.js";
import { PinnedChainDefinitionSchema, type ApproverRule, type ChainDefinition, type ChainDefinitionInput, type PinnedChainDefinition } from "../../packages/contracts/src/chains.js";
import { ChainDefinitionSchema } from "../../packages/contracts/src/chains.js";
import type { OrgId, OrgRole } from "../../packages/contracts/src/org.js";
import { orgMemberKey } from "../../packages/contracts/src/org-node.js";
import { builtinSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";

const START = Date.parse("2026-10-22T09:00:00.000Z");
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const STRANGER = "1".repeat(64);
const DIGEST = "d".repeat(64);
const ROLES: Record<string, OrgRole> = { [ALICE]: "member", [BOB]: "member" };

const SCRATCH: RecipeOverlay = { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] };
const UNSERVED_MODEL: RecipeOverlay = {
  instructions: "x",
  sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none", settings: { model: { provider: "openai", modelId: "gpt-not-served" } } }],
};

const caller = (developerId: string = ALICE, orgId: OrgId = ORG_A): AgentCaller => ({ orgId, developerId, orgRole: ROLES[developerId] ?? "member" });

/** The shipped built-ins, except that Code reviewer has released up to `release.codeReviewer`. */
function builtinsWithRelease(release: { codeReviewer: number }): BuiltinSource {
  return {
    currentVersion: (id) => (id === "code-reviewer" ? release.codeReviewer : currentBuiltinVersion(id as "rovara-code")),
    defaultPin: (id) => (id === "code-reviewer" ? release.codeReviewer : builtinDefaultPin(id as "rovara-code")),
    recipe: (id, version) => {
      if (id !== "code-reviewer" || version <= currentBuiltinVersion("code-reviewer") || version > release.codeReviewer) return builtinRecipe(id as "rovara-code", version);
      return builtinRecipe("code-reviewer", 1);
    },
    name: (id) => BUILTIN_AGENTS[id as "rovara-code"].name,
  };
}

function setup() {
  const db = new FakeDynamoDb();
  const clock = { now: START };
  const release = { codeReviewer: currentBuiltinVersion("code-reviewer") };
  let counter = 0;
  const store = new AgentStore({
    documentClient: db,
    tableName: "T",
    now: () => clock.now,
    newId: () => `agt_${String(++counter).padStart(20, "0")}`,
    builtins: builtinsWithRelease(release),
  });
  const deps: AgentAccessDeps = {
    store,
    projectMembers: new FakeProjectMembers(),
    documentClient: db,
    tableName: "T",
    signInStore: new DeveloperSignInStore({ documentClient: db, tableName: "T", now: () => clock.now }),
  };
  for (const [developerId, role] of Object.entries(ROLES)) {
    db.set({ ...orgMemberKey(ORG_A, developerId), entityType: "ORG_MEMBER", orgId: ORG_A, developerId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId });
  }
  db.set({ ...orgMemberKey(ORG_B, STRANGER), entityType: "ORG_MEMBER", orgId: ORG_B, developerId: STRANGER, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });

  const create = (name: string, overlay: RecipeOverlay = SCRATCH, extra: { owner?: string; orgId?: OrgId; extends?: AgentId } = {}) =>
    store.create({ orgId: extra.orgId ?? ORG_A, name, owner: { kind: "member", developerId: extra.owner ?? ALICE }, overlay, createdBy: extra.owner ?? ALICE, ...(extra.extends === undefined ? {} : { extends: extra.extends }) });
  const publish = async (agentId: AgentId, orgId: OrgId = ORG_A) => {
    const agent = (await store.get(orgId, agentId))!;
    return store.publish({ orgId, agentId, expectedDraftRevision: agent.draftRevision, digest: DIGEST, by: ALICE });
  };
  const validate = (def: ChainDefinitionInput, who: AgentCaller = caller()) => validateChainForPublish(deps, who, who.orgId, ChainDefinitionSchema.parse(def));
  return { db, release, store, deps, create, publish, validate };
}

/** One agent step that goes where `to` says, or ends. */
const agent = (id: string, to: string | undefined, extra: Record<string, unknown> = {}) => ({
  kind: "agent" as const,
  id,
  name: id,
  agent: { agentId: "ticket-triage", version: "current" as const },
  next: to === undefined ? ({ kind: "end" } as const) : ({ kind: "go", to, ...extra } as const),
});
const design = (start: string, ...steps: unknown[]): ChainDefinition => ChainDefinitionSchema.parse({ start, steps });
const text = (problems: Array<{ path: string; message: string }>) => problems.map(formatChainProblem);

describe("chainGraphProblems", () => {
  it("finds nothing wrong with the investigate-then-fix example", () => {
    expect(chainGraphProblems(ChainDefinitionSchema.parse(INVESTIGATE_THEN_FIX))).toEqual([]);
  });

  it("refuses a start that is not a step, and then reports no reachability noise", () => {
    expect(text(chainGraphProblems(design("nope", agent("a", undefined))))).toEqual(["start: no step is called nope"]);
  });

  it("refuses an edge to an unknown step on every kind of edge, at its own path", () => {
    const def = design(
      "a",
      { ...agent("a", undefined), next: { kind: "go", to: "ghost1" } },
      {
        kind: "agent", id: "b", name: "b", agent: { agentId: "ticket-triage", version: "current" },
        next: { kind: "branch", choices: [{ id: "x", description: "x", to: "$end" }, { id: "y", description: "y", to: "ghost2" }] },
      },
      { kind: "gate", id: "g", name: "g", prompt: "ok?", approvers: [{ kind: "chain_owner" }], onApprove: { to: "ghost3" }, onReject: { to: "nope" } },
    );
    expect(text(chainGraphProblems(def))).toEqual(
      expect.arrayContaining([
        "steps.0.next.to: no step is called ghost1",
        "steps.1.next.choices.1.to: no step is called ghost2",
        "steps.2.onApprove.to: no step is called ghost3",
        "steps.2.onReject.to: no step is called nope",
      ]),
    );
  });

  it("reports a gate's onReject to an unknown step with the exact text (the plan's example)", () => {
    const def = design("a", agent("a", "g"), { kind: "gate", id: "g", name: "g", prompt: "ok?", approvers: [{ kind: "chain_owner" }], onApprove: { to: "$end" }, onReject: { to: "nope" } });
    expect(chainGraphProblems(def)).toContainEqual({ path: "steps.1.onReject.to", message: "no step is called nope" });
    expect(text(chainGraphProblems(def))).toContain("steps.1.onReject.to: no step is called nope");
  });

  it("refuses a step no path from start reaches, naming its index and id", () => {
    const def = design("a", agent("a", undefined), agent("b", undefined), agent("c", "b"));
    expect(text(chainGraphProblems(def))).toEqual(["steps.1: b can never run", "steps.2: c can never run"]);
  });

  it("does not call a step reachable only through a branch choice or a gate edge unreachable", () => {
    expect(chainGraphProblems(ChainDefinitionSchema.parse(INVESTIGATE_THEN_FIX))).toEqual([]);
  });

  it("refuses a chain with no path to the end", () => {
    // a -> b -> a is bounded, so the only problem is that nothing leaves the loop.
    const def = design("a", agent("a", "b"), agent("b", "a", { maxTraversals: 2 }));
    expect(text(chainGraphProblems(def))).toEqual(["start: this chain can never finish"]);
  });

  it("accepts a chain whose only way out is a gate's rejection or a branch choice", () => {
    const gateOut = design("g", { kind: "gate", id: "g", name: "g", prompt: "ok?", approvers: [{ kind: "chain_owner" }], onApprove: { to: "a" }, onReject: { to: "$end" } }, agent("a", "a", { maxTraversals: 1 }));
    // a loops on itself and never ends, but the gate can end the run, so a path to $end exists.
    expect(text(chainGraphProblems(gateOut))).not.toContain("start: this chain can never finish");
  });

  describe("loops", () => {
    it("refuses a -> b -> a with no bound, naming a or b", () => {
      const def = design("a", agent("a", "b"), { ...agent("b", "a"), next: { kind: "branch", choices: [{ id: "again", description: "again", to: "a" }, { id: "stop", description: "stop", to: "$end" }] } });
      const problems = chainGraphProblems(def);
      expect(problems).toHaveLength(1);
      expect(problems[0]!.message).toMatch(/^(a|b) is in a loop with no limit; set maxTraversals on the edge that goes back$/);
      expect(problems[0]!.path).toMatch(/^steps\.[01]$/);
    });

    it("passes the same loop with maxTraversals: 3 on the edge back", () => {
      const def = design("a", agent("a", "b"), {
        ...agent("b", "a"),
        next: { kind: "branch", choices: [{ id: "again", description: "again", to: "a", maxTraversals: 3 }, { id: "stop", description: "stop", to: "$end" }] },
      });
      expect(chainGraphProblems(def)).toEqual([]);
    });

    it("names the step and index exactly", () => {
      const def = design("a", agent("a", "b"), { ...agent("b", "a"), next: { kind: "branch", choices: [{ id: "again", description: "again", to: "a" }, { id: "stop", description: "stop", to: "$end" }] } });
      expect(text(chainGraphProblems(def))).toEqual(["steps.0: a is in a loop with no limit; set maxTraversals on the edge that goes back"]);
    });

    it("refuses a self-loop branch choice without a bound and passes it with maxTraversals: 2", () => {
      const branch = (bound: number | undefined) =>
        design("a", {
          kind: "agent", id: "a", name: "a", agent: { agentId: "ticket-triage", version: "current" },
          next: { kind: "branch", choices: [{ id: "retry", description: "retry", to: "a", ...(bound === undefined ? {} : { maxTraversals: bound }) }, { id: "done", description: "done", to: "$end" }] },
        });
      expect(text(chainGraphProblems(branch(undefined)))).toEqual(["steps.0: a is in a loop with no limit; set maxTraversals on the edge that goes back"]);
      expect(chainGraphProblems(branch(2))).toEqual([]);
    });

    it("refuses a loop through a gate's rejection, and passes it when the rejection edge is bounded", () => {
      const withBound = (bound: number | undefined) =>
        design(
          "a",
          agent("a", "g"),
          { kind: "gate", id: "g", name: "g", prompt: "ok?", approvers: [{ kind: "chain_owner" }], onApprove: { to: "$end" }, onReject: { to: "a", ...(bound === undefined ? {} : { maxTraversals: bound }) } },
        );
      expect(text(chainGraphProblems(withBound(undefined)))).toHaveLength(1);
      expect(chainGraphProblems(withBound(1))).toEqual([]);
    });

    it("refuses a loop back through a gate's approval, and passes it when that edge is bounded", () => {
      const withBound = (bound: number | undefined) =>
        design(
          "g",
          { kind: "gate", id: "g", name: "g", prompt: "ok?", approvers: [{ kind: "chain_owner" }], onApprove: { to: "a", ...(bound === undefined ? {} : { maxTraversals: bound }) }, onReject: { to: "$end" } },
          agent("a", "g"),
        );
      expect(text(chainGraphProblems(withBound(undefined)))).toHaveLength(1);
      expect(chainGraphProblems(withBound(2))).toEqual([]);
    });

    it("treats a loop as bounded only when every cycle has a bounded edge", () => {
      // a <-> b is bounded; c <-> d is not; the problem must name c or d.
      const def = design(
        "a",
        { ...agent("a", "b"), next: { kind: "go", to: "b" } },
        { kind: "agent", id: "b", name: "b", agent: { agentId: "ticket-triage", version: "current" }, next: { kind: "branch", choices: [{ id: "back", description: "back", to: "a", maxTraversals: 2 }, { id: "on", description: "on", to: "c" }] } },
        agent("c", "d"),
        { ...agent("d", "c"), next: { kind: "branch", choices: [{ id: "back", description: "back", to: "c" }, { id: "stop", description: "stop", to: "$end" }] } },
      );
      const problems = text(chainGraphProblems(def));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^steps\.[23]: (c|d) is in a loop with no limit/);
    });

    it("names a step ON the cycle, not one that is only downstream of it", () => {
      // a -> b -> c -> b (unbounded), c -> d -> $end. d is left over by Kahn's algorithm but is not on a cycle, and it has the lowest index of the three.
      const def = design(
        "a",
        agent("a", "b"),
        agent("d", undefined),
        agent("b", "c"),
        { ...agent("c", "b"), next: { kind: "branch", choices: [{ id: "back", description: "back", to: "b" }, { id: "on", description: "on", to: "d" }] } },
      );
      const problems = chainGraphProblems(def);
      expect(problems).toHaveLength(1);
      expect(problems[0]!.message).toMatch(/^(b|c) is in a loop/);
      expect(problems[0]!.path).toMatch(/^steps\.[23]$/);
    });

    it("does not call two bounded edges in a row a loop and ignores edges to $end", () => {
      expect(chainGraphProblems(design("a", agent("a", "b"), agent("b", "$end")))).toEqual([]);
    });
  });

  describe("branch defaults and choices", () => {
    const branchStep = (choices: Array<{ id: string; to: string }>, defaultId?: string) => ({
      kind: "agent", id: "a", name: "a", agent: { agentId: "ticket-triage", version: "current" },
      next: { kind: "branch", ...(defaultId === undefined ? {} : { default: defaultId }), choices: choices.map((choice) => ({ ...choice, description: choice.id })) },
    });

    it("refuses a default that is not one of the choices", () => {
      expect(text(chainGraphProblems(design("a", branchStep([{ id: "x", to: "$end" }, { id: "y", to: "$end" }], "z"))))).toEqual(["steps.0.next.default: not one of this branch's choices"]);
    });

    it("accepts a default that is a choice, and a branch with no default", () => {
      expect(chainGraphProblems(design("a", branchStep([{ id: "x", to: "$end" }, { id: "y", to: "$end" }], "y")))).toEqual([]);
      expect(chainGraphProblems(design("a", branchStep([{ id: "x", to: "$end" }, { id: "y", to: "$end" }])))).toEqual([]);
    });

    it("refuses two choices with one id (the agent's pick would be ambiguous)", () => {
      expect(text(chainGraphProblems(design("a", branchStep([{ id: "x", to: "$end" }, { id: "x", to: "$end" }]))))).toEqual(["steps.0.next.choices.1.id: x is used by more than one choice"]);
    });
  });

  it("reports problems by the index of the step they are in", () => {
    const def = design("a", agent("a", "b"), agent("b", "c"), agent("c", "nowhere"));
    expect(text(chainGraphProblems(def))).toContain("steps.2.next.to: no step is called nowhere");
  });
});

describe("validateChainForPublish", () => {
  it("pins each built-in step to the newest release when the org has not chosen one, and does not write", async () => {
    const { validate, db } = setup();
    const result = await validate(INVESTIGATE_THEN_FIX);
    expect(result.problems).toEqual([]);
    const versions = result.pinned.steps.flatMap((step) => (step.kind === "agent" ? [[step.agent.agentId, step.agent.version]] : []));
    expect(versions).toEqual([
      ["root-cause-analyst", currentBuiltinVersion("root-cause-analyst")],
      ["rovara-code", builtinDefaultPin("rovara-code")],
      ["code-reviewer", currentBuiltinVersion("code-reviewer")],
    ]);
    expect(PinnedChainDefinitionSchema.safeParse(result.pinned).success).toBe(true);
    // Reading the org's pin must not create settings for the built-in.
    expect(db.get(builtinSettingsKey(ORG_A, "code-reviewer"))).toBeUndefined();
    expect(db.commandNames().filter((name) => name !== "GetCommand" && name !== "QueryCommand" && name !== "BatchGetCommand")).toEqual([]);
  });

  it("pins a built-in to the org's pinnedVersion when set, not to the newest release", async () => {
    const { validate, db, release } = setup();
    release.codeReviewer = 3;
    db.set({ ...builtinSettingsKey(ORG_A, "code-reviewer"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "x", updatedAt: "2026-10-20T00:00:00.000Z" });
    const result = await validate(INVESTIGATE_THEN_FIX);
    expect(result.problems).toEqual([]);
    const reviewer = result.pinned.steps.find((step) => step.id === "review");
    expect(reviewer).toMatchObject({ kind: "agent", agent: { agentId: "code-reviewer", version: 2 } });
    // And with no pin the newest release is 3.
    const other = setup();
    other.release.codeReviewer = 3;
    expect((await other.validate(INVESTIGATE_THEN_FIX)).pinned.steps.find((step) => step.id === "review")).toMatchObject({ agent: { version: 3 } });
  });

  it("does not change the definition it was given", async () => {
    const { validate } = setup();
    const input = structuredClone(INVESTIGATE_THEN_FIX);
    await validate(input);
    expect(input).toEqual(INVESTIGATE_THEN_FIX);
  });

  it("keeps the graph problems alongside the agent problems", async () => {
    const { validate } = setup();
    const result = await validate({ start: "nope", steps: [agent("a", undefined)] });
    expect(text(result.problems)).toEqual(["start: no step is called nope"]);
  });

  it("reports a built-in the org turned off as a problem of its step, and returns the revision of the guardrails it read", async () => {
    const { validate, store } = setup();
    expect((await validate(INVESTIGATE_THEN_FIX)).guardrailsRevision).toBe(0);
    const off = await store.putGuardrails({ ...({ orgId: ORG_A, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, disabledBuiltins: ["code-reviewer", "rovara-code"] }, expectedRevision: 0, by: ALICE }), by: fixtureActor(store, ORG_A, ALICE, true).developerId, actor: fixtureActor(store, ORG_A, ALICE, true) });
    const result = await validate(INVESTIGATE_THEN_FIX);
    expect(result.guardrailsRevision).toBe(off.revision);
    expect(text(result.problems)).toEqual([
      "steps.2.agent: Rovara Code is turned off in your company. Ask an admin to turn it on.",
      "steps.3.agent: Code reviewer is turned off in your company. Ask an admin to turn it on.",
    ]);
    // Nothing else is said about those steps, and the others are pinned as before.
    expect(result.pinned.steps[0]).toMatchObject({ agent: { agentId: "root-cause-analyst", version: currentBuiltinVersion("root-cause-analyst") } });
  });

  describe("custom agents", () => {
    /** A one-step chain on a custom agent at `version`. */
    const onAgent = (agentId: string, version: number | "current" = "current"): ChainDefinitionInput => ({
      start: "a",
      steps: [{ ...agent("a", undefined), agent: { agentId: agentId, version } }],
    });
    const publishAgain = async (ctx: ReturnType<typeof setup>, agentId: AgentId) => {
      const record = (await ctx.store.get(ORG_A, agentId))!;
      const draft = (await ctx.store.getDraft(ORG_A, agentId))!;
      await ctx.store.saveDraft({ orgId: ORG_A, agentId, overlay: { ...SCRATCH, instructions: `v${String(record.latestVersion + 1)}` }, expectedRevision: draft.revision, by: ALICE });
      return ctx.publish(agentId);
    };

    it("turns \"current\" into the agent's current version (3), and a later publish does not move the pinned value", async () => {
      const ctx = setup();
      const helper = await ctx.create("Helper");
      await ctx.publish(helper.agentId);
      await publishAgain(ctx, helper.agentId);
      await publishAgain(ctx, helper.agentId);
      const first = await ctx.validate(onAgent(helper.agentId));
      expect(first.problems).toEqual([]);
      expect(first.pinned.steps[0]).toMatchObject({ agent: { agentId: helper.agentId, version: 3 } });
      await publishAgain(ctx, helper.agentId);
      expect((await ctx.store.get(ORG_A, helper.agentId))!.currentVersion).toBe(4);
      expect(first.pinned.steps[0]).toMatchObject({ agent: { version: 3 } });
      expect((await ctx.validate(onAgent(helper.agentId))).pinned.steps[0]).toMatchObject({ agent: { version: 4 } });
    });

    it("keeps an older version a person named, if it exists, whatever the agent's current version is", async () => {
      const ctx = setup();
      const helper = await ctx.create("Helper");
      await ctx.publish(helper.agentId);
      await publishAgain(ctx, helper.agentId);
      const result = await ctx.validate(onAgent(helper.agentId, 1));
      expect(result.problems).toEqual([]);
      expect(result.pinned.steps[0]).toMatchObject({ agent: { version: 1 } });
    });

    it("refuses a pinned number that does not exist, at steps.<i>.agent.version", async () => {
      const ctx = setup();
      const helper = await ctx.create("Helper");
      await ctx.publish(helper.agentId);
      expect(text((await ctx.validate(onAgent(helper.agentId, 9))).problems)).toEqual(["steps.0.agent.version: Helper has no version 9"]);
    });

    it("refuses an agent with no published version", async () => {
      const ctx = setup();
      const helper = await ctx.create("Helper");
      expect(text((await ctx.validate(onAgent(helper.agentId))).problems)).toEqual(["steps.0.agent: Helper has no published version"]);
    });

    it("refuses an archived agent", async () => {
      const ctx = setup();
      const helper = await ctx.create("Helper");
      await ctx.publish(helper.agentId);
      await ctx.store.archive(ORG_A, helper.agentId, ALICE, undefined, { actor: fixtureActor(ctx.store, ORG_A, ALICE) });
      expect(text((await ctx.validate(onAgent(helper.agentId))).problems)).toEqual(["steps.0.agent: Helper is archived"]);
      expect(text((await ctx.validate(onAgent(helper.agentId, 1))).problems)).toEqual(["steps.0.agent: Helper is archived"]);
    });

    it("says only \"unknown agent\" for another org's agent, an agent that does not exist, and one the caller cannot see", async () => {
      const ctx = setup();
      const foreign = await ctx.create("Foreign", SCRATCH, { orgId: ORG_B, owner: STRANGER });
      await ctx.publish(foreign.agentId, ORG_B);
      const private_ = await ctx.create("Bobs", SCRATCH, { owner: BOB });
      await ctx.publish(private_.agentId);
      for (const id of [foreign.agentId, "agt_zzzzzzzzzzzzzzzzzzzz", private_.agentId]) {
        const result = await ctx.validate(onAgent(id, 1));
        expect(result.problems).toEqual([{ path: "steps.0.agent", message: "unknown agent" }]);
      }
      // An agent id that shows nothing about the other org: the message is the same whatever the id.
      expect(text((await ctx.validate(onAgent(foreign.agentId))).problems)).toEqual(["steps.0.agent: unknown agent"]);
    });

    it("refuses an agent the caller can see but not use, with Plan 3's own words", async () => {
      const ctx = setup();
      const helper = await ctx.create("Helper", SCRATCH, { owner: BOB });
      await ctx.publish(helper.agentId);
      await ctx.store.replaceShares({ orgId: ORG_A, agentId: helper.agentId, upsert: [{ principal: { kind: "member", developerId: ALICE }, level: "view" }], remove: [], expectedSharesRevision: 0, by: BOB });
      const result = await ctx.validate(onAgent(helper.agentId));
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]!.path).toBe("steps.0.agent");
      expect(result.problems[0]!.message).toMatch(/^You can view Helper; use needs /);
    });

    it("reports a base the agent builds on being archived, as Plan 3 words it", async () => {
      const ctx = setup();
      const base = await ctx.create("Base");
      await ctx.publish(base.agentId);
      const child = await ctx.create("Child", { instructions: "x" }, { extends: base.agentId });
      await ctx.publish(child.agentId);
      await ctx.store.archive(ORG_A, base.agentId, ALICE, undefined, { actor: fixtureActor(ctx.store, ORG_A, ALICE) });
      expect(text((await ctx.validate(onAgent(child.agentId))).problems)).toEqual(["steps.0.agent: Child builds on Base, which is archived. Ask Child's owner to pick another base."]);
    });

    it("prefixes the org's guardrail problems with steps.<i>.agent.", async () => {
      const ctx = setup();
      const helper = await ctx.create("Helper", UNSERVED_MODEL);
      await ctx.publish(helper.agentId);
      const result = await ctx.validate({ start: "x", steps: [agent("x", "a"), { ...agent("a", undefined), agent: { agentId: helper.agentId, version: "current" } }] });
      expect(result.problems).toEqual([
        { path: "steps.1.agent.steps.0.settings.model", message: expect.stringContaining("gpt-not-served") as string },
      ]);
    });

    it("reports each step's problems at its own index and still pins the steps that are fine", async () => {
      const ctx = setup();
      const good = await ctx.create("Good");
      await ctx.publish(good.agentId);
      const result = await ctx.validate({
        start: "a",
        steps: [{ ...agent("a", "b"), agent: { agentId: good.agentId, version: "current" } }, { ...agent("b", "c"), agent: { agentId: "agt_zzzzzzzzzzzzzzzzzzzz", version: "current" } }, agent("c", undefined)],
      });
      expect(text(result.problems)).toEqual(["steps.1.agent: unknown agent"]);
      expect(result.pinned.steps[0]).toMatchObject({ agent: { version: 1 } });
      expect(result.pinned.steps[2]).toMatchObject({ agent: { agentId: "ticket-triage", version: currentBuiltinVersion("ticket-triage") } });
    });

    it("refuses to run for a caller of another org than the one it was asked about", async () => {
      const ctx = setup();
      await expect(validateChainForPublish(ctx.deps, caller(ALICE, ORG_A), ORG_B, ChainDefinitionSchema.parse(INVESTIGATE_THEN_FIX))).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("built-in versions a person names", () => {
    const onBuiltin = (version: number): ChainDefinitionInput => ({ start: "a", steps: [{ ...agent("a", undefined), agent: { agentId: "code-reviewer", version } }] });

    it("keeps a release at or below the org's pin", async () => {
      const ctx = setup();
      ctx.release.codeReviewer = 3;
      ctx.db.set({ ...builtinSettingsKey(ORG_A, "code-reviewer"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "x", updatedAt: "2026-10-20T00:00:00.000Z" });
      expect((await ctx.validate(onBuiltin(1))).pinned.steps[0]).toMatchObject({ agent: { version: 1 } });
      expect((await ctx.validate(onBuiltin(2))).problems).toEqual([]);
    });

    it("refuses a release above the org's pin until an admin adopts it, as a run would", async () => {
      const ctx = setup();
      ctx.release.codeReviewer = 3;
      ctx.db.set({ ...builtinSettingsKey(ORG_A, "code-reviewer"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "x", updatedAt: "2026-10-20T00:00:00.000Z" });
      expect(text((await ctx.validate(onBuiltin(3))).problems)).toEqual(["steps.0.agent.version: Code reviewer version 3 hasn't been adopted by your company yet"]);
    });

    it("refuses a release that does not exist", async () => {
      const ctx = setup();
      expect(text((await ctx.validate(onBuiltin(7))).problems)).toEqual(["steps.0.agent.version: Code reviewer has no version 7"]);
    });
  });

  describe("branches after a coding agent", () => {
    const branchAfter = (agentId: string, version: number | "current" = "current"): ChainDefinitionInput => ({
      start: "a",
      steps: [
        {
          kind: "agent", id: "a", name: "a", agent: { agentId: agentId, version },
          next: { kind: "branch", choices: [{ id: "x", description: "x", to: "$end" }, { id: "y", description: "y", to: "$end" }] },
        },
      ],
    });
    const CODING = "steps.0.next: a coding agent can't choose a branch; add a step after it to decide";

    it("refuses a branch after the rovara-code step, with the exact text", async () => {
      const { validate } = setup();
      expect(text((await validate(branchAfter("rovara-code"))).problems)).toEqual([CODING]);
    });

    it("refuses it after a custom agent built on rovara-code, and accepts it after an agent-step agent", async () => {
      const ctx = setup();
      const coder = await ctx.create("Coder", { instructions: "x" }, { extends: "rovara-code" });
      await ctx.publish(coder.agentId);
      const plain = await ctx.create("Plain");
      await ctx.publish(plain.agentId);
      expect(text((await ctx.validate(branchAfter(coder.agentId))).problems)).toEqual([CODING]);
      expect((await ctx.validate(branchAfter(plain.agentId))).problems).toEqual([]);
      expect((await ctx.validate(branchAfter("root-cause-analyst"))).problems).toEqual([]);
    });

    it("lets a coding agent go on to the next step with a plain edge", async () => {
      const { validate } = setup();
      expect((await validate({ start: "a", steps: [{ ...agent("a", undefined), agent: { agentId: "rovara-code", version: "current" } }] })).problems).toEqual([]);
    });
  });
});

describe("autonomousTriggerProblems", () => {
  const pinnedOf = (def: ChainDefinitionInput): PinnedChainDefinition => {
    const parsed = ChainDefinitionSchema.parse(def);
    return PinnedChainDefinitionSchema.parse({ ...parsed, steps: parsed.steps.map((step) => (step.kind === "agent" ? { ...step, agent: { ...step.agent, version: 1 } } : step)) });
  };
  const RUN_LIMIT = "limits.maxRunUsd: set a run limit and a monthly budget before adding an event or schedule trigger";
  const gate = (approvers: ApproverRule[], id = "g"): unknown => ({
    kind: "gate", id, name: id, prompt: "ok?", approvers, onApprove: { to: "$end" }, onReject: { to: "$end" },
  });
  const withGate = (...gates: unknown[]): ChainDefinitionInput => ({ start: "a", steps: [agent("a", "g"), ...(gates as never[])], limits: { maxRunUsd: 5 } });

  it("passes INVESTIGATE_THEN_FIX with a monthly budget (its gate also lists project maintainers)", () => {
    expect(autonomousTriggerProblems({ monthlyBudgetUsd: 100, pinned: pinnedOf(INVESTIGATE_THEN_FIX) })).toEqual([]);
  });

  it("asks for a monthly budget", () => {
    const pinned = pinnedOf(INVESTIGATE_THEN_FIX);
    expect(text(autonomousTriggerProblems({ pinned }))).toEqual([RUN_LIMIT]);
    expect(text(autonomousTriggerProblems({ monthlyBudgetUsd: 0, pinned }))).toEqual([RUN_LIMIT]);
  });

  it("asks for a run limit, and reports the limit problem once when both are missing", () => {
    const unlimited: ChainDefinitionInput = { ...INVESTIGATE_THEN_FIX };
    delete unlimited.limits;
    const pinned = pinnedOf(unlimited);
    expect(text(autonomousTriggerProblems({ monthlyBudgetUsd: 100, pinned }))).toEqual([RUN_LIMIT]);
    expect(text(autonomousTriggerProblems({ pinned }))).toEqual([RUN_LIMIT]);
    const emptyLimits = pinnedOf({ ...INVESTIGATE_THEN_FIX, limits: { maxRunHours: 4 } });
    expect(text(autonomousTriggerProblems({ monthlyBudgetUsd: 100, pinned: emptyLimits }))).toEqual([RUN_LIMIT]);
  });

  it("refuses a gate that only the starter can decide, naming the step", () => {
    const pinned = pinnedOf(withGate(gate([{ kind: "starter" }])));
    expect(text(autonomousTriggerProblems({ monthlyBudgetUsd: 10, pinned }))).toEqual([
      "steps.1.approvers: no one starts an event or schedule run, so add project maintainers, the chain owner or named people",
    ]);
    // Two starter rules are still only the starter.
    expect(autonomousTriggerProblems({ monthlyBudgetUsd: 10, pinned: pinnedOf(withGate(gate([{ kind: "starter" }, { kind: "starter" }]))) })).toHaveLength(1);
  });

  it("passes a gate with any other rule beside starter", () => {
    const others: ApproverRule[] = [{ kind: "project_maintainers" }, { kind: "chain_owner" }, { kind: "members", developerIds: [ALICE] }];
    for (const rule of others) {
      expect(autonomousTriggerProblems({ monthlyBudgetUsd: 10, pinned: pinnedOf(withGate(gate([{ kind: "starter" }, rule]))) })).toEqual([]);
      expect(autonomousTriggerProblems({ monthlyBudgetUsd: 10, pinned: pinnedOf(withGate(gate([rule]))) })).toEqual([]);
    }
  });

  it("reports every starter-only gate and the limits problem together, limits first", () => {
    const pinned = pinnedOf({ start: "a", steps: [agent("a", "g1"), { ...(gate([{ kind: "starter" }], "g1") as object), onApprove: { to: "g2" } }, gate([{ kind: "starter" }], "g2")] as never });
    expect(text(autonomousTriggerProblems({ pinned }))).toEqual([
      RUN_LIMIT,
      "steps.1.approvers: no one starts an event or schedule run, so add project maintainers, the chain owner or named people",
      "steps.2.approvers: no one starts an event or schedule run, so add project maintainers, the chain owner or named people",
    ]);
  });
});
