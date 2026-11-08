// Lessons capture lane: the production subject source also reads the corrections people already make: "remember this" notes and reviewers' comments on the task's pull requests.
// Each span carries the row's id (so a lesson can cite it), the person is the row's author, and their standing and erasure are read NOW.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubPullRequestAddress, lessonSubjectSource, type LessonSubjectSourceDeps, type PullRequestFeedbackView } from "../../../packages/broker/src/aws/broker/lesson-subject-source.js";
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
const words = (id: string, who: string, text: string, over: Partial<CapturedWords> = {}): CapturedWords => ({ id, authorDeveloperId: who, text, audience: { kind: "project" }, scope: "github:repo/9", ...over });

interface Fixture { notes?: Record<string, CapturedWords>; comments?: Record<string, CapturedWords>; feedback?: PullRequestFeedbackView | undefined; erased?: string[]; outsiders?: string[]; workflow?: Record<string, unknown> }
function setup(fixture: Fixture = {}, over: Partial<LessonSubjectSourceDeps> = {}) {
  const db = new FakeDynamoDb();
  db.set(record(fixture.workflow));
  const asked: string[] = [];
  const captured: CapturedRowReader = {
    rememberedNote: async ({ noteId }) => fixture.notes?.[noteId],
    pullRequestWords: async ({ surface, commentId, repository, number }) => { asked.push(`${repository}#${String(number)}:${surface}:${commentId}`); return fixture.comments?.[`${surface}:${commentId}`]; },
  };
  const source = lessonSubjectSource({
    documentClient: db, tableName: "state", repositoriesOf: async () => ["api"],
    standing: async (_org, who) => (fixture.outsiders?.includes(who) ? "outsider" : "member"),
    isErased: async (_org, who) => fixture.erased?.includes(who) === true,
    visibility: async () => ({ kind: "shared" }), now: () => 1_800_000_000_000,
    captured, rememberedNoteIds: async () => Object.keys(fixture.notes ?? {}),
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

  it("each comment is a member span with the row's id, its author and where it was made; an outdated inline comment led to a change", async () => {
    const { source } = setup({ comments, feedback });
    const spans = (await spansOf(source)).filter((s) => s.kind === "pr_comment");
    expect(spans.map((s) => s.eventId)).toEqual(["acme/api#pr7:review_comment11", "acme/api#pr7:review_comment12", "acme/api#pr7:discussion13", "acme/api#pr7:review14"]);
    // The host still shows comment 11 on line 12; it shows comment 12 on no line at all, so a later commit changed those lines.
    expect(spans[0]).toMatchObject({ text: "On src/a.ts: Use withRetry", trust: "member", authorId: "rae", scopes: ["github:repo/9"] });
    expect(spans[0]!.ledToChange).toBeUndefined();
    expect(spans[1]).toMatchObject({ text: "On src/b.ts: This line needs the helper", ledToChange: true });
    // A conversation comment or a review summary has no line to follow: not marked.
    expect(spans[2]).toMatchObject({ text: "Please add a test", authorId: "sam" });
    expect(spans[2]!.ledToChange).toBeUndefined();
  });

  it("a comment the owner sent to the agent and approved led to a change", async () => {
    const { source } = setup({ comments, feedback, workflow: { feedbackDecisions: [decision({ selectedCommentIds: ["discussion:13", "review_comment:99"] }), decision({ decision: "DISMISS", selectedCommentIds: ["review:14"] })] } });
    const spans = (await spansOf(source)).filter((s) => s.kind === "pr_comment");
    expect(spans.find((s) => s.eventId?.endsWith("discussion13"))!.ledToChange).toBe(true);
    // A dismissed decision changed nothing.
    expect(spans.find((s) => s.eventId?.endsWith("review14"))!.ledToChange).toBeUndefined();
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
