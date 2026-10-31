import { describe, expect, it } from "vitest";
import { createCodeHostTap, humanEditFile, revertedCommits, runHumanEdit, revertedPullRequests, type CodeHostDiff, type CodeHostEvent, type CodeHostRepo, type HumanEditInput } from "../../packages/broker/src/team-record/sources/codehost.js";
import { createGithubDiffReader, createGithubRecordTap, githubEventsOf } from "../../packages/broker/src/team-record/sources/github.js";
import { createRovaraEmitter, type RovaraEventBase } from "../../packages/broker/src/team-record/sources/rovara.js";
import { repoScope } from "../../packages/broker/src/team-record/sources/codehost.js";
import { sha, world, WS } from "../support/team-record-ingest-fakes.js";

const repo = (over: Partial<CodeHostRepo> = {}): CodeHostRepo => ({ host: "github", id: "77", fullName: "acme/shop", isPrivate: true, defaultBranch: "main", workspaceId: WS, project: "shop", ...over });
const AT = "2026-10-30T10:00:00.000Z";
const alice = { id: "1001", login: "alice", isBot: false };
const mallory = { id: "9999", login: "mallory", isBot: false };
const AWS_KEY = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");

function setup(extra: Partial<Parameters<typeof createCodeHostTap>[0]> = {}) {
  const w = world();
  w.config.set("github", repoScope(repo()), { retention: "D" });
  w.actors.members.set("1001", "dev-alice");
  const logs: string[] = [];
  const tap = createCodeHostTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config, log: (event) => logs.push(event), ...extra });
  return { w, tap, logs };
}

const pr = (over: Partial<Extract<CodeHostEvent, { type: "pr" }>> = {}): CodeHostEvent => ({
  type: "pr", repo: repo(), number: 5, url: "https://github.com/acme/shop/pull/5", action: "opened", merged: false, title: "Fix cart total", body: "Rounds correctly now",
  author: alice, headSha: sha(10), baseRef: "main", at: AT, version: "opened:1", ...over,
});

describe("code-host tap: what is recorded", () => {
  it("records a member's pull request with the repository's audience and a redacted text", async () => {
    const { w, tap } = setup();
    const result = await tap.handle(pr({ body: `Use key ${AWS_KEY} for staging` }));
    expect(result.written).toBe(1);
    const draft = w.sink.puts[0]!;
    expect(draft.kind).toBe("github.pr");
    expect(draft.trust).toBe("member");
    expect(draft.actor).toMatchObject({ sourceId: "1001", developerId: "dev-alice" });
    expect(draft.audience).toMatchObject({ kind: "restricted", acl: { scope: "github:repo/77", liveCheck: "on_read" } });
    expect(draft.text).toContain("Fix cart total");
    expect(draft.text).not.toContain(AWS_KEY);
    expect(draft.links).toEqual(["https://github.com/acme/shop/pull/5"]);
  });

  it("gives a public repository the project audience", async () => {
    const { w, tap } = setup();
    w.config.set("github", repoScope(repo({ isPrivate: false })));
    await tap.handle({ ...(pr() as Extract<CodeHostEvent, { type: "pr" }>), repo: repo({ isPrivate: false }) });
    expect(w.sink.puts[0]!.audience).toEqual({ kind: "project" });
  });

  it("marks a non-member as outsider and a bot as system", async () => {
    const { w, tap } = setup();
    await tap.handle(pr({ author: mallory, number: 6 }));
    await tap.handle(pr({ author: { id: "5", login: "dependabot[bot]", isBot: true }, number: 7 }));
    expect(w.sink.puts.map((draft) => draft.trust)).toEqual(["outsider", "system"]);
  });

  it("records a CI verdict with no text, and a review and a comment with their own ids", async () => {
    const { w, tap } = setup();
    await tap.handle({ type: "ci", repo: repo(), id: "suite9", name: "build", conclusion: "failure", headSha: sha(10), prNumbers: [5], at: AT });
    await tap.handle({ type: "review", repo: repo(), prNumber: 5, id: "31", url: "https://github.com/acme/shop/pull/5#r31", action: "submitted", state: "changes_requested", body: "Please add a test", author: alice, at: AT, version: "submitted:1" });
    await tap.handle({ type: "comment", repo: repo(), prNumber: 5, id: "41", url: "https://github.com/acme/shop/pull/5#c41", action: "created", surface: "review_comment", body: "nit", author: alice, path: "src/a.ts", at: AT, version: "created:1" });
    expect(w.sink.kinds()).toEqual(["github.ci", "github.review", "github.review_comment"]);
    expect(w.sink.puts[0]!.text).toBeUndefined();
    expect(w.sink.puts[0]!.trust).toBe("system");
    expect(w.sink.puts[1]!.sourceRef.id).toBe("acme/shop#pr5:review31");
    expect(w.sink.puts[2]!.sourceRef.id).toBe("acme/shop#pr5:review_comment41");
  });

  it("keeps no raw text under retention A", async () => {
    const { w, tap } = setup();
    w.config.set("github", repoScope(repo()), { retention: "A" });
    await tap.handle(pr());
    expect(w.sink.puts[0]!.text).toBeUndefined();
    expect(w.sink.puts[0]!.retention).toBe("A");
    expect(w.sink.puts[0]!.structured).toMatchObject({ number: 5, action: "opened" });
  });

  it("records nothing without a source row, with the row disabled, or with the mode off, and a failing config read is no record", async () => {
    const { w, tap } = setup();
    w.config.rows.clear();
    expect((await tap.handle(pr())).written).toBe(0);
    w.config.set("github", repoScope(repo()), { enabled: false });
    expect((await tap.handle(pr())).written).toBe(0);
    w.config.set("github", repoScope(repo()));
    w.mode.on = false;
    expect((await tap.handle(pr())).written).toBe(0);
    w.mode.on = true;
    w.config.throws = true;
    expect((await tap.handle(pr())).written).toBe(0);
    expect(w.sink.puts).toEqual([]);
  });

  it("skips an excluded author, dedupes a redelivery, and a failing sink never throws", async () => {
    const { w, tap } = setup();
    w.config.set("github", repoScope(repo()), { exclude: ["alice"] });
    expect((await tap.handle(pr())).written).toBe(0);
    w.config.set("github", repoScope(repo()));
    await tap.handle(pr());
    expect((await tap.handle(pr())).duplicates).toBe(1);
    w.sink.failPut = true;
    expect((await tap.handle(pr({ version: "closed:2", action: "closed" }))).failed).toBe(1);
  });

  it("honours a deleted comment and a deleted or transferred repository whatever the row, the mode or the config read says", async () => {
    const { w, tap } = setup();
    const deletedComment: CodeHostEvent = { type: "comment", repo: repo(), prNumber: 5, id: "41", url: "https://github.com/acme/shop/pull/5#c41", action: "deleted", surface: "review_comment", author: alice, at: AT, version: "deleted:1" };
    // The row is disabled, the mode is off and the config read fails, all at once: the delete still goes through.
    w.config.set("github", repoScope(repo()), { enabled: false });
    w.mode.on = false;
    w.config.throws = true;
    await tap.handle(deletedComment);
    await tap.handle({ type: "repository", repo: repo(), action: "deleted", at: AT });
    await tap.handle({ type: "repository", repo: repo(), action: "transferred", at: AT });
    expect(w.sink.tombstones).toMatchObject([
      { system: "github", sourceIds: ["acme/shop#pr5:review_comment41"], cause: "source_deleted" },
      { system: "github", scope: "github:repo/77", cause: "source_deleted" },
      { system: "github", scope: "github:repo/77", cause: "source_deleted" },
    ]);
    expect(w.sink.puts).toEqual([]);
  });

  it("a failing tombstone is counted, never thrown", async () => {
    const { w, tap } = setup();
    w.sink.tombstone = async () => { throw new Error("table unavailable"); };
    const result = await tap.handle({ type: "repository", repo: repo(), action: "deleted", at: AT });
    expect(result.failed).toBe(1);
  });
});

describe("reverts of Rovara pull requests", () => {
  const rovaraPr = { taskId: "task-1", project: "shop", number: 5, url: "https://github.com/acme/shop/pull/5", candidateHeadSha: sha(20), mergeCommitSha: sha(30) };

  it("detects a revert commit on the default branch, records both events once, and re-scores the task", async () => {
    const marks: unknown[] = [];
    const { w, tap } = setup({ trackRecord: { markNotHeld: async (input) => { marks.push(input); } } });
    w.prs.list.push(rovaraPr);
    const push: CodeHostEvent = { type: "push", repo: repo(), ref: "refs/heads/main", at: AT, commits: [{ sha: sha(40), message: `Revert "Fix cart total"\n\nThis reverts commit ${sha(30)}.` }] };
    const first = await tap.handle(push);
    expect(first.written).toBe(2);
    expect(w.sink.kinds()).toEqual(["github.revert", "rovara.closed"]);
    expect(w.sink.puts[1]!).toMatchObject({ source: "rovara", trust: "rovara", structured: { outcome: "reverted", taskId: "task-1" } });
    expect(marks).toEqual([{ workspaceId: WS, project: "shop", taskId: "task-1", reason: "reverted", revertRef: sha(40) }]);
    // The same revert told again (a second delivery, or the revert pull request's merge) adds nothing new to the record.
    const second = await tap.handle(push);
    expect(second.written).toBe(0);
    expect(second.duplicates).toBe(2);
  });

  it("detects a merged revert pull request by its body, and ignores one that is not merged, not ours, or about another repository", async () => {
    const { w, tap } = setup();
    w.prs.list.push(rovaraPr);
    const revertPr = (over: Partial<Extract<CodeHostEvent, { type: "pr" }>>): CodeHostEvent => pr({ number: 9, title: 'Revert "Fix cart total"', body: "Reverts acme/shop#5", action: "closed", merged: true, mergeCommitSha: sha(41), version: "closed:9", ...over });
    await tap.handle(revertPr({ merged: false }));
    expect(w.sink.kinds().filter((kind) => kind === "github.revert")).toEqual([]);
    await tap.handle(revertPr({ body: "Reverts other/repo#5", version: "closed:10" }));
    await tap.handle(revertPr({ body: "Reverts acme/shop#99", version: "closed:11" }));
    expect(w.sink.kinds().filter((kind) => kind === "github.revert")).toEqual([]);
    await tap.handle(revertPr({ version: "closed:12" }));
    expect(w.sink.kinds().filter((kind) => kind === "github.revert")).toEqual(["github.revert"]);
  });

  it("ignores a merged revert PR whose base is not the default branch", async () => {
    const { w, tap } = setup();
    w.prs.list.push(rovaraPr);
    await tap.handle(pr({ number: 9, title: 'Revert "Fix cart total"', body: "Reverts acme/shop#5", action: "closed", merged: true, baseRef: "release/1", mergeCommitSha: sha(41), version: "closed:9" }));
    expect(w.sink.kinds().filter((kind) => kind === "github.revert")).toEqual([]);
  });

  it("re-scores a reverted task once, however many deliveries tell of it, and retries after a failure", async () => {
    const claimed = new Set<string>();
    const claims = { claim: async (key: string) => (claimed.has(key) ? false : (claimed.add(key), true)), release: async (key: string) => { claimed.delete(key); } };
    const marks: unknown[] = [];
    let failing = true;
    const { w, tap } = setup({ claims, trackRecord: { markNotHeld: async (input) => { if (failing) throw new Error("down"); marks.push(input); } } });
    w.prs.list.push(rovaraPr);
    const push = (version: number): CodeHostEvent => ({ type: "push", repo: repo(), ref: "refs/heads/main", at: AT, commits: [{ sha: sha(40 + version), message: `This reverts commit ${sha(30)}.` }] });
    await tap.handle(push(0));
    expect(marks).toEqual([]);
    failing = false;
    await tap.handle(push(0));
    await tap.handle(push(1));
    expect(marks).toHaveLength(1);
  });

  it("ignores a revert commit pushed to another branch, or one whose target is not a Rovara merge commit", async () => {
    const { w, tap } = setup();
    w.prs.list.push(rovaraPr);
    await tap.handle({ type: "push", repo: repo(), ref: "refs/heads/feature", at: AT, commits: [{ sha: sha(40), message: `This reverts commit ${sha(30)}` }] });
    await tap.handle({ type: "push", repo: repo(), ref: "refs/heads/main", at: AT, commits: [{ sha: sha(41), message: `This reverts commit ${sha(31)}` }] });
    expect(w.sink.puts.filter((draft) => draft.kind === "github.revert")).toEqual([]);
  });

  it("parses revert text strictly", () => {
    expect(revertedCommits(`This reverts commit ${sha(30).toUpperCase()}.`)).toEqual([sha(30)]);
    expect(revertedCommits("This reverts commit abc123")).toEqual([]);
    expect(revertedPullRequests("Reverts acme/shop#5 and Reverts #6 and Reverts other/x#7", "acme/shop")).toEqual([5, 6]);
  });
});

describe("human edits to Rovara pull requests (read live, never stored)", () => {
  const rovaraPr = { taskId: "task-1", project: "shop", number: 5, url: "https://github.com/acme/shop/pull/5", candidateHeadSha: sha(20) };
  const merged = (headSha = sha(21)): CodeHostEvent => pr({ action: "closed", merged: true, headSha, mergeCommitSha: sha(30), version: "closed:5" });
  const patchOf = (lines: number, secret = false): string => ["@@ -1,3 +1,3 @@ function total()", " context line", ...Array.from({ length: lines }, (_, i) => (i === 0 && secret ? `+const key = "${AWS_KEY}"` : `+line ${i}`)), "-old line"].join("\n");

  function fixture(diff: CodeHostDiff | undefined) {
    const handed: HumanEditInput[] = [];
    const compares: unknown[] = [];
    const { w, tap, logs } = setup({
      diffs: { compare: async (input) => { compares.push(input); return diff; } },
      extractor: { extract: async (input) => { handed.push(input); return { candidates: 1 }; } },
    });
    w.prs.list.push(rovaraPr);
    return { w, tap, logs, handed, compares };
  }

  it("hands a bounded, redacted diff to the extractor and stores NOTHING of it", async () => {
    const { w, tap, handed, compares } = fixture({
      status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, verified: true }],
      files: [{ path: "src/cart.ts", additions: 250, deletions: 1, patch: patchOf(250, true) }],
    });
    await tap.handle(merged());
    expect(compares).toEqual([{ repo: repo(), base: sha(20), head: sha(21) }]);
    expect(handed).toHaveLength(1);
    const input = handed[0]!;
    expect(input).toMatchObject({ workspaceId: WS, project: "shop", taskId: "task-1", repo: "acme/shop", trust: "member", link: "https://github.com/acme/shop/pull/5" });
    const file = input.files[0]!;
    expect(file.symbols).toEqual(["function total()"]);
    // 200 changed lines at most, hunk headers kept, context dropped, credentials redacted.
    expect(file.hunks.filter((line) => line.startsWith("+") || line.startsWith("-"))).toHaveLength(200);
    expect(file.hunks[0]).toMatch(/^@@/);
    expect(file.hunks.join("\n")).not.toContain(AWS_KEY);
    expect(file.hunks.join("\n")).not.toContain("context line");
    // Nothing of the diff reaches the record: the only rows are the pull request's own.
    expect(w.sink.kinds()).toEqual(["github.pr"]);
    expect(JSON.stringify(w.sink.puts)).not.toContain("line 1");
    expect(JSON.stringify(w.sink.puts)).not.toContain("function total");
  });

  it("hands nothing on when any human commit is an outsider's, a bot's, or has no linked author", async () => {
    for (const authors of [[alice, mallory], [alice, { id: "5", login: "x[bot]", isBot: true }], [alice, undefined]]) {
      const { tap, handed, logs } = fixture({
        status: "ahead", truncated: false, commits: authors.map((author, index) => ({ sha: sha(50 + index), verified: true, ...(author === undefined ? {} : { author }) })),
        files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }],
      });
      await tap.handle(merged());
      expect(handed).toEqual([]);
      expect(logs).toContain("human_edit.skipped");
    }
  });

  it("makes no call when nothing was pushed after Rovara's last push, and none for a pull request that is not Rovara's", async () => {
    const same = fixture({ status: "identical", truncated: false, commits: [], files: [] });
    await same.tap.handle(merged(sha(20)));
    expect(same.compares).toEqual([]);
    const other = fixture({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, verified: true }], files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] });
    await other.tap.handle(pr({ number: 77, action: "closed", merged: true, headSha: sha(21), version: "closed:77" }));
    expect(other.compares).toEqual([]);
    const notMerged = fixture({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, verified: true }], files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] });
    await notMerged.tap.handle(pr({ action: "closed", merged: false, headSha: sha(21), version: "closed:6" }));
    expect(notMerged.compares).toEqual([]);
  });

  it("drops a diverged or behind compare (a force push or rebase mixes in other people's commits), and one that was cut short", async () => {
    for (const status of ["diverged", "behind"] as const) {
      const f = fixture({ status, truncated: false, commits: [{ sha: sha(22), author: alice, verified: true }], files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] });
      await f.tap.handle(merged());
      expect(f.handed).toEqual([]);
      expect(f.logs).toContain("human_edit.skipped");
    }
    // A cut-short compare has commits nobody checked: they are as good as outsiders', so nothing is handed on.
    const truncated = fixture({ status: "ahead", truncated: true, commits: [{ sha: sha(22), author: alice, verified: true }], files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] });
    await truncated.tap.handle(merged());
    expect(truncated.handed).toEqual([]);
    const none = fixture(undefined);
    await none.tap.handle(merged());
    expect(none.handed).toEqual([]);
  });

  it("requires every human commit to be signature-verified: an author name or email on a commit proves nothing", async () => {
    const spoofed = fixture({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, verified: false }], files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] });
    await spoofed.tap.handle(merged());
    expect(spoofed.handed).toEqual([]);
    const mixed = fixture({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, verified: true }, { sha: sha(23), author: alice, verified: false }], files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] });
    await mixed.tap.handle(merged());
    expect(mixed.handed).toEqual([]);
  });

  it("hands a task's edit on once however often the merge is delivered, and gives the claim back when the extractor fails", async () => {
    const claimed = new Set<string>();
    const claims = { claim: async (key: string) => (claimed.has(key) ? false : (claimed.add(key), true)), release: async (key: string) => { claimed.delete(key); } };
    let failing = true;
    const handed: HumanEditInput[] = [];
    const { w, tap } = setup({
      claims,
      diffs: { compare: async () => ({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, verified: true }], files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] }) },
      extractor: { extract: async (input) => { if (failing) throw new Error("model down"); handed.push(input); return { candidates: 1 }; } },
    });
    w.prs.list.push(rovaraPr);
    await tap.handle(merged());
    expect(handed).toEqual([]);
    failing = false;
    await tap.handle(merged());
    await tap.handle(merged());
    await tap.handle(merged());
    expect(handed).toHaveLength(1);
  });

  it("queues the read when a job queue is given, so the compare and the extractor never run inside the webhook's answer", async () => {
    const jobs: unknown[] = [];
    const compares: unknown[] = [];
    const { w, tap } = setup({
      humanEditJobs: { enqueue: async (job) => { jobs.push(job); } },
      diffs: { compare: async (input) => { compares.push(input); return undefined; } },
      extractor: { extract: async () => ({ candidates: 0 }) },
    });
    w.prs.list.push(rovaraPr);
    await tap.handle(merged());
    expect(compares).toEqual([]);
    expect(jobs).toEqual([{ repo: repo(), project: "shop", taskId: "task-1", pullRequest: { number: 5, url: rovaraPr.url }, candidateHeadSha: sha(20), headSha: sha(21) }]);
  });

  it("a queued read re-checks the source row before it reads anything", async () => {
    const compares: unknown[] = [];
    const { w } = setup();
    w.mode.on = false;
    const outcome = await runHumanEdit({ actors: w.actors, mode: w.mode, config: w.config, diffs: { compare: async (input) => { compares.push(input); return undefined; } }, extractor: { extract: async () => ({ candidates: 0 }) } },
      { repo: repo(), project: "shop", taskId: "task-1", pullRequest: { number: 5, url: rovaraPr.url }, candidateHeadSha: sha(20), headSha: sha(21) });
    expect(outcome).toBe("skipped");
    expect(compares).toEqual([]);
  });

  it("reads a patch as hunk headers and changed lines only", () => {
    expect(humanEditFile({ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@ sym\n+x\n--- not a change\n+++ nor this" }).hunks).toEqual(["@@ -1 +1 @@ sym", "+x"]);
  });
});

describe("GitHub adapter", () => {
  const deliver = (eventName: string, action: string | undefined, payload: Record<string, unknown>) => githubEventsOf(eventName, action, payload, repo(), AT);
  const user = { id: 1001, login: "alice", type: "User" };
  const prBody = { number: 5, html_url: "https://github.com/acme/shop/pull/5", title: "T", body: "B", user, head: { sha: sha(10) }, base: { ref: "main" }, merged: true, merge_commit_sha: sha(30), updated_at: "2026-10-30T10:00:00Z" };

  it("reads each followed event and ignores the rest", () => {
    expect(deliver("pull_request", "closed", { pull_request: prBody })).toMatchObject([{ type: "pr", number: 5, merged: true, mergeCommitSha: sha(30), author: { id: "1001", isBot: false } }]);
    expect(deliver("pull_request", "labeled", { pull_request: prBody })).toEqual([]);
    expect(deliver("pull_request_review", "submitted", { pull_request: { number: 5 }, review: { id: 3, html_url: "https://github.com/x", state: "APPROVED", body: "ok", user, submitted_at: "2026-10-30T10:00:00Z" } })).toMatchObject([{ type: "review", state: "approved" }]);
    expect(deliver("issue_comment", "created", { issue: { number: 5, pull_request: {} }, comment: { id: 4, html_url: "https://github.com/x", body: "c", user, updated_at: "2026-10-30T10:00:00Z" } })).toMatchObject([{ type: "comment", surface: "discussion" }]);
    expect(deliver("issue_comment", "created", { issue: { number: 5 }, comment: { id: 4, html_url: "https://github.com/x", body: "c", user, updated_at: "2026-10-30T10:00:00Z" } })).toEqual([]);
    expect(deliver("check_suite", "completed", { check_suite: { id: 1, conclusion: "success", head_sha: sha(10), pull_requests: [{ number: 5 }] } })).toMatchObject([{ type: "ci", conclusion: "success", prNumbers: [5] }]);
    expect(deliver("check_suite", "requested", { check_suite: { id: 1, conclusion: null, head_sha: sha(10) } })).toEqual([]);
    expect(deliver("push", undefined, { ref: "refs/heads/main", commits: [{ id: sha(1), message: "m" }] })).toMatchObject([{ type: "push" }]);
    expect(deliver("repository", "transferred", {})).toMatchObject([{ type: "repository", action: "transferred" }]);
    expect(deliver("pull_request", "opened", { pull_request: { number: "five" } })).toEqual([]);
    expect(deliver("star", "created", {})).toEqual([]);
  });

  it("takes the workspace from the installation, never the body, and records nothing for an unregistered repository", async () => {
    const w = world();
    w.config.set("github", "github:repo/77");
    w.actors.members.set("1001", "dev-alice");
    const asked: unknown[] = [];
    const tap = createGithubRecordTap({
      sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config, now: () => Date.parse(AT),
      resolveRepo: async (input) => { asked.push(input); return input.repositoryId === 77 ? { workspaceId: "ws-from-install", project: "shop" } : undefined; },
    });
    const payload = (id: number) => ({ action: "opened", installation: { id: 5 }, repository: { id, full_name: "Acme/Shop", private: true, default_branch: "main" }, pull_request: prBody, workspaceId: "ws-evil" });
    expect(await tap({ eventName: "pull_request", deliveryId: "d1", payload: payload(77) })).toMatchObject({ written: 1 });
    expect(w.sink.puts[0]!.workspaceId).toBe("ws-from-install");
    expect(w.sink.puts[0]!.repo).toBe("acme/shop");
    expect(asked[0]).toEqual({ installationId: 5, repositoryId: 77, fullName: "acme/shop" });
    expect(await tap({ eventName: "pull_request", deliveryId: "d2", payload: payload(78) })).toBeUndefined();
    expect(await tap({ eventName: "pull_request", deliveryId: "d3", payload: { nonsense: true } })).toBeUndefined();
    expect(w.sink.puts).toHaveLength(1);
  });

  it("reads a compare and refuses anything but a clean answer", async () => {
    const calls: string[] = [];
    const body = { status: "ahead", total_commits: 1, commits: [{ sha: sha(22), author: { id: 1001, login: "alice", type: "User" }, commit: { verification: { verified: true } } }, { sha: sha(23), author: null, commit: { verification: { verified: false } } }], files: [{ filename: "a.ts", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n+x" }] };
    const reader = createGithubDiffReader(async (path) => { calls.push(path); return { status: 200, body }; });
    const diff = await reader.compare({ repo: repo(), base: sha(20), head: sha(21) });
    expect(calls).toEqual([`/repos/acme/shop/compare/${sha(20)}...${sha(21)}?per_page=100`]);
    expect(diff).toMatchObject({ status: "ahead", truncated: false, commits: [{ author: { id: "1001" } }, { sha: sha(23) }], files: [{ path: "a.ts" }] });
    expect(diff!.commits.map((commit) => commit.verified)).toEqual([true, false]);
    expect(diff!.commits[1]!.author).toBeUndefined();
    // More commits than were returned: the compare is cut short, and says so.
    const cut = await createGithubDiffReader(async () => ({ status: 200, body: { ...body, total_commits: 400 } })).compare({ repo: repo(), base: sha(20), head: sha(21) });
    expect(cut!.truncated).toBe(true);
    expect(await reader.compare({ repo: repo(), base: "main", head: sha(21) })).toBeUndefined();
    expect(await reader.compare({ repo: repo({ fullName: "../../etc" }), base: sha(20), head: sha(21) })).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(await createGithubDiffReader(async () => ({ status: 404, body: {} })).compare({ repo: repo(), base: sha(20), head: sha(21) })).toBeUndefined();
    expect(await createGithubDiffReader(async () => ({ status: 200, body: { status: "weird" } })).compare({ repo: repo(), base: sha(20), head: sha(21) })).toBeUndefined();
  });
});

describe("Rovara's own events", () => {
  const base = (over: Partial<RovaraEventBase> = {}): RovaraEventBase => ({ workspaceId: WS, project: "shop", taskId: "task-1", visibility: { kind: "shared" }, at: AT, url: "https://app.example.com/tasks/task-1", ...over });
  function emitterSetup() {
    const w = world();
    w.config.set("rovara", "rovara:project/shop", { retention: "D" });
    w.actors.members.set("dev-1", "dev-1");
    const told: unknown[] = [];
    const emitter = createRovaraEmitter({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config, reflector: { taskEnded: async (input) => { told.push(input); } } });
    return { w, emitter, told };
  }

  it("keeps a human send-back reason as a member's text, and an automatic one as a code only", async () => {
    const { w, emitter } = emitterSetup();
    await emitter.sendBack({ ...base(), sendBackId: "s1", round: 1, origin: "human", reasonText: `use the repo helper, token ${AWS_KEY}`, actorDeveloperId: "dev-1" });
    await emitter.sendBack({ ...base(), sendBackId: "s2", round: 2, origin: "automatic", code: "CHECKS_FAILED", reasonText: "ignored free text" });
    expect(w.sink.puts[0]).toMatchObject({ kind: "rovara.send_back", trust: "member", actor: { developerId: "dev-1" } });
    expect(w.sink.puts[0]!.text).toContain("repo helper");
    expect(w.sink.puts[0]!.text).not.toContain(AWS_KEY);
    expect(w.sink.puts[1]).toMatchObject({ trust: "rovara", structured: { code: "CHECKS_FAILED", round: 2 } });
    expect(w.sink.puts[1]!.text).toBeUndefined();
  });

  it("follows the task's visibility: a private task's events are not project-wide", async () => {
    const { w, emitter } = emitterSetup();
    await emitter.planOutcome({ ...base(), planId: "p1", outcome: "approved", claims: 4, claimsHeld: 3 });
    await emitter.planOutcome({ ...base({ visibility: { kind: "private", ownerDeveloperId: "dev-1" } }), planId: "p2", outcome: "approved", claims: 1, claimsHeld: 1 });
    await emitter.reviewOutcome({ ...base({ visibility: { kind: "shared_with", developerIds: ["dev-1", "dev-2"] } }), publicationId: "r1", outcome: "published", claims: 2, claimsHeld: 2 });
    expect(w.sink.puts[0]!.audience).toEqual({ kind: "project" });
    expect(w.sink.puts[1]!.audience).toMatchObject({ kind: "restricted", acl: { scope: "rovara:task/task-1", principals: ["dev-1"] } });
    expect(w.sink.puts[2]!.audience).toMatchObject({ kind: "restricted", acl: { principals: ["dev-1", "dev-2"] } });
  });

  it("drops free text under retention A but keeps the structured parts", async () => {
    const { w, emitter } = emitterSetup();
    w.config.set("rovara", "rovara:project/shop", { retention: "A" });
    await emitter.remembered({ ...base(), noteId: "n1", text: "we always use cents", actorDeveloperId: "dev-1" });
    expect(w.sink.puts[0]!.text).toBeUndefined();
    expect(w.sink.puts[0]!.structured).toMatchObject({ taskId: "task-1" });
  });

  it("tells the reflector once per task, only after the terminal row was accepted", async () => {
    const { w, emitter, told } = emitterSetup();
    const ended = { ...base(), outcome: "merged" as const, rounds: 2, sendBacks: 1 };
    await emitter.taskEnded(ended);
    await emitter.taskEnded(ended);
    expect(told).toEqual([{ workspaceId: WS, project: "shop", taskId: "task-1", outcome: "merged" }]);
    expect(w.sink.puts[0]).toMatchObject({ kind: "rovara.task", trust: "rovara", structured: { outcome: "merged", rounds: 2, sendBacks: 1 } });
    w.sink.failPut = true;
    await emitter.taskEnded({ ...ended, taskId: "task-2" });
    w.sink.failPut = false;
    w.mode.on = false;
    await emitter.taskEnded({ ...ended, taskId: "task-3" });
    expect(told).toHaveLength(1);
  });

  it("treats an unknown developer as an outsider rather than failing", async () => {
    const { w, emitter } = emitterSetup();
    await emitter.remembered({ ...base(), noteId: "n2", text: "hello", actorDeveloperId: "dev-unknown" });
    expect(w.sink.puts[0]!.trust).toBe("outsider");
  });
});
