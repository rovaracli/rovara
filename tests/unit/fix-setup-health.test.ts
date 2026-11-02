// Setup and test health SH17 + SH28: the Fix setup card port the project health calls, over the SH17 records, versioned (L4): a late call can never undo a newer one, the same call again changes nothing, and with
// vx off the port does nothing. A blocked reason that the auto-fix policy also names joins the auto-fix record, so one fault is one card.
import { describe, expect, it } from "vitest";

import { FIX_SETUP_CAUSES, fixSetupItemsFor, recordFixSetup, readFixSetupRecord } from "../../packages/broker/src/test-env/fix-setup.js";
import { healthFixSetupCards, recordCauseOfHealth } from "../../packages/broker/src/test-env/fix-setup-health.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = `org_${"e".repeat(20)}`;
const PROJECT = "web";
const ON = { VERIFY_RESULTS_ENABLED: "1" };
const task = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const who = { orgId: ORG, developerId: "dev_a" };

function bench(env: NodeJS.ProcessEnv = ON) {
  const db = new FakeDynamoDb();
  const clock = { now: Date.UTC(2026, 10, 3, 10, 0, 0) };
  const store = { documentClient: db, tableName: "state", now: () => clock.now };
  const cards = healthFixSetupCards(store, env);
  const items = () => fixSetupItemsFor({ store, maintainedProjects: async () => [PROJECT], task: async () => undefined }, who, ON);
  const open = (cause: string, version: number, extra: { source?: "nightly" | "tasks"; taskIds?: string[] } = {}) => cards.openOrJoin({ orgId: ORG, project: PROJECT, cause, source: extra.source ?? "nightly", taskIds: extra.taskIds ?? [], version });
  const resolve = (version: number, reason: "nightly_passed" | "nightly_setup_ok" | "setup_proved" = "nightly_passed") => cards.resolve({ orgId: ORG, project: PROJECT, reason, version });
  return { db, store, cards, items, open, resolve, clock };
}

describe("the port with vx off", () => {
  it("does nothing, for any value but exactly 1", async () => {
    for (const value of [undefined, "", "0", "true", " 1"]) {
      const t = bench(value === undefined ? {} : { VERIFY_RESULTS_ENABLED: value });
      await t.open("setup_failed", 1);
      await t.resolve(2);
      expect(t.db.find(() => true), String(value)).toEqual([]);
    }
  });
});

describe("opening a card for a repair state", () => {
  it("opens one card for a nightly cause, in fixed words, with no tasks", async () => {
    const t = bench();
    await t.open("setup_failed", 1);
    const [item] = await t.items() as unknown as Array<{ cause: string; step: string; taskCount: number; title: string; details?: Array<{ title: string; lines: string[] }> }>;
    expect(item).toMatchObject({ cause: "setup_failed", step: "Setup", taskCount: 0, title: "Fix setup: Setup" });
    expect(item!.details?.[0]).toEqual({ title: "What failed", lines: ["The nightly run could not set the project up."] });
  });

  it("repeating the same call (the same version) changes nothing; a newer version joins and keeps the card", async () => {
    const t = bench();
    await t.open("setup_failed", 3);
    const first = await readFixSetupRecord(t.store, ORG, PROJECT, "setup_failed");
    await t.open("setup_failed", 3);
    expect(await readFixSetupRecord(t.store, ORG, PROJECT, "setup_failed")).toEqual(first);
    await t.open("setup_failed", 4);
    const later = await readFixSetupRecord(t.store, ORG, PROJECT, "setup_failed");
    expect(later).toMatchObject({ status: "open", healthVersion: 4, epoch: 1 });
    expect(await t.items()).toHaveLength(1);
  });

  it("joins the blocked tasks of a repair state to the record the auto-fix path already has for the same fault (one card)", async () => {
    const t = bench();
    await recordFixSetup(t.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: "host-blocked" });
    expect(recordCauseOfHealth("host_blocked")).toBe("host-blocked");
    await t.open("host_blocked", 5, { source: "tasks", taskIds: [task(1), task(2), task(3)] });
    const items = await t.items() as Array<{ cause: string; taskCount: number }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ cause: "host-blocked", taskCount: 3 });
    // A task id that is not a task id is not counted.
    await t.open("host_blocked", 6, { source: "tasks", taskIds: ["task_9"] });
    expect((await t.items() as Array<{ taskCount: number }>)[0]!.taskCount).toBe(3);
  });

  it("a nightly word that is not an auto-fix code keeps its own record", () => {
    expect(recordCauseOfHealth("setup_failed")).toBe("setup_failed");
    expect(recordCauseOfHealth("other")).toBe("other");
  });
});

describe("the version closes the L4 race", () => {
  it("refuses an open that comes after a newer resolve (the late call cannot bring a card back)", async () => {
    const t = bench();
    await t.resolve(6, "setup_proved");
    await t.open("setup_failed", 5);
    expect(await t.items()).toEqual([]);
    expect(await readFixSetupRecord(t.store, ORG, PROJECT, "setup_failed")).toBeUndefined();
  });

  it("refuses a resolve that comes after a newer open (the late call cannot close the newer repair's card)", async () => {
    const t = bench();
    await t.open("setup_failed", 7);
    await t.resolve(6);
    expect(await t.items()).toHaveLength(1);
  });

  it("a resolve older than any event the project has seen closes nothing, whichever card it would have closed", async () => {
    const t = bench();
    await t.open("setup_failed", 3);
    await t.open("build_failed", 9);
    await t.resolve(5);
    expect((await t.items() as Array<{ cause: string }>).map((item) => item.cause).sort()).toEqual(["build_failed", "setup_failed"]);
  });

  it("a newer resolve closes the cards, and the card opens again, as a new one, for a still newer repair", async () => {
    const t = bench();
    await t.open("setup_failed", 2);
    await t.resolve(3);
    expect(await t.items()).toEqual([]);
    await t.open("setup_failed", 4);
    expect(await readFixSetupRecord(t.store, ORG, PROJECT, "setup_failed")).toMatchObject({ status: "open", epoch: 2, healthVersion: 4 });
  });
});

describe("resolving", () => {
  it("closes every open card of the project except the one about tests that fail on the original code, in as many passes as it takes", async () => {
    const t = bench();
    const causes = [...FIX_SETUP_CAUSES.filter((cause) => cause !== "fails-on-original-code"), "pull_failed", "update_failed", "setup_failed", "build_failed", "boot_failed", "mocks_failed", "preprod_unreachable", "check_never_started", "check_timed_out", "no_tests_collected", "no_report_written", "collection_errors"];
    expect(causes.length).toBeGreaterThan(24);
    for (const cause of causes) await recordFixSetup(t.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: cause as never }).catch(() => undefined);
    for (const cause of causes.filter((c) => !FIX_SETUP_CAUSES.includes(c as never))) await t.open(cause, 1);
    await recordFixSetup(t.store, { orgId: ORG, project: PROJECT, taskId: task(2), cause: "fails-on-original-code", tests: [{ name: "t::a", checkId: "unit" }] });
    expect((await t.items()).length).toBeGreaterThan(24);
    const before = t.db.transactions().length;
    await t.resolve(2);
    const passes = t.db.transactions().slice(before);
    expect(passes.length).toBeGreaterThan(1);
    for (const pass of passes) expect(pass.length).toBeLessThanOrEqual(25);
    const left = await t.items() as Array<{ cause: string }>;
    expect(left.map((item) => item.cause)).toEqual(["fails-on-original-code"]);
  });
});
