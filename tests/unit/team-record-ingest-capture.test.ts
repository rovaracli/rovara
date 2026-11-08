// Lessons capture lane: what the code-host tap adds for learning. A review comment keeps WHERE it was made (file, line, commit) so a later reader can tell whether it was followed; a merged Rovara
// pull request's merge commit is noted (the revert-by-commit match and the lesson's merged commit); a human edit hands on WHO wrote it (canonical developer ids), never a login or a diff kept.
import { describe, expect, it } from "vitest";
import { createCodeHostTap, runHumanEdit, repoScope, type CodeHostDiff, type CodeHostEvent, type CodeHostRepo, type HumanEditInput } from "../../packages/broker/src/team-record/sources/codehost.js";
import { createGithubDiffReader, githubEventsOf } from "../../packages/broker/src/team-record/sources/github.js";
import { sha, world, WS } from "../support/team-record-ingest-fakes.js";

const repo = (over: Partial<CodeHostRepo> = {}): CodeHostRepo => ({ host: "github", id: "77", fullName: "acme/shop", isPrivate: true, defaultBranch: "main", workspaceId: WS, project: "shop", ...over });
const AT = "2026-10-30T10:00:00.000Z";
const alice = { id: "1001", login: "alice", isBot: false };
const bob = { id: "1002", login: "bob", isBot: false };

function setup(extra: Partial<Parameters<typeof createCodeHostTap>[0]> = {}) {
  const w = world();
  w.config.set("github", repoScope(repo()), { retention: "D" });
  w.actors.members.set("1001", "dev-alice");
  w.actors.members.set("1002", "dev-bob");
  const tap = createCodeHostTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config, ...extra });
  return { w, tap };
}

describe("an inline review comment keeps where it was made", () => {
  it("the webhook's commit and line reach the event, and the row keeps them with the action", async () => {
    const events = githubEventsOf("pull_request_review_comment", "created", {
      action: "created", pull_request: { number: 5 }, sender: { id: 1001, login: "alice", type: "User" },
      comment: { id: 31, html_url: "https://github.com/acme/shop/pull/5#discussion_r31", body: "Use withRetry", user: { id: 1001, login: "alice", type: "User" }, path: "src/a.ts", line: 12, commit_id: "c".repeat(40), side: "LEFT", updated_at: AT },
    }, repo(), AT);
    expect(events[0]).toMatchObject({ type: "comment", path: "src/a.ts", line: 12, commitId: "c".repeat(40), side: "LEFT" });
    const { w, tap } = setup();
    await tap.handle(events[0]!);
    expect(w.sink.puts[0]).toMatchObject({ kind: "github.review_comment", structured: { prNumber: 5, path: "src/a.ts", line: 12, commitId: "c".repeat(40), side: "LEFT", action: "created" } });
  });

  it("a malformed commit or line is not kept", () => {
    const events = githubEventsOf("pull_request_review_comment", "created", {
      action: "created", pull_request: { number: 5 },
      comment: { id: 31, html_url: "https://github.com/acme/shop/pull/5#discussion_r31", body: "x", user: { id: 1001, login: "alice" }, path: "src/a.ts", line: -3, commit_id: "not-a-sha", side: "MIDDLE", updated_at: AT },
    }, repo(), AT);
    expect(events[0]).toBeDefined();
    expect(events[0]).not.toHaveProperty("commitId");
    expect(events[0]).not.toHaveProperty("line");
    expect(events[0]).not.toHaveProperty("side");
  });
});

describe("R7: who merged a pull request", () => {
  const payload = (over: Record<string, unknown>) => ({
    action: "closed", sender: { id: 1001, login: "alice", type: "User" },
    pull_request: { number: 9, html_url: "https://github.com/acme/shop/pull/9", title: "T", user: { id: 9999, login: "mallory", type: "User" }, head: { sha: sha(11) }, base: { ref: "main" }, updated_at: AT, ...over },
  });
  it("a merged pull request carries the host's merged_by; an unmerged one, or a delivery without it, carries none", () => {
    const merged = githubEventsOf("pull_request", "closed", payload({ merged: true, merged_by: { id: 1001, login: "alice", type: "User" } }), repo(), AT)[0]!;
    expect(merged).toMatchObject({ type: "pr", mergedBy: { id: "1001", login: "alice", isBot: false }, author: { id: "9999" } });
    expect(githubEventsOf("pull_request", "closed", payload({ merged: true }), repo(), AT)[0]).not.toHaveProperty("mergedBy");
    expect(githubEventsOf("pull_request", "closed", payload({ merged: false, merged_by: { id: 1001, login: "alice", type: "User" } }), repo(), AT)[0]).not.toHaveProperty("mergedBy");
  });
});

describe("the merge commit of a merged Rovara pull request", () => {
  const rovaraPr = { taskId: "task-1", project: "shop", number: 5, url: "https://github.com/acme/shop/pull/5", candidateHeadSha: sha(20) };
  const merged = (over: Partial<Extract<CodeHostEvent, { type: "pr" }>> = {}): CodeHostEvent => ({
    type: "pr", repo: repo(), number: 5, url: rovaraPr.url, action: "closed", merged: true, title: "Fix", author: alice, headSha: sha(20), baseRef: "main", mergeCommitSha: sha(30), at: AT, version: "closed:1", ...over,
  });

  it("is noted for a Rovara pull request, once the host says it", async () => {
    const noted: unknown[] = [];
    const second = world();
    second.prs.list.push(rovaraPr);
    second.config.set("github", repoScope(repo()), { retention: "D" });
    const tap = createCodeHostTap({ sink: second.sink, actors: second.actors, rovaraPrs: Object.assign(second.prs, { recordMerge: async (input: unknown) => { noted.push(input); } }), mode: second.mode, config: second.config });
    await tap.handle(merged());
    expect(noted).toEqual([{ workspaceId: WS, host: "github", repo: "acme/shop", number: 5, taskId: "task-1", project: "shop", url: rovaraPr.url, mergeCommitSha: sha(30) }]);
  });

  it("is not noted for a pull request that is not Rovara's, an unmerged close, or a missing or malformed commit", async () => {
    const noted: unknown[] = [];
    const second = world();
    second.config.set("github", repoScope(repo()), { retention: "D" });
    const tap = createCodeHostTap({ sink: second.sink, actors: second.actors, rovaraPrs: Object.assign(second.prs, { recordMerge: async (input: unknown) => { noted.push(input); } }), mode: second.mode, config: second.config });
    await tap.handle(merged());
    second.prs.list.push(rovaraPr);
    await tap.handle(merged({ merged: false }));
    const { mergeCommitSha: _none, ...withoutCommit } = merged() as Extract<CodeHostEvent, { type: "pr" }>;
    void _none;
    await tap.handle(withoutCommit);
    await tap.handle(merged({ mergeCommitSha: "xyz" }));
    expect(noted).toEqual([]);
  });

  it("L8: a merge into a branch that is not the default (a milestone or stacked pull request) is not noted: it can be restacked away", async () => {
    const noted: unknown[] = [];
    const second = world();
    second.prs.list.push(rovaraPr);
    second.config.set("github", repoScope(repo()), { retention: "D" });
    const tap = createCodeHostTap({ sink: second.sink, actors: second.actors, rovaraPrs: Object.assign(second.prs, { recordMerge: async (input: unknown) => { noted.push(input); } }), mode: second.mode, config: second.config });
    await tap.handle(merged({ baseRef: "milestone/2" }));
    expect(noted).toEqual([]);
    await tap.handle(merged());
    expect(noted).toHaveLength(1);
  });

  it("a note that fails never fails the delivery", async () => {
    const second = world();
    second.config.set("github", repoScope(repo()), { retention: "D" });
    second.prs.list.push(rovaraPr);
    const tap = createCodeHostTap({ sink: second.sink, actors: second.actors, rovaraPrs: Object.assign(second.prs, { recordMerge: async () => { throw new Error("down"); } }), mode: second.mode, config: second.config });
    const result = await tap.handle(merged());
    expect(result.written).toBe(1);
  });
});

describe("a human edit says who wrote it", () => {
  const job = { repo: repo(), project: "shop", taskId: "task-1", pullRequest: { number: 5, url: "https://github.com/acme/shop/pull/5" }, candidateHeadSha: sha(20), headSha: sha(21) };
  const diff = (authors: Array<typeof alice>): CodeHostDiff => ({
    status: "ahead", truncated: false, commits: authors.map((a, i) => ({ sha: sha(22 + i), author: a, committer: a, verified: true })), files: [{ path: "src/a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }],
  });
  async function run(authors: Array<typeof alice>, over: { exclude?: string[] } = {}) {
    const w = world();
    w.config.set("github", repoScope(repo()), { retention: "D", ...(over.exclude === undefined ? {} : { exclude: over.exclude }) });
    w.actors.members.set("1001", "dev-alice");
    w.actors.members.set("1002", "dev-bob");
    const handed: HumanEditInput[] = [];
    const outcome = await runHumanEdit({ actors: w.actors, mode: w.mode, config: w.config, diffs: { compare: async () => diff(authors) }, extractor: { extract: async (input) => { handed.push(input); return { candidates: 1 }; } } }, job);
    return { outcome, handed };
  }

  it("hands on the canonical developer ids of the proven authors, once each", async () => {
    const { handed, outcome } = await run([alice, bob, alice]);
    expect(outcome).toBe("handed_on");
    expect(handed[0]).toMatchObject({ authorCount: 2 });
    expect([...handed[0]!.authors].sort()).toEqual(["dev-alice", "dev-bob"]);
  });

  it("an excluded account's edit is not learned from", async () => {
    const { handed, outcome } = await run([alice], { exclude: ["alice"] });
    expect(outcome).toBe("skipped");
    expect(handed).toEqual([]);
  });

  it("outsider: one author who is not a member means nothing is handed on", async () => {
    const stranger = { id: "5555", login: "stranger", isBot: false };
    const { handed, outcome } = await run([alice, stranger]);
    expect(outcome).toBe("skipped");
    expect(handed).toEqual([]);
  });
});

describe("H1: a range that carries other people's work is never one member's correction", () => {
  const job = { repo: repo(), project: "shop", taskId: "task-1", pullRequest: { number: 5, url: "https://github.com/acme/shop/pull/5" }, candidateHeadSha: sha(20), headSha: sha(21), headRef: "rovara/x" };
  const files = [{ path: "src/a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }];
  const outsider = { id: "7777", login: "stranger", isBot: false };
  const dependabot = { id: "49699333", login: "dependabot[bot]", isBot: true };
  const signed = (author: typeof alice | undefined, over: Record<string, unknown> = {}) => ({ sha: sha(60), ...(author === undefined ? {} : { author, committer: author }), verified: true, ...over });
  function run(commits: CodeHostDiff["commits"], pushes: Array<{ before: number; after: number; sender: typeof alice }> = []) {
    const w = world();
    w.config.set("github", repoScope(repo()), { retention: "D" });
    w.actors.members.set("1001", "dev-alice");
    w.actors.members.set("1002", "dev-bob");
    for (const push of pushes) w.pushes.pushes.push({ repo: "acme/shop", ref: "refs/heads/rovara/x", before: sha(push.before), after: sha(push.after), senderId: push.sender.id, senderIsBot: push.sender.isBot, at: AT });
    const handed: HumanEditInput[] = [];
    const logs: string[] = [];
    const diff: CodeHostDiff = { status: "ahead", truncated: false, commits, files };
    return { handed, logs, outcome: () => runHumanEdit({ actors: w.actors, mode: w.mode, config: w.config, pushes: w.pushes, diffs: { compare: async () => diff }, extractor: { extract: async (input) => { handed.push(input); return { candidates: 1 }; } }, log: (event) => { logs.push(event); } }, job) };
  }

  it("'Update branch': a merge commit in the range is skipped, even when every commit in it is a member's", async () => {
    const f = run([signed(alice, { sha: sha(61) }), signed(alice, { sha: sha(62), merge: true })]);
    expect(await f.outcome()).toBe("skipped");
    expect(f.handed).toEqual([]);
    expect(f.logs).toContain("human_edit.skipped");
  });

  it("push-chain mode: an outsider's commit under a member's push is skipped (the member does not vouch for other people's authors)", async () => {
    const f = run([{ sha: sha(61), author: outsider, verified: false }], [{ before: 20, after: 21, sender: alice }]);
    expect(await f.outcome()).toBe("skipped");
    expect(f.handed).toEqual([]);
  });

  it("push-chain mode: a Dependabot commit, or a commit with no resolved author, is skipped", async () => {
    for (const author of [dependabot, undefined]) {
      const f = run([{ sha: sha(61), ...(author === undefined ? {} : { author }), verified: false }], [{ before: 20, after: 21, sender: alice }]);
      expect(await f.outcome()).toBe("skipped");
      expect(f.handed).toEqual([]);
    }
  });

  it("push-chain mode: when every commit is a member's, every author is named (the pusher and the commit authors, once each)", async () => {
    const f = run([{ sha: sha(61), author: bob, verified: false }, { sha: sha(62), author: alice, verified: false }], [{ before: 20, after: 21, sender: alice }]);
    expect(await f.outcome()).toBe("handed_on");
    expect([...f.handed[0]!.authors].sort()).toEqual(["dev-alice", "dev-bob"]);
  });

  it("R2: a commit that carries a Co-authored-by trailer (a committed suggestion) skips the range, in verified mode and in push-chain mode", async () => {
    const verified = run([signed(alice, { sha: sha(61) }), signed(alice, { sha: sha(62), coAuthored: true })]);
    expect(await verified.outcome()).toBe("skipped");
    expect(verified.handed).toEqual([]);
    expect(verified.logs).toContain("human_edit.skipped");
    const chain = run([{ sha: sha(61), author: alice, verified: false, coAuthored: true }], [{ before: 20, after: 21, sender: alice }]);
    expect(await chain.outcome()).toBe("skipped");
    expect(chain.handed).toEqual([]);
    // Positive control: the same commits without the trailer are handed on.
    const clean = run([signed(alice, { sha: sha(61) }), signed(alice, { sha: sha(62) })]);
    expect(await clean.outcome()).toBe("handed_on");
  });

  it("R2: the GitHub compare reader marks a commit whose message has a Co-authored-by trailer (any case, any position) and one with no message at all", async () => {
    const message = (text: string | undefined) => ({ sha: sha(61), parents: [{ sha: sha(20) }], author: { id: 1001, login: "alice" }, commit: text === undefined ? {} : { message: text } });
    const reader = createGithubDiffReader(async () => ({ status: 200, body: { status: "ahead", total_commits: 5, commits: [
      message("Fix the retry"),
      message("Apply suggestions from code review\n\nCo-authored-by: Sam <sam@example.com>"),
      message("Tidy\n\nbody\nCO-AUTHORED-BY : Sam <sam@example.com>\nSigned-off-by: A"),
      message("Mentions Co-authored-by: in the middle of a line only"),
      message(undefined),
    ], files: [{ filename: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] } }));
    const diff = await reader.compare({ repo: repo(), base: sha(20), head: sha(21) });
    expect(diff!.commits.map((commit) => commit.coAuthored === true)).toEqual([false, true, true, false, true]);
  });

  it("the GitHub compare reader marks a commit with two parents as a merge", async () => {
    const reader = createGithubDiffReader(async () => ({ status: 200, body: { status: "ahead", total_commits: 2, commits: [
      { sha: sha(61), parents: [{ sha: sha(20) }], author: { id: 1001, login: "alice" } },
      { sha: sha(62), parents: [{ sha: sha(61) }, { sha: sha(99) }], author: { id: 1001, login: "alice" } },
    ], files: [{ filename: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] } }));
    const diff = await reader.compare({ repo: repo(), base: sha(20), head: sha(21) });
    expect(diff!.commits.map((commit) => commit.merge === true)).toEqual([false, true]);
  });
});

