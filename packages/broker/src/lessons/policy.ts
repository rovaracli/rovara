// Learning v2: the learning mode, the approval policy and the edition caps (design §1.2, §4.5.3, §4.8.2 C10/C14; owner decisions Q2 and Q8).
import { z } from "zod";
import type { LessonAuditEvent, LessonAuditSink } from "./ports.js";
import type { Tier } from "./types.js";

/** Off: nothing is captured or loaded. Collect: the record is filled, nothing is loaded. Suggest: lessons are made and every one needs a person. On: tier 0 goes live by itself. */
export const LEARNING_MODES = ["Off", "Collect", "Suggest", "On"] as const;
export type LearningMode = (typeof LEARNING_MODES)[number];
export const LearningModeSchema = z.enum(LEARNING_MODES);
export type ModeAction = "capture" | "reflect" | "load" | "auto_apply";
const ALLOWED: Record<LearningMode, readonly ModeAction[]> = {
  Off: [], Collect: ["capture"], Suggest: ["capture", "reflect", "load"], On: ["capture", "reflect", "load", "auto_apply"],
};
export const modeAllows = (mode: LearningMode, action: ModeAction): boolean => ALLOWED[mode].includes(action);

/**
 * Approval by tier, as a policy a project (or a company, on Enterprise) can change. The default is the owner's decision Q2: cited low-risk facts
 * (tier 0) apply by themselves and are re-checked against the code before every use; broad lessons (tier 1) need one maintainer; reviewer, check and
 * security lessons (tier 2) need a second maintainer or admin. Tier 2 can never go below two people: the schema has no value for it.
 */
export const ApprovalPolicySchema = z.object({
  /** "auto": goes live by itself (mode On only). "one" or "two": a person, or two, must approve it first. */
  tier0: z.enum(["auto", "one", "two"]),
  tier1: z.enum(["one", "two"]),
  /** Enterprise: a named group that must be among the approvers of tier 1 and tier 2 lessons. */
  requiredGroup: z.string().min(1).max(100).optional(),
}).strict();
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { tier0: "auto", tier1: "one" };
/** What the project runs with when nothing is set (Q2). A company lock or a project setting may choose another mode. */
export const DEFAULT_LEARNING_MODE: LearningMode = "On";

export function approversRequired(tier: Tier, policy: ApprovalPolicy): 0 | 1 | 2 {
  if (tier === 2) return 2;
  const level = tier === 0 ? policy.tier0 : policy.tier1;
  return level === "auto" ? 0 : level === "one" ? 1 : 2;
}

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
/** Reads the settings and fails closed: a reader that throws, or settings that do not parse, give mode Off. */
export async function resolveLearning(reader: LearningSettingsReader, workspaceId: string, project: string): Promise<ResolvedLearning> {
  const off: ResolvedLearning = { mode: "Off", approval: DEFAULT_APPROVAL_POLICY, requiredGroups: [], expiryDays: undefined };
  let settings: LearningSettings;
  try { settings = await reader.read(workspaceId, project); } catch { return off; }
  const own = LearningModeSchema.safeParse(settings.mode ?? DEFAULT_LEARNING_MODE);
  const lock = settings.companyLock === undefined ? undefined : LearningModeSchema.safeParse(settings.companyLock);
  if (!own.success || (lock !== undefined && !lock.success)) return off;
  const mode = { success: true as const, data: lock === undefined ? own.data : stricterMode(own.data, lock.data) };
  const projectApproval = ApprovalPolicySchema.safeParse({ ...DEFAULT_APPROVAL_POLICY, ...(settings.approval ?? {}) });
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
  try { await sink.emit(safeFacts(event)); return true; } catch { return false; }
}
