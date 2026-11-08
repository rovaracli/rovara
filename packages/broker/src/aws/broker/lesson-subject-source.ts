// Learning v2 production wiring (lessons-in-production lane 1): the reflector's task-side facts, read from what the broker really records about a finished task (`TaskSubjectSource`, `lessons/task-end.ts`).
//
// Where each part lives:
//   - the task record (`DEVTASK#<id>`): who created and who started it (`taskStartActor` sets `initiatorId`), the request text (the intent), the title, the workflow snapshot;
//   - the workflow snapshot: the decisions (a human send-back is a `SEND_BACK` decision; its request id is the id of the send-back's `rovara.send_back` row), the review reports (findings), the pinned review
//     base (the base commit), the pull requests (links), the CI fix problems, the latest plan document (read from the artifact store);
//   - the project's own definition: the repositories (never the record's claim).
// What it does NOT hold is listed in the lane report (`.superpowers/sdd/lessons-prod/report-lane1.md`): the merge commit, per-person authorship of Slack thread replies, who pushed a failing revision, the agent's own steer messages.
//
// Rules, all enforced here at READ time (the worker reads fresh, so a task queued before an erasure is covered):
//   - A workspace other than the task's gives nothing. A task nobody started (an automatic run), a task of another kind (a setup draft, a diagnosis) gives nothing.
//   - Every span a PERSON wrote is dropped when that person is erased (the Team record's marker or the lessons fence); an erased initiator gives no `initiatorId` and no initiator trust (so nothing is measured).
//   - Each person-span's trust is read now (`readStanding`: member or outsider), not taken from what was true when the task ran.
//   - Slack and other channel text is never read here. Send-back and revert facts come only through `OutcomeRowReader`, which hides erased and deleted rows.
//   - A read that fails THROWS (the hook catches it): no read is ever treated as "not erased".
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, workflowFindingFingerprint, type WorkflowArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import { taskKey, taskOwnerKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { loadWorkflowDocument } from "../../developer/plan-artifacts.js";
import type { TaskSubjectBase, TaskSubjectSource } from "../../lessons/task-end.js";
import { isHumanSendBack } from "../../lessons/human-send-backs.js";
import type { EvidenceSpan } from "../../lessons/reflect-input.js";
import { taskStartActor } from "../../lessons/task-subject.js";
import type { Audience, TrustClass } from "../../lessons/types.js";
import type { TaskVisibility } from "../../team-record/sources/rovara.js";
import { cleanForLearning } from "../../lessons/guards.js";
import type { CapturedRowReader } from "../../lessons/captured-rows.js";
import { githubPullRequestAddress, type PullRequestAddress, type PullRequestFeedbackView, type PullRequestSurface } from "../../team-record/sources/capture-adapters.js";

/** At most this many human send-backs of a task are looked up (the hook reads one row for each). */
export const MAX_SEND_BACK_IDS = 50;
const MAX_FINDINGS = 20;
const MAX_CI_PROBLEMS = 10;
const PLAN_MAX_BYTES = 70_000;
/** The words of the spans Rovara itself authors (not a person's). */
const CI_FAILURE_PREFIX = "A check failed on the change: ";

/** At most this many remembered notes, pull requests and pull request comments of a task are read. */
export const MAX_REMEMBERED_NOTES = 20;
export const MAX_PULL_REQUESTS = 5;
export const MAX_PULL_REQUEST_COMMENTS = 40;
const COMMENT_PATH_MAX = 200;

export type { PullRequestAddress, PullRequestFeedbackView, PullRequestSurface };
export { githubPullRequestAddress };

export interface LessonSubjectSourceDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table (task records). */
  tableName: string;
  /** The names of the project's code repositories, from the project's OWN definition. */
  repositoriesOf(orgId: string, project: string): Promise<readonly string[]>;
  /** The person's standing in the project right now (`learning/standing.ts readStanding`). */
  standing(orgId: string, developerId: string, project: string): Promise<"member" | "outsider">;
  /** Whether the person is erased: the Team record's marker or the lessons fence. THROWS when it cannot tell. */
  isErased(orgId: string, developerId: string, project: string): Promise<boolean>;
  /** Who may read the task's rows (`lessons/task-visibility.ts`); undefined = nothing is recorded for this task. */
  visibility(orgId: string, taskId: string): Promise<TaskVisibility | undefined>;
  /** The artifact store's text read (the plan document). Absent: no plan span. */
  readObject?: ((objectKey: string, maxBytes: number) => Promise<string | undefined>) | undefined;
  now?: () => number;
  /** The Team record's captured words (remembered notes, pull request comments). Absent: neither kind of span is read. */
  captured?: CapturedRowReader | undefined;
  /** The ids of the task's LIVE correction notes (what "Remember this" made and Forget has not removed). Absent: no remembered spans. */
  rememberedNoteIds?: ((orgId: string, project: string, taskId: string) => Promise<readonly string[]>) | undefined;
  /** Which comments the code host lists on one pull request now. Absent, or a host that cannot say: no pull request comment spans. */
  pullRequestFeedback?: ((input: { orgId: string; project: string; taskId: string; address: PullRequestAddress; url: string }) => Promise<PullRequestFeedbackView | undefined>) | undefined;
  /**
   * Whether the author's account is on the place's exclusion list now. THROWS when it cannot tell. Absent: a task that went through the pull request feedback flow stays steered by someone unnamed
   * (nobody's exclusion can be checked).
   */
  sourceExcluded?: ((input: { orgId: string; project: string; source: string; scope: string; accountId: string }) => Promise<boolean>) | undefined;
  /**
   * The files a clean range of the pull request's branch changed, when EVERY commit in the range is proved a live member's (no merge commit, no bot, no outsider, no Rovara push): the compare of
   * `base` and `head` read live. Undefined when the range is not proved or the host cannot say. Absent: no comment is marked as having led to a change by a person's commit.
   */
  humanChangedFiles?: ((input: { orgId: string; project: string; host: string; repository: string; scope: string; isPrivate: boolean; base: string; head: string; headRef?: string }) => Promise<ReadonlyArray<{ path: string; patch?: string | undefined }> | undefined>) | undefined;
  /** The merge commit noted for a merged pull request of this task (the default branch's commit), or undefined. Absent: the subject names no merged commit. */
  mergeCommitOf?: ((input: { orgId: string; taskId: string; address: PullRequestAddress }) => Promise<string | undefined>) | undefined;
  /** The record's name of a pull request URL. Default: GitHub's. */
  pullRequestAddress?: ((url: string) => PullRequestAddress | undefined) | undefined;
}

/** Who may read a lesson made from this task: the task's own visibility (the same rule as the rows the record keeps for it, `audienceOfVisibility`). */
function audienceOf(taskId: string, visibility: TaskVisibility, at: string): Audience {
  if (visibility.kind === "shared") return { kind: "project" };
  const principals = visibility.kind === "private" ? [visibility.ownerDeveloperId] : [...visibility.developerIds].slice(0, 500);
  return { kind: "restricted", acl: { source: "rovara", scope: `rovara:task/${taskId}`, principals, capturedAt: at, liveCheck: "none" } };
}

const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

function outcomeOf(workflow: WorkflowSnapshot | undefined): "merged" | "closed" | undefined {
  switch (workflow?.outcome) {
    case "MERGED": return "merged";
    case "CLOSED": case "REJECTED": return "closed";
    default: return undefined;
  }
}

/** The base commit when the record pins exactly one for the project's repositories; several repositories have several bases and the subject holds one, so none is claimed. */
function baseOf(task: DeveloperTaskRecord, repositories: readonly string[]): { repository: string; commit: string } | undefined {
  const pinned = task.workflow?.reviewBase ?? task.preparedBase;
  if (pinned === undefined) return undefined;
  const mine = pinned.filter((entry) => repositories.includes(entry.repositoryId));
  return mine.length === 1 ? { repository: mine[0]!.repositoryId, commit: mine[0]!.baseCommitSha } : undefined;
}


/** Worker-written text is untrusted agent text: the class below the Rovara-authored one (it ranks above "outsider" only). */
const AGENT_TEXT_TRUST: TrustClass = "system";

/** The most distinct comments the shown-comments proof looks up for one task. More than this stays unnamed. */
export const MAX_SHOWN_COMMENTS_PROVED = 100;

/**
 * Whether a unified patch changes a commented line: a removed line within `radius` lines of it, or lines added right at it. Context lines do not count. Pure; a patch it cannot read is "no".
 * (The line is the one the comment was made on, in the file as it was at the comment's commit: the old side of a compare from that commit.)
 */
export function patchChangesLine(patch: string | undefined, line: number, radius = 2): boolean {
  if (patch === undefined) return false;
  let oldLine = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/u.exec(text);
    if (hunk !== null) { oldLine = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk || text.startsWith("\\")) continue;
    if (text.startsWith("-")) { if (Math.abs(oldLine - line) <= radius) return true; oldLine += 1; }
    else if (text.startsWith("+")) { if (Math.abs(oldLine - line) <= 1) return true; }
    else oldLine += 1;
  }
  return false;
}

const SHOWN_ID = /^(review_comment|review|discussion):([1-9][0-9]{0,18})$/u;

/** Whether the pull request feedback flow brought in text from the repository's commenters: a collected review, a review kept in the history, or review threads seen. */
function usedPullRequestComments(workflow: WorkflowSnapshot | undefined): boolean {
  if (workflow === undefined) return false;
  return workflow.feedbackReview !== undefined || (workflow.feedbackReviewHistory ?? []).length > 0 || (workflow.feedbackThreadObservations ?? []).length > 0;
}

/** Whether any person this record names beside the creator (the taker, a decision's or an answer's actor, a feedback note's actor) is erased. Asks every one (no short cut), so a read that cannot tell throws. */
async function namedPeopleErased(
  task: DeveloperTaskRecord, workflow: WorkflowSnapshot | undefined, developerOfActor: (actorId: string) => string | undefined, erased: (developerId: string) => Promise<boolean>,
): Promise<boolean> {
  const people = new Set<string>();
  const taker = tryEffectiveTaskOwner(task);
  if (taker !== undefined) people.add(taker.developerId);
  const actors = [
    ...(workflow?.decisions ?? []).filter((decision) => decision.actorRole !== "AGENTX").map((decision) => decision.actorId),
    ...(workflow?.intent?.answers ?? []).map((set) => set.by.actorId),
    ...(workflow?.feedbackDecisions ?? []).filter((decision) => decision.actorRole === "TASK_OWNER").map((decision) => decision.actorId),
    ...(workflow?.feedbackNotes ?? []).filter((note) => note.source !== "THREAD_REPLY").map((note) => note.actorId),
  ];
  for (const actor of actors) { const person = developerOfActor(actor); if (person !== undefined) people.add(person); }
  let any = false;
  for (const person of people) if (await erased(person)) any = true;
  return any;
}

export function lessonSubjectSource(deps: LessonSubjectSourceDeps): TaskSubjectSource {
  return {
    // L4: the project of a task from its record alone (one read), so the learning mode is checked before the plan, standing and erasure state are read. Same rules as `read` for whose task it is.
    async projectOf(input) {
      const orgParsed = OrgIdSchema.safeParse(input.workspaceId);
      if (!orgParsed.success) return undefined;
      const task = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(input.taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
      if (task === undefined || task.taskId !== input.taskId || task.orgId !== orgParsed.data) return undefined;
      if (task.automatic !== undefined || task.purpose !== undefined) return undefined;
      return task.project;
    },
    async read(input) {
      const orgParsed = OrgIdSchema.safeParse(input.workspaceId);
      if (!orgParsed.success) return undefined;
      const orgId = orgParsed.data;
      const task = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(input.taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
      // The workspace is the caller's: a record of another workspace (or none) gives nothing.
      if (task === undefined || task.taskId !== input.taskId || task.orgId !== orgId) return undefined;
      // Only a person's workflow task teaches: an automatic run has nobody who started it, a setup draft or a diagnosis is not a piece of work.
      if (task.automatic !== undefined || task.purpose !== undefined) return undefined;
      const visibility = await deps.visibility(orgId, task.taskId);
      if (visibility === undefined) return undefined;
      const project = task.project;

      const erasedCache = new Map<string, boolean>();
      const erased = async (developerId: string): Promise<boolean> => {
        const known = erasedCache.get(developerId);
        if (known !== undefined) return known;
        const answer = await deps.isErased(orgId, developerId, project);
        erasedCache.set(developerId, answer);
        return answer;
      };
      const standingCache = new Map<string, TrustClass>();
      const trustOf = async (developerId: string): Promise<TrustClass> => {
        const known = standingCache.get(developerId);
        if (known !== undefined) return known;
        const trust: TrustClass = (await deps.standing(orgId, developerId, project)) === "member" ? "member" : "outsider";
        standingCache.set(developerId, trust);
        return trust;
      };

      const allRepositories = await deps.repositoriesOf(orgId, project);
      const base = baseOf(task, allRepositories);
      const repositories = base === undefined ? [...allRepositories] : [base.repository];
      const workflow = task.workflow;

      // ---- who is who
      const creator = task.developerId;
      const initiatorId = taskStartActor(task);
      const initiatorErased = initiatorId !== undefined && await erased(initiatorId);
      const creatorErased = await erased(creator);
      // The actor ids a decision or an answer carries are hashed owner keys: the creator's, or the one who took the task over.
      const creatorKey = taskOwnerKey(creator, task.taskId);
      const takerOf = tryEffectiveTaskOwner(task);
      const takerKey = takerOf === undefined ? undefined : taskOwnerKey(takerOf.developerId, task.taskId);
      const developerOfActor = (actorId: string): string | undefined => {
        if (actorId === creatorKey) return creator;
        return takerOf !== undefined && takerKey === actorId ? takerOf.developerId : undefined;
      };

      // ---- spans
      const spans: EvidenceSpan[] = [];
      const intentText = present(task.requestText) ? task.requestText : task.title;
      if (!creatorErased && present(intentText)) spans.push({ kind: "intent", text: intentText, trust: await trustOf(creator), authorId: creator });

      // Worker-written text (the plan, the review findings, the CI text) is UNTRUSTED agent text (M5): the plan absorbs people's answers and the request, the findings and the CI log can carry text an outsider
      // influenced. It gets the "system" class, never "rovara". And if any person who decided on, answered for, took over or created the task is erased, none of it is read: it may hold that person's words.
      const workerTextTainted = creatorErased || await namedPeopleErased(task, workflow, developerOfActor, erased);
      if (!workerTextTainted && workflow !== undefined && deps.readObject !== undefined) {
        const plan: WorkflowArtifact | undefined = workflow.artifacts.filter((artifact) => artifact.type === "plan").sort((a, b) => a.version - b.version).at(-1);
        if (plan !== undefined) {
          const loaded = await loadWorkflowDocument((key, max) => deps.readObject!(key, max).catch(() => undefined), plan, {}).catch(() => undefined);
          const markdown = loaded?.markdown;
          if (present(markdown)) spans.push({ kind: "plan", text: markdown.slice(0, PLAN_MAX_BYTES), trust: AGENT_TEXT_TRUST, sourceKey: "plan" });
        }
      }

      let findings = 0;
      for (const review of workerTextTainted ? [] : workflow?.reviews ?? []) {
        for (const finding of review.findings) {
          if (finding.origin !== "INTRODUCED" || findings >= MAX_FINDINGS) continue;
          findings += 1;
          spans.push({ kind: "review_finding", text: finding.text, trust: AGENT_TEXT_TRUST, sourceKey: `review:${review.role.toLowerCase()}`, eventId: workflowFindingFingerprint(review.role, finding) });
        }
      }

      if (!workerTextTainted && workflow?.fixSource === "ci") {
        for (const problem of (workflow.fixProblems ?? []).slice(0, MAX_CI_PROBLEMS)) spans.push({ kind: "ci_failure", text: `${CI_FAILURE_PREFIX}${problem}`, trust: AGENT_TEXT_TRUST, sourceKey: "ci" });
      }

      // The close reason: the words of the person who closed (rejected) the task, when that person is the owner (the creator or the one who took over). A project admin's close is not attributed.
      const closer = [...(workflow?.decisions ?? [])].reverse().find((decision) => decision.decision === "REJECT" && decision.actorRole === "TASK_OWNER" && developerOfActor(decision.actorId) !== undefined);
      if (closer !== undefined) {
        const author = developerOfActor(closer.actorId)!;
        if (!(await erased(author))) spans.push({ kind: "close_reason", text: closer.reason, trust: await trustOf(author), authorId: author });
      }

      /**
       * Whether every pull request comment the agent was shown, in every round, is a live member's own words. The shown comments are the task record's (`feedbackShown`: the selected ones and the rest, review
       * bodies, whole threads, replies). Each must have its own author's first Team record row (written while they were a linked member, with text), that author must still be a live non-erased
       * non-excluded member, nobody else may have written on it (the comment is shown exactly as first written, or is a review), and a bot or an AI reviewer has no such row. Everything the record holds
       * now must be in the shown record, and every selected comment too. A missing record, an incomplete one, too many comments, or any lookup that does not succeed: not proved.
       */
      async function provedShownComments(): Promise<boolean> {
        const captured = deps.captured;
        const excluded = deps.sourceExcluded;
        const shown = workflow?.feedbackShown;
        if (captured === undefined || excluded === undefined || workflow === undefined || shown === undefined || shown.incomplete === true) return false;
        const key = (repositoryId: string, number: number, id: string): string => `${repositoryId}\u0000${String(number)}\u0000${id}`;
        const latest = new Map<string, { repositoryId: string; number: number; id: string; at: number }>();
        for (const round of shown.rounds) for (const pull of round.pulls) for (const comment of pull.comments) {
          const known = latest.get(key(pull.repositoryId, pull.number, comment.id));
          if (known === undefined || comment.at > known.at) latest.set(key(pull.repositoryId, pull.number, comment.id), { repositoryId: pull.repositoryId, number: pull.number, id: comment.id, at: comment.at });
        }
        if (usedPullRequestComments(workflow) && shown.rounds.length === 0) return false;
        // What the record holds now was shown; what was selected was shown.
        for (const bundle of workflow.feedbackReview?.bundleRefs ?? []) for (const comment of bundle.comments) if (!latest.has(key(bundle.repositoryId, bundle.number, comment.id))) return false;
        for (const thread of workflow.feedbackReview?.threadObservations ?? []) for (const comment of thread.comments) if (!latest.has(key(thread.repositoryId, thread.number, comment.id))) return false;
        const shownIds = new Set([...latest.values()].map((entry) => entry.id));
        for (const decision of workflow.feedbackDecisions ?? []) for (const id of decision.selectedCommentIds) if (!shownIds.has(id)) return false;
        if (latest.size > MAX_SHOWN_COMMENTS_PROVED) return false;
        for (const entry of latest.values()) {
          const pullRequest = (workflow.pullRequests ?? []).find((candidate) => candidate.repositoryId === entry.repositoryId && candidate.number === entry.number);
          const address = pullRequest === undefined ? undefined : (deps.pullRequestAddress ?? githubPullRequestAddress)(pullRequest.url);
          const parsed = SHOWN_ID.exec(entry.id);
          if (address === undefined || parsed === null) return false;
          const row = await captured.pullRequestWords({
            workspaceId: orgId, project, host: address.host, repository: address.repository, number: address.number, surface: parsed[1] as PullRequestSurface, commentId: parsed[2]!, shownAt: entry.at,
          });
          if (row === undefined || !row.ownText) return false;
          if (await erased(row.authorDeveloperId) || await trustOf(row.authorDeveloperId) !== "member") return false;
          if (await excluded({ orgId, project, source: row.source, scope: row.scope, accountId: row.authorSourceId })) return false;
        }
        return true;
      }

      // ---- steering: everyone who steered the task. The creator or the taker, when they decided, answered or sent it back; anyone this record cannot name is an outsider (unknown is outsider).
      // An ERASED steerer is unknown too (M6): their words may still be in the plan, so the task stays ineligible; they are never taken off the list.
      const steerers = new Set<TrustClass>();
      let unnamed = false;
      const steeredBy = async (actorId: string): Promise<void> => {
        const person = developerOfActor(actorId);
        if (person === undefined || await erased(person)) { unnamed = true; return; }
        steerers.add(await trustOf(person));
      };
      for (const decision of workflow?.decisions ?? []) {
        if (decision.actorRole === "AGENTX") continue;
        await steeredBy(decision.actorId);
      }
      for (const set of workflow?.intent?.answers ?? []) await steeredBy(set.by.actorId);
      // The owner's own feedback decisions and notes are named steerers like any other. A Slack thread reply is saved with a Slack account, not a member: the record cannot say whose it is.
      for (const decision of workflow?.feedbackDecisions ?? []) {
        if (decision.actorRole === "TASK_OWNER") await steeredBy(decision.actorId);
      }
      for (const note of workflow?.feedbackNotes ?? []) {
        if (note.source === "THREAD_REPLY") unnamed = true;
        else await steeredBy(note.actorId);
      }
      // Replies in the task's Slack thread are saved as notes with a Slack account, not a member: the record cannot say whose they are.
      if ((task.threadNoteCount ?? 0) > 0) unnamed = true;
      // The pull request feedback flow (M4, relaxed): the agent was shown comments from the pull request, and those can come from anyone who can comment on the repository. The task is steered by NAMED
      // MEMBERS only when every comment the agent was shown, in every round, is proved a live member's own words (see `provedShownComments`). Anything else, or any failure, stays unnamed. Skipped when the
      // task is already unnamed: the answer cannot change.
      const feedbackFlowUsed = usedPullRequestComments(workflow) || (workflow?.feedbackDecisions ?? []).some((decision) => decision.selectedCommentIds.length > 0);
      if (feedbackFlowUsed && !unnamed) {
        let proved = false;
        try { proved = await provedShownComments(); } catch { proved = false; }
        if (proved) steerers.add("member"); else unnamed = true;
      }
      const steeringTrust: TrustClass[] = [...steerers, ...(unnamed ? ["outsider" as const] : [])];

      // ---- a person's own corrections that the record already holds (no extra work for anyone): "remember this" notes, and reviewers' comments on the task's pull requests. Each is read from the
      // record by its row id; the person is the row's actor, their standing and erasure are read NOW, and an erased person's words are dropped. An outsider's span keeps its class: the reflector removes it.
      // A human-edit read (`context`) needs only the task's own intent and plan, and a task steered by someone unnamed teaches nothing: neither reads the code host (L7).
      if (deps.captured !== undefined && input.context !== "human_edit") {
        const captured = deps.captured;
        const where = { workspaceId: orgId, project };
        const person = async (authorId: string): Promise<TrustClass | undefined> => ((await erased(authorId)) ? undefined : trustOf(authorId));
        if (deps.rememberedNoteIds !== undefined) {
          for (const noteId of (await deps.rememberedNoteIds(orgId, project, task.taskId)).slice(0, MAX_REMEMBERED_NOTES)) {
            const row = await captured.rememberedNote({ ...where, taskId: task.taskId, noteId });
            if (row === undefined) continue;
            const trust = await person(row.authorDeveloperId);
            if (trust === undefined) continue;
            spans.push({ kind: "remembered", text: row.text, trust, authorId: row.authorDeveloperId, eventId: row.id, audience: row.audience, scopes: [row.scope] });
          }
        }
        if (deps.pullRequestFeedback !== undefined && !unnamed) {
          // The owner sent these comments to the agent and approved the change: the code changed because of them. (Rovara's own automatic decision is not a person's.)
          const acted = new Set((workflow?.feedbackDecisions ?? []).filter((decision) => decision.decision === "APPROVE" && decision.actorRole === "TASK_OWNER").flatMap((decision) => decision.selectedCommentIds));
          let taken = 0;
          for (const pullRequest of (workflow?.pullRequests ?? []).slice(0, MAX_PULL_REQUESTS)) {
            const address = (deps.pullRequestAddress ?? githubPullRequestAddress)(pullRequest.url);
            if (address === undefined) continue;
            let listed: PullRequestFeedbackView | undefined;
            try { listed = await deps.pullRequestFeedback({ orgId, project, taskId: task.taskId, address, url: pullRequest.url }); } catch { listed = undefined; }
            // What a person's own commits changed on the branch since a comment's commit, read once per commit (a clean range of members' commits only; Rovara's fix rounds, rebases and restacks are never it).
            const changedSince = new Map<string, ReadonlyArray<{ path: string; patch?: string | undefined }> | undefined>();
            for (const comment of listed?.comments ?? []) {
              if (taken >= MAX_PULL_REQUEST_COMMENTS) break;
              const row = await captured.pullRequestWords({ ...where, host: address.host, repository: address.repository, number: address.number, surface: comment.kind, commentId: comment.id });
              if (row === undefined) continue;
              const trust = await person(row.authorDeveloperId);
              if (trust === undefined) continue;
              taken += 1;
              let led = acted.has(`${comment.kind}:${comment.id}`);
              if (!led && comment.kind === "review_comment" && row.path !== undefined && row.line !== undefined && row.commitId !== undefined && listed?.headRevision !== undefined && listed.headRevision !== row.commitId && deps.humanChangedFiles !== undefined) {
                if (!changedSince.has(row.commitId)) {
                  try {
                    changedSince.set(row.commitId, await deps.humanChangedFiles({ orgId, project, host: address.host, repository: address.repository, scope: row.scope, isPrivate: row.audience.kind === "restricted", base: row.commitId, head: listed.headRevision, ...(listed.sourceBranch === undefined ? {} : { headRef: listed.sourceBranch }) }));
                  } catch { changedSince.set(row.commitId, undefined); }
                }
                led = (changedSince.get(row.commitId) ?? []).some((file) => file.path === row.path && patchChangesLine(file.patch, row.line!));
              }
              const place = row.path === undefined ? undefined : cleanForLearning(row.path, COMMENT_PATH_MAX);
              spans.push({
                kind: "pr_comment", text: place === undefined || place === "" ? row.text : `On ${place}: ${row.text}`, trust, authorId: row.authorDeveloperId, eventId: row.id,
                audience: row.audience, scopes: [row.scope], ...(led ? { ledToChange: true } : {}),
              });
            }
          }
        }
      }

      const links = (workflow?.pullRequests ?? []).map((pullRequest) => pullRequest.url).slice(0, 32);
      const sendBackRequestIds = (workflow?.decisions ?? [])
        .filter(isHumanSendBack)
        .map((decision) => decision.requestId)
        .slice(0, MAX_SEND_BACK_IDS);

      const outcome = outcomeOf(workflow);
      // The merge commit: noted when the host said the pull request merged. Named only for the one repository the subject names (a base was chosen), and only for a merged task.
      let mergedCommit: string | undefined;
      if (outcome === "merged" && base !== undefined && deps.mergeCommitOf !== undefined) {
        const merged = (workflow?.pullRequests ?? []).find((pullRequest) => pullRequest.repositoryId === base.repository && pullRequest.state === "MERGED");
        const address = merged === undefined ? undefined : (deps.pullRequestAddress ?? githubPullRequestAddress)(merged.url);
        if (address !== undefined) mergedCommit = await deps.mergeCommitOf({ orgId, taskId: task.taskId, address }).catch(() => undefined);
      }
      const base_: TaskSubjectBase = {
        facts: {
          workspaceId: orgId, project, taskId: task.taskId, repositories,
          ...(base === undefined ? {} : { baseCommit: base.commit }), ...(mergedCommit === undefined ? {} : { mergedCommit }),
          ...(outcome === undefined ? {} : { outcome }),
          // An erased initiator is nobody: with no `startedBy` and an `agent` mark the start actor is undefined, so no outcome is measured against them.
          task: initiatorErased ? { developerId: creator, agent: task.agent ?? {} } : { developerId: creator, ...(task.startedBy === undefined ? {} : { startedBy: task.startedBy }), ...(task.agent === undefined ? {} : { agent: task.agent }) },
          rest: {
            ...(initiatorId === undefined || initiatorErased ? {} : { initiatorTrust: await trustOf(initiatorId) }),
            steeringTrust,
            ...(creatorErased ? {} : { intentTrust: await trustOf(creator) }),
            ...(links.length === 0 ? {} : { links }),
            audience: audienceOf(task.taskId, visibility, new Date((deps.now ?? Date.now)()).toISOString()),
            spans,
          },
        },
        sendBackRequestIds,
      };
      return base_;
    },
  };
}
