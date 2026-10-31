import { describe, expect, it } from "vitest";
import { LakeError, type LakeClient } from "../../../packages/broker/src/team-record/lake.js";
import { DELETE_BATCH, buildLakeDeletes, runLakeDeletes, type LakeDeleteQueue, type PendingLakeDelete } from "../../../packages/broker/src/team-record/lake-delete.js";
import { actorSourceHash, scopeHash, sourceHash } from "../../../packages/broker/src/team-record/lake-sql.js";

const src = (n: number): PendingLakeDelete => ({ id: `q${n}`, target: { kind: "source", sourceHash: sourceHash("slack", `m${n}`) } });

function harness(pending: PendingLakeDelete[], failOn?: (sql: string) => boolean) {
  const executed: string[] = [];
  const acked: string[] = [];
  let t = 0;
  const lake: LakeClient = {
    now: () => (t += 1),
    query: async () => ({ rows: [], truncated: false }),
    execute: async (sql, parameters) => { expect(parameters).toEqual([]); if (failOn?.(sql)) throw new LakeError("lake_query_failed"); executed.push(sql); },
  };
  const queue: LakeDeleteQueue = { listPending: async () => pending, ack: async (_w, ids) => { acked.push(...ids); }, enqueue: async () => undefined };
  return { deps: { queue, lake, tableBucket: "rovara-lake" }, executed, acked };
}

describe("lake delete statements", () => {
  it("batches source deletes by 100 and always binds the workspace", () => {
    const statements = buildLakeDeletes("rovara-lake", "ws1", Array.from({ length: 250 }, (_, i) => src(i)));
    expect(statements).toHaveLength(3);
    expect(statements.map((s) => s.entryIds.length)).toEqual([DELETE_BATCH, DELETE_BATCH, 50]);
    for (const s of statements) expect(s.sql).toMatch(/^DELETE FROM "s3tablescatalog\/rovara-lake"\."record"\."events" WHERE "workspace_id" = 'ws1' AND "source_hash" IN \(/);
  });
  it("covers actor (events and outcomes), project (all four tables) and fact deletes, each scoped to the workspace", () => {
    const statements = buildLakeDeletes("rovara-lake", "ws1", [
      { id: "a", target: { kind: "actor", developerId: "dev-1" } },
      { id: "p", target: { kind: "project", project: "proj-1" } },
      { id: "f", target: { kind: "fact", factId: "fact-1" } },
    ]);
    expect(statements).toHaveLength(1 + 2 + 4);
    expect(statements.every((s) => s.sql.includes(`"workspace_id" = 'ws1'`))).toBe(true);
    expect(statements.filter((s) => s.sql.includes("lessons_history")).length).toBe(1);
  });
  it("I-3: erases a person with no developer id by actor source hash, and a whole place by scope hash (events and facts)", () => {
    const statements = buildLakeDeletes("rovara-lake", "ws1", [
      { id: "a", target: { kind: "actor_source", hash: actorSourceHash("slack", "U9") } },
      { id: "s", target: { kind: "scope", hash: scopeHash("slack:T/C9") } },
    ]);
    expect(statements.map((s) => s.sql.match(/FROM "s3tablescatalog\/rovara-lake"\."record"\."(\w+)" WHERE "workspace_id" = 'ws1' AND "(\w+)" = '[0-9a-f]{64}'$/)?.slice(1).join("."))).toEqual(["events.actor_source_hash", "events.scope_hash", "facts.scope_hash"]);
    expect(() => buildLakeDeletes("rovara-lake", "ws1", [{ id: "x", target: { kind: "scope", hash: "slack:T/C9" } }])).toThrow(/hash/);
  });
  it("refuses values that are not safe ids or hashes (a person's text can never reach a DELETE)", () => {
    expect(() => buildLakeDeletes("rovara-lake", "ws1", [{ id: "x", target: { kind: "actor", developerId: "d' OR '1'='1" } }])).toThrow(/safe id/);
    expect(() => buildLakeDeletes("rovara-lake", "ws1", [{ id: "x", target: { kind: "source", sourceHash: "T1/C1/1.2" } }])).toThrow(/hash/);
    expect(() => buildLakeDeletes("rovara-lake", "ws1' --", [])).toThrow(/safe id/);
  });
});

describe("lake delete run", () => {
  it("acks an entry only after its statement ran", async () => {
    const h = harness([src(1), src(2)]);
    const summary = await runLakeDeletes(h.deps, { workspaceId: "ws1", budget: { maxStatements: 10, maxMs: 60_000 } });
    expect(summary).toMatchObject({ statements: 1, acked: 2, failed: 0 });
    expect(h.acked).toEqual(["q1", "q2"]);
  });
  it("acks nothing and halts with a fixed code after repeated failures, so the entries are retried", async () => {
    const h = harness(Array.from({ length: 450 }, (_, i) => src(i)), () => true);
    const summary = await runLakeDeletes(h.deps, { workspaceId: "ws1", budget: { maxStatements: 10, maxMs: 60_000 } });
    expect(summary).toMatchObject({ acked: 0, failedStatements: 3, halted: "lake_query_failed" });
    expect(h.acked).toEqual([]);
  });
  it("M-2: a statement that keeps failing does not hold back the others; its entries stay queued", async () => {
    const poison = { id: "p", target: { kind: "actor_source", hash: actorSourceHash("slack", "U1") } } as const;
    const good = { id: "g", target: { kind: "scope", hash: scopeHash("slack:T/C1") } } as const;
    const h = harness([poison, good], (sql) => sql.includes('"actor_source_hash"'));
    const summary = await runLakeDeletes(h.deps, { workspaceId: "ws1", budget: { maxStatements: 10, maxMs: 60_000 } });
    expect(h.acked).toEqual(["g"]);
    expect(summary).toMatchObject({ failedStatements: 1, statements: 2 });
    expect(summary.halted).toBeUndefined();
  });
  it("leaves a refused entry queued and still runs the others", async () => {
    const h = harness([{ id: "bad", target: { kind: "actor", developerId: "x y" } }, src(1)]);
    const summary = await runLakeDeletes(h.deps, { workspaceId: "ws1", budget: { maxStatements: 10, maxMs: 60_000 } });
    expect(summary).toMatchObject({ failed: 1, acked: 1 });
    expect(h.acked).toEqual(["q1"]);
  });
  it("acks an actor erase only when both of its statements ran", async () => {
    const h = harness([{ id: "a", target: { kind: "actor", developerId: "dev-1" } }], (sql) => sql.includes('"outcomes"'));
    const summary = await runLakeDeletes(h.deps, { workspaceId: "ws1", budget: { maxStatements: 10, maxMs: 60_000 } });
    expect(summary.acked).toBe(0);
    expect(h.executed).toHaveLength(1);
  });
  it("stops at the statement budget and acks only what finished", async () => {
    const h = harness(Array.from({ length: 450 }, (_, i) => src(i)));
    const summary = await runLakeDeletes(h.deps, { workspaceId: "ws1", budget: { maxStatements: 2, maxMs: 60_000 } });
    expect(summary).toMatchObject({ statements: 2, halted: "budget", acked: 200 });
  });
  it("does nothing with an empty queue", async () => {
    const h = harness([]);
    expect(await runLakeDeletes(h.deps, { workspaceId: "ws1", budget: { maxStatements: 2, maxMs: 1000 } })).toEqual({ statements: 0, acked: 0, failed: 0 });
  });
});
