// 057 lane, SRL-6, the whole path: a real team-record runtime's hourly job fails its erase second pass -> the runtime counts it -> `runtime.opsFailures` -> the health probe -> the admin
// health route (the same wiring `aws/broker.ts` passes: `teamRecordFailures: (orgId) => teamRecord.opsFailures(orgId)`), and the web admin page's route (`readOrgServiceStatus`).
import { describe, expect, it } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { developerOrgKey, orgMemberKey, orgMetaKey, teamRecordOrgDirectoryKey } from "@agentx/cloud-contracts";
import { healthProbes } from "../../../packages/broker/src/aws/health-probes.js";
import { readOrgServiceStatus } from "../../../packages/broker/src/org/service-status.js";
import { createTeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { createAdminReadBroker } from "../../support/admin-read-broker.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { TEST_ORG } from "../../support/orgs.js";
import { ORG_B, T0 } from "../../support/team-record-core.js";

const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;

function runtimeWithBrokenSweep() {
  const db = new FakeDynamoDb({ indexKeys });
  db.set({ ...teamRecordOrgDirectoryKey(TEST_ORG), entityType: "TEAM_RECORD_ORG", orgId: TEST_ORG, at: "2026-10-30T10:00:00.000Z" });
  const state = { broken: true };
  const documentClient = { send: async (command: unknown) => {
    if (state.broken && command instanceof QueryCommand && JSON.stringify((command as { input?: unknown }).input).includes("ERASESWEEP#")) throw new Error("secret detail from the table");
    return db.send(command as never);
  } };
  const runtime = createTeamRecordRuntime({ env: ON, documentClient, stateTableName: "State", now: () => T0 });
  if (runtime === undefined) throw new Error("the runtime was not built");
  return { db, runtime, state };
}

describe("a failed erase second pass reaches the admin health answer", () => {
  it("through the runtime's own counter, the probe and the admin route; and only for that company", async () => {
    const { runtime, state } = runtimeWithBrokenSweep();
    const probes = healthProbes({ cloudWatch: { send: async () => ({}) } as never, sqs: { send: async () => ({}) } as never, github: { installationCount: async () => 1 }, log: () => undefined, teamRecordFailures: (orgId) => runtime.opsFailures(orgId) });
    const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: probes } } });
    // positive control: before any failure the row says all clear
    expect((await admin("GET", "/v1/admin/health")).body.teamRecordCheck).toEqual({ status: "ok", detail: "no erase or source delete failures in the last 24 hours" });
    const summary = await runtime.jobs.run("hourly");
    expect(summary.details.sweepFailed).toBe(1);
    const body = (await admin("GET", "/v1/admin/health")).body;
    expect(body.teamRecordCheck).toEqual({ status: "warn", detail: `1 erase second pass failed or stuck in the last 24 hours; latest ${new Date(T0).toISOString()}` });
    expect(JSON.stringify(body)).not.toContain("secret detail");
    // the other company has none
    expect(await runtime.opsFailures(ORG_B)).toEqual({ eraseSweep: 0, tombstone: 0 });
    state.broken = false;
  });

  it("and to the web admin page's route (company admins only, own company)", async () => {
    const { db, runtime } = runtimeWithBrokenSweep();
    await runtime.jobs.run("hourly");
    const developerId = "a".repeat(64);
    const state = new FakeDynamoDb();
    state.set({ ...orgMetaKey(TEST_ORG), orgId: TEST_ORG });
    state.set({ ...orgMemberKey(TEST_ORG, developerId), orgId: TEST_ORG, developerId, role: "owner" });
    state.set({ ...developerOrgKey(developerId), orgId: TEST_ORG, role: "owner" });
    state.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "cloud", revoked: false });
    const deps = { documentClient: state, tableName: "state", signInTableName: "signin", now: () => T0, runtimeStatus: async () => ({ rows: [], malformedKinds: [] as string[] }) };
    const caller = { orgId: TEST_ORG, developerId, browserSession: true as const };
    // without the probe (the record is off) the answer has no such row
    expect(await readOrgServiceStatus(deps, caller, { expectedOrgId: TEST_ORG })).not.toHaveProperty("teamRecord");
    const answer = await readOrgServiceStatus({ ...deps, teamRecordFailures: (orgId) => runtime.opsFailures(orgId) }, caller, { expectedOrgId: TEST_ORG });
    expect(answer.teamRecord).toEqual({ status: "warn", detail: `1 erase second pass failed or stuck in the last 24 hours; latest ${new Date(T0).toISOString()}` });
    // a probe that fails is unknown, never healthy and never a failed page
    const unknown = await readOrgServiceStatus({ ...deps, teamRecordFailures: async () => { throw new Error("secret detail"); } }, caller, { expectedOrgId: TEST_ORG });
    expect(unknown.teamRecord).toEqual({ status: "unknown", detail: "could not read the delete and erase failures" });
    void db;
  });
});
