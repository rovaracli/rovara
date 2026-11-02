// Setup and test health SH17: the Fix setup record (one per project per cause, later tasks join), its card source, and its two decisions ("Mark as known failing" and "Not now").
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUTO_FIX_ENVIRONMENT_CODES, type EvidencePack } from "@agentx/contracts";
import { projectDecisionCards, type DecisionItem } from "../../packages/broker/src/decisions/project.js";
import { fixSetupHandler } from "../../packages/broker/src/decisions/performer.js";
import {
  FIX_SETUP_TASKS_MAX, FIX_SETUP_TESTS_MAX, dismissFixSetup, failingOnOriginalTests, fixSetupCauseOf, fixSetupItemsFor, fixSetupNeedsSecondPerson, markKnownFailing, recordFixSetup, type SecondPersonPolicyPorts, type FixSetupDecisionPorts,
} from "../../packages/broker/src/test-env/fix-setup.js";
import { KNOWN_FAILING_MAX, alreadyFailingForResults, knownFailingKey, readKnownFailingRow } from "../../packages/broker/src/test-env/known-failing.js";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = `org_${"a".repeat(20)}`;
const PROJECT = "web";
const WHO = { orgId: ORG, developerId: "dev_a" };
const task = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CAUSE = "fails-on-original-code" as const;
const BROWSER = { ...WHO, browserSession: true as const };
const mark = (name: string, checkId = "unit") => ({ name, checkId });
type FixItem = Extract<DecisionItem, { kind: "fix_setup" }>;

function harness() {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  const clock = { now: Date.UTC(2026, 10, 2, 10, 0, 0) };
  const store = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit };
  const can = { value: true };
  // Who owns the tasks that waited on the card (default: someone else, so one maintainer may mark) and the company's "always two people" setting (default off).
  const owners = new Map<string, string>();
  const always = { value: false };
  const policy: SecondPersonPolicyPorts = {
    task: async (id) => ({ taskId: id, orgId: ORG, project: PROJECT, developerId: owners.get(id) ?? "dev_other", developerName: "Other", provider: "github" }) as never,
    alwaysTwoPeople: async () => always.value,
  };
  const ports: FixSetupDecisionPorts = { store, mayEditSettings: async () => can.value, policy };
  const tasks = new Map<string, Record<string, unknown>>();
  const cardPorts = { store, maintainedProjects: async () => [PROJECT], task: async (id: string) => tasks.get(id) as never };
  const items = async (env: NodeJS.ProcessEnv = { VERIFY_RESULTS_ENABLED: "1" }) => fixSetupItemsFor(cardPorts, WHO, env);
  const only = async (): Promise<FixItem> => {
    const found = await items();
    expect(found).toHaveLength(1);
    return found[0] as FixItem;
  };
  return { db, audit, clock, store, can, ports, tasks, items, only, owners, always, policy };
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

describe("the task titles on the card", () => {
  it("say how many more tasks wait than are named", async () => {
    const h = harness();
    for (let n = 1; n <= 7; n += 1) {
      h.tasks.set(task(n), { taskId: task(n), title: `Own task ${String(n)}`, orgId: ORG, project: PROJECT, developerId: "dev_a", developerName: "Ana", provider: "github" });
      await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(n), cause: "login-failed" });
    }
    const [item] = await h.items() as FixItem[];
    const lines = item!.details?.find((group) => group.title === "Tasks waiting on this")?.lines ?? [];
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe("and 2 more");
  });
});

describe("the tests a card could mark", () => {
  const pack = (checks: Array<Record<string, unknown>>): EvidencePack => ({ checks } as unknown as EvidencePack);
  const check = (names: Array<[string, string]>, over: Record<string, unknown> = {}, newTests: string[] = []) => ({
    checkId: "unit", after: "failed", class: "already_failing",
    tests: { total: names.length + 1, passed: 1, failed: names.filter(([, status]) => status === "failed").length, skipped: 0, errored: names.filter(([, status]) => status === "errored").length, names: names.map(([name, status]) => ({ name, status })), newTests },
    ...over,
  });

  it("are the failing tests of checks that failed on the original code AND that the nightly baseline lists, once each per check", () => {
    const offer = failingOnOriginalTests(pack([check([["t/a.py::one", "failed"], ["t/a.py::two", "errored"]]), check([["t/a.py::one", "failed"]], { checkId: "lint" })]), ["t/a.py::one", "t/a.py::two", "t/other::x"]);
    expect(offer).toEqual({ tests: [{ name: "t/a.py::one", checkId: "unit" }, { name: "t/a.py::two", checkId: "unit" }, { name: "t/a.py::one", checkId: "lint" }], unconfirmed: 0, codeFault: false });
  });

  it("never offers a test the change broke in a check that also failed before (B), or one the change added (C): the check is then the code's fault and nothing is offered", () => {
    const evidence = pack([check([["t::A", "failed"], ["t::B", "failed"], ["t::C", "failed"]], {}, ["t::C"])]);
    expect(failingOnOriginalTests(evidence, ["t::A", "t::C"])).toEqual({ tests: [], unconfirmed: 2, codeFault: true });
    // C is nightly-listed here only to prove the new-test list alone keeps it out.
    expect(failingOnOriginalTests(pack([check([["t::A", "failed"], ["t::C", "failed"]], {}, ["t::C"])]), ["t::A", "t::C"])).toEqual({ tests: [], unconfirmed: 1, codeFault: true });
  });

  it("with no nightly data (unknown, stale, truncated, never run) or none that matches, every failing test is unconfirmed: nothing is offered and it is the code's fault", () => {
    const evidence = pack([check([["t::A", "failed"]])]);
    expect(failingOnOriginalTests(evidence, [])).toEqual({ tests: [], unconfirmed: 1, codeFault: true });
    expect(failingOnOriginalTests(evidence, ["t::other"])).toEqual({ tests: [], unconfirmed: 1, codeFault: true });
  });

  it("says nothing when the pack is missing, the check is not a failure on the original code, or it has no test counts; failing tests the pack does not name are unconfirmed", () => {
    expect(failingOnOriginalTests(undefined, ["a"])).toBeUndefined();
    expect(failingOnOriginalTests(pack([]), ["a"])).toBeUndefined();
    expect(failingOnOriginalTests(pack([check([["a", "failed"]], { class: "regression" })]), ["a"])).toBeUndefined();
    // A check that is not a test kind (here with no kind at all) and has no test counts has no tests to judge; a TEST check with none cannot confirm anything: the code's fault (M2).
    expect(failingOnOriginalTests(pack([check([["a", "failed"]], { tests: undefined })]), ["a"])).toBeUndefined();
    expect(failingOnOriginalTests(pack([check([["a", "failed"]], { tests: undefined, kind: "test" })]), ["a"])).toEqual({ tests: [], unconfirmed: 1, codeFault: true });
    expect(failingOnOriginalTests(pack([check([["a", "failed"]], { tests: { total: 3, passed: 1, failed: 2, skipped: 0, errored: 0, names: [{ name: "a", status: "failed" }], newTests: [] } })]), ["a"])).toEqual({ tests: [], unconfirmed: 2, codeFault: true });
  });

  it("never offers a name that is not shown in full (over 200 characters or with whitespace; it is unconfirmed), and not more than one card shows", () => {
    const long = "t".repeat(201);
    expect(failingOnOriginalTests(pack([check([[long, "failed"]])]), [long])).toMatchObject({ tests: [], codeFault: true });
    expect(failingOnOriginalTests(pack([check([["has space", "failed"]])]), ["has space"])).toMatchObject({ tests: [], codeFault: true });
    const many = Array.from({ length: FIX_SETUP_TESTS_MAX + 1 }, (_, n) => `t${String(n)}`);
    expect(failingOnOriginalTests(pack([check(many.map((name) => [name, "failed"] as [string, string]))]), many)).toBeUndefined();
    const fits = many.slice(0, FIX_SETUP_TESTS_MAX);
    expect(failingOnOriginalTests(pack([check(fits.map((name) => [name, "failed"] as [string, string]))]), fits)?.tests).toHaveLength(FIX_SETUP_TESTS_MAX);
  });

  it("make the card offer a mark; a later task whose list does not fit removes the offer for everyone, never a partial one", async () => {
    const h = harness();
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: CAUSE, tests: [mark("t::a"), mark("t::b")], unconfirmed: 1 });
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(2), cause: CAUSE, tests: [mark("t::b"), mark("t::c")], unconfirmed: 3 });
    const item = await h.only();
    expect(item.knownFailingTests).toBe(3);
    expect(item.unconfirmedFailing).toBe(3);
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(3), cause: CAUSE, tests: Array.from({ length: FIX_SETUP_TESTS_MAX + 1 }, (_, n) => mark(`big${String(n)}`)) });
    expect((await h.only()).knownFailingTests).toBe(0);
    // Tests given for any other cause are ignored.
    const other = harness();
    await recordFixSetup(other.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: "login-failed", tests: [mark("t::a")] });
    expect((await other.only()).knownFailingTests).toBe(0);
  });

  it("a full record changes nothing for a later task: its tests are those of its first tasks", async () => {
    const h = harness();
    for (let n = 1; n <= FIX_SETUP_TASKS_MAX; n += 1) await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(n), cause: CAUSE, tests: [mark("t::a")] });
    const before = await h.only();
    expect(await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(99), cause: CAUSE, tests: [mark("t::z")], unconfirmed: 9 })).toBe("unchanged");
    const after = await h.only();
    expect(after).toEqual(before);
    expect(after.contentVersion).toBe(before.contentVersion);
  });
});

describe("Mark as known failing", () => {
  const opened = async (tests = [mark("t/a.py::one"), mark("t/a.py::two", "lint")]) => {
    const h = harness();
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: CAUSE, tests });
    return { h, item: await h.only() };
  };

  it("adds the record's own tests to the project's set with who, when, which card and which check, closes the card and audits it, all in one transaction", async () => {
    const { h, item } = await opened();
    expect(await markKnownFailing(h.ports, BROWSER, item, "request-1")).toBe("done");
    const row = (await readKnownFailingRow(h.store, ORG, PROJECT))!;
    expect(row.marks).toEqual([
      { name: "t/a.py::one", checkId: "unit", markedBy: "dev_a", markedAt: new Date(h.clock.now).toISOString(), epoch: 1 },
      { name: "t/a.py::two", checkId: "lint", markedBy: "dev_a", markedAt: new Date(h.clock.now).toISOString(), epoch: 1 },
    ]);
    expect(await h.items()).toEqual([]);
    const events = h.audit.recordedBy("project.known_failing_marked");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { id: "dev_a" }, target: { kind: "project", name: PROJECT }, facts: { cause: CAUSE, testCount: 2, recordEpoch: 1, taskCount: 1, rowVersionAfter: 1, totalAfter: 2 } });
    const facts = events[0]!.facts as Record<string, unknown>;
    expect(facts.testSetSha256).toBe(createHash("sha256").update(["lint\tt/a.py::two", "unit\tt/a.py::one"].join("\n")).digest("hex"));
    expect(facts.taskIdsSha256).toBe(createHash("sha256").update(task(1)).digest("hex"));
    // The audit event names no test.
    expect(JSON.stringify(events[0])).not.toContain("t/a.py");
    expect(h.db.transactions().at(-1)!.length).toBe(3);
  });

  it("is refused for anything but a live browser session, and writes nothing", async () => {
    const { h, item } = await opened();
    for (const caller of [WHO, { ...WHO, browserSession: undefined }]) await expect(markKnownFailing(h.ports, caller, item, "r"), "no session").rejects.toThrow("Use a live browser session to mark tests as known failing.");
    expect(await readKnownFailingRow(h.store, ORG, PROJECT)).toEqual({ marks: [], version: 0 });
    expect(await h.items()).toHaveLength(1);
    // Not now stays open to any caller.
    expect(await dismissFixSetup(h.ports, WHO, item)).toBe("done");
  });

  it("feeds the result classifier's set: the nightly failures by name, the marks by name and check", async () => {
    const { h, item } = await opened();
    await markKnownFailing(h.ports, BROWSER, item, "request-1");
    expect(await alreadyFailingForResults(h.store, ORG, PROJECT)).toEqual([{ name: "t/a.py::one", checkId: "unit" }, { name: "t/a.py::two", checkId: "lint" }]);
  });

  it("is refused for a caller who may not edit the project's settings, and writes nothing", async () => {
    const { h, item } = await opened();
    h.can.value = false;
    await expect(markKnownFailing(h.ports, BROWSER, item, "request-1")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readKnownFailingRow(h.store, ORG, PROJECT)).toEqual({ marks: [], version: 0 });
    expect(await h.items()).toHaveLength(1);
  });

  it("is stale when another task joined after the card was shown (the person never marks tests they were not shown)", async () => {
    const { h, item } = await opened();
    await recordFixSetup(h.store, { orgId: ORG, project: PROJECT, taskId: task(2), cause: CAUSE, tests: [mark("t/a.py::three")] });
    expect(await markKnownFailing(h.ports, BROWSER, item, "request-1")).toBe("stale");
    expect((await readKnownFailingRow(h.store, ORG, PROJECT))!.marks).toEqual([]);
    expect((await h.only()).knownFailingTests).toBe(3);
  });

  it("takes nothing from the card: the tests marked are the stored record's, whatever the item says", async () => {
    const { h, item } = await opened();
    const forged = { ...item, knownFailingTests: 1, details: [{ title: "Tests that would be marked as already failing", lines: ["evil::test"] }] } as FixItem;
    expect(await markKnownFailing(h.ports, BROWSER, forged, "request-1")).toBe("done");
    expect((await readKnownFailingRow(h.store, ORG, PROJECT))!.marks.map((m) => m.name)).toEqual(["t/a.py::one", "t/a.py::two"]);
  });

  it("a second press of the same card is stale, not a second mark", async () => {
    const { h, item } = await opened();
    await markKnownFailing(h.ports, BROWSER, item, "request-1");
    expect(await markKnownFailing(h.ports, BROWSER, item, "request-2")).toBe("stale");
    expect(h.audit.recordedBy("project.known_failing_marked")).toHaveLength(1);
  });

  it("is not ready when the record has no tests or is not the original-code cause", async () => {
    const none = harness();
    await recordFixSetup(none.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: CAUSE });
    expect(await markKnownFailing(none.ports, BROWSER, await none.only(), "r")).toBe("not_ready");
    const wrong = harness();
    await recordFixSetup(wrong.store, { orgId: ORG, project: PROJECT, taskId: task(1), cause: "login-failed" });
    expect(await markKnownFailing(wrong.ports, BROWSER, await wrong.only(), "r")).toBe("not_ready");
  });

  it("refuses a list that would pass the limit with its own sentence, and marks nothing", async () => {
    const { h, item } = await opened([mark("new::one")]);
    const old = { checkId: "unit", markedBy: "dev_b", markedAt: "2026-11-01T00:00:00.000Z", epoch: 1 };
    h.db.set({ ...knownFailingKey(ORG, PROJECT), entityType: "TEST_ENV_KNOWN_FAILING", marks: Array.from({ length: KNOWN_FAILING_MAX }, (_, n) => ({ ...old, name: `old${String(n)}` })), version: 1, updatedAt: "2026-11-01T00:00:00.000Z" });
    await expect(markKnownFailing(h.ports, BROWSER, item, "r")).rejects.toThrow("This project's known-failing list is full (500). Remove some with Undo on the project page (Environment) before marking more.");
    expect((await readKnownFailingRow(h.store, ORG, PROJECT))!.marks).toHaveLength(KNOWN_FAILING_MAX);
    expect(await h.items()).toHaveLength(1);
  });

  it("refuses to write when the project's marks cannot be read (a damaged row excuses nothing and takes no more)", async () => {
    const { h, item } = await opened();
    h.db.set({ ...knownFailingKey(ORG, PROJECT), entityType: "TEST_ENV_KNOWN_FAILING", marks: "not a list", version: 1 });
    expect(await markKnownFailing(h.ports, BROWSER, item, "r")).toBe("not_ready");
    expect(await alreadyFailingForResults(h.store, ORG, PROJECT)).toEqual([]);
  });

  it("asks the second-person seam before writing; 'needed' stops the mark until a confirmation stands, and nothing is written", async () => {
    const { h, item } = await opened();
    const asked: string[] = [];
    const stop = { ...h.ports, secondPersonNeed: async (input: { project: string }) => { asked.push(input.project); return { need: "needed" as const, why: "owner_of_affected_task" as const }; } };
    await expect(markKnownFailing(stop, { ...BROWSER, orgRole: "owner" }, item, "r")).rejects.toThrow("A second person has to confirm this");
    expect(asked).toEqual([PROJECT]);
    expect((await readKnownFailingRow(h.store, ORG, PROJECT))!.marks).toEqual([]);
    expect(await h.items()).toHaveLength(1);
  });
});

describe("when a second person is needed (owner decision F4)", () => {
  const record = (taskIds: string[], taskCount = taskIds.length) => ({ taskIds, taskCount, cause: CAUSE, epoch: 1 });
  const need = (h: ReturnType<typeof harness>, r: ReturnType<typeof record>) => fixSetupNeedsSecondPerson({ caller: WHO, record: r, project: PROJECT, policy: h.policy });

  it("is not needed for a presser who owns none of the affected tasks: one maintainer may mark", async () => {
    const h = harness();
    expect(await need(h, record([task(1), task(2)]))).toEqual({ need: "not_needed", why: "not_needed" });
  });

  it("is needed when the presser is the effective owner of any affected task", async () => {
    const h = harness();
    h.owners.set(task(2), "dev_a");
    expect(await need(h, record([task(1), task(2), task(3)]))).toEqual({ need: "needed", why: "owner_of_affected_task" });
  });

  it("is needed when an owner cannot be told: a task that cannot be read, one from another company, or no ports at all", async () => {
    const h = harness();
    const broken = { ...h.policy, task: async (id: string) => { if (id === task(2)) throw new Error("unreadable"); return h.policy.task(id); } };
    expect(await fixSetupNeedsSecondPerson({ caller: WHO, record: record([task(1), task(2)]), project: PROJECT, policy: broken })).toEqual({ need: "needed", why: "owner_unknown" });
    const missing = { ...h.policy, task: async () => undefined };
    expect((await fixSetupNeedsSecondPerson({ caller: WHO, record: record([task(1)]), project: PROJECT, policy: missing })).why).toBe("owner_unknown");
    const foreign = { ...h.policy, task: async (id: string) => ({ ...(await h.policy.task(id))!, orgId: "org_zzzzzzzzzzzzzzzzzzzz" }) as never };
    expect((await fixSetupNeedsSecondPerson({ caller: WHO, record: record([task(1)]), project: PROJECT, policy: foreign })).why).toBe("owner_unknown");
    expect(await fixSetupNeedsSecondPerson({ caller: WHO, record: record([task(1)]), project: PROJECT, policy: undefined })).toEqual({ need: "needed", why: "owner_unknown" });
  });

  it("is needed when the record is full (25 tasks): not every owner is known", async () => {
    const h = harness();
    const ids = Array.from({ length: FIX_SETUP_TASKS_MAX }, (_, n) => task(n + 1));
    expect(await need(h, record(ids, FIX_SETUP_TASKS_MAX))).toEqual({ need: "needed", why: "record_full" });
    expect(await need(h, record(ids.slice(0, 3), 3))).toEqual({ need: "not_needed", why: "not_needed" });
  });

  it("is needed for everyone when the company turned on always two people, and when that setting cannot be read", async () => {
    const h = harness();
    h.always.value = true;
    expect(await need(h, record([task(1)]))).toEqual({ need: "needed", why: "always_two" });
    const unreadable = { ...h.policy, alwaysTwoPeople: async () => { throw new Error("unreadable"); } };
    expect(await fixSetupNeedsSecondPerson({ caller: WHO, record: record([task(1)]), project: PROJECT, policy: unreadable })).toEqual({ need: "needed", why: "always_two" });
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
    const handler = fixSetupHandler<typeof BROWSER>({
      markKnownFailing: async () => (answers.shift() ?? "done") as never,
      dismiss: async () => (answers.shift() ?? "done") as never,
    });
    const item = { kind: "fix_setup" } as DecisionItem;
    const input = { card: {} as never, item, requestId: "r" };
    expect(await handler.approve(BROWSER, input)).toEqual({ kind: "done" });
    answers.push("stale");
    expect(await handler.approve(BROWSER, input)).toEqual({ kind: "refused", reason: "stale" });
    answers.push("second_person");
    expect(await handler.approve(BROWSER, input)).toEqual({ kind: "refused", reason: "second_person_required" });
    answers.push("not_ready");
    expect(await handler.reject!(WHO as typeof BROWSER, { ...input, reason: "not_now" })).toEqual({ kind: "refused", reason: "not_ready" });
    expect(await handler.approve(BROWSER, { ...input, item: { kind: "merge" } as DecisionItem })).toEqual({ kind: "refused", reason: "unsupported" });
  });

  it("an approve from anything but a live browser session is refused with the sentence before any port is asked, and a reject is not", async () => {
    let asked = 0;
    const handler = fixSetupHandler<typeof WHO>({ markKnownFailing: async () => { asked += 1; return "done"; }, dismiss: async () => { asked += 1; return "done"; } });
    const input = { card: {} as never, item: { kind: "fix_setup" } as DecisionItem, requestId: "r" };
    await expect(handler.approve(WHO, input)).rejects.toThrow("Use a live browser session to mark tests as known failing.");
    expect(asked).toBe(0);
    expect(await handler.reject!(WHO, { ...input, reason: "not_now" })).toEqual({ kind: "done" });
  });
});
