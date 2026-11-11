// Plan 6 Task 6 (owner ruling): a Rovara Code step in a chain that ended Answered (it answered a question and changed no code) is not a success to move on from. The run pauses at a
// gate, which is the chain's existing gate (Plan 3's step approval, `chain_gate`: the same approvers rule, confirmation page, expiry and handler), only that nobody drew it into the
// design: it is implied by the answered step, with a reserved id that no design can use (`$answered:<step id>`; a step id is lowercase letters, digits and underscores).
//
//   Continue (Approve): the run goes on by the answered step's own edge, as if the step had succeeded.
//   Stop (Decline):     the run ends `cancelled` (a person's decision, not a failure).
//
// Nothing a step reports can reach the approval record: the prompt is fixed words around the step's name.
import type { PinnedChainDefinition } from "@rovara-code/contracts";
import { neutralText } from "./run-events.js";

type PinnedStep = PinnedChainDefinition["steps"][number];
export type GateStep = Extract<PinnedStep, { kind: "gate" }>;

/** The id prefix of an implied gate. */
export const ANSWERED_GATE_PREFIX = "$answered:";
/** What follows the step's name in the gate's name. */
const ANSWERED_NAME_SUFFIX = " answered";
const NAME_MAX = 60;

export const answeredGateId = (stepId: string): string => `${ANSWERED_GATE_PREFIX}${stepId}`;

/** The step an implied gate follows, or undefined for any other id. */
export const answeredGateOrigin = (gateId: string): string | undefined => (gateId.startsWith(ANSWERED_GATE_PREFIX) ? gateId.slice(ANSWERED_GATE_PREFIX.length) : undefined);

/** The step's name as the gate's name says it ("Fix it" answered). */
export const answeredGateName = (stepName: string): string => `${neutralText(stepName, NAME_MAX)}${ANSWERED_NAME_SUFFIX}`;

/** The step's name back from the gate's name. */
export const answeredStepName = (gateName: string): string => (gateName.endsWith(ANSWERED_NAME_SUFFIX) ? gateName.slice(0, -ANSWERED_NAME_SUFFIX.length) : gateName);

/** The words the approval carries: fixed text around the step's name. */
export const answeredGatePrompt = (stepName: string): string => `Step "${neutralText(stepName, NAME_MAX)}" answered instead of changing code. Continue or stop?`;

/**
 * The gate an answered step implies: the person who started the run, a maintainer of the project or the chain's owner decide (the rules a designed gate names most often), with the
 * default time to decide. Its edges are never read: continuing takes the answered step's own edge, and stopping ends the run (see `afterAttempt`).
 */
export function answeredGateStep(stepId: string, stepName: string): GateStep {
  return {
    kind: "gate", id: answeredGateId(stepId), name: answeredGateName(stepName), prompt: answeredGatePrompt(stepName),
    approvers: [{ kind: "starter" }, { kind: "project_maintainers" }, { kind: "chain_owner" }],
    onApprove: { to: "$end" }, onReject: { to: "$end" },
  };
}

/** The gate of an attempt: the design's own gate step, or the gate an answered step implied (rebuilt from the attempt, which keeps its name). */
export function gateStepOf(definition: PinnedChainDefinition | undefined, attempt: { stepId: string; stepName: string }): GateStep | undefined {
  const origin = answeredGateOrigin(attempt.stepId);
  if (origin !== undefined) return answeredGateStep(origin, answeredStepName(attempt.stepName));
  const step = definition?.steps.find((candidate) => candidate.id === attempt.stepId);
  return step?.kind === "gate" ? step : undefined;
}
