// "How we work" (H4): which changes to a project's process layer wait for a person on the confirmation page. These are the extra rules for a process layer (a plan check or review
// that loses its independence or moves to a weaker model, a model from a new AI company, changed instructions of a plan check or review); an ordinary agent is judged as before.
import { describe, expect, it } from "vitest";
import { EMPTY_RECIPE, type ResolvedRecipe, type ResolvedStep } from "@rovara-code/contracts";
import { PROCESS_DEFAULT_STEP_TIMEOUT_MINUTES, lessSafeChangesFor, processLessSafeChanges } from "../../packages/broker/src/playbook/process-less-safe.js";

type Model = { provider: string; modelId: string };
const OPUS: Model = { provider: "anthropic", modelId: "claude-opus-4-8" };
const SONNET: Model = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const HAIKU: Model = { provider: "anthropic", modelId: "claude-haiku-4-5" };
const GPT: Model = { provider: "openai", modelId: "gpt-5" };
const GEMINI: Model = { provider: "google", modelId: "gemini-2.5-pro" };
const BEDROCK_OPUS: Model = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-8-v1:0" };

const layers = (...texts: string[]) => texts.map((text) => ({ agentName: "Layer", text }));
type Extra = { model?: Model; fallbackModel?: Model; differentCompanyFrom?: string; instructions?: string[]; timeoutMinutes?: number | null; stepBudgetUsd?: number | null };
const settings = ({ instructions = [], ...rest }: Extra = {}) => ({ instructions: layers(...instructions), ...rest });
const plan = (extra?: Extra): ResolvedStep => ({ id: "plan", name: "Plan", kind: "plan", settings: settings(extra) });
const critic = (extra?: Extra): ResolvedStep => ({ id: "plan_critic", name: "Plan check", kind: "plan_critic", settings: settings(extra) });
const build = (extra?: Extra): ResolvedStep => ({ id: "build", name: "Build", kind: "build", settings: settings(extra) });
const check = (): ResolvedStep => ({ id: "check", name: "Check", kind: "check", settings: { instructions: [] } });
const review = (extra?: Extra): ResolvedStep => ({ id: "review", name: "Review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 }, settings: settings(extra) });
const pr = (): ResolvedStep => ({ id: "pull_request", name: "Pull request", kind: "pull_request", settings: { instructions: [] } });
const recipe = (steps: ResolvedStep[]): ResolvedRecipe => ({ ...structuredClone(EMPTY_RECIPE), steps });
const flow = (parts: { plan?: Extra; critic?: Extra; build?: Extra; review?: Extra } = {}): ResolvedRecipe => recipe([plan(parts.plan), critic(parts.critic), build(parts.build), check(), review(parts.review), pr()]);
const ctx = { firstPublish: false };
const reasons = (current: ResolvedRecipe | undefined, next: ResolvedRecipe) => processLessSafeChanges(current, next, ctx);

describe("(a) a plan check or review loses its independence", () => {
  it("flags a review that now uses the same model as Build", () => {
    const current = flow({ build: { model: OPUS }, review: { model: SONNET } });
    expect(reasons(current, flow({ build: { model: OPUS }, review: { model: OPUS } }))).toEqual(['Makes the review step "Review" use the same model as the build step "Build"']);
  });
  it("flags it when the same model is reached by another route (canonical name)", () => {
    const current = flow({ build: { model: OPUS }, review: { model: SONNET } });
    expect(reasons(current, flow({ build: { model: OPUS }, review: { model: BEDROCK_OPUS } }))).toEqual(['Makes the review step "Review" use the same model as the build step "Build"', 'Lets the step "Review" send data through a new model provider (amazon-bedrock)']);
  });
  it("flags a plan check that now uses the same model as Plan", () => {
    const current = flow({ plan: { model: OPUS }, critic: { model: SONNET } });
    expect(reasons(current, flow({ plan: { model: OPUS }, critic: { model: OPUS } }))).toEqual(['Makes the plan check "Plan check" use the same model as the plan step "Plan"']);
  });
  it("flags a build model changed to the review's model", () => {
    const current = flow({ build: { model: OPUS }, review: { model: SONNET } });
    expect(reasons(current, flow({ build: { model: SONNET }, review: { model: SONNET } }))).toHaveLength(1);
  });
  it("flags removing differentCompanyFrom from a review or a plan check, or pointing it elsewhere", () => {
    const current = flow({ review: { differentCompanyFrom: "build" }, critic: { differentCompanyFrom: "plan" } });
    expect(reasons(current, flow())).toHaveLength(2);
    expect(reasons(flow({ review: { differentCompanyFrom: "build" } }), flow({ review: { differentCompanyFrom: "plan" } }))).toHaveLength(1);
  });
  it("does not flag a review that keeps its different model, or one that was already the same model", () => {
    const current = flow({ build: { model: OPUS }, review: { model: SONNET } });
    expect(reasons(current, flow({ build: { model: HAIKU }, review: { model: SONNET } }))).toEqual([]);
    expect(reasons(flow({ build: { model: OPUS }, review: { model: OPUS } }), flow({ build: { model: OPUS }, review: { model: OPUS } }))).toEqual([]);
  });
  it("treats an unset model as unknown: going to or from unset is not flagged", () => {
    const current = flow({ build: { model: OPUS }, review: { model: SONNET } });
    expect(reasons(current, flow({ build: { model: OPUS } }))).toEqual([]);
    expect(reasons(flow({ build: { model: OPUS } }), flow({ build: { model: OPUS }, review: { model: OPUS } }))).toEqual([]);
  });
});

describe("(b) a plan check or review moves to a weaker model tier", () => {
  it("flags a review and a plan check that move to a weaker tier", () => {
    expect(reasons(flow({ review: { model: OPUS } }), flow({ review: { model: SONNET } }))).toEqual(['Moves the review step "Review" to a weaker model']);
    expect(reasons(flow({ critic: { model: SONNET } }), flow({ critic: { model: HAIKU } }))).toEqual(['Moves the plan check "Plan check" to a weaker model']);
  });
  it("flags a weaker fallback model too", () => {
    expect(reasons(flow({ review: { model: SONNET } }), flow({ review: { model: SONNET, fallbackModel: HAIKU } }))).toHaveLength(1);
  });
  it("does not flag the same tier, a stronger tier, an unset model, or a weaker Build model", () => {
    expect(reasons(flow({ review: { model: SONNET } }), flow({ review: { model: SONNET } }))).toEqual([]);
    expect(reasons(flow({ review: { model: SONNET } }), flow({ review: { model: OPUS } }))).toEqual([]);
    expect(reasons(flow({ review: { model: SONNET } }), flow())).toEqual([]);
    expect(reasons(flow({ build: { model: OPUS } }), flow({ build: { model: OPUS }, review: { model: HAIKU } }))).toEqual([]);
    expect(reasons(flow({ build: { model: OPUS } }), flow({ build: { model: HAIKU } }))).toEqual([]);
  });
});

describe("(c) a model from a company no step of the current version used", () => {
  it("flags a step whose model comes from a new company", () => {
    expect(reasons(flow({ build: { model: OPUS } }), flow({ build: { model: OPUS }, review: { model: GPT } }))).toEqual(['Lets the step "Review" send data to a new AI company (openai)']);
  });
  it("flags a fallback model from a new company, on any kind of step", () => {
    expect(reasons(flow({ build: { model: OPUS } }), flow({ build: { model: OPUS, fallbackModel: GEMINI } }))).toEqual(['Lets the step "Build" send data to a new AI company (google)']);
  });
  it("flags a model of an unrecognised company without naming the provider", () => {
    const found = reasons(flow({ build: { model: OPUS } }), flow({ build: { model: { provider: "somewhere", modelId: "mystery-1" } } }));
    expect(found).toEqual(['Lets the step "Build" send data to a new AI company (one Rovara does not recognise)']);
    expect(JSON.stringify(found)).not.toContain("somewhere");
  });
  it("does not flag a company the current version already used on any step, nor an unset model", () => {
    expect(reasons(flow({ build: { model: OPUS }, review: { model: GPT } }), flow({ build: { model: GPT }, review: { model: OPUS } }))).toEqual([]);
    expect(reasons(flow({ build: { model: OPUS } }), flow())).toEqual([]);
  });
  it("flags a first model when the current version names none (nothing it used is known)", () => {
    expect(reasons(flow(), flow({ build: { model: OPUS } }))).toHaveLength(1);
  });
  it("words a first publish by what it builds on", () => {
    expect(processLessSafeChanges(flow(), flow({ build: { model: OPUS } }), { firstPublish: true })).toEqual(['Lets the step "Build" send data to an AI company (anthropic) that the process it builds on does not use']);
  });
});

describe("(d) the instructions of a plan check or review change", () => {
  it("flags any text change to a plan check or a review step", () => {
    expect(reasons(flow({ review: { instructions: ["Be strict."] } }), flow({ review: { instructions: ["Be lenient."] } }))).toEqual(['Changes the instructions of the review step "Review"']);
    expect(reasons(flow({ critic: { instructions: ["Be strict."] } }), flow({ critic: { instructions: ["Be strict. "] } }))).toEqual(['Changes the instructions of the plan check "Plan check"']);
  });
  it("flags adding or removing instructions on them", () => {
    expect(reasons(flow(), flow({ review: { instructions: ["New."] } }))).toHaveLength(1);
    expect(reasons(flow({ critic: { instructions: ["Old."] } }), flow())).toHaveLength(1);
  });
  it("does not flag unchanged instructions or a change of the layer's name only", () => {
    const next = flow({ review: { instructions: ["Same."] } });
    expect(reasons(flow({ review: { instructions: ["Same."] } }), next)).toEqual([]);
    (next.steps[4]!.settings as { instructions: Array<{ agentName: string }> }).instructions[0]!.agentName = "Renamed";
    expect(reasons(flow({ review: { instructions: ["Same."] } }), next)).toEqual([]);
  });
  it("does not flag a change to the instructions of Build, Plan, Check or Pull request", () => {
    expect(reasons(flow({ build: { instructions: ["a"] } }), flow({ build: { instructions: ["b"] } }))).toEqual([]);
    expect(reasons(flow({ plan: { instructions: ["a"] } }), flow({ plan: { instructions: ["b"] } }))).toEqual([]);
    expect(reasons(flow(), flow({ build: { instructions: ["new guidance"] } }))).toEqual([]);
  });
});

describe("(e) a plan check or review that is taken out (final review C1, belt and braces)", () => {
  const without = (kind: string, from: ResolvedRecipe = flow()) => recipe(from.steps.filter((step) => step.kind !== kind));
  it("flags a removed plan check", () => {
    expect(reasons(flow(), without("plan_critic"))).toEqual(['Removes the plan check "Plan check"']);
  });
  it("flags a removed review step, and a review step that loses a reviewer", () => {
    expect(reasons(flow(), without("review"))).toEqual(['Removes the review step "Review"']);
    const fewer = flow();
    (fewer.steps[4] as { reviewers: string[] }).reviewers = ["code"];
    expect(reasons(flow(), fewer)).toEqual(['Gives the review step "Review" fewer reviewers']);
  });
  it("does not flag one that stays, or a recipe that never had one", () => {
    expect(reasons(flow(), flow())).toEqual([]);
    expect(reasons(without("plan_critic"), without("plan_critic"))).toEqual([]);
  });
  it("an ordinary agent is still not flagged for a removed plan check", () => {
    expect(lessSafeChangesFor({}, flow(), without("plan_critic"), ctx)).toEqual([]);
    expect(lessSafeChangesFor({ purpose: "process" }, flow(), without("plan_critic"), ctx)).toEqual(['Removes the plan check "Plan check"']);
  });
});

describe("which rule applies to which agent", () => {
  const current = flow({ build: { model: OPUS }, review: { model: SONNET, instructions: ["a"] } });
  const next = flow({ build: { model: OPUS }, review: { model: OPUS, instructions: ["b"], fallbackModel: GPT } });
  it("a process layer gets the process rules added to the ordinary ones, without repeats", () => {
    const found = lessSafeChangesFor({ purpose: "process" }, current, next, ctx);
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(new Set(found).size).toBe(found.length);
  });
  it("an ordinary agent is judged by the ordinary rules only: the same changes are not flagged", () => {
    expect(lessSafeChangesFor({ purpose: undefined }, current, next, ctx)).toEqual([]);
    expect(lessSafeChangesFor({}, current, next, ctx)).toEqual([]);
  });
  it("a process layer still gets the ordinary reasons", () => {
    const looser = { ...flow(), autonomy: "run" as const };
    expect(lessSafeChangesFor({ purpose: "process" }, flow(), looser, ctx)).toEqual(["Raises the agent's autonomy from prepare to run"]);
  });
});

describe("(f) a step's time or step budget is raised (follow-up M1)", () => {
  it("flags a raised timeout on any kind of step, naming the step and the minutes", () => {
    expect(reasons(flow({ build: { timeoutMinutes: 30 } }), flow({ build: { timeoutMinutes: 90 } }))).toEqual(['Raises the time the step "Build" may run, from 30 to 90 minutes']);
    expect(reasons(flow({ review: { timeoutMinutes: 20 } }), flow({ review: { timeoutMinutes: 21 } }))).toHaveLength(1);
    expect(reasons(flow({ plan: { timeoutMinutes: 10 } }), flow({ plan: { timeoutMinutes: 240 } }))).toHaveLength(1);
  });
  it("judges a timeout set on a step that had none against Rovara's default", () => {
    expect(reasons(flow(), flow({ build: { timeoutMinutes: PROCESS_DEFAULT_STEP_TIMEOUT_MINUTES + 1 } }))).toHaveLength(1);
    expect(reasons(flow(), flow({ build: { timeoutMinutes: PROCESS_DEFAULT_STEP_TIMEOUT_MINUTES } }))).toEqual([]);
    expect(reasons(flow(), flow({ build: { timeoutMinutes: 30 } }))).toEqual([]);
    expect(reasons(flow({ build: { timeoutMinutes: null } }), flow({ build: { timeoutMinutes: PROCESS_DEFAULT_STEP_TIMEOUT_MINUTES + 1 } }))).toHaveLength(1);
  });
  it("flags a timeout that is taken away, whatever its value: an unset step time means no per-step limit (fix round 1, I1)", () => {
    expect(reasons(flow({ build: { timeoutMinutes: 30 } }), flow())).toEqual(['Removes the time limit of the step "Build"']);
    expect(reasons(flow({ build: { timeoutMinutes: 30 } }), flow({ build: { timeoutMinutes: null } }))).toEqual(['Removes the time limit of the step "Build"']);
    expect(reasons(flow({ build: { timeoutMinutes: PROCESS_DEFAULT_STEP_TIMEOUT_MINUTES } }), flow())).toHaveLength(1);
    expect(reasons(flow({ build: { timeoutMinutes: 200 } }), flow())).toEqual(['Removes the time limit of the step "Build"']);
    expect(reasons(flow({ review: { timeoutMinutes: 240 } }), flow({ review: { timeoutMinutes: null } }))).toHaveLength(1);
  });
  it("does not flag unset to unset, or a timeout that was null before and is still not set", () => {
    expect(reasons(flow(), flow())).toEqual([]);
    expect(reasons(flow({ build: { timeoutMinutes: null } }), flow())).toEqual([]);
  });
  it("does not flag a lowered or unchanged timeout", () => {
    expect(reasons(flow({ build: { timeoutMinutes: 90 } }), flow({ build: { timeoutMinutes: 30 } }))).toEqual([]);
    expect(reasons(flow({ build: { timeoutMinutes: 90 } }), flow({ build: { timeoutMinutes: 90 } }))).toEqual([]);
  });
  it("flags a raised step budget, and one that is taken away (set to unset counts as raised)", () => {
    expect(reasons(flow({ build: { stepBudgetUsd: 5 } }), flow({ build: { stepBudgetUsd: 6 } }))).toEqual(['Raises the spending limit of the step "Build", from $5 to $6']);
    expect(reasons(flow({ build: { stepBudgetUsd: 5 } }), flow())).toEqual(['Removes the spending limit of the step "Build"']);
    expect(reasons(flow({ build: { stepBudgetUsd: 5 } }), flow({ build: { stepBudgetUsd: null } }))).toEqual(['Removes the spending limit of the step "Build"']);
  });
  it("does not flag a lowered, unchanged or newly added step budget", () => {
    expect(reasons(flow({ build: { stepBudgetUsd: 5 } }), flow({ build: { stepBudgetUsd: 4 } }))).toEqual([]);
    expect(reasons(flow({ build: { stepBudgetUsd: 5 } }), flow({ build: { stepBudgetUsd: 5 } }))).toEqual([]);
    expect(reasons(flow(), flow({ build: { stepBudgetUsd: 50 } }))).toEqual([]);
  });
  it("judges a step the current version does not have against the default", () => {
    const extra = recipe([...flow().steps, { id: "extra", name: "Extra", kind: "build", settings: { instructions: [], timeoutMinutes: 200 } }]);
    expect(reasons(flow(), extra)).toHaveLength(1);
  });
  it("applies to a process layer only: an ordinary agent is judged as before", () => {
    const next = flow({ build: { timeoutMinutes: 90, stepBudgetUsd: 9 } });
    const current = flow({ build: { timeoutMinutes: 30, stepBudgetUsd: 5 } });
    expect(lessSafeChangesFor({}, current, next, ctx)).toEqual([]);
    expect(lessSafeChangesFor({ purpose: "process" }, current, next, ctx)).toHaveLength(2);
  });
});
