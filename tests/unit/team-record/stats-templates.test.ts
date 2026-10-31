import { describe, expect, it } from "vitest";
import { createLakeClient, type AthenaPort } from "../../../packages/broker/src/team-record/lake.js";
import { STATS_TEMPLATE_NAMES, buildStats, runStats, type HotStatsSource } from "../../../packages/broker/src/team-record/stats-templates.js";

const caller = { workspaceId: "ws1", project: "p1" };
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

describe("stats templates", () => {
  it.each(STATS_TEMPLATE_NAMES)("%s binds workspace and project from the caller as the first two parameters and reads project-wide rows only", (name) => {
    const { sql, parameters } = buildStats("rovara-lake", caller, name, {}, NOW);
    expect(parameters[0]).toBe("'ws1'");
    expect(parameters[1]).toBe("'p1'");
    expect(sql).toContain('"workspace_id" = ?');
    expect(sql).toContain('"project" = ?');
    if (name !== "rovara_merge_rate") expect(sql).toContain(`"audience_kind" = 'project'`);
    expect(sql.match(/\?/g)).toHaveLength(parameters.length);
  });

  it("defaults the window to the 90 days before now and binds it as timestamps", () => {
    const { parameters } = buildStats("rovara-lake", caller, "send_backs_by_stage", {}, NOW);
    expect(parameters[2]).toBe("CAST('2026-03-03 12:00:00.000' AS TIMESTAMP)");
    expect(parameters[3]).toBe("CAST('2026-06-01 12:00:00.000' AS TIMESTAMP)");
  });

  it("will not let params name a workspace or project, or add anything else", () => {
    expect(() => buildStats("rovara-lake", caller, "send_backs_by_stage", { workspace_id: "other" }, NOW)).toThrow(/not valid/);
    expect(() => buildStats("rovara-lake", caller, "send_backs_by_stage", { project: "other" }, NOW)).toThrow(/not valid/);
    expect(() => buildStats("rovara-lake", caller, "rovara_merge_rate", { limit: 5 }, NOW)).toThrow(/not valid/);
  });

  it("refuses an unknown template and a caller whose ids are not safe", () => {
    expect(() => buildStats("rovara-lake", caller, "select * from events", {}, NOW)).toThrow(/unknown template/);
    expect(() => buildStats("rovara-lake", { workspaceId: "ws1' OR '1'='1", project: "p1" }, "send_backs_by_stage", {}, NOW)).toThrow(/safe id/);
  });

  it("keeps injection text in a parameter or refuses it, never in the statement", () => {
    expect(() => buildStats("rovara-lake", caller, "send_backs_by_stage", { since: "2026-01-01T00:00:00Z' OR '1'='1" }, NOW)).toThrow(/not a date|ISO/);
    expect(() => buildStats("rovara-lake", caller, "send_backs_by_stage", { limit: "5; DROP" }, NOW)).toThrow(/not valid/);
    const { sql } = buildStats("rovara-lake", caller, "send_backs_by_stage", { limit: 7 }, NOW);
    expect(sql.endsWith("LIMIT 7")).toBe(true);
  });

  it("bounds the window and the limit", () => {
    expect(() => buildStats("rovara-lake", caller, "send_backs_by_stage", { since: "2020-01-01T00:00:00Z" }, NOW)).toThrow(/400 days/);
    expect(() => buildStats("rovara-lake", caller, "send_backs_by_stage", { since: "2026-07-01T00:00:00Z" }, NOW)).toThrow(/before until/);
    expect(() => buildStats("rovara-lake", caller, "send_backs_by_stage", { limit: 201 }, NOW)).toThrow(/not valid/);
  });

  it("runs the statement through the lake client and returns its rows", async () => {
    const seen: Array<{ workGroup: string; executionParameters: string[] }> = [];
    const athena: AthenaPort = {
      startQuery: async (r) => { seen.push(r); return { queryExecutionId: "q" }; },
      getQueryState: async () => ({ state: "SUCCEEDED" }),
      getResults: async () => ({ columns: ["group", "count"], rows: [["plan", "4"]] }),
      stopQuery: async () => undefined,
    };
    const lake = createLakeClient({ athena, workGroup: "wg", now: () => NOW });
    const hot: HotStatsSource = { groupedCounts: async () => [], mergeTotals: async () => ({ tasks: 0, merged: 0, reverted: 0, send_backs: 0 }) };
    expect(await runStats({ lake, tableBucket: "rovara-lake", hot }, caller, "send_backs_by_stage", {})).toEqual({ rows: [{ group: "plan", count: "4" }], truncated: false, lake: "ok", hot: true });
    expect(seen[0]!.workGroup).toBe("wg");
    expect(seen[0]!.executionParameters[0]).toBe("'ws1'");
  });
});

describe("recent and archived data together (I-9)", () => {
  const lakeReturning = (rows: Array<Array<string | null>>, columns: string[], fail = false) =>
    createLakeClient({
      now: () => NOW,
      athena: {
        startQuery: async () => { if (fail) throw new Error("down"); return { queryExecutionId: "q" }; },
        getQueryState: async () => ({ state: "SUCCEEDED" }),
        getResults: async () => ({ columns, rows }),
        stopQuery: async () => undefined,
      },
      workGroup: "wg",
    });
  const hot = (over: Partial<HotStatsSource> = {}): HotStatsSource => ({
    groupedCounts: async () => [{ group: "plan", count: 3 }, { group: "build", count: 1 }],
    mergeTotals: async () => ({ tasks: 4, merged: 3, reverted: 1, send_backs: 2 }),
    ...over,
  });

  it("I-9: the recent side is read by default: an empty lake still shows what happened in the last 90 days", async () => {
    const out = await runStats({ lake: lakeReturning([], ["group", "count"]), tableBucket: "rovara-lake", hot: hot() }, caller, "send_backs_by_stage", {});
    expect(out.rows).toEqual([{ group: "plan", count: "3" }, { group: "build", count: "1" }]);
    expect(out.hot).toBe(true);
  });
  it("I-9: a call without the recent side is a type error and fails at run time (no lake-only path)", async () => {
    // @ts-expect-error hot is required
    await expect(runStats({ lake: lakeReturning([], ["group", "count"]), tableBucket: "rovara-lake" }, caller, "send_backs_by_stage", {})).rejects.toThrow();
  });
  it("adds the recent counts to the archived ones, per group, and orders and limits the result", async () => {
    const out = await runStats({ lake: lakeReturning([["plan", "10"], ["review", "2"]], ["group", "count"]), tableBucket: "rovara-lake", hot: hot() }, caller, "send_backs_by_stage", { limit: 2 });
    expect(out).toMatchObject({ lake: "ok", hot: true, rows: [{ group: "plan", count: "13" }, { group: "review", count: "2" }] });
  });
  it("asks the lake for up to 200 groups so the merge is exact, and the recent side for the same window and project", async () => {
    const seen: string[] = [];
    const hotSeen: unknown[] = [];
    const lake = createLakeClient({ now: () => NOW, workGroup: "wg", athena: {
      startQuery: async (r) => { seen.push(r.sql); return { queryExecutionId: "q" }; },
      getQueryState: async () => ({ state: "SUCCEEDED" }), getResults: async () => ({ columns: ["group", "count"], rows: [] }), stopQuery: async () => undefined } });
    await runStats({ lake, tableBucket: "rovara-lake", hot: hot({ groupedCounts: async (r) => { hotSeen.push(r); return []; } }) }, caller, "send_backs_by_stage", { limit: 5 });
    expect(seen[0]!.endsWith("LIMIT 200")).toBe(true);
    expect(hotSeen[0]).toMatchObject({ workspaceId: "ws1", project: "p1", template: "send_backs_by_stage", since: "2026-03-03T12:00:00Z", until: "2026-06-01T12:00:00Z" });
  });
  it("sums merge-rate totals from both sides", async () => {
    const out = await runStats({ lake: lakeReturning([["5", "4", "0", "7"]], ["tasks", "merged", "reverted", "send_backs"]), tableBucket: "rovara-lake", hot: hot() }, caller, "rovara_merge_rate", {});
    expect(out.rows).toEqual([{ tasks: "9", merged: "7", reverted: "1", send_backs: "9" }]);
  });
  it("shows the recent data with a flag when the lake is down, and fails when the recent side fails", async () => {
    const out = await runStats({ lake: lakeReturning([], [], true), tableBucket: "rovara-lake", hot: hot() }, caller, "send_backs_by_stage", {});
    expect(out).toMatchObject({ lake: "unavailable", hot: true, rows: [{ group: "plan", count: "3" }, { group: "build", count: "1" }] });
    await expect(runStats({ lake: lakeReturning([], ["group", "count"]), tableBucket: "rovara-lake", hot: hot({ groupedCounts: async () => { throw new Error("x"); } }) }, caller, "send_backs_by_stage", {})).rejects.toThrow();
  });
  it("still refuses bad params before any call", async () => {
    await expect(runStats({ lake: lakeReturning([], []), tableBucket: "rovara-lake", hot: hot() }, caller, "send_backs_by_stage", { project: "other" })).rejects.toThrow(/not valid/);
  });
});
