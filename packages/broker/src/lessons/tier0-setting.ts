// Learning v2 wiring (LR-W3): the one place that writes the tier-0 approval setting (how a tier-0 lesson goes live), at project level (`tier0Approval`) and at company level (the
// floor, `companyApproval.tier0`). Owner decision 2026-10-31: tier-0 lessons need one person's OK for the pilot; automatic go-live comes back only after the "Before auto-apply is
// turned on" list passes review.
//
//  - A STRICTER (or equal) write (auto to one or two, one to two) applies at once, by an eligible maintainer or admin.
//  - ANY loosening (two to one, one to auto, two to auto; at project level or as the company floor) never applies as a direct write (controller decision 2026-10-31, owner decision M8:
//    projects loosen through their normal approval steps). It opens a proposal; a DIFFERENT eligible maintainer or admin approves it. The proposer can never approve their own
//    change, and the sole-owner exception does not apply here (a team of one cannot loosen this on its own).
//  - Nothing loosens TO "auto" while automatic go-live is not enabled (`autoApplyEnabled`), whoever approves.
//  - Every write is conditional on the value it was made against: a stricter write made in between is never overwritten (the result is "stale").
//  - A company floor can only be stricter: a project value below the floor is refused, at request and again at approval.
//  - Fail closed: an unknown value, eligibility that is incomplete or cannot be read, a stale proposal (the value moved), an expired one, or an audit event that cannot be written stops
//    the change. The audit event is written BEFORE a loosening is applied; a stricter write is never blocked by an audit outage (the kill-switch side).
import { randomUUID } from "node:crypto";
import { requireAudit, emitAudit, TIER0_APPROVAL_DEFAULT } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import { trySecondPerson } from "./approve.js";
import { idIn, sameId } from "./types.js";

export type Tier0Level = "auto" | "one" | "two";
const LEVEL: Record<Tier0Level, number> = { auto: 0, one: 1, two: 2 };
const isLevel = (value: unknown): value is Tier0Level => value === "auto" || value === "one" || value === "two";

export type Tier0Scope = { kind: "project"; workspaceId: string; project: string } | { kind: "company"; workspaceId: string };
/** What a proposal to loosen the setting says. `from` is the value it was made against: an approval after the value moved is stale. */
export interface Tier0Change {
  id: string; scope: Tier0Scope; from: Tier0Level; to: Tier0Level; proposedBy: string; at: number; expiresAt: number;
  state: "pending" | "applied" | "cancelled";
}
export const TIER0_CHANGE_TTL_MS = 7 * 86_400_000;

/** The stored value of one scope: the project's `tier0Approval`, or the company floor. Undefined when none was ever set. */
export interface Tier0SettingsStore {
  read(scope: Tier0Scope): Promise<Tier0Level | undefined>;
  /** Writes only if the stored value is still `from` (an absent value counts as the default). False: it moved, and nothing was written. */
  write(scope: Tier0Scope, value: Tier0Level, meta: { by: string; at: number }, from: Tier0Level): Promise<boolean>;
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
/** Who may change the setting: the project's maintainers and admins, or the company's admins. */
export interface Tier0Authority {
  eligibility(scope: Tier0Scope): Promise<{ complete: boolean; membershipVersion: number; ownerIds: string[]; eligibleIds: string[]; lastEligibleLossAtMs: number | null }>;
}
export interface Tier0Deps {
  settings: Tier0SettingsStore; changes: Tier0ChangeStore; audit: LessonAuditSink; authority: Tier0Authority; now(): number;
  /** Whether automatic go-live may be switched on at all. False until the "Before auto-apply is turned on" list has passed review. */
  autoApplyEnabled(): boolean;
  newId?: () => string;
}

export type Tier0Failure =
  | "invalid_value" | "not_eligible" | "eligibility_unavailable" | "below_company_floor" | "auto_apply_not_enabled" | "already_open" | "audit_unavailable"
  | "not_found" | "not_pending" | "expired" | "stale" | "second_person_required" | "conflict";
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
async function groupOf(deps: Tier0Deps, scope: Tier0Scope) {
  const group = await deps.authority.eligibility(scope).catch(() => undefined);
  return group !== undefined && group.complete ? group : undefined;
}

export async function requestTier0Change(deps: Tier0Deps, input: { scope: Tier0Scope; value: Tier0Level; requestedBy: string }): Promise<Tier0Request> {
  const { scope, value } = input;
  if (!isLevel(value)) return { ok: false, code: "invalid_value" };
  const group = await groupOf(deps, scope);
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
    if (!(await deps.settings.write(scope, value, { by: input.requestedBy, at }, current))) return { ok: false, code: "stale" };
    await emitAudit(deps.audit, event("lesson.tier0_setting_changed", { mode: "direct" }));
    return { ok: true, status: "applied", value };
  }
  // A loosening: a proposal. Going to "auto" also needs automatic go-live to be switched on at all.
  if (value === "auto" && !deps.autoApplyEnabled()) return { ok: false, code: "auto_apply_not_enabled" };
  if ((await deps.changes.open(scope, at)) !== undefined) return { ok: false, code: "already_open" };
  const id = (deps.newId ?? (() => randomUUID()))();
  if (!(await requireAudit(deps.audit, event("lesson.tier0_setting_proposed", { changeId: id })))) return { ok: false, code: "audit_unavailable" };
  const created = await deps.changes.create({ id, scope, from: current, to: value, proposedBy: input.requestedBy, at, expiresAt: at + TIER0_CHANGE_TTL_MS, state: "pending" });
  return created ? { ok: true, status: "needs_approval", changeId: id } : { ok: false, code: "conflict" };
}

export async function approveTier0Change(deps: Tier0Deps, input: { scope: Tier0Scope; changeId: string; approverId: string }): Promise<{ ok: true; value: Tier0Level } | { ok: false; code: Tier0Failure }> {
  const { scope } = input;
  const change = await deps.changes.get(scope, input.changeId);
  // A change is read through its own scope: under another scope it does not exist.
  if (change === undefined || !sameScope(change.scope, scope)) return { ok: false, code: "not_found" };
  if (change.state !== "pending") return { ok: false, code: "not_pending" };
  const at = deps.now();
  if (change.expiresAt <= at) return { ok: false, code: "expired" };
  // The proposer never approves their own change, however the id is spelled; there is no sole-owner path for loosening.
  if (sameId(change.proposedBy, input.approverId)) return { ok: false, code: "second_person_required" };
  const group = await groupOf(deps, scope);
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.approverId)) return { ok: false, code: "not_eligible" };
  const decision = trySecondPerson(group, change.proposedBy, input.approverId, at);
  if (!decision.ok) return { ok: false, code: decision.code === "eligibility_unavailable" ? "eligibility_unavailable" : "second_person_required" };
  if (decision.mode !== "second_person") return { ok: false, code: "second_person_required" };
  if (change.to === "auto" && !deps.autoApplyEnabled()) return { ok: false, code: "auto_apply_not_enabled" };
  // The world moved since the proposal: the value, or the company floor.
  if ((await currentOf(deps, scope)) !== change.from) return { ok: false, code: "stale" };
  if (scope.kind === "project" && LEVEL[change.to] < LEVEL[await floorOf(deps, scope)]) return { ok: false, code: "below_company_floor" };
  if (!(await requireAudit(deps.audit, {
    action: "lesson.tier0_setting_changed", workspaceId: scope.workspaceId, project: projectOf(scope), actor: input.approverId,
    facts: { scope: scope.kind, from: change.from, to: change.to, mode: "second_person", proposedBy: change.proposedBy, changeId: change.id },
  }))) return { ok: false, code: "audit_unavailable" };
  // One claim: of two approvers at once, only one moves the change out of pending.
  if (!(await deps.changes.transition(scope, change.id, "pending", "applied"))) return { ok: false, code: "not_pending" };
  // The write is conditional on the value the change was made against: a stricter write made since is never overwritten. A failed write throws (or is refused): the stricter value
  // stays in force (the safe side), the change is closed, and the proposer asks again.
  if (!(await deps.settings.write(scope, change.to, { by: input.approverId, at }, change.from))) {
    await deps.changes.transition(scope, change.id, "applied", "cancelled").catch(() => false);
    return { ok: false, code: "stale" };
  }
  return { ok: true, value: change.to };
}

/** An eligible maintainer or admin withdraws a pending proposal. */
export async function cancelTier0Change(deps: Tier0Deps, input: { scope: Tier0Scope; changeId: string; actorId: string }): Promise<{ ok: true } | { ok: false; code: Tier0Failure }> {
  const group = await groupOf(deps, input.scope);
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.actorId)) return { ok: false, code: "not_eligible" };
  const change = await deps.changes.get(input.scope, input.changeId);
  if (change === undefined || !sameScope(change.scope, input.scope)) return { ok: false, code: "not_found" };
  if (!(await deps.changes.transition(input.scope, change.id, "pending", "cancelled"))) return { ok: false, code: "not_pending" };
  await emitAudit(deps.audit, { action: "lesson.tier0_setting_cancelled", workspaceId: input.scope.workspaceId, project: projectOf(input.scope), actor: input.actorId, facts: { changeId: change.id, scope: input.scope.kind } });
  return { ok: true };
}
