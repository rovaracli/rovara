import { LAKE_TABLES } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import {
  actorSourceHash, allLakeColumns, buildInsertIfAbsent, scopeHash, columnNames, deleteLiteral, parameterFor, sourceHash, sqlString, tableRef, timestampText,
} from "../../../packages/broker/src/team-record/lake-sql.js";
import { createLakeClient, LakeError, type AthenaPort } from "../../../packages/broker/src/team-record/lake.js";

const eventRow = (over: Record<string, string | number | boolean | null> = {}) => ({
  workspace_id: "ws1", occurred_at: "2026-01-02T03:04:05Z", id: "e1", source: "github", source_system: "github", source_hash: sourceHash("github", "1"),
  kind: "github.pr", trust: "member", audience_kind: "project", retention: "D", archived_at: "2026-05-01T00:00:00Z", scope_hash: scopeHash("github:repo/1"), ...over,
});

describe("sql literals", () => {
  it("doubles quotes and refuses control characters", () => {
    expect(sqlString("a'b")).toBe("'a''b'");
    expect(sqlString("x'); DROP TABLE events; --")).toBe("'x''); DROP TABLE events; --'");
    expect(() => sqlString("a\u0000b")).toThrow(/control/);
    expect(() => sqlString("a\nb")).toThrow(/control/);
  });
  it("accepts only real ISO-8601 UTC timestamps", () => {
    expect(timestampText("2026-01-02T03:04:05Z")).toBe("2026-01-02 03:04:05.000");
    expect(timestampText("2026-01-02T03:04:05.25Z")).toBe("2026-01-02 03:04:05.250");
    expect(() => timestampText("2026-02-30T00:00:00Z")).toThrow(/real date/);
    expect(() => timestampText("2026-01-02 03:04:05")).toThrow(/ISO/);
    expect(() => timestampText("2026-01-02T03:04:05Z' OR '1'='1")).toThrow(/ISO/);
  });
  it("types a null so VALUES never has an unknown column", () => {
    expect(parameterFor("string", null)).toBe("CAST(NULL AS VARCHAR)");
    expect(parameterFor("timestamp", null)).toBe("CAST(NULL AS TIMESTAMP)");
    expect(parameterFor("int", 3)).toBe("CAST(3 AS INTEGER)");
    expect(() => parameterFor("int", 1.5)).toThrow(/whole/);
    expect(() => parameterFor("boolean", "true")).toThrow(/boolean/);
  });
  it("allows only safe ids and sha256 hashes in DELETE", () => {
    expect(deleteLiteral("ws-1", "id")).toBe("'ws-1'");
    expect(deleteLiteral(sourceHash("slack", "T1/C1/1.2"), "hash")).toMatch(/^'[0-9a-f]{64}'$/);
    for (const bad of ["a' OR '1'='1", "a b", "", "x;DELETE", "é"]) expect(() => deleteLiteral(bad, "id")).toThrow(/safe id/);
    expect(() => deleteLiteral("abc", "hash")).toThrow(/hash/);
  });
  it("builds table references only for known tables and valid bucket names", () => {
    expect(tableRef("rovara-lake", "events")).toBe('"s3tablescatalog/rovara-lake"."record"."events"');
    expect(() => tableRef('x" OR 1=1 --', "events")).toThrow(/not valid/);
    expect(() => tableRef("rovara-lake", "users" as never)).toThrow(/unknown table/);
  });
});

describe("insert if absent", () => {
  it("binds every value as a parameter, never into the SQL text, and checks existence by workspace and id", () => {
    const { sql, parameters } = buildInsertIfAbsent("rovara-lake", "events", [eventRow({ text: "it's secret'); DROP" }), eventRow({ id: "e2" })]);
    expect(sql).not.toContain("secret");
    expect(sql).toContain("WHERE NOT EXISTS");
    expect(sql).toContain('t."workspace_id" = s."workspace_id" AND t."id" = s."id"');
    expect(sql.match(/\?/g)).toHaveLength(parameters.length);
    expect(parameters).toHaveLength(2 * columnNames("events").length);
    expect(parameters).toContain("'it''s secret''); DROP'");
  });
  it("refuses an unknown column, a missing required column and an empty batch", () => {
    expect(() => buildInsertIfAbsent("rovara-lake", "events", [eventRow({ nope: "x" })])).toThrow(/not a column/);
    expect(() => buildInsertIfAbsent("rovara-lake", "events", [eventRow({ workspace_id: null })])).toThrow(/required/);
    expect(() => buildInsertIfAbsent("rovara-lake", "events", [])).toThrow(/no rows/);
  });
});

describe("schema agreement", () => {
  it("has lowercase unique column names and ids, with the partition columns present", () => {
    for (const table of LAKE_TABLES) {
      const names = table.columns.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      expect(new Set(table.columns.map((c) => c.id)).size).toBe(names.length);
      for (const name of names) expect(name).toBe(name.toLowerCase());
      expect(names).toContain("workspace_id");
      expect(names).toContain(table.timeColumn);
    }
  });
  it("knows every column the stats and delete SQL names", async () => {
    const { buildLakeDeletes } = await import("../../../packages/broker/src/team-record/lake-delete.js");
    const { buildStats, STATS_TEMPLATE_NAMES } = await import("../../../packages/broker/src/team-record/stats-templates.js");
    const sqls = [
      ...STATS_TEMPLATE_NAMES.map((name) => buildStats("rovara-lake", { workspaceId: "ws1", project: "p1" }, name, {}, Date.UTC(2026, 5, 1)).sql),
      ...buildLakeDeletes("rovara-lake", "ws1", [
        { id: "1", target: { kind: "source", sourceHash: sourceHash("a", "b") } }, { id: "2", target: { kind: "actor", developerId: "d1" } },
        { id: "3", target: { kind: "project", project: "p1" } }, { id: "4", target: { kind: "fact", factId: "f1" } },
        { id: "5", target: { kind: "actor_source", hash: actorSourceHash("slack", "U1") } }, { id: "6", target: { kind: "scope", hash: scopeHash("slack:T/C1") } },
      ]).map((s) => s.sql),
    ];
    const known = allLakeColumns();
    for (const sql of sqls) for (const match of sql.matchAll(/"([a-z_]+)"/g)) {
      const name = match[1]!;
      if (["group", "count", "tasks", "merged", "reverted", "send_backs", "s3tablescatalog", "record", "events", "facts", "outcomes", "lessons_history"].includes(name)) continue;
      expect(known.has(name), `${name} in ${sql}`).toBe(true);
    }
  });
});

describe("lake client", () => {
  const fake = (states: Array<"QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED">, over: Partial<AthenaPort> = {}) => {
    const started: Array<{ clientRequestToken?: string }> = [];
    let i = 0;
    const athena: AthenaPort = {
      startQuery: async (r) => { started.push(r); return { queryExecutionId: "q1" }; },
      getQueryState: async () => ({ state: states[Math.min(i++, states.length - 1)]! }),
      getResults: async () => ({ columns: ["a", "b"], rows: [["1", null], ["2", "x"]] }),
      stopQuery: async () => undefined,
      ...over,
    };
    return { athena, started };
  };
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

  it("polls to success and returns rows keyed by column", async () => {
    const { athena } = fake(["QUEUED", "RUNNING", "SUCCEEDED"]);
    const lake = createLakeClient({ athena, workGroup: "wg", ...clock() });
    expect(await lake.query("SELECT 1", [])).toEqual({ rows: [{ a: "1", b: null }, { a: "2", b: "x" }], truncated: false });
  });
  it("I-2: a data-changing statement gets a new token for every attempt, so a retry after FAILED starts a new execution; a SELECT gets none", async () => {
    // A fake that behaves like Athena: the same token returns the same (earlier) execution.
    const byToken = new Map<string, string>();
    const states = new Map<string, "FAILED" | "SUCCEEDED">();
    let n = 0;
    const athena: AthenaPort = {
      startQuery: async (r) => {
        const known = r.clientRequestToken === undefined ? undefined : byToken.get(r.clientRequestToken);
        if (known !== undefined) return { queryExecutionId: known };
        const id = `q${++n}`;
        states.set(id, n === 1 ? "FAILED" : "SUCCEEDED");
        if (r.clientRequestToken !== undefined) byToken.set(r.clientRequestToken, id);
        return { queryExecutionId: id };
      },
      getQueryState: async (id) => ({ state: states.get(id)! }),
      getResults: async () => ({ columns: [], rows: [] }),
      stopQuery: async () => undefined,
    };
    const lake = createLakeClient({ athena, workGroup: "wg", ...clock() });
    await expect(lake.execute("DELETE FROM t WHERE x", [])).rejects.toMatchObject({ code: "lake_query_failed" });
    await expect(lake.execute("DELETE FROM t WHERE x", [])).resolves.toBeUndefined();
    expect(n).toBe(2);
  });
  it("sends a 64-hex token on data changes only", async () => {
    const a = fake(["SUCCEEDED"]);
    const lake = createLakeClient({ athena: a.athena, workGroup: "wg", ...clock() });
    await lake.execute("DELETE FROM t", []);
    await lake.query("SELECT 1", []);
    expect(a.started[0]!.clientRequestToken).toMatch(/^[0-9a-f]{64}$/);
    expect(a.started[1]!.clientRequestToken).toBeUndefined();
  });
  it("turns a failed query, a failed start and a timeout into fixed codes, and stops the timed-out query", async () => {
    await expect(createLakeClient({ athena: fake(["FAILED"]).athena, workGroup: "wg", ...clock() }).query("x", [])).rejects.toMatchObject({ code: "lake_query_failed" });
    const down = fake(["SUCCEEDED"], { startQuery: async () => { throw new Error("secret sql text"); } });
    const failure = await createLakeClient({ athena: down.athena, workGroup: "wg", ...clock() }).query("x", []).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LakeError);
    expect((failure as Error).message).toBe("lake_unavailable");
    let stopped = 0;
    const slow = fake(["RUNNING"], { stopQuery: async () => { stopped += 1; } });
    await expect(createLakeClient({ athena: slow.athena, workGroup: "wg", timeoutMs: 1000, ...clock() }).query("x", [])).rejects.toMatchObject({ code: "lake_timeout" });
    expect(stopped).toBe(1);
  });
  it("truncates a result at the row cap and says so", async () => {
    const { athena } = fake(["SUCCEEDED"]);
    const lake = createLakeClient({ athena, workGroup: "wg", maxRows: 1, ...clock() });
    expect(await lake.query("x", [])).toEqual({ rows: [{ a: "1", b: null }], truncated: true });
  });
});
