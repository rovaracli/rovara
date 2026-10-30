// v1.2 learning loop: the audit events of the learning paths (design 8), built in one place so every path emits the same way. Each path asks for its events with `learningEvents`, puts the
// returned `items` in the transaction that changes the state, and calls `flushLearningEvents` after the commit. Without a ledger (`deps.audit` absent) there are no items and no events.
// Every fact is an id, a count or a fixed word: no correction text, rule text or note is ever a fact.
import type { AuditActor, AuditEventInput } from "@agentx/contracts";
import { SYSTEM_ACTOR, auditActorOf } from "../audit/plan3-hooks.js";
import { flushAuditEvents } from "../audit/flush.js";
import {
  auditOccurrence, auditRuleAccepted, auditRuleCorrectionRemembered, auditRuleDismissed, auditRuleNotApplied, auditRuleRolledBack, auditRuleSuggested, auditRuleWithdrawn,
} from "../audit/events.js";
import { auditedWrite } from "../playbook/project-settings-audit.js";
import type { LearningDeps, LearningScope } from "./store.js";

export type LearningTransactItem = Awaited<ReturnType<typeof auditedWrite>>["items"][number];

/** The pending items of the events, and the events (for the flush). `build` runs only where there is a ledger, and a builder that throws loses its event, not the action. */
export function learningEvents(deps: Pick<LearningDeps, "audit">, build: () => AuditEventInput[]): Promise<{ items: LearningTransactItem[]; events: AuditEventInput[] }> {
  return auditedWrite(deps.audit === undefined ? {} : { audit: deps.audit }, build);
}

/** After the commit: sends the events. Never throws. */
export function flushLearningEvents(deps: Pick<LearningDeps, "audit">, events: readonly AuditEventInput[]): Promise<void> {
  return events.length === 0 ? Promise.resolve() : flushAuditEvents(deps.audit === undefined ? {} : { audit: deps.audit }, [...events]);
}

const base = (deps: Pick<LearningDeps, "now">, scope: LearningScope, actor: AuditActor, occurrence: string) => ({
  orgId: scope.orgId, actor, occurredAt: new Date(deps.now()).toISOString(), occurrence, projectName: scope.project,
});

/** Rovara itself acts (grouping opens a suggestion; a suggestion is withdrawn because its sources went away). */
export const systemActor = (): AuditActor => SYSTEM_ACTOR;
export const memberActor = (developerId: string): AuditActor => auditActorOf(developerId);

export const suggestedEvent = (deps: Pick<LearningDeps, "now">, scope: LearningScope, input: { suggestionId: string; stage: string; sourceCount: number; sourceKinds: string; lessSafe: boolean; fromOnePerson: boolean }): AuditEventInput =>
  auditRuleSuggested({ ...base(deps, scope, systemActor(), input.suggestionId), ...input });

export const acceptedEvent = (deps: Pick<LearningDeps, "now">, scope: LearningScope, actor: AuditActor, input: {
  suggestionId: string; ruleId: string; stage: string; processAgentId: string; outcome: "published" | "awaiting_approval"; processVersion?: number; approvalId?: string; edited: boolean; lessSafe: boolean;
}): AuditEventInput => auditRuleAccepted({ ...base(deps, scope, actor, input.ruleId), ...input });

export const notAppliedEvent = (deps: Pick<LearningDeps, "now">, scope: LearningScope, input: { suggestionId: string; ruleId: string; approvalOutcome: "declined" | "expired" | "failed" }): AuditEventInput =>
  auditRuleNotApplied({ ...base(deps, scope, systemActor(), input.ruleId), ...input });

/** A person dismisses (`dismissKind` wrong, already_covered, one_off, other). Rovara's own withdrawals are `withdrawnEvent`, never this. */
export const dismissedEvent = (deps: Pick<LearningDeps, "now">, scope: LearningScope, actor: AuditActor, input: { suggestionId: string; stage: string; dismissKind: string }): AuditEventInput =>
  auditRuleDismissed({ ...base(deps, scope, actor, input.suggestionId), ...input });

/** Rovara withdraws a suggestion whose sources went away: the system acts, with a fixed cause. */
export type WithdrawCause = "forgotten" | "sources_gone" | "pr_capture_off" | "erased";
export const withdrawnEvent = (deps: Pick<LearningDeps, "now">, scope: LearningScope, input: { suggestionId: string; stage: string; cause: WithdrawCause }): AuditEventInput =>
  auditRuleWithdrawn({ ...base(deps, scope, systemActor(), input.suggestionId), ...input });

export const rolledBackEvent = (deps: Pick<LearningDeps, "now">, scope: LearningScope, actor: AuditActor, input: { ruleId: string; processAgentId: string; processVersion: number }): AuditEventInput =>
  auditRuleRolledBack({ ...base(deps, scope, actor, auditOccurrence(input.processAgentId, String(input.processVersion))), ...input });

export const rememberedEvent = (deps: Pick<LearningDeps, "now">, scope: LearningScope, actor: AuditActor, input: { correctionId: string; stage: string; standing: string; op: "remember" | "forget" }): AuditEventInput =>
  auditRuleCorrectionRemembered({ ...base(deps, scope, actor, input.correctionId), ...input });
