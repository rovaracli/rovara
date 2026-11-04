// Learning v2: the learning mode, the approval policy and the edition caps (design §1.2, §4.5.3, §4.8.2 C10/C14; owner decisions Q2 and Q8).
import { z } from "zod";
import { approversRequired as sharedApproversRequired } from "../org/approval-by-risk.js";
import type { LessonAuditEvent, LessonAuditSink } from "./ports.js";
import type { Tier } from "./types.js";

/** Off: nothing is captured or loaded. Collect: the record is filled, nothing is loaded. Suggest: lessons are made and every one needs a person. On: lessons are made and loaded; a tier-0 lesson goes live by itself ONLY if the project sets `tier0Approval: "auto"`, otherwise one person approves it first. */
export const LEARNING_MODES = ["Off", "Collect", "Suggest", "On"] as const;
export type LearningMode = (typeof LEARNING_MODES)[number];
export const LearningModeSchema = z.enum(LEARNING_MODES);
export type ModeAction = "capture" | "reflect" | "load" | "auto_apply";
const ALLOWED: Record<LearningMode, readonly ModeAction[]> = {
  Off: [], Collect: ["capture"], Suggest: ["capture", "reflect", "load"], On: ["capture", "reflect", "load", "auto_apply"],
};
export const modeAllows = (mode: LearningMode, action: ModeAction): boolean => ALLOWED[mode].includes(action);

/**
 * Approval by tier, as a policy a project (or a company, on Enterprise) can change. The pilot default (owner 2026-10-31, replacing Q2 auto-apply) is that a
 * person approves every lesson: tier 0 and tier 1 need one maintainer, reviewer, check and security lessons (tier 2) need a second maintainer or admin.
 * Tier 0 can go live by itself only when `tier0Approval` is set to "auto". Tier 2 can never go below two people: the schema has no value for it.
 */
export const ApprovalPolicySchema = z.object({
  /** "auto": goes live by itself (mode On only). "one" or "two": a person, or two, must approve it first. */
  tier0: z.enum(["auto", "one", "two"]),
  tier1: z.enum(["one", "two"]),
  /** Enterprise: a named group that must be among the approvers of tier 1 and tier 2 lessons. */
  requiredGroup: z.string().min(1).max(100).optional(),
}).strict();
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
/**
 * THE switch for the pilot: how a tier-0 lesson (a cited, rendered, corroborated fact) goes live. "auto": by itself, audited (owner decision Q2). "one": only after one
 * person approves it, on every path (ingest, rollback, resume). A project or company can set `tier0Approval` in its learning settings; this is the default when it does not.
 */
export type Tier0Approval = "auto" | "one" | "two";
export const TIER0_APPROVAL_DEFAULT: Tier0Approval = "one";
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { tier0: TIER0_APPROVAL_DEFAULT, tier1: "one" };
/** What the project runs with when nothing is set (Q2). A company lock or a project setting may choose another mode. */
export const DEFAULT_LEARNING_MODE: LearningMode = "On";

/** The rule is shared with the design review stage and lives in `org/approval-by-risk.ts`; lessons call it from here as before. */
export const approversRequired: (tier: Tier, policy: ApprovalPolicy) => 0 | 1 | 2 = sharedApproversRequired;

export type Edition = "enterprise" | "public";
/** Spend caps for learning. Enterprise has none: only the customer's own spend limits apply (decision Q8). Public keeps the caps. An absent value is no cap. */
export interface LearningCaps { perTaskUsd?: number; perNightUsd?: number }
export function learningCaps(edition: Edition, override?: LearningCaps): LearningCaps {
  if (edition === "enterprise") return {};
  return { perTaskUsd: 0.15, perNightUsd: 2, ...override };
}
/**
 * No flat caps on lessons, in either edition (owner decision "Lesson limits"). Every candidate is collected and queued, never dropped. What guards the queue
 * is per-source spike detection: a source whose daily count reaches SPIKE_MULTIPLE times its own learned baseline (and at least SPIKE_MINIMUM that day) is
 * paused alone, and the maintainer is alerted. Other sources carry on.
 */
export const SPIKE = { multiple: 10, minimum: 10, baselineDays: 14, baselineFloor: 1, projectMinimum: 30 } as const;

/**
 * Two brakes on tier-0 AUTO-APPLY (L7-2; controller default, owner may change; they matter only where automatic go-live is on, which it is not by default):
 * - project brake: after the project's volume alert fires, a tier-0 lesson goes to the one-tap queue (a person decides) for the next `brakeMs`. No source is paused by it.
 * - cold start: a source (a member, a channel, CI) with fewer than `coldStartLessons` lessons that a PERSON approved cannot auto-apply a lesson; its first nine wait for a person.
 */
export const AUTO_APPLY_GUARDS = { brakeMs: 86_400_000, coldStartLessons: 9 } as const;

export const MIN_EXPIRY_DAYS = 14;
export const MAX_EXPIRY_DAYS = 365;
export const DEFAULT_EXPIRY_DAYS = 90;
export const PREFERENCE_EXPIRY_DAYS = 180;

export interface LearningSettings {
  /** The project's own choice; absent means the default. */
  mode?: LearningMode;
  /** The company's lock (owner decision M8): it can only make the project stricter. The effective mode is the more restrictive of the lock and the project's own choice. */
  companyLock?: LearningMode;
  /** The company's approval floor: a project can ask for more approvers than this, never fewer, and cannot drop a required group set here. */
  companyApproval?: Partial<ApprovalPolicy>;
  approval?: Partial<ApprovalPolicy>;
  /** The named switch for tier-0 approval ("auto" | "one"); `approval.tier0` still wins when set. Unset: TIER0_APPROVAL_DEFAULT. A company floor can only make it "one". */
  tier0Approval?: Tier0Approval;
  expiryDays?: number;
}
export interface LearningSettingsReader { read(workspaceId: string, project: string): Promise<LearningSettings> }

/** `requiredGroups` holds every group that must be among the approvers: the company floor's and the project's own, both. */
export interface ResolvedLearning { mode: LearningMode; approval: ApprovalPolicy; requiredGroups: string[]; expiryDays: number | undefined }
const MODE_ORDER: readonly LearningMode[] = ["Off", "Collect", "Suggest", "On"];
/** The more restrictive mode: Off is the strictest, On the loosest. */
export const stricterMode = (a: LearningMode, b: LearningMode): LearningMode => (MODE_ORDER.indexOf(a) <= MODE_ORDER.indexOf(b) ? a : b);
const LEVEL: Record<ApprovalPolicy["tier0"], number> = { auto: 0, one: 1, two: 2 };
const NAMES = ["auto", "one", "two"] as const;
function stricterApproval(project: ApprovalPolicy, floor: ApprovalPolicy, hasFloor: boolean): ApprovalPolicy {
  if (!hasFloor) return project;
  const tier0 = NAMES[Math.max(LEVEL[project.tier0], LEVEL[floor.tier0])]!;
  const tier1 = NAMES[Math.max(LEVEL[project.tier1], LEVEL[floor.tier1], 1)] as ApprovalPolicy["tier1"];
  const requiredGroup = floor.requiredGroup ?? project.requiredGroup;
  return { tier0, tier1, ...(requiredGroup === undefined ? {} : { requiredGroup }) };
}
/**
 * THE gate on automatic go-live (review item 6, tidy round 2). While it says no (the default, and the state for the whole pilot) a tier-0 "auto" is never honoured, whatever wrote it
 * (an old row, a hand edit, a bug, a future reader): `resolveLearning`, which every consumer of the settings goes through, reads it as "one". The broker sets the gate once at start-up
 * (`setAutoApplyGate`) with the same function it gives `Tier0Deps.autoApplyEnabled`; it is asked at every resolve, so turning it off takes effect at once.
 */
let autoApplyGate: () => boolean = () => false;
export function setAutoApplyGate(gate: () => boolean): void { autoApplyGate = gate; }
const clampAuto = <T extends string | undefined>(level: T): T | "one" => (level === "auto" ? "one" : level);
/** The settings with every tier-0 "auto" read as "one". Pure. */
export function clampAutoApply(settings: LearningSettings): LearningSettings {
  return {
    ...settings,
    ...(settings.tier0Approval === undefined ? {} : { tier0Approval: clampAuto(settings.tier0Approval) }),
    ...(settings.approval === undefined ? {} : { approval: { ...settings.approval, ...(settings.approval.tier0 === undefined ? {} : { tier0: clampAuto(settings.approval.tier0) }) } }),
    ...(settings.companyApproval === undefined ? {} : { companyApproval: { ...settings.companyApproval, ...(settings.companyApproval.tier0 === undefined ? {} : { tier0: clampAuto(settings.companyApproval.tier0) }) } }),
  };
}

/** Reads the settings and fails closed: a reader that throws, or settings that do not parse, give mode Off. */
export async function resolveLearning(reader: LearningSettingsReader, workspaceId: string, project: string): Promise<ResolvedLearning> {
  const off: ResolvedLearning = { mode: "Off", approval: DEFAULT_APPROVAL_POLICY, requiredGroups: [], expiryDays: undefined };
  let settings: LearningSettings;
  // No settings row is the default (an undefined result), not a failure; a reader that throws fails closed.
  try { settings = (await reader.read(workspaceId, project)) ?? {}; } catch { return off; }
  if (!autoApplyGate()) settings = clampAutoApply(settings);
  const own = LearningModeSchema.safeParse(settings.mode ?? DEFAULT_LEARNING_MODE);
  const lock = settings.companyLock === undefined ? undefined : LearningModeSchema.safeParse(settings.companyLock);
  if (!own.success || (lock !== undefined && !lock.success)) return off;
  const mode = { success: true as const, data: lock === undefined ? own.data : stricterMode(own.data, lock.data) };
  const projectApproval = ApprovalPolicySchema.safeParse({ ...DEFAULT_APPROVAL_POLICY, tier0: settings.tier0Approval ?? TIER0_APPROVAL_DEFAULT, ...(settings.approval ?? {}) });
  const floor = ApprovalPolicySchema.safeParse({ ...DEFAULT_APPROVAL_POLICY, ...(settings.companyApproval ?? {}) });
  if (!projectApproval.success || !floor.success) return off;
  const approval = { success: true as const, data: stricterApproval(projectApproval.data, floor.data, settings.companyApproval !== undefined) };
  const days = settings.expiryDays;
  if (days !== undefined && (!Number.isInteger(days) || days < MIN_EXPIRY_DAYS || days > MAX_EXPIRY_DAYS)) return off;
  return { mode: mode.data, approval: approval.data, requiredGroups: [...new Set([floor.data.requiredGroup, projectApproval.data.requiredGroup].filter((g): g is string => g !== undefined))], expiryDays: days };
}

const SAFE_FACT = /^[A-Za-z0-9:_\-.#@/]{1,128}$/u;
/** Writes an audit event whose facts hold ids, counts and fixed codes only (the v1.2 rule): a string value that is not id-shaped is dropped. */
function safeFacts(event: LessonAuditEvent): LessonAuditEvent {
  const facts: LessonAuditEvent["facts"] = {};
  for (const [key, value] of Object.entries(event.facts)) if (typeof value !== "string" || SAFE_FACT.test(value)) facts[key] = value;
  return { ...event, facts };
}
/** Best-effort audit, for bookkeeping that grants nothing (counters, candidates, refusals, retire). An outage never blocks learning. */
export async function emitAudit(sink: LessonAuditSink, event: LessonAuditEvent): Promise<void> {
  try { await sink.emit(safeFacts(event)); } catch { /* bookkeeping only */ }
}
/**
 * Audit that must succeed before a change that GRANTS something (an approval, a go-live, a promotion, a rollback). The event is written before the change,
 * and a failed write returns false so the caller refuses the change (fail closed). The kill switches (retire) use `emitAudit`, so they always work.
 */
export async function requireAudit(sink: LessonAuditSink, event: LessonAuditEvent): Promise<boolean> {
  try { await sink.emit(safeFacts(event), { required: true }); return true; } catch { return false; }
}
