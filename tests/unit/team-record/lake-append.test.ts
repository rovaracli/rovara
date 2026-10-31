import { describe, expect, it } from "vitest";
import { appendRows, toLakeFactRow, toLakeOutcomeRow } from "../../../packages/broker/src/team-record/lake-append.js";
import type { LakeClient } from "../../../packages/broker/src/team-record/lake.js";
import { scopeHash } from "../../../packages/broker/src/team-record/lake-sql.js";
import type { RecordFactLike } from "../../../packages/broker/src/team-record/shared-types.js";

const fact: RecordFactLike = { id: "f1", workspaceId: "ws1", project: "p1", kind: "decision", text: "We use withRetry.", links: ["https://x.test/1"], derivedFrom: ["e1"], trust: "member", audience: { kind: "project" }, createdAt: "2026-05-01T00:00:00Z" };

describe("lake append (outcomes and facts)", () => {
  it("builds fact rows with the scope hash when the sources share one place, and without it otherwise", () => {
    expect(toLakeFactRow(fact, "github:repo/1").scope_hash).toBe(scopeHash("github:repo/1"));
    expect(toLakeFactRow(fact).scope_hash).toBeNull();
  });
  it("builds outcome rows", () => {
    expect(toLakeOutcomeRow({ id: "o1", workspaceId: "ws1", taskId: "t1", outcome: "merged", occurredAt: "2026-05-01T00:00:00Z", merged: true, sendBacks: 1 })).toMatchObject({ outcome: "merged", merged: true, send_backs: 1, reverted: null });
  });
  it("writes in batches with INSERT ... NOT EXISTS", async () => {
    const sql: string[] = [];
    const lake: LakeClient = { now: () => 0, query: async () => ({ rows: [], truncated: false }), execute: async (s) => { sql.push(s); } };
    const rows = Array.from({ length: 25 }, (_, i) => toLakeFactRow({ ...fact, id: `f${i}` }));
    expect(await appendRows({ lake, tableBucket: "rovara-lake" }, "facts", rows)).toEqual({ written: 25 });
    expect(sql).toHaveLength(3);
    expect(sql.every((s) => s.includes("WHERE NOT EXISTS"))).toBe(true);
  });
});
