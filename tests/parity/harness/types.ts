// The parity suite (decision 130): the same scenario through Cloud's old path and through Rovara Code's core on the composition root's adapters, compared
// on normalized outcomes. A scenario is a small declarative file (scenarios/*.ts); an engine turns each domain step into what its own path needs.
//
// The step vocabulary is the domain's, never an engine's: "the planner proposes this plan", "the owner approves", "the checks fail once". Each engine
// does whatever its path needs to make that true (Cloud: a Slack mention and the faux model; core: the worker jobs answered through the callbacks). A
// step an engine cannot drive yet is reported, so the area shows as "not covered" with the reason, never as a pass.

/** A structured plan as a scenario names it. */
export interface PlanSpec {
  title: string;
  claims: readonly string[];
  /** Whether the plan says how the change is tested (a `checks` block, here "none, the project's check covers it"). Default true. */
  testStatement?: boolean;
}

export type Step =
  | { do: "start"; request: string; path?: "QUICK" | "FULL" }
  | { do: "plan.proposed"; plan: PlanSpec }
  | { do: "plan.approve" }
  | { do: "plan.requestChanges"; note: string; revised: PlanSpec }
  | { do: "coding.done"; files: Readonly<Record<string, string>> }
  | { do: "checks"; outcome: "pass" | "fail" }
  | { do: "reviews"; outcome: "pass" | "findings" }
  | { do: "published" }
  | { do: "task.stop" }
  | { do: "session.message"; text: string }
  | { do: "race"; steps: readonly Step[] }
  | { do: "worker.lost" }
  | { do: "base.moved" }
  | { do: "merge.conflict" }
  | { do: "pr.merged" }
  | { do: "decision.timeout"; days: number }
  | { do: "spend.limit"; usd: number }
  | { do: "approval.needed"; kind: string; answer: "approve" | "refuse" }
  | { do: "person.erase" }
  | { do: "project.second" }
  | { do: "feature"; name: string };

export type StepKind = Step["do"];

/** The facets compared. Each engine says which it can observe; a facet one side cannot see is "not covered" for that scenario. */
export const FACETS = ["transitions", "decisions", "rows", "messages", "codeHost", "spend", "audit", "features"] as const;
export type Facet = (typeof FACETS)[number];

export interface Scenario {
  id: string;
  title: string;
  /** The parity areas (1-46) this scenario covers. */
  areas: readonly number[];
  steps: readonly Step[];
  /** The facets this scenario compares (default: all). */
  facets?: readonly Facet[];
  /** Failure, race or edge case (reported, so the table shows how many are covered). */
  kind?: "happy" | "failure" | "race" | "edge";
}

export function defineScenario(scenario: Scenario): Scenario {
  return scenario;
}

/** What an engine saw, normalized (normalize.ts) before comparing. */
export interface Observation {
  /** What a feature's own driver records about its outcome, in words both engines share (a route's answer, a part's checkpoint, a second opinion's verdict). In driver order. */
  features: string[];
  /** `stage/state` after each step (a step that changes nothing repeats the last). */
  transitions: string[];
  /** The decisions recorded on the workflow, in order (`APPROVE`, `REQUEST_CHANGES`, ...). */
  decisions: string[];
  /** The key families of the task's stored rows, after key mapping (sorted, unique). */
  rows: string[];
  /** Outbound messages by channel and kind (`slack:plan_ready`). */
  messages: string[];
  /** What the code host was asked to do (`open_draft_pr`, `merge`, ...). */
  codeHost: string[];
  /** Admission and spend outcome words (`admitted`, `refused:budget_exhausted`). */
  spend: string[];
  /** Audit event names, mapped to one vocabulary. */
  audit: string[];
}

export type StepSupport = true | { unsupported: string };

export interface ParityEngine {
  /** `cloud`, `core`, or a target's own name (`staging-core`). */
  readonly name: string;
  /** Whether this engine can drive the step; the reason otherwise. */
  supports(step: Step): StepSupport;
  /** Which facets this engine can observe; the reason for each it cannot. */
  observes(facet: Facet): StepSupport;
  /** Runs the whole scenario (an engine may need to see all steps first, e.g. to script its model). */
  run(scenario: Scenario): Promise<Observation>;
  dispose(): Promise<void>;
}

export interface EngineFactory {
  readonly name: string;
  create(): Promise<ParityEngine> | ParityEngine;
}
