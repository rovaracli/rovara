// Setup and test health KF-1: taking marks OFF the known-failing list. Undo (one maintainer, a live browser session, audited, no second person) and expiry (a usable, healthy nightly shows the test passing; audited as the system).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KnownFailingMarkViewSchema, NightlyBaselineSchema, projectRevisionKey, type StoredNightlyHealth } from "@agentx/contracts";
import { KNOWN_FAILING_MAX, KNOWN_FAILING_FULL_MESSAGE, knownFailingKey, nextKnownFailing, readKnownFailingRow, type KnownFailingMark } from "../../packages/broker/src/test-env/known-failing.js";
import { expireKnownFailing, knownFailingExpiryListener, nightShowsPassing, passingMarks, undoKnownFailing, type MarkRef } from "../../packages/broker/src/test-env/known-failing-undo.js";
import { NIGHTLY_BASELINE_MAX_AGE_MS } from "../../packages/broker/src/test-env/nightly-usable.js";
import type { NightlyRecorded } from "../../packages/broker/src/test-env/nightly.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = `org_${"a".repeat(20)}` as const;
const PROJECT = "web";
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const DAY = 86_400_000;
const ON = { VERIFY_RESULTS_ENABLED: "1" };
const BROWSER = { orgId: ORG, developerId: "dev_a", browserSession: true as const };
const markedAt = new Date(NOW - 2 * DAY).toISOString();
const mark = (name: string, over: Partial<KnownFailingMark> = {}): KnownFailingMark => ({ name, checkId: "unit", markedBy: "dev_b", markedAt, epoch: 3, ...over });

function harness(marks: KnownFailingMark[] = [mark("t/a.py::one"), mark("t/a.py::two", { checkId: "lint", epoch: 4 })], options: { branch?: string; base?: string } = {}) {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  const clock = { now: NOW };
  const store = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit };
  const can = { value: true };
  db.set({ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", definition: { name: PROJECT, revision: 1, repositories: [{ name: "r0", url: "https://github.com/acme/web.git", path: "repo/r0", defaultBranch: options.base ?? "main" }] } });
  if (marks.length > 0) db.set({ ...knownFailingKey(ORG, PROJECT), entityType: "TEST_ENV_KNOWN_FAILING", orgId: ORG, project: PROJECT, marks, version: 5, updatedAt: markedAt });
  const ports = { store, mayEditSettings: async () => can.value };
  const night = (over: { failed?: string[]; flaky?: string[]; ageMs?: number; passed?: number; branch?: string; health?: StoredNightlyHealth | undefined } = {}): NightlyRecorded => {
    const failed = over.failed ?? ["t/x.py::bad"], flaky = over.flaky ?? [];
    const finished = new Date(NOW - (over.ageMs ?? DAY)).toISOString();
    const passed = over.passed ?? 90;
    const baseline = NightlyBaselineSchema.parse({ recordedAt: finished, envRevision: 1, branch: over.branch ?? options.branch ?? "main", headSha: "a".repeat(40), finishedAt: finished, tests: { total: passed + failed.length, passed, failed: failed.length, skipped: 0 }, failed, flaky });
    return { orgId: ORG, project: PROJECT, slotId: "s".repeat(64), baseline, health: "health" in over ? over.health : ({ class: "passed", ranFrom: "fresh" }) };
  };
  const names = async () => (await readKnownFailingRow(store, ORG, PROJECT))!.marks.map((m) => m.name);
  return { db, audit, clock, store, can, ports, night, names };
}
const ref = (m: KnownFailingMark): MarkRef => ({ name: m.name, checkId: m.checkId, markedBy: m.markedBy, markedAt: m.markedAt, epoch: m.epoch });
const sha = (lines: string[]) => createHash("sha256").update(lines.join("\n")).digest("hex");

describe("undo", () => {
  it("removes exactly the named mark, keeps the rest in order, bumps the version and audits it as the maintainer", async () => {
    const h = harness([mark("t/a.py::one"), mark("t/a.py::two", { checkId: "lint", epoch: 4 }), mark("t/a.py::three")]);
    expect(await undoKnownFailing(h.ports, BROWSER, PROJECT, ref(mark("t/a.py::two", { checkId: "lint", epoch: 4 })), "request-1")).toBe("done");
    const row = (await readKnownFailingRow(h.store, ORG, PROJECT))!;
    expect(row.marks.map((m) => m.name)).toEqual(["t/a.py::one", "t/a.py::three"]);
    expect(row.version).toBe(6);
    const events = h.audit.recordedBy("project.known_failing_removed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "member", id: "dev_a" }, target: { kind: "project", name: PROJECT }, facts: { removal: "undo", testCount: 1, markEpoch: 4, rowVersionAfter: 6, totalAfter: 2, testSetSha256: sha(["lint\tt/a.py::two"]) } });
    // No test name in the event; the write and the event are one transaction.
    expect(JSON.stringify(events[0])).not.toContain("t/a.py");
    expect(h.db.transactions().at(-1)!.length).toBe(2);
  });

  it("two undos that carry the same request id are two audit events (the id is the client's, so it cannot name the event alone)", async () => {
    const h = harness([mark("t/a.py::one"), mark("t/a.py::two", { checkId: "lint", epoch: 4 })]);
    expect(await undoKnownFailing(h.ports, BROWSER, PROJECT, ref(mark("t/a.py::one")), "request-same")).toBe("done");
    expect(await undoKnownFailing(h.ports, BROWSER, PROJECT, ref(mark("t/a.py::two", { checkId: "lint", epoch: 4 })), "request-same")).toBe("done");
    const events = h.audit.recordedBy("project.known_failing_removed");
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
    expect(await h.names()).toEqual([]);
  });

  it("asks for no second person: the maintainer who undoes may be the one who marked it", async () => {
    const h = harness([mark("t/a.py::one", { markedBy: "dev_a" })]);
    expect(await undoKnownFailing(h.ports, BROWSER, PROJECT, ref(mark("t/a.py::one", { markedBy: "dev_a" })), "request-1")).toBe("done");
    expect(await h.names()).toEqual([]);
  });

  it("is refused for anything but a live browser session, and for a person who is no longer a maintainer; nothing is written", async () => {
    const h = harness();
    const target = ref(mark("t/a.py::one"));
    for (const caller of [{ orgId: ORG, developerId: "dev_a" }, { ...BROWSER, browserSession: undefined }]) await expect(undoKnownFailing(h.ports, caller, PROJECT, target, "r"), "no session").rejects.toThrow("Use a live browser session to remove a known-failing mark.");
    h.can.value = false;
    await expect(undoKnownFailing(h.ports, BROWSER, PROJECT, target, "r")).rejects.toThrow("only a project maintainer");
    expect(await h.names()).toEqual(["t/a.py::one", "t/a.py::two"]);
    expect(h.audit.recordedBy("project.known_failing_removed")).toEqual([]);
  });

  it("matches a mark on all five facts: a different test, check, person, time or card finds nothing (stale) and removes nothing", async () => {
    const h = harness();
    const base = ref(mark("t/a.py::one"));
    for (const changed of [{ name: "t/a.py::other" }, { checkId: "lint" }, { markedBy: "dev_c" }, { markedAt: new Date(NOW).toISOString() }, { epoch: 9 }]) {
      expect(await undoKnownFailing(h.ports, BROWSER, PROJECT, { ...base, ...changed }, "request-1"), JSON.stringify(changed)).toBe("stale");
    }
    expect(await h.names()).toEqual(["t/a.py::one", "t/a.py::two"]);
    expect(h.audit.recordedBy("project.known_failing_removed")).toEqual([]);
  });

  it("a second press of the same mark is stale, and a list that cannot be read is not_ready", async () => {
    const h = harness();
    const target = ref(mark("t/a.py::one"));
    expect(await undoKnownFailing(h.ports, BROWSER, PROJECT, target, "request-1")).toBe("done");
    expect(await undoKnownFailing(h.ports, BROWSER, PROJECT, target, "request-2")).toBe("stale");
    h.db.set({ ...knownFailingKey(ORG, PROJECT), marks: "garbage" });
    expect(await undoKnownFailing(h.ports, BROWSER, PROJECT, ref(mark("t/a.py::two", { checkId: "lint", epoch: 4 })), "request-3")).toBe("not_ready");
  });

  it("writes nothing when another change landed after the list was read (the version condition holds)", async () => {
    const h = harness();
    const racing = { ...h.ports, store: { ...h.store, documentClient: { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "TransactWriteCommand") h.db.set({ ...knownFailingKey(ORG, PROJECT), entityType: "TEST_ENV_KNOWN_FAILING", orgId: ORG, project: PROJECT, marks: [mark("t/a.py::one"), mark("t/new.py::n")], version: 6, updatedAt: markedAt });
      return h.db.send(command);
    } } } };
    expect(await undoKnownFailing(racing as never, BROWSER, PROJECT, ref(mark("t/a.py::one")), "request-1")).toBe("not_ready");
    expect(await h.names()).toEqual(["t/a.py::one", "t/new.py::n"]);
    expect(h.audit.recordedBy("project.known_failing_removed")).toEqual([]);
  });
});

describe("a full list points to Undo", () => {
  it("says where to remove marks, and a list at the limit still refuses another", () => {
    expect(KNOWN_FAILING_FULL_MESSAGE).toContain("Undo");
    expect(KNOWN_FAILING_FULL_MESSAGE).toContain("known-failing list is full (500)");
    const full = Array.from({ length: KNOWN_FAILING_MAX }, (_, n) => mark(`t/${String(n)}.py::x`));
    expect(() => nextKnownFailing({ marks: full, version: 1 }, [mark("t/extra.py::x")])).toThrow(KNOWN_FAILING_FULL_MESSAGE);
  });
});

describe("expiry by a nightly", () => {
  it("removes the marks the night shows passing (in neither list), audits once as the system, and keeps the failing and flaky ones", async () => {
    const h = harness([mark("t/a.py::one"), mark("t/x.py::bad"), mark("t/y.py::flaky", { epoch: 4 }), mark("t/a.py::two", { checkId: "lint", epoch: 4 })]);
    const removed = await expireKnownFailing(h.store, h.night({ failed: ["t/x.py::bad"], flaky: ["t/y.py::flaky"] }), {}, ON);
    expect(removed).toBe(2);
    expect(await h.names()).toEqual(["t/x.py::bad", "t/y.py::flaky"]);
    const events = h.audit.recordedBy("project.known_failing_removed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "system", id: "rovara" }, facts: { removal: "nightly_passing", testCount: 2, markEpoch: 0, rowVersionAfter: 6, totalAfter: 2, testSetSha256: sha(["lint\tt/a.py::two", "unit\tt/a.py::one"]) } });
    expect(JSON.stringify(events[0])).not.toContain("t/a.py");
  });

  it("one test id everywhere (NH-1): marks named by pytest's own node ids, as the nightly lists them, are matched and expired by those ids", async () => {
    const total = "tests/test_cart.py::test_total_fails", rules = "tests/test_cart_rules.py::TestRules::test_discount_fails";
    const h = harness([mark(total), mark(rules)]);
    // The night still fails the rules test (listed by its node id) and no longer fails the cart test.
    expect(await expireKnownFailing(h.store, h.night({ failed: [rules] }), {}, ON)).toBe(1);
    expect(await h.names()).toEqual([rules]);
    // A bare name in the night is NOT the same test as the node id: it holds nothing, so the mark is shown passing (one id everywhere, no tolerance for bare names).
    const g = harness([mark(total)]);
    expect(await expireKnownFailing(g.store, g.night({ failed: ["test_total_fails"] }), {}, ON)).toBe(1);
  });

  it("a mark named by a long id (up to the one test id's limit) is shown by the app's own schema", () => {
    const view = { name: `tests/${"d".repeat(400)}.py::t`, checkId: "unit", markedBy: "dev_a", markedByName: "Dev A", markedAt, epoch: 3, markedByYou: false };
    expect(KnownFailingMarkViewSchema.safeParse(view).success).toBe(true);
    expect(KnownFailingMarkViewSchema.safeParse({ ...view, name: "x".repeat(501) }).success).toBe(false);
  });

  it("a flaky list that hit its cap may be missing tests, so no mark is shown passing by that night", () => {
    const h = harness();
    const night = h.night({ flaky: Array.from({ length: 500 }, (_, index) => `t/f.py::f${String(index)}`) });
    expect(nightShowsPassing(night)).toBe(false);
    expect(nightShowsPassing(h.night({ flaky: Array.from({ length: 499 }, (_, index) => `t/f.py::f${String(index)}`) }))).toBe(true);
  });

  it("names the card when every removed mark came from one card", async () => {
    const h = harness([mark("t/a.py::one", { epoch: 7 }), mark("t/a.py::two", { epoch: 7 }), mark("t/x.py::bad")]);
    await expireKnownFailing(h.store, h.night(), {}, ON);
    expect(h.audit.recordedBy("project.known_failing_removed")[0]).toMatchObject({ facts: { markEpoch: 7, testCount: 2 } });
  });

  it("matches a name in any check (a nightly failure has no check): a name failing in the night stays marked in every check", async () => {
    const h = harness([mark("t/x.py::bad", { checkId: "unit" }), mark("t/x.py::bad", { checkId: "lint" })]);
    expect(await expireKnownFailing(h.store, h.night({ failed: ["t/x.py::bad"] }), {}, ON)).toBe(0);
    expect(await h.names()).toEqual(["t/x.py::bad", "t/x.py::bad"]);
  });

  it("does nothing while vx is off (for any value but exactly 1), and the listener does not exist then", async () => {
    for (const value of [undefined, "", "0", "true", " 1"]) {
      const h = harness();
      const env = value === undefined ? {} : { VERIFY_RESULTS_ENABLED: value };
      expect(await expireKnownFailing(h.store, h.night(), {}, env), String(value)).toBe(0);
      expect(await h.names()).toEqual(["t/a.py::one", "t/a.py::two"]);
      expect(knownFailingExpiryListener(h.store, env)).toBeUndefined();
    }
    expect(knownFailingExpiryListener(harness().store, ON)).toBeTypeOf("function");
  });

  it("uses only a usable nightly: not one from another branch than the tasks' base branch, not one older than 7 days (unless the branch has not moved), not one from the future", async () => {
    const other = harness(undefined, { branch: "release" });
    expect(await expireKnownFailing(other.store, other.night(), {}, ON)).toBe(0);
    const stale = harness();
    expect(await expireKnownFailing(stale.store, stale.night({ ageMs: NIGHTLY_BASELINE_MAX_AGE_MS + 60_000 }), {}, ON)).toBe(0);
    expect(await expireKnownFailing(stale.store, stale.night({ ageMs: NIGHTLY_BASELINE_MAX_AGE_MS + 60_000 }), { currentHead: async () => "b".repeat(40) }, ON)).toBe(0);
    const future = harness();
    expect(await expireKnownFailing(future.store, future.night({ ageMs: -2 * 3_600_000 }), {}, ON)).toBe(0);
    // A quiet repository: older than a week, run on exactly the branch's head now.
    const quiet = harness();
    expect(await expireKnownFailing(quiet.store, quiet.night({ ageMs: 30 * DAY }), { currentHead: async () => "a".repeat(40) }, ON)).toBe(2);
    // The tasks' own base branch is used when given.
    const task = harness();
    expect(await expireKnownFailing(task.store, task.night(), { taskBranches: ["develop"] }, ON)).toBe(0);
    expect(await task.names()).toEqual(["t/a.py::one", "t/a.py::two"]);
  });

  it("is not read as passing when the night ran nothing that passed, or its own step words say the setup broke or are unsure", async () => {
    const h = harness();
    expect(await expireKnownFailing(h.store, h.night({ passed: 0 }), {}, ON)).toBe(0);
    for (const health of [{ class: "environment", cause: "setup_failed", ranFrom: "fresh" }, { class: "unclear", ranFrom: "fresh" }, { class: "tests", setupProved: false, ranFrom: "fresh" }, { class: "tests", ranFrom: "fresh" }] as StoredNightlyHealth[]) {
      expect(await expireKnownFailing(h.store, h.night({ health }), {}, ON), JSON.stringify(health)).toBe(0);
    }
    expect(await h.names()).toEqual(["t/a.py::one", "t/a.py::two"]);
    expect(nightShowsPassing({ baseline: h.night().baseline, health: { class: "passed", ranFrom: "fresh" } })).toBe(true);
    expect(nightShowsPassing({ baseline: h.night().baseline, health: { class: "tests", setupProved: true, ranFrom: "saved_image" } })).toBe(true);
    expect(nightShowsPassing({ baseline: h.night().baseline, health: undefined })).toBe(false);
  });

  it("a night that carries no step words never takes a mark off", async () => {
    const h = harness();
    expect(await expireKnownFailing(h.store, h.night({ health: undefined }), {}, ON)).toBe(0);
    expect(await h.names()).toEqual(["t/a.py::one", "t/a.py::two"]);
    expect(h.audit.recordedBy("project.known_failing_removed")).toEqual([]);
  });

  it("a failing set that did not fit excuses nothing and so removes nothing", async () => {
    const h = harness();
    const night = h.night();
    const truncated = { ...night, baseline: { ...night.baseline, tests: { ...night.baseline.tests, failed: 9 } } };
    expect(await expireKnownFailing(h.store, truncated, {}, ON)).toBe(0);
    expect(await h.names()).toEqual(["t/a.py::one", "t/a.py::two"]);
  });

  it("leaves an unreadable list alone, and a list with nothing passing writes nothing", async () => {
    const h = harness();
    expect(await expireKnownFailing(h.store, h.night({ failed: ["t/a.py::one", "t/a.py::two"] }), {}, ON)).toBe(0);
    expect(h.audit.recordedBy("project.known_failing_removed")).toEqual([]);
    h.db.set({ ...knownFailingKey(ORG, PROJECT), marks: "garbage" });
    expect(await expireKnownFailing(h.store, h.night(), {}, ON)).toBe(0);
    const none = harness([]);
    expect(await expireKnownFailing(none.store, none.night(), {}, ON)).toBe(0);
  });

  it("retries once after another change lands, and then removes only what the night shows passing in the list as it is now", async () => {
    const h = harness();
    let raced = false;
    const racing = { ...h.store, documentClient: { send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "TransactWriteCommand" && !raced) { raced = true; h.db.set({ ...knownFailingKey(ORG, PROJECT), entityType: "TEST_ENV_KNOWN_FAILING", orgId: ORG, project: PROJECT, marks: [mark("t/a.py::one"), mark("t/new.py::n")], version: 6, updatedAt: markedAt }); }
      return h.db.send(command as never);
    } } };
    expect(await expireKnownFailing(racing as never, h.night(), {}, ON)).toBe(2);
    expect(await h.names()).toEqual([]);
  });

  it("passingMarks keeps a mark whose name is failing or flaky, whatever its check", () => {
    const marks = [mark("a"), mark("b", { checkId: "lint" }), mark("c")];
    expect(passingMarks(marks, { failed: ["a"], flaky: ["c"] }).map((m) => m.name)).toEqual(["b"]);
  });

  it("the listener never throws a fault into the nightly record: it logs the error's name and the marks stay", async () => {
    const h = harness();
    const broken = { ...h.store, documentClient: { send: async (command: { constructor: { name: string } }) => { if (command.constructor.name === "TransactWriteCommand") throw Object.assign(new Error("secret detail"), { name: "ThrottlingException" }); return h.db.send(command as never); } } };
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    try {
      await knownFailingExpiryListener(broken, ON)!(h.night());
    } finally { console.log = original; }
    expect(lines.join("")).toContain("known_failing_expiry_failed");
    expect(lines.join("")).not.toContain("secret detail");
    expect(await h.names()).toEqual(["t/a.py::one", "t/a.py::two"]);
  });
});

