// R5: the code-host tap. It reads host-neutral events (`CodeHostEvent`); `github.ts` turns GitHub webhook bodies into them and an Enterprise
// code-host plug-in (W6) turns its own events into them, so the record never sees a host's own types (design 4.4.1).
//
// What it writes: pull requests, reviews, comments, CI conclusions, reverts. What it deliberately does NOT write (owner decision Q5, 2026-10-30):
// the changed lines of a human edit to a Rovara pull request. At merge those are read live from the host, handed once, in memory, to the
// learning extractor, and dropped. Only the lesson the extractor makes, and a link to the pull request, are ever kept (by the learning lane).
import { createHash } from "node:crypto";
import { addedText, cleanText, gate, isExcluded, linksOf, scalars, withRetention, MAX_DRAFTS_PER_DELIVERY, type GateDependencies } from "./common.js";
import type {
  ActorResolverPort, Audience, OnceClaimPort, PushIndexPort, PushRecord, RecordDraft, RecordSinkPort, RovaraPullRequest, RovaraPullRequestIndexPort,
  PriorEditsPort, SourceSystem, TapLog, TrackRecordPort,
} from "./ports.js";

export interface CodeHostPerson {
  /** The host's stable id (GitHub's numeric id), as text. */
  id: string;
  login?: string;
  isBot: boolean;
}

export interface CodeHostRepo {
  /** `github`, or the plug-in's name. */
  host: string;
  id: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch?: string;
  /** Resolved by the adapter from the installation: never from the delivery body. */
  workspaceId: string;
  project?: string;
}

export type CodeHostEvent =
  | { type: "pr"; repo: CodeHostRepo; number: number; url: string; action: "opened" | "closed" | "reopened" | "edited"; merged: boolean; title: string; body?: string;
      author: CodeHostPerson; /** Who made this change (the delivery's sender): the person an edit, a close or a reopen is recorded under. Absent: the author. */ editor?: CodeHostPerson;
      /** What an `edited` change changed, and the text as it was (GitHub's `changes`). Absent: unknown, and no words of the edit are kept. */ changed?: { title?: boolean; body?: boolean }; previousBody?: string; previousTitle?: string; headSha: string; headRef?: string; mergeCommitSha?: string;
      /** Who merged it (the host's `merged_by`), for a merged pull request: the person a revert pull request is credited to. Absent: unknown, and a revert pull request then records nothing. */ mergedBy?: CodeHostPerson; baseRef: string; at: string; version: string }
  | { type: "review"; repo: CodeHostRepo; prNumber: number; id: string; url: string; action: "submitted" | "edited" | "dismissed"; state: string; body?: string; author: CodeHostPerson; editor?: CodeHostPerson; previousBody?: string; /** When the delivery was received, for an edit or dismissal that carries no time of its own: it orders the review's changes (it is not part of the row's identity). */ receivedAt?: string; at: string; version: string }
  | { type: "comment"; repo: CodeHostRepo; prNumber: number; id: string; url: string; action: "created" | "edited" | "deleted"; surface: "review_comment" | "discussion";
      body?: string; author: CodeHostPerson; editor?: CodeHostPerson; previousBody?: string; path?: string;
      /** An inline comment: the line it was made on and the commit it was made on, as the host said them. Kept so a later reader can tell whether the code the comment was about then changed. */ line?: number; commitId?: string; /** Which side of the diff the comment's line is numbered on: `LEFT` is the base file (a deleted line), `RIGHT` the file as of the commit. */ side?: "LEFT" | "RIGHT"; at: string; version: string }
  | { type: "ci"; repo: CodeHostRepo; id: string; name: string; conclusion: string; headSha: string; prNumbers: readonly number[]; url?: string; at: string }
  | { type: "push"; repo: CodeHostRepo; ref: string; commits: ReadonlyArray<{ sha: string; message: string }>; at: string;
      /** The pushed range and the account the host authenticated for the push (the signed delivery's sender): the second way a human commit is vouched for. */
      before?: string; after?: string; sender?: CodeHostPerson }
  | { type: "repository"; repo: CodeHostRepo; action: "deleted" | "transferred"; at: string };

/** The compare of two commits, read live from the host. */
export interface CodeHostDiff {
  /** `ahead`: base is an ancestor of head. Anything else is not a clean human delta and is dropped. */
  status: "identical" | "ahead" | "diverged" | "behind";
  /**
   * `verified`: the host verified the signature, which proves the COMMITTER's key, not who wrote the commit. `author` is only the account the host matched to
   * the author email, which anyone with push access can set. `webFlow`: the host itself committed it (a web-UI edit, signed as the logged-in author).
   */
  commits: ReadonlyArray<{ sha: string; author?: CodeHostPerson; committer?: CodeHostPerson; verified: boolean; webFlow?: boolean;
    /** The commit has more than one parent (a merge, as when a branch is updated from the base branch): it carries other people's work. */ merge?: boolean;
    /** The commit message carries a `Co-authored-by:` trailer (as a committed suggestion does), or the host did not give the message: someone else may have written part of it, and the host cannot prove who. */ coAuthored?: boolean }>;
  files: ReadonlyArray<{ path: string; additions: number; deletions: number; patch?: string }>;
  truncated: boolean;
}

export interface CodeHostDiffReader {
  compare(input: { repo: CodeHostRepo; base: string; head: string }): Promise<CodeHostDiff | undefined>;
}

/** One changed file of a human edit, in memory only. `hunks` are hunk headers and changed lines (at most 200), redacted. */
export interface HumanEditFile {
  path: string;
  additions: number;
  deletions: number;
  symbols: string[];
  hunks: string[];
}

export interface HumanEditInput {
  workspaceId: string;
  project: string;
  repo: string;
  taskId: string;
  pullRequest: { number: number; url: string };
  /** Every human author was a company member with a live project role (otherwise nothing is handed on). */
  trust: "member";
  authorCount: number;
  /** The authors as the company's canonical developer ids, each once (never a login or an email): so a lesson built from the edit names them, and their erasure reaches it. */
  authors: string[];
  /** Who may read what these lines say: the repository's audience (restricted, with a live access check, for a private repository) and its scope. Every span built from the lines carries them. */
  audience: Audience;
  scope: string;
  files: HumanEditFile[];
  /** The only thing of this input that may be kept. */
  link: string;
}

/** The learning extractor (L1). It reads `files` once and keeps at most lessons and `link`. Never stores `files`. */
export interface HumanEditExtractorPort {
  extract(input: HumanEditInput): Promise<{ candidates: number }>;
}

/** What reading a human edit needs, small enough to be a queue message: the compare is made later, off the webhook's answer. */
export interface HumanEditJob {
  repo: CodeHostRepo;
  project: string;
  taskId: string;
  pullRequest: { number: number; url: string };
  candidateHeadSha: string;
  headSha: string;
  /** The pull request's head branch, to match pushes against. */
  headRef?: string;
}

export interface CodeHostTapDependencies extends GateDependencies {
  sink: RecordSinkPort;
  actors: ActorResolverPort;
  rovaraPrs: RovaraPullRequestIndexPort;
  trackRecord?: TrackRecordPort;
  diffs?: CodeHostDiffReader;
  extractor?: HumanEditExtractorPort;
  /** Makes "once" true across redeliveries: the human-edit hand-off and the revert re-score each run once per task. Absent: no dedupe (tests only). */
  claims?: OnceClaimPort;
  /** Authenticated pushes (sender, before, after) for the push-chain rule of human-edit authorship. Absent: only the verified-committer rule can accept a commit. */
  pushes?: PushIndexPort;
  /** Where a human-edit read is queued so the compare and the extractor never run inside the webhook's answer. Absent: it runs inline. */
  humanEditJobs?: { enqueue(job: HumanEditJob): Promise<void> };
  log?: TapLog;
  /** S2: lets a comment edited by its own author, with no earlier text from the host, keep that author's whole text when nobody else edited it before. Absent: such an edit keeps no words. */
  priorEdits?: PriorEditsPort;
  /** A repository deleted or transferred marks its source row's health `failing` (after the place is tombstoned). Absent: the row is left as it is (tests). */
  sourceHealth?: { markFailing(input: { workspaceId: string; source: SourceSystem; scope: string }): Promise<void> };
  /** SRL-6: told when a delete at the source was accepted by no durable path, so the company's Health page can show it. A port that throws never changes the answer. */
  failures?: { tombstoneLost(workspaceId: string): Promise<void> };
}

export interface TapResult {
  written: number;
  duplicates: number;
  refused: number;
  failed: number;
  /** True when a DELETE at the source could not be accepted by any durable path (table, queue, event invoke). The webhook answer is then retryable, so the host can send it again. */
  removalFailed?: boolean;
}

export const HUMAN_EDIT_MAX_FILES = 40;
export const HUMAN_EDIT_MAX_LINES_PER_FILE = 200;
const HUMAN_EDIT_LINE_MAX_CHARS = 400;
const SHA = /^[0-9a-f]{40}$/;
/** How long the push index keeps a push: a range of commits and who pushed it, no content. */
export const PUSH_INDEX_TTL_SECONDS = 30 * 86_400;
const PUSH_CHAIN_MAX = 50;
const REVERTS_COMMIT = /This reverts commit ([0-9a-f]{40})\b/gi;

/** The record's source name for a host name: `github`, or `codehost:<plug-in>`. */
export function sourceOfHost(host: string): SourceSystem {
  return host === "github" ? "github" : `codehost:${host}`;
}

export function sourceOf(repo: CodeHostRepo): SourceSystem {
  return sourceOfHost(repo.host);
}

export function repoScope(repo: CodeHostRepo): string {
  return `${sourceOf(repo)}:repo/${repo.id}`;
}

function audienceOf(repo: CodeHostRepo, at: string): Audience {
  if (!repo.isPrivate) return { kind: "project" };
  return { kind: "restricted", acl: { source: sourceOf(repo), scope: repoScope(repo), capturedAt: at, liveCheck: "on_read" } };
}

const prId = (repo: CodeHostRepo, number: number): string => `${repo.fullName}#pr${number}`;

export function createCodeHostTap(deps: CodeHostTapDependencies): { handle(event: CodeHostEvent, hooks?: { removalStarted?: () => void }): Promise<TapResult> } {
  const log: TapLog = deps.log ?? (() => undefined);

  async function handle(event: CodeHostEvent, hooks: { removalStarted?: () => void } = {}): Promise<TapResult> {
    const result: TapResult = { written: 0, duplicates: 0, refused: 0, failed: 0 };
    // A delete at the source is always honoured, before any mode or source-row check: what was recorded must go whatever the settings say now.
    if (event.type === "repository" || (event.type === "comment" && event.action === "deleted")) {
      // The webhook is told first that a removal began, so one still running at its budget is answered retryable.
      try { hooks.removalStarted?.(); } catch { /* a caller's callback never fails the removal */ }
      try {
        await deps.sink.tombstone(event.type === "repository"
          ? { workspaceId: event.repo.workspaceId, system: event.repo.host, scope: repoScope(event.repo), cause: "source_deleted" }
          : { workspaceId: event.repo.workspaceId, system: event.repo.host, sourceIds: [commentId(event)], cause: "source_deleted" });
      } catch {
        result.failed += 1;
        result.removalFailed = true;
        log("record.tombstone_failed", { host: event.repo.host });
        try { await deps.failures?.tombstoneLost(event.repo.workspaceId); } catch { /* the count is best effort */ }
      }
      // The place is gone at its source: its source row (if any) reads as failing. Never fails the delivery.
      if (event.type === "repository" && deps.sourceHealth !== undefined) {
        try {
          await deps.sourceHealth.markFailing({ workspaceId: event.repo.workspaceId, source: sourceOf(event.repo), scope: repoScope(event.repo) });
        } catch {
          log("record.health_failed", { host: event.repo.host });
        }
      }
      return result;
    }
    const config = await gate(deps, { workspaceId: event.repo.workspaceId, ...(event.repo.project === undefined ? {} : { project: event.repo.project }), source: sourceOf(event.repo), scope: repoScope(event.repo) });
    if (config === undefined) {
      // S2: an edit of a comment while capture is off (or the repository has no source row) is not kept, but its words may be in the comment's text: the item is marked.
      if (event.type === "comment" && event.action === "edited") await deps.priorEdits?.noteUnstored?.({ workspaceId: event.repo.workspaceId, source: sourceOf(event.repo), system: event.repo.host, id: commentId(event) }).catch(() => undefined);
      return result;
    }
    try {
      const drafts: RecordDraft[] = [];
      const project = event.repo.project ?? config.project;
      const base = { workspaceId: event.repo.workspaceId, ...(project === undefined ? {} : { project }), repo: event.repo.fullName, source: sourceOf(event.repo), scope: repoScope(event.repo), links: [] as string[] };
      const actor = async (person: CodeHostPerson): Promise<NonNullable<RecordDraft["actor"]>> => {
        const resolved = await deps.actors.resolve({ workspaceId: event.repo.workspaceId, project, system: sourceOf(event.repo), sourceId: person.id, isBot: person.isBot });
        return { sourceId: person.id, ...(resolved.developerId === undefined ? {} : { developerId: resolved.developerId }), trust: person.isBot ? "system" : resolved.trust };
      };
      // Per-editor rows (owner, 2026-11-02): ONE row per change to a pull request, review or comment, under the person who made it (the delivery's sender for an edit, a close, a reopen, a dismissal;
      // the author for the first sight). A row holds only that person's own words: an edit credits the editor with the lines they added to what was there, and an edit whose earlier text the host did
      // not send credits no words at all (except a comment edited by its own author). Nothing is frozen and nothing is replaced, so a person's erase takes exactly their rows.
      const tagOf = (person: CodeHostPerson): string => createHash("sha256").update(person.id).digest("hex").slice(0, 12);
      const rowOf = (fields: { person: CodeHostPerson; at: string; version: string }): { person: CodeHostPerson; version: string; order: number } => {
        const ms = Date.parse(fields.at);
        return { person: fields.person, version: `${fields.version}:${tagOf(fields.person)}`.slice(0, 100), order: Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : 0 };
      };
      switch (event.type) {
        case "pr": {
          const doer = event.action === "opened" ? event.author : event.editor ?? event.author;
          if (isExcluded(config, event.author.id, event.author.login, doer.id, doer.login)) {
            // S2: an excluded person's change is not kept, but its words may be in the item's text.
            if (event.action !== "opened") await deps.priorEdits?.noteUnstored?.({ workspaceId: event.repo.workspaceId, source: sourceOf(event.repo), system: event.repo.host, id: prId(event.repo, event.number) }).catch(() => undefined);
            return result;
          }
          const who = await actor(doer);
          const row = rowOf({ person: doer, at: event.at, version: event.version });
          let text: string | undefined;
          if (event.action === "opened") text = cleanText([event.title, event.body].filter((part) => part !== undefined && part !== "").join("\n\n"));
          else if (event.action === "edited") text = cleanText([event.changed?.title === true ? addedText(event.previousTitle, event.title) : undefined, event.changed?.body === true ? addedText(event.previousBody, event.body) : undefined].filter((part) => part !== undefined && part !== "").join("\n\n"));
          drafts.push({
            ...base, kind: "github.pr", occurredAt: event.at,
            sourceRef: { system: event.repo.host, id: prId(event.repo, event.number), url: event.url, version: row.version, order: row.order },
            actor: who, trust: who.trust, pieceTrusts: [who.trust], audience: audienceOf(event.repo, event.at), ...(text === undefined ? {} : { text }),
            structured: scalars({ number: event.number, action: event.action, merged: event.merged, base: event.baseRef, headSha: event.headSha, mergeCommitSha: event.mergeCommitSha }),
            links: linksOf(event.url), retention: config.retention,
          });
          break;
        }
        case "review": {
          const doer = event.action === "submitted" ? event.author : event.editor ?? event.author;
          if (isExcluded(config, event.author.id, event.author.login, doer.id, doer.login)) {
            // S2: an excluded person's change is not kept, but its words may be in the item's text.
            if (event.action !== "submitted") await deps.priorEdits?.noteUnstored?.({ workspaceId: event.repo.workspaceId, source: sourceOf(event.repo), system: event.repo.host, id: `${prId(event.repo, event.prNumber)}:review${event.id}` }).catch(() => undefined);
            return result;
          }
          const who = await actor(doer);
          const row = rowOf({ person: doer, at: event.receivedAt ?? event.at, version: event.version });
          const text = event.action === "submitted" ? cleanText(event.body) : event.action === "edited" ? cleanText(addedText(event.previousBody, event.body)) : undefined;
          drafts.push({
            ...base, kind: "github.review", occurredAt: event.at,
            sourceRef: { system: event.repo.host, id: `${prId(event.repo, event.prNumber)}:review${event.id}`, url: event.url, parentId: prId(event.repo, event.prNumber), version: row.version, order: row.order },
            actor: who, trust: who.trust, pieceTrusts: [who.trust], audience: audienceOf(event.repo, event.at), ...(text === undefined ? {} : { text }),
            structured: scalars({ prNumber: event.prNumber, state: event.state, action: event.action }),
            links: linksOf(event.url), retention: config.retention,
          });
          break;
        }
        case "comment": {
          const doer = event.action === "created" ? event.author : event.editor ?? event.author;
          if (isExcluded(config, event.author.id, event.author.login, doer.id, doer.login)) {
            // S2: an excluded person's change is not kept, but its words may be in the item's text.
            if (event.action !== "created") await deps.priorEdits?.noteUnstored?.({ workspaceId: event.repo.workspaceId, source: sourceOf(event.repo), system: event.repo.host, id: commentId(event) }).catch(() => undefined);
            return result;
          }
          const who = await actor(doer);
          const row = rowOf({ person: doer, at: event.at, version: event.version });
          let text: string | undefined;
          if (event.action === "created") text = cleanText(event.body);
          else if (event.action === "edited") {
            // Only the comment's own author edits it, apart from a repository administrator, whose edit always sends what it was.
            const added = addedText(event.previousBody, event.body);
            let whole: string | undefined;
            if (added === undefined && event.previousBody === undefined && doer.id === event.author.id) {
              // S2: only when nobody else edited this comment before (their words may be in it). A lookup that fails, or no lookup, keeps no words.
              const others = deps.priorEdits === undefined ? true : await deps.priorEdits.editedByOthers({ workspaceId: event.repo.workspaceId, source: sourceOf(event.repo), system: event.repo.host, id: commentId(event), actorSourceId: doer.id }).catch(() => true);
              if (!others) whole = event.body;
            }
            text = cleanText(added ?? whole);
          }
          drafts.push({
            ...base, kind: "github.review_comment", occurredAt: event.at,
            sourceRef: { system: event.repo.host, id: commentId(event), url: event.url, parentId: prId(event.repo, event.prNumber), version: row.version, order: row.order },
            actor: who, trust: who.trust, pieceTrusts: [who.trust], audience: audienceOf(event.repo, event.at), ...(text === undefined ? {} : { text }),
            structured: scalars({ prNumber: event.prNumber, surface: event.surface, path: event.path, line: event.line, commitId: event.commitId, side: event.side, action: event.action }),
            links: linksOf(event.url), retention: config.retention,
          });
          break;
        }
        case "ci": {
          // CI text (logs, annotations) is customer-system text and is never fetched here: only the verdict is kept.
          drafts.push({
            ...base, kind: "github.ci", occurredAt: event.at,
            sourceRef: { system: event.repo.host, id: `${event.repo.fullName}:ci:${event.id}`, ...(event.url === undefined ? {} : { url: event.url }), version: event.conclusion },
            trust: "system", audience: audienceOf(event.repo, event.at),
            structured: scalars({ name: event.name, conclusion: event.conclusion, headSha: event.headSha, prNumbers: event.prNumbers.slice(0, 10).join(",") }),
            links: linksOf(event.url), retention: config.retention,
          });
          break;
        }
        case "push": {
          // A tiny index of who pushed which range, for human-edit authorship. Branch pushes only; nothing of the commits is kept.
          if (deps.pushes !== undefined && event.sender !== undefined && event.ref.startsWith("refs/heads/") && event.before !== undefined && event.after !== undefined && SHA.test(event.before) && SHA.test(event.after)) {
            try {
              await deps.pushes.record({ workspaceId: event.repo.workspaceId, host: event.repo.host, ttlSeconds: PUSH_INDEX_TTL_SECONDS,
                push: { repo: event.repo.fullName, ref: event.ref, before: event.before, after: event.after, senderId: event.sender.id, senderIsBot: event.sender.isBot, at: event.at } });
            } catch {
              log("record.push_index_failed", { host: event.repo.host });
            }
          }
          break;
        }
      }
      for (const draft of drafts.slice(0, MAX_DRAFTS_PER_DELIVERY)) await write(draft, result);
      await revertsOf(event, config, result);
      if (event.type === "pr" && event.action === "closed" && event.merged) {
        await noteMerge(event);
        await humanEdit(event);
      }
    } catch {
      result.failed += 1;
      log("record.codehost_failed", { host: event.repo.host });
    }
    return result;
  }

  async function write(draft: RecordDraft, result: TapResult): Promise<void> {
    try {
      const outcome = await deps.sink.put(withRetention(draft, draft.retention));
      if (outcome.status === "stored" || outcome.status === "queued") result.written += 1;
      else if (outcome.status === "duplicate") result.duplicates += 1;
      else result.refused += 1;
    } catch {
      result.failed += 1;
      log("record.write_failed", { kind: draft.kind });
    }
  }

  /**
   * Whether a revert told by words is a member's. For a push (`commitSha` given): the compare of the pushed range must show that commit, not a merge, verified with its author as committer (or the host's web-flow
   * account for a squash merge), with a live member as its AUTHOR; and the account that pushed it must be a live member too. For a pull request (no `commitSha`): the pull request's author must be a member.
   * The result is the author, who is credited as the reverter; undefined when anything is missing or cannot be told.
   */
  async function memberRevertAuthor(
    repo: CodeHostRepo, project: string, source: NonNullable<Awaited<ReturnType<typeof gate>>>, diff: CodeHostDiff | undefined, pusher: CodeHostPerson | undefined, commitSha: string | undefined,
  ): Promise<CodeHostPerson | undefined> {
    const memberPerson = async (person: CodeHostPerson | undefined): Promise<boolean> => {
      if (person === undefined || person.isBot || isExcluded(source, person.id, person.login)) return false;
      try {
        const resolved = await deps.actors.resolve({ workspaceId: repo.workspaceId, project, system: sourceOf(repo), sourceId: person.id });
        return resolved.developerId !== undefined && resolved.trust === "member";
      } catch { return false; }
    };
    if (commitSha === undefined) return (await memberPerson(pusher)) ? pusher : undefined;
    if (diff === undefined || diff.status !== "ahead" || diff.truncated) return undefined;
    const commit = diff.commits.find((candidate) => candidate.sha === commitSha);
    if (commit === undefined || commit.merge === true || !commit.verified) return undefined;
    const sameCommitter = commit.webFlow === true || (commit.committer !== undefined && commit.author !== undefined && commit.committer.id === commit.author.id);
    if (!sameCommitter || !await memberPerson(commit.author) || !await memberPerson(pusher)) return undefined;
    return commit.author;
  }

  /** A merged revert pull request, or a default-branch push whose commits say "This reverts commit <sha>". Only a Rovara pull request's merge commit counts. */
  async function revertsOf(event: CodeHostEvent, source: NonNullable<Awaited<ReturnType<typeof gate>>>, result: TapResult): Promise<void> {
    const retention = source.retention;
    // A revert is told only by words (a commit message, a pull request's title and body), which anyone who can get a commit or a pull request onto the default branch can write. It counts only when a member is
    // proved behind it (see `memberRevertAuthor` and the proof below).
    let targets: Array<{ target: RovaraPullRequest; via: string; at: string; by: CodeHostPerson | undefined }> = [];
    const repo = event.repo;
    if (event.type === "push") {
      if (repo.defaultBranch === undefined || event.ref !== `refs/heads/${repo.defaultBranch}`) return;
      for (const commit of event.commits.slice(0, 100)) {
        for (const sha of gitRevertedCommits(commit.message)) {
          const target = await deps.rovaraPrs.byMergeCommit({ workspaceId: repo.workspaceId, host: repo.host, repo: repo.fullName, sha });
          if (target !== undefined) targets.push({ target, via: commit.sha, at: event.at, by: event.sender });
        }
      }
    } else if (event.type === "pr" && event.action === "closed" && event.merged && repo.defaultBranch !== undefined && event.baseRef === repo.defaultBranch && /^revert\s+["“']/i.test(event.title.trim())) {
      for (const number of revertedPullRequests(event.body ?? "", repo.fullName)) {
        const target = await deps.rovaraPrs.byNumber({ workspaceId: repo.workspaceId, host: repo.host, repo: repo.fullName, number });
        if (target !== undefined) targets.push({ target, via: event.mergeCommitSha ?? prId(repo, event.number), at: event.at, by: event.author });
      }
      for (const sha of revertedCommits(event.body ?? "")) {
        const target = await deps.rovaraPrs.byMergeCommit({ workspaceId: repo.workspaceId, host: repo.host, repo: repo.fullName, sha });
        if (target !== undefined) targets.push({ target, via: event.mergeCommitSha ?? prId(repo, event.number), at: event.at, by: event.author });
      }
    }
    // A revert told by a commit message counts only when its commit is authored by a member AND pushed by a member. A revert PULL REQUEST counts only when it was MERGED by a live project member (the host's
    // `merged_by`, and the delivery's sender when it names someone else is a mismatch): the member who merged it is credited as the reverter, whoever opened it (the host's Revert button makes the member who
    // clicks it the author, but a bot or an outsider can open one that a member then merges). Anything unproven records nothing: no outcome, no re-score, no reverter.
    const proved: typeof targets = [];
    let range: CodeHostDiff | undefined | null = null;
    const merger = event.type === "pr" && event.mergedBy !== undefined && (event.editor === undefined || event.editor.id === event.mergedBy.id) ? event.mergedBy : undefined;
    for (const entry of targets) {
      let author: CodeHostPerson | undefined;
      if (event.type === "push") {
        if (range === null) range = event.before !== undefined && event.after !== undefined && SHA.test(event.before) && SHA.test(event.after) && deps.diffs !== undefined
          ? await deps.diffs.compare({ repo, base: event.before, head: event.after }).catch(() => undefined) : undefined;
        author = await memberRevertAuthor(repo, entry.target.project, source, range ?? undefined, event.sender, entry.via);
      } else author = await memberRevertAuthor(repo, entry.target.project, source, undefined, merger, undefined);
      if (author !== undefined) proved.push({ ...entry, by: author });
      else log("record.revert_unproven", { host: repo.host });
    }
    targets = proved;
    // One revert per Rovara pull request, however many deliveries or ways tell us of it.
    const seen = new Set<string>();
    targets = targets.filter(({ target }) => !seen.has(target.taskId) && seen.add(target.taskId));
    for (const { target, via, at, by } of targets.slice(0, 20)) {
      // Who reverted it (LR-W1): the reverting pull request's author, or the account that pushed the revert commit. The TASK's outcome ("reverted") is task data and is always recorded
      // with no person on it. The reverter is kept on a SEPARATE person-link row (`rovara.reverted_by`, the person as that row's `actor`, never in a structured field), which an
      // erase of that person deletes with their other rows. Only a company member counts: a bot, an excluded account, an outsider, an unknown account, an erased one, or a resolver
      // that fails leaves the revert without a person (an outcome nobody measured), and the outcome rows are recorded anyway.
      let reverter: NonNullable<RecordDraft["actor"]> | undefined;
      if (by !== undefined && !by.isBot && !isExcluded(source, by.id, by.login)) {
        try {
          const resolved = await deps.actors.resolve({ workspaceId: repo.workspaceId, project: target.project, system: sourceOf(repo), sourceId: by.id });
          if (resolved.developerId !== undefined && resolved.trust === "member") reverter = { sourceId: resolved.developerId, developerId: resolved.developerId, trust: "member" };
        } catch {
          log("record.reverter_unresolved", { host: repo.host });
        }
      }
      const common = {
        workspaceId: repo.workspaceId, project: target.project, repo: repo.fullName, source: sourceOf(repo), scope: repoScope(repo), occurredAt: at, retention: retention,
        audience: audienceOf(repo, at), links: linksOf(target.url),
      };
      await write({
        ...common, kind: "github.revert", trust: "system",
        sourceRef: { system: repo.host, id: `${repo.fullName}:revert:${target.taskId}`, url: target.url, version: "1" },
        structured: scalars({ taskId: target.taskId, prNumber: target.number, revertedBy: via }),
      }, result);
      await write({
        ...common, kind: "rovara.closed", trust: "rovara", source: "rovara",
        sourceRef: { system: "rovara", id: `task:${target.taskId}:closed`, url: target.url, version: "reverted" },
        structured: scalars({ taskId: target.taskId, outcome: "reverted", revertedBy: via }),
      }, result);
      if (reverter !== undefined) {
        await write({
          ...common, kind: "rovara.reverted_by", trust: "member", source: "rovara", actor: reverter,
          sourceRef: { system: "rovara", id: `task:${target.taskId}:reverted_by`, url: target.url, version: "1" },
          structured: scalars({ taskId: target.taskId }),
        }, result);
      }
      if (deps.trackRecord !== undefined) {
        // Once per task, however many deliveries tell of the revert; a failure gives the claim back so the next delivery retries.
        const key = `revert#${target.taskId}`;
        const claimed = deps.claims === undefined || await deps.claims.claim(key);
        if (claimed) {
          try {
            await deps.trackRecord.markNotHeld({ workspaceId: repo.workspaceId, project: target.project, taskId: target.taskId, reason: "reverted", revertRef: via });
          } catch {
            result.failed += 1;
            log("record.track_record_rescore_failed", { host: repo.host });
            await deps.claims?.release(key).catch(() => undefined);
          }
        }
      }
    }
  }

  /** A merged Rovara pull request: its merge commit is kept (once the host names it) for the revert-by-commit match and for the task's lessons. A failure never fails the delivery. */
  async function noteMerge(event: Extract<CodeHostEvent, { type: "pr" }>): Promise<void> {
    if (deps.rovaraPrs.recordMerge === undefined || event.mergeCommitSha === undefined || !SHA.test(event.mergeCommitSha)) return;
    // Only a merge into the default branch is the commit a revert or a lesson's citation can rely on: a milestone or stacked pull request's merge commit may be restacked away.
    if (event.repo.defaultBranch === undefined || event.baseRef !== event.repo.defaultBranch) return;
    try {
      const rovara = await deps.rovaraPrs.byNumber({ workspaceId: event.repo.workspaceId, host: event.repo.host, repo: event.repo.fullName, number: event.number });
      if (rovara === undefined) return;
      await deps.rovaraPrs.recordMerge({ workspaceId: event.repo.workspaceId, host: event.repo.host, repo: event.repo.fullName, number: event.number, taskId: rovara.taskId, project: rovara.project, url: rovara.url, mergeCommitSha: event.mergeCommitSha });
    } catch {
      log("record.merge_not_noted", { host: event.repo.host });
    }
  }

  /**
   * At merge of a Rovara pull request: finds whether anything was pushed after Rovara's last push and, if so, queues (or runs) the live read. Nothing is
   * written to the record, and the compare and the extractor never run inside the webhook's answer when a job queue is given.
   */
  async function humanEdit(event: Extract<CodeHostEvent, { type: "pr" }>): Promise<void> {
    if (deps.diffs === undefined || deps.extractor === undefined) return;
    const rovara = await deps.rovaraPrs.byNumber({ workspaceId: event.repo.workspaceId, host: event.repo.host, repo: event.repo.fullName, number: event.number });
    if (rovara === undefined || !SHA.test(rovara.candidateHeadSha) || !SHA.test(event.headSha)) return;
    // Nothing was pushed after Rovara's last push: no human edit, and no call to the host.
    if (rovara.candidateHeadSha === event.headSha) return;
    const job: HumanEditJob = { repo: event.repo, project: rovara.project, taskId: rovara.taskId, pullRequest: { number: event.number, url: rovara.url }, candidateHeadSha: rovara.candidateHeadSha, headSha: event.headSha, ...(event.headRef === undefined ? {} : { headRef: event.headRef }) };
    if (deps.humanEditJobs !== undefined) await deps.humanEditJobs.enqueue(job);
    else await runHumanEdit(deps, job);
  }

  return { handle };
}

/**
 * Reads, live from the host, what people changed after Rovara's last push and hands it to the extractor, once per task and head. Hands nothing on unless
 * the whole picture is checked: the compare is a clean "ahead" and not cut short, and authorship is proved (see below). Never writes to the record.
 */
export async function runHumanEdit(deps: Pick<CodeHostTapDependencies, "actors" | "diffs" | "extractor" | "claims" | "pushes" | "mode" | "config" | "log">, job: HumanEditJob): Promise<"handed_on" | "skipped"> {
  const log: TapLog = deps.log ?? (() => undefined);
  if (deps.diffs === undefined || deps.extractor === undefined) return "skipped";
  const config = await gate(deps, { workspaceId: job.repo.workspaceId, project: job.project, source: sourceOf(job.repo), scope: repoScope(job.repo) });
  if (config === undefined) return "skipped";
  const diff = await deps.diffs.compare({ repo: job.repo, base: job.candidateHeadSha, head: job.headSha });
  if (diff === undefined || diff.status === "identical" || diff.files.length === 0) return "skipped";
  if (diff.status !== "ahead" || diff.truncated) {
    // A force push or a rebase mixes in Rovara's own code and other people's commits; a cut-short compare has authors nobody checked.
    log("human_edit.skipped", { reason: diff.truncated ? "compare_truncated" : "not_a_clean_delta" });
    return "skipped";
  }
  const proof = await provenAuthors(deps, config, { repo: job.repo, project: job.project, base: job.candidateHeadSha, head: job.headSha, ...(job.headRef === undefined ? {} : { headRef: job.headRef }) }, diff, log);
  if (!("authors" in proof)) return "skipped";
  const authorIds = proof.authors;
  const key = `human_edit#${job.taskId}#${job.headSha}`;
  if (deps.claims !== undefined && !await deps.claims.claim(key)) return "skipped";
  try {
    const outcome = await deps.extractor.extract({
      workspaceId: job.repo.workspaceId, project: job.project, repo: job.repo.fullName, taskId: job.taskId, pullRequest: job.pullRequest,
      trust: "member", authorCount: authorIds.length, authors: authorIds, audience: audienceOf(job.repo, new Date().toISOString()), scope: repoScope(job.repo), files: diff.files.slice(0, HUMAN_EDIT_MAX_FILES).map(humanEditFile), link: job.pullRequest.url,
    });
    log("human_edit.handed_on", { files: Math.min(diff.files.length, HUMAN_EDIT_MAX_FILES), candidates: outcome.candidates });
    return "handed_on";
  } catch {
    // The claim is given back and the failure is told on (a fixed error, never the extractor's own text): the queue's consumer then retries the job, and an inline run counts it as failed.
    await deps.claims?.release(key).catch(() => undefined);
    log("human_edit.extractor_failed", {});
    throw new Error("the human edit could not be read");
  }
}

/**
 * The files a range of a pull request's branch changed, when the capture is on for the repository and EVERY commit in the range is proved a live member's (`provenAuthors`): so a later reader may say
 * "a person changed these lines". Undefined for anything else (no compare, a force push, a merge commit, a bot or an outsider, Rovara's own push, a chain with a gap). Nothing is stored.
 */
export async function provenRangeFiles(deps: Pick<CodeHostTapDependencies, "actors" | "diffs" | "pushes" | "mode" | "config" | "log">, range: CommitRange): Promise<CodeHostDiff["files"] | undefined> {
  if (deps.diffs === undefined || !SHA.test(range.base) || !SHA.test(range.head) || range.base === range.head) return undefined;
  const config = await gate(deps, { workspaceId: range.repo.workspaceId, project: range.project, source: sourceOf(range.repo), scope: repoScope(range.repo) });
  if (config === undefined) return undefined;
  const diff = await deps.diffs.compare({ repo: range.repo, base: range.base, head: range.head });
  if (diff === undefined || diff.status === "identical" || diff.files.length === 0) return undefined;
  const proof = await provenAuthors(deps, config, range, diff, deps.log ?? (() => undefined));
  return "authors" in proof ? diff.files : undefined;
}

/** A range of commits on a pull request branch, the ends of which are known commits: what authorship is proved for. */
export interface CommitRange { repo: CodeHostRepo; project: string; base: string; head: string; headRef?: string }

/**
 * Who wrote the commits of a clean "ahead" compare, proved; or why nothing may be said. Never a name or an email on a commit, and never whoever merged the pull request. A range with a merge commit
 * (a branch updated from its base) carries other people's work and is refused, and so does a range with a `Co-authored-by:` trailer (a committed suggestion). Otherwise, in one of two ways:
 *  (1) every commit is verified by the host, its committer is its author (or the host itself, for a web-UI edit), and the author is a live member; or
 *  (2) the commits reached the branch in pushes the host authenticated (the signed delivery's `sender`), the chain of pushes from `base` to `head` is complete, and every sender is a linked
 *      non-bot member. And, either way, EVERY commit's author must be a live member too (a member's push does not vouch for an outsider's or a bot's commit): an unresolved author refuses.
 * A person counts only as a live company member who is not excluded from the source. The result is every author as a canonical developer id (the identity link), each once.
 */
export async function provenAuthors(
  deps: Pick<CodeHostTapDependencies, "actors" | "pushes">, config: NonNullable<Awaited<ReturnType<typeof gate>>>, range: CommitRange, diff: CodeHostDiff, log: TapLog,
): Promise<{ authors: string[] } | { skip: string }> {
  const skip = (reason: string): { skip: string } => { log("human_edit.skipped", { reason }); return { skip: reason }; };
  if (diff.status !== "ahead" || diff.truncated) return skip(diff.truncated ? "compare_truncated" : "not_a_clean_delta");
  if (diff.commits.some((commit) => commit.merge === true)) return skip("merge_commit_in_range");
  // A co-author trailer names a person the host cannot tie to a member (an email in a message): the range may hold their lines, so it is skipped, as a merge is.
  if (diff.commits.some((commit) => commit.coAuthored === true)) return skip("co_authored_commit");
  const memberOf = async (person: CodeHostPerson | undefined): Promise<string | undefined> => {
    if (person === undefined || person.isBot || isExcluded(config, person.id, person.login)) return undefined;
    const who = await deps.actors.resolve({ workspaceId: range.repo.workspaceId, project: range.project, system: sourceOf(range.repo), sourceId: person.id });
    return who.trust === "member" ? who.developerId : undefined;
  };
  const authors = new Set<string>();
  let byCommits = diff.commits.length > 0;
  for (const commit of diff.commits) {
    const sameCommitter = commit.webFlow === true || (commit.committer !== undefined && commit.author !== undefined && commit.committer.id === commit.author.id);
    const developerId = commit.verified && sameCommitter ? await memberOf(commit.author) : undefined;
    if (developerId === undefined) { byCommits = false; break; }
    authors.add(developerId);
  }
  if (!byCommits) {
    authors.clear();
    const chain = deps.pushes === undefined ? undefined : await pushChain(deps.pushes, range);
    if (chain === undefined) return skip("authorship_not_proved");
    for (const push of chain) {
      let developerId: string | undefined;
      if (push.senderIsBot) developerId = undefined;
      else if (push.senderDeveloperId !== undefined) developerId = (await deps.actors.resolveDeveloper({ workspaceId: range.repo.workspaceId, project: range.project, developerId: push.senderDeveloperId })).trust === "member" ? push.senderDeveloperId : undefined;
      else if (push.senderId !== "") developerId = await memberOf({ id: push.senderId, isBot: false });
      if (developerId === undefined) return skip("author_not_member");
      authors.add(developerId);
    }
    // The pusher is not the author: every commit's own author must be a member as well, and is named.
    if (diff.commits.length === 0) return skip("authorship_not_proved");
    for (const commit of diff.commits) {
      const developerId = await memberOf(commit.author);
      if (developerId === undefined) return skip("author_not_member");
      authors.add(developerId);
    }
  }
  if (authors.size === 0) return skip("authorship_not_proved");
  return { authors: [...authors] };
}

/** The pushes from `range.base` to the head, newest first, or undefined when any link is missing. */
async function pushChain(index: PushIndexPort, range: CommitRange): Promise<PushRecord[] | undefined> {
  const chain: PushRecord[] = [];
  let current = range.head;
  for (let step = 0; step < PUSH_CHAIN_MAX; step += 1) {
    if (current === range.base) return chain.length === 0 ? undefined : chain;
    const push = await index.byAfter({ workspaceId: range.repo.workspaceId, host: range.repo.host, repo: range.repo.fullName, after: current }).catch(() => undefined);
    if (push === undefined || (range.headRef !== undefined && push.ref !== `refs/heads/${range.headRef}`)) return undefined;
    chain.push(push);
    current = push.before;
  }
  return undefined;
}

function commentId(event: Extract<CodeHostEvent, { type: "comment" }>): string {
  return `${prId(event.repo, event.prNumber)}:${event.surface}${event.id}`;
}

/**
 * SRL-3 (L1): the commits a pushed commit reverts, only when it has git's own revert shape: a subject that starts `Revert "` and a body line that STARTS with "This reverts commit <sha>".
 * A quoted line, a sentence that mentions the words, or a commit that merely carries such text is not a revert. A revert of a revert (re-landing the change) names the first revert's
 * commit, so it matches nothing and the task stays reverted: there is no un-revert (a known limit, DEFERRED-CHECKS SRL-3).
 */
export function gitRevertedCommits(message: string): string[] {
  const subject = message.split("\n", 1)[0] ?? "";
  if (!/^Revert\s+["“']/i.test(subject.trim())) return [];
  const out = new Set<string>();
  for (const match of message.matchAll(/^This reverts commit ([0-9a-f]{40})\b/gim)) out.add(match[1]!.toLowerCase());
  return [...out].slice(0, 20);
}

/** Full commit ids named by "This reverts commit <sha>". */
export function revertedCommits(message: string): string[] {
  const out = new Set<string>();
  for (const match of message.matchAll(REVERTS_COMMIT)) out.add(match[1]!.toLowerCase());
  return [...out].slice(0, 20);
}

/** Pull request numbers named by GitHub's revert body, "Reverts owner/repo#12" or "Reverts #12". Another repository's number is not ours. */
export function revertedPullRequests(body: string, fullName: string): number[] {
  const out = new Set<number>();
  for (const match of body.matchAll(/\bReverts\s+(?:([\w.-]+\/[\w.-]+))?#(\d{1,9})\b/gi)) {
    if (match[1] !== undefined && match[1].toLowerCase() !== fullName.toLowerCase()) continue;
    out.add(Number(match[2]));
  }
  return [...out].slice(0, 5);
}

/** Hunk headers and the changed lines of a unified patch, at most 200 changed lines, redacted and bounded in width. Context lines are dropped. */
export function humanEditFile(file: CodeHostDiff["files"][number]): HumanEditFile {
  const hunks: string[] = [];
  const symbols = new Set<string>();
  let changed = 0;
  for (const line of (file.patch ?? "").split("\n")) {
    if (line.startsWith("@@")) {
      const symbol = /^@@[^@]*@@\s*(.*)$/.exec(line)?.[1]?.trim();
      if (symbol !== undefined && symbol !== "") symbols.add(cleanText(symbol, 120) ?? "");
      hunks.push(cleanText(line, HUMAN_EDIT_LINE_MAX_CHARS) ?? "@@");
    } else if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
      if (changed >= HUMAN_EDIT_MAX_LINES_PER_FILE) continue;
      changed += 1;
      hunks.push(line[0]! + (cleanText(line.slice(1), HUMAN_EDIT_LINE_MAX_CHARS) ?? ""));
    }
  }
  symbols.delete("");
  return { path: cleanText(file.path, 400) ?? "", additions: Math.max(0, file.additions), deletions: Math.max(0, file.deletions), symbols: [...symbols].slice(0, 20), hunks };
}

