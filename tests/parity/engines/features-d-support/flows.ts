// Areas 16 and 17 (chains, custom agents): the same flows on each product's chain runner, at the service level. Both products drive a chain one step at a
// time through a "start an agent run" seam and are told when a step's task ended; neither needs the coding worker. So the flows run on each side's own
// runner and stores (Cloud: packages/broker/src/chains on its DynamoDB fake; Code: vendored core/chains on the document store port) with a recording
// starter, and report one vocabulary:
//   - transitions: `RUN:<status>|<seq>:<status>,...` after every action (the run's status and each step attempt's status);
//   - spend: what the run seam was asked (`start:<agent>`, `refused:<code>`);
//   - rows: the key families the runner wrote.
// Both are switched on for the comparison (decision 45.10 hides them in Cloud, Code's automation switch is off by default); where each product's switch
// sits is itself compared (`chains-switch-off`).

/** What one flow saw. */
export interface FlowObservation {
  transitions: string[];
  spend: string[];
  rows: string[];
}

/** The flows the scenarios name (`feature:<name>`). */
export const FLOWS = ["chains", "custom-agents", "chains-admission-refused", "chains-start-twice", "chains-switch-off", "chains-code-defaults"] as const;
export type FlowName = (typeof FLOWS)[number];

export const isFlow = (name: string): name is FlowName => (FLOWS as readonly string[]).includes(name);

/** A run's state as one word: the run's status (with its failure reason when it failed), then each step attempt's seq and status. */
export function runWord(run: { status: string; failure?: { reason: string } } | undefined, attempts: ReadonlyArray<{ seq: number; status: string }>): string {
  const failed = run?.failure === undefined ? "" : `(${run.failure.reason})`;
  return `RUN:${run?.status ?? "none"}${failed}|${attempts.map((attempt) => `${String(attempt.seq)}:${attempt.status}`).join(",")}`;
}

/** The input a person gives when starting a run (the same text both sides). */
export const START_INPUT = "Please look into the refund errors.";
/** The two built-in steps every chain flow runs: Root-cause analyst, then Code reviewer (both products ship these built-ins). */
export const TWO_BUILTIN_STEPS = {
  start: "look", limits: { maxRunUsd: 30 },
  steps: [
    { kind: "agent", id: "look", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "go", to: "review" } },
    { kind: "agent", id: "review", name: "Review it", agent: { agentId: "code-reviewer", version: "current" }, next: { kind: "end" } },
  ],
};
/** One step on a custom agent. */
export const oneStepOn = (agentId: string) => ({
  start: "work", limits: { maxRunUsd: 30 },
  steps: [{ kind: "agent", id: "work", name: "Work", agent: { agentId, version: "current" }, next: { kind: "end" } }],
});
/** The custom agent's recipe overlay (a report-only agent step, no workspace): the same on both. */
export const CUSTOM_OVERLAY = { instructions: "Look at the request and report what you find.", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] };
