// Cost report slice A6: the read-only reader of the model gateway's person-month meter rows. Exact keys built from the caller's company (so another
// company's row is never asked for), every returned row checked against what was asked, nothing written, and a row that does not read fails the read.
import { describe, expect, it } from "vitest";
import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoGatewayMeterReader, meterPartition, personMonthSort } from "../../packages/cloud-server/src/index.js";

const ISS = "https://code.example.test/v1/auth";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const P = (n: number) => n.toString(16).padStart(64, "0");
const TABLE = "gateway-meter";

type Row = Record<string, unknown>;
const companyRow = (company = A, month = "2026-11", over: Row = {}): Row => ({ pk: meterPartition(ISS, company), sk: `ROW#${JSON.stringify(["company", month])}`, item: "company", company, spentMicros: 0, ...over });
const meterRow = (company: string, person: string, month: string, spentMicros: unknown, over: Row = {}): Row => ({ pk: meterPartition(ISS, company), sk: personMonthSort(person, month), item: "person", company, spentMicros, estimatedMicros: 0, reservedMicros: 0, committed: 0, overrun: false, ...over });
/** A fake DocumentClient over a table of rows. It records every command and refuses anything but BatchGet. */
function fake(rows: Row[], options: { unprocessedOnce?: boolean; neverFinish?: boolean; extra?: Row[]; noPartition?: boolean } = {}) {
  const commands: Array<{ name: string; input: BatchGetCommand["input"] }> = [];
  let first = true;
  const db = {
    async send(command: unknown) {
      if (!(command instanceof BatchGetCommand)) throw new Error("a write or another read was sent");
      commands.push({ name: command.constructor.name, input: command.input });
      const table = command.input.RequestItems![TABLE]!;
      const keys = table.Keys as Array<{ pk: string; sk: string }>;
      if (keys.length > 100) throw new Error("more than 100 keys");
      if (new Set(keys.map((key) => key.pk + key.sk)).size !== keys.length) throw new Error("duplicate keys");
      const stored = options.noPartition === true ? rows : [companyRow(), ...rows];
      const found = keys.flatMap((key) => stored.filter((row) => row["pk"] === key.pk && row["sk"] === key.sk));
      if (options.neverFinish === true) return { Responses: { [TABLE]: [] }, UnprocessedKeys: { [TABLE]: { Keys: keys } } };
      if (options.unprocessedOnce === true && first && keys.length > 1) { first = false; return { Responses: { [TABLE]: found.slice(0, 1) }, UnprocessedKeys: { [TABLE]: { Keys: keys.slice(1) } } }; }
      return { Responses: { [TABLE]: [...found, ...(options.extra ?? [])] } };
    },
  };
  return { db: db as never, commands };
}

describe("DynamoGatewayMeterReader", () => {
  it("asks for exactly this company's person-month rows with consistent reads, and returns spend by person (a missing row is absent)", async () => {
    const f = fake([meterRow(A, P(1), "2026-11", 2_500_000), meterRow(B, P(1), "2026-11", 99_000_000), meterRow(A, P(1), "2026-10", 7_000_000)]);
    const read = await new DynamoGatewayMeterReader(f.db, TABLE, ISS).monthSpend(A, "2026-11", [P(1), P(2)]);
    expect([...read]).toEqual([[P(1), 2_500_000]]);
    const keys = f.commands[1]!.input.RequestItems![TABLE]!;
    expect(keys.ConsistentRead).toBe(true);
    expect(keys.Keys).toEqual([{ pk: `CO#${JSON.stringify([ISS, A])}`, sk: `ROW#${JSON.stringify(["person", P(1), "2026-11"])}` }, { pk: `CO#${JSON.stringify([ISS, A])}`, sk: `ROW#${JSON.stringify(["person", P(2), "2026-11"])}` }]);
    expect(JSON.stringify(keys.Keys)).not.toContain(B);
  });
  it("never sends a key for another issuer's company, and splits more than 100 people into batches without a duplicate", async () => {
    const ids = Array.from({ length: 250 }, (_, n) => P(n + 1));
    const f = fake(ids.map((id, n) => meterRow(A, id, "2026-11", (n + 1) * 10_000)));
    const read = await new DynamoGatewayMeterReader(f.db, TABLE, ISS).monthSpend(A, "2026-11", [...ids, ids[0]!]);
    expect(f.commands.map((c) => c.input.RequestItems![TABLE]!.Keys!.length)).toEqual([1, 100, 100, 50]);
    expect(read.size).toBe(250);
    expect(read.get(P(250))).toBe(2_500_000);
  });
  it("sends only reads: a table of rows is never written, scanned or queried", async () => {
    const f = fake([meterRow(A, P(1), "2026-11", 1)]);
    await new DynamoGatewayMeterReader(f.db, TABLE, ISS).monthSpend(A, "2026-11", [P(1)]);
    expect(f.commands.every((c) => c.name === "BatchGetCommand")).toBe(true);
  });
  it("retries keys DynamoDB left unprocessed, and gives up (an error, never a partial answer) when they never finish", async () => {
    const rows = [meterRow(A, P(1), "2026-11", 1_000_000), meterRow(A, P(2), "2026-11", 2_000_000)];
    const retried = fake(rows, { unprocessedOnce: true });
    expect([...await new DynamoGatewayMeterReader(retried.db, TABLE, ISS).monthSpend(A, "2026-11", [P(1), P(2)])].sort()).toEqual([[P(1), 1_000_000], [P(2), 2_000_000]]);
    expect(retried.commands.length).toBe(3);
    await expect(new DynamoGatewayMeterReader(fake(rows, { neverFinish: true }).db, TABLE, ISS).monthSpend(A, "2026-11", [P(1)])).rejects.toThrow("meter unavailable");
  });
  it("refuses a row that is not exactly the one asked for", async () => {
    const good = meterRow(A, P(1), "2026-11", 5);
    const cases: Row[] = [
      { ...good, company: B }, { ...good, item: "project" }, { ...good, item: undefined }, { ...good, pk: meterPartition(ISS, B) }, { ...good, pk: meterPartition("https://other.example/v1/auth", A) },
      { ...good, spentMicros: -1 }, { ...good, spentMicros: 1.5 }, { ...good, spentMicros: "5" }, { ...good, spentMicros: undefined }, { ...good, spentMicros: Number.MAX_SAFE_INTEGER + 2 },
    ];
    for (const bad of cases) await expect(new DynamoGatewayMeterReader(fake([], { extra: [bad] }).db, TABLE, ISS).monthSpend(A, "2026-11", [P(1)]), JSON.stringify(bad)).rejects.toThrow("meter unavailable");
    // A row that was not asked for comes back anyway (another person, another company): refused.
    await expect(new DynamoGatewayMeterReader(fake([good], { extra: [meterRow(B, P(9), "2026-11", 1)] }).db, TABLE, ISS).monthSpend(A, "2026-11", [P(1)])).rejects.toThrow("meter unavailable");
  });
  it("refuses a company, month or person that is not in the expected format before anything is sent", async () => {
    const f = fake([]);
    const reader = new DynamoGatewayMeterReader(f.db, TABLE, ISS);
    for (const [company, month, ids] of [["nope", "2026-11", [P(1)]], [A, "2026-13", [P(1)]], [A, "2026-1", [P(1)]], [A, "2026-11", ["abc"]], [A, "2026-11", [`${P(1).slice(0, 63)}"`]]] as const) await expect(reader.monthSpend(company, month, ids)).rejects.toThrow("meter unavailable");
    expect(f.commands).toEqual([]);
    expect(await reader.monthSpend(A, "2026-11", [])).toEqual(new Map());
    expect(() => new DynamoGatewayMeterReader(f.db, "", ISS)).toThrow();
    expect(() => new DynamoGatewayMeterReader(f.db, TABLE, "")).toThrow();
  });
  it("matches the gateway's own key shape (the gateway's partition and row names)", async () => {
    const { companyPartition } = await import("../../packages/model-gateway/src/dynamo-meter.js");
    expect(meterPartition(ISS, A)).toBe(companyPartition(ISS, A));
  });
});


it("refuses an unverified issuer/partition instead of interpreting every missing person as zero", async () => {
  const f = fake([meterRow(A, P(1), "2026-11", 5)]);
  await expect(new DynamoGatewayMeterReader(f.db, TABLE, "https://wrong.example/v1/auth").monthSpend(A, "2026-11", [P(1)])).rejects.toThrow("meter unavailable");
  await expect(new DynamoGatewayMeterReader(fake([], { noPartition: true }).db, TABLE, ISS).monthSpend(A, "2026-11", [P(1)])).rejects.toThrow("meter unavailable");
  for (const over of [{ company: B }, { item: "person" }, { spentMicros: -1 }, { pk: meterPartition(ISS, B) }]) {
    await expect(new DynamoGatewayMeterReader(fake([companyRow(A, "2026-11", over)], { noPartition: true }).db, TABLE, ISS).monthSpend(A, "2026-11", [P(1)])).rejects.toThrow("meter unavailable");
  }
});
