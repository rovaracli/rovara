// Design review stage (DR8, design-review-stage.md 3.5 "Company layer"): the company's lock on a project's design review setting. A lock can only make the setting STRICTER (the M8 rule):
//   - force a mode other than `never` (`auto` or `always`; `always` is the stricter),
//   - set `allowSkip` to false,
//   - raise the tier (a floor),
//   - lower the cap ceiling,
//   - name the high-risk approver group.
// A project can never loosen it. Two places enforce that, and both fail closed:
//   - `checkAgainstLock` refuses a project's write that is looser than the lock, naming only the field;
//   - `effectiveDesignReviewSetting` clamps whatever is stored to the lock, so a lock added AFTER a project chose something looser still holds from then on.
// A lock that is stored but cannot be read is never read as "no lock": the effective setting is then the strictest posture (always, no skipping), and a write is refused.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { TransactItem } from "../audit/outbox.js";
import { DESIGN_REVIEW_FAIL_CLOSED_SETTING, markEffective, type EffectiveDesignReviewSetting } from "./effective-setting.js";
import {
  DESIGN_REVIEW_CAP_MAX_USD, DESIGN_REVIEW_CAP_MIN_USD, DESIGN_REVIEW_DEFAULT_SETTING, DESIGN_REVIEW_TIERS, DesignReviewTierSchema, designReviewSettingOf, featureEnabled, orgMetaKey,
  type DesignReviewSetting, type EditionPolicy,
} from "@agentx/contracts";

/** The lock the company set. Every field is optional: an absent field locks nothing. Strict, so a typo is not a silently ignored lock. */
export const DesignReviewLockSchema = z.object({
  /** The setting's mode may not be below this: `auto` forbids `never`; `always` forces `always`. `never` is not a lock (it would be the loosest). */
  mode: z.enum(["auto", "always"]).optional(),
  /** The setting's tier may not be below this. */
  tierAtLeast: DesignReviewTierSchema.optional(),
  /** `false` takes away the Skip button for every project. There is no `true`: a lock that allows something locks nothing. */
  allowSkip: z.literal(false).optional(),
  /** The setting's cap per task may not be above this. */
  capCeilingUsd: z.number().min(DESIGN_REVIEW_CAP_MIN_USD).max(DESIGN_REVIEW_CAP_MAX_USD).optional(),
  /** The high-risk approver is this group, in every project. Enterprise only. */
  approverGroupId: z.string().min(1).max(100).optional(),
}).strict();
export type DesignReviewLock = z.infer<typeof DesignReviewLockSchema>;

/** What reading the company's lock gave: none, a lock, or one that is stored but unreadable (never the same as none). */
export type DesignReviewLockRead = { kind: "none" } | { kind: "lock"; lock: DesignReviewLock; /** The lock item's revision at the read. A write that depends on this read is conditional on it (M3). */ revision: number } | { kind: "unreadable" };

export const DESIGN_REVIEW_LOCK_SK = "DESIGNREVIEW#LOCK";
export interface DesignReviewLockTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

/** The condition a write puts on the lock item so that a lock set after the read refuses the write (M3). `none`: the item must still not exist; a lock: its revision must be the one read. Unreadable has none (a write is refused). */
export function lockRevisionCheck(table: DesignReviewLockTable, orgId: string, read: DesignReviewLockRead): TransactItem | undefined {
  const Key = { pk: orgMetaKey(orgId).pk, sk: DESIGN_REVIEW_LOCK_SK };
  if (read.kind === "none") return { ConditionCheck: { TableName: table.tableName, Key, ConditionExpression: "attribute_not_exists(pk)" } };
  if (read.kind === "lock") return { ConditionCheck: { TableName: table.tableName, Key, ConditionExpression: "#revision = :lockRevision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":lockRevision": read.revision } } };
  return undefined;
}

/**
 * Reads the company's lock from the State table beside its other settings. A missing item is no lock; an item whose `lock` does not parse, that is not an object, or that has no whole-number `revision`
 * (the lock's writer bumps it on every write) is `unreadable` (fail closed). A failed read is the caller's to handle: it must not be taken for "no lock".
 */
export async function readDesignReviewLock(table: DesignReviewLockTable, orgId: string): Promise<DesignReviewLockRead> {
  const found = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: { pk: orgMetaKey(orgId).pk, sk: DESIGN_REVIEW_LOCK_SK }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  if (found.Item === undefined) return { kind: "none" };
  const parsed = DesignReviewLockSchema.safeParse(found.Item["lock"]);
  const revision = found.Item["revision"];
  return parsed.success && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? { kind: "lock", lock: parsed.data, revision } : { kind: "unreadable" };
}

const MODE_RANK = { never: 0, auto: 1, always: 2 } as const;
const TIER_RANK = Object.fromEntries(DESIGN_REVIEW_TIERS.map((tier, index) => [tier, index])) as Record<DesignReviewSetting["tier"], number>;

export { DESIGN_REVIEW_FAIL_CLOSED_SETTING };

/** A field a write was refused on, named by its path only (never a value). */
export type LockViolation = "designReview.mode" | "designReview.tier" | "designReview.allowSkip" | "designReview.capUsdPerTask" | "designReview.highRiskApprover";

/** The fields of `setting` that are looser than the lock. Empty: the setting holds the lock. */
export function lockViolations(setting: DesignReviewSetting, lock: DesignReviewLock): LockViolation[] {
  const found: LockViolation[] = [];
  if (lock.mode !== undefined && MODE_RANK[setting.mode] < MODE_RANK[lock.mode]) found.push("designReview.mode");
  if (lock.tierAtLeast !== undefined && TIER_RANK[setting.tier] < TIER_RANK[lock.tierAtLeast]) found.push("designReview.tier");
  if (lock.allowSkip === false && setting.allowSkip) found.push("designReview.allowSkip");
  if (lock.capCeilingUsd !== undefined && setting.capUsdPerTask > lock.capCeilingUsd) found.push("designReview.capUsdPerTask");
  if (lock.approverGroupId !== undefined && !(setting.highRiskApprover.kind === "group" && setting.highRiskApprover.groupId === lock.approverGroupId)) found.push("designReview.highRiskApprover");
  return found;
}

/** The setting made to hold the lock: each locked field moves to the lock's value when it is looser, and never the other way. Pure. */
export function applyLock(setting: DesignReviewSetting, lock: DesignReviewLock): DesignReviewSetting {
  return {
    mode: lock.mode !== undefined && MODE_RANK[setting.mode] < MODE_RANK[lock.mode] ? lock.mode : setting.mode,
    tier: lock.tierAtLeast !== undefined && TIER_RANK[setting.tier] < TIER_RANK[lock.tierAtLeast] ? lock.tierAtLeast : setting.tier,
    allowSkip: lock.allowSkip === false ? false : setting.allowSkip,
    capUsdPerTask: lock.capCeilingUsd !== undefined ? Math.min(setting.capUsdPerTask, lock.capCeilingUsd) : setting.capUsdPerTask,
    highRiskApprover: lock.approverGroupId !== undefined ? { kind: "group", groupId: lock.approverGroupId } : setting.highRiskApprover,
  };
}

/** The fields the lock holds fixed, for the page: a locked field cannot be changed by the project. */
export function lockedFields(lock: DesignReviewLock): LockViolation[] {
  return [
    ...(lock.mode === undefined ? [] : ["designReview.mode" as const]),
    ...(lock.tierAtLeast === undefined ? [] : ["designReview.tier" as const]),
    ...(lock.allowSkip === undefined ? [] : ["designReview.allowSkip" as const]),
    ...(lock.capCeilingUsd === undefined ? [] : ["designReview.capUsdPerTask" as const]),
    ...(lock.approverGroupId === undefined ? [] : ["designReview.highRiskApprover" as const]),
  ];
}

/**
 * The setting a task runs with: the project's (or the owner's defaults) held to the company's lock. An unreadable lock gives the strictest posture. Pure.
 * `setting` is what `designReviewSettingOf(playbook)` gave, or `undefined` for a playbook whose setting could not be read (also strictest).
 */
export function effectiveDesignReviewSetting(playbook: { designReview?: DesignReviewSetting | undefined }, lock: DesignReviewLockRead): EffectiveDesignReviewSetting {
  const own = designReviewSettingOf(playbook);
  // An unreadable lock may have set anything, so every field it could hold is clamped to the strictest known value (L1): always on, no skipping, the default cap at most, the default tier at least,
  // and the maintainers as the approver (a project's own named people could be exactly who the lock was written to replace).
  if (lock.kind === "unreadable") {
    return markEffective({
      ...applyLock(own, { mode: "always", allowSkip: false, tierAtLeast: DESIGN_REVIEW_DEFAULT_SETTING.tier, capCeilingUsd: DESIGN_REVIEW_DEFAULT_SETTING.capUsdPerTask }),
      highRiskApprover: { kind: "maintainers" },
    });
  }
  return markEffective(lock.kind === "lock" ? applyLock(own, lock.lock) : own);
}

/** What the page shows when a lock names a group in an edition without groups (L2). */
export const DESIGN_REVIEW_LOCK_GROUP_EDITION = "group locks need the Enterprise edition";

/**
 * Whether the company may save this lock (L2). A lock that names an approver group is refused in an edition without groups (Public, or an unknown edition): applied there it would leave every high-risk
 * design waiting on `group_not_available` with nobody able to skip it. The lock's writer calls this before it writes.
 */
export function checkDesignReviewLockWrite(lock: DesignReviewLock, edition: EditionPolicy | undefined): { ok: true } | { ok: false; reason: "group_not_available"; message: string } {
  if (lock.approverGroupId !== undefined && (edition === undefined || !featureEnabled(edition, "groups"))) return { ok: false, reason: "group_not_available", message: DESIGN_REVIEW_LOCK_GROUP_EDITION };
  return { ok: true };
}

export type DesignReviewWriteCheck = { ok: true } | { ok: false; reason: "locked"; fields: LockViolation[] } | { ok: false; reason: "lock_unreadable" } | { ok: false; reason: "group_not_available" };

/**
 * Whether a project may save this setting. Refused when it is looser than the company's lock (the fields are named, never the values), when the lock cannot be read, or when it names a group in an
 * edition without groups (Public). `edition` absent is read as "no groups" (fail closed).
 */
export function checkDesignReviewWrite(setting: DesignReviewSetting, lock: DesignReviewLockRead, edition: EditionPolicy | undefined): DesignReviewWriteCheck {
  if (setting.highRiskApprover.kind === "group" && (edition === undefined || !featureEnabled(edition, "groups"))) return { ok: false, reason: "group_not_available" };
  if (lock.kind === "unreadable") return { ok: false, reason: "lock_unreadable" };
  if (lock.kind === "lock") {
    const fields = lockViolations(setting, lock.lock);
    if (fields.length > 0) return { ok: false, reason: "locked", fields };
  }
  return { ok: true };
}
