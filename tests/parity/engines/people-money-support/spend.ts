// The money seed the people-money lane's scenarios share: one company limit and what was already spent, written the way each side reads it.
//   Cloud: the org's BUDGET setting (`orgSettingsKey(org, "BUDGET")`, read by `effectiveLimits`), the ledger counter `SPEND#<month>/ORG` (`readScopeCounters`), and
//          the model proxy's own figure for the org (the proxy is the truth for an org, ruling R22), all at the same amounts.
//   Core:  the same ledger counter row in the core's store (A5's CloudAdmission holds against `committedUsd`), and the limit through FakeWorldOptions.companyLimitUsd.
// `effectiveLimitOf` reads Cloud's own `effectiveLimits` over the seeded BUDGET row, so the core's limit is checked to be the number Cloud's rule gives (one rule).
import { orgSettingsKey, spendCounterKey } from "@agentx/cloud-contracts";
import type { OrgId, StoredDocument } from "@rovara-code/contracts";
import { effectiveLimits } from "../../../../packages/broker/src/spend/settings.js";
import { FakeDynamoDb } from "../../../support/fake-dynamodb.js";
import type { Scenario, Step } from "../../harness/types.js";

export type SpendLimitStep = Extract<Step, { do: "spend.limit" }> & { spentUsd?: number };

export const spendStepOf = (scenario: Scenario): SpendLimitStep | undefined => scenario.steps.find((step): step is SpendLimitStep => step.do === "spend.limit");

export const monthNow = (now: Date): string => now.toISOString().slice(0, 7);

/** The items Cloud's admission reads, for one company and month. */
export function cloudSpendItems(orgId: OrgId, month: string, limitUsd: number, spentUsd: number): Record<string, unknown>[] {
  return [
    { ...orgSettingsKey(orgId, "BUDGET"), orgMonthlyUsd: limitUsd, memberOverrides: {} },
    { ...spendCounterKey(orgId, month, "ORG"), spentUsd, committedUsd: spentUsd },
  ];
}

/** The ledger counter the core's CloudAdmission holds against. */
export function coreCounterItem(companyId: OrgId, month: string, spentUsd: number): StoredDocument {
  return { ...spendCounterKey(companyId, month, "ORG"), entityType: "SPEND_COUNTER", spentUsd, committedUsd: spentUsd };
}

/** Cloud's org limit for the month, as its own `effectiveLimits` reads the seeded BUDGET row (the number the core is given). */
export async function effectiveLimitOf(orgId: OrgId, month: string, limitUsd: number): Promise<number | undefined> {
  const db = new FakeDynamoDb();
  for (const item of cloudSpendItems(orgId, month, limitUsd, 0)) db.set(item);
  const limits = await effectiveLimits({ documentClient: db, tableName: "state" }, { orgId, month, scopes: [{ kind: "org" }] });
  return limits.get("ORG");
}
