// Setup and test health SH28: the store of proposed fix tasks, and the erase of everything the health stored.
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, orgProjectCatalogKey, projectMetaKey, projectPk, type OrgId } from "@agentx/contracts";
import { eraseOrgHealth, eraseProjectHealth } from "../../packages/broker/src/test-env/health-erase.js";
import { PROPOSED_OPEN_MAX, dismissProposedFixTask, listProposedFixTasks, proposedFixTaskStore } from "../../packages/broker/src/test-env/proposed-tasks.js";
import { setProposeFixTask } from "../../packages/broker/src/test-env/health.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PROJECT = "partner-service";
const T0 = Date.UTC(2026, 10, 5, 6, 0, 0);
const key = (n: number) => n.toString(16).padStart(64, "0");

function harness() {
  const db = new FakeDynamoDb();
  const clock = { now: T0 };
  const deps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: capturingAuditDeps({ db }).audit };
  return { db, clock, deps, store: proposedFixTaskStore(deps) };
}
const proposal = (n: number, over: Record<string, unknown> = {}) => ({ orgId: ORG, project: PROJECT, key: key(n), title: `${n} tests failing on main since 2026-11-05`, failingCount: n, testIds: ["tests/a.py::t1"], ...over });

describe("the proposed fix task store", () => {
  it("stores a proposal as a record, open, with the test ids; nothing else", async () => {
    const h = harness();
    await h.store.propose(proposal(2));
    expect(await listProposedFixTasks(h.deps, ORG, PROJECT)).toEqual([{ key: key(2), title: "2 tests failing on main since 2026-11-05", failingCount: 2, testIds: ["tests/a.py::t1"], proposedAt: new Date(T0).toISOString(), status: "open" }]);
    expect(h.db.find((item) => String(item.sk).startsWith("TESTENV#PROPOSEDTASK#"))).toHaveLength(1);
  });

  it("proposing the same set again stores nothing more, and never brings back one that was dismissed", async () => {
    const h = harness();
    await h.store.propose(proposal(2));
    await h.store.propose(proposal(2));
    expect(await listProposedFixTasks(h.deps, ORG, PROJECT)).toHaveLength(1);
    await dismissProposedFixTask(h.deps, { orgId: ORG, project: PROJECT, role: "maintainer", key: key(2) });
    await h.store.propose(proposal(2));
    expect((await listProposedFixTasks(h.deps, ORG, PROJECT)).map((entry) => entry.status)).toEqual(["dismissed"]);
  });

  it("lists open ones first, newest first, and keeps one project's apart from another's", async () => {
    const h = harness();
    await h.store.propose(proposal(1));
    h.clock.now += 1_000;
    await h.store.propose(proposal(2));
    h.clock.now += 1_000;
    await h.store.propose(proposal(3));
    await dismissProposedFixTask(h.deps, { orgId: ORG, project: PROJECT, role: "maintainer", key: key(3) });
    expect((await listProposedFixTasks(h.deps, ORG, PROJECT)).map((entry) => [entry.failingCount, entry.status])).toEqual([[2, "open"], [1, "open"], [3, "dismissed"]]);
    expect(await listProposedFixTasks(h.deps, OTHER, PROJECT)).toEqual([]);
    expect(await listProposedFixTasks(h.deps, ORG, "another")).toEqual([]);
  });

  it("stores no more than the open cap, and does not fail", async () => {
    const h = harness();
    for (let n = 1; n <= PROPOSED_OPEN_MAX + 3; n += 1) await h.store.propose(proposal(n));
    expect(await listProposedFixTasks(h.deps, ORG, PROJECT)).toHaveLength(PROPOSED_OPEN_MAX);
    await dismissProposedFixTask(h.deps, { orgId: ORG, project: PROJECT, role: "maintainer", key: key(1) });
    await h.store.propose(proposal(PROPOSED_OPEN_MAX + 5));
    expect((await listProposedFixTasks(h.deps, ORG, PROJECT)).filter((entry) => entry.status === "open")).toHaveLength(PROPOSED_OPEN_MAX);
  });

  it("refuses a proposal that is not bounded plain words and ids, and expires what it stores", async () => {
    const h = harness();
    await expect(h.store.propose(proposal(1, { title: "bad\ntitle" }))).rejects.toThrow();
    await expect(h.store.propose(proposal(1, { testIds: ["has space"] }))).rejects.toThrow();
    await expect(h.store.propose(proposal(1, { key: "nope" }))).rejects.toThrow();
    await h.store.propose(proposal(1, { testIds: Array.from({ length: 50 }, (_, index) => `t${index}`) }));
    expect((await listProposedFixTasks(h.deps, ORG, PROJECT))[0]?.testIds).toHaveLength(20);
    const stored = h.db.find((item) => String(item.sk).startsWith("TESTENV#PROPOSEDTASK#"))[0]!;
    expect(stored[INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor((T0 + 30 * 86_400_000) / 1000));
  });

  it("is dismissed only by a maintainer, and only a proposal that exists", async () => {
    const h = harness();
    await h.store.propose(proposal(1));
    for (const role of [undefined, "viewer", "contributor"] as const) await expect(dismissProposedFixTask(h.deps, { orgId: ORG, project: PROJECT, role, key: key(1) })).rejects.toThrow(/maintainer/);
    await expect(dismissProposedFixTask(h.deps, { orgId: ORG, project: PROJECT, role: "maintainer", key: key(9) })).rejects.toThrow(/gone/);
    await expect(dismissProposedFixTask(h.deps, { orgId: ORG, project: PROJECT, role: "maintainer", key: "nope" })).rejects.toThrow(/not a proposal/);
    expect((await listProposedFixTasks(h.deps, ORG, PROJECT))[0]?.status).toBe("open");
  });

  it("an item that does not read back is left out of the list", async () => {
    const h = harness();
    await h.store.propose(proposal(1));
    await h.store.propose(proposal(2));
    const damaged = h.db.find((item) => String(item.sk).endsWith(key(1)))[0]!;
    h.db.set({ ...damaged, proposal: { ...(damaged.proposal as object), failingCount: -5 } });
    expect((await listProposedFixTasks(h.deps, ORG, PROJECT)).map((entry) => entry.failingCount)).toEqual([2]);
  });
});

describe("what the health stored goes with the project", () => {
  async function seeded(h: ReturnType<typeof harness>, org: OrgId, project: string) {
    h.db.set({ ...orgProjectCatalogKey(org, project), entityType: "PROJECT_CATALOG", name: project });
    h.db.set({ ...projectMetaKey(org, project), status: "active" });
    await h.store.propose({ ...proposal(2), orgId: org, project });
    await setProposeFixTask(h.deps, { orgId: org, project, role: "maintainer", changedBy: "dev_a", enabled: true, requestId: `request-${project}` });
    h.db.set({ pk: projectPk(org, project), sk: "TESTENV#HEALTH", entityType: "TEST_ENV_HEALTH" });
    h.db.set({ pk: projectPk(org, project), sk: "TESTENV#REV#000001", entityType: "TEST_ENV_REVISION" });
  }
  const mine = (h: ReturnType<typeof harness>, org: OrgId, project: string) => h.db.find((item) => item.pk === projectPk(org, project) && /^TESTENV#(HEALTH|PROPOSEDTASK#)/u.test(String(item.sk)));
  const revisions = (h: ReturnType<typeof harness>, org: OrgId, project: string) => h.db.find((item) => item.pk === projectPk(org, project) && item.sk === "TESTENV#REV#000001");

  it("a project erase removes its health, its setting and its proposals, and nothing of another project or of the approved environment", async () => {
    const h = harness();
    await seeded(h, ORG, PROJECT);
    await seeded(h, ORG, "other-project");
    expect(mine(h, ORG, PROJECT).map((item) => String(item.sk).replace(/PROPOSEDTASK#.*$/u, "PROPOSEDTASK#")).sort()).toEqual(["TESTENV#HEALTH", "TESTENV#HEALTH#SETTINGS", "TESTENV#PROPOSEDTASK#"]);
    await eraseProjectHealth(h.deps, ORG, PROJECT);
    expect(mine(h, ORG, PROJECT)).toEqual([]);
    expect(mine(h, ORG, "other-project")).toHaveLength(3);
    expect(revisions(h, ORG, PROJECT)).toHaveLength(1);
    await eraseProjectHealth(h.deps, ORG, PROJECT);
  });

  it("a company erase goes through every project of the company, and no other company", async () => {
    const h = harness();
    await seeded(h, ORG, PROJECT);
    await seeded(h, ORG, "second-project");
    await seeded(h, OTHER, PROJECT);
    expect(await eraseOrgHealth(h.deps, ORG)).toBe("done");
    expect(mine(h, ORG, PROJECT)).toEqual([]);
    expect(mine(h, ORG, "second-project")).toEqual([]);
    expect(mine(h, OTHER, PROJECT)).toHaveLength(3);
    expect(revisions(h, ORG, PROJECT)).toHaveLength(1);
  });
});
