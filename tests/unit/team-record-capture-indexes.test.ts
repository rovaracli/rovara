// Lessons capture lane: the once-claim, the push index and the merge index the code-host tap's human-edit read needs. The push index names a company member by developer id and goes with the person's erase.
import { describe, expect, it } from "vitest";
import { tableMergeIndex, tableOnceClaims, tablePushIndex, PUSH_INDEX_ENTITY } from "../../packages/broker/src/team-record/capture-indexes.js";
import { erasePerson } from "../../packages/broker/src/team-record/erase.js";
import { ORG_A, ORG_B, world } from "../support/team-record-core.js";
import { deleteDeps } from "../support/team-record-delete.js";
import { FakeActors, sha } from "../support/team-record-ingest-fakes.js";

const AT = "2026-10-30T10:00:00.000Z";

describe("once claims", () => {
  it("the first claim wins, a repeat loses, a released claim can be taken again", async () => {
    const w = world();
    const claims = tableOnceClaims(w.table);
    expect(await claims.claim("human_edit#t1#abc")).toBe(true);
    expect(await claims.claim("human_edit#t1#abc")).toBe(false);
    expect(await claims.claim("human_edit#t1#def")).toBe(true);
    await claims.release("human_edit#t1#abc");
    expect(await claims.claim("human_edit#t1#abc")).toBe(true);
  });
});

describe("push index", () => {
  const actors = new FakeActors();
  actors.members.set("1001", "dev-1");
  const push = (over: Record<string, unknown> = {}) => ({ repo: "acme/api", ref: "refs/heads/fix", before: sha(1), after: sha(2), senderId: "1001", senderIsBot: false, at: AT, ...over });

  it("keeps a member as their developer id and never the host's account id", async () => {
    const w = world();
    const index = tablePushIndex(w.table, actors);
    await index.record({ workspaceId: ORG_A, host: "github", push: push(), ttlSeconds: 3600 });
    const found = await index.byAfter({ workspaceId: ORG_A, host: "github", repo: "acme/api", after: sha(2) });
    expect(found).toMatchObject({ senderDeveloperId: "dev-1", senderId: "", senderIsBot: false, before: sha(1), ref: "refs/heads/fix" });
    expect(JSON.stringify(w.db.find((item) => item.entityType === PUSH_INDEX_ENTITY))).not.toContain("1001");
  });

  it("a bot is kept as a bot, and anyone who is not a member as nobody (the chain then fails closed)", async () => {
    const w = world();
    const index = tablePushIndex(w.table, actors);
    await index.record({ workspaceId: ORG_A, host: "github", push: push({ after: sha(3), senderIsBot: true }), ttlSeconds: 3600 });
    await index.record({ workspaceId: ORG_A, host: "github", push: push({ after: sha(4), senderId: "7777" }), ttlSeconds: 3600 });
    expect(await index.byAfter({ workspaceId: ORG_A, host: "github", repo: "acme/api", after: sha(3) })).toMatchObject({ senderIsBot: true });
    const stranger = await index.byAfter({ workspaceId: ORG_A, host: "github", repo: "acme/api", after: sha(4) });
    expect(stranger?.senderDeveloperId).toBeUndefined();
    expect(stranger?.senderIsBot).toBe(false);
  });

  it("L1: the sender is looked up under the record's name for the host (a plug-in's is `codehost:<name>`), the same name the tap's identity fix uses", async () => {
    const seen: string[] = [];
    const spy = { resolve: async (input: { system: string; sourceId: string }) => { seen.push(input.system); return { trust: "outsider" as const }; }, resolveDeveloper: async () => ({ trust: "outsider" as const }) };
    const w = world();
    const index = tablePushIndex(w.table, spy);
    await index.record({ workspaceId: ORG_A, host: "examplehost", push: push(), ttlSeconds: 3600 });
    await index.record({ workspaceId: ORG_A, host: "github", push: push({ after: sha(5) }), ttlSeconds: 3600 });
    expect(seen).toEqual(["codehost:examplehost", "github"]);
  });

  it("another workspace or repository finds nothing", async () => {
    const w = world();
    const index = tablePushIndex(w.table, actors);
    await index.record({ workspaceId: ORG_A, host: "github", push: push(), ttlSeconds: 3600 });
    expect(await index.byAfter({ workspaceId: ORG_B, host: "github", repo: "acme/api", after: sha(2) })).toBeUndefined();
    expect(await index.byAfter({ workspaceId: ORG_A, host: "github", repo: "acme/other", after: sha(2) })).toBeUndefined();
  });

  it("erasure: a person's erase deletes the pushes that name them", async () => {
    const w = world();
    const index = tablePushIndex(w.table, actors);
    await index.record({ workspaceId: ORG_A, host: "github", push: push(), ttlSeconds: 3600 });
    expect(await index.byAfter({ workspaceId: ORG_A, host: "github", repo: "acme/api", after: sha(2) })).toBeDefined();
    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-1" }, "e1");
    expect(await index.byAfter({ workspaceId: ORG_A, host: "github", repo: "acme/api", after: sha(2) })).toBeUndefined();
    expect(w.db.find((item) => item.entityType === PUSH_INDEX_ENTITY)).toHaveLength(0);
  });
});

describe("merge index", () => {
  const note = { workspaceId: ORG_A, host: "github", repo: "acme/api", number: 7, taskId: "task-1", project: "web", url: "https://github.com/acme/api/pull/7", mergeCommitSha: sha(30) };
  it("finds the task from the merge commit and the merge commit from the task's pull request", async () => {
    const w = world();
    const index = tableMergeIndex(w.table);
    await index.record(note);
    expect(await index.byMergeCommit({ workspaceId: ORG_A, host: "github", repo: "acme/api", sha: sha(30) })).toMatchObject({ taskId: "task-1", project: "web", number: 7, mergeCommitSha: sha(30) });
    expect(await index.mergeCommitOf({ workspaceId: ORG_A, host: "github", repo: "acme/api", number: 7, taskId: "task-1" })).toBe(sha(30));
  });
  it("another workspace, repository, task or a malformed sha finds nothing", async () => {
    const w = world();
    const index = tableMergeIndex(w.table);
    await index.record(note);
    await index.record({ ...note, number: 8, mergeCommitSha: "not-a-sha" });
    expect(await index.byMergeCommit({ workspaceId: ORG_B, host: "github", repo: "acme/api", sha: sha(30) })).toBeUndefined();
    expect(await index.byMergeCommit({ workspaceId: ORG_A, host: "github", repo: "acme/other", sha: sha(30) })).toBeUndefined();
    expect(await index.mergeCommitOf({ workspaceId: ORG_A, host: "github", repo: "acme/api", number: 7, taskId: "task-2" })).toBeUndefined();
    expect(await index.mergeCommitOf({ workspaceId: ORG_A, host: "github", repo: "acme/api", number: 8, taskId: "task-1" })).toBeUndefined();
  });
});
