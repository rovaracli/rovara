// Proof and evidence, and decision cards (wire-proof): the two switches. Leaf module (no broker imports), so the route wiring, the worker dispatch and the publication path can all read them.
// Both are packed broker settings (stack parameters ProofEvidenceEnabled and DecisionCardsEnabled, "0" by default) that reach the broker as PROOF_EVIDENCE_ENABLED and DECISION_CARDS_ENABLED. A switch is on only when it is exactly "1".
import { BROKER_SETTINGS, liveInteractionFlagOn } from "@agentx/contracts";

/** Whether the evidence of a task's checks is gathered, kept, posted and served in this environment. Anything but exactly "1" is off. */
export const proofEvidenceEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.proofEvidence.variable]);

/** Whether the decision card routes and the Slack card press exist in this environment. Anything but exactly "1" is off. */
export const decisionCardsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.decisionCards.variable]);
