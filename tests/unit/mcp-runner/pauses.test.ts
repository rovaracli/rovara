// Stdio MCP host redesign (fix round 1, S2): where the controller keeps a pause.
import { describe, expect, it } from "vitest";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { orgScoped } from "@agentx/contracts";
import { dynamoPauses } from "../../../packages/broker/src/mcp-host/pauses.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG } from "../context-sources/fixtures.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const SERVER = "mcpwiki000001";
const setup = () => { const db = new FakeDynamoDb(); return { db, pauses: dynamoPauses({ documentClient: db, tableName: "state", orgId: ORG }) }; };

describe("the controller's pause store", () => {
  it("keeps a pause as one item in the probe-slot partition, reads it back, and removes it", async () => {
    const { db, pauses } = setup();
    await pauses.set(SERVER, { toolsHash: A, bundleHash: B });
    expect([...db.items.values()]).toEqual([{ pk: orgScoped(ORG, "MCPSLOT"), sk: `PAUSE#${SERVER}`, toolsHash: A, bundleHash: B }]);
    expect(await pauses.get(SERVER)).toEqual({ toolsHash: A, bundleHash: B });
    await pauses.clear(SERVER);
    expect(await pauses.get(SERVER)).toBeUndefined();
    await expect(pauses.clear(SERVER)).resolves.toBeUndefined();
  });
  it("never writes the registry's partition", async () => {
    const { db, pauses } = setup();
    await pauses.set(SERVER, { toolsHash: A, bundleHash: B });
    expect([...db.items.values()].some((item) => String(item.pk).endsWith("MCPSRV"))).toBe(false);
  });
  it("refuses an id that is not a server id, and a pause that does not name two hashes", async () => {
    const { pauses } = setup();
    for (const id of ["../x", "mcp", "SLOT#1", ""]) { await expect(pauses.get(id), id).rejects.toThrow(); await expect(pauses.set(id, { toolsHash: A, bundleHash: B }), id).rejects.toThrow(); }
    for (const bad of [{ toolsHash: "x", bundleHash: B }, { toolsHash: A, bundleHash: "" }]) await expect(pauses.set(SERVER, bad)).rejects.toThrow(/two hashes/u);
  });
  it("reads a damaged item as a pause that matches no approval, never as no pause", async () => {
    const { db, pauses } = setup();
    await db.send(new PutCommand({ TableName: "state", Item: { pk: orgScoped(ORG, "MCPSLOT"), sk: `PAUSE#${SERVER}`, toolsHash: 5 } }));
    expect(await pauses.get(SERVER)).toEqual({ toolsHash: "", bundleHash: "" });
  });
  it("is one org's: another org's pause is not read", async () => {
    const { db } = setup();
    const other = dynamoPauses({ documentClient: db, tableName: "state", orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    await dynamoPauses({ documentClient: db, tableName: "state", orgId: ORG }).set(SERVER, { toolsHash: A, bundleHash: B });
    expect(await other.get(SERVER)).toBeUndefined();
  });
});
