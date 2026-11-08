// Lessons capture lane: the production subject source also reads the corrections people already make: "remember this" notes and reviewers' comments on the task's pull requests.
// Each span carries the row's id (so a lesson can cite it), the person is the row's author, and their standing and erasure are read NOW.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubPullRequestAddress, lessonSubjectSource, patchChangesLine, type LessonSubjectSourceDeps, type PullRequestFeedbackView } from "../../../packages/broker/src/aws/broker/lesson-subject-source.js";
import type { CapturedRowReader, CapturedWords } from "../../../packages/broker/src/lessons/captured-rows.js";
import { taskKey, taskOwnerKey } from "../../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { WS } from "./lesson-helpers.js";

const PROJECT = "proj-1";
const TASK = randomUUID();
const CREATOR = "creator-1";
const PR = "https://github.com/Acme/Api/pull/7";

function decision(over: Record<string, unknown> = {}) {
  return { requestId: randomUUID(), workflowRevision: 1, decision: "APPROVE", actorId: taskOwnerKey(CREATOR, TASK), actorRole: "TASK_OWNER", reviewDigest: "a".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: ["c".repeat(64)], selectedFindingIds: [], selectedCommentIds: [], candidates: [], at: "2026-11-01T00:00:00.000Z", schemaVersion: 1, ...over };
}
function record(workflow: Record<string, unknown> = {}) {
  return {
    ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: WS, project: PROJECT, developerId: CREATOR, developerName: "Creator", provider: "oidc", client: "web",
    requestText: "Make the retries use withRetry", title: "Retries", agent: { agentId: "a" }, startedBy: { developerId: CREATOR }, ownerKey: taskOwnerKey(CREATOR, TASK),
    workflow: {
      schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: TASK, ownerId: taskOwnerKey(CREATOR, TASK), revision: 3, stage: "WAIT_FOR_MERGE", state: "COMPLETE", outcome: "MERGED",
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", artifacts: [], decisions: [],
      pullRequests: [{ repositoryId: "api", number: 7, url: PR, candidateDigest: "b".repeat(64), required: true, state: "MERGED" }], ...workflow,
    },
  };
}
const words = (id: string, who: string, text: string, over: Partial<CapturedWords> = {}): CapturedWords => ({ id, authorDeveloperId: who, authorSourceId: `acct-${who}`, source: "github", ownText: true, text, audience: { kind: "project" }, scope: "github:repo/9", ...over });

interface Fixture { lookupThrows?: boolean; notes?: Record<string, CapturedWords>; comments?: Record<string, CapturedWords>; feedback?: PullRequestFeedbackView | undefined; erased?: string[]; outsiders?: string[]; workflow?: Record<string, unknown> }
function setup(fixture: Fixture = {}, over: Partial<LessonSubjectSourceDeps> = {}) {
  const db = new FakeDynamoDb();
  db.set(record(fixture.workflow));
  const asked: string[] = [];
  const captured: CapturedRowReader = {
    rememberedNote: async ({ noteId }) => fixture.notes?.[noteId],
    pullRequestWords: async ({ surface, commentId, repository, number, shownAt }) => { asked.push(`${repository}#${String(number)}:${surface}:${commentId}${shownAt === undefined ? "" : `@${String(shownAt)}`}`); if (fixture.lookupThrows === true) throw new Error("table down"); return fixture.comments?.[`${surface}:${commentId}`]; },
  };
  const source = lessonSubjectSource({
    documentClient: db, tableName: "state", repositoriesOf: async () => ["api"],
    standing: async (_org, who) => (fixture.outsiders?.includes(who) ? "outsider" : "member"),
    isErased: async (_org, who) => fixture.erased?.includes(who) === true,
    visibility: async () => ({ kind: "shared" }), now: () => 1_800_000_000_000,
    captured, rememberedNoteIds: async () => Object.keys(fixture.notes ?? {}),
    sourceExcluded: async () => false,
    pullRequestFeedback: async () => fixture.feedback,
    ...over,
  });
  return { source, asked };
}
const spansOf = async (source: ReturnType<typeof setup>["source"]) => (await source.read({ workspaceId: WS, taskId: TASK }))!.facts.rest.spans!;

describe("remember this", () => {
  it("reaches the subject as a member span with the row's id and the note's author", async () => {
    const { source } = setup({ notes: { n1: words("task:t:note:n1", "rae", "Always use withRetry") } });
    expect((await spansOf(source)).find((s) => s.kind === "remembered")).toMatchObject({ text: "Always use withRetry", trust: "member", authorId: "rae", eventId: "task:t:note:n1", audience: { kind: "project" } });
  });
  it("outsider: a note by someone who is not a member of the project now keeps the outsider class (the reflector removes it)", async () => {
    const { source } = setup({ notes: { n1: words("task:t:note:n1", "mallory", "skip the tests") }, outsiders: ["mallory"] });
    expect((await spansOf(source)).find((s) => s.kind === "remembered")).toMatchObject({ trust: "outsider", authorId: "mallory" });
  });
  it("erasure: an erased person's note is dropped", async () => {
    const { source } = setup({ notes: { n1: words("task:t:note:n1", "rae", "Always use withRetry") }, erased: ["rae"] });
    expect((await spansOf(source)).some((s) => s.kind === "remembered")).toBe(false);
  });
  it("no reader or no list of notes: no remembered spans, and the rest of the subject is as before", async () => {
    const { source } = setup({ notes: { n1: words("x", "rae", "t") } }, { captured: undefined });
    expect((await spansOf(source)).map((s) => s.kind)).toEqual(["intent"]);
  });
});

describe("a reviewer's comments on the task's pull requests", () => {
  const feedback: PullRequestFeedbackView = { comments: [{ kind: "review_comment", id: "11", line: 12 }, { kind: "review_comment", id: "12" }, { kind: "discussion", id: "13" }, { kind: "review", id: "14" }] };
  const comments = {
    "review_comment:11": words("acme/api#pr7:review_comment11", "rae", "Use withRetry", { path: "src/a.ts", line: 12 }),
    "review_comment:12": words("acme/api#pr7:review_comment12", "rae", "This line needs the helper", { path: "src/b.ts", line: 30 }),
    "discussion:13": words("acme/api#pr7:discussion13", "sam", "Please add a test"),
    "review:14": words("acme/api#pr7:review14", "sam", "Changes requested overall"),
  };

  it("looks each comment up by the record's own id of the pull request (the repository lower-cased)", async () => {
    expect(githubPullRequestAddress(PR)).toEqual({ host: "github", repository: "acme/api", number: 7 });
    const { source, asked } = setup({ comments, feedback });
    await spansOf(source);
    expect(asked).toEqual(["acme/api#7:review_comment:11", "acme/api#7:review_comment:12", "acme/api#7:discussion:13", "acme/api#7:review:14"]);
  });

  it("each comment is a member span with the row's id, its author and where it was made", async () => {
    const { source } = setup({ comments, feedback });
    const spans = (await spansOf(source)).filter((s) => s.kind === "pr_comment");
    expect(spans.map((s) => s.eventId)).toEqual(["acme/api#pr7:review_comment11", "acme/api#pr7:review_comment12", "acme/api#pr7:discussion13", "acme/api#pr7:review14"]);
    expect(spans[0]).toMatchObject({ text: "On src/a.ts: Use withRetry", trust: "member", authorId: "rae", scopes: ["github:repo/9"] });
    expect(spans[2]).toMatchObject({ text: "Please add a test", authorId: "sam" });
  });

  it("M2: a comment the host now shows on no line (outdated, as after Rovara's own fix round, a rebase or a restack force-push) did NOT lead to a change", async () => {
    const { source } = setup({ comments, feedback });
    const spans = (await spansOf(source)).filter((s) => s.kind === "pr_comment");
    // Comment 12 is on no line now; that alone is not a person's correction.
    expect(spans.map((s) => s.ledToChange)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("a comment the owner sent to the agent and approved led to a change; Rovara's own automatic decision and a dismissal did not", async () => {
    const everything = { rounds: [{ at: "2026-11-01T00:00:00.000Z", pulls: [{ repositoryId: "api", number: 7, comments: ["review_comment:11", "review_comment:12", "discussion:13", "review:14"].map((id) => ({ id, at: 1_762_000_000_000 })) }] }] };
    const { source } = setup({ comments, feedback, workflow: { feedbackShown: everything, feedbackDecisions: [
      decision({ selectedCommentIds: ["discussion:13"] }), decision({ decision: "DISMISS", selectedCommentIds: ["review:14"] }),
      decision({ actorRole: "ROVARA_AUTONOMY", actorId: "rovara", selectedCommentIds: ["review_comment:12"] }),
    ] } });
    const spans = (await spansOf(source)).filter((s) => s.kind === "pr_comment");
    expect(spans.find((s) => s.eventId?.endsWith("discussion13"))!.ledToChange).toBe(true);
    // A dismissed decision changed nothing, and a round Rovara decided itself is not a person's.
    expect(spans.find((s) => s.eventId?.endsWith("review14"))!.ledToChange).toBeUndefined();
    expect(spans.find((s) => s.eventId?.endsWith("review_comment12"))!.ledToChange).toBeUndefined();
  });

  describe("M2: a person's own commit that changed the commented lines", () => {
    const HEAD = "d".repeat(40);
    const COMMIT = "c".repeat(40);
    const patch = "@@ -10,4 +10,4 @@\n a\n b\n-the commented line 12\n+the fixed line\n d";
    const view = (over: Partial<PullRequestFeedbackView> = {}): PullRequestFeedbackView => ({ comments: [{ kind: "review_comment", id: "11" }], headRevision: HEAD, sourceBranch: "rovara/x", ...over });
    const one = { "review_comment:11": words("acme/api#pr7:review_comment11", "rae", "Use withRetry", { path: "src/a.ts", line: 12, commitId: COMMIT }) };
    const ledOf = async (files: Array<{ path: string; patch?: string }> | undefined, over: Partial<Parameters<typeof setup>[1]> = {}, feedbackOver: Partial<PullRequestFeedbackView> = {}) => {
      const asked: unknown[] = [];
      const { source } = setup({ comments: one, feedback: view(feedbackOver) }, { humanChangedFiles: async (input) => { asked.push(input); return files; }, ...over });
      return { led: (await spansOf(source)).find((s) => s.kind === "pr_comment")!.ledToChange, asked };
    };

    it("is marked when the host-proved range of members' commits changed a line next to the comment's line in its file", async () => {
      const { led, asked } = await ledOf([{ path: "src/a.ts", patch }]);
      expect(led).toBe(true);
      expect(asked).toEqual([{ orgId: WS, project: PROJECT, host: "github", repository: "acme/api", scope: "github:repo/9", isPrivate: false, base: COMMIT, head: HEAD, headRef: "rovara/x" }]);
    });
    it("is not marked for another file, a hunk far from the line, a range not proved (undefined), no reader, a head equal to the comment's commit, or a failing compare", async () => {
      expect((await ledOf([{ path: "src/other.ts", patch }])).led).toBeUndefined();
      expect((await ledOf([{ path: "src/a.ts", patch: "@@ -100,3 +100,3 @@\n a\n-b\n+c" }])).led).toBeUndefined();
      expect((await ledOf(undefined)).led).toBeUndefined();
      expect((await ledOf([{ path: "src/a.ts", patch }], { humanChangedFiles: undefined })).led).toBeUndefined();
      expect((await ledOf([{ path: "src/a.ts", patch }], {}, { headRevision: COMMIT })).asked).toEqual([]);
      expect((await ledOf([{ path: "src/a.ts", patch }], { humanChangedFiles: async () => { throw new Error("host down"); } })).led).toBeUndefined();
    });
    it("reads each commit's range once, however many comments were made on it", async () => {
      const asked: unknown[] = [];
      const many = { "review_comment:11": one["review_comment:11"]!, "review_comment:12": words("acme/api#pr7:review_comment12", "rae", "And here", { path: "src/a.ts", line: 40, commitId: COMMIT }) };
      const { source } = setup({ comments: many, feedback: view({ comments: [{ kind: "review_comment", id: "11" }, { kind: "review_comment", id: "12" }] }) }, { humanChangedFiles: async (input) => { asked.push(input); return [{ path: "src/a.ts", patch }]; } });
      const spans = (await spansOf(source)).filter((s) => s.kind === "pr_comment");
      expect(spans.map((s) => s.ledToChange)).toEqual([true, undefined]);
      expect(asked).toHaveLength(1);
    });
    it("the line test: a removed line within two lines, an addition right at it, but not context lines", () => {
      expect(patchChangesLine(patch, 12)).toBe(true);
      expect(patchChangesLine(patch, 14)).toBe(true);
      expect(patchChangesLine(patch, 15)).toBe(false);
      expect(patchChangesLine(patch, 9)).toBe(false);
      expect(patchChangesLine("@@ -10,3 +10,4 @@\n a\n b\n+inserted\n c", 12)).toBe(true);
      expect(patchChangesLine("@@ -10,3 +10,4 @@\n a\n b\n+inserted\n c", 20)).toBe(false);
      expect(patchChangesLine(undefined, 12)).toBe(false);
    });
  });

  it("outsider: a comment by someone who is not a member of the project now keeps the outsider class", async () => {
    const { source } = setup({ comments, feedback, outsiders: ["sam"] });
    const spans = (await spansOf(source)).filter((s) => s.kind === "pr_comment");
    expect(spans.filter((s) => s.trust === "outsider").map((s) => s.authorId)).toEqual(["sam", "sam"]);
    expect(spans.filter((s) => s.trust === "member").map((s) => s.authorId)).toEqual(["rae", "rae"]);
  });

  it("erasure: an erased person's comments are dropped and never counted; the others stay", async () => {
    const { source } = setup({ comments, feedback, erased: ["rae"] });
    const spans = (await spansOf(source)).filter((s) => s.kind === "pr_comment");
    expect(spans.map((s) => s.authorId)).toEqual(["sam", "sam"]);
  });

  it("a comment the record has no row for (a bot, an unlinked account, a deleted comment, an erased author's) gives no span", async () => {
    const { source } = setup({ comments: { "review_comment:11": comments["review_comment:11"] }, feedback });
    expect((await spansOf(source)).filter((s) => s.kind === "pr_comment")).toHaveLength(1);
  });

  it("a restricted repository's comment carries its audience and place, so the lesson is no wider than who can read the repository", async () => {
    const audience = { kind: "restricted" as const, acl: { source: "github" as const, scope: "github:repo/9", principals: ["1"], capturedAt: "2026-11-01T00:00:00.000Z", liveCheck: "on_read" as const } };
    const { source } = setup({ comments: { "review_comment:11": words("acme/api#pr7:review_comment11", "rae", "Use withRetry", { audience }) }, feedback });
    expect((await spansOf(source)).find((s) => s.kind === "pr_comment")).toMatchObject({ audience, scopes: ["github:repo/9"] });
  });

  it("a host that cannot list, or one that fails, gives no comment spans and does not fail the read", async () => {
    expect((await spansOf(setup({ comments, feedback: undefined }).source)).some((s) => s.kind === "pr_comment")).toBe(false);
    const failing = setup({ comments, feedback }, { pullRequestFeedback: async () => { throw new Error("down"); } });
    expect((await spansOf(failing.source)).map((s) => s.kind)).toEqual(["intent"]);
  });

  it("a pull request on a host the record cannot name is skipped; a plug-in host names its own", async () => {
    const other = setup({ comments, feedback, workflow: { pullRequests: [{ repositoryId: "api", number: 7, url: "https://gitfarm.example/cr/7", candidateDigest: "b".repeat(64), required: true, state: "MERGED" }] } });
    expect((await spansOf(other.source)).some((s) => s.kind === "pr_comment")).toBe(false);
    const named = setup({ comments, feedback, workflow: { pullRequests: [{ repositoryId: "api", number: 7, url: "https://gitfarm.example/cr/7", candidateDigest: "b".repeat(64), required: true, state: "MERGED" }] } },
      { pullRequestAddress: () => ({ host: "codehost:gitfarm", repository: "acme/api", number: 7 }) });
    await spansOf(named.source);
    expect(named.asked).toHaveLength(4);
  });
});

describe("the merged commit", () => {
  const sha = "d".repeat(40);
  const merged = { workflow: { pullRequests: [{ repositoryId: "api", number: 7, url: PR, candidateDigest: "b".repeat(64), required: true, state: "MERGED" }], reviewBase: [{ repositoryId: "api", baseCommitSha: "a".repeat(40) }] } };
  it("is the merge commit noted for the task's merged pull request in the repository the subject names", async () => {
    const asked: unknown[] = [];
    const { source } = setup(merged, { mergeCommitOf: async (input) => { asked.push(input); return sha; } });
    expect((await source.read({ workspaceId: WS, taskId: TASK }))!.facts.mergedCommit).toBe(sha);
    expect(asked).toEqual([{ orgId: WS, taskId: TASK, address: { host: "github", repository: "acme/api", number: 7 } }]);
  });
  it("is not claimed when no commit was noted, the lookup fails, the pull request is not merged, or no base names a repository", async () => {
    expect((await setup(merged, { mergeCommitOf: async () => undefined }).source.read({ workspaceId: WS, taskId: TASK }))!.facts.mergedCommit).toBeUndefined();
    expect((await setup(merged, { mergeCommitOf: async () => { throw new Error("down"); } }).source.read({ workspaceId: WS, taskId: TASK }))!.facts.mergedCommit).toBeUndefined();
    const open = { workflow: { ...merged.workflow, pullRequests: [{ ...merged.workflow.pullRequests[0]!, state: "OPEN" }], outcome: "CLOSED" } };
    expect((await setup(open, { mergeCommitOf: async () => sha }).source.read({ workspaceId: WS, taskId: TASK }))!.facts.mergedCommit).toBeUndefined();
    const noBase = { workflow: { pullRequests: merged.workflow.pullRequests } };
    expect((await setup(noBase, { mergeCommitOf: async () => sha }).source.read({ workspaceId: WS, taskId: TASK }))!.facts.mergedCommit).toBeUndefined();
    expect((await setup(merged).source.read({ workspaceId: WS, taskId: TASK }))!.facts.mergedCommit).toBeUndefined();
  });
});

describe("M4 relaxed: a task whose agent was shown pull request comments is steered by named members only on proof", () => {
  const AT = 1_762_000_000_000;
  const shownRecord = (ids: string[], extra: Record<string, unknown> = {}) => ({ rounds: [{ at: "2026-11-01T00:00:00.000Z", pulls: [{ repositoryId: "api", number: 7, comments: ids.map((id) => ({ id, at: AT })) }] }], ...extra });
  const history = [{ sha256: "4".repeat(64), objectKey: "k" }];
  const comments = {
    "review_comment:11": words("acme/api#pr7:review_comment11", "rae", "Use withRetry", { path: "src/a.ts", line: 12 }),
    "discussion:13": words("acme/api#pr7:discussion13", "sam", "Please add a test"),
    "review:14": words("acme/api#pr7:review14", "sam", "Changes requested overall"),
  };
  const ALL = ["review_comment:11", "discussion:13", "review:14"];
  const steering = async (fixture: Fixture, over: Partial<LessonSubjectSourceDeps> = {}) => {
    const { source, asked } = setup({ comments, ...fixture, workflow: { feedbackReviewHistory: history, feedbackShown: shownRecord(ALL), ...fixture.workflow } }, over);
    return { steering: (await source.read({ workspaceId: WS, taskId: TASK }))!.facts.rest.steeringTrust, asked };
  };

  it("positive control: every shown comment is a live member's own words, so the task is steered by named members (no outsider), and each is looked up with the time it was shown", async () => {
    const { steering: trust, asked } = await steering({});
    expect(trust).toEqual(["member"]);
    expect(asked).toEqual([`acme/api#7:review_comment:11@${AT}`, `acme/api#7:discussion:13@${AT}`, `acme/api#7:review:14@${AT}`]);
  });

  it("every round counts: a comment shown only in an earlier round is proved too, and one that cannot be proved there keeps the task unnamed", async () => {
    const twoRounds = { rounds: [shownRecord(["review_comment:11"]).rounds[0]!, shownRecord(["discussion:13", "review:14"]).rounds[0]!] };
    expect((await steering({ workflow: { feedbackShown: twoRounds } })).steering).toEqual(["member"]);
    const firstRoundBot = { rounds: [shownRecord(["review_comment:99"]).rounds[0]!, ...twoRounds.rounds] };
    expect((await steering({ workflow: { feedbackShown: firstRoundBot } })).steering).toContain("outsider");
  });

  it("stays unnamed (outsider) whenever anything is not proved", async () => {
    const cases: Array<[string, Fixture, Partial<LessonSubjectSourceDeps>]> = [
      ["no record of what was shown (a round from before the record)", { workflow: { feedbackShown: undefined } }, {}],
      ["an incomplete record", { workflow: { feedbackShown: shownRecord(ALL, { incomplete: true }) } }, {}],
      ["a rounds list with nothing in it although a review was collected", { workflow: { feedbackShown: { rounds: [] } } }, {}],
      ["a shown comment with no row of its own (a bot, an AI reviewer, an unlinked account, a retention A comment)", { comments: { ...comments, "discussion:13": undefined as never } }, {}],
      ["a shown comment whose text is not provably its author's own (edited since, or by another)", { comments: { ...comments, "discussion:13": words("acme/api#pr7:discussion13", "sam", "x", { ownText: false }) } }, {}],
      ["an author who is not a member of the project now", { outsiders: ["sam"] }, {}],
      ["an author who is erased", { erased: ["sam"] }, {}],
      ["an author whose account is excluded", {}, { sourceExcluded: async ({ accountId }) => accountId === "acct-sam" }],
      ["an exclusion check that fails", {}, { sourceExcluded: async () => { throw new Error("config unreadable"); } }],
      ["no exclusion check at all", {}, { sourceExcluded: undefined }],
      ["a row lookup that fails", { lookupThrows: true }, {}],
      ["a selected comment the record never showed", { workflow: { feedbackDecisions: [decision({ selectedCommentIds: ["review_comment:77"] })] } }, {}],
      ["a comment of the current review that the record does not list", { workflow: { feedbackReview: { status: "COLLECTING", threadObservations: [], bundleRefs: [{ repositoryId: "api", number: 7, comments: [{ id: "discussion:99" }] }] } } }, {}],
      ["a thread comment (a reply) of the current review that the record does not list", { workflow: { feedbackReview: { status: "COLLECTING", bundleRefs: [], threadObservations: [{ repositoryId: "api", number: 7, threadId: "t", comments: [{ id: "review_comment:55" }] }] } } }, {}],
      ["a comment of a pull request the task does not have", { workflow: { feedbackShown: { rounds: [{ at: "x", pulls: [{ repositoryId: "other", number: 1, comments: [{ id: "discussion:13", at: AT }] }] }] } } }, {}],
      ["a shown id that is not a comment id", { workflow: { feedbackShown: shownRecord(["discussion:13", "weird"]) } }, {}],
      ["more comments than are looked up", { workflow: { feedbackShown: shownRecord(Array.from({ length: 101 }, (_, i) => `discussion:${String(i + 1000)}`)) } }, {}],
      ["no reader of the record's rows", {}, { captured: undefined }],
    ];
    for (const [name, fixture, over] of cases) expect((await steering(fixture, over)).steering, name).toContain("outsider");
  });

  it("a reply in the task's Slack thread keeps it unnamed even when every pull request comment is proved", async () => {
    const note = { requestId: randomUUID(), actorId: taskOwnerKey(CREATOR, TASK), source: "THREAD_REPLY", sourceId: "x", text: "do it", at: "2026-11-01T00:00:00.000Z" };
    expect((await steering({ workflow: { feedbackNotes: [note] } })).steering).toContain("outsider");
  });

  it("an owner-approved round over comments that are proved: the owner and the commenters are named members", async () => {
    const { steering: trust } = await steering({ workflow: { feedbackDecisions: [decision({ selectedCommentIds: ["review_comment:11"] })] } });
    expect(trust).toEqual(["member"]);
  });

  describe("L7: the code host is not read for a task that cannot teach", () => {
    it("a task already steered by someone unnamed does not list the pull request's comments from the host", async () => {
      let listed = 0;
      const note = { requestId: randomUUID(), actorId: taskOwnerKey(CREATOR, TASK), source: "THREAD_REPLY", sourceId: "x", text: "do it", at: "2026-11-01T00:00:00.000Z" };
      await steering({ feedback: { comments: [{ kind: "discussion", id: "13" }] }, workflow: { feedbackNotes: [note] } }, { pullRequestFeedback: async () => { listed += 1; return undefined; } });
      expect(listed).toBe(0);
      // Positive control: the same task without the thread reply does list them.
      await steering({ feedback: { comments: [{ kind: "discussion", id: "13" }] } }, { pullRequestFeedback: async () => { listed += 1; return undefined; } });
      expect(listed).toBe(1);
    });
    it("a human edit's read of the task (context) asks the host for nothing and reads no notes", async () => {
      let listed = 0;
      const { source } = setup({ comments, feedback: { comments: [{ kind: "discussion", id: "13" }] }, notes: { n1: words("task:t:note:n1", "rae", "Always use withRetry") } }, { pullRequestFeedback: async () => { listed += 1; return undefined; } });
      const base = (await source.read({ workspaceId: WS, taskId: TASK, context: "human_edit" }))!;
      expect(listed).toBe(0);
      expect(base.facts.rest.spans!.map((s) => s.kind)).toEqual(["intent"]);
    });
  });
});
