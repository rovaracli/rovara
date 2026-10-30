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
/** Safety rate limits (C10). They are not spend caps: they stop a compromised account from flooding the queue, so both editions keep them. */
export const RATE_LIMITS = { candidatesPerTask: 3, candidatesPerProjectPerDay: 20, candidatesPerAuthorPerDay: 10, burstMultiple: 3, burstMinimum: 6 } as const;

export const MIN_EXPIRY_DAYS = 14;
export const MAX_EXPIRY_DAYS = 365;
export const DEFAULT_EXPIRY_DAYS = 90;
export const PREFERENCE_EXPIRY_DAYS = 180;

export interface LearningSettings {
  /** The project's own choice; absent means the default. */
  mode?: LearningMode;
  /** The company's lock: when set, it wins over the project's mode. */
  companyLock?: LearningMode;
  approval?: Partial<ApprovalPolicy>;
  expiryDays?: number;
}
export interface LearningSettingsReader { read(workspaceId: string, project: string): Promise<LearningSettings> }

export interface ResolvedLearning { mode: LearningMode; approval: ApprovalPolicy; expiryDays: number | undefined }
/** Reads the settings and fails closed: a reader that throws, or settings that do not parse, give mode Off. */
export async function resolveLearning(reader: LearningSettingsReader, workspaceId: string, project: string): Promise<ResolvedLearning> {
  const off: ResolvedLearning = { mode: "Off", approval: DEFAULT_APPROVAL_POLICY, expiryDays: undefined };
  let settings: LearningSettings;
  try { settings = await reader.read(workspaceId, project); } catch { return off; }
  const mode = LearningModeSchema.safeParse(settings.companyLock ?? settings.mode ?? DEFAULT_LEARNING_MODE);
  const approval = ApprovalPolicySchema.safeParse({ ...DEFAULT_APPROVAL_POLICY, ...(settings.approval ?? {}) });
  if (!mode.success || !approval.success) return off;
  const days = settings.expiryDays;
  if (days !== undefined && (!Number.isInteger(days) || days < MIN_EXPIRY_DAYS || days > MAX_EXPIRY_DAYS)) return off;
  return { mode: mode.data, approval: approval.data, expiryDays: days };
}

const SAFE_FACT = /^[A-Za-z0-9:_\-.#@/]{1,128}$/u;
/** Writes an audit event whose facts hold ids, counts and fixed codes only (the v1.2 rule): a string value that is not id-shaped is dropped. */
export async function emitAudit(sink: LessonAuditSink, event: LessonAuditEvent): Promise<void> {
  const facts: LessonAuditEvent["facts"] = {};
  for (const [key, value] of Object.entries(event.facts)) if (typeof value !== "string" || SAFE_FACT.test(value)) facts[key] = value;
  try { await sink.emit({ ...event, facts }); } catch { /* an audit outage never blocks learning; the outbox retries */ }
}
