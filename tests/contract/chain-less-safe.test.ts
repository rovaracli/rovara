// Plan 4 Task 4: what makes a new version of a chain less safe than the one that runs (human decision N6), and the gates every path to a step passes.
import { describe, expect, it } from "vitest";
import { chainLessSafeChanges, gatesOnEveryPath, type ChainLessSafeLookups } from "../../packages/broker/src/chains/less-safe.js";
import { ChainDefinitionSchema, PinnedChainDefinitionSchema, type ChainDefinitionInput, type PinnedChainDefinition } from "@rovara-code/contracts";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";

/** The example with every agent pinned to version 1. */
function pinned(definition: ChainDefinitionInput = INVESTIGATE_THEN_FIX): PinnedChainDefinition {
  const parsed = ChainDefinitionSchema.parse(definition);
  return PinnedChainDefinitionSchema.parse({ ...parsed, steps: parsed.steps.map((step) => (step.kind === "agent" ? { ...step, agent: { ...step.agent, version: 1 } } : step)) });
}

const NAMES: Record<string, string> = { "root-cause-analyst": "Root-cause analyst", "rovara-code": "Rovara Code", "code-reviewer": "Code reviewer", "agt_00000000000000000001": "Helper" };
const lookups = (findings: string[] = []): ChainLessSafeLookups & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    agentName: (agentId) => NAMES[agentId] ?? agentId,
    repinFindings: (agentId, from, to) => { asked.push(`${agentId} ${String(from)}->${String(to)}`); return findings; },
  };
};

type Step = ChainDefinitionInput["steps"][number];
/** The example with some steps replaced by id (an unmatched replacement is appended). */
function variant(changes: Record<string, Partial<Step> | Step>, extra: Step[] = [], tweak: Partial<ChainDefinitionInput> = {}): PinnedChainDefinition {
  const steps = INVESTIGATE_THEN_FIX.steps.map((step) => (changes[step.id] === undefined ? step : ({ ...step, ...changes[step.id] } as Step)));
  return pinned({ ...INVESTIGATE_THEN_FIX, ...tweak, steps: [...steps, ...extra] });
}
const changes = (next: PinnedChainDefinition, find = lookups()) => chainLessSafeChanges(pinned(), next, find);
const FIX_DIRECT: Extract<Step, { kind: "agent" }>["next"] = { kind: "branch", default: "no_fix", choices: [{ id: "fix", description: "The cause is in our code and a code change fixes it", to: "fix" }, { id: "no_fix", description: "Not a code problem, or not enough evidence", to: "$end" }] };
/** The example without its gate: the investigation hands straight to the fix. */
const withoutGate = (): PinnedChainDefinition => pinned({ ...INVESTIGATE_THEN_FIX, steps: INVESTIGATE_THEN_FIX.steps.filter((step) => step.id !== "approve_fix").map((step) => (step.id === "investigate" ? { ...step, next: FIX_DIRECT } : step)) });
/** The same design with one agent step pinned to another version. */
function repinned(stepId: string, version: number): PinnedChainDefinition {
  const base = pinned();
  return { ...base, steps: base.steps.map((step) => (step.kind === "agent" && step.id === stepId ? { ...step, agent: { ...step.agent, version } } : step)) };
}

describe("chainLessSafeChanges", () => {
  it("has nothing to compare for a first publish, and finds nothing in an unchanged design", async () => {
    expect(await chainLessSafeChanges(undefined, pinned(), lookups())).toEqual([]);
    expect(await changes(pinned())).toEqual([]);
  });

  it("calls edits that take nothing away safe: instructions, a lower run limit, narrower approvers, a lower retry count", async () => {
    expect(await changes(variant({ fix: { instructions: "Fix it, and say what you changed." } }))).toEqual([]);
    expect(await changes(variant({}, [], { limits: { maxRunUsd: 10 } }))).toEqual([]);
    expect(await changes(variant({ approve_fix: { approvers: [{ kind: "project_maintainers" }] } }))).toEqual([]);
    expect(await changes(variant({ approve_fix: { approvers: [{ kind: "starter" }] } }))).toEqual([]);
    expect(await changes(variant({ fix: { retries: 0, timeoutMinutes: 30 } }))).toEqual([]);
    // Naming a run limit where there was none is lower, not higher.
    const unlimited = { ...INVESTIGATE_THEN_FIX, limits: {} };
    expect(await chainLessSafeChanges(pinned(unlimited), pinned(), lookups())).toEqual([]);
  });

  describe("gates", () => {
    it("removes a gate", async () => {
      expect(await changes(withoutGate())).toEqual(['removes the gate "approve_fix"']);
    });

    it("lengthens a gate's wait, counting an unset wait as 72 hours", async () => {
      expect(await changes(variant({ approve_fix: { timeoutHours: 168 } }))).toEqual(["approve_fix may now wait 168 hours"]);
      expect(await changes(variant({ approve_fix: { timeoutHours: 72 } }))).toEqual([]);
      expect(await changes(variant({ approve_fix: { timeoutHours: 24 } }))).toEqual([]);
    });

    it("lets a rejection carry on where it used to stop the run", async () => {
      expect(await changes(variant({ approve_fix: { onReject: { to: "fix" } } }))).toEqual([
        "a rejection at approve_fix now carries on to fix", 'fix can now be reached without passing "approve_fix"', 'review can now be reached without passing "approve_fix"',
      ]);
      // Moving a rejection to a step that was behind no gate, or to the end, is not new; moving it behind the gate is.
      const before = variant({ approve_fix: { onReject: { to: "review" } } });
      expect(await chainLessSafeChanges(before, variant({ approve_fix: { onReject: { to: "fix" } } }), lookups())).toEqual(['fix can now be reached without passing "approve_fix"']);
      expect(await chainLessSafeChanges(before, pinned(), lookups())).toEqual([]);
    });

    it("widens who may decide a gate: a kind added, or more named people", async () => {
      expect(await changes(variant({ approve_fix: { approvers: [{ kind: "starter" }, { kind: "project_maintainers" }, { kind: "chain_owner" }] } }))).toEqual(["approve_fix can now be decided by the chain's owner"]);
      expect(await changes(variant({ approve_fix: { approvers: [{ kind: "starter" }, { kind: "project_maintainers" }, { kind: "members", developerIds: ["a".repeat(64)] }] } }))).toEqual(["approve_fix can now be decided by named people"]);
      // Replacing the starter with a wider rule is a kind added.
      expect(await changes(variant({ approve_fix: { approvers: [{ kind: "project_maintainers" }, { kind: "chain_owner" }] } }))).toEqual(["approve_fix can now be decided by the chain's owner"]);
      const named = (ids: string[]) => variant({ approve_fix: { approvers: [{ kind: "members", developerIds: ids }] } });
      expect(await chainLessSafeChanges(named(["a".repeat(64)]), named(["a".repeat(64), "b".repeat(64)]), lookups())).toEqual(["approve_fix can now be decided by more named people"]);
      expect(await chainLessSafeChanges(named(["a".repeat(64), "b".repeat(64)]), named(["b".repeat(64)]), lookups())).toEqual([]);
      expect(await chainLessSafeChanges(named(["a".repeat(64)]), named(["b".repeat(64)]), lookups())).toEqual(["approve_fix can now be decided by more named people"]);
    });
  });

  describe("limits", () => {
    it("raises or removes the dollar limit of a run", async () => {
      expect(await changes(variant({}, [], { limits: { maxRunUsd: 60 } }))).toEqual(["raises the most one run may cost, from $30 to $60"]);
      expect(await changes(variant({}, [], { limits: {} }))).toEqual(["removes the limit on what one run may cost (it was $30)"]);
      expect(await changes(variant({}, [], { limits: { maxRunUsd: 30 } }))).toEqual([]);
    });

    it("raises or removes the time limit of a run", async () => {
      const hours = (maxRunHours: number | undefined) => chainLessSafeChanges(pinned({ ...INVESTIGATE_THEN_FIX, limits: { maxRunUsd: 30, ...(maxRunHours === undefined ? {} : { maxRunHours }) } }), pinned({ ...INVESTIGATE_THEN_FIX, limits: { maxRunUsd: 30, maxRunHours: 48 } }), lookups());
      expect(await hours(24)).toEqual(["raises the longest one run may take, from 24 to 48 hours"]);
      expect(await hours(48)).toEqual([]);
      expect(await hours(72)).toEqual([]);
      // No limit set is the 168 hours every run is held to, so naming one is lower.
      expect(await hours(undefined)).toEqual([]);
      expect(await chainLessSafeChanges(pinned({ ...INVESTIGATE_THEN_FIX, limits: { maxRunUsd: 30, maxRunHours: 48 } }), pinned(), lookups())).toEqual(["removes the limit on how long one run may take (it was 48 hours)"]);
    });
  });

  describe("loops", () => {
    // review sends the run back to fix, which hands on to review again.
    const loop = (bound: number | undefined, extra: Partial<Step> = {}): PinnedChainDefinition => variant({
      review: { next: { kind: "branch", choices: [{ id: "again", description: "The change needs work", to: "fix", ...(bound === undefined ? {} : { maxTraversals: bound }) }, { id: "done", description: "Good to go", to: "$end" }] }, ...extra },
    });

    it("raises the bound of a loop edge", async () => {
      expect(await chainLessSafeChanges(loop(2), loop(4), lookups())).toEqual(["review may now go back to fix up to 4 times, up from 2"]);
      expect(await chainLessSafeChanges(loop(4), loop(2), lookups())).toEqual([]);
      expect(await chainLessSafeChanges(loop(2), loop(2), lookups())).toEqual([]);
    });

    it("adds a bounded back edge where there was no loop, and takes a bound off", async () => {
      expect(await changes(loop(3))).toEqual(["review can now go back to fix, up to 3 times"]);
      expect(await chainLessSafeChanges(loop(3), loop(undefined), lookups())).toEqual(["review may now go back to fix with no limit"]);
    });

    it("counts the bound on a gate's edges too", async () => {
      const withBound = (bound: number) => variant({ approve_fix: { onApprove: { to: "fix", maxTraversals: bound } } });
      expect(await chainLessSafeChanges(withBound(1), withBound(3), lookups())).toEqual(["approve_fix may now go back to fix up to 3 times, up from 1"]);
    });
  });

  describe("reaching a step without passing a gate", () => {
    const skipping = variant({
      investigate: { next: { kind: "branch", default: "no_fix", choices: [{ id: "fix", description: "The cause is in our code and a code change fixes it", to: "approve_fix" }, { id: "no_fix", description: "Not a code problem", to: "$end" }, { id: "quick", description: "Obvious fix", to: "fix" }] } },
    });

    it("names a step a new edge reaches around a gate", async () => {
      expect(await changes(skipping)).toEqual(['fix can now be reached without passing "approve_fix"', 'review can now be reached without passing "approve_fix"']);
    });

    it("counts a gate's rejection edge as a way around the next gate", async () => {
      const two = (rejectTo: string): PinnedChainDefinition => pinned({
        start: "a",
        steps: [
          { kind: "agent", id: "a", name: "a", agent: { agentId: "ticket-triage", version: "current" }, next: { kind: "go", to: "g1" } },
          { kind: "gate", id: "g1", name: "g1", prompt: "First?", approvers: [{ kind: "chain_owner" }], onApprove: { to: "g2" }, onReject: { to: rejectTo } },
          { kind: "gate", id: "g2", name: "g2", prompt: "Second?", approvers: [{ kind: "chain_owner" }], onApprove: { to: "b" }, onReject: { to: "$end" } },
          { kind: "agent", id: "b", name: "b", agent: { agentId: "ticket-triage", version: "current" }, next: { kind: "end" } },
        ],
      });
      // A rejection is not an approval: b is now reached around g1 as well as around g2.
      expect(await chainLessSafeChanges(two("$end"), two("b"), lookups())).toEqual(["a rejection at g1 now carries on to b", 'b can now be reached without passing "g1"', 'b can now be reached without passing "g2"']);
    });

    it("counts a rejection sent to a step behind the gate as a way around it, whatever the rejection led to before", async () => {
      // "Send it back": a rejection used to go back to investigate, and now goes straight to fix, which only an approval used to reach.
      const rejectTo = (to: string) => variant({ approve_fix: { onReject: { to, maxTraversals: 2 } } });
      expect(await chainLessSafeChanges(rejectTo("investigate"), rejectTo("fix"), lookups())).toEqual(['fix can now be reached without passing "approve_fix"', 'review can now be reached without passing "approve_fix"']);
      // A rejection that goes back to an earlier step, or to a step that is behind no gate, is not.
      expect(await chainLessSafeChanges(rejectTo("fix"), rejectTo("investigate"), lookups())).toEqual([]);
    });

    it("says nothing about a gate that is gone (the removal says it), or a step that was never behind it", async () => {
      expect(await chainLessSafeChanges(pinned(), withoutGate(), lookups())).toEqual(['removes the gate "approve_fix"']);
      expect(await chainLessSafeChanges(skipping, pinned(), lookups())).toEqual([]);
    });
  });

  describe("agent steps", () => {
    const deploy: Step = { kind: "agent", id: "deploy", name: "Deploy", agent: { agentId: "code-reviewer", version: "current" }, next: { kind: "end" } };

    it("adds a step that has no counterpart, naming the agent and its version", async () => {
      const next = variant({ review: { next: { kind: "go", to: "deploy" } } }, [deploy]);
      expect(await changes(next)).toEqual(["adds step deploy (Code reviewer version 1)"]);
    });

    it("calls a different agent less safe, and never asks what its recipe would add", async () => {
      const find = lookups(["should not be asked"]);
      const next = variant({ review: { agent: { agentId: "agt_00000000000000000001", version: "current" } } });
      expect(await changes(next, find)).toEqual(["review now uses Helper version 1 instead of Code reviewer version 1"]);
      expect(find.asked).toEqual([]);
    });

    it("calls a new version of the same agent less safe only when its recipe gains something", async () => {
      const next = repinned("fix", 2);
      const safe = lookups([]);
      expect(await changes(next, safe)).toEqual([]);
      expect(safe.asked).toEqual(["rovara-code 1->2"]);
      const unsafe = lookups(["Lets the agent change things in every linear connector (read and write)"]);
      expect(await changes(next, unsafe)).toEqual([
        "fix now uses Rovara Code version 2 instead of Rovara Code version 1",
        "fix: Lets the agent change things in every linear connector (read and write)",
      ]);
      // Going back to an older version is compared the same way.
      const down = lookups([]);
      expect(await chainLessSafeChanges(next, pinned(), down)).toEqual([]);
      expect(down.asked).toEqual(["rovara-code 2->1"]);
    });

    it("raises retries and timeouts, counting an unset retry as 0 and an unset timeout as 120 minutes", async () => {
      expect(await changes(variant({ fix: { retries: 2 } }))).toEqual(["fix may now retry 2 times"]);
      expect(await changes(variant({ fix: { timeoutMinutes: 600 } }))).toEqual(["fix may now run 600 minutes"]);
      expect(await changes(variant({ fix: { retries: 0, timeoutMinutes: 120 } }))).toEqual([]);
      expect(await changes(variant({ fix: { retries: 1, timeoutMinutes: 200 } }))).toEqual(["fix may now retry 1 times", "fix may now run 200 minutes"]);
      const before = variant({ fix: { retries: 2, timeoutMinutes: 600 } });
      expect(await chainLessSafeChanges(before, pinned(), lookups())).toEqual([]);
    });

    it("widens what a step receives from the previous report to every report", async () => {
      expect(await changes(variant({ fix: { handoff: "all" } }))).toEqual(["fix now receives every earlier report"]);
      expect(await changes(variant({ fix: { handoff: "previous" } }))).toEqual([]);
      expect(await chainLessSafeChanges(variant({ fix: { handoff: "all" } }), pinned(), lookups())).toEqual([]);
    });
  });

  it("lists every change, each in its own words", async () => {
    const next = variant({ fix: { retries: 2, handoff: "all" } }, [], { limits: { maxRunUsd: 60 } });
    expect(await changes(next)).toEqual(["raises the most one run may cost, from $30 to $60", "fix may now retry 2 times", "fix now receives every earlier report"]);
  });
});

describe("gatesOnEveryPath", () => {
  it("passes a gate only through its approval: a step its rejection reaches is not behind it", () => {
    const def = variant({ approve_fix: { onReject: { to: "fix", maxTraversals: 2 } } });
    expect(gatesOnEveryPath(def, "fix")).toEqual([]);
    expect(gatesOnEveryPath(def, "review")).toEqual([]);
    expect(gatesOnEveryPath(variant({ approve_fix: { onReject: { to: "investigate", maxTraversals: 2 } } }), "fix")).toEqual(["approve_fix"]);
  });

  const design = (definition: ChainDefinitionInput = INVESTIGATE_THEN_FIX) => ChainDefinitionSchema.parse(definition);

  it("names the gates every path from the start to a step passes", () => {
    const def = design();
    expect(gatesOnEveryPath(def, "investigate")).toEqual([]);
    expect(gatesOnEveryPath(def, "fix")).toEqual(["approve_fix"]);
    expect(gatesOnEveryPath(def, "review")).toEqual(["approve_fix"]);
    // A gate is not behind itself.
    expect(gatesOnEveryPath(def, "approve_fix")).toEqual([]);
  });

  it("drops a gate once a path goes around it", () => {
    const around = design({ ...INVESTIGATE_THEN_FIX, steps: INVESTIGATE_THEN_FIX.steps.map((step) => (step.id === "investigate" ? { ...step, next: { kind: "branch", choices: [{ id: "fix", description: "Fix", to: "approve_fix" }, { id: "quick", description: "Quick", to: "fix" }] } } as Step : step)) });
    expect(gatesOnEveryPath(around, "fix")).toEqual([]);
    expect(gatesOnEveryPath(around, "review")).toEqual([]);
  });

  it("treats a start that is a gate as passed by every step, and ignores steps nothing reaches", () => {
    const gateFirst = design({
      start: "g",
      steps: [
        { kind: "gate", id: "g", name: "g", prompt: "Go on?", approvers: [{ kind: "chain_owner" }], onApprove: { to: "a" }, onReject: { to: "$end" } },
        { kind: "agent", id: "a", name: "a", agent: { agentId: "ticket-triage", version: "current" }, next: { kind: "end" } },
        { kind: "agent", id: "lonely", name: "lonely", agent: { agentId: "ticket-triage", version: "current" }, next: { kind: "go", to: "a" } },
      ],
    });
    expect(gatesOnEveryPath(gateFirst, "a")).toEqual(["g"]);
    expect(gatesOnEveryPath(gateFirst, "lonely")).toEqual([]);
  });

  it("lists several gates in the order of the design, and an unknown step has none", () => {
    const two = design({
      start: "a",
      steps: [
        { kind: "agent", id: "a", name: "a", agent: { agentId: "ticket-triage", version: "current" }, next: { kind: "go", to: "g2" } },
        { kind: "gate", id: "g2", name: "g2", prompt: "Second?", approvers: [{ kind: "chain_owner" }], onApprove: { to: "g1" }, onReject: { to: "$end" } },
        { kind: "gate", id: "g1", name: "g1", prompt: "First?", approvers: [{ kind: "chain_owner" }], onApprove: { to: "b" }, onReject: { to: "$end" } },
        { kind: "agent", id: "b", name: "b", agent: { agentId: "ticket-triage", version: "current" }, next: { kind: "end" } },
      ],
    });
    expect(gatesOnEveryPath(two, "b")).toEqual(["g2", "g1"]);
    expect(gatesOnEveryPath(two, "nope")).toEqual([]);
  });
});
