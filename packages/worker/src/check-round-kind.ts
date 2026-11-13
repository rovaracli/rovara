// TE-B1-fresh (DECISIONS 163b D2): which kind of check round a task gets, and what each kind may do. Pure: no Docker, no file, no clock.
//
// THREE KINDS.
//   working         today's round: the checks run in the agent's own sandbox (or its dev container). The rollback, and what a company without the gate gets. Never a place for a real model call (D2).
//   fresh_unsealed  a fresh sandbox made from a clean export of the candidate commit (fresh-check-round.ts). NOT sealed: it keeps the task network, so the label always says "not sealed".
//   sealed          the sealed round of test services (check-round-runners.ts), exactly as it is today. Nothing in this lane changes it.
//
// THE GATE IS ITS OWN. `freshGate` is the company gate named `freshCheckRound` (the TE-A1 rollout gates). It is NOT `sealedChecks`: a gate called "sealed" must never turn on a round that is not sealed, and an unsealed round never counts as a
// sealed one. Every fact below must be exactly the boolean `true` to count, so a value that is anything else (a string, a number, nothing) reads as off and the answer is today's behaviour.
//
// "It becomes the sealed round with no other change once TS-L passes" means the switch is this chooser's input and nothing else: the same export, the same runners shape, the same evidence input; only the sandbox, the network and the label differ.

export const CHECK_ROUND_KINDS = ["working", "fresh_unsealed", "sealed"] as const;
export type CheckRoundKind = (typeof CHECK_ROUND_KINDS)[number];

export interface CheckRoundFacts {
  /** The company's `freshCheckRound` gate. */
  readonly freshGate: unknown;
  /** Test services (`tx`) are on for this task: its plan has dependencies and a run was started. */
  readonly testServices: unknown;
  /** The sealed round is cleared for production (the TS-L worker self-test passed). Held means false. */
  readonly sealedCleared: unknown;
  /** The project has a dev container: it is not moved. */
  readonly devcontainer: unknown;
  /** The task has a task sandbox (not the local shell of a developer's machine): a fresh sandbox needs the Docker host it runs on. */
  readonly sandbox: unknown;
  /** The round checks a COMMITTED candidate (an IMPLEMENT task commits its worktree before the final checks; a CHECKS retry checks the commit it was sent). A task that does not commit has no commit to export. */
  readonly candidateCommitted: unknown;
}

/**
 * The kind of round: `sealed` only when test services are on AND the sealed round is cleared (the gate does not matter: the sealed round is not this gate's to switch); otherwise `fresh_unsealed` only when the gate is on, the project has no dev
 * container, the task has a sandbox and its candidate is committed; otherwise `working`. A fresh round is never chosen for a dev container or a local shell, and never in place of a sealed round that is held.
 */
export function chooseCheckRound(facts: CheckRoundFacts): CheckRoundKind {
  if (facts.testServices === true && facts.sealedCleared === true) return "sealed";
  if (facts.freshGate === true && facts.devcontainer === false && facts.sandbox === true && facts.candidateCommitted === true) return "fresh_unsealed";
  return "working";
}

/**
 * D2 as code: real model calls (a customer's own key, a provider's real answer) are allowed only in a fresh check sandbox or the sealed round, never in the agent's working sandbox. F1-c's mode control and F1-e's bridge read the kind
 * from the worker with this, never from the sandbox or a helper. An unknown value is not allowed.
 */
export function realModelCallsAllowed(kind: unknown): boolean {
  return kind === "fresh_unsealed" || kind === "sealed";
}

/** The spelling F1-a's evidence lines use (`ModelEgressRoundKind`, packages/contracts/src/model-egress/evidence-lines.ts): `working`, `check_unsealed`, `check_sealed`. */
export function modelEgressRoundKind(kind: CheckRoundKind): "working" | "check_unsealed" | "check_sealed" {
  return kind === "sealed" ? "check_sealed" : kind === "fresh_unsealed" ? "check_unsealed" : "working";
}

/** The first line of a fresh round, and its round-kind label in the evidence input. It starts with "not sealed". */
export const FRESH_ROUND_FIRST_LINE = "not sealed: checked in a fresh sandbox made from the committed code, which can still reach the network";
/** Today's round (the agent's own sandbox). */
export const WORKING_ROUND_LINE = "checked in the task's working sandbox (not sealed)";
/** A project with a dev container keeps its own line, and the gap is stated plainly. */
export const DEVCONTAINER_ROUND_LINE = "checked in your dev container (not sealed): it is the agent's own working environment, not a fresh copy of the committed code";
/** The sealed round has its own words; they are never used for another round. */
export const SEALED_ROUND_LINE = "checked in a sealed sandbox with no outside network";

/**
 * The lines the evidence input carries for a round, the first one first. `residualLine` is F1-a's exact residual for the model-host block ("not sealed; model hosts blocked by name only", from `evidenceLinesFor`): it is passed in, never written
 * here, so the sentence exists once. No line for an unsealed round has "sealed" without "not" in front of it.
 */
export function roundEvidenceLines(kind: CheckRoundKind, options: { devcontainer: boolean; residualLine?: string | undefined }): string[] {
  if (kind === "sealed") return [SEALED_ROUND_LINE];
  if (kind === "fresh_unsealed") return [FRESH_ROUND_FIRST_LINE, ...(options.residualLine === undefined ? [] : [options.residualLine])];
  return [options.devcontainer ? DEVCONTAINER_ROUND_LINE : WORKING_ROUND_LINE];
}
