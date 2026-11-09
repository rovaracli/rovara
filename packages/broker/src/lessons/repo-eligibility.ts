// Lessons in the repo (owner decisions 50, 50a, 50b; design LESSONS-REPO-FILE-DESIGN.md rev 2, section 2 and lane R1): which lessons may ever go into ONE repository's `.rovara/lessons.md`.
//
// The rule (50a.1): a lesson is eligible for repository R only if EVERY input the reflector was given was readable by everyone who can read R, and its text names nobody. Checked by code, fail closed: an input of an
// unknown kind or an unknown place makes the lesson not eligible. Nothing in this file calls a model (decision 47) or reads a store: every function is pure.
//   - `repoVisibilityOf`: at reflection, from the task's own inputs and every span the reflector was given, sets `provenance.repoOnly` (and the fixed codes of what blocked it, `repoBlockCodes`).
//   - `mergedRepoVisibility`: at a merge (`curate.ts#mergeInto`, which a person's merge `foldDuplicate` also uses), the AND of the two sides: kept only when both carry it for the SAME repository.
//   - `isRepoFileEligible` / `repoFileBlockers`: whether a stored lesson may go into repository R's file now.
// The table of inputs (one kind of span each):
//   pr_comment, human_edit, outcome, fact, and a CI result or an intent that carries a repository place  -> yes, if the place is ONE repository and the span's audience is that repository's readers (or the project, a public repository)
//   send_back, remembered, close_reason (typed in Rovara)                                                -> never
//   plan, review_finding, ci_failure written by Rovara (no person)                                       -> only if everything else passes (they are derived from the task's inputs)
//   a person's words in a plan / finding, a span from Slack, a tracker, MCP or Rovara itself, a loaded lesson, another repository, an unknown kind -> never
//   a task's own start and steering that are not spans (typed task text, answers, notes, connections)     -> never, unless the subject source PROVED them repository-visible (`ReflectSubject.repoInputs`)
import { hasStaleCitation, namesAPerson } from "./trial.js";
import { REPO_PLACE, repoOnlyScopes } from "./project-repo-audience.js";
import { REPO_BLOCK_CODES, SPAN_KINDS, type Audience, type Lesson, type LessonProvenance, type RepoBlockCode } from "./types.js";

/** Whether a text is a repository place (`<source>:repo/<id>`), the shape the Team record names a code-host repository with. */
export const isRepoPlace = (place: string): boolean => REPO_PLACE.test(place);

/** What this module reads of a span: structural, so a `MarkedSpan` and an `EvidenceSpan` both fit. */
export interface RepoInputSpan {
  kind: string; trust?: string; authorId?: string | undefined; authorIds?: readonly string[] | undefined; audience?: Audience | undefined; scopes?: readonly string[] | undefined;
}
export interface RepoInputSubject {
  kind: string; inheritedTasks?: readonly string[] | undefined; repoInputs?: { place: string } | undefined;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(SPAN_KINDS);
/** Kinds that are the repository's own words, work or facts: they pass when their place and readers are one repository's. */
const REPOSITORY_KINDS: ReadonlySet<string> = new Set(["pr_comment", "human_edit", "outcome", "fact"]);
/** Kinds a person types in Rovara (or its CLI, chat or Slack-linked session): never repository-visible, whatever place they carry. */
const TYPED_IN_ROVARA: ReadonlySet<string> = new Set(["send_back", "remembered", "close_reason"]);
/** Kinds Rovara derives from the task's inputs: they add nothing of their own, and are only as visible as the inputs they were made from. */
const DERIVED_KINDS: ReadonlySet<string> = new Set(["plan", "review_finding", "ci_failure"]);

type Placed = { place: string } | { block: RepoBlockCode };

/** The ONE repository place a span came from and whether that repository's readers are its audience. Anything else is a block, with the reason. */
function placeOfSpan(span: RepoInputSpan): Placed {
  const scopes = span.scopes;
  if (scopes === undefined || scopes.length === 0) return { block: "missing_place" };
  if (!scopes.every(isRepoPlace)) return { block: "other_place" };
  const places = new Set(scopes);
  if (places.size > 1) return { block: "other_repo" };
  const place = [...places][0]!;
  const audience = span.audience;
  if (audience === undefined) return { block: "audience_not_repo" };
  if (audience.kind === "project") return { place };
  // Restricted: exactly the readers of this one repository (the code-host row shape: no principals, no groups, the scope is the repository's place).
  const readers = repoOnlyScopes({ provenance: { audience } as LessonProvenance });
  return readers !== undefined && readers.every((reader) => reader === place) ? { place } : { block: "audience_not_repo" };
}

export interface RepoVisibility {
  /** Set exactly when every input is visible to the readers of this one repository. */
  repoOnly?: { place: string };
  /** The fixed codes of what blocked it, in `REPO_BLOCK_CODES` order. Empty exactly when `repoOnly` is set. */
  blocked: RepoBlockCode[];
}

const inCodeOrder = (codes: ReadonlySet<RepoBlockCode>): RepoBlockCode[] => REPO_BLOCK_CODES.filter((code) => codes.has(code));

/**
 * Whether every input of a reflection was readable by the readers of one repository. `spans` is EVERY span the reflector was given (cited or not): the model cannot launder a span by choosing its evidence. Unknown is blocked:
 * a task whose own start and steering are not proved (`subject.repoInputs`), a span of a kind or place this build does not know, a lesson loaded into the task (`inheritedTasks`, and a `loaded_lesson` span), and a reflection
 * with no input from a repository at all. Pure; calls no model.
 */
export function repoVisibilityOf(subject: RepoInputSubject, spans: Iterable<RepoInputSpan>): RepoVisibility {
  const blocked = new Set<RepoBlockCode>();
  const places = new Set<string>();
  let fromRepository = 0;
  if (subject.kind === "task") {
    if (subject.repoInputs === undefined || !isRepoPlace(subject.repoInputs.place)) blocked.add("task_inputs_unproved");
    else places.add(subject.repoInputs.place);
  } else if (subject.kind !== "facts") blocked.add("unknown_input");
  if ((subject.inheritedTasks ?? []).length > 0) blocked.add("loaded_lesson");
  for (const span of spans) {
    const personAuthored = span.authorId !== undefined || (span.authorIds?.length ?? 0) > 0 || span.trust === "member";
    if (!KNOWN_KINDS.has(span.kind)) { blocked.add("unknown_input"); continue; }
    if (span.kind === "loaded_lesson") { blocked.add("loaded_lesson"); continue; }
    if (TYPED_IN_ROVARA.has(span.kind)) { blocked.add("typed_in_rovara"); continue; }
    if (span.kind === "intent") {
      const placed = placeOfSpan(span);
      if ("place" in placed) places.add(placed.place);
      else blocked.add(placed.block === "missing_place" || placed.block === "other_place" ? "intent_not_repo" : placed.block);
      continue;
    }
    // The repository's own kinds always need a place. A derived kind (written by Rovara) needs none, but a person's words in it, or a place that is not a repository, block it.
    const hasPlace = span.scopes !== undefined && span.scopes.length > 0;
    if (DERIVED_KINDS.has(span.kind) && !hasPlace) {
      if (personAuthored) blocked.add("typed_in_rovara");
      continue;
    }
    if (REPOSITORY_KINDS.has(span.kind) || DERIVED_KINDS.has(span.kind)) {
      const placed = placeOfSpan(span);
      if ("place" in placed) { places.add(placed.place); fromRepository += 1; } else blocked.add(placed.block);
      continue;
    }
    blocked.add("unknown_input");
  }
  if (places.size > 1) blocked.add("other_repo");
  if (fromRepository === 0) blocked.add("no_repo_evidence");
  const codes = inCodeOrder(blocked);
  return codes.length === 0 && places.size === 1 ? { repoOnly: { place: [...places][0]! }, blocked: [] } : { blocked: codes.length === 0 ? ["unknown_input"] : codes };
}

/** What the provenance fields say, for a merge: a side that is not repository-only carries its recorded codes; a side that recorded none (learned before the field) is `predates_field`. */
function blockedOf(side: Pick<LessonProvenance, "repoOnly" | "repoBlockCodes">): RepoBlockCode[] {
  if (side.repoOnly !== undefined) return [];
  return side.repoBlockCodes === undefined || side.repoBlockCodes.length === 0 ? ["predates_field"] : [...side.repoBlockCodes];
}

/**
 * The repository-visibility fields after two lessons merge (`curate.ts#mergeInto`; a person's "Merge into the existing lesson" is the same fold): the AND of the sides. `repoOnly` is kept only when BOTH sides carry it for the
 * SAME repository; anything else clears it, and `repoBlockCodes` is the union of what blocked each side (two different repositories: `other_repo`). An unset side reads as false. Pure.
 */
export function mergedRepoVisibility(target: Pick<LessonProvenance, "repoOnly" | "repoBlockCodes">, draft: Pick<LessonProvenance, "repoOnly" | "repoBlockCodes">): Pick<LessonProvenance, "repoOnly" | "repoBlockCodes"> {
  if (target.repoOnly !== undefined && draft.repoOnly !== undefined && target.repoOnly.place === draft.repoOnly.place) return { repoOnly: target.repoOnly };
  const codes = new Set<RepoBlockCode>([...blockedOf(target), ...blockedOf(draft)]);
  if (target.repoOnly !== undefined && draft.repoOnly !== undefined) codes.add("other_repo");
  return { repoBlockCodes: inCodeOrder(codes) };
}

/** The approvals a PERSON gave (not the trial's or the automatic path's): decision 50b's "person-approved". */
const PERSON_APPROVAL_MODES: ReadonlySet<string> = new Set(["one", "second_person", "sole_owner_exception"]);

export type RepoFileBlocker =
  | "repo_unknown" | "not_repo_only" | "other_repo" | "not_active" | "on_trial" | "not_stable_or_approved" | "restricted_audience" | "names_a_person" | "needs_review";

/**
 * Everything that keeps a lesson out of repository `repo`'s file now (empty: eligible). `repo` is its place (`<source>:repo/<id>`); `names` are the display names of the people the lesson could name, REQUIRED as for
 * `isPublishable` (an empty list is a statement that the caller found none; an @handle or an e-mail address always counts). Pure; every doubt is a blocker.
 */
export function repoFileBlockers(lesson: Lesson, repo: string, names: readonly string[]): RepoFileBlocker[] {
  const blockers: RepoFileBlocker[] = [];
  if (!isRepoPlace(repo)) return ["repo_unknown"];
  const only = lesson.provenance.repoOnly;
  if (only === undefined) blockers.push("not_repo_only");
  else if (only.place !== repo) blockers.push("other_repo");
  if (lesson.status !== "active") blockers.push("not_active");
  // Decision 50b: stable after trial, or approved by a person. A lesson still on trial, or one that went live without any person, waits.
  const stable = lesson.trial?.state === "stable";
  const onTrial = lesson.trial?.state === "trial";
  const approvedByPerson = lesson.trial === undefined && lesson.approvals.some((approval) => PERSON_APPROVAL_MODES.has(approval.mode));
  if (onTrial) blockers.push("on_trial");
  else if (!stable && !approvedByPerson) blockers.push("not_stable_or_approved");
  // Decisions 34 and 36: no restriction except "the readers of this very repository".
  const audience = lesson.provenance.audience;
  const readers = repoOnlyScopes(lesson);
  if (audience.kind !== "project" && !(readers !== undefined && readers.every((reader) => reader === repo))) blockers.push("restricted_audience");
  if (namesAPerson([lesson.title, lesson.description, lesson.body].join("\n"), names)) blockers.push("names_a_person");
  // The same soundness `isPublishable` asks of a lesson that leaves Rovara's store.
  if (lesson.tier >= 2 || lesson.reviewRequired === true || lesson.retireProposedAt !== undefined || lesson.counters.harmful > 0 || hasStaleCitation(lesson)) blockers.push("needs_review");
  return blockers;
}

/** Whether the lesson may go into repository `repo`'s `.rovara/lessons.md`. Pure; see `repoFileBlockers` for the reasons. */
export const isRepoFileEligible = (lesson: Lesson, repo: string, names: readonly string[]): boolean => repoFileBlockers(lesson, repo, names).length === 0;
