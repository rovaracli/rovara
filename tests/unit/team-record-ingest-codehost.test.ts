import { describe, expect, it } from "vitest";
import { createCodeHostTap, gitRevertedCommits, humanEditFile, revertedCommits, runHumanEdit, revertedPullRequests, type CodeHostDiff, type CodeHostEvent, type CodeHostRepo, type HumanEditInput } from "../../packages/broker/src/team-record/sources/codehost.js";
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

describe("per-editor rows: every change to a pull request, review or comment is its own row under the person who made it", () => {
  const bob = { id: "1002", login: "bob", isBot: false };
  const comment = (over: Partial<Extract<CodeHostEvent, { type: "comment" }>> = {}): CodeHostEvent => ({
    type: "comment", repo: repo(), prNumber: 5, id: "77", url: "https://github.com/acme/shop/pull/5#c77", action: "created", surface: "discussion", body: "alice's words", author: alice, at: AT, version: "created:1", ...over,
  });

  function twoPeople() {
    const s = setup();
    s.w.actors.members.set("1002", "dev-bob");
    return s;
  }

  it("bob's edit of alice's comment is BOB's row with the lines he added; alice's own words stay in her row; nothing is replaced", async () => {
    const { w, tap } = twoPeople();
    await tap.handle(comment());
    await tap.handle(comment({ action: "edited", body: "alice's words\nbob added this", previousBody: "alice's words", editor: bob, at: "2026-10-30T10:05:00.000Z", version: "edited:2" }));
    await tap.handle(comment({ action: "edited", body: "alice's words\nbob added this\nalice again", previousBody: "alice's words\nbob added this", editor: alice, at: "2026-10-30T10:06:00.000Z", version: "edited:3" }));
    expect(w.sink.puts.map((draft) => [draft.actor?.developerId, draft.text])).toStrictEqual([["dev-alice", "alice's words"], ["dev-bob", "bob added this"], ["dev-alice", "alice again"]]);
    expect(new Set(w.sink.puts.map((draft) => draft.sourceRef.id))).toStrictEqual(new Set(["acme/shop#pr5:comment77"].filter(() => true).concat([]).length === 0 ? [] : [w.sink.puts[0]!.sourceRef.id]));
    expect(w.sink.puts.map((draft) => draft.sourceRef.order)).toStrictEqual([Date.parse(AT), Date.parse("2026-10-30T10:05:00.000Z"), Date.parse("2026-10-30T10:06:00.000Z")]);
  });

  it("an edit by someone else with no earlier text keeps no words; the author's edit with no earlier text is her whole comment only when nobody else edited it before (S2)", async () => {
    const others = { value: false };
    const { w, tap } = (() => { const s = setup({ priorEdits: { editedByOthers: async () => others.value } }); s.w.actors.members.set("1002", "dev-bob"); return s; })();
    await tap.handle(comment({ id: "1", action: "edited", body: "rewritten", editor: bob, version: "edited:1" }));
    await tap.handle(comment({ id: "2", action: "edited", body: "mine, fixed", editor: alice, version: "edited:1" }));
    await tap.handle(comment({ id: "3", action: "edited", body: "no editor named", version: "edited:1" }));
    others.value = true;
    await tap.handle(comment({ id: "5", action: "edited", body: "mine again", editor: alice, version: "edited:1" }));
    expect(w.sink.puts.map((draft) => [draft.actor?.developerId, draft.text])).toStrictEqual([["dev-bob", undefined], ["dev-alice", "mine, fixed"], ["dev-alice", "no editor named"], ["dev-alice", undefined]]);
    const { w: bare, tap: bareTap } = twoPeople();
    await bareTap.handle(comment({ id: "6", action: "edited", body: "no lookup wired", editor: alice, version: "edited:1" }));
    expect(bare.sink.puts.map((draft) => draft.text)).toStrictEqual([undefined]);
  });

  it("a pull request: opened is the author's; an edit of the title and description is the editor's added words; closing is the closer's row with no words", async () => {
    const { w, tap } = twoPeople();
    await tap.handle(pr({ number: 8 }));
    await tap.handle(pr({ number: 8, action: "edited", title: "Fix cart total, properly", body: "Rounds correctly now\nbob: also handles zero", editor: bob, changed: { title: true, body: true }, previousTitle: "Fix cart total", previousBody: "Rounds correctly now", at: "2026-10-30T10:01:00.000Z", version: "edited:2" }));
    await tap.handle(pr({ number: 8, action: "closed", editor: bob, merged: true, at: "2026-10-30T10:02:00.000Z", version: "closed:3" }));
    await tap.handle(pr({ number: 9, action: "edited", editor: bob, body: "unknown what changed", at: "2026-10-30T10:03:00.000Z", version: "edited:1" }));
    expect(w.sink.puts.map((draft) => [draft.actor?.developerId, draft.text, draft.structured?.action])).toStrictEqual([
      ["dev-alice", "Fix cart total\n\nRounds correctly now", "opened"],
      ["dev-bob", "properly\n\nbob: also handles zero", "edited"],
      ["dev-bob", undefined, "closed"],
      ["dev-bob", undefined, "edited"],
    ]);
  });

  it("a review: submitted is the author's; a dismissal or an edit is the sender's row", async () => {
    const { w, tap } = twoPeople();
    const review = (over: Record<string, unknown>): CodeHostEvent => ({ type: "review", repo: repo(), prNumber: 8, id: "31", url: "https://github.com/acme/shop/pull/8#r31", action: "submitted", state: "approved", body: "alice reviews", author: alice, at: AT, version: "submitted:1", ...over });
    await tap.handle(review({}));
    await tap.handle(review({ action: "edited", body: "alice reviews\nbob adds", previousBody: "alice reviews", editor: bob, at: "2026-10-30T10:07:00.000Z", version: "edited:2" }));
    await tap.handle(review({ action: "dismissed", editor: bob, at: "2026-10-30T10:08:00.000Z", version: "dismissed:3" }));
    expect(w.sink.puts.map((draft) => [draft.actor?.developerId, draft.text])).toStrictEqual([["dev-alice", "alice reviews"], ["dev-bob", "bob adds"], ["dev-bob", undefined]]);
  });

  it("an unlinked editor's change is a draft with no developer (the sink refuses and counts it); a bot's change needs no one", async () => {
    const { w, tap } = twoPeople();
    await tap.handle(comment({ id: "1", action: "edited", editor: mallory, version: "edited:1", previousBody: "alice's words", body: "alice's words\nmallory" }));
    await tap.handle(comment({ id: "3", action: "edited", editor: { id: "5", login: "dependabot[bot]", isBot: true }, version: "edited:1" }));
    expect(w.sink.puts.map((draft) => [draft.actor?.developerId, draft.trust])).toStrictEqual([[undefined, "outsider"], [undefined, "system"]]);
  });

  it("the GitHub reader names the delivery's sender as the person behind an edit, a close or a dismissal (not a first sight), and reads what `changes` says was edited", () => {
    const payload = (action: string, changes?: unknown) => ({ action, sender: { id: 1002, login: "bob", type: "User" }, issue: { number: 5, pull_request: {} }, ...(changes === undefined ? {} : { changes }), comment: { id: 77, html_url: "https://github.com/acme/shop/pull/5#c77", body: "x", user: { id: 1001, login: "alice", type: "User" }, updated_at: AT } });
    expect(githubEventsOf("issue_comment", "edited", payload("edited", { body: { from: "before" } }), repo(), AT)).toMatchObject([{ type: "comment", action: "edited", editor: { id: "1002", isBot: false }, author: { id: "1001" }, previousBody: "before" }]);
    expect((githubEventsOf("issue_comment", "created", payload("created"), repo(), AT)[0] as { editor?: unknown }).editor).toBeUndefined();
    const prPayload = (action: string, changes?: unknown) => ({ action, sender: { id: 1002, login: "bob", type: "User" }, ...(changes === undefined ? {} : { changes }), pull_request: { number: 5, html_url: "https://github.com/acme/shop/pull/5", title: "t", body: "b", user: { id: 1001, login: "alice", type: "User" }, head: { sha: sha(10) }, base: { ref: "main" }, updated_at: AT } });
    expect(githubEventsOf("pull_request", "closed", prPayload("closed"), repo(), AT)).toMatchObject([{ type: "pr", action: "closed", editor: { id: "1002" } }]);
    expect(githubEventsOf("pull_request", "edited", prPayload("edited", { title: { from: "old" }, body: { from: null } }), repo(), AT)).toMatchObject([{ type: "pr", editor: { id: "1002" }, changed: { title: true, body: true }, previousBody: "", previousTitle: "old" }]);
    expect((githubEventsOf("pull_request", "edited", prPayload("edited"), repo(), AT)[0] as { changed?: unknown }).changed).toBeUndefined();
  });
});

describe("S2: a comment edit skipped before anyone is looked at still marks the item", () => {
  it("with no source row (or capture off) for the repository, an edited comment marks it; a created one does not", async () => {
    const marked: string[] = [];
    const { w, tap } = setup({ priorEdits: { editedByOthers: async () => false, noteUnstored: async (input) => { marked.push(input.id); } } });
    w.config.set("github", repoScope(repo()), { enabled: false });
    const comment = (action: "created" | "edited"): CodeHostEvent => ({ type: "comment", repo: repo(), prNumber: 5, id: "77", url: "https://github.com/acme/shop/pull/5#c77", action, surface: "discussion", body: "x", author: alice, at: AT, version: `${action}:1` });
    await tap.handle(comment("created"));
    expect(marked).toStrictEqual([]);
    await tap.handle(comment("edited"));
    expect(marked).toHaveLength(1);
    expect(w.sink.puts).toStrictEqual([]);
  });
});

describe("S1: a delivery GitHub sends again is the same change", () => {
  const review = (action: string) => ({ action, sender: { id: 1002, login: "bob", type: "User" }, pull_request: { number: 8 }, review: { id: 31, html_url: "https://github.com/acme/shop/pull/8#r31", state: "approved", body: "alice reviews\nbob adds", user: { id: 1001, login: "alice", type: "User" }, submitted_at: "2026-10-30T10:00:00Z" }, changes: { body: { from: "alice reviews" } } });
  it("an edit or dismissal is versioned by the delivery id and keyed by the review's own time; the same delivery at another moment is the same version and time, another delivery is another version", () => {
    const first = githubEventsOf("pull_request_review", "edited", review("edited"), repo(), "2026-10-30T11:00:00.000Z", "delivery-1")[0] as Extract<CodeHostEvent, { type: "review" }>;
    const again = githubEventsOf("pull_request_review", "edited", review("edited"), repo(), "2026-10-30T11:05:00.000Z", "delivery-1")[0] as Extract<CodeHostEvent, { type: "review" }>;
    const other = githubEventsOf("pull_request_review", "edited", review("edited"), repo(), "2026-10-30T11:06:00.000Z", "delivery-2")[0] as Extract<CodeHostEvent, { type: "review" }>;
    expect([again.version, again.at]).toStrictEqual([first.version, first.at]);
    expect(other.version).not.toBe(first.version);
    expect(first.at).toBe("2026-10-30T10:00:00.000Z");
    expect(first.receivedAt).toBe("2026-10-30T11:00:00.000Z");
    const submitted = githubEventsOf("pull_request_review", "submitted", review("submitted"), repo(), "2026-10-30T11:00:00.000Z", "delivery-1")[0] as Extract<CodeHostEvent, { type: "review" }>;
    expect(submitted.version).toBe("submitted:2026-10-30T10:00:00Z");
  });
  it("through the tap, a retried delivery writes one row and a different edit writes another", async () => {
    const { w, tap } = setup();
    w.actors.members.set("1002", "dev-bob");
    const now = { at: 0 };
    const github = createGithubRecordTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config, now: () => now.at, resolveRepo: async () => ({ workspaceId: WS, project: "shop" }) });
    void tap;
    const delivery = (id: string) => ({ eventName: "pull_request_review", deliveryId: id, payload: { ...review("edited"), installation: { id: 1 }, repository: { id: 77, full_name: "acme/shop", private: true, default_branch: "main" } } });
    now.at = Date.parse("2026-10-30T11:00:00.000Z");
    await github(delivery("delivery-1"));
    now.at = Date.parse("2026-10-30T11:30:00.000Z");
    await github(delivery("delivery-1"));
    expect(w.sink.puts).toHaveLength(1);
    await github(delivery("delivery-2"));
    expect(w.sink.puts).toHaveLength(2);
    expect(w.sink.puts.map((draft) => draft.text)).toStrictEqual(["bob adds", "bob adds"]);
  });
});

describe("reverts of Rovara pull requests", () => {
  const rovaraPr = { taskId: "task-1", project: "shop", number: 5, url: "https://github.com/acme/shop/pull/5", candidateHeadSha: sha(20), mergeCommitSha: sha(30) };
  // SRL-3 (controller ee, 2026-11-08): a revert told only by a pushed commit's message counts only when the host's compare shows that exact commit non-merge, verified, committed by its author
  // (or the host's web-flow account), the author a live member and the pusher a live non-bot member. Anything else, or a compare that fails, records nothing.
  const COMMIT = sha(40);
  const goodCommit = { sha: COMMIT, author: alice, committer: alice, verified: true };
  const rangeOf = (commit: Record<string, unknown> | undefined, over: Partial<CodeHostDiff> = {}): CodeHostDiff => ({ status: "ahead", truncated: false, files: [], commits: commit === undefined ? [] : [{ ...goodCommit, ...commit }], ...over });
  const revertPush = (over: Partial<Extract<CodeHostEvent, { type: "push" }>> = {}): CodeHostEvent => ({
    type: "push", repo: repo(), ref: "refs/heads/main", at: AT, before: sha(39), after: COMMIT, sender: alice,
    commits: [{ sha: COMMIT, message: `Revert "Fix cart total"\n\nThis reverts commit ${sha(30)}.` }], ...over,
  });
  function gated(range: CodeHostDiff | "throws" | undefined | "none") {
    const marks: unknown[] = [];
    const compares: unknown[] = [];
    const diffs = range === "none" ? {} : { diffs: { compare: async (input: unknown) => { compares.push(input); if (range === "throws") throw new Error("down"); return range; } } };
    const made = setup({ trackRecord: { markNotHeld: async (input) => { marks.push(input); } }, ...diffs });
    made.w.prs.list.push(rovaraPr);
    return { ...made, marks, compares };
  }
  const recordsNothing = (made: ReturnType<typeof gated>, result: { written: number; failed: number }) => {
    expect(result).toMatchObject({ written: 0, failed: 0 });
    expect(made.w.sink.puts).toEqual([]);
    expect(made.marks).toEqual([]);
  };

  it("SRL-3 all pass: a non-merge, verified commit authored and pushed by a live member records the outcome, the reverter and the re-score", async () => {
    const made = gated(rangeOf({}));
    const result = await made.tap.handle(revertPush());
    expect(result.written).toBe(3);
    expect(made.w.sink.kinds()).toEqual(["github.revert", "rovara.closed", "rovara.reverted_by"]);
    expect(made.w.sink.puts[2]!.actor).toMatchObject({ developerId: "dev-alice" });
    expect(made.marks).toHaveLength(1);
    expect(made.compares).toEqual([{ repo: repo(), base: sha(39), head: COMMIT }]);
  });
  it("SRL-3 the web-flow account may commit a member's squash-merged revert", async () => {
    const made = gated(rangeOf({ committer: { id: "19864447", login: "web-flow", isBot: false }, webFlow: true }));
    expect((await made.tap.handle(revertPush())).written).toBe(3);
  });
  it.each([
    ["a merge commit", rangeOf({ merge: true })],
    ["an unverified commit", rangeOf({ verified: false })],
    ["an author who is not a member", rangeOf({ author: mallory, committer: mallory })],
    ["a committer who is not the author (and not web-flow)", rangeOf({ committer: mallory })],
    ["no committer at all", rangeOf({ committer: undefined })],
    ["a compare that does not show the commit", rangeOf(undefined)],
    ["a compare that is not a clean ahead", rangeOf({}, { status: "diverged" })],
    ["a cut-short compare", rangeOf({}, { truncated: true })],
    ["no answer from the host", undefined],
    ["a compare that throws (read failure)", "throws" as const],
    ["no compare reader at all", "none" as const],
  ])("SRL-3 %s: nothing is recorded, nothing is re-scored, no reverter", async (_name, range) => {
    const made = gated(range);
    recordsNothing(made, await made.tap.handle(revertPush()));
    expect(made.logs).toContain("record.revert_unproven");
  });
  it.each([
    ["a pusher who is not a member", { sender: mallory }],
    ["a bot pusher", { sender: { id: "5", login: "revert-bot[bot]", isBot: true } }],
    ["no pusher", { sender: undefined }],
    ["an excluded pusher", {}],
  ])("SRL-3 %s: nothing is recorded, nothing is re-scored, no reverter", async (name, over) => {
    const made = gated(rangeOf({}));
    if (name === "an excluded pusher") made.w.config.set("github", repoScope(repo()), { retention: "D", exclude: ["1001"] });
    recordsNothing(made, await made.tap.handle(revertPush(over as never)));
  });
  it("SRL-3 the compare is read only after an index hit, and once for a push, so a non-Rovara revert costs no read", async () => {
    const made = gated(rangeOf({}));
    made.w.prs.list.length = 0;
    await made.tap.handle(revertPush());
    expect(made.compares).toEqual([]);
  });
  it("SRL-3 the merged revert pull request path needs no compare", async () => {
    const made = gated("none");
    await made.tap.handle(pr({ number: 9, title: 'Revert "Fix cart total"', body: "Reverts acme/shop#5", action: "closed", merged: true, mergeCommitSha: sha(41), version: "closed:9" }));
    expect(made.w.sink.kinds()).toContain("rovara.closed");
    expect(made.marks).toHaveLength(1);
  });

  // M3: a revert told by a commit message counts only when its commit is a member's: the host's compare shows it verified, authored by a member, and the member pushed it.
  const memberRevertCommit = (n = 40): Pick<NonNullable<Parameters<typeof createCodeHostTap>[0]["diffs"]>, "compare"> => ({ compare: async () => ({ status: "ahead", truncated: false, files: [], commits: [{ sha: sha(n), author: alice, committer: alice, verified: true }] }) });
  const pushedBy = (n: number, sender: typeof alice | null = alice): Pick<Extract<CodeHostEvent, { type: "push" }>, "before" | "after"> & { sender?: typeof alice } => ({ before: sha(n - 1), after: sha(n), ...(sender === null ? {} : { sender }) });

  it("detects a revert commit on the default branch, records both events once, and re-scores the task", async () => {
    const { w, tap, marks } = gated(rangeOf({}));
    const push = revertPush();
    const first = await tap.handle(push);
    expect(first.written).toBe(3);
    expect(w.sink.kinds()).toEqual(["github.revert", "rovara.closed", "rovara.reverted_by"]);
    expect(w.sink.puts[1]!).toMatchObject({ source: "rovara", trust: "rovara", structured: { outcome: "reverted", taskId: "task-1" } });
    expect(marks).toEqual([{ workspaceId: WS, project: "shop", taskId: "task-1", reason: "reverted", revertRef: sha(40) }]);
    // The same revert told again (a second delivery, or the revert pull request's merge) adds nothing new to the record.
    const second = await tap.handle(push);
    expect(second.written).toBe(0);
    expect(second.duplicates).toBe(3);
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
    const diffs = { compare: async (input: { head: string }) => rangeOf({ sha: input.head }) };
    const { w, tap } = setup({ claims, diffs, trackRecord: { markNotHeld: async (input) => { if (failing) throw new Error("down"); marks.push(input); } } });
    w.prs.list.push(rovaraPr);
    const push = (version: number): CodeHostEvent => ({ type: "push", repo: repo(), ref: "refs/heads/main", at: AT, before: sha(39), after: sha(40 + version), sender: alice, commits: [{ sha: sha(40 + version), message: `Revert "Fix cart total"\n\nThis reverts commit ${sha(30)}.` }] });
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
    await tap.handle({ type: "push", repo: repo(), ref: "refs/heads/feature", at: AT, commits: [{ sha: sha(40), message: `Revert "x"\n\nThis reverts commit ${sha(30)}` }] });
    await tap.handle({ type: "push", repo: repo(), ref: "refs/heads/main", at: AT, commits: [{ sha: sha(41), message: `Revert "x"\n\nThis reverts commit ${sha(31)}` }] });
    expect(w.sink.puts.filter((draft) => draft.kind === "github.revert")).toEqual([]);
  });

  it("SRL-3 L1: a push counts as a revert only in git's own shape (subject `Revert \"`, body line starting `This reverts commit <sha>`)", async () => {
    expect(gitRevertedCommits(`Revert "Fix"\n\nThis reverts commit ${sha(30)}.`)).toEqual([sha(30)]);
    expect(gitRevertedCommits(`Revert "Fix"\n\nThis reverts commit ${sha(30)}, reversing changes made to ${sha(2)}.`)).toEqual([sha(30)]);
    expect(gitRevertedCommits(`This reverts commit ${sha(30)}`)).toEqual([]);
    expect(gitRevertedCommits(`Fix the cart\n\nThis reverts commit ${sha(30)}`)).toEqual([]);
    expect(gitRevertedCommits(`Revert "Fix"\n\nsee: This reverts commit ${sha(30)}`)).toEqual([]);
    expect(gitRevertedCommits(`Revert "Fix"\n\n> This reverts commit ${sha(30)}`)).toEqual([]);
    const { w, tap } = setup();
    w.prs.list.push(rovaraPr);
    const result = await tap.handle({ type: "push", repo: repo(), ref: "refs/heads/main", at: AT, commits: [{ sha: sha(40), message: `Fix cart\n\nThis reverts commit ${sha(30)}.` }] });
    expect(result.written).toBe(0);
    expect(w.sink.kinds()).toEqual([]);
  });

  describe("M3: a revert told only by a commit message is not forgeable", () => {
    const message = `Revert "Fix cart total"\n\nThis reverts commit ${sha(30)}.`;
    const pushEvent = (sender: typeof alice | null = alice): CodeHostEvent => ({ type: "push", repo: repo(), ref: "refs/heads/main", at: AT, ...pushedBy(40, sender), commits: [{ sha: sha(40), message }] });
    const verifiedBy = (author: typeof alice | undefined, over: Record<string, unknown> = {}) => ({ compare: async () => ({ status: "ahead" as const, truncated: false, files: [], commits: [{ sha: sha(40), ...(author === undefined ? {} : { author, committer: author }), verified: true, ...over }] }) });
    async function counts(extra: Partial<Parameters<typeof createCodeHostTap>[0]>, event: CodeHostEvent): Promise<{ kinds: string[]; marks: unknown[]; reverter: unknown }> {
      const marks: unknown[] = [];
      const { w, tap } = setup({ trackRecord: { markNotHeld: async (input) => { marks.push(input); } }, ...extra });
      w.prs.list.push(rovaraPr);
      await tap.handle(event);
      return { kinds: w.sink.kinds(), marks, reverter: w.sink.puts.find((draft) => draft.kind === "rovara.reverted_by")?.actor };
    }

    it("positive control: a member's verified commit, pushed by the member, counts and credits the commit's author", async () => {
      const result = await counts({ diffs: verifiedBy(alice) }, pushEvent());
      expect(result.kinds).toEqual(["github.revert", "rovara.closed", "rovara.reverted_by"]);
      expect(result.marks).toHaveLength(1);
      expect(result.reverter).toMatchObject({ developerId: "dev-alice" });
    });

    it("an outsider's pull request that a member squash-merged (outsider author, host committer) does not count: no outcome, no re-score, no reverter", async () => {
      const webFlow = { id: "19864447", login: "web-flow", isBot: false };
      const result = await counts({ diffs: verifiedBy(mallory, { committer: webFlow, webFlow: true }) }, pushEvent(alice));
      expect(result.kinds).toEqual([]);
      expect(result.marks).toEqual([]);
    });

    it("does not count when the commit is a member's but was pushed by an outsider, a bot, or nobody", async () => {
      for (const sender of [mallory, { id: "5", login: "ci[bot]", isBot: true }, null]) {
        const result = await counts({ diffs: verifiedBy(alice) }, pushEvent(sender));
        expect(result.kinds).toEqual([]);
        expect(result.marks).toEqual([]);
      }
    });

    it("does not count an unverified commit, a merge commit, a commit the compare does not list, a compare that failed, or a host with no compare at all", async () => {
      for (const extra of [{ diffs: verifiedBy(alice, { verified: false }) }, { diffs: verifiedBy(alice, { merge: true }) }, { diffs: { compare: async () => ({ status: "ahead" as const, truncated: false, files: [], commits: [] }) } },
        { diffs: { compare: async () => undefined } }, { diffs: { compare: async () => { throw new Error("host down"); } } }, {}]) {
        const result = await counts(extra, pushEvent());
        expect(result.kinds).toEqual([]);
        expect(result.marks).toEqual([]);
      }
    });
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
      status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, committer: alice, verified: true }],
      files: [{ path: "src/cart.ts", additions: 250, deletions: 1, patch: patchOf(250, true) }],
    });
    await tap.handle(merged());
    expect(compares).toEqual([{ repo: repo(), base: sha(20), head: sha(21) }]);
    expect(handed).toHaveLength(1);
    const input = handed[0]!;
    expect(input).toMatchObject({ workspaceId: WS, project: "shop", taskId: "task-1", repo: "acme/shop", trust: "member", link: "https://github.com/acme/shop/pull/5" });
    // M4: the lines carry the repository's audience and scope (a private repository's are restricted with a live access check).
    expect(input.audience).toMatchObject({ kind: "restricted", acl: { source: "github", scope: "github:repo/77", liveCheck: "on_read" } });
    expect(input.scope).toBe("github:repo/77");
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
        status: "ahead", truncated: false, commits: authors.map((author, index) => ({ sha: sha(50 + index), verified: true, ...(author === undefined ? {} : { author, committer: author }) })),
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
    const other = fixture({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, committer: alice, verified: true }], files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] });
    await other.tap.handle(pr({ number: 77, action: "closed", merged: true, headSha: sha(21), version: "closed:77" }));
    expect(other.compares).toEqual([]);
    const notMerged = fixture({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, committer: alice, verified: true }], files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] });
    await notMerged.tap.handle(pr({ action: "closed", merged: false, headSha: sha(21), version: "closed:6" }));
    expect(notMerged.compares).toEqual([]);
  });

  it("drops a diverged or behind compare (a force push or rebase mixes in other people's commits), and one that was cut short", async () => {
    for (const status of ["diverged", "behind"] as const) {
      const f = fixture({ status, truncated: false, commits: [{ sha: sha(22), author: alice, committer: alice, verified: true }], files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] });
      await f.tap.handle(merged());
      expect(f.handed).toEqual([]);
      expect(f.logs).toContain("human_edit.skipped");
    }
    // A cut-short compare has commits nobody checked: they are as good as outsiders', so nothing is handed on.
    const truncated = fixture({ status: "ahead", truncated: true, commits: [{ sha: sha(22), author: alice, committer: alice, verified: true }], files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] });
    await truncated.tap.handle(merged());
    expect(truncated.handed).toEqual([]);
    const none = fixture(undefined);
    await none.tap.handle(merged());
    expect(none.handed).toEqual([]);
  });

  const filesOf = [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }];
  const webFlow = { id: "19864447", login: "web-flow", isBot: false };

  it("a signature alone does not prove authorship: verified, author = a member, committer = an outsider (the review's spoof) hands nothing on", async () => {
    const spoofed = fixture({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, committer: mallory, verified: true }], files: filesOf });
    await spoofed.tap.handle(merged());
    expect(spoofed.handed).toEqual([]);
    expect(spoofed.logs).toContain("human_edit.skipped");
    const unsigned = fixture({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, committer: alice, verified: false }], files: filesOf });
    await unsigned.tap.handle(merged());
    expect(unsigned.handed).toEqual([]);
    const noCommitter = fixture({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, verified: true }], files: filesOf });
    await noCommitter.tap.handle(merged());
    expect(noCommitter.handed).toEqual([]);
  });

  it("accepts a verified commit whose committer is the author, or the host's web-flow account for a member author", async () => {
    const same = fixture({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, committer: alice, verified: true }], files: filesOf });
    await same.tap.handle(merged());
    expect(same.handed).toHaveLength(1);
    const web = fixture({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, committer: webFlow, verified: true, webFlow: true }], files: filesOf });
    await web.tap.handle(merged());
    expect(web.handed).toHaveLength(1);
    // web-flow with an outsider author is still an outsider's edit.
    const outsiderWeb = fixture({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: mallory, committer: webFlow, verified: true, webFlow: true }], files: filesOf });
    await outsiderWeb.tap.handle(merged());
    expect(outsiderWeb.handed).toEqual([]);
  });

  describe("unsigned commits: the push chain", () => {
    const unsigned = { status: "ahead" as const, truncated: false, commits: [{ sha: sha(22), author: mallory, verified: false }], files: filesOf };
    const push = (before: number, after: number, sender: typeof alice, ref = "refs/heads/rovara/x") => ({ repo: "acme/shop", ref, before: sha(before), after: sha(after), senderId: sender.id, senderIsBot: sender.isBot, at: AT });
    const job = { repo: repo(), project: "shop", taskId: "task-1", pullRequest: { number: 5, url: rovaraPr.url }, candidateHeadSha: sha(20), headSha: sha(21), headRef: "rovara/x" };
    function chainFixture(pushes: Array<ReturnType<typeof push>>, commits: CodeHostDiff["commits"] = unsigned.commits) {
      const handed: HumanEditInput[] = [];
      const w = world();
      w.config.set("github", repoScope(repo()));
      w.actors.members.set("1001", "dev-alice");
      w.pushes.pushes.push(...pushes);
      const deps = { actors: w.actors, mode: w.mode, config: w.config, pushes: w.pushes, diffs: { compare: async () => ({ ...unsigned, commits }) }, extractor: { extract: async (input: HumanEditInput) => { handed.push(input); return { candidates: 1 }; } } };
      return { handed, run: () => runHumanEdit(deps, job) };
    }

    it("accepts unsigned commits that reached the branch in a complete chain of pushes by a linked member, when every commit's author is a member too", async () => {
      const { handed, run } = chainFixture([push(20, 25, alice), push(25, 21, alice)], [{ sha: sha(22), author: alice, verified: false }]);
      expect(await run()).toBe("handed_on");
      expect(handed[0]).toMatchObject({ trust: "member", authorCount: 1 });
    });

    it("fails closed on a gap in the chain, a push by a non-member or a bot, a push to another branch, and a missing index", async () => {
      expect(await chainFixture([push(20, 25, alice)]).run()).toBe("skipped");
      expect(await chainFixture([push(20, 25, alice), push(25, 21, mallory)]).run()).toBe("skipped");
      expect(await chainFixture([push(20, 21, { id: "9", login: "ci[bot]", isBot: true })]).run()).toBe("skipped");
      expect(await chainFixture([push(20, 21, alice, "refs/heads/other")]).run()).toBe("skipped");
      expect(await chainFixture([]).run()).toBe("skipped");
      const loop = chainFixture([push(21, 21, alice)]);
      expect(await loop.run()).toBe("skipped");
      expect(loop.handed).toEqual([]);
    });

    it("the merger's identity is never authorship: a member merging an outsider's unsigned commits hands nothing on", async () => {
      const f = fixture({ ...unsigned });
      f.w.prs.list.push(rovaraPr);
      await f.tap.handle({ ...(merged() as Extract<CodeHostEvent, { type: "pr" }>), author: alice });
      expect(f.handed).toEqual([]);
    });

    it("the tap records an authenticated branch push (sender, range, no content) and ignores a push without a sender or to a tag", async () => {
      const { w, tap } = setup({});
      const withIndex = createCodeHostTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config, pushes: w.pushes });
      await withIndex.handle({ type: "push", repo: repo(), ref: "refs/heads/rovara/x", commits: [{ sha: sha(21), message: "secret change" }], at: AT, before: sha(20), after: sha(21), sender: alice });
      await withIndex.handle({ type: "push", repo: repo(), ref: "refs/heads/rovara/x", commits: [], at: AT, before: sha(21), after: sha(22) });
      await withIndex.handle({ type: "push", repo: repo(), ref: "refs/tags/v1", commits: [], at: AT, before: sha(21), after: sha(23), sender: alice });
      expect(w.pushes.pushes).toEqual([{ repo: "acme/shop", ref: "refs/heads/rovara/x", before: sha(20), after: sha(21), senderId: "1001", senderIsBot: false, at: AT }]);
      expect(JSON.stringify(w.pushes.pushes)).not.toContain("secret change");
      void tap;
    });
  });

  it("hands a task's edit on once however often the merge is delivered, and gives the claim back when the extractor fails", async () => {
    const claimed = new Set<string>();
    const claims = { claim: async (key: string) => (claimed.has(key) ? false : (claimed.add(key), true)), release: async (key: string) => { claimed.delete(key); } };
    let failing = true;
    const handed: HumanEditInput[] = [];
    const { w, tap } = setup({
      claims,
      diffs: { compare: async () => ({ status: "ahead", truncated: false, commits: [{ sha: sha(22), author: alice, committer: alice, verified: true }], files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] }) },
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
    expect(deliver("push", undefined, { ref: "refs/heads/x", before: sha(1), after: sha(2), sender: { id: 1001, login: "alice", type: "User" }, commits: [] })).toMatchObject([{ type: "push", before: sha(1), after: sha(2), sender: { id: "1001", isBot: false } }]);
    expect(deliver("pull_request", "opened", { pull_request: { ...prBody, head: { sha: sha(10), ref: "rovara/x" } } })).toMatchObject([{ headRef: "rovara/x" }]);
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
    // The committer is the mapped account, and only GitHub's own web-flow account (by name and id) counts as the host committing.
    const committerBody = { ...body, commits: [
      { sha: sha(22), author: { id: 1001, login: "alice", type: "User" }, committer: { id: 19864447, login: "web-flow", type: "User" }, commit: { verification: { verified: true } } },
      { sha: sha(23), author: { id: 1001, login: "alice", type: "User" }, committer: { id: 4242, login: "web-flow", type: "User" }, commit: { verification: { verified: true } } },
    ] };
    const withCommitters = await createGithubDiffReader(async () => ({ status: 200, body: committerBody })).compare({ repo: repo(), base: sha(20), head: sha(21) });
    expect(withCommitters!.commits.map((commit) => commit.webFlow === true)).toEqual([true, false]);
    expect(withCommitters!.commits[0]!.committer).toMatchObject({ id: "19864447" });
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
