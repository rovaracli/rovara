// Lessons in the repo, lane R1b (owner decision 50c; design LESSONS-REPO-FILE-DESIGN.md rev 2 section 2, "if the share is small", and LESSONS-REPO-ELIGIBILITY-REVIEW.md): the REPO-ONLY reflection.
//
// Every task starts from an input the repository cannot see (a Slack message, a tracker issue, text typed in Rovara), so R1 marks ~0% of the ordinary reflection's lessons as fit for a repository's file. This is the second
// reflection that fixes that: when a Rovara task's pull request merges, ONE more reflection runs over what the repository itself says about that change request, and nothing else. Its prompt holds:
//   - the repository's review comments and review threads on that pull request (the captured rows the first reflection already read: a member's own words, `ownText`, written in the repository),
//   - the human fix-up edits on that pull request (`human_edit`, handed over in memory by the code-host tap; never stored),
//   - the merge fact (the outcome word and the merge revision),
//   - the change request's TITLE (review M2: not the description, which Rovara writes itself from the plan, the names of the requester and approver and the task link).
// It holds no Slack, no tracker, no session message, no task description, no plan, no finding, no loaded lesson, no other repository. Its subject sets `repoInputs` ({place, repository, linkPrefix}) for exactly that repository, so
// R1's `repoVisibilityOf` marks every draft `repoOnly` BY CONSTRUCTION; the drafts then go through the normal curate, trial and eligibility rules (decision 50b: stable or person-approved before a weekly pull request).
//
// Provider neutrality (decision 51): this file knows no code host. A `RepoChangeRequest` is the code-host-neutral description of one change request (place, repository, link and link prefix, revision, title, description,
// comments, edits) that the code host's ADAPTER produces (`aws/broker/lesson-subject-source.ts` from the capture adapter's view); nothing here builds a URL or parses one.
//
// Money and gates (the first reflection's rules, not new ones):
//   - Off and Collect make no call and read nothing (`modeAllows`); the model itself is behind the lessons switch (`gatedByLessonsSwitch`), so a caller that skipped the mode check still cannot spend (decision 47).
//   - The customer's own model path, through `reflectSubject`: quote, spend look, hold, key; a refusal records its pause, a failed call counts once per task (`TaskFailureTally`).
//   - Public's per-task cap is ONE total with the task's other learning calls: the call is given only what the task has left (`capsOverride`), and its hold is added to the same tally (`taskBudget`).
//   - One call per merged change request: a once-key per task, repository place and change request head is checked before and taken after a call that was made. The worker's lease (`callStartedAt`) is the other lock:
//     a delivery after the call started is never run again. The once-key is taken atomically right before the provider is called (so two runs at once make one call, and a quote that fails takes nothing).
//   - The repository is proved BEFORE anything is paid (review M1): R1's `repoVisibilityOf` is run over the prompt's spans first; a change request that could not be repo-only makes no call. The proof is the project's registered
//     repository address, matched to the code host's own identity by the adapter, never the project's name.
//   - One owner per change request (review, human edits): when the merged head is not the head Rovara last pushed, the human-edit job owns it (comments + edits in one call); otherwise the task end does, comments only.
//   - Only a change request with at least one repository-visible correction is reflected (a member's review comment that reads as a correction, or a human edit); otherwise no call.
import { currentLearningAttempt } from "./learning-deadline.js";
import { looksLikeCorrection } from "./correction-filter.js";
import { processDraftRetrying } from "./draft-retry.js";
import { gatedByLessonsSwitch } from "./model-gate.js";
import { LearningRefusal, failuresCountedOncePerTask, withFailuresCountedOnce, type LessonsPauseStore, type TaskFailureTally } from "./pause.js";
import { learningCaps, modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { ProcessDeps } from "./process.js";
import { reflectSubject, type ReflectDeps } from "./reflect.js";
import type { PipelineModel } from "./ports.js";
import { buildReflectorInput, type EvidenceSpan, type ReflectSubject } from "./reflect-input.js";
import { repoVisibilityOf } from "./repo-eligibility.js";
import type { Audience } from "./types.js";

/**
 * One merged change request of a repository, described without naming a code host. The code host's adapter produces it from the host's own facts; the repository's words in it were already proved by the capture lane
 * (a member's own text, standing and erasure read now, the place and audience of the row they came from).
 */
export interface RepoChangeRequest {
  /** The record's name of the repository (`<source>:repo/<id>`), as the comment rows (or the edits) name it. Absent until a comment row or an edit names it. */
  place?: string | undefined;
  /** The project's name for the repository (the name in the project definition and in the prompt header). */
  repository: string;
  /** The project's REGISTERED repository address, which the adapter matched to the code host's own identity of the change request's repository: the proof R1 judges the link prefix against, without case. */
  repositoryUrl: string;
  /** The change request's permalink. */
  link: string;
  /** The start of every change request link of that repository: the header's links must all begin with it (R1's `repoInputs.linkPrefix`). */
  linkPrefix: string;
  /** The change request's head revision at the merge: the once-key's "head", so a new head is a new reflection. */
  revision: string;
  /** The merge revision on the default branch, when the host said it. */
  mergeRevision?: string | undefined;
  merged: boolean;
  /** The title. Nothing else the host calls the description is carried: Rovara writes it from the plan, the names of the people involved and the task link. */
  title: string;
  /** True when the merged head is not the head Rovara last pushed: someone pushed after Rovara, so the human-edit job owns this change request (it runs the reflection with the edits). */
  humanEditsExpected?: boolean | undefined;
  /** Who may read the change request: the repository's readers. Absent until a comment row or an edit says it. */
  audience?: Audience | undefined;
  /** The repository's review comments and review threads on it (`pr_comment` spans, member text, scope = `place`). */
  comments: readonly EvidenceSpan[];
  /** The human fix-up edits on it (`human_edit` spans, scope = `place`). Handed over in memory by the human-edit job; never stored. */
  edits: readonly EvidenceSpan[];
}

/** A change request with its place and readers named: what a subject can be built from. */
export type PlacedChangeRequest = RepoChangeRequest & { place: string; audience: Audience };
const isPlaced = (change: RepoChangeRequest): change is PlacedChangeRequest => change.place !== undefined && change.audience !== undefined;

/** The change request completed with the place and readers an edit names (the human-edit job's), and the edits. A change request that already has a different place is another repository's: undefined. Pure. */
export function withEdits(change: RepoChangeRequest, edit: { place: string; audience: Audience; spans: readonly EvidenceSpan[] }): PlacedChangeRequest | undefined {
  if (change.place !== undefined && change.place !== edit.place) return undefined;
  return { ...change, place: edit.place, audience: change.audience ?? edit.audience, edits: [...change.edits, ...edit.spans] };
}

/** At most this many change requests of one task are reflected on. */
export const MAX_REPO_CHANGES = 5;
/** Less room than this in the task's budget is none. */
const MIN_ROOM_USD = 0.001;
const TITLE_MAX = 300;

/** Whether a span is a person's own correction in the repository: a member with a known id, words that are theirs (not chosen by code). */
const isMemberWords = (span: EvidenceSpan): boolean => span.trust === "member" && span.fixedText !== true && (span.authorId !== undefined || (span.authorIds?.length ?? 0) > 0);

/** Whether the change request has a repository-visible correction: a merged change request with a member's review comment that reads as a correction, or a human edit. Pure. */
export function hasRepoCorrection(change: RepoChangeRequest): boolean {
  if (!change.merged) return false;
  return change.comments.some((span) => span.kind === "pr_comment" && isMemberWords(span) && looksLikeCorrection(span.text)) || change.edits.some((span) => span.kind === "human_edit" && isMemberWords(span));
}

/** The once-key of one reflection: the task, the repository and the change request's head. */
export const repoReflectKey = (taskId: string, change: Pick<RepoChangeRequest, "place" | "revision">): string => `repo-reflect:${taskId}:${change.place}:${change.revision}`;

/**
 * The subject of the repo-only reflection. It takes from the finished task only who started and steered it (their trust gates the reflection as for the first one, so a task an outsider started or steered teaches nothing
 * here either) and the outcome; nothing of its text. Every span is the repository's. Pure.
 */
export function repoOnlySubjectOf(main: ReflectSubject, change: PlacedChangeRequest): ReflectSubject {
  // The title only (review M2), as its own span and labelled for what it is: Rovara writes it, anyone with write access may edit it, so it is `system` text and a lesson that cites it alone is no correction.
  const written: EvidenceSpan = {
    kind: "fact", trust: "system", sourceKey: "change_request_title", audience: change.audience, scopes: [change.place],
    text: `Change request title (written by Rovara): ${change.title.slice(0, TITLE_MAX)}`,
  };
  return {
    kind: "task", id: main.id, workspaceId: main.workspaceId, project: main.project, repositories: [change.repository], outcome: "merged",
    ...(change.mergeRevision === undefined ? {} : { mergedCommit: change.mergeRevision }),
    ...(main.initiatorId === undefined ? {} : { initiatorId: main.initiatorId }),
    ...(main.initiatorTrust === undefined ? {} : { initiatorTrust: main.initiatorTrust }),
    ...(main.steeringTrust === undefined ? {} : { steeringTrust: main.steeringTrust }),
    ...(main.intentTrust === undefined ? {} : { intentTrust: main.intentTrust }),
    links: [change.link], audience: change.audience, scopes: [change.place],
    repoInputs: { place: change.place, repository: change.repository, linkPrefix: change.linkPrefix, repositoryUrl: change.repositoryUrl },
    promptStyle: "repo_only", requireEvidenceKind: ["pr_comment", "human_edit"],
    ...(main.evalRun === true ? { evalRun: true } : {}),
    spans: [written, ...change.comments, ...change.edits],
  };
}

/** What the repo-only reflection needs of the task's learning dependencies (a structural subset of `TaskLearningDeps`). */
export interface RepoReflectDeps {
  reflect: ReflectDeps;
  process: ProcessDeps;
  settings: LearningSettingsReader;
  log?: ((event: string, fields: Record<string, string | number>) => void) | undefined;
}

/**
 * A pause store that does not record "cost_too_high" (the task simply has no room left, which is not a reason to pause the project: the outcome judge's rule) or "no_provider" (this path's own refusals, a switch turned off
 * mid-run or a lost once-key, are not a missing provider; the task's first reflection records a real one).
 */
function withoutOwnRefusals(pause: LessonsPauseStore | undefined): LessonsPauseStore | undefined {
  return pause === undefined ? undefined : { ...pause, record: async (workspaceId, project, code) => { if (code !== "cost_too_high" && code !== "no_provider") await pause.record(workspaceId, project, code); } };
}

/** Who runs the reflection of a change request: the task end (comments only) or the human-edit job (comments and edits, for a change request someone pushed to after Rovara). */
export interface RepoReflectOptions { owner?: "task_end" | "human_edit" }

export interface RepoReflectResult { calls: number; drafts: number }

/**
 * Runs the repo-only reflection for each merged change request of a finished task that has a repository-visible correction. Sequential, one model call per change request, never throws into the caller's work: a fault is one
 * fixed log line. `tally` is the task's: the hold goes on it, so Public's per-task cap is one total with the first reflection and the outcome judge.
 */
export async function reflectRepoOnly(deps: RepoReflectDeps, main: ReflectSubject, changes: readonly RepoChangeRequest[], tally: TaskFailureTally, options: RepoReflectOptions = {}): Promise<RepoReflectResult> {
  const result: RepoReflectResult = { calls: 0, drafts: 0 };
  if (main.outcome !== "merged" || main.evalRun === true) return result;
  const owner = options.owner ?? "task_end";
  const wanted = changes.filter(hasRepoCorrection).slice(0, MAX_REPO_CHANGES);
  if (wanted.length === 0) return result;
  try {
    // The switch first: Off, Collect and a lessons switch that is off or unreadable read nothing and call nothing.
    if (!modeAllows((await resolveLearning(deps.settings, main.workspaceId, main.project)).mode, "reflect")) return result;
    const key = { workspaceId: main.workspaceId, project: main.project };
    const pause = withoutOwnRefusals(failuresCountedOncePerTask(deps.reflect.pause, tally));
    for (const change of wanted) {
      const attempt = currentLearningAttempt();
      if (attempt?.signal?.aborted === true) break;
      if (!isPlaced(change)) continue;
      // One owner per change request: someone pushed after Rovara, so the human-edit job runs the reflection with the edits; a job that cannot use them still runs it, comments only.
      if (owner === "task_end" && change.humanEditsExpected === true) { deps.log?.("learning.repo_reflect_left_to_human_edit", {}); continue; }
      const once = repoReflectKey(main.id, change);
      if (await deps.process.store.seenOnce(key, once)) continue;
      // The repository is proved BEFORE anything is paid: a change request whose prompt could not be repo-only makes no call.
      const subject = repoOnlySubjectOf(main, change);
      const built = buildReflectorInput(subject);
      if (!built.eligible) continue;
      const visibility = repoVisibilityOf(subject, built.spans.values());
      if (visibility.repoOnly === undefined) { deps.log?.("learning.repo_reflect_not_repo_only", { codes: visibility.blocked.join(",") }); continue; }
      // Public's per-task cap is one total: this call is given what the task has left.
      const cap = learningCaps(deps.reflect.edition, deps.reflect.capsOverride).perTaskUsd;
      const room = cap === undefined ? undefined : cap - tally.heldUsd;
      if (room !== undefined && room < MIN_ROOM_USD) { deps.log?.("learning.repo_reflect_no_room", {}); break; }
      // The once-key is taken right before the provider is called (atomically: of two runs at once only one gets it), and only then: a quote that fails, a refusal or a lost key spends nothing and takes nothing.
      let called = false;
      const claiming: PipelineModel = { ...deps.reflect.model, complete: async (request) => {
        if (!(await deps.process.store.markOnce(key, once))) throw new LearningRefusal("no_provider", "this change request was already reflected on");
        called = true;
        return deps.reflect.model.complete(request);
      } };
      // The lessons switch is checked first (a refusal there takes no key), then the key, then the provider.
      const model = gatedByLessonsSwitch(claiming);
      const heldBefore = tally.heldUsd;
      const reflected = await reflectSubject({
        ...deps.reflect, model, ...(pause === undefined ? {} : { pause }), taskBudget: tally,
        ...(room === undefined ? {} : { capsOverride: { ...deps.reflect.capsOverride, perTaskUsd: room } }),
      }, subject);
      if (called) result.calls += 1; else tally.heldUsd = heldBefore;
      if (reflected.status !== "ok") continue;
      const processDeps = withFailuresCountedOnce(deps.process, tally);
      for (const draft of reflected.drafts) {
        if (currentLearningAttempt()?.signal?.aborted === true) { deps.log?.("learning.drafts_cut_at_deadline", {}); break; }
        try {
          await processDraftRetrying(processDeps, key, draft, { ...(deps.log === undefined ? {} : { log: deps.log }) });
          result.drafts += 1;
        } catch { deps.log?.("learning.repo_reflect_draft_failed", {}); }
      }
    }
  } catch {
    deps.log?.("learning.repo_reflect_failed", {});
  }
  return result;
}
