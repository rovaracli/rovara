// Learning v2 production wiring (lessons-in-production lane 1): the company's own limit on what learning may spend (`LearningSpend`, `lessons/ports.ts`).
//
//   - Public: learning has a cap of its own, $20 a month per company (owner decision, DECISIONS #22). The month's figure is ONE spend counter of the company's ledger, `LEARNING` (UTC month, like every counter):
//     its `committedUsd` is what learning has spent plus what the caps of learning's open keys hold. The BINDING check is atomic and is not made here: every learning key holds its whole cap on that counter in the same
//     transaction that reserves it (`reserve` with a hold, `learning-model.ts`), so concurrent calls can never take the month past the cap, a call that failed or crashed holds its cap until the key is settled and
//     finalized (the ordinary sweep, which also finalizes a key nobody blocked ten minutes after it expired), and the spend is booked when the proxy has flushed it, not before.
//   - `admit` is only the cheap look before a call: does the month have room for this estimate? It writes nothing and holds nothing (a hold with a token that could leak does not exist any more).
//   - Enterprise: learning has no cap of its own (Q8). `admit` is true; the company's existing budgets (the org's and the project's, in the same reservation) bind the call.
//   - Fail closed: a counter that cannot be read is a refusal.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, spendCounterKey } from "@agentx/contracts";
import type { Edition } from "../../lessons/policy.js";
import type { LearningSpend } from "../../lessons/ports.js";
import { cleanUsd } from "../../spend/top-ups.js";

/** Owner decision (DECISIONS #22): a Public company's learning may spend at most this much in a UTC month. */
export const PUBLIC_LEARNING_MONTHLY_CAP_USD = 20;
/** The agent name the learning line carries on the ledger (the key's tag and its agent usage counter). */
export const LEARNING_AGENT_ID = "learning";
/** The name of the month's learning counter among the company's spend counters. */
export const LEARNING_COUNTER = "LEARNING";

/** What learning may spend in a month on this edition: the Public cap (or the given replacement), nothing for Enterprise (no cap of its own). */
export const learningMonthlyCapUsd = (edition: Edition, override?: number): number | undefined => (edition === "enterprise" ? undefined : override ?? PUBLIC_LEARNING_MONTHLY_CAP_USD);

export interface CompanyLearningSpendDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table. */
  tableName: string;
  edition: Edition;
  now: () => number;
  /** Replaces the Public cap (tests, and a later setting). */
  monthlyCapUsd?: number;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

/** The UTC month a time falls in, `YYYY-MM`. */
export const learningMonthOf = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 7);

export function companyLearningSpend(deps: CompanyLearningSpendDependencies): LearningSpend {
  const cap = learningMonthlyCapUsd(deps.edition, deps.monthlyCapUsd);
  const look = async (workspaceId: string, estimateUsd: number): Promise<"ok" | "month_full" | "too_large" | "unreadable"> => {
    const org = OrgIdSchema.safeParse(workspaceId);
    if (!org.success || !Number.isFinite(estimateUsd) || estimateUsd < 0) return "unreadable";
    // Enterprise: no cap of its own, nothing to look at.
    if (cap === undefined) return "ok";
    const estimate = cleanUsd(estimateUsd);
    // A call that cannot fit the month's whole cap fits nowhere.
    if (estimate > cap) return "too_large";
    try {
      const item = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: spendCounterKey(org.data, learningMonthOf(deps.now()), LEARNING_COUNTER), ConsistentRead: true }))) as { Item?: { committedUsd?: unknown } }).Item;
      const committed = typeof item?.committedUsd === "number" && Number.isFinite(item.committedUsd) ? item.committedUsd : 0;
      // A millionth of slack keeps float dust from refusing a call that fits exactly (the reservation uses the same).
      return committed <= cleanUsd(cap - estimate + 0.000001) ? "ok" : "month_full";
    } catch {
      deps.log?.("learning.spend_admit_failed", { orgId: org.data });
      return "unreadable";
    }
  };
  return { look, async admit(workspaceId, estimateUsd) { return (await look(workspaceId, estimateUsd)) === "ok"; } };
}
