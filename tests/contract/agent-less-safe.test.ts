// Plan 3 Task 7: which changes to a recipe wait for a person on the confirmation page (human decision 2026-10-20, R9-1, R9-2).
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "@rovara-code/contracts";
import { EMPTY_RECIPE, type ResolvedRecipe, type ResolvedStep, type ToolGrant } from "@rovara-code/contracts";
import { lessSafeChanges } from "../../packages/broker/src/agents/less-safe.js";

const settings = (extra: Record<string, unknown> = {}) => ({ instructions: [], ...extra });
const agentStep = (id: string, workspace: "none" | "read" = "none", tools?: string[]): ResolvedStep => ({
  id, name: id.toUpperCase(), kind: "agent", workspace, settings: settings(tools === undefined ? {} : { tools }),
});
const approvalStep = (id = "gate"): ResolvedStep => ({ id, name: "Gate", kind: "approval", prompt: "OK to go on?", settings: settings() });
const reviewStep = (reviewers: Array<"code" | "security">, maxRounds?: number, id = "review"): ResolvedStep => ({
  id, name: "Review", kind: "review", reviewers, ...(maxRounds === undefined ? {} : { onFindings: { backTo: "build", maxRounds } }), settings: settings(),
});
const codingStep = (id: string, kind: "plan" | "build" | "check" | "pull_request"): ResolvedStep => ({ id, name: id, kind, settings: settings() });
const recipe = (overrides: Partial<ResolvedRecipe> = {}): ResolvedRecipe => ({ ...structuredClone(EMPTY_RECIPE), steps: [agentStep("work")], ...overrides });
const grant = (connector: ToolGrant["connector"], access: ToolGrant["access"] = "read", tools?: string[]): ToolGrant => ({ connector, access, ...(tools === undefined ? {} : { tools }) });

describe("lessSafeChanges", () => {
  it("lists nothing when nothing changes, or when only instructions change", () => {
    const base = recipe({ tools: [grant({ type: "linear" })] });
    expect(lessSafeChanges(base, structuredClone(base))).toEqual([]);
    const edited = structuredClone(base);
    edited.instructions = [{ agentName: "A", text: "Be more careful." }];
    edited.steps = [{ ...agentStep("work"), name: "Renamed" }];
    expect(lessSafeChanges(base, edited)).toEqual([]);
  });

  it("lists nothing for a change that only tightens", () => {
    const current = recipe({
      steps: [agentStep("a", "read", ["x_*", "y_*"]), approvalStep()],
      tools: [grant({ type: "linear" }, "read_write", ["a_*", "b_*"]), grant({ name: "docs" })],
      approvals: { alwaysAsk: ["create_*"] },
      autonomy: "run",
      allowMentions: true,
    });
    const next = recipe({
      steps: [agentStep("a", "none", ["x_*"]), approvalStep()],
      tools: [grant({ type: "linear" }, "read", ["a_*"])],
      approvals: { alwaysAsk: ["create_*", "delete_*"] },
      autonomy: "suggest",
      allowMentions: false,
    });
    expect(lessSafeChanges(current, next)).toEqual([]);
  });

  it("treats a first publish with nothing to compare against as a change from the empty recipe", () => {
    expect(lessSafeChanges(undefined, recipe())).toEqual([]);
    expect(lessSafeChanges(undefined, recipe({ autonomy: "run" }))).toEqual(["Raises the agent's autonomy from prepare to run"]);
  });

  it("flags a removed approval step and a later one", () => {
    const current = recipe({ steps: [agentStep("a"), approvalStep(), agentStep("b")] });
    expect(lessSafeChanges(current, recipe({ steps: [agentStep("a"), agentStep("b")] }))).toEqual(['Removes the approval step "Gate"']);
    expect(lessSafeChanges(current, recipe({ steps: [agentStep("a"), agentStep("b"), approvalStep()] }))).toEqual(['Moves the approval step "Gate" later, so more happens before it']);
    // Earlier, or the same place after a step is added after it, is no weaker.
    expect(lessSafeChanges(current, recipe({ steps: [approvalStep(), agentStep("a"), agentStep("b")] }))).toEqual([]);
    expect(lessSafeChanges(current, recipe({ steps: [agentStep("a"), approvalStep(), agentStep("b"), agentStep("c")] }))).toEqual([]);
    // A step added before the gate means more happens before it.
    expect(lessSafeChanges(current, recipe({ steps: [agentStep("a"), agentStep("n"), approvalStep(), agentStep("b")] }))).toHaveLength(1);
    // An added approval step is a stronger gate.
    expect(lessSafeChanges(recipe({ steps: [agentStep("a")] }), recipe({ steps: [agentStep("a"), approvalStep()] }))).toEqual([]);
  });

  it("flags a removed review step, fewer reviewers and fewer review rounds", () => {
    const coding = (review: ResolvedStep | undefined) => recipe({ steps: [codingStep("plan", "plan"), codingStep("build", "build"), ...(review === undefined ? [] : [review]), codingStep("pull_request", "pull_request")] });
    const current = coding(reviewStep(["code", "security"], 3));
    expect(lessSafeChanges(current, coding(undefined))).toEqual(['Removes the review step "Review"']);
    expect(lessSafeChanges(current, coding(reviewStep(["code"], 3)))).toEqual(['Gives the review step "Review" fewer reviewers']);
    expect(lessSafeChanges(current, coding(reviewStep(["code", "security"], 1)))).toEqual(['Lowers how many times the review step "Review" sends findings back, from 3 to 1']);
    expect(lessSafeChanges(current, coding(reviewStep(["code", "security"])))).toEqual(['Stops the review step "Review" sending findings back']);
    expect(lessSafeChanges(current, coding(reviewStep(["code", "security"], 5)))).toEqual([]);
    expect(lessSafeChanges(coding(reviewStep(["code"], 3)), coding(reviewStep(["code", "security"], 3)))).toEqual([]);
  });

  it("flags a removed or changed alwaysAsk pattern, but not an added one", () => {
    const current = recipe({ approvals: { alwaysAsk: ["create_*", "delete_*"] } });
    expect(lessSafeChanges(current, recipe({ approvals: { alwaysAsk: ["delete_*"] } }))).toEqual(['Removes or changes the always-ask rule "create_*"']);
    expect(lessSafeChanges(current, recipe({ approvals: { alwaysAsk: ["create_issue", "delete_*"] } }))).toEqual(['Removes or changes the always-ask rule "create_*"']);
    expect(lessSafeChanges(current, recipe({ approvals: { alwaysAsk: [] } }))).toHaveLength(2);
    expect(lessSafeChanges(current, recipe({ approvals: { alwaysAsk: ["delete_*", "create_*", "merge_*"] } }))).toEqual([]);
  });

  it("flags a grant widened to read and write, a new grant, and a dropped or widened tool list", () => {
    const current = recipe({ tools: [grant({ type: "linear" }), grant({ name: "docs" }, "read", ["get_*"])] });
    expect(lessSafeChanges(current, recipe({ tools: [grant({ type: "linear" }, "read_write"), grant({ name: "docs" }, "read", ["get_*"])] }))).toEqual(["Lets the agent change things in every linear connector (read and write)"]);
    expect(lessSafeChanges(current, recipe({ tools: [...current.tools, grant({ type: "jira" })] }))).toEqual(["Gives the agent access to every jira connector (read)"]);
    expect(lessSafeChanges(current, recipe({ tools: [current.tools[0]!, grant({ name: "docs" })] }))).toEqual(['Removes the tool limit on the "docs" connector']);
    expect(lessSafeChanges(current, recipe({ tools: [current.tools[0]!, grant({ name: "docs" }, "read", ["get_*", "list_*"])] }))).toEqual(['Allows more tools on the "docs" connector']);
    // Narrowing, or removing a grant, is fine.
    expect(lessSafeChanges(current, recipe({ tools: [grant({ type: "linear" }, "read", ["get_issue"])] }))).toEqual([]);
    expect(lessSafeChanges(recipe({ tools: [grant({ type: "linear" }, "read_write")] }), recipe({ tools: [grant({ type: "linear" })] }))).toEqual([]);
  });

  it("flags a grant whose selector changes to cover more connectors (R9-2)", () => {
    const current = recipe({ tools: [grant({ name: "tracker" })] });
    expect(lessSafeChanges(current, recipe({ tools: [grant({ type: "linear" })] }))).toEqual(["Gives the agent access to every linear connector (read)"]);
  });

  it("flags a step whose tool limit is dropped or widened, and a step that gains tools", () => {
    const current = recipe({ steps: [agentStep("a", "none", ["search_*"])] });
    expect(lessSafeChanges(current, recipe({ steps: [agentStep("a")] }))).toEqual(['Removes the tool limit on the step "A"']);
    expect(lessSafeChanges(current, recipe({ steps: [agentStep("a", "none", ["search_*", "write_*"])] }))).toEqual(['Allows more tools in the step "A"']);
    expect(lessSafeChanges(current, recipe({ steps: [agentStep("a", "none", [])] as ResolvedStep[] }))).toEqual([]);
    expect(lessSafeChanges(recipe({ steps: [agentStep("a")] }), recipe({ steps: [agentStep("a", "none", ["search_*"])] }))).toEqual([]);
  });

  it("flags a step that replaces a limited step under a new id, and a new step with no limit (review Important 1)", () => {
    const current = recipe({ steps: [agentStep("a", "none", ["search_*"])] });
    // The same step renamed, the limit gone: it now uses every tool the grants allow.
    expect(lessSafeChanges(current, recipe({ steps: [agentStep("a2")] }))).toEqual(['Adds the step "A2" without the tool limit the other steps have']);
    // Added beside the limited one.
    expect(lessSafeChanges(current, recipe({ steps: [agentStep("a", "none", ["search_*"]), agentStep("b")] }))).toEqual(['Adds the step "B" without the tool limit the other steps have']);
    // A new step inside the limits already there is no wider; one that allows more is.
    expect(lessSafeChanges(current, recipe({ steps: [agentStep("a", "none", ["search_*"]), agentStep("b", "none", ["search_*"])] }))).toEqual([]);
    expect(lessSafeChanges(current, recipe({ steps: [agentStep("b", "none", ["search_*", "write_*"])] }))).toEqual(['Allows more tools in the step "B"']);
    // Nothing was limited before, so nothing is dropped; a first publish is not flagged for it.
    expect(lessSafeChanges(recipe({ steps: [agentStep("a")] }), recipe({ steps: [agentStep("a"), agentStep("b")] }))).toEqual([]);
    expect(lessSafeChanges(undefined, recipe({ steps: [agentStep("b")] }))).toEqual([]);
    // A step of another kind does not borrow the limits of this kind.
    expect(lessSafeChanges(current, recipe({ steps: [agentStep("a", "none", ["search_*"]), approvalStep()] }))).toEqual([]);
  });

  describe("a step under a new id is judged against the steps that left (review Important 1, round 2)", () => {
    const buildStep = (id: string, tools?: string[]): ResolvedStep => ({ id, name: id.toUpperCase(), kind: "build", settings: settings(tools === undefined ? {} : { tools }) });
    const tools = (...names: string[]) => names;

    it("flags a renamed limited step that comes back unlimited, even when other steps of its kind were never limited", () => {
      const current = recipe({ steps: [agentStep("a", "none", tools("x")), agentStep("b")] });
      expect(lessSafeChanges(current, recipe({ steps: [agentStep("a2"), agentStep("b")] }))).toEqual(['Adds the step "A2" without the tool limit the other steps have']);
      // The same edit with the id kept was already caught.
      expect(lessSafeChanges(current, recipe({ steps: [agentStep("a"), agentStep("b")] }))).toEqual(['Removes the tool limit on the step "A"']);
    });

    it("flags a merge whose one step can use more than any step it replaced", () => {
      const current = recipe({ steps: [agentStep("a", "none", tools("x")), agentStep("b", "none", tools("y"))] });
      expect(lessSafeChanges(current, recipe({ steps: [agentStep("c", "none", tools("x", "y"))] }))).toEqual(['Allows more tools in the step "C"']);
      expect(lessSafeChanges(current, recipe({ steps: [agentStep("c", "none", tools("x"))] }))).toEqual([]);
    });

    it("keeps the added-beside rule when nothing of that kind left", () => {
      expect(lessSafeChanges(recipe({ steps: [agentStep("a", "none", tools("x"))] }), recipe({ steps: [agentStep("a", "none", tools("x")), agentStep("c")] }))).toEqual(['Adds the step "C" without the tool limit the other steps have']);
      // One step of that kind was never limited, so an unlimited new one drops nothing.
      expect(lessSafeChanges(recipe({ steps: [agentStep("a", "none", tools("x")), agentStep("b")] }), recipe({ steps: [agentStep("a", "none", tools("x")), agentStep("b"), agentStep("c")] }))).toEqual([]);
      // An unlimited step that left may be replaced by an unlimited one.
      expect(lessSafeChanges(recipe({ steps: [agentStep("a"), agentStep("b", "none", tools("x"))] }), recipe({ steps: [agentStep("a2"), agentStep("b", "none", tools("x"))] }))).toEqual([]);
    });

    it("flags a step of a kind the recipe did not have when it can use more tools than any step before it", () => {
      const current = recipe({ steps: [agentStep("a", "none", tools("x"))] });
      expect(lessSafeChanges(current, recipe({ steps: [buildStep("b")] }))).toEqual(['Adds the step "B", which can use more tools than any step before it']);
      expect(lessSafeChanges(current, recipe({ steps: [buildStep("b", tools("x"))] }))).toEqual([]);
      // Nothing before it, nothing to compare with: a first publish is not flagged for its steps' default tools.
      expect(lessSafeChanges(undefined, recipe({ steps: [buildStep("b")] }))).toEqual([]);
      expect(lessSafeChanges(recipe({ steps: [] }), recipe({ steps: [buildStep("b")] }))).toEqual([]);
    });

    it("does not flag splitting a limited step in two, or reordering steps", () => {
      expect(lessSafeChanges(recipe({ steps: [agentStep("a", "none", tools("x"))] }), recipe({ steps: [agentStep("a1", "none", tools("x")), agentStep("a2", "none", tools("x"))] }))).toEqual([]);
      expect(lessSafeChanges(recipe({ steps: [agentStep("a", "none", tools("x", "y"))] }), recipe({ steps: [agentStep("a1", "none", tools("x")), agentStep("a2", "none", tools("y"))] }))).toEqual([]);
      expect(lessSafeChanges(recipe({ steps: [agentStep("a", "none", tools("x")), agentStep("b")] }), recipe({ steps: [agentStep("b"), agentStep("a", "none", tools("x"))] }))).toEqual([]);
    });
  });

  it("flags raised autonomy only", () => {
    expect(lessSafeChanges(recipe({ autonomy: "suggest" }), recipe({ autonomy: "prepare" }))).toEqual(["Raises the agent's autonomy from suggest to prepare"]);
    expect(lessSafeChanges(recipe({ autonomy: "prepare" }), recipe({ autonomy: "run" }))).toHaveLength(1);
    expect(lessSafeChanges(recipe({ autonomy: "run" }), recipe({ autonomy: "prepare" }))).toEqual([]);
  });

  it("flags allowMentions turned on, but not off", () => {
    expect(lessSafeChanges(recipe(), recipe({ allowMentions: true }))).toEqual(["Lets the agent @-mention people in its comments"]);
    expect(lessSafeChanges(recipe({ allowMentions: true }), recipe({ allowMentions: true }))).toEqual([]);
    expect(lessSafeChanges(recipe({ allowMentions: true }), recipe())).toEqual([]);
  });

  it("flags a trigger kind other than person that is newly on", () => {
    const withEvent = recipe({ triggers: [{ kind: "person" }, { kind: "event" } as never] });
    expect(lessSafeChanges(recipe(), withEvent)).toEqual(["Lets the agent be started by event triggers"]);
    expect(lessSafeChanges(withEvent, withEvent)).toEqual([]);
    expect(lessSafeChanges(withEvent, recipe())).toEqual([]);
  });

  it("flags an agent step that gains the project's files, whether it is new or changed", () => {
    expect(lessSafeChanges(recipe({ steps: [agentStep("a", "none")] }), recipe({ steps: [agentStep("a", "read")] }))).toEqual(['Gives the step "A" read access to the project\'s files']);
    expect(lessSafeChanges(recipe({ steps: [agentStep("a", "none")] }), recipe({ steps: [agentStep("a", "none"), agentStep("b", "read")] }))).toEqual(['Gives the step "B" read access to the project\'s files']);
    expect(lessSafeChanges(recipe({ steps: [agentStep("a", "read")] }), recipe({ steps: [agentStep("a", "read")] }))).toEqual([]);
    expect(lessSafeChanges(recipe({ steps: [agentStep("a", "read")] }), recipe({ steps: [agentStep("a", "none")] }))).toEqual([]);
  });

  it("lists every change once, in a stable order", () => {
    const current = recipe({ steps: [agentStep("a"), approvalStep()], autonomy: "suggest", approvals: { alwaysAsk: ["x_*"] } });
    const next = recipe({ steps: [agentStep("a", "read")], autonomy: "run", allowMentions: true });
    const changes = lessSafeChanges(current, next);
    expect(changes).toHaveLength(5);
    expect(new Set(changes).size).toBe(5);
    expect(lessSafeChanges(current, next)).toEqual(changes);
  });

  it("finds nothing unsafe between the built-in versions an agent can build on with no edits", () => {
    for (const agent of Object.values(BUILTIN_AGENTS)) {
      const latest = agent.versions.at(-1)!.recipe;
      expect(lessSafeChanges(latest, structuredClone(latest))).toEqual([]);
    }
  });
});
