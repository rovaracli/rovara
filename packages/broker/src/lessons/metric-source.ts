// Learning v2 metric (metric.ts): what it reads today, from records that already exist. Read-only.
//   - `v12CorrectionSource`: the v1.2 loop's corrections (`CORRECTION#` items): who gave them (standing), on which task, when, and the repeat the grouping step already found. Its text may
//     already be gone (it is removed once a correction's rule is accepted), so what is compared is the salted word signature, which stays.
//   - `signatureMatcher`: a matcher that needs no model and no text: two corrections, or a correction and a lesson, are the same when their signatures are similar and neither says "never"
//     where the other does not (the v1.2 rule). It is a floor: `fusedMatcher` (below) is the matcher for corrections whose text is still there, and falls back to this one for those whose text is gone.
// Nothing here writes. A correction that has no signature cannot be compared, so the matcher throws and the metric reports it as unjudged rather than guessing.
import { LearningCorrectionSchema } from "@rovara-code/contracts";
import { learningSalt } from "../learning/standing.js";
import { NEGATED, compareSignatures, signatureOf, type Signature } from "../learning/similarity.js";
import { readLearningPartition, type LearningDeps, type LearningScope } from "../learning/store.js";
import { cleanForLearning } from "./guards.js";
import { covers, relate } from "./copy-match.js";
import type { CorrectionKind, Embedder } from "./ports.js";
import type { CorrectionMatcher, CorrectionRecord, CorrectionSource, EmbeddingBudget, LessonFacts } from "./metric.js";
import { cosine, lessonTextOf, overlapOf, tokenSetOf } from "./similarity.js";

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

/** Two corrections are the same advice when this share of their words is common; a correction is in a lesson when this share of the correction's words is in the lesson. */
export const FUSED_SAME = { jaccard: 0.75, inLesson: 0.8, /** the share of the words that must also be in the other text in the same order (the set measures above ignore order) */ ordered: 0.75, /** the share of a correction's neighbouring word pairs that a lesson must also hold (two words swapped break them) */ pairs: 0.5, /** with the embedder: the cosine at which two texts are the same advice (bge-small scores unrelated text near 0.6) */ cosine: 0.9 } as const;

/**
 * The same fused matcher the curator and the loader use (lessons/similarity.ts), for the measure: two corrections, or a correction and a lesson, are the same advice when they say it in nearly the same words
 * (code-aware tokens: identifiers whole and split), or, where there is an embedder, when their vectors are at least `threshold` alike; and neither says "never" where the other does
 * not. Every vector comes through the measurement's `EmbeddingBudget` (each distinct text once, a hard cap on calls; no embedder: no calls). A failed embedding makes the correction unjudged, never "different".
 * A correction whose text is gone cannot be compared by words: it falls to `signature` (the v1.2 matcher) when it still has its signature, else it throws and the metric reports it as unjudged.
 */
export function fusedMatcher(budget: EmbeddingBudget, embedder: Embedder | undefined, options: { threshold?: number; signature?: CorrectionMatcher } = {}): CorrectionMatcher {
  const threshold = options.threshold ?? FUSED_SAME.cosine;
  const hasText = (c: CorrectionRecord): boolean => c.text !== undefined && c.text.trim() !== "";
  const textOf = (c: CorrectionRecord): string => {
    if (!hasText(c)) throw new Error("no text");
    return cleanForLearning(c.text!, 1000);
  };
  // The comparison is ORDERED and keeps every negation, direction word and number (copy-match.ts): "turn X on" and "turn X off", or two steps in the other order, are different advice however many words they share.
  // `check` returns false when the pair must never count as the same (a polarity, direction or number differs) and otherwise how well the first text's words appear in the second in the same order.
  type Check = (a: string, b: string) => { ok: boolean; ordered: number };
  const decide = async (a: string, b: string, check: Check, lexicalSame: (o: { containment: number; jaccard: number }) => boolean): Promise<boolean> => {
    const checked = check(a, b);
    if (!checked.ok) return false;
    const overlap = overlapOf(tokenSetOf(a), tokenSetOf(b));
    if (lexicalSame(overlap) && checked.ordered >= FUSED_SAME.ordered) return true;
    if (embedder === undefined) return false;
    return cosine(await budget.embed(embedder, a), await budget.embed(embedder, b)) >= threshold;
  };
  // Two corrections: neither is flipped against the other and they carry the same negations, directions and numbers.
  const betweenCorrections: Check = (a, b) => { const r = relate(a, b); return { ok: !r.flipped && r.polaritySame, ordered: r.ordered }; };
  // A correction against a lesson: every negation, direction word and number of the correction is in the lesson.
  const againstLesson: Check = (correction, lesson) => { const c = covers(correction, lesson); return { ok: c.polarityContained && c.pairs >= FUSED_SAME.pairs, ordered: c.ordered }; };
  const lessonText = (lesson: LessonFacts): string => cleanForLearning(lessonTextOf(lesson), 1000);
  return {
    sameAsCorrection: async (earlier, later) => (!hasText(earlier) || !hasText(later)) && options.signature !== undefined ? options.signature.sameAsCorrection(earlier, later) : decide(textOf(earlier), textOf(later), betweenCorrections, (o) => o.jaccard >= FUSED_SAME.jaccard),
    sameAsLesson: async (correction, lesson) => (!hasText(correction) && options.signature !== undefined ? options.signature.sameAsLesson(correction, lesson) : decide(textOf(correction), lessonText(lesson), againstLesson, (o) => o.containment >= FUSED_SAME.inLesson && o.jaccard > 0)),
  };
}
