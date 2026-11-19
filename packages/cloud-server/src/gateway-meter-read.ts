// The model gateway's person-month spend rows, read for People and limits (people-limits-routes.ts). READ ONLY: batch reads of exact keys, no Scan, no Query,
// no write. The gateway writes these rows (packages/model-gateway/src/dynamo-meter.ts targetsFor) and nothing here changes them:
//
//   meter table   pk = "CO#" + JSON.stringify([issuer, companyId])    sk = "ROW#" + JSON.stringify(["person", personId, "YYYY-MM"])
//                 { item: "person", company, spentMicros, estimatedMicros, reservedMicros, committed, overrun }
//
// The issuer is the Code install the gateway trusts (`<ROVARA_CODE_URL>/v1/auth`, the same one the product AI store names). A missing row is a person
// who spent nothing this month, but only after the existing company-month row verifies the issuer/partition. A row that is not exactly this company's person row, or whose amount is not a whole number, fails the whole read
// (the route then refuses; a person is never drawn as $0 because their row did not read). Every key is built from the caller's company, so another
// company's row cannot be asked for, and one that comes back anyway is refused.
import { BatchGetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { PersonSpendReader } from "./people-limits-routes.js";

type Db = Pick<DynamoDBDocumentClient, "send">;
const COMPANY_KEY_PREFIX = "CO#";
const COMPANY_ID = /^org_[a-z0-9]{20}$/u;
const PERSON_ID = /^[a-f0-9]{64}$/u;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;
/** DynamoDB's BatchGetItem takes at most 100 keys. */
const BATCH = 100;
const ATTEMPTS = 4;
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const meterPartition = (issuer: string, companyId: string): string => `${COMPANY_KEY_PREFIX}${JSON.stringify([issuer, companyId])}`;
export const personMonthSort = (personId: string, month: string): string => `ROW#${JSON.stringify(["person", personId, month])}`;

export class DynamoGatewayMeterReader implements PersonSpendReader {
  constructor(private readonly db: Db, private readonly table: string, private readonly issuer: string) {
    if (table === "" || issuer === "" || issuer.length > 2048) throw new Error("gateway meter settings: a table and the install issuer are both needed");
  }

  /** One exact company-month row. Missing or malformed totals stay unavailable, never zero. */
  async companyMonth(companyId: string, month: string): Promise<{ spentMicros: number; reservedMicros: number; committed: number; provisionalMicros?: number }> {
    if (!COMPANY_ID.test(companyId) || !MONTH.test(month)) throw new Error("meter unavailable");
    const pk = meterPartition(this.issuer, companyId), sk = `ROW#${JSON.stringify(["company", month])}`;
    const answer = await this.db.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: [{ pk, sk }], ConsistentRead: true } } }));
    if ((answer.UnprocessedKeys?.[this.table]?.Keys?.length ?? 0) > 0) throw new Error("meter unavailable");
    const rows = answer.Responses?.[this.table] ?? [], row = rows[0];
    if (rows.length !== 1 || row === undefined || row["pk"] !== pk || row["sk"] !== sk || row["company"] !== companyId || row["item"] !== "company" || !whole(row["spentMicros"]) || !whole(row["reservedMicros"]) || !whole(row["committed"]) || (row["provisionalMicros"] !== undefined && !whole(row["provisionalMicros"]))) throw new Error("meter unavailable");
    return { spentMicros: row["spentMicros"], reservedMicros: row["reservedMicros"], committed: row["committed"], ...(row["provisionalMicros"] === undefined ? {} : { provisionalMicros: row["provisionalMicros"] as number }) };
  }

  /** Existing BatchGet permission, same company partition; missing rollout field stays unknown. */
  async provisionalTotal(companyId: string, month: string): Promise<number | undefined> {
    if (!COMPANY_ID.test(companyId) || !MONTH.test(month)) throw new Error("meter unavailable");
    const pk = meterPartition(this.issuer, companyId), sk = `ROW#${JSON.stringify(["company", month])}`;
    const answer = await this.db.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: [{ pk, sk }], ConsistentRead: true } } }));
    if ((answer.UnprocessedKeys?.[this.table]?.Keys?.length ?? 0) > 0) throw new Error("meter unavailable");
    const rows = answer.Responses?.[this.table] ?? [];
    if (rows.length === 0) return undefined;
    const row = rows[0]!;
    if (rows.length !== 1 || row["pk"] !== pk || row["sk"] !== sk || row["company"] !== companyId || row["item"] !== "company" || (row["provisionalMicros"] !== undefined && !whole(row["provisionalMicros"]))) throw new Error("meter unavailable");
    return row["provisionalMicros"] as number | undefined;
  }

  async monthSpend(companyId: string, month: string, personIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (!COMPANY_ID.test(companyId) || !MONTH.test(month) || !personIds.every((id) => PERSON_ID.test(id))) throw new Error("meter unavailable");
    const pk = meterPartition(this.issuer, companyId);
    const readBatch = async (sorts: readonly string[]): Promise<Array<Record<string, unknown>>> => {
      const asked = new Set(sorts), received = new Set<string>();
      const rows: Array<Record<string, unknown>> = [];
      let pending = sorts.map(sk => ({ pk, sk }));
      for (let attempt = 0; pending.length > 0; attempt += 1) {
        if (attempt >= ATTEMPTS) throw new Error("meter unavailable");
        if (attempt > 0) await new Promise<void>((resolve) => { setTimeout(resolve, Math.floor(Math.random() * 25 * 2 ** attempt)); });
        const answer = await this.db.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: pending, ConsistentRead: true } } }));
        for (const item of (answer.Responses?.[this.table] ?? []) as Array<Record<string, unknown>>) {
          const sk = item["sk"];
          if (item["pk"] !== pk || typeof sk !== "string" || !asked.has(sk) || received.has(sk)) throw new Error("meter unavailable");
          received.add(sk);
          rows.push(item);
        }
        const left = answer.UnprocessedKeys?.[this.table]?.Keys ?? [];
        pending = left.map(key => {
          if (key["pk"] !== pk || typeof key["sk"] !== "string" || !asked.has(key["sk"]) || received.has(key["sk"])) throw new Error("meter unavailable");
          return { pk, sk: key["sk"] };
        });
      }
      return rows;
    };
    const spent = new Map<string, number>();
    if (personIds.length === 0) return spent;
    // An empty lookup under a wrong issuer is indistinguishable from zero spend. Verify an existing gateway row first.
    // A new/unused partition is unavailable until its company-month row exists; never invent a marker here.
    const companySort = `ROW#${JSON.stringify(["company", month])}`;
    const companyRows = await readBatch([companySort]);
    const company = companyRows[0];
    if (companyRows.length !== 1 || company?.["item"] !== "company" || company["company"] !== companyId || !whole(company["spentMicros"])) throw new Error("meter unavailable");
    const bySort = new Map(personIds.map((id) => [personMonthSort(id, month), id]));
    const sorts = [...bySort.keys()];
    for (let from = 0; from < sorts.length; from += BATCH) {
      for (const item of await readBatch(sorts.slice(from, from + BATCH))) {
        const id = bySort.get(item["sk"] as string);
        if (id === undefined || item["item"] !== "person" || item["company"] !== companyId || !whole(item["spentMicros"])) throw new Error("meter unavailable");
        spent.set(id, item["spentMicros"]);
      }
    }
    return spent;
  }
}
