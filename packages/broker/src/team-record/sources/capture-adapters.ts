// Lessons capture lane: ONE interface for what learning needs from a code host, so a host added later (a GitFarm-style Enterprise plug-in) adds itself and nothing else changes.
//
// What learning reads from a host (all of it live, nothing kept but lessons and a link):
//   1. pull request comments: which comments a pull request has now, and whether an inline comment still points at a line (it does not once a later commit changed those lines). The words and the
//      people come from the Team record (the code-host tap writes them); the host only lists ids. Every host that implements the `CodeHost` port's `feedback` gets this by `captureAdapterOf`.
//   2. human fix-up commits: a compare of two commits with who wrote each (`CodeHostDiffReader`). The `CodeHost` port has no such read, so a host that can supply it says so (`diffs`). Without
//      it that host's human edits are not learned from, and the report says so.
//   3. the merge commit of a merged pull request: from the tap's own event (`mergeCommitSha`), kept by the merge index. A plug-in that has the commit says it in its events.
// A host registers an adapter with the `host` name its rows carry (`github`, or the plug-in's name) and says what it supports; the registry answers by host and by pull request address.
import type { ChangeRequestRef, CodeHost, HostScope } from "@agentx/contracts";
import type { CodeHostDiffReader } from "./codehost.js";

/** A pull request as the record names it: the host, the repository's full name as the tap lower-cased it, and the number. */
export interface PullRequestAddress { host: string; repository: string; number: number }
export type PullRequestSurface = "review_comment" | "discussion" | "review";
/** What the host lists of a pull request's comments now: the ids, and for an inline comment whether it still points at a line. Never the words or the people. */
export interface PullRequestFeedbackView {
  comments: ReadonlyArray<{ kind: PullRequestSurface; id: string; line?: number | undefined }>;
}

export interface CodeHostCaptureSupport {
  /** Lists a pull request's comments (so reviewers' comments become evidence). */
  pullRequestComments: boolean;
  /** Says whether an inline comment's lines changed since (so a comment that led to a change is marked). */
  commentOutdated: boolean;
  /** Reads a compare of two commits with the author of each (so a person's fix-up commits become evidence). */
  humanEdits: boolean;
  /** How a human edit's authorship is proved on this host. `none`: not learned from. */
  authorship: "verified_commits_and_push_chain" | "verified_commits" | "none";
  /** The merge commit of a merged pull request is noted from the host's own event. */
  mergeCommit: boolean;
}

export interface CodeHostCaptureAdapter {
  /** The `host` name this host's rows and events carry. */
  readonly host: string;
  readonly supports: CodeHostCaptureSupport;
  /** The record's name of a pull request URL on this host; undefined for a URL that is not this host's. */
  pullRequestAddress(url: string): PullRequestAddress | undefined;
  /** The comments the host lists now. THROWS when the host cannot be read. Absent when `supports.pullRequestComments` is false. */
  pullRequestFeedback?(input: { workspaceId: string; project: string; taskId: string; address: PullRequestAddress; url: string }): Promise<PullRequestFeedbackView | undefined>;
  /** Reads a compare live. Absent when `supports.humanEdits` is false. */
  readonly diffs?: CodeHostDiffReader;
}

export interface CaptureAdapters {
  register(adapter: CodeHostCaptureAdapter): void;
  forHost(host: string): CodeHostCaptureAdapter | undefined;
  /** The adapter whose host recognises this pull request URL. */
  addressOf(url: string): { adapter: CodeHostCaptureAdapter; address: PullRequestAddress } | undefined;
  /** What each registered host supports, by host name (for the report and the settings page). */
  support(): Record<string, CodeHostCaptureSupport>;
  /** A diff reader that picks the adapter by the repository's host. A host with no reader gives "no diff" (the human edit is skipped). */
  diffs: CodeHostDiffReader;
}

export function createCaptureAdapters(): CaptureAdapters {
  const adapters = new Map<string, CodeHostCaptureAdapter>();
  return {
    register(adapter) {
      if (adapters.has(adapter.host)) throw new Error("a capture adapter for this host is already registered");
      adapters.set(adapter.host, adapter);
    },
    forHost: (host) => adapters.get(host),
    addressOf(url) {
      for (const adapter of adapters.values()) {
        const address = adapter.pullRequestAddress(url);
        if (address !== undefined) return { adapter, address };
      }
      return undefined;
    },
    support: () => Object.fromEntries([...adapters.entries()].map(([host, adapter]) => [host, adapter.supports])),
    diffs: { compare: async (input) => adapters.get(input.repo.host)?.diffs?.compare(input) },
  };
}

const GITHUB_PULL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9][0-9]{0,9})$/u;
/** GitHub's pull request URL, in the record's naming (the repository lower-cased, as the tap does). */
export function githubPullRequestAddress(url: string): PullRequestAddress | undefined {
  const match = GITHUB_PULL.exec(url);
  return match === null ? undefined : { host: "github", repository: `${match[1]}/${match[2]}`.toLowerCase(), number: Number(match[3]) };
}

/** The numeric part of a neutral comment id: `review_comment:123` and `123` both name 123. Anything else is not an id. */
function commentIdOf(kind: PullRequestSurface, id: string): string | undefined {
  const match = /^(?:(review_comment|review|discussion):)?([1-9][0-9]{0,18})$/u.exec(id);
  return match !== null && (match[1] === undefined || match[1] === kind) ? match[2] : undefined;
}

/**
 * The adapter for any host registered through the `CodeHost` port: the comments come from the port's `feedback` read (so a new host gets pull request comments with nothing else written), and the
 * pull request address from the host's own naming (`addressOf`). `diffs` is the extra a host adds when it can compare two commits with their authors.
 */
export function captureAdapterOf(input: {
  host: string; codeHost: Pick<CodeHost, "feedback">;
  /** The record's name of a pull request URL on this host. */
  pullRequestAddress(url: string): PullRequestAddress | undefined;
  /** The port's change request ref for an address. */
  refOf(address: PullRequestAddress, url: string): ChangeRequestRef;
  /** The scope the port's call is made under (the company's own). */
  scopeOf(workspaceId: string): HostScope | Promise<HostScope>;
  diffs?: CodeHostDiffReader;
  /** How this host's commits are vouched for. Default: `verified_commits_and_push_chain` when `diffs` is given (GitHub's webhook has the pushes), else `none`. */
  authorship?: CodeHostCaptureSupport["authorship"];
  mergeCommit?: boolean;
}): CodeHostCaptureAdapter {
  return {
    host: input.host,
    supports: {
      pullRequestComments: true, commentOutdated: true, humanEdits: input.diffs !== undefined,
      authorship: input.diffs === undefined ? "none" : input.authorship ?? "verified_commits_and_push_chain", mergeCommit: input.mergeCommit ?? true,
    },
    pullRequestAddress: input.pullRequestAddress,
    ...(input.diffs === undefined ? {} : { diffs: input.diffs }),
    async pullRequestFeedback({ workspaceId, address, url }) {
      const feedback = await input.codeHost.feedback(input.refOf(address, url), await input.scopeOf(workspaceId));
      const comments: PullRequestFeedbackView["comments"][number][] = [];
      for (const comment of feedback.comments) {
        const id = commentIdOf(comment.kind, comment.id);
        if (id !== undefined) comments.push({ kind: comment.kind, id, ...(comment.line === undefined ? {} : { line: comment.line }) });
      }
      return { comments };
    },
  };
}
