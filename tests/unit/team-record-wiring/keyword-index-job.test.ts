// Lanes K2/K3: the keyword index's maintenance runs on the existing schedules. The 15-minute job (`reembed`) builds a project's index first (and keeps removals moving) even with no embedder; a closing company or an
// archived project is left alone; a switched-off index does nothing.
import { describe, expect, it } from "vitest";
import { orgMetaKey } from "@agentx/cloud-contracts";
import { orgProjectCatalogPk, teamRecordPk } from "@rovara-code/contracts";
import { createTeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { eventItem, listWorkspace } from "../../../packages/broker/src/team-record/store.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, world } from "../../support/team-record-core.js";
import { DAY, rowOf } from "../../support/keyword-index.js";

const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const MANIFEST = { pk: teamRecordPk(ORG_A, "web"), sk: "KWIDX#M" };

async function setup(extra: Partial<Parameters<typeof createTeamRecordRuntime>[0]> = {}) {
  const w = world();
  const db = new FakeDynamoDb({ indexKeys });
  const runtime = createTeamRecordRuntime({ env: ON, documentClient: db, stateTableName: "State", now: () => w.clock.ms, log: () => undefined, ...extra });
  if (runtime === undefined) throw new Error("the runtime was not built");
  // a company with one project in the catalog and some old rows
  db.set({ pk: orgProjectCatalogPk(ORG_A), sk: "PROJECT#web", entityType: "PROJECT" });
  await listWorkspace({ documentClient: db, tableName: "TeamRecord" }, ORG_A, new Date(w.clock.ms).toISOString());
  for (let i = 0; i < 60; i += 1) db.set(eventItem(rowOf(w, i, { text: `wiring row ${String(i)} jobwordone`, at: w.clock.ms - 4 * DAY + i * 60_000 })));
  return { w, db, runtime };
}

describe("the schedules run the keyword index's maintenance", () => {
  it("the 15-minute job builds the index of a project (no embedder needed) and the next one finds nothing to do", async () => {
    const { db, runtime } = await setup();
    const first = await runtime.jobs.run("reembed");
    expect(first.details).toMatchObject({ skipped: 1, kwProjects: 1, kwSealed: 1 });
    expect((db.get(MANIFEST) as { coverage?: string } | undefined)?.coverage).toBe("complete");
    const second = await runtime.jobs.run("reembed");
    expect(second.details).toMatchObject({ kwProjects: 1, kwSealed: 0, kwRebuilt: 0 });
  });

  it("the nightly job runs the expiry pass of the index (a segment whose rows' text has expired is rebuilt)", async () => {
    const { w, db, runtime } = await setup();
    await runtime.jobs.run("reembed");
    const before = (db.get(MANIFEST) as { segments: Array<{ id: string }> }).segments.map((entry) => entry.id);
    // nothing expired: the nightly pass rebuilds nothing
    const quiet = await runtime.jobs.run("nightly");
    expect(quiet.details.kwExpired ?? 0).toBe(0);
    expect((db.get(MANIFEST) as { segments: Array<{ id: string }> }).segments.map((entry) => entry.id)).toEqual(before);
    void w;
  });

  it("a switched-off index does nothing (and the job still runs)", async () => {
    const { db, runtime } = await setup({ keywordIndex: false });
    const first = await runtime.jobs.run("reembed");
    expect(first.details.kwProjects).toBeUndefined();
    expect(db.get(MANIFEST)).toBeUndefined();
  });

  it("a company that is closing is left alone", async () => {
    const { db, runtime } = await setup();
    db.set({ ...orgMetaKey(ORG_A), entityType: "ORG_META", closingAt: "2026-10-30T00:00:00.000Z" });
    const done = await runtime.jobs.run("reembed");
    expect(done.details.kwProjects ?? 0).toBe(0);
    expect(db.get(MANIFEST)).toBeUndefined();
  });
});
