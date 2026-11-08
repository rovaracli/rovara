// Learning v2: the learning preset (Standard / Regulated, DECISIONS 24) as a company or project setting.
//   Standard (the default): a low-risk lesson from a project member's own correction goes live on trial. Regulated: no trial, every lesson needs a person first.
// Stricter-only, like the mode lock: Regulated applies at once for an eligible maintainer or admin; a company's Regulated is a floor no project can go below. Going back to Standard is NOT a write
// here: loosening a lesson-approval setting needs a second person (the tier-0 rule), and that proposal flow is not built for the preset yet, so it is refused with a fixed code. The stored item
// names no person (the audit event does), so the person erase has nothing to rewrite.
import { emitAudit, LearningPresetSchema, DEFAULT_LEARNING_PRESET, type LearningPreset } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import { idIn } from "./types.js";

export type PresetScope = { kind: "project"; workspaceId: string; project: string } | { kind: "company"; workspaceId: string };

export interface PresetStore {
  /** The stored preset, or undefined when never set. A stored value that is not valid throws (the caller fails closed). */
  read(scope: PresetScope): Promise<LearningPreset | undefined>;
  write(scope: PresetScope, value: LearningPreset, at: number): Promise<void>;
}
export interface PresetDeps {
  store: PresetStore; audit: LessonAuditSink; now(): number;
  /** Who may change the setting: the project's maintainers and admins, or the company's admins. Incomplete means nobody. */
  eligibility(scope: PresetScope): Promise<{ complete: boolean; eligibleIds: readonly string[] }>;
}
export type PresetFailure = "invalid_value" | "not_eligible" | "eligibility_unavailable" | "loosening_not_supported";
export type PresetResult = { ok: true; changed: boolean; value: LearningPreset } | { ok: false; code: PresetFailure };

export async function setLearningPreset(deps: PresetDeps, input: { scope: PresetScope; value: unknown; requestedBy: string }): Promise<PresetResult> {
  const parsed = LearningPresetSchema.safeParse(input.value);
  if (!parsed.success) return { ok: false, code: "invalid_value" };
  const group = await deps.eligibility(input.scope).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.requestedBy)) return { ok: false, code: "not_eligible" };
  let current: LearningPreset;
  try { current = (await deps.store.read(input.scope)) ?? DEFAULT_LEARNING_PRESET; } catch { return { ok: false, code: "eligibility_unavailable" }; }
  if (parsed.data === current) return { ok: true, changed: false, value: current };
  if (parsed.data === "standard") return { ok: false, code: "loosening_not_supported" };
  await deps.store.write(input.scope, parsed.data, deps.now());
  // Stricter, so never blocked by an audit outage (the kill-switch side).
  await emitAudit(deps.audit, { action: "lesson.preset_changed", workspaceId: input.scope.workspaceId, project: input.scope.kind === "project" ? input.scope.project : "_workspace", actor: input.requestedBy, facts: { scope: input.scope.kind, from: current, to: parsed.data } });
  return { ok: true, changed: true, value: parsed.data };
}
