// Lessons in the repo, lane R1b (decision 50c, decision 51): the production subject source describes a task's merged pull request WITHOUT naming a code host in the lessons code: place, repository, link and link prefix, head
// and merge revision, title and description, and the comments this read already proved. It does that only from what the host's adapter said and the comment rows' own place and readers.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { lessonSubjectSource, type LessonSubjectSourceDeps, type PullRequestFeedbackView } from "../../../packages/broker/src/aws/broker/lesson-subject-source.js";
import type { CapturedRowReader, CapturedWords } from "../../../packages/broker/src/lessons/captured-rows.js";
import { taskKey, taskOwnerKey } from "../../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { WS } from "./lesson-helpers.js";

const PROJECT = "proj-1";
const TASK = randomUUID();
const CREATOR = "creator-1";
const PR = "https://github.com/Acme/Api/pull/7";
const HEAD = "d".repeat(40);
const MERGE = "e".repeat(40);

function record(state: string) {
  return {
    ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: WS, project: PROJECT, developerId: CREATOR, developerName: "Creator", provider: "oidc", client: "web",
    requestText: "Make the retries use withRetry", title: "Retries", agent: { agentId: "a" }, startedBy: { developerId: CREATOR }, ownerKey: taskOwnerKey(CREATOR, TASK),
    workflow: {
      schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: TASK, ownerId: taskOwnerKey(CREATOR, TASK), revision: 3, stage: "WAIT_FOR_MERGE", state: "COMPLETE", outcome: "MERGED",
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", artifacts: [], decisions: [],
      pullRequests: [{ repositoryId: "api", number: 7, url: PR, candidateDigest: "b".repeat(64), required: true, state }],
    },
  };
}
const words = (id: string, who: string, text: string, over: Partial<CapturedWords> = {}): CapturedWords => ({ id, authorDeveloperId: who, authorSourceId: `acct-${who}`, source: "github", ownText: true, text, audience: { kind: "project" }, scope: "github:repo/9", ...over });
const feedback = (over: Partial<PullRequestFeedbackView> = {}): PullRequestFeedbackView => ({
  comments: [{ kind: "review_comment", id: "11" }, { kind: "discussion", id: "13" }], headRevision: HEAD, title: "Retries use withRetry", body: "Moves retries.\n\n## Lessons used\nRovara used 1 lesson.", mergeRevision: MERGE, ...over,
});
const comments: Record<string, CapturedWords> = {
  "review_comment:11": words("acme/api#pr7:review_comment11", "rae", "Use withRetry", { path: "src/a.ts" }),
  "discussion:13": words("acme/api#pr7:discussion13", "sam", "Please add a test"),
};

function read(options: { state?: string; feedback?: PullRequestFeedbackView | undefined; comments?: Record<string, CapturedWords> } = {}, over: Partial<LessonSubjectSourceDeps> = {}) {
  const db = new FakeDynamoDb();
  db.set(record(options.state ?? "MERGED"));
  const captured: CapturedRowReader = { rememberedNote: async () => undefined, pullRequestWords: async ({ surface, commentId }) => (options.comments ?? comments)[`${surface}:${commentId}`] };
  const source = lessonSubjectSource({
    documentClient: db, tableName: "state", repositoriesOf: async () => ["api"], standing: async () => "member", isErased: async () => false, visibility: async () => ({ kind: "shared" }), now: () => 1_800_000_000_000,
    captured, rememberedNoteIds: async () => [], sourceExcluded: async () => false, pullRequestFeedback: async () => ("feedback" in options ? options.feedback : feedback()), ...over,
  });
  return source.read({ workspaceId: WS, taskId: TASK });
}

describe("the subject source describes the merged pull request for the repo-only reflection", () => {
  it("gives the place and readers of the comment rows, the project's name for the repository, the link and its prefix, the head and merge revisions, the title and the description", async () => {
    const base = await read();
    expect(base?.repoChanges).toHaveLength(1);
    const change = base!.repoChanges![0]!;
    expect(change).toMatchObject({ place: "github:repo/9", repository: "api", link: PR, linkPrefix: "https://github.com/Acme/Api/pull/", revision: HEAD, mergeRevision: MERGE, merged: true, title: "Retries use withRetry", audience: { kind: "project" }, edits: [] });
    expect(change.body).toContain("Moves retries.");
    expect(change.comments.map((span) => [span.kind, span.authorId, span.scopes])).toEqual([["pr_comment", "rae", ["github:repo/9"]], ["pr_comment", "sam", ["github:repo/9"]]]);
    // The same comment spans are in the first reflection's subject: nothing more is read from the host for it.
    expect(base!.facts.rest.spans!.filter((span) => span.kind === "pr_comment")).toEqual([...change.comments]);
  });

  it("gives none for a pull request that did not merge, a host that gave no title or head, no comment of this read, or comments from two places", async () => {
    expect((await read({ state: "OPEN" }))?.repoChanges).toBeUndefined();
    expect((await read({ feedback: feedback({ title: undefined }) }))?.repoChanges).toBeUndefined();
    expect((await read({ feedback: feedback({ headRevision: undefined }) }))?.repoChanges).toBeUndefined();
    expect((await read({ comments: {} }))?.repoChanges).toBeUndefined();
    expect((await read({ feedback: undefined }))?.repoChanges).toBeUndefined();
    expect((await read({ comments: { ...comments, "discussion:13": words("acme/api#pr7:discussion13", "sam", "Please add a test", { scope: "github:repo/77" }) } }))?.repoChanges).toBeUndefined();
  });

  it("a link that does not end in the pull request's number has no prefix, so none is described (the adapter's address is the only parser)", async () => {
    const odd = await read({}, { pullRequestAddress: () => ({ host: "github", repository: "acme/api", number: 8 }) });
    expect(odd?.repoChanges).toBeUndefined();
  });
});
