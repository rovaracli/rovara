// LR-W1 and review items 6 and 7: a revert's OUTCOME is task data and never names a person; who reverted rides on a separate person-link row (`rovara.reverted_by`) that an erase
// deletes. Only a member counts as the reverter. An erased, unknown, outsider, bot or excluded reverter, or a resolver that fails, still records the anonymous outcome.
import { describe, expect, it } from "vitest";
import { createCodeHostTap, repoScope, type CodeHostEvent, type CodeHostRepo } from "../../packages/broker/src/team-record/sources/codehost.js";
import { erasePerson } from "../../packages/broker/src/team-record/erase.js";
import { markPersonErased } from "../../packages/broker/src/team-record/erased.js";
import { ORG_A, addSource, rows, world as coreWorld } from "../support/team-record-core.js";
import { deleteDeps } from "../support/team-record-delete.js";
import { sha, world, WS } from "../support/team-record-ingest-fakes.js";

const repo = (over: Partial<CodeHostRepo> = {}): CodeHostRepo => ({ host: "github", id: "77", fullName: "acme/shop", isPrivate: true, defaultBranch: "main", workspaceId: WS, project: "shop", ...over });
const AT = "2026-10-30T10:00:00.000Z";
const rovaraPr = { taskId: "task-1", project: "shop", number: 5, url: "https://github.com/acme/shop/pull/5", candidateHeadSha: sha(20), mergeCommitSha: sha(30) };
const revertPr = (author: { id: string; login: string; isBot: boolean }, over: Partial<Extract<CodeHostEvent, { type: "pr" }>> = {}): CodeHostEvent => ({
  type: "pr", repo: repo(), number: 9, url: "https://github.com/acme/shop/pull/9", action: "closed", merged: true, title: 'Revert "Fix cart total"', body: "Reverts acme/shop#5",
  author, headSha: sha(11), baseRef: "main", mergeCommitSha: sha(41), at: AT, version: "closed:9", ...over,
});
const push = (sender?: { id: string; login: string; isBot: boolean }): CodeHostEvent => ({ type: "push", repo: repo(), ref: "refs/heads/main", at: AT, before: sha(39), after: sha(40), ...(sender === undefined ? {} : { sender }), commits: [{ sha: sha(40), message: `Revert "Fix cart total"\n\nThis reverts commit ${sha(30)}.` }] });
const alice = { id: "1001", login: "alice", isBot: false };
// SRL-3 (controller ee): a revert told only by a pushed commit's message counts only when the host's compare shows that commit non-merge, verified and a live member's own.
const verifiedRange = { compare: async () => ({ status: "ahead" as const, truncated: false, files: [], commits: [{ sha: sha(40), author: alice, committer: alice, verified: true }] }) };

function setup(exclude: string[] = []) {
  const w = world();
  w.config.set("github", repoScope(repo()), { retention: "D", exclude });
  w.actors.members.set("1001", "dev-alice");
  w.prs.list.push(rovaraPr);
  const tap = createCodeHostTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config, diffs: verifiedRange });
  return { w, tap };
}
const kinds = (w: ReturnType<typeof setup>["w"]) => w.sink.kinds().filter((kind) => kind !== "github.pr"); // (a revert pull request is also recorded as a pull request)
const rowOf = (w: ReturnType<typeof setup>["w"], kind: string) => w.sink.puts.find((draft) => draft.kind === kind);

describe("the revert's outcome rows carry no person", () => {
  it("a revert by a member: both outcome rows are anonymous and the member rides only on the person-link row", async () => {
    const { w, tap } = setup();
    await tap.handle(revertPr(alice));
    expect(kinds(w)).toEqual(expect.arrayContaining(["github.revert", "rovara.closed", "rovara.reverted_by"]));
    expect(rowOf(w, "github.revert")!.actor).toBeUndefined();
    expect(rowOf(w, "rovara.closed")!.actor).toBeUndefined();
    const link = rowOf(w, "rovara.reverted_by")!;
    expect(link.actor).toMatchObject({ developerId: "dev-alice", trust: "member" });
    expect(link.sourceRef.id).toBe("task:task-1:reverted_by");
    for (const kind of ["github.revert", "rovara.closed", "rovara.reverted_by"]) expect(JSON.stringify(rowOf(w, kind)!.structured)).not.toMatch(/dev-alice|1001/u);
  });
  it("a revert commit pushed by a member names the commit's author on the link row too", async () => {
    const { w, tap } = setup();
    await tap.handle(push(alice));
    expect(rowOf(w, "rovara.reverted_by")!.actor).toMatchObject({ developerId: "dev-alice" });
  });
});

describe("only a member counts as the reverter; the anonymous outcome is recorded either way (revert pull requests)", () => {
  const outcomeOnly = (w: ReturnType<typeof setup>["w"]) => { expect(kinds(w)).toEqual(["github.revert", "rovara.closed"]); expect(rowOf(w, "rovara.closed")!.structured).toMatchObject({ outcome: "reverted", taskId: "task-1" }); };
  it("a bot and an unknown account that opened the revert pull request", async () => {
    for (const author of [{ id: "5", login: "revert-bot[bot]", isBot: true }, { id: "9999", login: "mallory", isBot: false }]) {
      const { w, tap } = setup();
      await tap.handle(revertPr(author));
      outcomeOnly(w);
    }
  });
  it("an account the resolver calls an outsider, even if it knows a developer id for it", async () => {
    const { w, tap } = setup();
    (w.actors as unknown as { resolve: () => Promise<unknown> }).resolve = async () => ({ developerId: "dev-ext", trust: "outsider" });
    await tap.handle(revertPr(alice));
    outcomeOnly(w);
  });
  it("a resolver that fails", async () => {
    // A pushed commit's words count only when its author and pusher are proved members: a resolver that fails proves nothing, so nothing is recorded (and nothing fails).
    const pushed = setup();
    (pushed.w.actors as unknown as { resolve: () => Promise<unknown> }).resolve = async () => { throw new Error("identity service down"); };
    expect((await pushed.tap.handle(push(alice))).failed).toBe(0);
    expect(kinds(pushed.w)).toEqual([]);
  });
  it("an excluded account that pushes a revert commit records nothing at all", async () => {
    const { w, tap } = setup(["1001"]);
    await tap.handle(push(alice));
    expect(kinds(w)).toEqual([]);
  });
  it("a push with no sender records nothing at all", async () => {
    const { w, tap } = setup();
    await tap.handle(push());
    expect(kinds(w)).toEqual([]);
  });
});

describe("a revert told by a commit message counts only when a member wrote and pushed it (nothing is recorded otherwise)", () => {
  it("a push with no sender, an excluded account, and a resolver that fails record nothing, and fail nothing", async () => {
    const none = setup();
    await none.tap.handle(push());
    expect(kinds(none.w)).toEqual([]);
    const excluded = setup(["1001"]);
    await excluded.tap.handle(push(alice));
    expect(kinds(excluded.w)).toEqual([]);
    const broken = setup();
    (broken.w.actors as unknown as { resolve: () => Promise<unknown> }).resolve = async () => { throw new Error("identity service down"); };
    const result = await broken.tap.handle(push(alice));
    expect(kinds(broken.w)).toEqual([]);
    expect(result.failed).toBe(0);
  });
});

describe("erasure and the revert (real record core)", () => {
  function realTap() {
    const core = coreWorld({ rovaraDefaultRetention: "D" }); // (Rovara's own rows take the code host's retention here)
    const fakes = world();
    const rrepo = repo({ workspaceId: ORG_A });
    fakes.config.set("github", repoScope(rrepo), { retention: "D" });
    fakes.actors.members.set("1001", "dev-alice");
    fakes.prs.list.push(rovaraPr);
    const tap = createCodeHostTap({ sink: core.sink, actors: fakes.actors, rovaraPrs: fakes.prs, mode: fakes.mode, config: fakes.config, diffs: verifiedRange });
    return { core, tap, rrepo };
  }
  const event = (rrepo: CodeHostRepo): CodeHostEvent => ({ ...(push(alice) as Extract<CodeHostEvent, { type: "push" }>), repo: rrepo });
  const kindsOf = (core: ReturnType<typeof coreWorld>) => rows(core, "TEAM_RECORD_EVENT").map((row) => row.kind as string).sort();

  it("a revert by an already-erased person still records the anonymous outcome, never actor_erased", async () => {
    const { core, tap, rrepo } = realTap();
    await addSource(core, { source: "github", scope: repoScope(rrepo), project: "shop" });
    await markPersonErased(core.table, ORG_A, { developerId: "dev-alice" }, AT);
    const result = await tap.handle(event(rrepo));
    expect(kindsOf(core)).toEqual(["github.revert", "rovara.closed"]);
    expect(rows(core, "TEAM_RECORD_EVENT").every((row) => row.actor === undefined)).toBe(true);
    expect(result.refused).toBe(1); // only the person-link row was refused
  });
  it("erasing the reverter deletes the person-link row and leaves the task's outcome", async () => {
    const { core, tap, rrepo } = realTap();
    await addSource(core, { source: "github", scope: repoScope(rrepo), project: "shop" });
    await tap.handle(event(rrepo));
    expect(kindsOf(core)).toEqual(["github.revert", "rovara.closed", "rovara.reverted_by"]);
    const done = await erasePerson(deleteDeps(core).deps, ORG_A, { developerId: "dev-alice", projects: ["shop"] }, "e-rev");
    expect(done.complete).toBe(true);
    expect(kindsOf(core)).toEqual(["github.revert", "rovara.closed"]);
    expect(JSON.stringify(core.db.find((item) => !String(item.sk).startsWith("ERASESWEEP#")))).not.toContain("dev-alice");
  });
});
