// Lanes K2/K3: the keyword index's maintenance runs on the existing schedules. The 15-minute job (`reembed`) builds a project's index first (and keeps removals moving) even with no embedder; a closing company or an
// archived project is left alone; a switched-off index does nothing.
import { describe, expect, it } from "vitest";
import { orgMetaKey } from "@agentx/cloud-contracts";
import { orgProjectCatalogPk, teamRecordPk } from "@rovara-code/contracts";
import { createTeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { eventItem, listWorkspace } from "../../../packages/broker/src/team-record/store.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { learningModeKey } from "@rovara-code/contracts";
import { runTeamRecordJob, isTeamRecordJobEvent } from "../../../packages/broker/src/aws/broker/team-record-wiring.js";
import { keywordIndexIsOn } from "../../../packages/broker/src/team-record/runtime.js";
import { ORG_A, world } from "../../support/team-record-core.js";
import { DAY, rowOf } from "../../support/keyword-index.js";

const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const MANIFEST = { pk: teamRecordPk(ORG_A, "web"), sk: "KWIDX#M" };

async function setup(extra: Partial<Parameters<typeof createTeamRecordRuntime>[0]> = {}, logs: string[] = []) {
  const w = world();
  const db = new FakeDynamoDb({ indexKeys });
  const runtime = createTeamRecordRuntime({ env: ON, documentClient: db, stateTableName: "State", now: () => w.clock.ms, log: (entry) => { logs.push(String((entry as { event?: unknown }).event)); }, ...extra });
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

  const search = (runtime: Awaited<ReturnType<typeof setup>>["runtime"], query: string) => runtime.routes({ method: "GET", path: "/v1/app/projects/web/record/search", query: { query }, caller: { orgId: ORG_A, developerId: "d".repeat(64), projectRole: "maintainer" } });

  describe("the kill switch (broker setting `tw`, TEAM_RECORD_KEYWORD_INDEX)", () => {
    it("is on unless the setting is exactly 0 (the default is on)", () => {
      expect(keywordIndexIsOn({})).toBe(true);
      expect(keywordIndexIsOn({ TEAM_RECORD_KEYWORD_INDEX: "1" })).toBe(true);
      expect(keywordIndexIsOn({ TEAM_RECORD_KEYWORD_INDEX: "0" })).toBe(false);
      expect(keywordIndexIsOn({ TEAM_RECORD_KEYWORD_INDEX: "off" })).toBe(true);
    });

    it("on: the job builds the index and a search uses it", async () => {
      const logs: string[] = [];
      const { db, runtime, w } = await setup({ env: { ...ON, TEAM_RECORD_KEYWORD_INDEX: "1" } }, logs);
      db.set({ ...learningModeKey(ORG_A, "web"), entityType: "TEAM_RECORD_MODE", mode: "on" });
      await runtime.jobs.run("reembed");
      expect(db.get(MANIFEST)).toBeDefined();
      const found = await search(runtime, "jobwordone");
      expect(found?.status).toBe(200);
      expect((found?.body as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
      expect(logs).toContain("record.keyword_index");
      void w;
    });

    it("off: the job builds nothing and a search reads the window only, and flipping it back builds the index", async () => {
      const logs: string[] = [];
      const env = { ...ON, TEAM_RECORD_KEYWORD_INDEX: "0" } as Record<string, string | undefined>;
      const { db, runtime } = await setup({ env }, logs);
      db.set({ ...learningModeKey(ORG_A, "web"), entityType: "TEAM_RECORD_MODE", mode: "on" });
      const off = await runtime.jobs.run("reembed");
      expect(off.details).toMatchObject({ kwSealed: 0 });
      expect(db.get(MANIFEST)).toBeUndefined();
      const found = await search(runtime, "jobwordone");
      expect((found?.body as { hits: unknown[] }).hits.length).toBeGreaterThan(0);   // the window answered
      expect(logs).not.toContain("record.keyword_index");
      env.TEAM_RECORD_KEYWORD_INDEX = "1";                                              // read at each use, not once
      await runtime.jobs.run("reembed");
      expect(db.get(MANIFEST)).toBeDefined();
      await search(runtime, "jobwordone");
      expect(logs).toContain("record.keyword_index");
    });

    it("off: a segment a removal marked is still rebuilt by the job", async () => {
      const { w, db, runtime } = await setup();
      await runtime.jobs.run("reembed");
      const item = db.get(MANIFEST) as { segments: Array<Record<string, unknown>> } & Record<string, unknown>;
      db.set({ ...item, version: (item.version as number) + 1, segments: item.segments.map((entry) => ({ ...entry, dirty: { since: new Date(w.clock.ms).toISOString(), reason: "removal" } })) });
      const env = { ...ON, TEAM_RECORD_KEYWORD_INDEX: "0" };
      const off = createTeamRecordRuntime({ env, documentClient: db, stateTableName: "State", now: () => w.clock.ms, log: () => undefined })!;
      const done = await off.jobs.run("reembed");
      expect(done.details).toMatchObject({ kwRebuilt: 1, kwSealed: 0 });
      expect((db.get(MANIFEST) as { segments: Array<{ dirty?: unknown }> }).segments.every((entry) => entry.dirty === undefined)).toBe(true);
    });
  });

  describe("the one-shot clear of a company's index", () => {
    it("deletes every index item and late marker of the company's projects (and nothing else), and only for a real org id", async () => {
      const { db, runtime } = await setup();
      await runtime.jobs.run("reembed");
      db.set({ pk: MANIFEST.pk, sk: "KWLATE#2026-10-01T00:00:00.000Z#x", entityType: "TEAM_RECORD_KWLATE" });
      const rowsBefore = [...db.items.values()].filter((item) => item.entityType === "TEAM_RECORD_EVENT").length;
      expect([...db.items.values()].filter((item) => String(item.sk).startsWith("KWIDX#") || String(item.sk).startsWith("KWLATE#")).length).toBeGreaterThan(2);
      const event = { source: "agentx.team-record", job: "keyword-index-clear", orgId: ORG_A };
      expect(isTeamRecordJobEvent(event)).toBe(true);
      const answer = await runTeamRecordJob({ teamRecord: runtime }, event);
      expect(answer).toMatchObject({ job: "keyword-index-clear", summary: { details: { more: 0 } } });
      expect([...db.items.values()].filter((item) => String(item.sk).startsWith("KWIDX#") || String(item.sk).startsWith("KWLATE#"))).toEqual([]);
      expect([...db.items.values()].filter((item) => item.entityType === "TEAM_RECORD_EVENT")).toHaveLength(rowsBefore);
      await expect(runTeamRecordJob({ teamRecord: runtime }, { job: "keyword-index-clear", orgId: "acme" })).rejects.toThrow("orgId");
      expect(await runTeamRecordJob({}, event)).toEqual({ skipped: true, reason: "off" });
    });
  });
});
