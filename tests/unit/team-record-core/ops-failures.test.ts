// 057 lane, register SRL-6: erase second-pass failures and lost source deletes were only log lines (and a count in a job answer nobody reads). They are now counted per company in
// the Team record table (counts and a time only, no person, no text), and the admin Health data reads them.
import { describe, expect, it } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { ERASE_SWEEP_DELAY_MS, erasePerson, eraseWorkspace, runErasureSweeps } from "../../../packages/broker/src/team-record/erase.js";
import { opsFailuresCheck, readOpsFailures, recordOpsFailure, recordOpsLevel } from "../../../packages/broker/src/team-record/ops-failures.js";
import { createCodeHostTap, type CodeHostEvent, type CodeHostRepo } from "../../../packages/broker/src/team-record/sources/codehost.js";
import { teamRecordPk } from "@rovara-code/contracts";
import { ORG_A, ORG_B, world } from "../../support/team-record-core.js";
import { deleteDeps, seedComments } from "../../support/team-record-delete.js";
import { world as ingestWorld, WS } from "../../support/team-record-ingest-fakes.js";

const HOUR = 3_600_000;

describe("the repository check's counter (SRL-5a)", () => {
  it("counts per company under its own kind, shows only when not zero, and company B's count never appears for company A", async () => {
    const w = world();
    const t = w.clock.ms;
    await recordOpsFailure(w.table, ORG_B, "repo_check", t);
    await recordOpsFailure(w.table, ORG_B, "repo_check", t - HOUR);
    expect(await readOpsFailures(w.table, ORG_B, t)).toEqual({ eraseSweep: 0, tombstone: 0, repoCheck: 2, lastAt: new Date(t).toISOString() });
    expect(await readOpsFailures(w.table, ORG_A, t)).toEqual({ eraseSweep: 0, tombstone: 0 });
    expect(await readOpsFailures(w.table, ORG_B, t + 48 * HOUR)).toEqual({ eraseSweep: 0, tombstone: 0 });
  });
});

describe("the stuck lesson rollbacks' level (LP-13 C2)", () => {
  it("is a level, not a count: the hourly job writes how many are stuck NOW, a later hour replaces an earlier one, and it shows on the Health line only while the job keeps reporting it", async () => {
    const w = world();
    const t = w.clock.ms;
    await recordOpsLevel(w.table, ORG_A, "lesson_rollback", 2, t - 2 * HOUR);
    await recordOpsLevel(w.table, ORG_A, "lesson_rollback", 2, t - HOUR);
    await recordOpsLevel(w.table, ORG_A, "lesson_rollback", 3, t);
    // not 7: the same intents seen every hour are not counted every hour
    expect(await readOpsFailures(w.table, ORG_A, t)).toEqual({ eraseSweep: 0, tombstone: 0, lessonRollbacks: 3, lastAt: new Date(t).toISOString() });
    expect(await readOpsFailures(w.table, ORG_B, t)).toEqual({ eraseSweep: 0, tombstone: 0 });
    // the job found them mended and said 0: the line clears at once
    await recordOpsLevel(w.table, ORG_A, "lesson_rollback", 0, t + HOUR);
    expect(await readOpsFailures(w.table, ORG_A, t + HOUR)).toEqual({ eraseSweep: 0, tombstone: 0 });
    // the job stopped reporting (its last word was 3, three hours ago): the line does not stay on for ever
    await recordOpsLevel(w.table, ORG_B, "lesson_rollback", 3, t);
    expect(await readOpsFailures(w.table, ORG_B, t + 2 * HOUR)).toMatchObject({ lessonRollbacks: 3 });
    expect(await readOpsFailures(w.table, ORG_B, t + 4 * HOUR)).toEqual({ eraseSweep: 0, tombstone: 0 });
    for (const item of w.db.find((row) => typeof row.sk === "string" && row.sk.startsWith("OPSLEVEL#lesson_rollback#"))) expect(Object.keys(item).sort()).toEqual(["count", "entityType", "indexExpiresAt", "lastAt", "pk", "sk"]);
  });
  it("the newest level is read even when more than 100 hourly items are stored (the oldest are not what counts)", async () => {
    const w = world();
    const t = w.clock.ms;
    for (let age = 119; age >= 1; age -= 1) await recordOpsLevel(w.table, ORG_A, "lesson_rollback", 5, t - age * HOUR);
    await recordOpsLevel(w.table, ORG_A, "lesson_rollback", 2, t);
    expect(w.db.find((row) => typeof row.sk === "string" && row.sk.startsWith("OPSLEVEL#lesson_rollback#")).length).toBe(120);
    expect(await readOpsFailures(w.table, ORG_A, t)).toMatchObject({ lessonRollbacks: 2 });
  });
  it("a level has its own OPSLEVEL# prefix: a count-0 lesson_rollback row is not a failure row, and nothing is written under OPSFAIL#", async () => {
    const w = world();
    const t = w.clock.ms;
    await recordOpsLevel(w.table, ORG_A, "lesson_rollback", 0, t);
    expect(w.db.find((row) => typeof row.sk === "string" && row.sk.startsWith("OPSFAIL#"))).toStrictEqual([]);
    expect(w.db.find((row) => typeof row.sk === "string" && row.sk.startsWith("OPSLEVEL#"))).toEqual([expect.objectContaining({ entityType: "TEAM_RECORD_OPS_LEVEL", count: 0 })]);
    // Health shows it only when it is not zero
    expect(await readOpsFailures(w.table, ORG_A, t)).toEqual({ eraseSweep: 0, tombstone: 0 });
    await recordOpsLevel(w.table, ORG_A, "lesson_rollback", 2, t + HOUR);
    expect(await readOpsFailures(w.table, ORG_A, t + HOUR)).toMatchObject({ lessonRollbacks: 2 });
    // and an ordinary failure still lands under OPSFAIL#
    await recordOpsFailure(w.table, ORG_A, "tombstone", t + HOUR);
    expect(w.db.find((row) => typeof row.sk === "string" && row.sk.startsWith("OPSFAIL#"))).toHaveLength(1);
  });
  it("rollout: a level written under the old OPSFAIL#lesson_rollback# prefix (by 0.5.14) is still read, and the newer of the two wins", async () => {
    const w = world();
    const t = w.clock.ms;
    const legacy = (hoursAgo: number, count: number) => w.db.set({ pk: teamRecordPk(ORG_A), sk: `OPSFAIL#lesson_rollback#${String(Math.floor((t - hoursAgo * HOUR) / HOUR)).padStart(9, "0")}`, entityType: "TEAM_RECORD_OPS_FAILURE", count, lastAt: new Date(t - hoursAgo * HOUR).toISOString(), indexExpiresAt: Math.floor(t / 1000) + 86_400 });
    legacy(1, 4);
    expect(await readOpsFailures(w.table, ORG_A, t)).toMatchObject({ lessonRollbacks: 4 });
    // 0.5.15 reports a newer level (0): it wins over the older legacy row
    await recordOpsLevel(w.table, ORG_A, "lesson_rollback", 0, t);
    expect(await readOpsFailures(w.table, ORG_A, t)).toEqual({ eraseSweep: 0, tombstone: 0 });
    // and a newer non-zero one wins over a legacy zero
    legacy(0, 0);
    await recordOpsLevel(w.table, ORG_A, "lesson_rollback", 3, t + HOUR);
    expect(await readOpsFailures(w.table, ORG_A, t + HOUR)).toMatchObject({ lessonRollbacks: 3 });
    // a legacy row is never counted as a failure kind
    expect((await readOpsFailures(w.table, ORG_A, t)).tombstone).toBe(0);
  });
  it("a company's erase removes the level rows (OPSLEVEL#) as it removes the failure counters", async () => {
    const w = world();
    const t = w.clock.ms;
    await recordOpsLevel(w.table, ORG_A, "lesson_rollback", 2, t);
    await recordOpsFailure(w.table, ORG_A, "tombstone", t);
    await eraseWorkspace(deleteDeps(w).deps, ORG_A, [], "close-2");
    expect(w.db.find((row) => typeof row.sk === "string" && (row.sk.startsWith("OPSLEVEL#") || row.sk.startsWith("OPSFAIL#")))).toStrictEqual([]);
  });
  it("the Health line says how many, in words, and no id", () => {
    expect(opsFailuresCheck({ eraseSweep: 0, tombstone: 0, lessonRollbacks: 1 })).toEqual({ status: "warn", detail: "1 lesson rollback not finished (an administrator needs to look at the project's lessons)" });
    expect(opsFailuresCheck({ eraseSweep: 1, tombstone: 0, lessonRollbacks: 1, lastAt: "2026-11-08T10:00:00.000Z" }).detail).toBe("1 erase second pass failed or stuck in the last 24 hours; 1 lesson rollback not finished (an administrator needs to look at the project's lessons); latest 2026-11-08T10:00:00.000Z");
    expect(opsFailuresCheck({ eraseSweep: 0, tombstone: 0, lessonRollbacks: 2 }).detail).toContain("2 lesson rollbacks not finished");
  });
});

describe("the failure counters", () => {
  it("count per company and kind, window to the last 24 hours, and hold no person", async () => {
    const w = world();
    const t = w.clock.ms;
    await recordOpsFailure(w.table, ORG_A, "erase_sweep", t - 30 * HOUR); // older than the window
    await recordOpsFailure(w.table, ORG_A, "erase_sweep", t - HOUR);
    await recordOpsFailure(w.table, ORG_A, "erase_sweep", t);
    await recordOpsFailure(w.table, ORG_A, "erase_sweep", t);
    await recordOpsFailure(w.table, ORG_A, "tombstone", t);
    await recordOpsFailure(w.table, ORG_B, "tombstone", t);
    expect(await readOpsFailures(w.table, ORG_A, t)).toEqual({ eraseSweep: 3, tombstone: 1, lastAt: new Date(t).toISOString() });
    expect(await readOpsFailures(w.table, ORG_B, t)).toEqual({ eraseSweep: 0, tombstone: 1, lastAt: new Date(t).toISOString() });
    expect(await readOpsFailures(w.table, ORG_A, t + 48 * HOUR)).toEqual({ eraseSweep: 0, tombstone: 0 });
    for (const item of w.db.find((row) => typeof row.sk === "string" && row.sk.startsWith("OPSFAIL#"))) {
      expect(Object.keys(item).sort()).toEqual(["count", "entityType", "indexExpiresAt", "lastAt", "pk", "sk"]);
    }
  });

  it("never fail the caller when the table does", async () => {
    const w = world();
    const broken = { ...w.table, documentClient: { send: async () => { throw new Error("table unavailable"); } } as never };
    await expect(recordOpsFailure(broken, ORG_A, "tombstone", w.clock.ms)).resolves.toBeUndefined();
    await expect(readOpsFailures(broken, ORG_A, w.clock.ms)).rejects.toThrow();
  });

  it("go with the company on a close", async () => {
    const w = world();
    await recordOpsFailure(w.table, ORG_A, "tombstone", w.clock.ms);
    await recordOpsFailure(w.table, ORG_B, "tombstone", w.clock.ms);
    await eraseWorkspace(deleteDeps(w).deps, ORG_A, [], "close-1");
    expect((await readOpsFailures(w.table, ORG_A, w.clock.ms)).tombstone).toBe(0);
    expect((await readOpsFailures(w.table, ORG_B, w.clock.ms)).tombstone).toBe(1);
  });
});

describe("the writers", () => {
  it("a failing erase second pass is counted for its company (and the run summary still says so)", async () => {
    const w = world();
    const d = deleteDeps(w);
    const real = w.table.documentClient;
    const broken = { ...d.deps, table: { ...w.table, documentClient: { send: async (command: unknown) => {
      if (command instanceof QueryCommand && JSON.stringify((command as { input?: unknown }).input).includes("ERASESWEEP#")) throw new Error("secret detail from the table");
      return real.send(command);
    } } as never } };
    const run = await runDeleteWorker(broken, ORG_A);
    expect(run.sweepFailed).toBe(1);
    expect(await readOpsFailures(w.table, ORG_A, w.clock.ms)).toMatchObject({ eraseSweep: 1, tombstone: 0 });
    expect(await readOpsFailures(w.table, ORG_B, w.clock.ms)).toMatchObject({ eraseSweep: 0 });
    expect(JSON.stringify(w.db.find((row) => typeof row.sk === "string" && row.sk.startsWith("OPSFAIL#")))).not.toContain("secret detail");
    // a clean run adds nothing
    const before = (await readOpsFailures(w.table, ORG_A, w.clock.ms)).eraseSweep;
    await runDeleteWorker(d.deps, ORG_A);
    expect((await readOpsFailures(w.table, ORG_A, w.clock.ms)).eraseSweep).toBe(before);
  });

  it("an erase second pass that is STUCK, though nothing threw, is counted too (it is re-queued, not failed)", async () => {
    const w = world();
    await seedComments(w);
    const d = deleteDeps(w);
    expect((await erasePerson(d.deps, ORG_A, { developerId: "dev-1", projects: ["web"] }, "stuck-1")).complete).toBe(true);
    // positive control: a sweep that finishes counts nothing
    w.clock.ms += ERASE_SWEEP_DELAY_MS + 1;
    // the second pass finds a step it cannot finish (the lessons store is down): erasePerson catches it, reports incomplete and returns
    const stuck = { ...d.deps, lessons: { ...d.deps.lessons!, erasePerson: async () => { throw new Error("lessons store down"); } } };
    const first = await runErasureSweeps(stuck, ORG_A, w.clock.ms);
    expect(first).toEqual({ ran: 1, final: 0 });
    expect(await readOpsFailures(w.table, ORG_A, w.clock.ms)).toMatchObject({ eraseSweep: 1, tombstone: 0 });
    // still stuck at the next run: counted again, and the sweep item is kept for another try
    w.clock.ms += ERASE_SWEEP_DELAY_MS + 1;
    await runErasureSweeps(stuck, ORG_A, w.clock.ms);
    expect((await readOpsFailures(w.table, ORG_A, w.clock.ms)).eraseSweep).toBe(2);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ERASE_SWEEP")).toHaveLength(1);
    // recovered: the sweep finishes, nothing more is counted, the item goes
    w.clock.ms += ERASE_SWEEP_DELAY_MS + 1;
    expect(await runErasureSweeps(d.deps, ORG_A, w.clock.ms)).toEqual({ ran: 1, final: 1 });
    expect((await readOpsFailures(w.table, ORG_A, w.clock.ms)).eraseSweep).toBe(2);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ERASE_SWEEP")).toHaveLength(0);
  });

  it("a source delete nothing accepted (record.tombstone_failed) is reported to the tap's failure port with the company, never a person", async () => {
    const w = ingestWorld();
    const repo: CodeHostRepo = { host: "github", id: "77", fullName: "acme/shop", isPrivate: true, workspaceId: WS, project: "shop" };
    const event: CodeHostEvent = { type: "comment", repo, prNumber: 5, id: "41", url: "https://github.com/acme/shop/pull/5#c41", action: "deleted", surface: "review_comment", author: { id: "1001", login: "alice", isBot: false }, at: "2026-10-30T10:00:00.000Z", version: "deleted:1" };
    const seen: string[] = [];
    const tap = createCodeHostTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config, failures: { async tombstoneLost(workspaceId) { seen.push(workspaceId); } } });
    // positive control: a removal that works reports nothing
    expect(await tap.handle(event)).toMatchObject({ failed: 0 });
    expect(seen).toEqual([]);
    w.sink.tombstone = async () => { throw new Error("table unavailable"); };
    expect(await tap.handle(event)).toMatchObject({ failed: 1, removalFailed: true });
    expect(seen).toEqual([WS]);
    // a port that throws never changes the answer
    const tap2 = createCodeHostTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config, failures: { async tombstoneLost() { throw new Error("nope"); } } });
    expect(await tap2.handle(event)).toMatchObject({ failed: 1, removalFailed: true });
  });
});
