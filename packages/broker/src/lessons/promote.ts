// Learning v2 L3a: "Promote to How we work rule" (design §4.5.3). It turns one active lesson into exactly one paragraph and hands it to the same publish
// path the v1.2 Accept button uses (`acceptSuggestion` through `publishDraft`), which keeps its own less-safe checks. A lesson from a restricted source is
// never promoted (design Q14): a rule is read by everyone in the project.
import { cleanForLearning } from "./guards.js";
import { emitAudit, modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { ApproverDirectory, LessonDeps, RulePublisher } from "./ports.js";
import { nextVersion, type LessonStore, type ScopeKey } from "./store.js";
import { isRestricted, trustAtLeast, type Lesson } from "./types.js";

export interface PromoteDeps extends LessonDeps { store: LessonStore; directory: ApproverDirectory; settings: LearningSettingsReader; publisher: RulePublisher }
export type PromoteFailure = "not_found" | "not_active" | "restricted" | "not_trusted" | "not_eligible" | "eligibility_unavailable" | "mode_off" | "publish_failed" | "conflict";

/** One paragraph: the title as a sentence, then the body, on one line. No headings, lists or line breaks, so the rule is one paragraph (v1.2 rule I6). */
export function ruleParagraph(lesson: Pick<Lesson, "title" | "body">): string {
  const title = cleanForLearning(lesson.title, 80).replace(/\s+/gu, " ").replace(/[.!?]+$/u, "");
  const body = cleanForLearning(lesson.body, 600).replace(/\s+/gu, " ").replace(/^[#>*\-+\d.)\s]+/u, "");
  return `${title}. ${body}`.trim();
}

export async function promoteToRule(deps: PromoteDeps, input: { workspaceId: string; project: string; lessonId: string; approverId: string }): Promise<{ ok: true; ruleId: string; already: boolean } | { ok: false; code: PromoteFailure }> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.mode, "load")) return { ok: false, code: "mode_off" };
  const group = await deps.directory.eligibility(key.workspaceId, key.project).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!group.eligibleIds.includes(input.approverId)) return { ok: false, code: "not_eligible" };
  const lesson = await deps.store.get(key, input.lessonId);
  if (lesson === undefined) return { ok: false, code: "not_found" };
  if (lesson.promotedRuleId !== undefined) return { ok: true, ruleId: lesson.promotedRuleId, already: true };
  if (lesson.status !== "active") return { ok: false, code: "not_active" };
  if (isRestricted(lesson)) return { ok: false, code: "restricted" };
  if (!trustAtLeast(lesson.provenance.minTrust, "rovara")) return { ok: false, code: "not_trusted" };

  let published: { ruleId: string };
  try {
    published = await deps.publisher.publish({ workspaceId: key.workspaceId, project: key.project, paragraph: ruleParagraph(lesson), lessonId: lesson.id, approverId: input.approverId });
  } catch { return { ok: false, code: "publish_failed" }; }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = await deps.store.get(key, lesson.id);
    if (fresh === undefined) return { ok: false, code: "not_found" };
    if (fresh.promotedRuleId !== undefined) return { ok: true, ruleId: fresh.promotedRuleId, already: true };
    const setVersion = await deps.store.setVersion(key);
    const result = await deps.store.commit(key, setVersion, [{ ...fresh, version: nextVersion(fresh, await deps.store.versions(key, fresh.id)), promotedRuleId: published.ruleId.slice(0, 100), updatedAt: deps.now() }], deps.now());
    if (result.ok) {
      await emitAudit(deps.audit, { action: "lesson.promoted", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.approverId, facts: { rule: published.ruleId.slice(0, 100) } });
      return { ok: true, ruleId: published.ruleId, already: false };
    }
  }
  return { ok: false, code: "conflict" };
}
