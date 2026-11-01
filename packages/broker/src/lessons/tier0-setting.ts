// Learning v2 wiring (LR-W3): the one place that writes the tier-0 approval setting (how a tier-0 lesson goes live), at project level (`tier0Approval`) and at company level (the
// floor, `companyApproval.tier0`). Owner decision 2026-10-31: tier-0 lessons need one person's OK for the pilot; automatic go-live comes back only after the "Before auto-apply is
// turned on" list passes review.
//
//  - A STRICTER (or equal) write (auto to one or two, one to two) applies at once, by an eligible maintainer or admin.
//  - ANY loosening (two to one, one to auto, two to auto; at project level or as the company floor) never applies as a direct write (controller decision 2026-10-31, owner decision M8:
//    projects loosen through their normal approval steps). It opens a proposal; a DIFFERENT eligible maintainer or admin approves it. The proposer cannot approve their own change
//    while anyone else is eligible. The one exception is the shared sole-owner exception (`org/second-person-approval.ts`, the same rule lesson approval uses): when the proposer is the
//    ONLY eligible person and nobody eligible left or was removed in the last 24 hours, they approve alone, and the audit records mode "sole_owner_exception". Within 24 hours the
//    answer is "sole_owner_cool_off" with the time it opens. A company setting (`soleOwnerLoosening`, default ON) turns the exception off for loosening (owner decision 2026-11-01,
//    "One-admin companies"; replaces "there is no sole-owner path for loosening"). A setting that cannot be read counts as OFF.
//  - Nothing loosens TO "auto" while automatic go-live is not enabled (`autoApplyEnabled`), whoever approves.
//  - Every write is conditional on the value it was made against: a stricter write made in between is never overwritten (the result is "stale").
//  - A company floor can only be stricter: a project value below the floor is refused, at request and again at approval.
//  - Fail closed: an unknown value, eligibility that is incomplete or cannot be read, a stale proposal (the value moved), an expired one, or an audit event that cannot be written stops
//    the change. The audit event is written BEFORE a loosening is applied; a stricter write is never blocked by an audit outage (the kill-switch side).
import { randomUUID } from "node:crypto";
import { requireAudit, emitAudit, TIER0_APPROVAL_DEFAULT } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import { trySecondPersonTimed } from "./approve.js";
import { idIn, sameId } from "./types.js";

export type Tier0Level = "auto" | "one" | "two";
const LEVEL: Record<Tier0Level, number> = { auto: 0, one: 1, two: 2 };
const isLevel = (value: unknown): value is Tier0Level => value === "auto" || value === "one" || value === "two";

export type Tier0Scope = { kind: "project"; workspaceId: string; project: string } | { kind: "company"; workspaceId: string };
/** What a proposal to loosen the setting says. `from` is the value it was made against: an approval after the value moved is stale. */
export interface Tier0Change {
  id: string; scope: Tier0Scope; from: Tier0Level; to: Tier0Level; proposedBy: string; at: number; expiresAt: number;
  state: "pending" | "applied" | "cancelled";
  /**
   * True when the proposer was the ONLY eligible person when they proposed. Only such a proposal can be approved by its proposer through the sole-owner exception: one made while another
   * eligible person existed is not turned into a self-approval by that person leaving later (the proposer cancels it and proposes again). Absent (an older row) counts as false.
   */
  soleEligibleAtProposal?: boolean;
}
export const TIER0_CHANGE_TTL_MS = 7 * 86_400_000;

/** The stored value of one scope: the project's `tier0Approval`, or the company floor. Undefined when none was ever set. */
export interface Tier0SettingsStore {
  read(scope: Tier0Scope): Promise<Tier0Level | undefined>;
  /**
   * Writes only if the stored value is still `from` (an absent value counts as the default). False: it moved, and nothing was written.
   * With a `fence` the write also commits only if the membership the decision rested on still holds (the same transaction, so a person added or removed between the eligibility
   * read and this write stops it): the store carries `fence.conditions` into its commit. A store that cannot honour a fence must refuse (throw), never ignore it.
   */
  write(scope: Tier0Scope, value: Tier0Level, meta: { by: string; at: number }, from: Tier0Level, fence?: Tier0Fence): Promise<boolean>;
}
export interface Tier0ChangeStore {
  /** False when the id is taken. */
  create(change: Tier0Change): Promise<boolean>;
  get(scope: Tier0Scope, id: string): Promise<Tier0Change | undefined>;
  /** The scope's pending proposal that has not expired, if any. */
  open(scope: Tier0Scope, now: number): Promise<Tier0Change | undefined>;
  /** Moves a change from one state to another only if it is still in `from`; true when it moved (the one claim that stops two approvers racing). */
  transition(scope: Tier0Scope, id: string, from: Tier0Change["state"], to: Tier0Change["state"]): Promise<boolean>;
}
/** What a decision rested on: the membership generation, and the opaque commit conditions (`readSecondPersonApprovalEvidence`'s) that pin both people's live authority. */
export interface Tier0Fence { membershipVersion: number; conditions?: readonly unknown[] }
export interface Tier0Group { complete: boolean; membershipVersion: number; ownerIds: string[]; eligibleIds: string[]; lastEligibleLossAtMs: number | null; /** Commit conditions for the writes that rest on this answer. */ fence?: readonly unknown[] }
/** Who may change the setting: the project's maintainers and admins, or the company's admins. `who` names the proposer and the approver the answer is for (the same person when one acts alone). */
export interface Tier0Authority {
  eligibility(scope: Tier0Scope, who: { proposerId: string; approverId: string }): Promise<Tier0Group>;
}
const fenceOf = (group: Tier0Group): Tier0Fence => ({ membershipVersion: group.membershipVersion, ...(group.fence === undefined ? {} : { conditions: group.fence }) });
export interface Tier0Deps {
  settings: Tier0SettingsStore; changes: Tier0ChangeStore; audit: LessonAuditSink; authority: Tier0Authority; now(): number;
  /** Whether automatic go-live may be switched on at all. False until the "Before auto-apply is turned on" list has passed review. */
  autoApplyEnabled(): boolean;
  /** The company setting that allows the sole-owner exception for loosening (default ON when never set). Asked only when a person approves their own loosening; a throw counts as OFF. */
  soleOwnerLoosening(workspaceId: string): Promise<boolean>;
  newId?: () => string;
}

export type Tier0Failure =
  | "invalid_value" | "not_eligible" | "eligibility_unavailable" | "below_company_floor" | "auto_apply_not_enabled" | "already_open" | "audit_unavailable"
  | "not_found" | "not_pending" | "expired" | "stale" | "second_person_required" | "sole_owner_cool_off" | "conflict";
export type Tier0Request = { ok: true; status: "applied"; value: Tier0Level } | { ok: true; status: "needs_approval"; changeId: string } | { ok: false; code: Tier0Failure };

const NO_PROJECT = "_workspace";
const projectOf = (scope: Tier0Scope): string => (scope.kind === "project" ? scope.project : NO_PROJECT);
const sameScope = (a: Tier0Scope, b: Tier0Scope): boolean => a.kind === b.kind && a.workspaceId === b.workspaceId && projectOf(a) === projectOf(b);

/** The value in force for a scope: the stored one, else the default (a project: `TIER0_APPROVAL_DEFAULT`; the company floor: none, which is "auto"). */
async function currentOf(deps: Tier0Deps, scope: Tier0Scope): Promise<Tier0Level> {
  const stored = await deps.settings.read(scope);
  return stored ?? (scope.kind === "project" ? TIER0_APPROVAL_DEFAULT : "auto");
}
/** The company floor ("auto" when there is none). A project cannot go below it. */
async function floorOf(deps: Tier0Deps, scope: Tier0Scope): Promise<Tier0Level> {
  return (await deps.settings.read({ kind: "company", workspaceId: scope.workspaceId })) ?? "auto";
}
/** Whether the company allows the sole-owner exception for loosening. A reader that fails counts as OFF. */
async function soleOwnerAllowed(deps: Tier0Deps, scope: Tier0Scope): Promise<boolean> {
  try { return (await deps.soleOwnerLoosening(scope.workspaceId)) === true; } catch { return false; }
}
async function groupOf(deps: Tier0Deps, scope: Tier0Scope, who: { proposerId: string; approverId: string }) {
  const group = await deps.authority.eligibility(scope, who).catch(() => undefined);
  return group !== undefined && group.complete ? group : undefined;
}

export async function requestTier0Change(deps: Tier0Deps, input: { scope: Tier0Scope; value: Tier0Level; requestedBy: string }): Promise<Tier0Request> {
  const { scope, value } = input;
  if (!isLevel(value)) return { ok: false, code: "invalid_value" };
  const group = await groupOf(deps, scope, { proposerId: input.requestedBy, approverId: input.requestedBy });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.requestedBy)) return { ok: false, code: "not_eligible" };
  const current = await currentOf(deps, scope);
  if (scope.kind === "project" && LEVEL[value] < LEVEL[await floorOf(deps, scope)]) return { ok: false, code: "below_company_floor" };
  const at = deps.now();
  const event = (action: "lesson.tier0_setting_changed" | "lesson.tier0_setting_proposed", extra: Record<string, string> = {}) => ({
    action, workspaceId: scope.workspaceId, project: projectOf(scope), actor: input.requestedBy, facts: { scope: scope.kind, from: current, to: value, ...extra },
  });
  if (LEVEL[value] >= LEVEL[current]) {
    // Stricter or equal: applied now, against the value it was read at. An audit outage never blocks the stricter side.
    if (!(await deps.settings.write(scope, value, { by: input.requestedBy, at }, current, fenceOf(group)))) return { ok: false, code: "stale" };
    await emitAudit(deps.audit, event("lesson.tier0_setting_changed", { mode: "direct" }));
    return { ok: true, status: "applied", value };
  }
  // A loosening: a proposal. Going to "auto" also needs automatic go-live to be switched on at all.
  if (value === "auto" && !deps.autoApplyEnabled()) return { ok: false, code: "auto_apply_not_enabled" };
  if ((await deps.changes.open(scope, at)) !== undefined) return { ok: false, code: "already_open" };
  const id = (deps.newId ?? (() => randomUUID()))();
  if (!(await requireAudit(deps.audit, event("lesson.tier0_setting_proposed", { changeId: id })))) return { ok: false, code: "audit_unavailable" };
  const created = await deps.changes.create({ id, scope, from: current, to: value, proposedBy: input.requestedBy, at, expiresAt: at + TIER0_CHANGE_TTL_MS, state: "pending", soleEligibleAtProposal: group.eligibleIds.length === 1 });
  return created ? { ok: true, status: "needs_approval", changeId: id } : { ok: false, code: "conflict" };
}

export type Tier0ApproveResult = { ok: true; value: Tier0Level } | { ok: false; code: Tier0Failure; availableAt?: string };

export async function approveTier0Change(deps: Tier0Deps, input: { scope: Tier0Scope; changeId: string; approverId: string }): Promise<Tier0ApproveResult> {
  const { scope } = input;
  const change = await deps.changes.get(scope, input.changeId);
  // A change is read through its own scope: under another scope it does not exist.
  if (change === undefined || !sameScope(change.scope, scope)) return { ok: false, code: "not_found" };
  if (change.state !== "pending") return { ok: false, code: "not_pending" };
  const at = deps.now();
  if (change.expiresAt <= at) return { ok: false, code: "expired" };
  // The proposer approves their own change only through the sole-owner exception (below), however the id is spelled.
  const selfApproval = sameId(change.proposedBy, input.approverId);
  // ...and only for a proposal made while they were the only eligible person (a later departure does not turn an earlier proposal into a self-approval).
  if (selfApproval && change.soleEligibleAtProposal !== true) return { ok: false, code: "second_person_required" };
  const group = await groupOf(deps, scope, { proposerId: change.proposedBy, approverId: input.approverId });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.approverId)) return { ok: false, code: "not_eligible" };
  const decision = trySecondPersonTimed(group, change.proposedBy, input.approverId, at);
  if (!decision.ok) {
    if (decision.code === "eligibility_unavailable") return { ok: false, code: "eligibility_unavailable" };
    if (decision.code === "sole_owner_cool_off" && selfApproval && decision.availableAt !== undefined) {
      if (!(await soleOwnerAllowed(deps, scope))) return { ok: false, code: "second_person_required" };
      return { ok: false, code: "sole_owner_cool_off", availableAt: decision.availableAt };
    }
    return { ok: false, code: "second_person_required" };
  }
  // The exception is asked for only by a person approving their own change; a company can turn it off.
  if (decision.mode === "sole_owner_exception" && !(selfApproval && (await soleOwnerAllowed(deps, scope)))) return { ok: false, code: "second_person_required" };
  if (change.to === "auto" && !deps.autoApplyEnabled()) return { ok: false, code: "auto_apply_not_enabled" };
  // The world moved since the proposal: the value, or the company floor.
  if ((await currentOf(deps, scope)) !== change.from) return { ok: false, code: "stale" };
  if (scope.kind === "project" && LEVEL[change.to] < LEVEL[await floorOf(deps, scope)]) return { ok: false, code: "below_company_floor" };
  // The sole-owner exception is recorded before anything changes (as lesson approval does): if the record cannot be written, nothing is claimed or written.
  const soleFacts: Record<string, string | number | boolean> = decision.mode === "sole_owner_exception"
    ? { ownerCount: group.ownerIds.length, exceptionReason: "sole_owner_no_other_eligible_24h_clear" } : {};
  if (decision.mode === "sole_owner_exception" && !(await requireAudit(deps.audit, {
    action: "lesson.sole_owner_exception", workspaceId: scope.workspaceId, project: projectOf(scope), actor: input.approverId,
    facts: { scope: scope.kind, changeId: change.id, membershipVersion: group.membershipVersion, ...soleFacts },
  }))) return { ok: false, code: "audit_unavailable" };
  // One claim: of two approvers at once, only one moves the change out of pending.
  if (!(await deps.changes.transition(scope, change.id, "pending", "applied"))) return { ok: false, code: "not_pending" };
  // The write is conditional on the value the change was made against: a stricter write made since is never overwritten. A failed write throws (or is refused): the stricter value
  // stays in force (the safe side), the change is closed, and the proposer asks again. The write is also fenced on the membership the decision rested on (a person added or removed since the
  // eligibility read, or an approver who lost authority, stops it as "stale" the same way).
  if (!(await deps.settings.write(scope, change.to, { by: input.approverId, at }, change.from, fenceOf(group)))) {
    await deps.changes.transition(scope, change.id, "applied", "cancelled").catch(() => false);
    return { ok: false, code: "stale" };
  }
  // The audit event is written only now, once the claim and the write have succeeded, so a lost race never leaves a "changed" event. If it cannot be written the loosening is taken back
  // (conditionally: only if the value is still the one this approval wrote), and the change is closed: nothing loosened stays unaudited.
  const audited = await requireAudit(deps.audit, {
    action: "lesson.tier0_setting_changed", workspaceId: scope.workspaceId, project: projectOf(scope), actor: input.approverId,
    facts: { scope: scope.kind, from: change.from, to: change.to, mode: decision.mode, proposedBy: change.proposedBy, changeId: change.id, membershipVersion: group.membershipVersion, ...soleFacts },
  });
  if (!audited) {
    await deps.settings.write(scope, change.from, { by: input.approverId, at }, change.to).catch(() => false);
    await deps.changes.transition(scope, change.id, "applied", "cancelled").catch(() => false);
    return { ok: false, code: "audit_unavailable" };
  }
  return { ok: true, value: change.to };
}

/** An eligible maintainer or admin withdraws a pending proposal. */
export async function cancelTier0Change(deps: Tier0Deps, input: { scope: Tier0Scope; changeId: string; actorId: string }): Promise<{ ok: true } | { ok: false; code: Tier0Failure }> {
  const group = await groupOf(deps, input.scope, { proposerId: input.actorId, approverId: input.actorId });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.actorId)) return { ok: false, code: "not_eligible" };
  const change = await deps.changes.get(input.scope, input.changeId);
  if (change === undefined || !sameScope(change.scope, input.scope)) return { ok: false, code: "not_found" };
  if (!(await deps.changes.transition(input.scope, change.id, "pending", "cancelled"))) return { ok: false, code: "not_pending" };
  await emitAudit(deps.audit, { action: "lesson.tier0_setting_cancelled", workspaceId: input.scope.workspaceId, project: projectOf(input.scope), actor: input.actorId, facts: { changeId: change.id, scope: input.scope.kind } });
  return { ok: true };
}
