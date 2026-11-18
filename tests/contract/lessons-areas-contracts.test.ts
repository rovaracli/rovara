// Lead 4 L4-LP3W: the Cloud copy of Code's `lessons-by-area.ts` contract. It is strict (an unknown field is refused), bounded, browser-safe, and its words and keys are pinned here because Cloud's server and screens repeat them.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LEARNING_SOURCE_KEYS, LEARNING_SOURCE_WORDS, LearningSourcePauseBodySchema, LearningSourcesAnswerSchema, LessonAreasAnswerSchema, TEAM_LESSONS_NOTE, TeamLessonRowSchema, TeamLessonsAnswerSchema,
} from "../../packages/contracts/src/app-lessons-areas.js";

const row = { id: "L-les_ok000001", lessonId: "les_ok000001", version: 1, type: "convention", statement: "Verify the webhook signature first", why: "A parse error causes a retry storm.", detail: "", scopeLabel: "repo api src/billing/**", trust: "team-approved" };
const team = { project: "payments", pageId: "m-api-src-billing-5285b1ad", area: { repo: "api", folder: "src/billing" }, lessons: [row], moreLessons: 0, note: TEAM_LESSONS_NOTE };

describe("team lessons", () => {
  it("reads the answer and its row, and refuses an unknown field, another trust word, a wrong id, a bad type and too many rows", () => {
    expect(TeamLessonsAnswerSchema.parse(team)).toEqual(team);
    for (const bad of [{ ...team, extra: 1 }, { ...team, note: "Follow these." }, { ...team, lessons: [{ ...row, trust: "team rule" }] }, { ...team, lessons: [{ ...row, id: "les_ok000001" }] }, { ...team, lessons: [{ ...row, type: "command" }] }, { ...team, lessons: [{ ...row, extra: true }] }, { ...team, lessons: Array.from({ length: 31 }, () => row) }, { ...team, moreLessons: -1 }]) {
      expect(TeamLessonsAnswerSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    expect(TeamLessonRowSchema.safeParse({ ...row, statement: "" }).success).toBe(false);
  });
  it("the note is the sentence both ends say", () => { expect(TEAM_LESSONS_NOTE).toBe("These are the team's approved lessons for this area. Agents are told them as notes, not commands, and the code wins when they disagree."); });
});

describe("where Rovara learns from", () => {
  const source = (key: string) => ({ key, ...LEARNING_SOURCE_WORDS[key as keyof typeof LEARNING_SOURCE_WORDS], seen: 1, suggested: 1, kept: 1, paused: false });
  it("has the six keys in order, each with its own words, and a strict answer", () => {
    expect([...LEARNING_SOURCE_KEYS]).toEqual(["task_decisions", "review_comments", "pr_edits", "remember", "after_merge", "ci"]);
    const answer = { project: "payments", windowDays: 30, canPause: true, sources: LEARNING_SOURCE_KEYS.map(source) };
    expect(LearningSourcesAnswerSchema.parse(answer)).toEqual(answer);
    for (const bad of [{ ...answer, windowDays: 7 }, { ...answer, extra: 1 }, { ...answer, sources: [{ ...source("ci"), key: "nope" }] }, { ...answer, sources: [{ ...source("ci"), seen: -1 }] }, { ...answer, sources: [{ ...source("ci"), example: { lessonId: "bad id", title: "x" } }] }]) {
      expect(LearningSourcesAnswerSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("the pause body is exactly one boolean", () => {
    expect(LearningSourcePauseBodySchema.safeParse({ paused: true }).success).toBe(true);
    for (const bad of [{}, { paused: "yes" }, { paused: true, extra: 1 }]) expect(LearningSourcePauseBodySchema.safeParse(bad).success).toBe(false);
  });
});

describe("the area tree", () => {
  const tree = { project: "payments", total: 2, wholeProject: 1, repos: [{ repo: "api", lessons: 1, children: [{ name: "src", path: "src/", lessons: 1, children: [], files: [{ name: "a.ts", lessons: 1 }] }], files: [] }, { repo: null, lessons: 1, children: [], files: [] }] };
  it("reads a tree, and refuses an unknown field and more folders than the bound", () => {
    expect(LessonAreasAnswerSchema.parse(tree)).toEqual(tree);
    expect(LessonAreasAnswerSchema.safeParse({ ...tree, extra: 1 }).success).toBe(false);
    expect(LessonAreasAnswerSchema.safeParse({ ...tree, repos: [{ ...tree.repos[0]!, children: Array.from({ length: 41 }, (_, i) => ({ name: `d${i}`, path: `d${i}/`, lessons: 1, children: [], files: [] })) }] }).success).toBe(false);
  });
  it("is browser-safe: it imports nothing but zod and its own contract files", () => {
    const text = readFileSync(new URL("../../packages/contracts/src/app-lessons-areas.ts", import.meta.url), "utf8");
    expect([...text.matchAll(/^import .* from "([^"]+)";/gmu)].map((match) => match[1])).toEqual(["zod", "./app-lessons.js", "./learned-context.js"]);
  });
});
