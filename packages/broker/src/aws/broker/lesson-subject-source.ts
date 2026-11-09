// Learning v2 production wiring (lessons-in-production lane 1): the reflector's task-side facts, read from what the broker really records about a finished task (`TaskSubjectSource`, `lessons/task-end.ts`).
//
// Where each part lives:
//   - the task record (`DEVTASK#<id>`): who created and who started it (`taskStartActor` sets `initiatorId`), the request text (the intent), the title, the workflow snapshot;
//   - the workflow snapshot: the decisions (a human send-back is a `SEND_BACK` decision; its request id is the id of the send-back's `rovara.send_back` row), the review reports (findings), the pinned review
//     base (the base commit), the pull requests (links), the CI fix problems, the latest plan document (read from the artifact store);
//   - the project's own definition: the repositories (never the record's claim).
// What it does NOT hold is listed in the lane report (`.superpowers/sdd/lessons-prod/report-lane1.md`): the merge commit, who pushed a failing revision, the agent's own steer messages.
//
// Rules, all enforced here at READ time (the worker reads fresh, so a task queued before an erasure is covered):
//   - A workspace other than the task's gives nothing. A task nobody started (an automatic run), a task of another kind (a setup draft, a diagnosis) gives nothing.
//   - Every span a PERSON wrote is dropped when that person is erased (the Team record's marker or the lessons fence); an erased initiator gives no `initiatorId` and no initiator trust (so nothing is measured).
//   - Each person-span's trust is read now (`readStanding`: member or outsider), not taken from what was true when the task ran.
//   - Slack and other channel text is never read here. Send-back and revert facts come only through `OutcomeRowReader`, which hides erased and deleted rows.
//   - Slack thread replies (lessons sweep, lane D): the words are NOT read, only WHO wrote each reply. A reply's author is named through the Rovara identity their Slack account is verifiably linked to
//     (`slackAuthor`; the Slack workspace must be the task's company's); the linked person then counts like any other steerer: their project role decides member or outsider, an erased person makes
//     the task unnamed and taints the worker-written text (the plan quotes replies), and an unlinked, unverified, other-workspace, bot or unreadable author is unknown (an outsider). Bounded.
//   - Messages people sent to the agent from a session (app or Linear): the route authenticated the sender and checked their level, so the note's developer id names them; they count like any other steerer.
//   - A read that fails THROWS (the hook catches it): no read is ever treated as "not erased".
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, SLACK_OIDC_ISSUER, workflowFindingFingerprint, type WorkflowArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import { taskKey, taskOwnerKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { loadWorkflowDocument } from "../../developer/plan-artifacts.js";
import type { TaskSubjectBase, TaskSubjectSource } from "../../lessons/task-end.js";
import { isHumanSendBack } from "../../lessons/human-send-backs.js";
import { logRef } from "../../lessons/log-ref.js";
import type { EvidenceSpan } from "../../lessons/reflect-input.js";
import { taskStartActor } from "../../lessons/task-subject.js";
import { ownerKeyForSubject } from "../lambda.js";
import type { SlackWorkspaceScope } from "./lesson-slack-author.js";
import { narrowestAudience, type Audience, type TrustClass } from "../../lessons/types.js";
import type { TaskVisibility } from "../../team-record/sources/rovara.js";
import { cleanForLearning } from "../../lessons/guards.js";
import type { CapturedRowReader } from "../../lessons/captured-rows.js";
import type { RepoChangeRequest } from "../../lessons/repo-reflect.js";
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

/** At most this many saved thread replies of a task are looked at; a task with more is steered by someone unnamed (no read at all). */
export const MAX_THREAD_REPLIES = 100;
/** At most this many distinct Slack accounts of one task are resolved to a person; more than this stays unnamed. */
export const MAX_SLACK_AUTHORS = 20;

/** One saved note of a task, as far as steering goes: a Slack reply names its Slack workspace and user; any other kind (a session message) is not named by this source. */
export type ThreadNoteAuthor = { kind: "slack"; teamId: string; slackUserId: string } | { kind: "person"; developerId: string } | { kind: "other" };

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
  /**
   * The task's LIVE visibility from the strict reader (`resolveTaskVisibility(..., { strict: true })`: any unreadable record, session, share list or People list THROWS). Only for `sharedTask`, the
   * mark that lets a lesson be published to the repository. Absent, or a read that fails, is "not shared": nothing is published on a guess.
   */
  strictVisibility?: ((orgId: string, taskId: string) => Promise<TaskVisibility | undefined>) | undefined;
  /**
   * Owner decision 32: whether the task is visible to the whole project right now with no People denial (an ordinary task nobody shared counts; `lessons/task-project-wide.ts`). Strict: THROWS when anything cannot be read.
   * Used with the strict reader: either one saying "project-wide" is enough. Absent: only the strict reader decides.
   */
  projectWide?: ((orgId: string, taskId: string) => Promise<boolean>) | undefined;
  /** A fixed line for a read that failed: the task only as a hash (`logRef`), never a raw id and never text. */
  log?: ((event: string, fields: Record<string, string | number>) => void) | undefined;
  /**
   * The task's saved Slack thread replies and session messages (`NOTE#` rows), oldest first, with the author's Slack workspace and user id for a Slack reply. THROWS when it cannot read. Absent: a task with any
   * saved reply stays steered by someone unnamed.
   */
  threadNotes?: ((orgId: string, taskId: string) => Promise<readonly ThreadNoteAuthor[]>) | undefined;
  /**
   * The Rovara developer a Slack account is VERIFIABLY linked to (the sign-in table's active Slack identity link, followed through merges), only when the Slack workspace is the one bound to `orgId`; undefined for an
   * unlinked or unlinked-again account, a bot, another workspace's account or a revoked developer. May throw: a failure is "unknown" (the author stays unnamed), never a member. Absent: Slack authors stay unnamed.
   */
  slackAuthor?: ((input: { orgId: string; teamId: string; slackUserId: string }, scope?: SlackWorkspaceScope) => Promise<string | undefined>) | undefined;
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
  /** The project's REGISTERED repository addresses (the URL in the project definition), by the project's name for each. With `repositoryAddress` it proves a pull request is in a registered repository. Absent: no repo-only reflection. */
  repositoryUrlsOf?: ((orgId: string, project: string) => Promise<Readonly<Record<string, string>>>) | undefined;
  /** Whether the code host's adapter reads human edits (a fix-up job exists for its pull requests). Absent: yes. A host that does not leaves every pull request to the task end. */
  humanEditsSupported?: ((host: string) => boolean) | undefined;
  /** The address of a repository as the project's repository record spells it, from the code host's own identity of it (the host and the full name the pull request's address carries); undefined when the host cannot say. */
  repositoryAddress?: ((host: string, fullName: string) => string | undefined) | undefined;
}

/** Who may read a lesson made from this task: the task's own visibility (the same rule as the rows the record keeps for it, `audienceOfVisibility`). */
function audienceOf(taskId: string, visibility: TaskVisibility, at: string): Audience {
  if (visibility.kind === "shared") return { kind: "project" };
  const principals = visibility.kind === "private" ? [visibility.ownerDeveloperId] : [...visibility.developerIds].slice(0, 500);
  return { kind: "restricted", acl: { source: "rovara", scope: `rovara:task/${taskId}`, principals, capturedAt: at, liveCheck: "none" } };
}

/**
 * Whether the task is, right now, the whole project's: shared with the project (or the company) with no People denial, or (owner decision 32) an ordinary task nobody shared that no People entry denies anyone.
 * `true` / `false` when the live reads say so; `undefined` when they could not be read (twice): UNKNOWN, which is not "not shared" (the lesson's mark is left unset, and a later draft or a merge does not clear what an
 * earlier one set), logged as one fixed line. With no reader at all it is `false` for a task the strict reader calls private, and unknown otherwise.
 */
async function sharedWithProjectNow(deps: LessonSubjectSourceDeps, orgId: string, taskId: string): Promise<boolean | undefined> {
  if (deps.strictVisibility === undefined && deps.projectWide === undefined) return undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (deps.strictVisibility !== undefined && (await deps.strictVisibility(orgId, taskId))?.kind === "shared") return true;
      return deps.projectWide === undefined ? false : await deps.projectWide(orgId, taskId);
    } catch { /* read again once */ }
  }
  deps.log?.("learning.shared_task_unreadable", { task: logRef(orgId, taskId) });
  return undefined;
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
 * (The line is the one the comment was made on, in the file as it was at the comment's commit: the old side of a compare from that commit. Only a RIGHT-side comment has such a line: a comment on a deleted line is numbered in the base file.)
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

/** Whether any person this record names beside the creator (the taker, a decision's or an answer's actor, a feedback note's actor, a Slack reply's linked author) is erased. Asks every one (no short cut), so a read that cannot tell throws. */
async function namedPeopleErased(
  task: DeveloperTaskRecord, workflow: WorkflowSnapshot | undefined, developerOfActor: (actorId: string) => string | undefined, erased: (developerId: string) => Promise<boolean>,
  /** The people whose Slack thread replies the task holds (already resolved to their Rovara identity). */
  slackPeople: readonly string[] = [],
): Promise<boolean> {
  const people = new Set<string>(slackPeople);
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

/**
 * Who wrote the task's Slack thread replies: the Rovara developer each Slack account is verifiably linked to (`deps.slackAuthor`), one entry per distinct Slack account (`undefined` for an account that could not be named),
 * and `unnamed` when anything about the replies cannot be accounted for. Fails closed everywhere: no reader or resolver, more than `MAX_THREAD_REPLIES` saved replies, a read that fails, a different number of rows than
 * the task counts (some row unreadable or gone), a note that is not a Slack reply, a reply with no workspace, more than `MAX_SLACK_AUTHORS` accounts, or a resolver that throws. Nothing here ever makes someone a member:
 * the project role is read by the caller afterwards.
 */
async function slackSteerers(deps: LessonSubjectSourceDeps, orgId: string, task: DeveloperTaskRecord, workspaces: SlackWorkspaceScope): Promise<{ persons: Array<string | undefined>; unnamed: boolean }> {
  const accounts = new Map<string, { teamId: string; slackUserId: string }>();
  // People who sent a message from a session: the route authenticated them and checked their "use" level, so their developer id is the note's author as it stands.
  const sessionPeople = new Set<string>();
  let unnamed = false;
  // A reply the owner sent for the pull request feedback review is kept on the workflow too (with its Slack account).
  for (const note of task.workflow?.feedbackNotes ?? []) {
    if (note.source !== "THREAD_REPLY") continue;
    if (note.slack === undefined) unnamed = true;
    else accounts.set(`${note.slack.teamId}\u0000${note.slack.userId}`, { teamId: note.slack.teamId, slackUserId: note.slack.userId });
  }
  const count = task.threadNoteCount ?? 0;
  if (count > 0) {
    let rows: readonly ThreadNoteAuthor[] | undefined;
    if (deps.threadNotes !== undefined && count <= MAX_THREAD_REPLIES) {
      try { rows = await deps.threadNotes(orgId, task.taskId); } catch { rows = undefined; }
    }
    if (rows === undefined || rows.length !== count) unnamed = true;
    else for (const row of rows) {
      if (row.kind === "person") { if (present(row.developerId)) sessionPeople.add(row.developerId.trim()); else unnamed = true; }
      else if (row.kind !== "slack") unnamed = true;
      else accounts.set(`${row.teamId}\u0000${row.slackUserId}`, { teamId: row.teamId, slackUserId: row.slackUserId });
    }
  }
  const persons: Array<string | undefined> = [...sessionPeople].slice(0, MAX_SLACK_AUTHORS);
  if (sessionPeople.size > MAX_SLACK_AUTHORS) unnamed = true;
  if (accounts.size === 0) return { persons, unnamed };
  if (deps.slackAuthor === undefined) return { persons, unnamed: true };
  const resolve = deps.slackAuthor;
  for (const account of [...accounts.values()].slice(0, MAX_SLACK_AUTHORS)) {
    try {
      const person = await resolve({ orgId, ...account }, workspaces);
      persons.push(present(person) ? person.trim() : undefined);
    } catch { persons.push(undefined); }
  }
  return { persons, unnamed: unnamed || accounts.size > MAX_SLACK_AUTHORS };
}

/** The start of every change request link of a repository, from one change request's link and number: the link without its number (`https://host/owner/name/pull/` for `.../pull/7`). Undefined when the link does not end in the number. */
function linkPrefixOf(url: string, number: number): string | undefined {
  const tail = `/${String(number)}`;
  return url.endsWith(tail) ? url.slice(0, url.length - tail.length + 1) : undefined;
}

/** A repository address without a trailing slash or `.git`, lower-cased: the code host's names are case-insensitive. */
const addressKey = (url: string): string => url.trim().replace(/\/+$/u, "").replace(/\.git$/u, "").toLowerCase();

/**
 * Lessons in the repo (decision 50c): one merged pull request of the task as a `RepoChangeRequest`, from what the code host's adapter said (`listed`: head and merge revision) and the comment spans this read already
 * proved. Undefined (no second reflection for it) unless the pull request merged, the host gave a head revision, the repository is PROVED (the project's registered address for the repository equals the address
 * the code host's own identity gives for the pull request's repository, without case) and the comments name at most ONE place with one audience.
 * `pushedHead` is the head Rovara last pushed; a merged head that differs means someone pushed after Rovara, so the human-edit job owns the change request.
 */
function repoChangeOf(input: {
  pullRequest: { repositoryId: string; url: string; state: string; headSha?: string | undefined }; address: PullRequestAddress; listed: PullRequestFeedbackView | undefined; comments: readonly EvidenceSpan[];
  registered: string | undefined; hostAddress: string | undefined; /** The host's adapter reads human edits, so a moved head means the fix-up job runs. */ humanEditsRead: boolean;
}): RepoChangeRequest | undefined {
  const { pullRequest, listed, comments } = input;
  if (pullRequest.state !== "MERGED" || listed === undefined || listed.headRevision === undefined) return undefined;
  if (input.registered === undefined || input.hostAddress === undefined || addressKey(input.registered) !== addressKey(input.hostAddress)) return undefined;
  const places = new Set(comments.flatMap((span) => span.scopes ?? []));
  const audiences = comments.flatMap((span) => (span.audience === undefined ? [] : [span.audience]));
  const linkPrefix = linkPrefixOf(pullRequest.url, input.address.number);
  if (places.size > 1 || audiences.length !== comments.length || linkPrefix === undefined) return undefined;
  const place = [...places][0];
  const pushed = pullRequest.headSha;
  return {
    ...(place === undefined ? {} : { place }), repository: pullRequest.repositoryId, repositoryUrl: input.registered, link: pullRequest.url, linkPrefix, revision: listed.headRevision, merged: true,
    ...(listed.mergeRevision === undefined ? {} : { mergeRevision: listed.mergeRevision }),
    ...(pushed === undefined ? {} : { humanEditsExpected: input.humanEditsRead && pushed.toLowerCase() !== listed.headRevision.toLowerCase() }),
    ...(audiences.length === 0 ? {} : { audience: narrowestAudience(audiences) }), comments, edits: [],
  };
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

      // A task started in Slack is recorded under the Slack-derived developer id of its creator (and its taker), which is no member of the company when the person is a member through a linked web account. The
      // task record, its ownership and every authorization path keep that id. This source reads it as the person the Slack account is verifiably linked to (`slackAuthor`, the same proof that names a reply's author),
      // and that person's id is what goes into the subject: their trust and erasure are read under it, and it is the intent span's and the close reason's `authorId` and the initiator, so the lessons made from
      // the task are attributed to the person (and a later erase of that person removes them). An erase is checked under the recorded id as well as the person (see `erased`).
      // Only an id that is exactly the Slack-derived id of a Slack account this record names, in the workspace the task was shared in, is looked up. Anything else, a failed lookup or no proof: the id as it is.
      // One memory of the workspace-to-company bindings for this build: each workspace's binding is read once.
      const workspaces: SlackWorkspaceScope = new Map();
      const slackIds = new Map<string, string>();
      for (const slackUserId of [task.slackUserId, tryEffectiveTaskOwner(task)?.slackUserId]) {
        if (typeof slackUserId === "string" && slackUserId !== "") slackIds.set(ownerKeyForSubject(SLACK_OIDC_ISSUER, slackUserId), slackUserId);
      }
      const canonCache = new Map<string, string>();
      const canon = async (developerId: string): Promise<string> => {
        const known = canonCache.get(developerId);
        if (known !== undefined) return known;
        let person = developerId;
        const slackUserId = slackIds.get(developerId);
        const teamId = task.share?.teamId;
        if (slackUserId !== undefined && typeof teamId === "string" && deps.slackAuthor !== undefined) {
          try {
            const linked = await deps.slackAuthor({ orgId, teamId, slackUserId }, workspaces);
            if (present(linked)) person = linked.trim();
          } catch { person = developerId; }
        }
        canonCache.set(developerId, person);
        return person;
      };
      const erasedCache = new Map<string, boolean>();
      const erasedRaw = async (developerId: string): Promise<boolean> => {
        const known = erasedCache.get(developerId);
        if (known !== undefined) return known;
        const answer = await deps.isErased(orgId, developerId, project);
        erasedCache.set(developerId, answer);
        return answer;
      };
      // Erased under the id as recorded or under the person it is linked to: either one is enough (no short cut, so a read that cannot tell throws).
      const erased = async (developerId: string): Promise<boolean> => {
        const raw = await erasedRaw(developerId);
        const person = await canon(developerId);
        return (person !== developerId && await erasedRaw(person)) || raw;
      };
      const standingCache = new Map<string, TrustClass>();
      const trustOf = async (developerId: string): Promise<TrustClass> => {
        const known = standingCache.get(developerId);
        if (known !== undefined) return known;
        const trust: TrustClass = (await deps.standing(orgId, await canon(developerId), project)) === "member" ? "member" : "outsider";
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
      const creatorId = await canon(creator);
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
      if (!creatorErased && present(intentText)) spans.push({ kind: "intent", text: intentText, trust: await trustOf(creator), authorId: await canon(creator) });

      // Slack thread replies: who wrote them, through their linked Rovara identity (see `slackSteerers`). Resolved before the worker text, because the plan quotes replies.
      const slack = await slackSteerers(deps, orgId, task, workspaces);

      // Worker-written text (the plan, the review findings, the CI text) is UNTRUSTED agent text (M5): the plan absorbs people's answers and the request, the findings and the CI log can carry text an outsider
      // influenced. It gets the "system" class, never "rovara". And if any person who decided on, answered for, took over or created the task is erased, none of it is read: it may hold that person's words.
      const workerTextTainted = creatorErased || await namedPeopleErased(task, workflow, developerOfActor, erased, slack.persons.filter((person): person is string => person !== undefined));
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
        if (!(await erased(author))) spans.push({ kind: "close_reason", text: closer.reason, trust: await trustOf(author), authorId: await canon(author) });
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
        // A comment shown in several rounds is "never edited" only when EVERY round saw it so; one round that saw it edited, or did not say, decides.
        const editedBy = new Map<string, boolean | undefined>();
        for (const round of shown.rounds) for (const pull of round.pulls) for (const comment of pull.comments) {
          const id = key(pull.repositoryId, pull.number, comment.id);
          const known = latest.get(id);
          if (known === undefined || comment.at > known.at) latest.set(id, { repositoryId: pull.repositoryId, number: pull.number, id: comment.id, at: comment.at });
          editedBy.set(id, editedBy.has(id) ? (editedBy.get(id) === true || comment.edited === true ? true : editedBy.get(id) === false && comment.edited === false ? false : undefined) : comment.edited);
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
            workspaceId: orgId, project, host: address.host, repository: address.repository, number: address.number, surface: parsed[1] as PullRequestSurface, commentId: parsed[2]!, shownAt: entry.at, ...(editedBy.get(key(entry.repositoryId, entry.number, entry.id)) === undefined ? {} : { edited: editedBy.get(key(entry.repositoryId, entry.number, entry.id))! }),
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
      // The owner's own feedback decisions and notes are named steerers like any other.
      for (const decision of workflow?.feedbackDecisions ?? []) {
        if (decision.actorRole === "TASK_OWNER") await steeredBy(decision.actorId);
      }
      for (const note of workflow?.feedbackNotes ?? []) {
        if (note.source !== "THREAD_REPLY") await steeredBy(note.actorId);
      }
      // A Slack thread reply is saved with a Slack account, not a member. It names a steerer only through a verified link to a Rovara identity (`slackSteerers`): that person counts like any other steerer
      // (their project role now decides member or outsider; an erased person is unknown). A reply whose author cannot be named that way, or any reply this source cannot account for, is someone unnamed.
      if (slack.unnamed) unnamed = true;
      for (const person of slack.persons) {
        if (person === undefined || await erased(person)) unnamed = true;
        else steerers.add(await trustOf(person));
      }
      // The pull request feedback flow (M4, relaxed): the agent was shown comments from the pull request, and those can come from anyone who can comment on the repository. The task is steered by NAMED
      // MEMBERS only when every comment the agent was shown, in every round, is proved a live member's own words (see `provedShownComments`). Anything else, or any failure, stays unnamed. Skipped when the
      // task is already unnamed: the answer cannot change.
      const feedbackFlowUsed = usedPullRequestComments(workflow) || (workflow?.feedbackDecisions ?? []).some((decision) => decision.selectedCommentIds.length > 0);
      if (feedbackFlowUsed && !unnamed) {
        const proved = await provedShownComments().catch(() => false);
        if (proved) steerers.add("member"); else unnamed = true;
      }
      const steeringTrust: TrustClass[] = [...steerers, ...(unnamed ? ["outsider" as const] : [])];

      const repoChanges: RepoChangeRequest[] = [];
      let registered: Readonly<Record<string, string>> | undefined;
      const registeredUrls = async (): Promise<Readonly<Record<string, string>>> => (registered ??= (await deps.repositoryUrlsOf?.(orgId, project)) ?? {});
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
            const spansBefore = spans.length;
            for (const comment of listed?.comments ?? []) {
              if (taken >= MAX_PULL_REQUEST_COMMENTS) break;
              const row = await captured.pullRequestWords({ ...where, host: address.host, repository: address.repository, number: address.number, surface: comment.kind, commentId: comment.id });
              if (row === undefined) continue;
              const trust = await person(row.authorDeveloperId);
              if (trust === undefined) continue;
              taken += 1;
              let led = acted.has(`${comment.kind}:${comment.id}`);
              if (!led && comment.kind === "review_comment" && row.side === "RIGHT" && row.path !== undefined && row.line !== undefined && row.commitId !== undefined && listed?.headRevision !== undefined && listed.headRevision !== row.commitId && deps.humanChangedFiles !== undefined) {
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
                audience: row.audience, scopes: [row.scope], ...(led ? { ledToChange: true } : {}), ...(place === undefined || place === "" ? {} : { paths: [place] }),
              });
            }
            // Lessons in the repo (decision 50c): the merged change request, described without naming a host, for the repo-only reflection. The host's adapter gave the head; the place and the readers are the
            // comment rows' own (one place or none). Only a merged pull request with at least one comment of this read.
            const change = repoChangeOf({
              pullRequest, address, listed, comments: spans.slice(spansBefore).filter((span) => span.kind === "pr_comment"),
              registered: (await registeredUrls())[pullRequest.repositoryId], hostAddress: deps.repositoryAddress?.(address.host, address.repository), humanEditsRead: deps.humanEditsSupported?.(address.host) ?? true,
            });
            if (change !== undefined) repoChanges.push(change);
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
      const audience = audienceOf(task.taskId, visibility, new Date((deps.now ?? Date.now)()).toISOString());
      const wide = await sharedWithProjectNow(deps, orgId, task.taskId);
      const base_: TaskSubjectBase = {
        facts: {
          workspaceId: orgId, project, taskId: task.taskId, repositories,
          ...(base === undefined ? {} : { baseCommit: base.commit }), ...(mergedCommit === undefined ? {} : { mergedCommit }),
          ...(outcome === undefined ? {} : { outcome }),
          // An erased initiator is nobody: with no `startedBy` and an `agent` mark the start actor is undefined, so no outcome is measured against them.
          task: initiatorErased ? { developerId: creatorId, agent: task.agent ?? {} } : { developerId: creatorId, ...(task.startedBy === undefined ? {} : { startedBy: { developerId: await canon(task.startedBy.developerId) } }), ...(task.agent === undefined ? {} : { agent: task.agent }) },
          rest: {
            ...(initiatorId === undefined || initiatorErased ? {} : { initiatorTrust: await trustOf(initiatorId) }),
            steeringTrust,
            ...(creatorErased ? {} : { intentTrust: await trustOf(creator) }),
            ...(links.length === 0 ? {} : { links }),
            audience,
            // `sharedTask` is a FROZEN, coarse mark taken at reflection time (true / false when the live reads say so, unset when they could not be read): a lesson is publishable only if its source tasks were project-wide
            // THEN. It is necessary, not sufficient: the task may be narrowed afterwards, so publishing must re-check every source task's live visibility (decision 32; that check is not in this change).
            ...(wide === undefined ? {} : { sharedTask: wide }),
            spans,
          },
        },
        sendBackRequestIds,
        ...(repoChanges.length === 0 ? {} : { repoChanges }),
      };
      return base_;
    },
  };
}
