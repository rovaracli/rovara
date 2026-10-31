// LR-W1: the revert row names who reverted, so the learning side can tell a third party's revert (a measured outcome) from the task starter's own.
import { describe, expect, it } from "vitest";
import { createCodeHostTap, repoScope, type CodeHostEvent, type CodeHostRepo } from "../../packages/broker/src/team-record/sources/codehost.js";
import { sha, world, WS } from "../support/team-record-ingest-fakes.js";

const repo = (over: Partial<CodeHostRepo> = {}): CodeHostRepo => ({ host: "github", id: "77", fullName: "acme/shop", isPrivate: true, defaultBranch: "main", workspaceId: WS, project: "shop", ...over });
const AT = "2026-10-30T10:00:00.000Z";
const rovaraPr = { taskId: "task-1", project: "shop", number: 5, url: "https://github.com/acme/shop/pull/5", candidateHeadSha: sha(20), mergeCommitSha: sha(30) };
const revertPr = (author: { id: string; login: string; isBot: boolean }, over: Partial<Extract<CodeHostEvent, { type: "pr" }>> = {}): CodeHostEvent => ({
  type: "pr", repo: repo(), number: 9, url: "https://github.com/acme/shop/pull/9", action: "closed", merged: true, title: 'Revert "Fix cart total"', body: "Reverts acme/shop#5",
  author, headSha: sha(11), baseRef: "main", mergeCommitSha: sha(41), at: AT, version: "closed:9", ...over,
});

function setup(exclude: string[] = []) {
  const w = world();
  w.config.set("github", repoScope(repo()), { retention: "D", exclude });
  w.actors.members.set("1001", "dev-alice");
  w.prs.list.push(rovaraPr);
  const tap = createCodeHostTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config });
  return { w, tap };
}
const revertRow = (w: ReturnType<typeof setup>["w"]) => w.sink.puts.find((draft) => draft.kind === "github.revert")!;

describe("the revert row's actor", () => {
  it("a merged revert pull request by a member carries that member as the row's actor, never in a structured field", async () => {
    const { w, tap } = setup();
    await tap.handle(revertPr({ id: "1001", login: "alice", isBot: false }));
    expect(revertRow(w).actor).toMatchObject({ sourceId: "1001", developerId: "dev-alice", trust: "member" });
    expect(JSON.stringify(revertRow(w).structured)).not.toContain("dev-alice");
    expect(JSON.stringify(revertRow(w).structured)).not.toContain("1001");
  });
  it("a revert commit pushed by a member names the pusher", async () => {
    const { w, tap } = setup();
    await tap.handle({ type: "push", repo: repo(), ref: "refs/heads/main", at: AT, sender: { id: "1001", login: "alice", isBot: false }, commits: [{ sha: sha(40), message: `Revert "Fix cart total"\n\nThis reverts commit ${sha(30)}.` }] });
    expect(revertRow(w).actor).toMatchObject({ developerId: "dev-alice" });
  });
  it("a bot, an unknown account, an excluded account and a push with no sender leave the revert without a person (and the revert is still recorded)", async () => {
    for (const author of [{ id: "5", login: "revert-bot[bot]", isBot: true }, { id: "9999", login: "mallory", isBot: false }]) {
      const { w, tap } = setup();
      await tap.handle(revertPr(author));
      expect(revertRow(w)).toBeDefined();
      expect(revertRow(w).actor?.developerId).toBeUndefined();
    }
    // An excluded account's own pull request is not recorded at all; an excluded account that PUSHES a revert is recorded as a revert without a person.
    const excluded = setup(["1001"]);
    await excluded.tap.handle({ type: "push", repo: repo(), ref: "refs/heads/main", at: AT, sender: { id: "1001", login: "alice", isBot: false }, commits: [{ sha: sha(40), message: `This reverts commit ${sha(30)}.` }] });
    expect(revertRow(excluded.w)).toBeDefined();
    expect(revertRow(excluded.w).actor).toBeUndefined();
    const { w, tap } = setup();
    await tap.handle({ type: "push", repo: repo(), ref: "refs/heads/main", at: AT, commits: [{ sha: sha(40), message: `This reverts commit ${sha(30)}.` }] });
    expect(revertRow(w).actor).toBeUndefined();
  });
});
