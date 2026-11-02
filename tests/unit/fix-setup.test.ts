// Setup and test health SH17: the Fix setup record (one per project per cause, later tasks join), its card source, and its two decisions ("Mark as known failing" and "Not now").
import { describe, expect, it } from "vitest";
import { AUTO_FIX_ENVIRONMENT_CODES, type EvidencePack } from "@agentx/contracts";
import { projectDecisionCards, type DecisionItem } from "../../packages/broker/src/decisions/project.js";
import { fixSetupHandler } from "../../packages/broker/src/decisions/performer.js";
import {
  FIX_SETUP_TASKS_MAX, FIX_SETUP_TESTS_MAX, dismissFixSetup, failingOnOriginalTests, fixSetupCauseOf, fixSetupItemsFor, markKnownFailing, recordFixSetup, type FixSetupDecisionPorts,
} from "../../packages/broker/src/test-env/fix-setup.js";
import { KNOWN_FAILING_MAX, alreadyFailingForResults, knownFailingKey, readKnownFailingRow } from "../../packages/broker/src/test-env/known-failing.js";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = `org_${"a".repeat(20)}`;
const PROJECT = "web";
const WHO = { orgId: ORG, developerId: "dev_a" };
const task = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CAUSE = "fails-on-original-code" as const;
type FixItem = Extract<DecisionItem, { kind: "fix_setup" }>;

function harness() {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  const clock = { now: Date.UTC(2026, 10, 2, 10, 0, 0) };
  const store = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit };
  const can = { value: true };
  const ports: FixSetupDecisionPorts = { store, mayEditSettings: async () => can.value };
  const tasks = new Map<string, Record<string, unknown>>();
  const cardPorts = { store, maintainedProjects: async () => [PROJECT], task: async (id: string) => tasks.get(id) as never };
  const items = async (env: NodeJS.ProcessEnv = { VERIFY_RESULTS_ENABLED: "1" }) => fixSetupItemsFor(cardPorts, WHO, env);
  const only = async (): Promise<FixItem> => {
    const found = await items();
    expect(found).toHaveLength(1);
    return found[0] as FixItem;
  };
  return { db, audit, clock, store, can, ports, tasks, items, only };
}

describe("the cause of an ask", () => {
  it("is the first environment code, in the policy table's order, and nothing for a code fault", () => {
    expect(fixSetupCauseOf(["runner-busy", "check-broken"])).toBe("runner-busy");
    expect(fixSetupCauseOf(["check-broken", "runner-busy"])).toBe("runner-busy");
    expect(fixSetupCauseOf(["build-failed", "check-failed"])).toBeUndefined();
    expect(AUTO_FIX_ENVIRONMENT_CODES.length).toBeGreaterThan(10);
  });
});

describe("recordFixSetup: one open record per project and cause", () => {
  it("opens one, and a later task joins it instead of opening another; the same task twice changes nothing", async () => {
    const h = harness();
    expect(await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: "setup-failed-in-task" })).toBe("opened");
    expect(await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(2), cause: "setup-failed-in-task" })).toBe("joined");
    expect(await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(2), cause: "setup-failed-in-task" })).toBe("unchanged");
    const found = await h.items();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "fix_setup", project: PROJECT, cause: "setup-failed-in-task", step: "Setup", taskCount: 2, knownFailingTests: 0 });
  });

  it("a different cause is a different card, and a different project is too", async () => {
    const h = harness();
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: "setup-failed-in-task" });
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: "login-failed" });
    expect((await h.items()).map((item) => (item as FixItem).cause).sort()).toEqual(["login-failed", "setup-failed-in-task"]);
    const ids = projectDecisionCards(await h.items()).cards.map((card) => card.id);
    expect(new Set(ids).size).toBe(2);
    await recordFixSetup(h.store, { orgId: ORG, project: "api", taskId: task(3), cause: "login-failed" });
    const other = projectDecisionCards([...(await h.items()), ...(await fixSetupItemsFor({ ...{ store: h.store, maintainedProjects: async () => ["api"], task: async () => undefined } }, WHO, { VERIFY_RESULTS_ENABLED: "1" }))]).cards;
    expect(new Set(other.map((card) => card.id)).size).toBe(3);
  });

  it("stops counting tasks at the bound and stays one record", async () => {
    const h = harness();
    for (let n = 1; n <= FIX_SETUP_TASKS_MAX + 5; n += 1) await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(n), cause: "login-failed" });
    const [item] = await h.items() as FixItem[];
    expect(item!.taskCount).toBe(FIX_SETUP_TASKS_MAX);
    expect(await h.items()).toHaveLength(1);
  });

  it("lists nothing while vx is off, and records nothing is needed for that: the source returns [] for any value but exactly 1", async () => {
    const h = harness();
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: "login-failed" });
    for (const value of [undefined, "", "0", "true", " 1", "01"]) expect(await h.items(value === undefined ? {} : { VERIFY_RESULTS_ENABLED: value }), String(value)).toEqual([]);
    expect(await h.items({ VERIFY_RESULTS_ENABLED: "1" })).toHaveLength(1);
  });

  it("names an affected task only to its own owner, and only an open one of this company and project", async () => {
    const h = harness();
    const row = (id: string, over: Record<string, unknown> = {}) => ({ taskId: id, title: `Title ${id.slice(-2)}`, orgId: ORG, project: PROJECT, developerId: "dev_a", developerName: "Ana", provider: "github", ...over });
    h.tasks.set(task(1), row(task(1)));
    h.tasks.set(task(2), row(task(2), { project: "other" }));
    h.tasks.set(task(3), row(task(3), { closedAt: "2026-11-02T00:00:00.000Z" }));
    h.tasks.set(task(4), row(task(4), { developerId: "dev_b", developerName: "Bo" }));
    for (const n of [1, 2, 3, 4]) await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(n), cause: "login-failed" });
    const [item] = await h.items() as FixItem[];
    const lines = item!.details?.find((group) => group.title === "Tasks waiting on this")?.lines ?? [];
    expect(lines.join("|")).toContain("Title 01");
    expect(lines.join("|")).not.toContain("Title 02");
    expect(lines.join("|")).not.toContain("Title 03");
    expect(lines.join("|")).not.toContain("Title 04");
    expect(item!.taskCount).toBe(4);
  });
});

describe("the tests a card could mark", () => {
  const pack = (checks: Array<Record<string, unknown>>): EvidencePack => ({ checks } as unknown as EvidencePack);
  const check = (names: Array<[string, string]>, over: Record<string, unknown> = {}) => ({
    checkId: "unit", after: "failed", class: "already_failing",
    tests: { total: names.length + 1, passed: 1, failed: names.filter(([, status]) => status === "failed").length, skipped: 0, errored: names.filter(([, status]) => status === "errored").length, names: names.map(([name, status]) => ({ name, status })), newTests: [] },
    ...over,
  });

  it("are every failing test of every check that failed on the original code, once each", () => {
    expect(failingOnOriginalTests(pack([check([["t/a.py::one", "failed"], ["t/a.py::two", "errored"]]), check([["t/a.py::one", "failed"]])]))).toEqual(["t/a.py::one", "t/a.py::two"]);
  });

  it("are not offered when the pack is missing, names fewer tests than failed, has a name with a space, or has too many", () => {
    expect(failingOnOriginalTests(undefined)).toBeUndefined();
    expect(failingOnOriginalTests(pack([]))).toBeUndefined();
    expect(failingOnOriginalTests(pack([check([["a", "failed"]], { tests: { total: 3, passed: 1, failed: 2, skipped: 0, errored: 0, names: [{ name: "a", status: "failed" }], newTests: [] } })]))).toBeUndefined();
    expect(failingOnOriginalTests(pack([check([["has space", "failed"]])]))).toBeUndefined();
    expect(failingOnOriginalTests(pack([check(Array.from({ length: FIX_SETUP_TESTS_MAX + 1 }, (_, n) => [`t${String(n)}`, "failed"] as [string, string]))]))).toBeUndefined();
    expect(failingOnOriginalTests(pack([check([["a", "failed"]], { class: "regression" })]))).toBeUndefined();
    expect(failingOnOriginalTests(pack([check([["a", "failed"]], { tests: undefined })]))).toBeUndefined();
  });

  it("make the card offer a mark; a later task whose list does not fit removes the offer for everyone, never a partial one", async () => {
    const h = harness();
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: CAUSE, tests: ["t::a", "t::b"] });
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(2), cause: CAUSE, tests: ["t::b", "t::c"] });
    expect((await h.only()).knownFailingTests).toBe(3);
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(3), cause: CAUSE, tests: Array.from({ length: FIX_SETUP_TESTS_MAX + 1 }, (_, n) => `big${String(n)}`) });
    expect((await h.only()).knownFailingTests).toBe(0);
    // Tests given for any other cause are ignored.
    const other = harness();
    await recordFixSetup(other.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: "login-failed", tests: ["t::a"] });
    expect((await other.only()).knownFailingTests).toBe(0);
  });
});

describe("Mark as known failing", () => {
  const opened = async (tests = ["t/a.py::one", "t/a.py::two"]) => {
    const h = harness();
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: CAUSE, tests });
    return { h, item: await h.only() };
  };

  it("adds the record's own tests to the project's set, closes the card and audits it, all in one transaction", async () => {
    const { h, item } = await opened();
    expect(await markKnownFailing(h.ports, WHO, item, "request-1")).toBe("done");
    expect((await readKnownFailingRow(h.store, ORG, PROJECT))!.tests).toEqual(["t/a.py::one", "t/a.py::two"]);
    expect(await h.items()).toEqual([]);
    const events = h.audit.recordedBy("project.known_failing_marked");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { id: "dev_a" }, target: { kind: "project", name: PROJECT }, facts: { cause: CAUSE, testCount: 2 } });
    // The audit event names no test.
    expect(JSON.stringify(events[0])).not.toContain("t/a.py");
    // One transaction held the three writes.
    const last = h.db.transactions().at(-1)!;
    expect(last.length).toBe(3);
  });

  it("feeds the result classifier's set (the nightly failures and the marks together)", async () => {
    const { h, item } = await opened();
    await markKnownFailing(h.ports, WHO, item, "request-1");
    expect(await alreadyFailingForResults(h.store, ORG, PROJECT)).toEqual(["t/a.py::one", "t/a.py::two"]);
  });

  it("is refused for a caller who may not edit the project's settings, and writes nothing", async () => {
    const { h, item } = await opened();
    h.can.value = false;
    await expect(markKnownFailing(h.ports, WHO, item, "request-1")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readKnownFailingRow(h.store, ORG, PROJECT)).toEqual({ tests: [], version: 0 });
    expect(await h.items()).toHaveLength(1);
  });

  it("is stale when another task joined after the card was shown (the person never marks tests they were not shown)", async () => {
    const { h, item } = await opened();
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(2), cause: CAUSE, tests: ["t/a.py::three"] });
    expect(await markKnownFailing(h.ports, WHO, item, "request-1")).toBe("stale");
    expect((await readKnownFailingRow(h.store, ORG, PROJECT))!.tests).toEqual([]);
    // The new card carries all three.
    expect((await h.only()).knownFailingTests).toBe(3);
  });

  it("takes nothing from the card: the tests marked are the stored record's, whatever the item says", async () => {
    const { h, item } = await opened();
    const forged = { ...item, knownFailingTests: 1, details: [{ title: "Tests that would be marked as already failing", lines: ["evil::test"] }] } as FixItem;
    expect(await markKnownFailing(h.ports, WHO, forged, "request-1")).toBe("done");
    expect((await readKnownFailingRow(h.store, ORG, PROJECT))!.tests).toEqual(["t/a.py::one", "t/a.py::two"]);
  });

  it("a second press of the same card is stale, not a second mark", async () => {
    const { h, item } = await opened();
    await markKnownFailing(h.ports, WHO, item, "request-1");
    expect(await markKnownFailing(h.ports, WHO, item, "request-2")).toBe("stale");
    expect(h.audit.recordedBy("project.known_failing_marked")).toHaveLength(1);
  });

  it("is not ready when the record has no tests, is not the original-code cause, or the project's list would overflow", async () => {
    const none = harness();
    await recordFixSetup(none.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: CAUSE });
    expect(await markKnownFailing(none.ports, WHO, await none.only(), "r")).toBe("not_ready");
    const wrong = harness();
    await recordFixSetup(wrong.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: "login-failed" });
    expect(await markKnownFailing(wrong.ports, WHO, await wrong.only(), "r")).toBe("not_ready");
    const { h, item } = await opened(["new::one"]);
    h.db.set({ ...knownFailingKey(ORG, PROJECT), entityType: "TEST_ENV_KNOWN_FAILING", tests: Array.from({ length: KNOWN_FAILING_MAX }, (_, n) => `old${String(n)}`), version: 1, updatedAt: "2026-11-01T00:00:00.000Z" });
    expect(await markKnownFailing(h.ports, WHO, item, "r")).toBe("not_ready");
    expect((await readKnownFailingRow(h.store, ORG, PROJECT))!.tests).toHaveLength(KNOWN_FAILING_MAX);
  });

  it("refuses to write when the project's marks cannot be read (a damaged row excuses nothing and takes no more)", async () => {
    const { h, item } = await opened();
    h.db.set({ ...knownFailingKey(ORG, PROJECT), entityType: "TEST_ENV_KNOWN_FAILING", tests: "not a list", version: 1 });
    expect(await markKnownFailing(h.ports, WHO, item, "r")).toBe("not_ready");
    expect(await alreadyFailingForResults(h.store, ORG, PROJECT)).toEqual([]);
  });
});

describe("Not now", () => {
  it("closes the record, changes no setting (no audit event), and a later task reopens a fresh card", async () => {
    const h = harness();
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: "login-failed" });
    const item = await h.only();
    expect(await dismissFixSetup(h.ports, WHO, item)).toBe("done");
    expect(await h.items()).toEqual([]);
    expect(h.audit.recorded()).toEqual([]);
    expect(await dismissFixSetup(h.ports, WHO, item)).toBe("stale");
    expect(await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(2), cause: "login-failed" })).toBe("opened");
    const reopened = await h.only();
    expect(reopened.taskCount).toBe(1);
    expect(reopened.contentVersion).not.toBe(item.contentVersion);
  });

  it("is refused for a caller who may not edit the project's settings", async () => {
    const h = harness();
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: "login-failed" });
    const item = await h.only();
    h.can.value = false;
    await expect(dismissFixSetup(h.ports, WHO, item)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await h.items()).toHaveLength(1);
  });
});

describe("the card handler", () => {
  it("maps the answers to the card routes' outcomes and refuses another kind's item", async () => {
    const answers: string[] = [];
    const handler = fixSetupHandler<typeof WHO>({
      markKnownFailing: async () => (answers.shift() ?? "done") as never,
      dismiss: async () => (answers.shift() ?? "done") as never,
    });
    const item = { kind: "fix_setup" } as DecisionItem;
    const input = { card: {} as never, item, requestId: "r" };
    expect(await handler.approve(WHO, input)).toEqual({ kind: "done" });
    answers.push("stale");
    expect(await handler.approve(WHO, input)).toEqual({ kind: "refused", reason: "stale" });
    answers.push("not_ready");
    expect(await handler.reject!(WHO, { ...input, reason: "not_now" })).toEqual({ kind: "refused", reason: "not_ready" });
    expect(await handler.approve(WHO, { ...input, item: { kind: "merge" } as DecisionItem })).toEqual({ kind: "refused", reason: "unsupported" });
  });
});

