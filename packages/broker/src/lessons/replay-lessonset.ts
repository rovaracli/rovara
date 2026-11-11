// Lane 7: what the replay report says about an arm's FINAL lesson set: how many lessons, how many duplicates, how many unresolved contradictions. Pure and free (no model): the same word-by-word comparison the
// curator uses to keep a copy or a flipped copy apart (`copy-match.ts#relate`). A pair is a duplicate when the two say the same thing in the same words once filler is set aside; a contradiction when they are close in
// words but a negation, direction or number differs, and they reach the same place (a shared repository, or either has no repository).
import { createHash } from "node:crypto";
import type { ArmLessonSet } from "@rovara-code/contracts";
import { normalizedText, relate } from "./copy-match.js";
import type { Lesson } from "./types.js";

export type SetLesson = Pick<Lesson, "title" | "description" | "body" | "scope" | "status">;

const textOf = (lesson: Pick<Lesson, "title" | "body">): string => `${lesson.title}. ${lesson.body}`;

/** The key a lesson is matched by across arms and runs: a hash of its normalised words, so a reworded lesson is a different one. */
export function lessonContentKey(lesson: Pick<Lesson, "title" | "body">): string {
  return createHash("sha256").update(normalizedText(textOf(lesson))).digest("hex").slice(0, 24);
}

const sharePlace = (a: SetLesson, b: SetLesson): boolean => {
  const left = a.scope.repos ?? [], right = b.scope.repos ?? [];
  return left.length === 0 || right.length === 0 || left.some((repo) => right.includes(repo));
};

/** Counts the active lessons and the pairs among them that are copies or contradictions. A pair is counted once. */
export function summarizeLessonSet(arm: string, lessons: readonly SetLesson[]): ArmLessonSet {
  const active = lessons.filter((lesson) => lesson.status === "active");
  let duplicates = 0, contradictions = 0;
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i]!, b = active[j]!;
      const relation = relate(textOf(a), textOf(b));
      if (relation.near || relation.verbatim) duplicates += 1;
      else if (relation.flipped && sharePlace(a, b)) contradictions += 1;
    }
  }
  return { arm, size: active.length, duplicates, contradictions };
}
