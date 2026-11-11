// Plan 4 Task 5: what a chain run asks of Plan 3's spend engine, as one place. A chain is paid for the way an agent is: a payer (`chainRunPayer`), a place (the
// project), the budgets the run counts against (`budgetScopesFor`: the org, the project and, when the chain pays, the chain, never the agent that runs the
// step), an admission (`admitChainRun`), and a limit of its own per run that each step is started under (`stepRunLimitUsd`) and settled against (`settleStepSpend`).
// A chain's monthly budget is counted in its owner's one monthly total with their agents' budgets (R65; `spend/owner-budgets.ts`, which both stores share), and
// the routes that change it are in routes.ts.
import { DEFAULT_PERSON_CHAIN_RUN_LIMIT_USD, agentXError, type ChainId, type OrgId, type Payer, type PinnedChainDefinition, type WorkOrigin } from "@rovara-code/contracts";
import { admitWork } from "../spend/admission.js";
import type { AdmissionDependencies } from "../org/budget.js";
import { resolvePayer, type NamedPerson, type PayerFacts } from "../spend/payer.js";
import { cleanUsd } from "../spend/top-ups.js";

/** The person a chain's budget counts for: the member who owns it, else the maintainer accountable for it (the same rule as an agent's). */
export { budgetOwnerOf } from "../spend/owner-total.js";

/** Where a chain run can start from: a person's origins, and the two that no person starts. */
export type ChainRunOrigin = Extract<WorkOrigin, "app" | "cli" | "mcp" | "slack" | "linear" | "event" | "schedule">;

/**
 * Whose budget a chain run is charged to (`resolvePayer`, Plan 3 Task 29): an event or a schedule that starts a chain is paid by the chain; a person's run is
 * paid by the project when it pays for its tasks, else by the member who started it.
 */
export function chainRunPayer(input: { origin: ChainRunOrigin; project: string; projectPays: boolean; chainId: ChainId; startedBy?: NamedPerson | undefined } & PayerFacts): Payer {
  return resolvePayer({
    origin: input.origin, project: input.project, projectPays: input.projectPays, chainId: input.chainId,
    ...(input.startedBy === undefined ? {} : { startedBy: input.startedBy }),
    // A Linear-started run follows Plan 3's payer table: its person assigner pays, else the member who approved a bot's assignment, else the project.
    ...(input.assignedBy === undefined ? {} : { assignedBy: input.assignedBy }),
    ...(input.approvedBy === undefined ? {} : { approvedBy: input.approvedBy }),
    ...(input.acceptedBy === undefined ? {} : { acceptedBy: input.acceptedBy }),
  });
}

/**
 * The most a chain run may spend: the design's `limits.maxRunUsd` when it set one, else the default for a run a person started. An event or a schedule starts
 * runs no one watches, so they need the design's own limit (Task 18 refuses the trigger without one, and checks again at every change and at dispatch).
 */
export function chainRunLimitUsd(pinned: Pick<PinnedChainDefinition, "limits">, origin: ChainRunOrigin): number {
  const set = pinned.limits?.maxRunUsd;
  if (set !== undefined) return set;
  if (origin === "event" || origin === "schedule") throw agentXError("CONFIG_INVALID", "limits.maxRunUsd: a chain that events or schedules start needs a run limit");
  return DEFAULT_PERSON_CHAIN_RUN_LIMIT_USD;
}

/**
 * Whether a chain run may start: Plan 3's `admitWork` for the run's payer and place, whose chain refusals (`SCOPE_ERRORS.chain`) are the chain's own: a chain that
 * pays has to have a monthly budget (CHAIN_BUDGET_REQUIRED), and a month that is used up refuses (CHAIN_BUDGET_EXCEEDED). The first step's agent is the one whose
 * minimum room the start needs; a run a person's budget pays for is admitted on theirs and the project's.
 */
export async function admitChainRun(
  deps: AdmissionDependencies,
  input: { orgId: OrgId; chain: { chainId: ChainId  ; name: string }; project: string; payer: Payer; firstAgent: { agentId: string; name: string } },
): Promise<void> {
  await admitWork(deps, {
    orgId: input.orgId, payer: input.payer, project: input.project, agentId: input.firstAgent.agentId, agentName: input.firstAgent.name,
    chainName: input.chain.name, path: "AGENT",
  });
}

// ---- a run's limit, and a step under it

/** The part of a chain run's record that its limit is made of. */
export interface ChainRunLimits {
  runLimitUsd: number;
  spentUsd: number;
}

/** What the run had left of its own limit when a step started, kept on the step's attempt. */
export interface StepAttempt {
  remainingAtStartUsd: number;
}

/** The part of Plan 3's `TaskEndEvent` a step's settlement reads: the task's limit as it stands (every approved raise included) and what its keys spent. */
export interface StepEnd {
  runLimitUsd: number;
  spentUsd: number;
}

/**
 * The run limit a step is started with: what the run has left, never below 0. Plan 3 applies the agent's max per run to it (`stopAtUsd`), and a step started with
 * 0 starts paused with a spend request (G8). The attempt records this figure as `remainingAtStartUsd` before the call.
 */
export const stepRunLimitUsd = (run: ChainRunLimits): number => Math.max(0, cleanUsd(run.runLimitUsd - run.spentUsd));

/**
 * What a step that ended adds to its run. The step spent `event.spentUsd`. Its task's limit as the end says it (`event.runLimitUsd`) was raised past the room the run
 * had left only by what a person approved beyond it: Plan 3 grants a step the lower of its estimate and its run limit, and a raise from there up to the run's
 * remaining limit adds nothing, because that money was inside the chain's limit already. So `raisedUsd = max(0, event.runLimitUsd - remainingAtStartUsd)`; the run
 * adds `spentUsd` to what it has spent and `raisedUsd` to its limit, so the raise carries to the steps after it. Spend that settles after the step ends is small
 * and accepted. This only works the figures out: the runner writes them to the run, with `runRaiseMessage` as its event.
 */
export function settleStepSpend(run: ChainRunLimits, attempt: StepAttempt, event: StepEnd): { spentUsd: number; raisedUsd: number; run: ChainRunLimits } {
  const spentUsd = event.spentUsd;
  const raisedUsd = Math.max(0, cleanUsd(event.runLimitUsd - attempt.remainingAtStartUsd));
  return { spentUsd, raisedUsd, run: { runLimitUsd: cleanUsd(run.runLimitUsd + raisedUsd), spentUsd: cleanUsd(run.spentUsd + spentUsd) } };
}

/** The event a run leaves when a person approved more for it: `"<name> approved $<n> more for this run."` */
export const runRaiseMessage = (name: string, usd: number): string => `${name} approved $${String(Number(cleanUsd(usd).toFixed(2)))} more for this run.`;
