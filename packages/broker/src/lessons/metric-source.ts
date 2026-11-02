// Learning v2 metric (metric.ts): what it reads today, from records that already exist. Read-only.
//   - `v12CorrectionSource`: the v1.2 loop's corrections (`CORRECTION#` items): who gave them (standing), on which task, when, and the repeat the grouping step already found. Its text may
//     already be gone (it is removed once a correction's rule is accepted), so what is compared is the salted word signature, which stays.
//   - `signatureMatcher`: a matcher that needs no model and no text: two corrections, or a correction and a lesson, are the same when their signatures are similar and neither says "never"
//     where the other does not (the v1.2 rule). It is a floor, and the curator's embedding matcher can replace it behind the same port.
// Nothing here writes. A correction that has no signature cannot be compared, so the matcher throws and the metric reports it as unjudged rather than guessing.
import { LearningCorrectionSchema } from "@agentx/contracts";
import { learningSalt } from "../learning/standing.js";
import { NEGATED, compareSignatures, signatureOf, type Signature } from "../learning/similarity.js";
import { readLearningPartition, type LearningDeps, type LearningScope } from "../learning/store.js";
import { cleanForLearning } from "./guards.js";
import type { CorrectionKind, Embedder } from "./ports.js";
import type { CorrectionMatcher, CorrectionRecord, CorrectionSource, EmbeddingBudget } from "./metric.js";

const KIND: Record<string, CorrectionKind> = { send_back: "send_back", comment: "review_comment", pr_comment: "review_comment" };
const PAGE = 200;
const MAX_PAGES = 50;
/** Erased people's corrections keep this author (the v1.2 erase); they are not counted. */
const ERASED_AUTHOR = "erased";

export function v12CorrectionSource(deps: LearningDeps, scope: LearningScope): CorrectionSource {
  return {
    async list(key, range, limit) {
      // The scope is the project the source was built for: a key for any other organisation or project reads nothing.
      if (key.workspaceId !== scope.orgId || key.project !== scope.project) return { corrections: [], truncated: false };
      const corrections: CorrectionRecord[] = [];
      // Sort keys are `CORRECTION#<iso time>#<id>`, oldest first: start just before the range, stop at its end.
      let cursor: string | undefined = `CORRECTION#${new Date(range.since).toISOString()}`;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const read = await readLearningPartition(deps, scope, { prefix: "CORRECTION#", ...(cursor === undefined ? {} : { cursor }), maxItems: PAGE, maxPages: 1, pageSize: PAGE });
        for (const item of read.items) {
          const parsed = LearningCorrectionSchema.safeParse(item);
          if (!parsed.success) continue;
          const c = parsed.data;
          const at = Date.parse(c.createdAt);
          if (!Number.isFinite(at) || at < range.since) continue;
          if (at >= range.until) return { corrections, truncated: false };
          if (corrections.length >= limit) return { corrections, truncated: true };
          corrections.push({
            id: c.id, taskId: c.taskId, at, kind: KIND[c.source] ?? "send_back", member: c.standing === "member" && c.author !== ERASED_AUTHOR,
            signature: c.signature, ...(c.repeatOf === undefined ? {} : { repeatOf: c.repeatOf }),
          });
        }
        cursor = read.cursor;
        if (cursor === undefined) return { corrections, truncated: false };
      }
      return { corrections, truncated: true };
    },
  };
}

const sameSignature = (a: Signature, b: Signature): boolean => a.includes(NEGATED) === b.includes(NEGATED) && compareSignatures(a, b).similar;

export function signatureMatcher(scope: Pick<LearningScope, "orgId" | "project" | "projectCreatedAt">): CorrectionMatcher {
  const salt = learningSalt(scope);
  const need = (c: CorrectionRecord): Signature => {
    if (c.signature === undefined || c.signature.length === 0) throw new Error("no signature");
    return c.signature;
  };
  return {
    async sameAsCorrection(earlier, later) { return sameSignature(need(earlier), need(later)); },
    async sameAsLesson(correction, lesson) { return sameSignature(need(correction), signatureOf(cleanForLearning(`${lesson.title}\n${lesson.description}\n${lesson.body}`, 1000), salt)); },
  };
}

const cosine = (a: readonly number[], b: readonly number[]): number => {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

/**
 * The curator's kind of matcher: two corrections, or a correction and a lesson, are the same advice when their embeddings are at least `threshold` alike and neither says "never" where the other
 * does not. Every vector comes through the measurement's `EmbeddingBudget` (each distinct text once, a hard cap on calls). A correction whose text is gone cannot be embedded: it throws and the
 * metric reports it as unjudged.
 */
export function embeddingMatcher(budget: EmbeddingBudget, embedder: Embedder, options: { threshold: number }): CorrectionMatcher {
  const textOf = (c: CorrectionRecord): string => {
    if (c.text === undefined || c.text.trim() === "") throw new Error("no text");
    return cleanForLearning(c.text, 1000);
  };
  const negated = (text: string): boolean => /\b(never|don'?t|do not|must not|avoid)\b/iu.test(text);
  const same = async (a: string, b: string): Promise<boolean> =>
    negated(a) === negated(b) && cosine(await budget.embed(embedder, a), await budget.embed(embedder, b)) >= options.threshold;
  return {
    sameAsCorrection: (earlier, later) => same(textOf(earlier), textOf(later)),
    sameAsLesson: (correction, lesson) => same(textOf(correction), cleanForLearning(`${lesson.title}\n${lesson.description}\n${lesson.body}`, 1000)),
  };
}
