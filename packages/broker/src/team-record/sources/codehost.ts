// R5: the code-host tap. It reads host-neutral events (`CodeHostEvent`); `github.ts` turns GitHub webhook bodies into them and an Enterprise
// code-host plug-in (W6) turns its own events into them, so the record never sees a host's own types (design 4.4.1).
//
// What it writes: pull requests, reviews, comments, CI conclusions, reverts. What it deliberately does NOT write (owner decision Q5, 2026-10-30):
// the changed lines of a human edit to a Rovara pull request. At merge those are read live from the host, handed once, in memory, to the
// learning extractor, and dropped. Only the lesson the extractor makes, and a link to the pull request, are ever kept (by the learning lane).
import { cleanText, gate, isExcluded, linksOf, scalars, withRetention, MAX_DRAFTS_PER_DELIVERY, type GateDependencies } from "./common.js";
import type {
  ActorResolverPort, Audience, RecordDraft, RecordSinkPort, RovaraPullRequest, RovaraPullRequestIndexPort,
  SourceSystem, TapLog, TrackRecordPort,
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
      author: CodeHostPerson; headSha: string; mergeCommitSha?: string; baseRef: string; at: string; version: string }
  | { type: "review"; repo: CodeHostRepo; prNumber: number; id: string; url: string; action: "submitted" | "edited" | "dismissed"; state: string; body?: string; author: CodeHostPerson; at: string; version: string }
  | { type: "comment"; repo: CodeHostRepo; prNumber: number; id: string; url: string; action: "created" | "edited" | "deleted"; surface: "review_comment" | "discussion";
      body?: string; author: CodeHostPerson; path?: string; at: string; version: string }
  | { type: "ci"; repo: CodeHostRepo; id: string; name: string; conclusion: string; headSha: string; prNumbers: readonly number[]; url?: string; at: string }
  | { type: "push"; repo: CodeHostRepo; ref: string; commits: ReadonlyArray<{ sha: string; message: string }>; at: string }
  | { type: "repository"; repo: CodeHostRepo; action: "deleted" | "transferred"; at: string };

/** The compare of two commits, read live from the host. */
export interface CodeHostDiff {
  /** `ahead`: base is an ancestor of head. Anything else is not a clean human delta. */
  status: "identical" | "ahead" | "diverged" | "behind";
  commits: ReadonlyArray<{ sha: string; author?: CodeHostPerson }>;
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
  /** True when the host could not give a clean delta (a force push or a rebase happened): the diff may include changes that were not the human's. */
  approximate: boolean;
  files: HumanEditFile[];
  /** The only thing of this input that may be kept. */
  link: string;
}

/** The learning extractor (L1). It reads `files` once and keeps at most lessons and `link`. Never stores `files`. */
export interface HumanEditExtractorPort {
  extract(input: HumanEditInput): Promise<{ candidates: number }>;
}

export interface CodeHostTapDependencies extends GateDependencies {
  sink: RecordSinkPort;
  actors: ActorResolverPort;
  rovaraPrs: RovaraPullRequestIndexPort;
  trackRecord?: TrackRecordPort;
  diffs?: CodeHostDiffReader;
  extractor?: HumanEditExtractorPort;
  log?: TapLog;
}

export interface TapResult {
  written: number;
  duplicates: number;
  refused: number;
  failed: number;
}

export const HUMAN_EDIT_MAX_FILES = 40;
export const HUMAN_EDIT_MAX_LINES_PER_FILE = 200;
const HUMAN_EDIT_LINE_MAX_CHARS = 400;
const SHA = /^[0-9a-f]{40}$/;
const REVERTS_COMMIT = /This reverts commit ([0-9a-f]{40})\b/gi;

export function sourceOf(repo: CodeHostRepo): SourceSystem {
  return repo.host === "github" ? "github" : `codehost:${repo.host}`;
}

export function repoScope(repo: CodeHostRepo): string {
  return `${sourceOf(repo)}:repo/${repo.id}`;
}

function audienceOf(repo: CodeHostRepo, at: string): Audience {
  if (!repo.isPrivate) return { kind: "project" };
  return { kind: "restricted", acl: { source: sourceOf(repo), scope: repoScope(repo), capturedAt: at, liveCheck: "on_read" } };
}

const prId = (repo: CodeHostRepo, number: number): string => `${repo.fullName}#pr${number}`;

export function createCodeHostTap(deps: CodeHostTapDependencies): { handle(event: CodeHostEvent): Promise<TapResult> } {
  const log: TapLog = deps.log ?? (() => undefined);

  async function handle(event: CodeHostEvent): Promise<TapResult> {
    const result: TapResult = { written: 0, duplicates: 0, refused: 0, failed: 0 };
    const config = await gate(deps, { workspaceId: event.repo.workspaceId, ...(event.repo.project === undefined ? {} : { project: event.repo.project }), source: sourceOf(event.repo), scope: repoScope(event.repo) });
    if (config === undefined) return result;
    try {
      if (event.type === "repository") {
        await deps.sink.tombstone({ workspaceId: event.repo.workspaceId, system: event.repo.host, scope: repoScope(event.repo), cause: "source_deleted" });
        return result;
      }
      if (event.type === "comment" && event.action === "deleted") {
        await deps.sink.tombstone({ workspaceId: event.repo.workspaceId, system: event.repo.host, sourceIds: [commentId(event)], cause: "source_deleted" });
        return result;
      }
      const drafts: RecordDraft[] = [];
      const project = event.repo.project ?? config.project;
      const base = { workspaceId: event.repo.workspaceId, ...(project === undefined ? {} : { project }), repo: event.repo.fullName, source: sourceOf(event.repo), links: [] as string[] };
      const actor = async (person: CodeHostPerson): Promise<NonNullable<RecordDraft["actor"]>> => {
        const resolved = await deps.actors.resolve({ workspaceId: event.repo.workspaceId, project, system: event.repo.host, sourceId: person.id, isBot: person.isBot });
        return { sourceId: person.id, ...(resolved.developerId === undefined ? {} : { developerId: resolved.developerId }), trust: person.isBot ? "system" : resolved.trust };
      };
      switch (event.type) {
        case "pr": {
          if (isExcluded(config, event.author.id, event.author.login)) return result;
          const who = await actor(event.author);
          const text = cleanText([event.title, event.body].filter((part) => part !== undefined && part !== "").join("\n\n"));
          drafts.push({
            ...base, kind: "github.pr", occurredAt: event.at,
            sourceRef: { system: event.repo.host, id: prId(event.repo, event.number), url: event.url, version: event.version },
            actor: who, trust: who.trust, audience: audienceOf(event.repo, event.at), ...(text === undefined ? {} : { text }),
            structured: scalars({ number: event.number, action: event.action, merged: event.merged, base: event.baseRef, headSha: event.headSha, mergeCommitSha: event.mergeCommitSha }),
            links: linksOf(event.url), retention: config.retention,
          });
          break;
        }
        case "review": {
          if (isExcluded(config, event.author.id, event.author.login)) return result;
          const who = await actor(event.author);
          const text = cleanText(event.body);
          drafts.push({
            ...base, kind: "github.review", occurredAt: event.at,
            sourceRef: { system: event.repo.host, id: `${prId(event.repo, event.prNumber)}:review${event.id}`, url: event.url, parentId: prId(event.repo, event.prNumber), version: event.version },
            actor: who, trust: who.trust, audience: audienceOf(event.repo, event.at), ...(text === undefined ? {} : { text }),
            structured: scalars({ prNumber: event.prNumber, state: event.state, action: event.action }),
            links: linksOf(event.url), retention: config.retention,
          });
          break;
        }
        case "comment": {
          if (isExcluded(config, event.author.id, event.author.login)) return result;
          const who = await actor(event.author);
          const text = cleanText(event.body);
          drafts.push({
            ...base, kind: "github.review_comment", occurredAt: event.at,
            sourceRef: { system: event.repo.host, id: commentId(event), url: event.url, parentId: prId(event.repo, event.prNumber), version: event.version },
            actor: who, trust: who.trust, audience: audienceOf(event.repo, event.at), ...(text === undefined ? {} : { text }),
            structured: scalars({ prNumber: event.prNumber, surface: event.surface, path: event.path }),
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
        case "push":
          break;
      }
      for (const draft of drafts.slice(0, MAX_DRAFTS_PER_DELIVERY)) await write(draft, result);
      await revertsOf(event, config.retention, result);
      if (event.type === "pr" && event.action === "closed" && event.merged) await humanEdit(event);
    } catch {
      result.failed += 1;
      log("record.codehost_failed", { host: event.repo.host });
    }
    return result;
  }

  async function write(draft: RecordDraft, result: TapResult): Promise<void> {
    try {
      const outcome = await deps.sink.put(withRetention(draft, draft.retention));
      if (outcome.status === "stored") result.written += 1;
      else if (outcome.status === "duplicate") result.duplicates += 1;
      else result.refused += 1;
    } catch {
      result.failed += 1;
      log("record.write_failed", { kind: draft.kind });
    }
  }

  /** A merged revert pull request, or a default-branch push whose commits say "This reverts commit <sha>". Only a Rovara pull request's merge commit counts. */
  async function revertsOf(event: CodeHostEvent, retention: RecordDraft["retention"], result: TapResult): Promise<void> {
    let targets: Array<{ target: RovaraPullRequest; via: string; at: string }> = [];
    const repo = event.repo;
    if (event.type === "push") {
      if (repo.defaultBranch === undefined || event.ref !== `refs/heads/${repo.defaultBranch}`) return;
      for (const commit of event.commits.slice(0, 100)) {
        for (const sha of revertedCommits(commit.message)) {
          const target = await deps.rovaraPrs.byMergeCommit({ workspaceId: repo.workspaceId, host: repo.host, repo: repo.fullName, sha });
          if (target !== undefined) targets.push({ target, via: commit.sha, at: event.at });
        }
      }
    } else if (event.type === "pr" && event.action === "closed" && event.merged && /^revert\s+["“']/i.test(event.title.trim())) {
      for (const number of revertedPullRequests(event.body ?? "", repo.fullName)) {
        const target = await deps.rovaraPrs.byNumber({ workspaceId: repo.workspaceId, host: repo.host, repo: repo.fullName, number });
        if (target !== undefined) targets.push({ target, via: event.mergeCommitSha ?? prId(repo, event.number), at: event.at });
      }
      for (const sha of revertedCommits(event.body ?? "")) {
        const target = await deps.rovaraPrs.byMergeCommit({ workspaceId: repo.workspaceId, host: repo.host, repo: repo.fullName, sha });
        if (target !== undefined) targets.push({ target, via: event.mergeCommitSha ?? prId(repo, event.number), at: event.at });
      }
    }
    // One revert per Rovara pull request, however many deliveries or ways tell us of it.
    const seen = new Set<string>();
    targets = targets.filter(({ target }) => !seen.has(target.taskId) && seen.add(target.taskId));
    for (const { target, via, at } of targets.slice(0, 20)) {
      const common = {
        workspaceId: repo.workspaceId, project: target.project, repo: repo.fullName, source: sourceOf(repo), occurredAt: at, retention: retention,
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
      if (deps.trackRecord !== undefined) {
        try {
          await deps.trackRecord.markNotHeld({ workspaceId: repo.workspaceId, project: target.project, taskId: target.taskId, reason: "reverted", revertRef: via });
        } catch {
          result.failed += 1;
          log("record.track_record_rescore_failed", { host: repo.host });
        }
      }
    }
  }

  /**
   * At merge of a Rovara pull request: reads, live from the host, what people changed after Rovara's last push, and hands it to the extractor.
   * Nothing is written to the record. Skipped, with a fixed reason in the log, when there is nothing to read, a reader is missing, or any of the
   * human commits is not a member's (outsiders' text is never used for learning).
   */
  async function humanEdit(event: Extract<CodeHostEvent, { type: "pr" }>): Promise<void> {
    if (deps.diffs === undefined || deps.extractor === undefined) return;
    const rovara = await deps.rovaraPrs.byNumber({ workspaceId: event.repo.workspaceId, host: event.repo.host, repo: event.repo.fullName, number: event.number });
    if (rovara === undefined || !SHA.test(rovara.candidateHeadSha) || !SHA.test(event.headSha)) return;
    // Nothing was pushed after Rovara's last push: no human edit, and no call to the host.
    if (rovara.candidateHeadSha === event.headSha) return;
    const diff = await deps.diffs.compare({ repo: event.repo, base: rovara.candidateHeadSha, head: event.headSha });
    if (diff === undefined || diff.status === "identical" || diff.files.length === 0) return;
    const authors = new Map<string, CodeHostPerson | undefined>();
    for (const commit of diff.commits) authors.set(commit.author?.id ?? commit.sha, commit.author);
    let allMembers = authors.size > 0;
    for (const person of authors.values()) {
      if (person === undefined || person.isBot) { allMembers = false; break; }
      const who = await deps.actors.resolve({ workspaceId: event.repo.workspaceId, project: rovara.project, system: event.repo.host, sourceId: person.id });
      if (who.trust !== "member") { allMembers = false; break; }
    }
    if (!allMembers) {
      log("human_edit.skipped", { reason: "author_not_member" });
      return;
    }
    const files = diff.files.slice(0, HUMAN_EDIT_MAX_FILES).map(humanEditFile);
    const outcome = await deps.extractor.extract({
      workspaceId: event.repo.workspaceId, project: rovara.project, repo: event.repo.fullName, taskId: rovara.taskId,
      pullRequest: { number: event.number, url: rovara.url }, trust: "member", authorCount: authors.size,
      approximate: diff.status !== "ahead" || diff.truncated, files, link: rovara.url,
    });
    log("human_edit.handed_on", { files: files.length, candidates: outcome.candidates, approximate: diff.status !== "ahead" || diff.truncated });
  }

  return { handle };
}

function commentId(event: Extract<CodeHostEvent, { type: "comment" }>): string {
  return `${prId(event.repo, event.prNumber)}:${event.surface}${event.id}`;
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

