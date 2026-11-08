// Lessons capture lane, fix round 2 (M1 gap): the production wiring takes its "remember this" notes from the LIVE corrections (`liveRememberedNoteIds`), never from the task's comment list.
// If the old wiring (every live person comment's id is a note id) is put back, the forgotten comment's note is asked for again and this test fails.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { taskKey, taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { installLessons } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import type { learningDepsFor } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const TASK = randomUUID();
const CREATOR = "creator-1";
const asked: string[] = [];
const liveCalls: Array<{ taskId: string; commentIds: readonly string[] }> = [];

vi.mock("../../packages/broker/src/learning/capture-comment.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  // Only the remembered, not forgotten comment is a live correction: its note id is "note-live".
  liveRememberedNoteIds: vi.fn(async (_deps: unknown, _org: string, _project: string, taskId: string, commentIds: readonly string[]) => { liveCalls.push({ taskId, commentIds }); return commentIds.includes("c-remembered") ? ["note-live"] : []; }),
}));
vi.mock("../../packages/broker/src/developer/page-comments.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listTaskComments: vi.fn(async () => [
    { commentId: "c-remembered", author: { kind: "person" } },
    { commentId: "c-forgotten", author: { kind: "person" } },
    { commentId: "c-agent", author: { kind: "agent" } },
    { commentId: "c-deleted", author: { kind: "person" }, deletedAt: "2026-11-01T00:00:00.000Z" },
  ]),
}));
vi.mock("../../packages/broker/src/aws/broker/records.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  requireLatestProject: vi.fn(async () => ({ definition: { repositories: [{ name: "api", url: "https://github.com/acme/api" }] } })),
}));
vi.mock("../../packages/broker/src/lessons/captured-rows.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  tableCapturedRows: () => ({ rememberedNote: async ({ noteId }: { noteId: string }) => { asked.push(noteId); return undefined; }, pullRequestWords: async () => undefined }),
}));

describe("M1 wiring: the subject source asks for the notes of live corrections only", () => {
  it("lists the task's person comments, asks which are live corrections, and reads only those notes", async () => {
    const db = new FakeDynamoDb();
    db.set({
      ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: TEST_ORG, project: "proj-1", developerId: CREATOR, developerName: "Creator", provider: "oidc", client: "web",
      requestText: "Make the retries use withRetry", title: "Retries", agent: { agentId: "a" }, startedBy: { developerId: CREATOR }, ownerKey: taskOwnerKey(CREATOR, TASK),
      workflow: { schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: TASK, ownerId: taskOwnerKey(CREATOR, TASK), revision: 3, stage: "WAIT_FOR_MERGE", state: "COMPLETE", outcome: "MERGED",
        createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", artifacts: [], decisions: [] },
    });
    const dependencies = {
      documentClient: db, tableName: "state", developer: { signInTableName: "signin" }, artifactBucketName: "artifacts", s3: { send: async () => ({}) },
      teamRecord: { table: { documentClient: new FakeDynamoDb(), tableName: "record" }, edition: "public", emitter: { sendBack: async () => undefined }, taskVisibility: async () => ({ kind: "shared" }), captureAdapters: {}, sourceExcluded: async () => false },
      modelAccess: { access: { learningCompletion: async () => ({ text: "{}", model: "m" }) }, proxyUrl: "http://proxy" },
    } as Record<string, unknown>;
    installLessons(dependencies as never);
    const learning = dependencies.learning as NonNullable<ReturnType<typeof learningDepsFor>>;
    expect(learning).toBeDefined();
    const read = await learning.source.read({ workspaceId: TEST_ORG, taskId: TASK });
    expect(read).toBeDefined();
    // Positive control: the live-corrections reader ran, with the person comments only (not the agent's, not a deleted one).
    expect(liveCalls).toEqual([{ taskId: TASK, commentIds: ["c-remembered", "c-forgotten"] }]);
    // The notes read are the live corrections' ids, and nothing else: the forgotten comment's id is never asked for.
    expect(asked).toEqual(["note-live"]);
  });
});
