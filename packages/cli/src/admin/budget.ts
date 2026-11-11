// `agentx admin budget set` (ruling R47): an operator of a private or single-org install sets the monthly AI limits of its one org,
// which has none until they do. A cloud install's orgs set their own through the web app.
import { randomUUID } from "node:crypto";
import { agentXError } from "@rovara-code/contracts";
import { adminResponseBody } from "./http.js";

const MAX_BUDGET_USD = 1_000_000;

/** A limit in US dollars, from 0 to 1,000,000 with at most cents; the flag's name is in the refusal. */
export function parseBudgetUsd(flag: string, value: string): number {
  const text = value.trim().replace(/^\$/, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/u.test(text) || Number(text) > MAX_BUDGET_USD) {
    throw agentXError("CONFIG_INVALID", `${flag} must be a dollar amount from 0 to ${String(MAX_BUDGET_USD)}, such as 250 or 12.50`);
  }
  return Number(text);
}

export interface BudgetSettingsView {
  orgMonthlyUsd?: number;
  memberDefaultMonthlyUsd?: number;
  memberOverrides: Record<string, number>;
}

export async function setOrgBudget(
  input: { controlPlaneUrl: string; accessToken: string; orgMonthlyUsd?: number; memberDefaultMonthlyUsd?: number; requestId?: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ budget: BudgetSettingsView }> {
  if (input.orgMonthlyUsd === undefined && input.memberDefaultMonthlyUsd === undefined) {
    throw agentXError("CONFIG_INVALID", "name at least one of --org-monthly and --member-default");
  }
  const body = {
    requestId: input.requestId ?? randomUUID(),
    ...(input.orgMonthlyUsd === undefined ? {} : { orgMonthlyUsd: input.orgMonthlyUsd }),
    ...(input.memberDefaultMonthlyUsd === undefined ? {} : { memberDefaultMonthlyUsd: input.memberDefaultMonthlyUsd }),
  };
  const result = await adminResponseBody(await fetchImplementation(`${input.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/org/budget`, {
    method: "PUT",
    headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as { budget?: unknown };
  if (typeof result.budget !== "object" || result.budget === null) throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid budget answer");
  return { budget: result.budget as BudgetSettingsView };
}

/** What the operator is told: each limit as set, or "no limit". */
export function budgetText(budget: BudgetSettingsView): string {
  const money = (value: number | undefined) => (value === undefined ? "no limit" : `$${value.toFixed(2)}`);
  return `Monthly AI budget: organization ${money(budget.orgMonthlyUsd)}, each member ${money(budget.memberDefaultMonthlyUsd)}.\n`;
}
