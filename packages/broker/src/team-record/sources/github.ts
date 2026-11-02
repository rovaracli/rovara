// R5: GitHub as the first code host. Turns a verified webhook delivery into host-neutral `CodeHostEvent`s (codehost.ts), and reads a
// compare through any `getJson` that carries an installation token. A body is a hint only: the workspace and project of a repository come from
// the installation (`resolveRepo`), never from the delivery.
import { z } from "zod";
import { isoOrUndefined } from "./common.js";
import { createCodeHostTap, type CodeHostDiff, type CodeHostDiffReader, type CodeHostEvent, type CodeHostPerson, type CodeHostRepo, type CodeHostTapDependencies, type TapResult } from "./codehost.js";

const Person = z.object({ id: z.number().int().positive(), login: z.string().max(200).optional(), type: z.string().max(40).optional() }).passthrough();
const Repository = z.object({ id: z.number().int().positive(), full_name: z.string().min(3).max(300), private: z.boolean(), default_branch: z.string().max(250).optional() }).passthrough();
const Envelope = z.object({ action: z.string().max(64).optional(), installation: z.object({ id: z.number().int().positive() }).passthrough(), repository: Repository }).passthrough();
const PullRequest = z.object({
  number: z.number().int().positive(), html_url: z.string().max(2048), title: z.string().max(1000).default(""), body: z.string().max(70_000).nullish(),
  user: Person, head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), ref: z.string().max(250).optional() }).passthrough(), base: z.object({ ref: z.string().max(250) }).passthrough(),
  merged: z.boolean().optional(), merge_commit_sha: z.string().regex(/^[0-9a-f]{40}$/).nullish(), updated_at: z.string().max(64),
}).passthrough();
const Review = z.object({ id: z.number().int().positive(), html_url: z.string().max(2048), state: z.string().max(40), body: z.string().max(70_000).nullish(), user: Person, submitted_at: z.string().max(64).nullish() }).passthrough();
const Comment = z.object({ id: z.number().int().positive(), html_url: z.string().max(2048), body: z.string().max(70_000).nullish(), user: Person, path: z.string().max(1000).optional(), updated_at: z.string().max(64) }).passthrough();
const CheckSuite = z.object({ id: z.number().int().positive(), conclusion: z.string().max(40).nullish(), head_sha: z.string().regex(/^[0-9a-f]{40}$/), pull_requests: z.array(z.object({ number: z.number().int().positive() }).passthrough()).max(50).default([]), updated_at: z.string().max(64).optional(), app: z.object({ name: z.string().max(100).optional() }).passthrough().nullish() }).passthrough();
const WorkflowRun = z.object({ id: z.number().int().positive(), name: z.string().max(200).nullish(), conclusion: z.string().max(40).nullish(), head_sha: z.string().regex(/^[0-9a-f]{40}$/), html_url: z.string().max(2048).optional(), pull_requests: z.array(z.object({ number: z.number().int().positive() }).passthrough()).max(50).default([]), updated_at: z.string().max(64).optional() }).passthrough();
const Push = z.object({ ref: z.string().max(300), before: z.string().regex(/^[0-9a-f]{40}$/).optional(), after: z.string().regex(/^[0-9a-f]{40}$/).optional(), sender: Person.optional(), commits: z.array(z.object({ id: z.string().regex(/^[0-9a-f]{40}$/), message: z.string().max(20_000) }).passthrough()).max(100).default([]), head_commit: z.object({ timestamp: z.string().max(64).optional() }).passthrough().nullish() }).passthrough();

/** GitHub's own committer account for edits made in the web UI. */
const GITHUB_WEB_FLOW_ID = 19864447;

const personOf = (person: z.infer<typeof Person>): CodeHostPerson => ({
  id: String(person.id), ...(person.login === undefined ? {} : { login: person.login }), isBot: person.type === "Bot" || /\[bot\]$/i.test(person.login ?? ""),
});

/** Who made this change: the delivery's sender (GitHub names the account that acted). A first sight is its author's own; an edit, a close, a reopen and a dismissal are the sender's. */
const editorOf = (action: string | undefined, sender: unknown): { editor?: CodeHostPerson } => {
  if (action === "opened" || action === "created" || action === "submitted") return {};
  const parsed = Person.safeParse(sender);
  return parsed.success ? { editor: personOf(parsed.data) } : {};
};

/** What an `edited` delivery says it changed, and the text before (`changes.<field>.from`). */
const ChangesOf = z.object({ changes: z.object({ title: z.object({ from: z.string().max(1000) }).passthrough().optional(), body: z.object({ from: z.string().max(70_000).nullish() }).passthrough().optional() }).passthrough().optional() }).passthrough();
const changesOf = (action: string | undefined, payload: unknown): { changed?: { title?: boolean; body?: boolean }; previousBody?: string } => {
  if (action !== "edited") return {};
  const parsed = ChangesOf.safeParse(payload);
  const changes = parsed.success ? parsed.data.changes : undefined;
  if (changes === undefined) return {};
  return { changed: { title: changes.title !== undefined, body: changes.body !== undefined }, ...(changes.body === undefined ? {} : { previousBody: changes.body.from ?? "" }) };
};

export interface GithubRecordTapDependencies extends Omit<CodeHostTapDependencies, "diffs"> {
  /**
   * The workspace and project an installation's repository belongs to (the Rovara project's repository registry). It MUST check that the repository is one
   * the installation holds and a project registered, never trusting the body's names: a delivery for any other repository must answer `undefined`, and then
   * nothing is recorded.
   */
  resolveRepo(input: { installationId: number; repositoryId: number; fullName: string }): Promise<{ workspaceId: string; project?: string } | undefined>;
  /** Reads a compare with the installation's token (github-app.ts `trackingJson`). Without it, human edits are not read. */
  getJson?: GithubGetJson;
  now?: () => number;
}

export type GithubGetJson = (path: string) => Promise<{ status: number; body: unknown }>;

/** A verified delivery in, nothing out: it never throws, so a failed record can never fail the webhook that carried it. */
export function createGithubRecordTap(deps: GithubRecordTapDependencies): (verified: { eventName: string | undefined; deliveryId: string; payload: unknown }) => Promise<TapResult | undefined> {
  const tap = createCodeHostTap({ ...deps, ...(deps.getJson === undefined ? {} : { diffs: createGithubDiffReader(deps.getJson) }) });
  const now = deps.now ?? Date.now;
  return async ({ eventName, payload }) => {
    try {
      if (eventName === undefined) return undefined;
      const envelope = Envelope.safeParse(payload);
      if (!envelope.success) return undefined;
      const fullName = envelope.data.repository.full_name.toLowerCase();
      const scope = await deps.resolveRepo({ installationId: envelope.data.installation.id, repositoryId: envelope.data.repository.id, fullName });
      if (scope === undefined) return undefined;
      const repo: CodeHostRepo = {
        host: "github", id: String(envelope.data.repository.id), fullName, isPrivate: envelope.data.repository.private,
        ...(envelope.data.repository.default_branch === undefined ? {} : { defaultBranch: envelope.data.repository.default_branch }),
        workspaceId: scope.workspaceId, ...(scope.project === undefined ? {} : { project: scope.project }),
      };
      const events = githubEventsOf(eventName, envelope.data.action, payload, repo, new Date(now()).toISOString());
      let total: TapResult | undefined;
      for (const event of events) {
        const result = await tap.handle(event);
        total = total === undefined ? result : { written: total.written + result.written, duplicates: total.duplicates + result.duplicates, refused: total.refused + result.refused, failed: total.failed + result.failed };
      }
      return total;
    } catch {
      return undefined;
    }
  };
}

/** The host-neutral events of one GitHub delivery. Unknown shapes and actions give none. */
export function githubEventsOf(eventName: string, action: string | undefined, payload: unknown, repo: CodeHostRepo, fallbackAt: string): CodeHostEvent[] {
  const object = payload as Record<string, unknown>;
  switch (eventName) {
    case "pull_request": {
      if (action !== "opened" && action !== "closed" && action !== "reopened" && action !== "edited") return [];
      const pr = PullRequest.safeParse(object.pull_request);
      if (!pr.success) return [];
      const at = isoOrUndefined(pr.data.updated_at) ?? fallbackAt;
      return [{
        type: "pr", repo, number: pr.data.number, url: pr.data.html_url, action, merged: pr.data.merged === true, title: pr.data.title, ...(pr.data.body ? { body: pr.data.body } : {}),
        author: personOf(pr.data.user), ...editorOf(action, object.sender), ...changesOf(action, payload), headSha: pr.data.head.sha, ...(pr.data.head.ref === undefined ? {} : { headRef: pr.data.head.ref }), ...(pr.data.merge_commit_sha ? { mergeCommitSha: pr.data.merge_commit_sha } : {}), baseRef: pr.data.base.ref, at, version: `${action}:${pr.data.updated_at}`,
      }];
    }
    case "pull_request_review": {
      if (action !== "submitted" && action !== "edited" && action !== "dismissed") return [];
      const pr = z.object({ number: z.number().int().positive() }).safeParse(object.pull_request);
      const review = Review.safeParse(object.review);
      if (!pr.success || !review.success) return [];
      const stamp = review.data.submitted_at ?? undefined;
      return [{
        type: "review", repo, prNumber: pr.data.number, id: String(review.data.id), url: review.data.html_url, action, state: review.data.state.toLowerCase(),
        ...(review.data.body ? { body: review.data.body } : {}), author: personOf(review.data.user), ...editorOf(action, object.sender), ...(changesOf(action, payload).previousBody === undefined ? {} : { previousBody: changesOf(action, payload).previousBody! }), at: action === "submitted" ? isoOrUndefined(stamp) ?? fallbackAt : fallbackAt, version: action === "submitted" ? `${action}:${stamp ?? "none"}` : `${action}:${fallbackAt}`,
      }];
    }
    case "pull_request_review_comment":
    case "issue_comment": {
      if (action !== "created" && action !== "edited" && action !== "deleted") return [];
      const comment = Comment.safeParse(object.comment);
      if (!comment.success) return [];
      let prNumber: number | undefined;
      if (eventName === "issue_comment") {
        const issue = z.object({ number: z.number().int().positive(), pull_request: z.unknown() }).passthrough().safeParse(object.issue);
        // A comment on a plain issue is not a pull request's.
        if (!issue.success || issue.data.pull_request === undefined || issue.data.pull_request === null) return [];
        prNumber = issue.data.number;
      } else {
        const pr = z.object({ number: z.number().int().positive() }).safeParse(object.pull_request);
        if (!pr.success) return [];
        prNumber = pr.data.number;
      }
      return [{
        type: "comment", repo, prNumber, id: String(comment.data.id), url: comment.data.html_url, action, surface: eventName === "issue_comment" ? "discussion" : "review_comment",
        ...(comment.data.body ? { body: comment.data.body } : {}), author: personOf(comment.data.user), ...editorOf(action, object.sender), ...(changesOf(action, payload).previousBody === undefined ? {} : { previousBody: changesOf(action, payload).previousBody! }), ...(comment.data.path === undefined ? {} : { path: comment.data.path }),
        at: isoOrUndefined(comment.data.updated_at) ?? fallbackAt, version: `${action}:${comment.data.updated_at}`,
      }];
    }
    case "check_suite": {
      const suite = CheckSuite.safeParse(object.check_suite);
      if (action !== "completed" || !suite.success || !suite.data.conclusion) return [];
      return [{
        type: "ci", repo, id: `suite${suite.data.id}`, name: suite.data.app?.name ?? "check_suite", conclusion: suite.data.conclusion, headSha: suite.data.head_sha,
        prNumbers: suite.data.pull_requests.map((pr) => pr.number), at: isoOrUndefined(suite.data.updated_at) ?? fallbackAt,
      }];
    }
    case "workflow_run": {
      const run = WorkflowRun.safeParse(object.workflow_run);
      if (action !== "completed" || !run.success || !run.data.conclusion) return [];
      return [{
        type: "ci", repo, id: `run${run.data.id}`, name: run.data.name ?? "workflow_run", conclusion: run.data.conclusion, headSha: run.data.head_sha,
        prNumbers: run.data.pull_requests.map((pr) => pr.number), ...(run.data.html_url === undefined ? {} : { url: run.data.html_url }), at: isoOrUndefined(run.data.updated_at) ?? fallbackAt,
      }];
    }
    case "push": {
      const push = Push.safeParse(payload);
      if (!push.success) return [];
      return [{ type: "push", repo, ref: push.data.ref, ...(push.data.before === undefined ? {} : { before: push.data.before }), ...(push.data.after === undefined ? {} : { after: push.data.after }), ...(push.data.sender === undefined ? {} : { sender: personOf(push.data.sender) }), commits: push.data.commits.map((commit) => ({ sha: commit.id, message: commit.message })), at: isoOrUndefined(push.data.head_commit?.timestamp) ?? fallbackAt }];
    }
    case "repository":
      return action === "deleted" || action === "transferred" ? [{ type: "repository", repo, action, at: fallbackAt }] : [];
    default:
      return [];
  }
}

const Compare = z.object({
  status: z.enum(["identical", "ahead", "behind", "diverged"]),
  total_commits: z.number().int().nonnegative().optional(),
  commits: z.array(z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), author: Person.nullish(), committer: Person.nullish(), commit: z.object({ verification: z.object({ verified: z.boolean().optional() }).passthrough().nullish() }).passthrough().optional() }).passthrough()).max(300).default([]),
  files: z.array(z.object({ filename: z.string().max(1000), additions: z.number().int().nonnegative().default(0), deletions: z.number().int().nonnegative().default(0), patch: z.string().max(200_000).optional() }).passthrough()).max(300).default([]),
}).passthrough();

/** Reads `base...head` through `getJson`. Any other answer than a clean 200 is "no diff": the caller then hands nothing on. */
export function createGithubDiffReader(getJson: GithubGetJson): CodeHostDiffReader {
  return {
    async compare({ repo, base, head }) {
      if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head) || !/^[\w.-]+\/[\w.-]+$/.test(repo.fullName)) return undefined;
      const [owner, name] = repo.fullName.split("/") as [string, string];
      const answered = await getJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${base}...${head}?per_page=100`);
      if (answered.status !== 200) return undefined;
      const parsed = Compare.safeParse(answered.body);
      if (!parsed.success) return undefined;
      const diff: CodeHostDiff = {
        status: parsed.data.status,
        commits: parsed.data.commits.map((commit) => ({ sha: commit.sha, verified: commit.commit?.verification?.verified === true, ...(commit.author ? { author: personOf(commit.author) } : {}), ...(commit.committer ? { committer: personOf(commit.committer) } : {}), ...(commit.committer?.login === "web-flow" && commit.committer.id === GITHUB_WEB_FLOW_ID ? { webFlow: true } : {}) })),
        files: parsed.data.files.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, ...(file.patch === undefined ? {} : { patch: file.patch }) })),
        truncated: parsed.data.files.length >= 300 || (parsed.data.total_commits ?? 0) > parsed.data.commits.length,
      };
      return diff;
    },
  };
}
