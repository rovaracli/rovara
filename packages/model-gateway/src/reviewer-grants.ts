// DEC 254zzz41 (lane L4-GW6): the single-use store of reviewer grants (a task token carrying `reviewer`: model-gateway-token.ts).
//
// A grant is claimed ONCE, by its jti, before any money is held or any provider is called. The claim is one conditional put in the
// markers table the gateway already writes (the ended-task list lives there too), under the company's own key (`CO#[iss,cid]`, so the
// serving role's LeadingKeys condition already covers it) and with the table's `expiresAt` TTL; no new table, record kind or IAM:
//
//   markers table CO#[iss,cid] / REVGRANT#<jti>     one per claimed grant (expires after the grant's own life plus REVIEWER_GRANT_KEEP_SECONDS)
//
// The claim is durable: a second gateway process, or the same one after a restart, finds the item and refuses the replay. A claim that
// cannot be made (the store is down, times out, or its answer is lost) is a refusal: the caller spends nothing. A lost answer after the
// write applied leaves a claimed grant, which is the safe side (a grant is never usable twice, never "maybe once more").
import { AwsNotSentError } from "./aws.js";
import { companyPartition } from "./dynamo-meter.js";
import type { CapsSource } from "./caps.js";
import type { Dynamo } from "./dynamo.js";
import type { Meter } from "./meter.js";
import { COMPANY, REVIEWER_GRANT_SECONDS } from "./model-gateway-token.js";

/** How long a claimed grant's item outlives the grant (clock skew and the verifier's own 30 second window; DynamoDB deletes lazily after this). */
export const REVIEWER_GRANT_KEEP_SECONDS = 300;
const JTI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface ReviewerGrantStore {
  /**
   * Atomically claims the grant: true for the first claim only. `expiresAtSeconds` is the grant's `exp`. False or a throw both mean "do not
   * spend": the caller (consumeReviewerGrant) turns a throw into a refusal.
   */
  claim(iss: string, cid: string, jti: string, expiresAtSeconds: number, signal?: AbortSignal): Promise<boolean>;
}

export class DynamoReviewerGrants implements ReviewerGrantStore {
  /** `table` is the agent route's markers table (GATEWAY_MARKERS_TABLE). */
  constructor(private readonly db: Dynamo, private readonly table: string, private readonly now: () => number = Date.now) {}
  async claim(iss: string, cid: string, jti: string, expiresAtSeconds: number, signal?: AbortSignal): Promise<boolean> {
    if (typeof iss !== "string" || iss.length === 0 || iss.length > 2048 || !COMPANY.test(cid) || !JTI.test(jti) || !Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= 0) throw new AwsNotSentError();
    return this.db.put(
      this.table,
      { pk: companyPartition(iss, cid), sk: `REVGRANT#${jti.toLowerCase()}`, claimedAt: Math.floor(this.now() / 1000), expiresAt: expiresAtSeconds + REVIEWER_GRANT_KEEP_SECONDS },
      (e) => `attribute_not_exists(${e.name("pk")})`,
      signal === undefined ? {} : { signal },
    );
  }
}

/** The store for tests and harnesses only: it forgets everything when the process ends, so it must never back a deployed gateway (process.ts builds the Dynamo one). */
export class InMemoryReviewerGrants implements ReviewerGrantStore {
  readonly #claimed = new Set<string>();
  async claim(iss: string, cid: string, jti: string): Promise<boolean> {
    const key = JSON.stringify([iss, cid, jti.toLowerCase()]);
    if (this.#claimed.has(key)) return false;
    this.#claimed.add(key);
    return true;
  }
}

/** The project and task id the company-limit read uses: the company's row does not depend on either. */
export const REVIEWER_LIMIT_ID = "reviewer-limit";
/**
 * The room left in the company's ONE cap (the agent meter's company row, which every route's holds count in), in micro-dollars: what a review may
 * still take, the same figure the reserve below enforces. Undefined when the cap or the row cannot be read as this company's (no reviewer access).
 */
export async function companyRoomMicros(caps: CapsSource, meter: Pick<Meter, "read">, iss: string, cid: string, signal?: AbortSignal): Promise<number | undefined> {
  const scope = { iss, cid, pid: REVIEWER_LIMIT_ID, tid: REVIEWER_LIMIT_ID };
  const cap = (await caps.capsFor(scope, signal)).companyMonth;
  const row = (await meter.read(scope)).find((r) => r.item === "company");
  return cap === undefined || !Number.isSafeInteger(cap) || row === undefined || row.company !== cid ? undefined : Math.max(0, cap - row.committed);
}
export { REVIEWER_GRANT_SECONDS };
