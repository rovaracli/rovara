// Stdio MCP host redesign, fix round 1 (I2): instance leases in DynamoDB.
import { describe, expect, it } from "vitest";
import { dynamoInstanceLeases } from "../../../packages/broker/src/mcp-host/instance-leases.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG } from "../context-sources/fixtures.js";

describe("instance leases", () => {
  it("is alive after it renews, until the lease runs out, and not before it renewed", async () => {
    const table = new FakeDynamoDb();
    let clock = 1_000_000;
    const one = dynamoInstanceLeases({ documentClient: table, tableName: "state", orgId: ORG, instanceId: "aaaaaaaa11111111", leaseMs: 60_000, now: () => clock });
    const two = dynamoInstanceLeases({ documentClient: table, tableName: "state", orgId: ORG, instanceId: "bbbbbbbb22222222", leaseMs: 60_000, now: () => clock });
    expect(await two.alive("aaaaaaaa11111111")).toBe(false);
    await one.renew();
    expect(await two.alive("aaaaaaaa11111111")).toBe(true);
    expect(await two.alive("bbbbbbbb22222222")).toBe(false);
    clock += 59_000;
    expect(await two.alive("aaaaaaaa11111111")).toBe(true);
    clock += 2_000;
    expect(await two.alive("aaaaaaaa11111111")).toBe(false);
    await one.renew();
    expect(await two.alive("aaaaaaaa11111111")).toBe(true);
  });
  it("counts each org on its own and takes a name that is not an instance id as not alive", async () => {
    const table = new FakeDynamoDb();
    const a = dynamoInstanceLeases({ documentClient: table, tableName: "state", orgId: ORG, instanceId: "aaaaaaaa11111111" });
    const b = dynamoInstanceLeases({ documentClient: table, tableName: "state", orgId: "org_bbbbbbbbbbbbbbbbbbbb", instanceId: "cccccccc33333333" });
    await a.renew();
    expect(await b.alive("aaaaaaaa11111111")).toBe(false);
    for (const bad of ["", "short", "../x", "a".repeat(65)]) expect(await a.alive(bad), bad).toBe(false);
  });
  it("lets a failing table fail the renewal and the check", async () => {
    const down = { send: async () => { throw new Error("throttled"); } };
    const leases = dynamoInstanceLeases({ documentClient: down, tableName: "state", orgId: ORG, instanceId: "aaaaaaaa11111111" });
    await expect(leases.renew()).rejects.toThrow("throttled");
    await expect(leases.alive("bbbbbbbb22222222")).rejects.toThrow("throttled");
  });
});
