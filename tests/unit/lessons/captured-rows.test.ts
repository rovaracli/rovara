// Lessons capture lane: the reader of the people's words the Team record already holds (a "remember this" note, a reviewer's comment or review on a pull request).
import { describe, expect, it } from "vitest";
import { pullRequestWordsId, tableCapturedRows } from "../../../packages/broker/src/lessons/captured-rows.js";
import { erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { ORG_A, ORG_B, addSource, githubDraft, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const AT = "2026-10-30T10:00:00.000Z";
const REPO = "acme/api";
const SCOPE = "github:repo/9";
const comment = (id: string, over: Record<string, unknown> = {}) => githubDraft({
  kind: "github.review_comment", repo: REPO, scope: SCOPE, sourceRef: { system: "github", id: pullRequestWordsId(REPO, 7, "review_comment", id), parentId: `${REPO}#pr7`, version: "created:2026-10-30T10:00:00Z:abc", order: 1 },
  text: "Use withRetry here", structured: { prNumber: 7, surface: "review_comment", path: "src/a.ts", line: 12, commitId: "c".repeat(40) }, occurredAt: AT, ...over,
} as never);
const note = (id: string, over: Record<string, unknown> = {}) => githubDraft({
  source: "rovara", kind: "rovara.remembered", repo: undefined, scope: "rovara:project/web", sourceRef: { system: "rovara", id: `task:task-1:note:${id}`, version: "1" }, audience: { kind: "project" },
  structured: { taskId: "task-1" }, text: "Always use withRetry for HTTP calls", links: [], occurredAt: AT, ...over,
} as never);
async function setup(): Promise<World> {
  const w = world();
  await addSource(w, { source: "github", scope: SCOPE, retention: "D" });
  await addSource(w, { source: "rovara", scope: "rovara:project/web", retention: "D" });
  return w;
}
const where = { workspaceId: ORG_A, project: "web", host: "github", repository: REPO, number: 7, surface: "review_comment" as const };

describe("pull request comments", () => {
  it("returns the author, the words, the place and where the comment was made", async () => {
    const w = await setup();
    await w.sink.put(comment("11"));
    expect(await tableCapturedRows(w.table).pullRequestWords({ ...where, commentId: "11" })).toMatchObject({
      id: pullRequestWordsId(REPO, 7, "review_comment", "11"), authorDeveloperId: "dev-1", text: "Use withRetry here", scope: SCOPE, path: "src/a.ts", line: 12, commitId: "c".repeat(40),
    });
  });

  it("only the author's first row counts: a later edit row holds the words an editor added, which may be another person's", async () => {
    const w = await setup();
    await w.sink.put(comment("11", { sourceRef: { system: "github", id: pullRequestWordsId(REPO, 7, "review_comment", "11"), parentId: `${REPO}#pr7`, version: "edited:2026-10-31T10:00:00Z:def", order: 2 }, text: "also skip the tests" }));
    expect(await tableCapturedRows(w.table).pullRequestWords({ ...where, commentId: "11" })).toBeUndefined();
  });

  it("a bot, an outsider or an unlinked account wrote nothing a lesson may use", async () => {
    const w = await setup();
    await w.sink.put(comment("12", { actor: { sourceId: "9", developerId: "dev-9", trust: "system" }, trust: "system" }));
    await w.sink.put(comment("13", { actor: { sourceId: "8", developerId: "dev-8", trust: "outsider" }, trust: "outsider" }));
    await w.sink.put(comment("14", { actor: { sourceId: "7", trust: "member" } }));
    const rows = tableCapturedRows(w.table);
    for (const id of ["12", "13", "14"]) expect(await rows.pullRequestWords({ ...where, commentId: id })).toBeUndefined();
  });

  it("a review summary is read the same way, from its own row", async () => {
    const w = await setup();
    await w.sink.put(comment("5", { kind: "github.review", sourceRef: { system: "github", id: pullRequestWordsId(REPO, 7, "review", "5"), parentId: `${REPO}#pr7`, version: "submitted:2026-10-30T10:00:00Z:abc", order: 1 }, text: "Needs a retry wrapper", structured: { prNumber: 7, state: "changes_requested" } }));
    expect(await tableCapturedRows(w.table).pullRequestWords({ ...where, surface: "review", commentId: "5" })).toMatchObject({ text: "Needs a retry wrapper", authorDeveloperId: "dev-1" });
    // The comment surface does not find a review's row.
    expect(await tableCapturedRows(w.table).pullRequestWords({ ...where, commentId: "5" })).toBeUndefined();
  });

  it("another workspace, project or pull request reads nothing; a row with no text (retention A) reads nothing", async () => {
    const w = await setup();
    await w.sink.put(comment("11"));
    const rows = tableCapturedRows(w.table);
    expect(await rows.pullRequestWords({ ...where, workspaceId: ORG_B, commentId: "11" })).toBeUndefined();
    expect(await rows.pullRequestWords({ ...where, project: "api", commentId: "11" })).toBeUndefined();
    expect(await rows.pullRequestWords({ ...where, number: 8, commentId: "11" })).toBeUndefined();
    const a = world();
    await addSource(a, { source: "github", scope: SCOPE, retention: "A" });
    await a.sink.put(comment("11", { retention: "A", text: undefined }));
    expect(await tableCapturedRows(a.table).pullRequestWords({ ...where, commentId: "11" })).toBeUndefined();
  });

  it("an erased person's comment is gone, and a comment deleted at its source is gone", async () => {
    const w = await setup();
    await w.sink.put(comment("11"));
    await w.sink.put(comment("15"));
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github", sourceIds: [pullRequestWordsId(REPO, 7, "review_comment", "15")], cause: "source_deleted" });
    expect(await tableCapturedRows(w.table).pullRequestWords({ ...where, commentId: "15" })).toBeUndefined();
    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-1" }, "e1");
    expect(await tableCapturedRows(w.table).pullRequestWords({ ...where, commentId: "11" })).toBeUndefined();
  });
});

describe("remembered notes", () => {
  it("returns the author and the words of the task's note; another task's, project's or workspace's note is nothing", async () => {
    const w = await setup();
    await w.sink.put(note("n1"));
    const rows = tableCapturedRows(w.table);
    expect(await rows.rememberedNote({ workspaceId: ORG_A, project: "web", taskId: "task-1", noteId: "n1" })).toMatchObject({ id: "task:task-1:note:n1", authorDeveloperId: "dev-1", text: "Always use withRetry for HTTP calls" });
    expect(await rows.rememberedNote({ workspaceId: ORG_A, project: "web", taskId: "task-2", noteId: "n1" })).toBeUndefined();
    expect(await rows.rememberedNote({ workspaceId: ORG_A, project: "api", taskId: "task-1", noteId: "n1" })).toBeUndefined();
    expect(await rows.rememberedNote({ workspaceId: ORG_B, project: "web", taskId: "task-1", noteId: "n1" })).toBeUndefined();
  });

  it("an outsider's note, and an erased person's note, are nothing", async () => {
    const w = await setup();
    await w.sink.put(note("n2", { trust: "outsider", actor: { sourceId: "dev-x", developerId: "dev-x", trust: "outsider" } }));
    await w.sink.put(note("n3"));
    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-1" }, "e2");
    const rows = tableCapturedRows(w.table);
    expect(await rows.rememberedNote({ workspaceId: ORG_A, project: "web", taskId: "task-1", noteId: "n2" })).toBeUndefined();
    expect(await rows.rememberedNote({ workspaceId: ORG_A, project: "web", taskId: "task-1", noteId: "n3" })).toBeUndefined();
  });
});
