// Convergence lane A8 (H2): Slack's keys under ORG#. The rows Cloud writes today are the rows Code's company-scoped channel functions read, a second company never reads or lists the first's, and the one
// addition (the tenant row) has a backfill and a reverse that these tests run on an in-memory store (neither is run on a real table by this lane).
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import { bindChannelSpace, listAllChannelBindings, listChannelBindings, readChannelBinding } from "@rovara-code/broker/core/channel";
import { channelBindingKey, orgChannelBindingKey, orgChannelBindingPartition, orgScoped, queryAll, readChannelBindingItem, slackBindingKey, slackBindingPk, type OrgId } from "@rovara-code/contracts";
import { slackBindingItem } from "../../packages/broker/src/org/slack-binding.js";
import { TENANT_BACKFILL_MARK, backfillSlackTenants, markedTenantRows, tenantRowKey, tenantsOfBindingRows, undoBackfillSlackTenants } from "../../packages/broker/src/plugins/channel/slack-cloud/index.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TEAM = "T0AAAAAAA";
const OTHER_TEAM = "T0BBBBBBB";
const CHANNEL = "C0AAAAAAA";
const ref = (channel = CHANNEL, tenant = TEAM) => ({ channel: "slack", tenant, space: channel });

/** A binding row exactly as Cloud's bind writes it today, including the attributes an old row carries. */
const todaysRow = (orgId: OrgId, teamId = TEAM, channelId = CHANNEL, projectName = "web") =>
  ({ ...slackBindingItem(orgId, { teamId, channelId, projectName, updatedAt: "2026-11-01T00:00:00.000Z" }, "d".repeat(64)), projectRevision: 4 });

/** The `CHANNEL_TENANTS` rows of both test companies, as a scan of the table would find them. */
const tenantRows = async (store: MemoryDocumentStore): Promise<Array<Record<string, unknown>>> =>
  (await Promise.all([A, B].map((orgId) => queryAll(store, { pk: orgScoped(orgId, "CHANNEL_TENANTS") })))).flat();

async function storeWith(...rows: Array<Record<string, unknown>>): Promise<MemoryDocumentStore> {
  const store = new MemoryDocumentStore();
  for (const row of rows) await store.put({ item: row as never });
  return store;
}

describe("the key layout (no row moves)", () => {
  it("is the same key Code's company-scoped channel binding function makes, for every company", () => {
    for (const orgId of [A, B]) {
      expect(slackBindingKey(orgId, TEAM, CHANNEL)).toEqual(orgChannelBindingKey(orgId, ref()));
      expect(slackBindingPk(orgId, TEAM)).toBe(orgChannelBindingPartition(orgId, "slack", TEAM));
    }
    expect(slackBindingKey(A, TEAM, CHANNEL)).toEqual({ pk: `ORG#${A}#SLACK_BINDING#${TEAM}`, sk: `CHANNEL#${CHANNEL}` });
  });

  it("puts the company in the key text, so two companies never share a partition for one workspace and channel", () => {
    expect(slackBindingKey(A, TEAM, CHANNEL).pk).not.toBe(slackBindingKey(B, TEAM, CHANNEL).pk);
    expect(orgChannelBindingKey(A, ref()).pk).not.toBe(orgChannelBindingKey(B, ref()).pk);
    // The unscoped key has no company: it is not what Cloud writes, and the company-scoped one differs from it.
    expect(channelBindingKey(ref()).pk).toBe(`SLACK_BINDING#${TEAM}`);
    expect(slackBindingKey(A, TEAM, CHANNEL).pk).not.toBe(channelBindingKey(ref()).pk);
  });
});

describe("existing rows stay readable", () => {
  it("reads a row written by Cloud's bind today (with its updatedBy and an old projectRevision) through Code's functions", async () => {
    const store = await storeWith(todaysRow(A));
    expect(await readChannelBinding({ store, orgId: A }, ref())).toEqual({ channel: "slack", tenant: TEAM, space: CHANNEL, projectName: "web", updatedAt: "2026-11-01T00:00:00.000Z" });
    expect(await listChannelBindings({ store, orgId: A }, "slack", TEAM)).toHaveLength(1);
    expect(readChannelBindingItem(ref(), todaysRow(A))?.projectName).toBe("web");
  });

  it("refuses a stored row that names another space, instead of reading it as the asked one", () => {
    expect(() => readChannelBindingItem(ref("C0CCCCCCC"), todaysRow(A))).toThrow();
  });

  it("reads a row Code writes with its own bind, and Cloud's own reader reads that row too (the attributes are the same)", async () => {
    const store = new MemoryDocumentStore();
    await bindChannelSpace({ store, orgId: A, now: () => Date.UTC(2026, 10, 11) }, ref(), "web");
    const row = await store.get(slackBindingKey(A, TEAM, CHANNEL));
    expect(row).toMatchObject({ teamId: TEAM, channelId: CHANNEL, projectName: "web", entityType: "SLACK_BINDING" });
  });
});

describe("company isolation", () => {
  it("lets one company read and list only its own bindings, the same workspace and channel in both", async () => {
    const store = await storeWith(todaysRow(A, TEAM, CHANNEL, "alpha"), todaysRow(B, TEAM, CHANNEL, "beta"), todaysRow(B, TEAM, "C0BBBBBBB", "beta-two"));
    expect((await readChannelBinding({ store, orgId: A }, ref()))?.projectName).toBe("alpha");
    expect((await readChannelBinding({ store, orgId: B }, ref()))?.projectName).toBe("beta");
    expect((await listChannelBindings({ store, orgId: A }, "slack", TEAM)).map((binding) => binding.projectName)).toEqual(["alpha"]);
    expect((await listChannelBindings({ store, orgId: B }, "slack", TEAM)).map((binding) => binding.projectName).sort()).toEqual(["beta", "beta-two"]);
  });

  it("finds nothing for a company that has no binding, even when another company has one for that workspace and channel", async () => {
    const store = await storeWith(todaysRow(A));
    expect(await readChannelBinding({ store, orgId: B }, ref())).toBeUndefined();
    expect(await listChannelBindings({ store, orgId: B }, "slack", TEAM)).toEqual([]);
  });

  it("lists every binding of a company across its workspaces from the tenant rows, and none of another company's", async () => {
    const store = await storeWith(todaysRow(A, TEAM), todaysRow(A, OTHER_TEAM, "C0DDDDDDD"), todaysRow(B, TEAM));
    await backfillSlackTenants(store, [todaysRow(A, TEAM), todaysRow(A, OTHER_TEAM, "C0DDDDDDD"), todaysRow(B, TEAM)]);
    expect((await listAllChannelBindings({ store, orgId: A })).map((binding) => binding.tenant).sort()).toEqual([TEAM, OTHER_TEAM]);
    expect((await listAllChannelBindings({ store, orgId: B })).map((binding) => binding.tenant)).toEqual([TEAM]);
  });
});

describe("the tenant-row backfill and its reverse (not run on a table by this lane)", () => {
  const rows = () => [todaysRow(A, TEAM), todaysRow(A, TEAM, "C0EEEEEEE"), todaysRow(A, OTHER_TEAM, "C0DDDDDDD"), todaysRow(B, TEAM)];

  it("is needed: before it, the cross-workspace listing does not see the bindings that exist (the positive control)", async () => {
    const store = await storeWith(...rows());
    expect(await listAllChannelBindings({ store, orgId: A })).toEqual([]);
    expect(await listChannelBindings({ store, orgId: A }, "slack", TEAM)).toHaveLength(2);
  });

  it("writes one row for each company and workspace, once, and the listing then sees every binding", async () => {
    const store = await storeWith(...rows());
    expect(await backfillSlackTenants(store, rows())).toEqual({ written: 3, alreadyThere: 0, skipped: 0 });
    expect(await store.get(tenantRowKey(A, TEAM))).toMatchObject({ channel: "slack", tenant: TEAM, backfilledBy: TENANT_BACKFILL_MARK });
    expect(await listAllChannelBindings({ store, orgId: A })).toHaveLength(3);
    // Run again: nothing is rewritten.
    expect(await backfillSlackTenants(store, rows())).toEqual({ written: 0, alreadyThere: 3, skipped: 0 });
  });

  it("leaves a row Code's own bind wrote exactly as it is, and the reverse never deletes it", async () => {
    const store = await storeWith(...rows());
    await bindChannelSpace({ store, orgId: A, now: () => 1 }, ref(), "web");
    const before = await store.get(tenantRowKey(A, TEAM));
    expect(before).toBeDefined();
    expect(await backfillSlackTenants(store, rows())).toEqual({ written: 2, alreadyThere: 1, skipped: 0 });
    expect(await store.get(tenantRowKey(A, TEAM))).toEqual(before);
    // The unmarked row is not one the forward step wrote, so the reverse does not even list it.
    expect(await undoBackfillSlackTenants(store, await tenantRows(store))).toEqual({ deleted: 2, kept: 0 });
    expect(await store.get(tenantRowKey(A, TEAM))).toEqual(before);
  });

  it("is undone completely: after the reverse the table holds exactly the binding rows it started with, and the bindings still read", async () => {
    const store = await storeWith(...rows());
    const keys = async () => (await Promise.all([A, B].map(async (orgId) => store.get(tenantRowKey(orgId, TEAM))))).map((row) => row !== undefined);
    await backfillSlackTenants(store, rows());
    expect(await keys()).toEqual([true, true]);
    expect(await undoBackfillSlackTenants(store, await tenantRows(store))).toEqual({ deleted: 3, kept: 0 });
    expect(await keys()).toEqual([false, false]);
    expect(await store.get(tenantRowKey(A, OTHER_TEAM))).toBeUndefined();
    expect(await listChannelBindings({ store, orgId: A }, "slack", TEAM)).toHaveLength(2);
  });

  it("finds the rows to undo from the tenant rows, so a binding unbound between the two steps leaves no marked row behind", async () => {
    const store = await storeWith(...rows());
    await backfillSlackTenants(store, rows());
    // The owner unbinds every channel of company A in workspace T0BBBBBBB between the forward step and the reverse.
    await store.delete({ key: slackBindingKey(A, OTHER_TEAM, "C0DDDDDDD") });
    expect(await listChannelBindings({ store, orgId: A }, "slack", OTHER_TEAM)).toEqual([]);
    expect(await undoBackfillSlackTenants(store, await tenantRows(store))).toEqual({ deleted: 3, kept: 0 });
    expect(await tenantRows(store)).toEqual([]);
  });

  it("keeps a row that has no mark, one that has another mark, and one whose key is not a Slack tenant row, and keeps a row that lost its mark after the scan", async () => {
    const store = await storeWith(...rows());
    await store.put({ item: { ...tenantRowKey(A, TEAM), entityType: "CHANNEL_TENANT", channel: "slack", tenant: TEAM } });
    await store.put({ item: { ...tenantRowKey(B, TEAM), entityType: "CHANNEL_TENANT", channel: "slack", tenant: TEAM, backfilledBy: "another-run" } });
    const scanned = await tenantRows(store);
    expect(markedTenantRows([...scanned, { pk: orgScoped(A, "CHANNEL_TENANTS"), sk: "teams/T0AAAAAAA", backfilledBy: TENANT_BACKFILL_MARK }, { pk: `ORG#${A}#OTHER`, sk: "slack/T0AAAAAAA", backfilledBy: TENANT_BACKFILL_MARK }])).toEqual([]);
    // A row marked at scan time that lost its mark before the delete is kept (the delete is conditional on the mark).
    const stale = [{ ...tenantRowKey(A, TEAM), backfilledBy: TENANT_BACKFILL_MARK }];
    expect(await undoBackfillSlackTenants(store, stale)).toEqual({ deleted: 0, kept: 1 });
    expect(await store.get(tenantRowKey(A, TEAM))).toBeDefined();
  });

  it("skips rows that are not bindings, and takes the company and workspace from the key text only", () => {
    const found = tenantsOfBindingRows([
      todaysRow(A), { pk: "SLACK_TEAM#T0AAAAAAA", sk: "ORG" }, { pk: `ORG#${A}#SLACK_BINDING#${TEAM}`, sk: "META" }, { pk: `ORG#${A}#SLACK_BINDING#not-a-team`, sk: "CHANNEL#C1" },
      { pk: "ORG#org_short#SLACK_BINDING#T0AAAAAAA", sk: "CHANNEL#C1" }, { pk: 7, sk: "CHANNEL#C1" }, {},
      // A row whose attributes claim another company is still read by its key.
      { ...todaysRow(A), orgId: B },
    ]);
    expect(found.pairs).toEqual([{ orgId: A, teamId: TEAM }]);
    expect(found.skipped).toBe(6);
  });
});
