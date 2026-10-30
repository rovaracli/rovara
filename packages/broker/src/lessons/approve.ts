// Learning v2 L3a: approving, rejecting and rolling back lessons (design §4.5.3, owner decision Q2). Who must approve is set by the tier and the policy:
// tier 0 applies by itself (mode On), tier 1 needs one maintainer, tier 2 needs two (a second maintainer or admin). Eligibility comes from the project's
// maintainers and How-we-work editors (`ApproverDirectory`); the second-person rule is the existing `decideSecondPersonApproval`, so the sole-owner exception
// and its 24-hour cool-off behave as they do for every other less-safe change.
//
// The approvals inbox: a lesson waiting for people is a `LESSON#` item in the lesson store, listed by `listWaiting`. Registering it as a subject kind in
// the shared approvals engine (agents/approvals-store.ts) so it also shows in the generic inbox is wiring pending; see the report.
import { randomUUID } from "node:crypto";
import { decideSecondPersonApproval } from "../org/second-person-approval.js";
import { cleanForLearning, requestsCapabilityChange } from "./guards.js";
import { expiryWindowMs } from "./expiry.js";
import { approversRequired, emitAudit, modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { ApproverDirectory, LessonDeps } from "./ports.js";
import { retireLesson } from "./curate.js";
import { nextVersion, type LessonStore, type ScopeKey } from "./store.js";
import { classifyTier } from "./tier.js";
import type { Lesson, Tier } from "./types.js";

export interface ApproveDeps extends LessonDeps { store: LessonStore; directory: ApproverDirectory; settings: LearningSettingsReader }

export type ApprovalFailure =
  | "not_found" | "not_pending" | "mode_off" | "not_eligible" | "already_approved" | "author_cannot_approve_alone"
  | "second_person_required" | "sole_owner_cool_off" | "eligibility_unavailable" | "capability_request" | "conflict" | "tier_never";
export type ApprovalResult =
  | { ok: true; status: "active" | "pending"; lesson: Lesson; needs: "nothing" | "second_person" | "group_member" }
  | { ok: false; code: ApprovalFailure };

const MAX_TRIES = 3;

/** Makes a lesson live: status active, expiry set, approvals recorded, and the lesson it supersedes retired. One conditional commit per attempt. */
export async function activateLesson(deps: LessonDeps & { store: LessonStore }, key: ScopeKey, lesson: Lesson, approvals: Lesson["approvals"], expiryDays: number | undefined, action: "lesson.activated" | "lesson.auto_applied"): Promise<Lesson | undefined> {
  const now = deps.now();
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const fresh = await deps.store.get(key, lesson.id);
    if (fresh === undefined || (fresh.status !== "pending" && fresh.status !== "candidate")) return undefined;
    const setVersion = await deps.store.setVersion(key);
    const next: Lesson = {
      ...fresh, version: nextVersion(fresh, await deps.store.versions(key, fresh.id)), status: "active", approvals: [...approvals],
      expiresAt: now + expiryWindowMs(fresh.type, expiryDays), updatedAt: now,
    };
    delete (next as { pendingExpiresAt?: number }).pendingExpiresAt;
    const writes = [next];
    if (fresh.supersedes !== undefined) {
      const old = await deps.store.get(key, fresh.supersedes);
      if (old !== undefined && old.status === "active") writes.push({ ...old, version: nextVersion(old, await deps.store.versions(key, old.id)), status: "retired", updatedAt: now });
    }
    const result = await deps.store.commit(key, setVersion, writes, now);
    if (result.ok) {
      await emitAudit(deps.audit, { action, workspaceId: key.workspaceId, project: key.project, lessonId: fresh.id, facts: { tier: fresh.tier, approvals: approvals.length, ...(fresh.supersedes === undefined ? {} : { supersedes: fresh.supersedes }) } });
      return next;
    }
  }
  return undefined;
}

export interface ApproveInput { workspaceId: string; project: string; lessonId: string; approverId: string; edit?: { title: string; description: string; body: string } }

export async function approveLesson(deps: ApproveDeps, input: ApproveInput): Promise<ApprovalResult> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.mode, "load")) return { ok: false, code: "mode_off" };

  const group = await deps.directory.eligibility(key.workspaceId, key.project).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!group.eligibleIds.includes(input.approverId)) return { ok: false, code: "not_eligible" };

  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const lesson = await deps.store.get(key, input.lessonId);
    if (lesson === undefined) return { ok: false, code: "not_found" };
    if (lesson.status !== "pending") return { ok: false, code: "not_pending" };

    // Edit and approve: the edited text is cleaned and screened, and the tier is worked out again on it.
    let working: Lesson = lesson;
    let approvals = [...lesson.approvals];
    if (input.edit !== undefined) {
      const title = cleanForLearning(input.edit.title, 80);
      const description = cleanForLearning(input.edit.description, 160);
      const body = cleanForLearning(input.edit.body, 600);
      if (title === "" || body === "" || requestsCapabilityChange(title, description, body)) return { ok: false, code: "capability_request" };
      working = { ...lesson, title, description, body };
      const decision = classifyTier(working, { contradiction: lesson.contradictsWith !== undefined });
      if (decision.tier === "never") return { ok: false, code: "tier_never" };
      working = { ...working, tier: decision.tier, tierReasons: decision.reasons };
      // A person's edit is a new lesson text: approvals given to the old text do not carry over, and a higher tier needs its people again.
      approvals = [];
    }

    if (approvals.some((a) => a.by === input.approverId)) return { ok: false, code: "already_approved" };
    const tier: Tier = working.tier;
    const required = approversRequired(tier, resolved.approval);
    const soleAuthor = working.provenance.authors.length === 1 ? working.provenance.authors[0] : undefined;
    let mode: Lesson["approvals"][number]["mode"] = "one";

    if (required === 0) {
      // Policy says this tier applies by itself, but a person who is deciding anyway is accepted as the approval.
      mode = "one";
    } else if (required === 1) {
      if (soleAuthor === input.approverId && group.eligibleIds.length > 1) return { ok: false, code: "author_cannot_approve_alone" };
      if (soleAuthor === input.approverId) {
        const decision = trySecondPerson(group, input.approverId, input.approverId, deps.now());
        if (!decision.ok) return decision;
        mode = "sole_owner_exception";
      }
    } else if (approvals.length === 0) {
      // The first of two. If this person is the only eligible one, the sole-owner exception may let them finish alone.
      if (group.eligibleIds.length === 1) {
        const decision = trySecondPerson(group, input.approverId, input.approverId, deps.now());
        if (!decision.ok) return decision;
        mode = "sole_owner_exception";
      }
    } else {
      const first = approvals[0]!;
      const decision = trySecondPerson(group, first.by, input.approverId, deps.now());
      if (!decision.ok) return decision;
      mode = decision.mode;
    }

    const now = deps.now();
    const given = { approvalId: (deps.newId ?? randomUUID)(), by: input.approverId, at: now, mode };
    approvals = [...approvals, given];
    const complete = mode === "sole_owner_exception" || approvals.length >= Math.max(required, 1);
    const inGroup = resolved.approval.requiredGroup === undefined || approvals.some((a) => (group.groups?.[resolved.approval.requiredGroup!] ?? []).includes(a.by));
    await emitAudit(deps.audit, { action: "lesson.approved", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.approverId, facts: { tier, mode, count: approvals.length } });
    if (mode === "sole_owner_exception") await emitAudit(deps.audit, { action: "lesson.sole_owner_exception", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.approverId, facts: { tier } });

    if (complete && inGroup) {
      // The edited text must be saved with the activation: write the edit first as a version of the pending lesson when there is one.
      if (input.edit !== undefined) {
        const setVersion = await deps.store.setVersion(key);
        const saved = await deps.store.commit(key, setVersion, [{ ...working, version: nextVersion(lesson, await deps.store.versions(key, lesson.id)), updatedAt: now }], now);
        if (!saved.ok) continue;
      }
      const active = await activateLesson(deps, key, working, approvals, resolved.expiryDays, "lesson.activated");
      if (active === undefined) continue;
      return { ok: true, status: "active", lesson: active, needs: "nothing" };
    }
    // Not complete: keep the lesson pending with this approval.
    const setVersion = await deps.store.setVersion(key);
    const saved: Lesson = { ...working, version: nextVersion(lesson, await deps.store.versions(key, lesson.id)), approvals, updatedAt: now };
    const result = await deps.store.commit(key, setVersion, [saved], now);
    if (!result.ok) continue;
    return { ok: true, status: "pending", lesson: saved, needs: complete ? "group_member" : "second_person" };
  }
  return { ok: false, code: "conflict" };
}

function trySecondPerson(group: Awaited<ReturnType<ApproverDirectory["eligibility"]>>, proposerId: string, approverId: string, nowMs: number):
  | { ok: true; mode: "second_person" | "sole_owner_exception" } | { ok: false; code: ApprovalFailure } {
  try {
    const decision = decideSecondPersonApproval({
      proposerId, approverId, nowMs, complete: group.complete, membershipVersion: group.membershipVersion, ownerIds: group.ownerIds, eligibleIds: group.eligibleIds, lastEligibleLossAtMs: group.lastEligibleLossAtMs,
    });
    return { ok: true, mode: decision.mode };
  } catch (error) {
    const reason = (error as { soleOwner?: { reasonCode?: string } }).soleOwner?.reasonCode;
    return { ok: false, code: reason === "SOLE_OWNER_COOL_OFF" ? "sole_owner_cool_off" : reason === "SECOND_PERSON_REQUIRED" ? "second_person_required" : "eligibility_unavailable" };
  }
}

async function decideOnce(deps: ApproveDeps, input: { workspaceId: string; project: string; lessonId: string; actorId: string; allowed: readonly Lesson["status"][]; to: "rejected" | "retired"; reason: string; action: "lesson.rejected" | "lesson.retired" }): Promise<{ ok: true } | { ok: false; code: ApprovalFailure }> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const group = await deps.directory.eligibility(key.workspaceId, key.project).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!group.eligibleIds.includes(input.actorId)) return { ok: false, code: "not_eligible" };
  const lesson = await deps.store.get(key, input.lessonId);
  if (lesson === undefined) return { ok: false, code: "not_found" };
  if (!input.allowed.includes(lesson.status)) return { ok: false, code: "not_pending" };
  if (input.to === "retired") return (await retireLesson(deps, key, lesson.id, input.reason, input.actorId, "lesson.retired")) ? { ok: true } : { ok: false, code: "conflict" };
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const fresh = await deps.store.get(key, lesson.id);
    if (fresh === undefined || fresh.status !== "pending") return { ok: false, code: "not_pending" };
    const setVersion = await deps.store.setVersion(key);
    const result = await deps.store.commit(key, setVersion, [{ ...fresh, version: nextVersion(fresh, await deps.store.versions(key, fresh.id)), status: "rejected", rejectedReason: cleanForLearning(input.reason, 200), updatedAt: deps.now() }], deps.now());
    if (result.ok) {
      await emitAudit(deps.audit, { action: input.action, workspaceId: key.workspaceId, project: key.project, lessonId: fresh.id, actor: input.actorId, facts: {} });
      return { ok: true };
    }
  }
  return { ok: false, code: "conflict" };
}

/** A maintainer rejects a pending lesson. The reason is kept (cleaned), and a similar lesson is not proposed again. */
export const rejectLesson = (deps: ApproveDeps, input: { workspaceId: string; project: string; lessonId: string; approverId: string; reason: string }) =>
  decideOnce(deps, { ...input, actorId: input.approverId, allowed: ["pending"], to: "rejected", reason: input.reason, action: "lesson.rejected" });

/** A maintainer retires a lesson (active, stale or pending). Always possible for an eligible person: this is the kill switch (C14). */
export const retireByPerson = (deps: ApproveDeps, input: { workspaceId: string; project: string; lessonId: string; actorId: string; reason: string }) =>
  decideOnce(deps, { ...input, allowed: ["active", "stale", "pending", "candidate"], to: "retired", action: "lesson.retired" });

/** Restores an earlier lesson-set version (design §4.6). Audited `lesson.rolled_back`. */
export async function rollbackLessonSet(deps: ApproveDeps, input: { workspaceId: string; project: string; targetSetVersion: number; actorId: string }): Promise<{ ok: true; setVersion: number } | { ok: false; code: ApprovalFailure }> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const group = await deps.directory.eligibility(key.workspaceId, key.project).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!group.eligibleIds.includes(input.actorId)) return { ok: false, code: "not_eligible" };
  const current = await deps.store.setVersion(key);
  const result = await deps.store.rollback(key, input.targetSetVersion, current, deps.now());
  if (!result.ok) return { ok: false, code: "conflict" };
  await emitAudit(deps.audit, { action: "lesson.rolled_back", workspaceId: key.workspaceId, project: key.project, actor: input.actorId, facts: { to: input.targetSetVersion, from: current } });
  return { ok: true, setVersion: result.setVersion };
}

/** The lessons waiting for people, for the Lessons tab and the Home card. Newest first. */
export async function listWaiting(store: LessonStore, key: ScopeKey): Promise<Lesson[]> {
  return (await store.list(key, { statuses: ["pending"] })).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
