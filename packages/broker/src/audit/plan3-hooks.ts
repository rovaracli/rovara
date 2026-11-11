// Task 19: the events of Plan 3's hook sites that compare a record before and after a write (budgets, the project AI settings, the spend policy, an
// agent's owner), and the pieces every site shares. The sites themselves (the agent store, the settings writers, the org connection store) call these
// inside their own transactions: a builder here is pure, and a site wraps the call in `tryAuditEvents` so that a failure never reaches the action.
//
// Occurrences. A write that is conditional on a revision can commit once per revision, so the new revision (with the project and the field where
// several limits can move in one write) is the occurrence: a retry of a refused write records nothing, and two changes never share an id. The agent store
// writes an `EVENT#` item for every notable change; its sort key is the occurrence of the events about that change (the field joins it where one
// write records several).
import type { AuditActor } from "@agentx/cloud-contracts";
import type { AuditProof, AuditDetailPart, AuditEventInput, ProjectAiSettings, SpendPolicy } from "@agentx/cloud-contracts";
import { auditBudgetChanged, auditOccurrence, auditOwnerChanged, auditSpendPolicyChanged } from "./events.js";

export const SYSTEM_ACTOR: AuditActor = { kind: "system", id: "rovara" };

/** The actor of a change made by `by`: Rovara itself for `system`, else the member. A caller always names who; nobody named is not Rovara. */
export function auditActorOf(by: string): AuditActor {
  return by === "system" ? SYSTEM_ACTOR : { kind: "member", id: by };
}

/**
 * The proof a decision's audit event carries: the decide session's (`caller.decideProof`, set only by the decide routes from
 * `requireDecideSession`), else `{ kind: "none" }`. The code that builds `approval.decided` and `spend_request.decided` calls this, so a decision
 * made some other way is recorded as having no proof rather than with none at all.
 */
export function decisionProofOf(caller: { decideProof?: AuditProof }): AuditProof {
  return caller.decideProof ?? { kind: "none" };
}

/** Whole cents, as the chain holds an amount. */
export const centsOf = (usd: number): number => Math.round(usd * 100);

interface Base { orgId: string; actor: AuditActor; occurredAt: string }

/** `budget.changed` for an amount that may be unset on either side; an unset side has no figure. */
function budgetEvent(base: Base, input: { occurrence: string; target: Parameters<typeof auditBudgetChanged>[0]["target"]; scopeKind: string; field: string; from: number | undefined; to: number | undefined; related?: string[] }): AuditEventInput {
  return auditBudgetChanged({
    ...base, occurrence: input.occurrence, target: input.target, scopeKind: input.scopeKind, field: input.field,
    ...(input.from === undefined ? {} : { fromCents: centsOf(input.from) }), ...(input.to === undefined ? {} : { toCents: centsOf(input.to) }),
    ...(input.related === undefined ? {} : { related: input.related }),
  });
}

/**
 * `budget.changed` for a member's monthly limit when Rovara moves or removes the member's own limit (a member's removal, a merge of duplicates). The figures
 * are the limits that apply to the member, before and after: their own limit, and the members' default it falls back to.
 */
export function memberLimitChangedEvent(base: Base & { occurrence: string; developerId: string; from: number | undefined; to: number | undefined }): AuditEventInput {
  const { occurrence, developerId, from, to, ...common } = base;
  return budgetEvent(common, { occurrence, target: { kind: "budget", id: developerId }, scopeKind: "member", field: "member_monthly_limit", from, to, related: [developerId] });
}

/** The agent limits (`monthlyBudgetUsd`, `maxPerRunUsd`) an agent's or a built-in's record can hold. */
export interface AgentLimits { monthlyBudgetUsd?: number | undefined; maxPerRunUsd?: number | undefined }

/**
 * One `budget.changed` for each of an agent's two limits that the write moved. `occurrence` is the store's `EVENT#` sort key; the field joins it
 * because one write can move both limits.
 */
export function agentBudgetEvents(base: Base & { agentId: string; occurrence: string; before: AgentLimits; after: AgentLimits }): AuditEventInput[] {
  const { agentId, occurrence, before, after, ...common } = base;
  const target = { kind: "budget", id: agentId } as const;
  const events: AuditEventInput[] = [];
  if (before.monthlyBudgetUsd !== after.monthlyBudgetUsd) {
    events.push(budgetEvent(common, { occurrence: auditOccurrence(occurrence, "agent_monthly_limit"), target, scopeKind: "agent", field: "agent_monthly_limit", from: before.monthlyBudgetUsd, to: after.monthlyBudgetUsd }));
  }
  if (before.maxPerRunUsd !== after.maxPerRunUsd) {
    events.push(budgetEvent(common, { occurrence: auditOccurrence(occurrence, "agent_max_per_run"), target, scopeKind: "agent", field: "agent_max_per_run", from: before.maxPerRunUsd, to: after.maxPerRunUsd }));
  }
  return events;
}

/** One `budget.changed` when a write moved a chain's monthly limit. `occurrence` is the store's `EVENT#` sort key. */
export function chainBudgetEvents(base: Base & { chainId: string; occurrence: string; before: number | undefined; after: number | undefined }): AuditEventInput[] {
  const { chainId, occurrence, before, after, ...common } = base;
  if (before === after) return [];
  return [budgetEvent(common, { occurrence: auditOccurrence(occurrence, "chain_monthly_limit"), target: { kind: "budget", id: chainId }, scopeKind: "chain", field: "chain_monthly_limit", from: before, to: after })];
}

/** One `budget.changed` for each money limit of a project's AI settings that the write moved. The project's name is a name-keyed target. */
export function projectAiEvents(base: Base & { project: string; revision: number; before: ProjectAiSettings; after: ProjectAiSettings }): AuditEventInput[] {
  const { project, revision, before, after, ...common } = base;
  const target = { kind: "project", name: project } as const;
  const limits: Array<[string, number | undefined, number | undefined]> = [
    ["project_monthly_limit", before.monthlyBudgetUsd, after.monthlyBudgetUsd],
    ["project_planning_limit_quick", before.planningLimitUsd?.QUICK, after.planningLimitUsd?.QUICK],
    ["project_planning_limit_full", before.planningLimitUsd?.FULL, after.planningLimitUsd?.FULL],
    ["project_member_accept_run_limit", before.memberAcceptRunLimitUpToUsd, after.memberAcceptRunLimitUpToUsd],
  ];
  return limits.filter(([, from, to]) => from !== to).map(([field, from, to]) =>
    budgetEvent(common, { occurrence: auditOccurrence(project, String(revision), field), target, scopeKind: "project", field, from, to }));
}

const POLICY_AMOUNTS = ["leadApprovalThresholdUsd", "adminApprovalThresholdUsd", "testingAllowanceUsd", "perTestCapUsd", "ownerAgentBudgetCapUsd"] as const;

/** One `spend_policy.changed` for each figure of the policy that the write moved: dollars as cents, the run limit multiplier in hundredths. */
export function spendPolicyEvents(base: Base & { revision: number; before: SpendPolicy; after: SpendPolicy }): AuditEventInput[] {
  const { revision, before, after, ...common } = base;
  const figures: Array<[string, number, number]> = [
    ...POLICY_AMOUNTS.map((field): [string, number, number] => [field, centsOf(before[field]), centsOf(after[field])]),
    ["runLimitMultiplier", centsOf(before.runLimitMultiplier), centsOf(after.runLimitMultiplier)],
  ];
  return figures.filter(([, from, to]) => from !== to).map(([field, from, to]) =>
    auditSpendPolicyChanged({ ...common, occurrence: auditOccurrence(String(revision), field), field, from, to }));
}

/** What an owner is, for the people an event names and the project it keeps in its details. */
function ownerParts(owner: { kind: "member"; developerId: string } | { kind: "project"; project: string } | undefined): { member?: string; project?: string } {
  if (owner === undefined) return {};
  return owner.kind === "member" ? { member: owner.developerId } : { project: owner.project };
}

/**
 * `agent.owner_changed` (or, with `scope` "chain", `chain.owner_changed`; `agentId` then holds the chain's id) for a move of an agent to another owner. The people involved (both owners that are members, and the accountable maintainer)
 * are `related` ids; a project's name is personal data and goes only in `details`.
 */
export function ownerMovedEvent(base: Base & { occurrence: string; agentId: string; from: Parameters<typeof ownerParts>[0]; to: Parameters<typeof ownerParts>[0]; accountable?: string }, scope: "agent" | "chain" = "agent"): AuditEventInput {
  const { occurrence, agentId, from, to, accountable, ...common } = base;
  const was = ownerParts(from);
  const now = ownerParts(to);
  const related = [...new Set([was.member, now.member, accountable].filter((id): id is string => id !== undefined))];
  const fields = { ...(was.project === undefined ? {} : { fromProject: was.project }), ...(now.project === undefined ? {} : { toProject: now.project }) };
  const details: AuditDetailPart[] = Object.keys(fields).length === 0 ? [] : [{ subject: "org", fields }];
  return auditOwnerChanged({ ...common, occurrence, scope, targetId: agentId, field: "owner", ...(related.length === 0 ? {} : { related }), ...(details.length === 0 ? {} : { details }) });
}

/** `agent.owner_changed` (`chain.owner_changed` with `scope` "chain", and the chain's id in `agentId`) for a change of the maintainer accountable; `related` has the new person first, then the one before. */
export function accountableChangedEvent(base: Base & { occurrence: string; agentId: string; accountable: string; previous?: string }, scope: "agent" | "chain" = "agent"): AuditEventInput {
  const { occurrence, agentId, accountable, previous, ...common } = base;
  return auditOwnerChanged({ ...common, occurrence, scope, targetId: agentId, field: "accountable", related: [...new Set([accountable, ...(previous === undefined ? [] : [previous])])] });
}
