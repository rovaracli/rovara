import { describe, expect, it } from "vitest";
import { createLakeClient, type AthenaPort } from "../../../packages/broker/src/team-record/lake.js";
import { STATS_TEMPLATE_NAMES, buildStats, runStats } from "../../../packages/broker/src/team-record/stats-templates.js";

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
    expect(await runStats({ lake, tableBucket: "rovara-lake" }, caller, "send_backs_by_stage", {})).toEqual({ rows: [{ group: "plan", count: "4" }], truncated: false });
    expect(seen[0]!.workGroup).toBe("wg");
    expect(seen[0]!.executionParameters[0]).toBe("'ws1'");
  });
});
