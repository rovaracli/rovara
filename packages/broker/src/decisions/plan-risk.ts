// Decision journey slice 2 (review fix): the coding plan card's facts and tier, read from the plan document itself, never assumed. ONE function for the card (plan-cards.ts), the workflow decision
// (decide.ts: who may approve, from where) and the Slack message (the notifier), so a plan is the same tier wherever it is decided.
//   structured   files: the code its claims cite and the paths its work items name (`planFiles`); untested claims: top-level claims no check or scenario proves.
//   Markdown     files: the paths its text names (for the infrastructure rule); which checks prove it is not stated, so the plan is at least medium and the card shows no proof chip.
//   unreadable   no files, no proof: at least medium, and the card shows neither chip.
import type { DecisionRisk } from "@agentx/contracts";
import type { LoadedDocument } from "../developer/plan-artifacts.js";
import { pathsIn, planFiles, planUntestedClaims } from "../developer/plan-one-screen.js";
import { riskTierOf } from "./risk-tier.js";

export interface PlanFacts {
  files: string[];
  untestedClaims: number;
  /** The files or the checks that prove the plan could not be read from it: no such chips, and the tier is at least medium. */
  unread: boolean;
}

export function planFactsOf(loaded: LoadedDocument | undefined): PlanFacts {
  if (loaded === undefined) return { files: [], untestedClaims: 0, unread: true };
  if (loaded.format === "structured") return { files: planFiles(loaded.plan), untestedClaims: planUntestedClaims(loaded.plan), unread: false };
  return { files: pathsIn(loaded.markdown), untestedClaims: 0, unread: true };
}

/** The coding plan card's tier for these facts and the plan's expected cost (the high end), with no company lock (none is stored yet). */
export function planRiskOf(facts: PlanFacts, costHighUsd: number | undefined): DecisionRisk {
  return riskTierOf("approve_plan", { plan: { files: facts.files, untestedClaims: facts.untestedClaims, unread: facts.unread, ...(costHighUsd === undefined ? {} : { costHighUsd }) } }).risk;
}
