// Insights: spend vs outcomes (design section 3), from the spend counters that exist today (the partition `GET /v1/app/org/spend` reads), cut down to the viewer's scope on the server.
//   - the company's totals and every project's figures for a company-scope viewer; a maintainer gets only the projects they maintain and no totals;
//   - `byPerson` (spend per member) ONLY for an owner or admin (decision 33, A-28): for anyone else the key is ABSENT, not empty, and the per-member counters are never read at all;
//   - what a project shipped needs the work-event capture that is not built: `people`, `shipped` and `costPerShippedUsd` are null and `outcomes.status` is "unavailable", never a 0.
// `committedUsd` includes `spentUsd` (held = committed - spent, available = limit - committed), as the Spending page already computes it. Every key is built from the caller's checked company.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { scopeKey, spendCounterKey, type BudgetScope, type InsightsSpend } from "@agentx/cloud-contracts";
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { queryPartition } from "../agent-sessions/live.js";
import { effectiveLimits } from "../spend/settings.js";
import { cleanUsd } from "../spend/top-ups.js";
import { insightsNames, type InsightsNameDependencies } from "./names.js";
import type { InsightsCaller, InsightsViewer } from "./scope.js";

export interface InsightsSpendDependencies extends InsightsNameDependencies {
  /** Ruling R47: true on a cloud install, whose orgs start with the placeholder monthly limits. */
  cloud?: boolean | undefined;
}
type Item = Record<string, unknown>;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;
const PROJECTS_MAX = 2000;
const MEMBERS_MAX = 10_000;
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? cleanUsd(value) : 0);

export function spendMonth(asked: string | null, nowMs: number): string {
  if (asked === null) return new Date(nowMs).toISOString().slice(0, 7);
  if (!MONTH.test(asked)) throw agentXError("CONFIG_INVALID", "month: use the form YYYY-MM");
  return asked;
}

export async function buildSpend(deps: InsightsSpendDependencies, caller: InsightsCaller, viewer: InsightsViewer, query: { month: string; project?: string | undefined }): Promise<InsightsSpend> {
  const orgId: OrgId = caller.orgId;
  const { month } = query;
  const pk = spendCounterKey(orgId, month, "ORG").pk;
  const company = viewer.scope.kind === "company";
  const read = { documentClient: deps.documentClient, tableName: deps.tableName } as Parameters<typeof queryPartition>[0];
  const [orgItem, projectItems, memberItems] = await Promise.all([
    company ? (deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk, sk: "ORG" }, ConsistentRead: true })) as Promise<{ Item?: Item }>).then((answer) => answer.Item) : Promise.resolve(undefined),
    queryPartition(read, pk, { prefix: "PROJECT#", max: PROJECTS_MAX }),
    // Per-person counters are read only for the one reader who may be told them.
    viewer.canSeePerPerson ? queryPartition(read, pk, { prefix: "MEMBER#", max: MEMBERS_MAX }) : Promise.resolve({ items: [] as Item[], more: false }),
  ]);
  const counters = new Map<string, Item>(projectItems.items.map((item) => [String(item["sk"]).slice("PROJECT#".length), item]));
  // The projects shown: for the company, every project with a counter (or the one asked for); for a maintainer, every project they maintain (at 0 when nothing was spent).
  const names = viewer.scope.kind === "projects" ? [...viewer.scope.projects] : [...counters.keys()];
  const shown = names.filter((name) => query.project === undefined || name === query.project);
  const scopes: BudgetScope[] = [...(company ? [{ kind: "org" as const }] : []), ...shown.map((project) => ({ kind: "project" as const, project })), ...memberItems.items.map((item) => ({ kind: "member" as const, developerId: String(item["sk"]).slice("MEMBER#".length) }))];
  const limits = await effectiveLimits({ documentClient: deps.documentClient, tableName: deps.tableName, ...(deps.cloud === true ? { cloud: true } : {}) }, { orgId, month, scopes });
  const limitOf = (scope: BudgetScope): { limitUsd?: number } => { const limit = limits.get(scopeKey(scope)); return limit === undefined ? {} : { limitUsd: limit }; };

  const byProject = shown.map((project) => {
    const item = counters.get(project);
    return { project, spentUsd: num(item?.["spentUsd"]), committedUsd: num(item?.["committedUsd"]), ...limitOf({ kind: "project", project }), people: null, shipped: null, costPerShippedUsd: null };
  }).sort((a, b) => b.spentUsd - a.spentUsd || a.project.localeCompare(b.project));

  let byPerson: NonNullable<InsightsSpend["byPerson"]> | undefined;
  if (viewer.canSeePerPerson) {
    const ids = memberItems.items.map((item) => String(item["sk"]).slice("MEMBER#".length)).filter((id) => /^[a-f0-9]{64}$/u.test(id));
    const named = await insightsNames(deps, orgId, ids);
    byPerson = memberItems.items.flatMap((item) => {
      const developerId = String(item["sk"]).slice("MEMBER#".length);
      return /^[a-f0-9]{64}$/u.test(developerId) ? [{ developerId, name: named.get(developerId) ?? "Unknown", spentUsd: num(item["spentUsd"]), ...limitOf({ kind: "member", developerId }) }] : [];
    }).sort((a, b) => b.spentUsd - a.spentUsd || a.name.localeCompare(b.name) || a.developerId.localeCompare(b.developerId));
  }
  return {
    month, status: "ready", scope: company ? "company" : "projects",
    ...(company ? { totals: { spentUsd: num(orgItem?.["spentUsd"]), committedUsd: num(orgItem?.["committedUsd"]), ...limitOf({ kind: "org" }) } } : {}),
    byProject,
    ...(byPerson === undefined ? {} : { byPerson }),
    outcomes: { status: "unavailable" },
  };
}
