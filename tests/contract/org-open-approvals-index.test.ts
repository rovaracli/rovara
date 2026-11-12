// 0.5.15 (APPROVALS-SUMMARY-PER-ORG-INDEX): every PENDING approval has an item in its company's own open index (`ORG#<org>#OPEN_APPROVALS`) beside the install-wide `OPEN_APPROVALS` one, written and
// removed in the SAME transactions (create, decide, expire, withdraw, close); the company's pending summary reads only the caller's partition once the one-off backfill is done, and the global
// index until then. These tests hold two companies on one install.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ORG_OPEN_APPROVALS_BACKFILL_KEY, OrgPendingApprovalsSummarySchema, orgOpenApprovalKey, orgOpenApprovalsPk } from "@agentx/cloud-contracts";
import { approvalKey, openApprovalKey, type OrgId } from "@rovara-code/contracts";
import {
  approvalTaskEventKey, createPendingChange, createStepApproval, createWriteApprovalRecord, decideApproval, expireApprovalNow, getAnyApproval, type ApprovalDependencies, type WriteApprovalRecord,
} from "../../packages/broker/src/agents/approvals.js";
import { withdrawChange } from "../../packages/broker/src/agents/approvals-decide.js";
import { closeStepApproval } from "../../packages/broker/src/chains/lifecycle.js";
import { backfillOrgOpenApprovals } from "../../packages/broker/src/agents/org-open-approvals-backfill.js";
import { ORG_PENDING_SCAN_MAX } from "../../packages/broker/src/agents/org-pending-summary.js";
import { orgAdminApprovers } from "../../packages/broker/src/agents/changes.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { ADA, BEN, CARL, ORG_B, person, setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";

const BETH = person("6", "Beth Owner");
const PATH = "/v1/app/org/approvals/pending-summary";
const orgResolver: OrgResolver = async (subject) => (subject.developerId === BETH.developerId ? ORG_B : TEST_ORG);

async function world() {
  const t = await setup({ decide: true, orgResolver });
  const { db } = t;
  db.set({ pk: `SESSION#${BETH.sessionId}`, sk: "META", sessionId: BETH.sessionId, developerId: BETH.developerId, amr: BETH.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  db.set({ pk: `DEVELOPER#${BETH.developerId}`, sk: "META", developerId: BETH.developerId, provider: BETH.provider, displayName: BETH.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  await t.orgOf(BETH);
  seedMembership(db, BETH.developerId, { orgId: ORG_B, role: "owner" });
  const deps = t.deps() as ApprovalDependencies;
  const taskId = randomUUID();
  let clock = Date.now() - 6 * 3_600_000;
  const tick = () => { clock += 60_000; return new Date(clock).toISOString(); };
  const change = async (orgId: OrgId = TEST_ORG, by = CARL.developerId) => {
    const record = await createPendingChange({ ...deps, now: () => clock }, {
      orgId, requestId: randomUUID(), requestedBy: by, subject: { kind: "code_settings", project: "payments", settingsRevision: 0, changes: { allowSelfApproval: true } },
      changes: ["Let a person approve a pull request that Rovara made for them, in project payments"], approvers: await orgAdminApprovers(deps, orgId),
    });
    clock += 60_000;
    return record;
  };
  let writes = 0;
  const write = async (orgId: OrgId = TEST_ORG) => {
    writes += 1;
    const approvalId = `apr_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const createdAt = tick();
    const record: WriteApprovalRecord = {
      orgId, approvalId, kind: "write", subject: { kind: "agent_run", taskId, stepId: `investigate-${String(writes)}` }, operationId: randomUUID(), connector: "linear", connectorType: "linear", tool: "save_issue", toolAccess: "write",
      scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64), arguments: { title: "x" }, argumentsHash: "c".repeat(64), summary: "create the issue",
      class: "consequential", approvers: { kind: "ids", ids: [BEN.developerId] }, status: "PENDING", project: "payments", owner: { developerId: BEN.developerId, name: BEN.name },
      attempts: 0, createdAt, expiresAt: new Date(Date.parse(createdAt) + 30 * 86_400_000).toISOString(),
    };
    const event = { Put: { TableName: "state", Item: { ...approvalTaskEventKey(taskId, createdAt, approvalId), entityType: "TASK_EVENT", orgId, kind: "status", text: "Agent wants to create the issue.", at: createdAt } } };
    expect(await createWriteApprovalRecord({ ...deps, now: () => clock }, record, [event], 80)).toBe("created");
    return record;
  };
  const step = async (orgId: OrgId = TEST_ORG) => { clock += 60_000; return createStepApproval({ ...deps, now: () => clock }, {
    orgId, subject: { kind: "agent_run", taskId: randomUUID(), stepId: "report" }, prompt: "Send the report?", approvers: { kind: "ids", ids: [BEN.developerId] }, project: "payments",
    owner: { developerId: BEN.developerId, name: BEN.name }, expiresAt: new Date(clock + 30 * 86_400_000).toISOString(),
  }); };
  const get = (who: typeof ADA) => t.dev(who, "GET", PATH);
  const summary = async (who: typeof ADA) => { const reply = await get(who); expect(reply.status, JSON.stringify(reply.body)).toBe(200); const { requestId: _id, ...rest } = reply.body; return OrgPendingApprovalsSummarySchema.parse(rest); }; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id
  const own = (record: { orgId: OrgId; createdAt: string; approvalId: string }) => db.get(orgOpenApprovalKey(record.orgId, record.createdAt, record.approvalId));
  const global = (record: { orgId: OrgId; expiresAt: string; approvalId: string }) => db.get(openApprovalKey(record.expiresAt, record.orgId, record.approvalId));
  /** What 0.5.14 left behind: the record and its global item, no company item and no backfill marker. */
  const asBeforeThisRelease = () => {
    for (const item of db.find((entry) => entry.entityType === "ORG_OPEN_APPROVAL")) db.delete({ pk: String(item.pk), sk: String(item.sk) });
    db.delete(ORG_OPEN_APPROVALS_BACKFILL_KEY);
  };
  const admin = { orgId: TEST_ORG, developerId: ADA.developerId, orgRole: "owner" as const };
  return { ...t, approvals: deps, change, write, step, get, summary, own, global, asBeforeThisRelease, admin };
}

/** Records every command sent to the table (name and input), without changing what the table does. */
function spy(db: { send: (command: unknown) => Promise<unknown> }) {
  const seen: Array<{ name: string; input: Record<string, unknown> }> = [];
  const original = db.send.bind(db);
  db.send = async (command: unknown) => {
    seen.push({ name: (command as { constructor: { name: string } }).constructor.name, input: (command as { input: Record<string, unknown> }).input });
    return original(command);
  };
  return seen;
}

describe("a company's open index is written and removed with the approval", () => {
  it("is written in the transaction that makes a change, a write and a step: ids, the org and the expiry, no person", async () => {
    const t = await world();
    for (const record of [await t.change(), await t.write(), await t.step()]) {
      const item = t.own(record);
      expect(item, record.kind).toMatchObject({ pk: orgOpenApprovalsPk(TEST_ORG), orgId: TEST_ORG, approvalId: record.approvalId, expiresAt: record.expiresAt, entityType: "ORG_OPEN_APPROVAL" });
      expect(Object.keys(item ?? {}).sort(), record.kind).toEqual(["approvalId", "entityType", "expiresAt", "indexExpiresAt", "orgId", "pk", "sk"]);
      expect(item?.indexExpiresAt).toBe(Math.floor(Date.parse(record.expiresAt) / 1000) + 86_400);
      expect(String(item?.sk).endsWith(`#${record.approvalId}`)).toBe(true);
      expect(t.global(record), record.kind).toBeDefined();
    }
    // The key is its own company's: another company's approval lands in its own partition.
    const other = await t.change(ORG_B, BETH.developerId);
    expect(t.own(other)?.pk).toBe(orgOpenApprovalsPk(ORG_B));
    expect(t.db.find((item) => item.pk === orgOpenApprovalsPk(TEST_ORG))).toHaveLength(3);
  });

  it("is made in the same transaction as the record and the global item (one TransactWrite holds all three)", async () => {
    const t = await world();
    const seen = spy(t.db as never);
    const record = await t.step();
    const transactions = seen.filter((entry) => entry.name === "TransactWriteCommand").map((entry) => entry.input.TransactItems as Array<{ Put?: { Item: { pk: string } } }>);
    const holding = transactions.filter((items) => items.some((entry) => entry.Put?.Item.pk === orgOpenApprovalsPk(TEST_ORG)));
    expect(holding).toHaveLength(1);
    const pks = holding[0]!.map((entry) => entry.Put?.Item.pk);
    expect(pks).toContain("OPEN_APPROVALS");
    expect(holding[0]!.some((entry) => entry.Put?.Item.pk === approvalKey(TEST_ORG, record.approvalId).pk)).toBe(true);
  });

  it("is removed when the approval is declined, with the same transaction that ends PENDING", async () => {
    const t = await world();
    const record = await t.change();
    expect(t.own(record)).toBeDefined();
    const seen = spy(t.db as never);
    expect(await decideApproval(t.approvals, t.admin, record.approvalId, { requestId: randomUUID(), decision: "DECLINE" })).toMatchObject({ status: "DECLINED" });
    expect(t.own(record)).toBeUndefined();
    expect(t.global(record)).toBeUndefined();
    const decide = seen.filter((entry) => entry.name === "TransactWriteCommand").map((entry) => entry.input.TransactItems as Array<{ Delete?: { Key: { pk: string } }; Update?: { Key: { pk: string } } }>)
      .filter((items) => items.some((entry) => entry.Delete?.Key.pk === orgOpenApprovalsPk(TEST_ORG)));
    expect(decide).toHaveLength(1);
    expect(decide[0]!.some((entry) => entry.Update?.Key.pk === approvalKey(TEST_ORG, record.approvalId).pk)).toBe(true);
  });

  it("is removed when the approval is approved and goes on executing (a step ends APPROVED)", async () => {
    const t = await world();
    const record = await t.step();
    const caller = { orgId: TEST_ORG, developerId: BEN.developerId, orgRole: "member" as const };
    await decideApproval(t.approvals, caller, record.approvalId, { requestId: randomUUID(), decision: "DECLINE" });
    expect(t.own(record)).toBeUndefined();
    expect(await getAnyApproval(t.approvals, TEST_ORG, record.approvalId as never)).toMatchObject({ status: "DECLINED" });
  });

  it("is removed when the approval expires, is withdrawn or is closed with its chain run", async () => {
    const t = await world();
    const expiring = await t.write();
    const withdrawn = await t.change();
    expect(await expireApprovalNow(t.approvals, expiring)).toBe(true);
    expect(t.own(expiring)).toBeUndefined();
    expect(await withdrawChange(t.approvals, withdrawn, CARL.developerId, [])).toMatchObject({ status: "EXPIRED" });
    expect(t.own(withdrawn)).toBeUndefined();
    // closeStepApproval only closes a chain gate of the run named; any other record is left, with its item.
    const step = await t.step();
    expect(await closeStepApproval(t.approvals, TEST_ORG, "run-1", step.approvalId, "the run ended")).toBe(false);
    expect(t.own(step)).toBeDefined();
  });

  it("leaves both indexes and the record as they were when the deciding transaction fails (atomic)", async () => {
    const t = await world();
    const record = await t.change();
    const original = t.db.send.bind(t.db) as (command: unknown) => Promise<unknown>;
    (t.db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
      return original(command);
    };
    await expect(decideApproval(t.approvals, t.admin, record.approvalId, { requestId: randomUUID(), decision: "DECLINE" })).rejects.toBeDefined();
    (t.db as unknown as { send: unknown }).send = original;
    expect(await getAnyApproval(t.approvals, TEST_ORG, record.approvalId as never)).toMatchObject({ status: "PENDING" });
    expect(t.own(record)).toBeDefined();
    expect(t.global(record)).toBeDefined();
  });

  it("deleting the company item of an approval that has none (made before this release) ends it normally", async () => {
    const t = await world();
    const record = await t.change();
    t.asBeforeThisRelease();
    expect(t.own(record)).toBeUndefined();
    expect(await decideApproval(t.approvals, t.admin, record.approvalId, { requestId: randomUUID(), decision: "DECLINE" })).toMatchObject({ status: "DECLINED" });
    expect(t.global(record)).toBeUndefined();
  });
});

describe("the summary reads the caller's own partition once the backfill is done", () => {
  it("queries only the caller's company partition: another company's approvals are never read or counted", async () => {
    const t = await world();
    const ours = [await t.change(), await t.write(), await t.step()];
    const theirs = [await t.change(ORG_B, BETH.developerId), await t.write(ORG_B), await t.step(ORG_B)];
    expect((await backfillOrgOpenApprovals(t.approvals)).complete).toBe(true);
    const seen = spy(t.db as never);
    const mine = await t.summary(ADA);
    expect(mine.total).toBe(3);
    expect(mine.approvals.map((entry) => entry.approvalId).sort()).toEqual(ours.map((record) => record.approvalId).sort());
    const queries = seen.filter((entry) => entry.name === "QueryCommand").map((entry) => (entry.input.ExpressionAttributeValues as Record<string, unknown>)[":pk"]);
    expect(queries).toEqual([orgOpenApprovalsPk(TEST_ORG)]);
    // Newest first, read from the partition itself.
    expect(seen.find((entry) => entry.name === "QueryCommand")?.input.ScanIndexForward).toBe(false);
    const gets = seen.filter((entry) => entry.name === "GetCommand").map((entry) => String((entry.input.Key as { pk: string }).pk));
    for (const record of theirs) expect(gets.some((pk) => pk.includes(record.approvalId)), record.approvalId).toBe(false);
    const hers = await t.summary(BETH);
    expect(hers.total).toBe(3);
    expect(hers.approvals.map((entry) => entry.approvalId).sort()).toEqual(theirs.map((record) => record.approvalId).sort());
  });

  it("is not crowded out by other companies' approvals: they are not in its partition, so the newest of the company are always read", async () => {
    const t = await world();
    const mine = await t.change();
    for (let n = 0; n < ORG_PENDING_SCAN_MAX + 5; n += 1) {
      const id = `apr_${String(n).padStart(20, "0")}`;
      t.db.set({ pk: "OPEN_APPROVALS", sk: `2026-01-01T00:00:00.000Z#${ORG_B}#${id}`, entityType: "OPEN_APPROVAL", orgId: ORG_B, approvalId: id });
      t.db.set({ pk: orgOpenApprovalsPk(ORG_B), sk: `2026-01-01T00:00:00.000Z#${id}`, entityType: "ORG_OPEN_APPROVAL", orgId: ORG_B, approvalId: id });
    }
    // Before the backfill: the old read, which the other company's items fill (the answer says it may be short).
    expect(await t.summary(ADA)).toMatchObject({ total: 0, truncated: true });
    await backfillOrgOpenApprovals(t.approvals, { pageSize: 50 });
    const after = await t.summary(ADA);
    expect(after.truncated).toBeUndefined();
    expect(after.total).toBe(1);
    expect(after.approvals.map((entry) => entry.approvalId)).toEqual([mine.approvalId]);
  });

  it("an item in the partition that names another company or another approval counts nothing", async () => {
    const t = await world();
    const ours = await t.change();
    const theirs = await t.change(ORG_B, BETH.developerId);
    await backfillOrgOpenApprovals(t.approvals);
    t.db.set({ pk: orgOpenApprovalsPk(TEST_ORG), sk: `${theirs.createdAt}#${theirs.approvalId}`, entityType: "ORG_OPEN_APPROVAL", orgId: TEST_ORG, approvalId: theirs.approvalId });
    t.db.set({ pk: orgOpenApprovalsPk(TEST_ORG), sk: `${ours.createdAt.replace(/\d{2}\.\d{3}Z$/, "59.999Z")}#apr_zzzzzzzzzzzzzzzzzzzz`, entityType: "ORG_OPEN_APPROVAL", orgId: TEST_ORG, approvalId: ours.approvalId });
    const summary = await t.summary(ADA);
    expect(summary.approvals.map((entry) => entry.approvalId)).toEqual([ours.approvalId]);
    expect(summary.total).toBe(1);
  });
});

describe("the gap before the backfill", () => {
  it("reads the global index while the marker is not set, even when the company's partition holds some items", async () => {
    const t = await world();
    const old = [await t.change(), await t.write()];
    t.asBeforeThisRelease();
    // An approval made after the deploy has its company item; the older two do not. A summary that trusted the partition would show one.
    const fresh = await t.step();
    expect(t.db.find((item) => item.pk === orgOpenApprovalsPk(TEST_ORG))).toHaveLength(1);
    const seen = spy(t.db as never);
    const during = await t.summary(ADA);
    expect(during.total).toBe(3);
    expect(during.approvals.map((entry) => entry.approvalId).sort()).toEqual([...old, fresh].map((record) => record.approvalId).sort());
    expect(seen.filter((entry) => entry.name === "QueryCommand").map((entry) => (entry.input.ExpressionAttributeValues as Record<string, unknown>)[":pk"])).toEqual(["OPEN_APPROVALS"]);
  });

  it("reads the same answer from the company's partition once the backfill is done", async () => {
    const t = await world();
    for (let n = 0; n < 4; n += 1) { await t.change(); await t.write(); }
    await t.change(ORG_B, BETH.developerId);
    const before = await t.summary(ADA);
    t.asBeforeThisRelease();
    expect(await t.summary(ADA)).toEqual(before);
    const report = await backfillOrgOpenApprovals(t.approvals);
    expect(report).toMatchObject({ ran: true, copied: 9, complete: true });
    expect(await t.summary(ADA)).toEqual(before);
    expect(t.db.find((item) => item.pk === orgOpenApprovalsPk(TEST_ORG))).toHaveLength(8);
  });
});

describe("the backfill", () => {
  it("is idempotent: a second run reads only the marker, and a forced pass writes the same items", async () => {
    const t = await world();
    const records = [await t.change(), await t.write(), await t.step(), await t.change(ORG_B, BETH.developerId)];
    t.asBeforeThisRelease();
    await backfillOrgOpenApprovals(t.approvals);
    const items = () => JSON.stringify(t.db.find((item) => item.entityType === "ORG_OPEN_APPROVAL").sort((a, b) => String(a.sk).localeCompare(String(b.sk))));
    const first = items();
    for (const record of records) expect(t.own(record), record.approvalId).toBeDefined();
    const seen = spy(t.db as never);
    expect(await backfillOrgOpenApprovals(t.approvals)).toEqual({ ran: false, copied: 0, skipped: 0, complete: true });
    expect(seen.map((entry) => entry.name)).toEqual(["GetCommand"]);
    // Taking the marker away (an operator's re-run) walks again and changes nothing.
    t.db.delete(ORG_OPEN_APPROVALS_BACKFILL_KEY);
    expect(await backfillOrgOpenApprovals(t.approvals)).toMatchObject({ ran: true, copied: 4, complete: true });
    expect(items()).toBe(first);
  });

  it("copies only PENDING approvals: not one that was decided, one whose record is gone, or a follow-up due item", async () => {
    const t = await world();
    const live = await t.change();
    const decided = await t.write();
    const gone = await t.change();
    await decideApproval(t.approvals, { orgId: TEST_ORG, developerId: BEN.developerId, orgRole: "member" }, (await t.step()).approvalId, { requestId: randomUUID(), decision: "DECLINE" });
    t.asBeforeThisRelease();
    t.db.set({ ...t.db.get(approvalKey(TEST_ORG, decided.approvalId))!, status: "DECLINED" });
    t.db.delete(approvalKey(TEST_ORG, gone.approvalId));
    t.db.set({ pk: "OPEN_APPROVALS", sk: "garbage" });
    const report = await backfillOrgOpenApprovals(t.approvals);
    expect(report.complete).toBe(true);
    expect(t.db.find((item) => item.entityType === "ORG_OPEN_APPROVAL").map((item) => item.approvalId)).toEqual([live.approvalId]);
  });

  it("does not list an approval that is decided while it is being read (the put and a PENDING check are one transaction)", async () => {
    const t = await world();
    const record = await t.change();
    t.asBeforeThisRelease();
    const original = t.db.send.bind(t.db) as (command: unknown) => Promise<unknown>;
    (t.db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      // Between the backfill's read of the record and its write: the approval is declined.
      if (name === "TransactWriteCommand") t.db.set({ ...t.db.get(approvalKey(TEST_ORG, record.approvalId))!, status: "DECLINED" });
      return original(command);
    };
    const report = await backfillOrgOpenApprovals(t.approvals);
    expect(report).toMatchObject({ copied: 0, complete: true });
    expect(t.own(record)).toBeUndefined();
  });

  it("stops at its deadline, keeps its place, and finishes on the next run; the summary reads the global index until then", async () => {
    const t = await world();
    for (let n = 0; n < 5; n += 1) await t.change();
    t.asBeforeThisRelease();
    let now = 1_000;
    const deps = { ...t.approvals, now: () => { now += 10; return now; } };
    const partial = await backfillOrgOpenApprovals(deps, { pageSize: 2, deadline: 1_000 + 70 });
    expect(partial.complete).toBe(false);
    expect(partial.copied).toBeGreaterThan(0);
    expect(partial.copied).toBeLessThan(5);
    expect(t.db.get(ORG_OPEN_APPROVALS_BACKFILL_KEY)).toMatchObject({ cursor: expect.any(String) as string });
    expect(t.db.get(ORG_OPEN_APPROVALS_BACKFILL_KEY)?.completedAt).toBeUndefined();
    expect((await t.summary(ADA)).total).toBe(5);
    const rest = await backfillOrgOpenApprovals(t.approvals, { pageSize: 2 });
    expect(rest.complete).toBe(true);
    expect(t.db.find((item) => item.pk === orgOpenApprovalsPk(TEST_ORG))).toHaveLength(5);
    expect(t.db.get(ORG_OPEN_APPROVALS_BACKFILL_KEY)).toMatchObject({ completedAt: expect.any(String) as string });
  });

  it("completes at once on an install with nothing open", async () => {
    const t = await world();
    expect(await backfillOrgOpenApprovals(t.approvals)).toEqual({ ran: true, copied: 0, skipped: 0, complete: true });
    expect(await t.summary(ADA)).toMatchObject({ total: 0 });
  });
});

