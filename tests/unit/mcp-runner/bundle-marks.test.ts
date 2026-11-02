// Review N4: where the controller keeps the day it first saw a bundle unreferenced. One small item per bundle in the probe-slot partition, which the controller's role already reads, writes and deletes.
import { describe, expect, it } from "vitest";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { orgScoped } from "@agentx/contracts";
import { dynamoBundleMarks } from "../../../packages/broker/src/mcp-host/bundle-marks.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG } from "../context-sources/fixtures.js";

const HASH = "a".repeat(64);
const setup = () => { const db = new FakeDynamoDb(); return { db, marks: dynamoBundleMarks({ documentClient: db, tableName: "state", orgId: ORG }) }; };

describe("the controller's bundle marks", () => {
  it("keeps a mark as one item in the probe-slot partition, reads it back, and clears it", async () => {
    const { db, marks } = setup();
    expect(await marks.get(HASH)).toBeUndefined();
    await marks.set(HASH, 1_762_000_000_000);
    expect([...db.items.values()]).toEqual([{ pk: orgScoped(ORG, "MCPSLOT"), sk: `ORPHAN#${HASH}`, firstSeenAt: 1_762_000_000_000 }]);
    expect(await marks.get(HASH)).toBe(1_762_000_000_000);
    await marks.clear(HASH);
    expect(await marks.get(HASH)).toBeUndefined();
    await expect(marks.clear(HASH)).resolves.toBeUndefined();
  });
  it("does not move a mark that is already there (the first sighting is the one that counts)", async () => {
    const { marks } = setup();
    await marks.set(HASH, 100);
    await marks.set(HASH, 900);
    expect(await marks.get(HASH)).toBe(100);
  });
  it("refuses a name that is not a sha256 and a time that is not a whole number, and throws for a damaged item rather than reading it as none", async () => {
    const { db, marks } = setup();
    for (const bad of ["../x", "x", HASH.toUpperCase(), `${HASH}/..`, ""]) { await expect(marks.get(bad), bad).rejects.toThrow(); await expect(marks.set(bad, 1), bad).rejects.toThrow(); await expect(marks.clear(bad), bad).rejects.toThrow(); }
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) await expect(marks.set(HASH, bad), String(bad)).rejects.toThrow();
    await db.send(new PutCommand({ TableName: "state", Item: { pk: orgScoped(ORG, "MCPSLOT"), sk: `ORPHAN#${HASH}`, firstSeenAt: "yesterday" } }));
    await expect(marks.get(HASH)).rejects.toThrow(/damaged/u);
  });
  it("never writes the registry's partition", async () => {
    const { db, marks } = setup();
    await marks.set(HASH, 5);
    expect([...db.items.values()].some((item) => String(item.pk).endsWith("MCPSRV"))).toBe(false);
  });
});
