// Convergence S0: the money rules the composition root owns (A5's notes, DEFERRED A5-S0-OPEN-QUESTIONS).
//
//  (2) ONE spend writer. CloudAdmission.settle and the LiteLLM key ledger both count the same SPEND# counters. Work whose model calls go through a
//      Cloud model key (the LiteLLM key ledger records the real spend) RELEASES its admission hold: the ledger is the writer. Only work the key ledger
//      does not see (machine time, a provider outside the proxy) SETTLES, from what Metering priced. Never both: that is double counting.
//  (3) A hold whose caller died is charged in full by `sweepExpiredHolds` on a schedule (jobs.ts `admission-hold-sweep`).
//  (4) The levels a request counts against repeat Cloud's own `budgetScopesFor` + `effectiveLimits`, with the default payer (the person who acts; the
//      project when no person is named), so a core admission and Cloud's own `admitWork` agree on the scopes and limits.
import { scopeKey, type BudgetScope } from "@agentx/cloud-contracts";
import type { AdmissionRequest, Cost } from "@rovara-code/contracts";
import { budgetScopesFor } from "../../spend/payer.js";

/** Who records the real spend of a piece of work. */
export type SpendWriter = "key-ledger" | "metering";

export interface WorkSpend {
  /** The work's model calls went through a Cloud model key (the LiteLLM proxy's per-task key). */
  viaModelKey: boolean;
}

export function spendWriterFor(work: WorkSpend): SpendWriter {
  return work.viaModelKey ? "key-ledger" : "metering";
}

export interface HoldCloser {
  settle(reservationId: string, actual: { tokens?: number; cost?: Cost }): Promise<void>;
  release(reservationId: string): Promise<void>;
}

/**
 * Closes an admission hold with the one writer rule. `metered` is what Metering priced for the work (undefined: nothing priced, which settles the
 * whole hold, as an unknown cost is never $0, decision 79).
 */
export async function closeHold(admission: HoldCloser, reservationId: string, work: WorkSpend, metered: Cost | undefined): Promise<"released" | "settled"> {
  if (spendWriterFor(work) === "key-ledger") {
    await admission.release(reservationId);
    return "released";
  }
  await admission.settle(reservationId, metered === undefined ? {} : { cost: metered });
  return "settled";
}

export interface AdmissionLevel {
  scope: string;
  kind: BudgetScope["kind"];
  limitUsd: number | undefined;
}

export interface LevelSources {
  /** Cloud's `effectiveLimits` for these scopes in this month (by `scopeKey`). */
  limits(input: { orgId: string; month: string; scopes: readonly BudgetScope[] }): Promise<Map<string, number | undefined>>;
  /** The agent that runs a request (Rovara's own agent unless the request names another). */
  agentId(request: AdmissionRequest): string;
}

/** The default payer of a core request: the acting person, else the project. A request with neither is refused upstream (no scopes is never "free"). */
export function defaultScopes(request: AdmissionRequest, agentId: string): BudgetScope[] {
  const project = request.projectName;
  if (project === undefined) throw new Error("a request that spends money names its project");
  const personId = request.actor?.personId;
  const payer = personId === undefined ? { kind: "project" as const, project } : { kind: "member" as const, developerId: personId };
  return budgetScopesFor(payer, { project }, { agentId: agentId });
}

/** CloudAdmission's `levels`: the scopes and limits of a request in a month, as Cloud's own admission computes them. */
export function cloudAdmissionLevels(sources: LevelSources) {
  return async (request: AdmissionRequest, month: string): Promise<AdmissionLevel[]> => {
    const scopes = defaultScopes(request, sources.agentId(request));
    const limits = await sources.limits({ orgId: request.companyId, month, scopes });
    return scopes.map((scope) => ({ scope: scopeKey(scope), kind: scope.kind, limitUsd: limits.get(scopeKey(scope)) }));
  };
}
