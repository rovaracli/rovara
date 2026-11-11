// Stdio MCP host redesign, task T7: at most two probe or install jobs per org at once, counted in DynamoDB with a conditional write, across controller instances.
import { describe, expect, it } from "vitest";
import { dynamoProbeSlots } from "../../../packages/broker/src/mcp-host/probe-slots.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG } from "../context-sources/fixtures.js";

const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as typeof ORG;

describe("probe slots", () => {
  it("gives out two slots and refuses the third, and gives one back when it is released", async () => {
    const table = new FakeDynamoDb();
    const slots = dynamoProbeSlots({ documentClient: table, tableName: "state", orgId: ORG });
    const a = await slots.acquire();
    const b = await slots.acquire();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(await slots.acquire()).toBeUndefined();
    await a!();
    const c = await slots.acquire();
    expect(c).toBeDefined();
    expect(await slots.acquire()).toBeUndefined();
  });
  it("counts across two controllers that share the table: together they hold two, not four", async () => {
    const table = new FakeDynamoDb();
    const one = dynamoProbeSlots({ documentClient: table, tableName: "state", orgId: ORG });
    const two = dynamoProbeSlots({ documentClient: table, tableName: "state", orgId: ORG });
    const held = await Promise.all([one.acquire(), two.acquire(), one.acquire(), two.acquire(), one.acquire(), two.acquire()]);
    expect(held.filter((release) => release !== undefined)).toHaveLength(2);
  });
  it("counts each org on its own", async () => {
    const table = new FakeDynamoDb();
    const a = dynamoProbeSlots({ documentClient: table, tableName: "state", orgId: ORG, max: 1 });
    const b = dynamoProbeSlots({ documentClient: table, tableName: "state", orgId: OTHER_ORG, max: 1 });
    expect(await a.acquire()).toBeDefined();
    expect(await a.acquire()).toBeUndefined();
    expect(await b.acquire()).toBeDefined();
  });
  it("lets a slot go when its lease has run out (a controller that died with it), and not before", async () => {
    const table = new FakeDynamoDb();
    let clock = 1_000_000;
    const slots = dynamoProbeSlots({ documentClient: table, tableName: "state", orgId: ORG, max: 1, leaseMs: 10 * 60_000, now: () => clock });
    expect(await slots.acquire()).toBeDefined();
    clock += 9 * 60_000;
    expect(await slots.acquire()).toBeUndefined();
    clock += 2 * 60_000;
    expect(await slots.acquire()).toBeDefined();
  });
  it("does not give back a slot that now belongs to someone else, and a release is only ever done once", async () => {
    const table = new FakeDynamoDb();
    let clock = 1_000_000;
    const slots = dynamoProbeSlots({ documentClient: table, tableName: "state", orgId: ORG, max: 1, leaseMs: 60_000, now: () => clock });
    const first = await slots.acquire();
    clock += 120_000;
    const second = await slots.acquire();
    expect(second).toBeDefined();
    // the first job's late release must not free the second job's slot
    await first!();
    expect(await slots.acquire()).toBeUndefined();
    await second!();
    await second!();
    expect(await slots.acquire()).toBeDefined();
  });
  it("is no slot at all when the table cannot be written", async () => {
    const slots = dynamoProbeSlots({ documentClient: { send: async () => { throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }); } }, tableName: "state", orgId: ORG });
    await expect(slots.acquire()).rejects.toThrow("throttled");
  });
  it("keeps its items out of the registry of approvals: another partition and a sort key the registry never lists", async () => {
    const table = new FakeDynamoDb();
    const slots = dynamoProbeSlots({ documentClient: table, tableName: "state", orgId: ORG, max: 1 });
    await slots.acquire();
    const { dynamoMcpServerStore } = await import("../../../packages/broker/src/context-sources/mcp-servers.js");
    expect(await dynamoMcpServerStore({ documentClient: table, tableName: "state" }).list(ORG)).toEqual([]);
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    const { orgScoped } = await import("@rovara-code/contracts");
    const found = await table.send(new GetCommand({ TableName: "state", Key: { pk: orgScoped(ORG, "MCPSLOT"), sk: "SLOT#0" } })) as { Item?: { leaseId?: string } };
    expect(found.Item?.leaseId).toMatch(/^[0-9a-f]{32}$/u);
    expect(((await table.send(new GetCommand({ TableName: "state", Key: { pk: orgScoped(ORG, "MCPSRV"), sk: "SLOT#0" } }))) as { Item?: unknown }).Item).toBeUndefined();
  });
  it("refuses a number of slots that is not between 1 and 16", () => {
    for (const max of [0, 17, 1.5, -1]) expect(() => dynamoProbeSlots({ documentClient: new FakeDynamoDb(), tableName: "state", orgId: ORG, max }), String(max)).toThrow();
  });
});
