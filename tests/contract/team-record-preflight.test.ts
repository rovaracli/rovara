// Lane fix/0513-embedder-3gb: before the first Team record build, a table left by a rolled-back try is found and named, not discovered as "already exists" in the middle of a deploy
// (staging, 2026-11-10: agentx-staging-team-record, deletion protection on, 0 items). The check is read-only, runs only while the control plane has no Team record, and never deletes.
import { describe, expect, it } from "vitest";
import { runConfigSet } from "../../packages/cli/src/config/commands.js";
import { dynamoTeamRecordProbe } from "../../packages/cli/src/deploy/team-record-probe.js";
import { NEW_RESOURCE_RUNBOOK, teamRecordPreflight, type TeamRecordProbe } from "../../packages/cli/src/deploy/team-record-preflight.js";
import { readTeamRecordRecord } from "../../packages/cli/src/deploy/team-record-switch.js";
import { readEnvironmentSettings, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { seeded, services, stacks } from "../support/config-services.js";

const ENV = "staging";
const TABLE = "agentx-staging-team-record";
const probeOf = (answer: Awaited<ReturnType<TeamRecordProbe["tableState"]>> | "throws"): TeamRecordProbe & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, tableState: async (name) => { asked.push(name); if (answer === "throws") throw new Error("network"); return answer; } };
};

describe("teamRecordPreflight", () => {
  it("refuses with the table's name, what it holds and the fix, when the table exists and the record is not built", async () => {
    const probe = probeOf({ exists: true, itemCount: 0, deletionProtected: true });
    const result = await teamRecordPreflight({ env: ENV, built: false, probe });
    expect(probe.asked).toEqual([TABLE]);
    expect(result.warnings).toEqual([]);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain(`${TABLE} exists (0 items, deletion protection on)`);
    expect(result.refusals[0]).toMatch(/left over from an earlier try.*turn off its deletion protection.*if it holds data, do not delete it/s);
  });

  it("passes when the table is absent, and does not even ask when the record is built (the table is the record's own)", async () => {
    expect(await teamRecordPreflight({ env: ENV, built: false, probe: probeOf({ exists: false }) })).toEqual({ refusals: [], warnings: [] });
    const built = probeOf({ exists: true, itemCount: 9 });
    expect(await teamRecordPreflight({ env: ENV, built: true, probe: built })).toEqual({ refusals: [], warnings: [] });
    expect(built.asked).toEqual([]);
  });

  it("warns, and does not refuse, when the probe cannot tell (no probe, no permission, a network fault)", async () => {
    for (const probe of [undefined, probeOf(undefined), probeOf("throws")]) {
      const result = await teamRecordPreflight({ env: ENV, built: false, probe });
      expect(result.refusals).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(NEW_RESOURCE_RUNBOOK);
    }
  });
});

describe("the DynamoDB probe", () => {
  const clientOf = (reply: () => unknown) => ({ send: async (command: { input: { TableName: string } }) => { expect(command.input.TableName).toBe(TABLE); return reply(); } });

  it("reads one table: exists with its count and protection, or absent on ResourceNotFoundException, or unknown on any other fault", async () => {
    expect(await dynamoTeamRecordProbe(clientOf(() => ({ Table: { ItemCount: 3, DeletionProtectionEnabled: true } })) as never).tableState(TABLE)).toEqual({ exists: true, itemCount: 3, deletionProtected: true });
    expect(await dynamoTeamRecordProbe(clientOf(() => { throw Object.assign(new Error("x"), { name: "ResourceNotFoundException" }); }) as never).tableState(TABLE)).toEqual({ exists: false });
    expect(await dynamoTeamRecordProbe(clientOf(() => { throw Object.assign(new Error("x"), { name: "AccessDeniedException" }); }) as never).tableState(TABLE)).toBeUndefined();
  });
});

describe("agentx config set teamRecord.enabled 1", () => {
  async function ready(controlPlane: Record<string, string>, probe: TeamRecordProbe) {
    const store = await seeded();
    const settings = (await readEnvironmentSettings(store, ENV))!;
    await writeEnvironmentSettings(store, { ...settings, engine: "cdk", cloud: true });
    const configured = services({ store, stacks: stacks({ "agentx-staging-control-plane": controlPlane }), teamRecordProbe: probe });
    await runConfigSet(configured, ENV, { key: "teamRecord.options", value: "default", yes: true });
    return { store, configured };
  }

  it("stops on a left-over table before recording anything", async () => {
    const { store, configured } = await ready({}, probeOf({ exists: true, itemCount: 0, deletionProtected: true }));
    await expect(runConfigSet(configured, ENV, { key: "teamRecord.enabled", value: "1", yes: true })).rejects.toThrow(/agentx-staging-team-record exists/);
    expect((await readTeamRecordRecord(store, ENV))?.enabled).toBe(false);
  });

  it("records the choice when the account is clear, and points to the limits runbook", async () => {
    const { store, configured } = await ready({}, probeOf({ exists: false }));
    expect(await runConfigSet(configured, ENV, { key: "teamRecord.enabled", value: "1", yes: true })).toEqual({ changed: true });
    expect((await readTeamRecordRecord(store, ENV))?.enabled).toBe(true);
    expect(configured.lines.join("\n")).toContain(NEW_RESOURCE_RUNBOOK);
  });

  it("a retry after a rollback (already recorded as on) is checked too", async () => {
    const { store, configured } = await ready({}, probeOf({ exists: false }));
    await runConfigSet(configured, ENV, { key: "teamRecord.enabled", value: "1", yes: true });
    const orphaned = services({ store, stacks: stacks({ "agentx-staging-control-plane": {} }), teamRecordProbe: probeOf({ exists: true, itemCount: 0 }) });
    await expect(runConfigSet(orphaned, ENV, { key: "teamRecord.enabled", value: "1", yes: true })).rejects.toThrow(/left over from an earlier try/);
  });
});
