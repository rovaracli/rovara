// "How we work" H6: the audit events for the project settings that used to change without a record. This file holds the comparison ("what changed") and builds the events; the
// writers (the project definition registration, the Slack project model selection, the roster) only hand it the before and after and put the result in their own transaction.
//
// Facts are counts, revisions and flags (see `contracts/src/audit.ts`): never a model id, a label, a command or any text a person wrote.
import { canonicalJson } from "@rovara-code/contracts";
import { type AuditActor } from "@agentx/cloud-contracts";
import { type AuditEventInput } from "@agentx/cloud-contracts";
import { auditPending, tryAuditEvents, type AuditDeps, type TransactItem } from "../audit/outbox.js";
import {
  auditOccurrence,
  auditProjectLearningChanged,
  auditProjectChecksChanged,
  auditProjectE2ePolicyChanged,
  auditProjectModelSelectionChanged,
  auditProjectModelsChanged,
  auditProjectRosterChanged,
} from "../audit/events.js";

/** A model of the approved list as far as an audit cares: which model, at which thinking level, under which label. A stored check result (`lastCheck`) is not a setting. */
interface ModelLike { provider: string; modelId: string; thinkingLevel?: string | undefined; label?: string | undefined }

/** The parts of a project definition the three events look at. A registered revision and a definition about to be registered both fit. */
export interface AuditedDefinition {
  name: string;
  revision: number;
  models?: { default: ModelLike; approved: readonly ModelLike[] } | undefined;
  readiness?: readonly unknown[] | undefined;
  developerTasks?: { optionalWorkflowChecks?: readonly unknown[] | undefined } | undefined;
  e2e?: { capture?: Partial<Record<"screenshots" | "traces" | "video" | "downloads", boolean>> | undefined } | undefined;
}

/**
 * The events of a write and their pending items, to add to the write's own transaction. `build` runs only on an install with a ledger; if it throws, or an event is not valid, the write goes on
 * without that event (logged, no value). After the commit, `flushAuditEvents(deps, events)` sends them.
 */
export async function auditedWrite(deps: AuditDeps, build: () => AuditEventInput[]): Promise<{ items: TransactItem[]; events: AuditEventInput[] }> {
  const events = await tryAuditEvents(deps, build);
  return { items: events.flatMap((event) => auditPending(deps, event)), events };
}

interface EventBase { orgId: string; actor: AuditActor; occurredAt: string }

const modelOf = (model: ModelLike) => ({ provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinkingLevel ?? null, label: model.label ?? null });
/** The approved list without its order: which models are approved is the setting, not the order they are listed in. */
const approvedOf = (definition: AuditedDefinition | undefined): string[] => (definition?.models?.approved ?? []).map((model) => canonicalJson(modelOf(model))).sort();
const defaultOf = (definition: AuditedDefinition | undefined): string => canonicalJson(definition?.models === undefined ? null : { ...modelOf(definition.models.default), label: null });
const optionalChecksOf = (definition: AuditedDefinition | undefined): readonly unknown[] => {
  const checks = definition?.developerTasks?.optionalWorkflowChecks;
  return Array.isArray(checks) ? checks as readonly unknown[] : [];
};
const requiredChecksOf = (definition: AuditedDefinition | undefined): readonly unknown[] => definition?.readiness ?? [];
const captureOf = (definition: AuditedDefinition | undefined) => {
  const capture = definition?.e2e?.capture;
  return { screenshots: capture?.screenshots === true, traces: capture?.traces === true, video: capture?.video === true, downloads: capture?.downloads === true };
};
const same = (left: unknown, right: unknown): boolean => canonicalJson(left ?? null) === canonicalJson(right ?? null);

/**
 * The events for one project definition revision, against the revision before it (`undefined` for a project's first: it is compared with a project that sets none of these, so it records
 * only what it configures). Each event is for an area the revision changed; one revision can change several, and then all of them are returned, with the one occurrence of the revision
 * (the event ids differ by action). The counts and flags are of the new revision.
 */
export function projectDefinitionAuditEvents(input: EventBase & { before: AuditedDefinition | undefined; after: AuditedDefinition }): AuditEventInput[] {
  const { before, after } = input;
  const base = { orgId: input.orgId, actor: input.actor, occurredAt: input.occurredAt, occurrence: auditOccurrence(after.name, String(after.revision)), projectName: after.name, revision: after.revision };
  const events: AuditEventInput[] = [];
  const defaultChanged = defaultOf(before) !== defaultOf(after);
  if (defaultChanged || !same(approvedOf(before), approvedOf(after))) {
    events.push(auditProjectModelsChanged({ ...base, approvedCount: after.models?.approved.length ?? 0, defaultChanged }));
  }
  if (!same(requiredChecksOf(before), requiredChecksOf(after)) || !same(optionalChecksOf(before), optionalChecksOf(after))) {
    events.push(auditProjectChecksChanged({ ...base, requiredCount: requiredChecksOf(after).length, optionalCount: optionalChecksOf(after).length }));
  }
  if (!same(captureOf(before), captureOf(after))) events.push(auditProjectE2ePolicyChanged({ ...base, ...captureOf(after) }));
  return events;
}

/** `project.roster_changed` for one agent added or removed. `requestId` is the roster change's request (a retry of the write is the same occurrence); without one the time stands in. */
export function rosterAuditEvent(input: EventBase & { project: string; agentId: string; change: "added" | "removed"; requestId: string | undefined }): AuditEventInput {
  return auditProjectRosterChanged({
    orgId: input.orgId, actor: input.actor, occurredAt: input.occurredAt, occurrence: auditOccurrence(input.project, input.agentId, input.change, input.requestId ?? input.occurredAt),
    projectName: input.project, added: input.change === "added" ? 1 : 0, removed: input.change === "removed" ? 1 : 0,
  });
}

/** `project.model_selection_changed`. `surface` is where the selection was made (`slack`, `app`, `cli`); `requestId` is the request that made it. */
export function modelSelectionAuditEvent(input: EventBase & { project: string; surface: "slack" | "app" | "cli"; cleared: boolean; requestId: string }): AuditEventInput {
  return auditProjectModelSelectionChanged({
    orgId: input.orgId, actor: input.actor, occurredAt: input.occurredAt, occurrence: auditOccurrence(input.project, input.surface, input.requestId),
    projectName: input.project, surface: input.surface, cleared: input.cleared,
  });
}

/** B8: the project setting and this one summary event commit together. */
export function learningSettingsAuditEvent(input: EventBase & { project: string; revision: number; enabled: boolean; selfConfirmedSoleOwner: boolean }): AuditEventInput {
  return auditProjectLearningChanged({ ...input, projectName: input.project, occurrence: auditOccurrence(input.project, String(input.revision)) });
}
