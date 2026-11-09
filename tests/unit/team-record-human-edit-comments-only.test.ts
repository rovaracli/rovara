// Lessons in the repo, lane R1b (review M-a): when the human-edit tap SKIPS a pull request someone pushed to after Rovara, for any reason, the pull request's review comments are still reflected on, comment-only, by the
// extractor's `commentsOnly` (same once-key and gates as the edit path, inside the extractor). The task end leaves such a pull request to the job, so a skip must never lose its comments. A job whose extractor is
// called (or that failed and is retried) does not take the fallback.
import { describe, expect, it } from "vitest";
import { runHumanEdit, repoScope, type CodeHostDiff, type CodeHostRepo, type HumanEditInput } from "../../packages/broker/src/team-record/sources/codehost.js";
import { sha, world, WS } from "../support/team-record-ingest-fakes.js";

const repo: CodeHostRepo = { host: "github", id: "77", fullName: "acme/shop", isPrivate: true, defaultBranch: "main", workspaceId: WS, project: "shop" };
const AT = "2026-10-30T10:00:00.000Z";
const alice = { id: "1001", login: "alice", isBot: false };
const stranger = { id: "7777", login: "stranger", isBot: false };
const dependabot = { id: "49699333", login: "dependabot[bot]", isBot: true };
const job = { repo, project: "shop", taskId: "task-1", pullRequest: { number: 5, url: "https://github.com/acme/shop/pull/5" }, candidateHeadSha: sha(20), headSha: sha(21), headRef: "rovara/x" };
const files = [{ path: "src/a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }];
const signed = (author: typeof alice | undefined, over: Record<string, unknown> = {}) => ({ sha: sha(60), ...(author === undefined ? {} : { author, committer: author }), verified: true, ...over });
const ahead = (commits: CodeHostDiff["commits"], over: Partial<CodeHostDiff> = {}): CodeHostDiff => ({ status: "ahead", truncated: false, commits, files, ...over });

interface Fallback { workspaceId: string; project: string; taskId: string; link: string }
interface Case { name: string; diff: CodeHostDiff | undefined; configured?: boolean; exclude?: string[]; claimTaken?: boolean }
async function run(c: Case) {
  const w = world();
  if (c.configured !== false) w.config.set("github", repoScope(repo), { retention: "D", ...(c.exclude === undefined ? {} : { exclude: c.exclude }) });
  w.actors.members.set("1001", "dev-alice");
  const extracted: HumanEditInput[] = [];
  const fallback: Fallback[] = [];
  const outcome = await runHumanEdit({
    actors: w.actors, mode: w.mode, config: w.config, pushes: w.pushes, diffs: { compare: async () => c.diff },
    ...(c.claimTaken === true ? { claims: { claim: async () => false, release: async () => undefined } } : {}),
    extractor: { extract: async (input: HumanEditInput) => { extracted.push(input); return { candidates: 1 }; }, commentsOnly: async (input: Fallback) => { fallback.push(input); } },
  }, job);
  return { outcome, extracted, fallback };
}

describe("every skip of the human-edit job still reflects the pull request's comments, comment-only, once", () => {
  const skips: Case[] = [
    { name: "'Update branch': a merge commit in the range", diff: ahead([signed(alice, { sha: sha(61) }), signed(alice, { sha: sha(62), merge: true })]) },
    { name: "a bot's commit (Dependabot)", diff: ahead([signed(dependabot, { verified: false })]) },
    { name: "a commit with no resolved author", diff: ahead([signed(undefined, { verified: false })]) },
    { name: "an author who is not a member", diff: ahead([signed(alice, { sha: sha(61) }), signed(stranger, { sha: sha(62), verified: false })]) },
    { name: "authorship not proved (an unverified commit with no push behind it)", diff: ahead([signed(alice, { verified: false })]) },
    { name: "an excluded account", diff: ahead([signed(alice)]), exclude: ["alice"] },
    { name: "a rebase or force push (the compare is not a clean 'ahead')", diff: ahead([signed(alice)], { status: "diverged" }) },
    { name: "a compare cut short", diff: ahead([signed(alice)], { truncated: true }) },
    { name: "no such compare", diff: undefined },
    { name: "an identical compare", diff: ahead([], { status: "identical", files: [] }) },
    { name: "a compare with no changed files", diff: ahead([signed(alice)], { files: [] }) },
    { name: "the capture is off for the repository", diff: ahead([signed(alice)]), configured: false },
  ];
  for (const c of skips) {
    it(`${c.name}: skipped, the extractor is not called, and the comment-only reflection is`, async () => {
      const r = await run(c);
      expect(r.outcome).toBe("skipped");
      expect(r.extracted).toEqual([]);
      expect(r.fallback).toEqual([{ workspaceId: WS, project: "shop", taskId: "task-1", link: job.pullRequest.url }]);
    });
  }

  it("control: a usable edit is handed to the extractor (which runs the reflection with the edit), and the fallback is not taken", async () => {
    const r = await run({ name: "ok", diff: ahead([signed(alice)]) });
    expect(r.outcome).toBe("handed_on");
    expect(r.extracted).toHaveLength(1);
    expect(r.fallback).toEqual([]);
  });

  it("a claim already taken means another run owns the edit: no fallback", async () => {
    const r = await run({ name: "claimed", diff: ahead([signed(alice)]), claimTaken: true });
    expect(r.outcome).toBe("skipped");
    expect(r.fallback).toEqual([]);
  });

  it("an extractor that fails is retried as a whole: no fallback is taken on the failure", async () => {
    const w = world();
    w.config.set("github", repoScope(repo), { retention: "D" });
    w.actors.members.set("1001", "dev-alice");
    const fallback: unknown[] = [];
    await expect(runHumanEdit({
      actors: w.actors, mode: w.mode, config: w.config, pushes: w.pushes, diffs: { compare: async () => ahead([signed(alice)]) },
      extractor: { extract: async () => { throw new Error("model down"); }, commentsOnly: async (input: Fallback) => { fallback.push(input); } },
    }, job)).rejects.toThrow();
    expect(fallback).toEqual([]);
  });

  it("an extractor with no fallback (an older one) is simply skipped as before", async () => {
    const w = world();
    w.config.set("github", repoScope(repo), { retention: "D" });
    expect(await runHumanEdit({ actors: w.actors, mode: w.mode, config: w.config, pushes: w.pushes, diffs: { compare: async () => undefined }, extractor: { extract: async () => ({ candidates: 0 }) } }, job)).toBe("skipped");
  });
});
void AT;
