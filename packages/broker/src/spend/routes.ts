// Plan 3 Task 30: the read routes over the spend counters and the ledger.
//   GET /v1/app/budget                               the caller's own figures, the org's, the testing allowance, the ChatGPT plan's tokens, their alerts
//   GET /v1/app/org/spend?month=                     [owner or admin] the org's spend by project, member, agent, source and model
//   GET /v1/app/org/spend/ledger?month=&cursor=      [owner or admin] the month's settled amounts, newest first
//   GET /v1/app/projects/{p}/spend?month=            [`view_spend` on the project]
//   GET /v1/app/agents/{id}/spend?month=             [view] an agent's spend split by where its runs came from, its recent runs, its budget
// Every key is built from the caller's checked org, so another org's counters and lines can't be reached by any id or cursor. Member and org figures are the
// counters', which are advisory: LiteLLM's caps stay authoritative (R23). A month is `YYYY-MM` in UTC and defaults to the current one.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AgentIdSchema, agentRunsKey, agentXError, builtinSettingsKey, isBuiltinAgentId, projectAllows, type AgentId, type OrgId } from "@rovara-code/contracts";
import { SPEND_ORIGIN_KINDS, budgetAlertKey, ledgerKey, modelCounter, originCounter, personalCounter, scopeKey, sourceCounter, spendCounterKey, type BudgetScope } from "@agentx/cloud-contracts";
import { requireAgentAccess, type AgentCaller } from "../agents/access.js";
import { readGuardrails } from "../agents/guardrails.js";
import type { AgentRouteDependencies } from "../agents/routes.js";
import { roleOnProject } from "../agents/roster.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import type { BuiltinSettings } from "../agents/store.js";
import { agentUsageCounter } from "./payer.js";
import { effectiveLimits, effectiveMaxPerRun } from "./settings.js";
import { cleanUsd } from "./top-ups.js";

type Item = Record<string, unknown>;
type Deps = AgentRouteDependencies;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LEDGER_PAGE = 50;
const RECENT_RUNS = 20;
/** A month's counters and a month's runs of one agent are read whole; a partition this large is cut off rather than read forever. */
const MAX_QUERY_PAGES = 20;
const QUERY_PAGE = 500;
const CURSOR_SK = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z#[0-9a-f]{64}#\d{6}$/;

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? cleanUsd(value) : 0);
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const currentMonth = (deps: Deps): string => new Date((deps.now ?? Date.now)()).toISOString().slice(0, 7);

function monthOf(deps: Deps, url: URL): string {
  const asked = url.searchParams.get("month");
  if (asked === null) return currentMonth(deps);
  if (!MONTH.test(asked)) throw agentXError("CONFIG_INVALID", "month: use the form YYYY-MM");
  return asked;
}

async function getItem(deps: Pick<Deps, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

/** Every item of a partition, in sort-key order (newest first with `backwards`), up to the page limit. */
async function queryPartition(deps: Deps, pk: string, options: { backwards?: boolean } = {}): Promise<Item[]> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_QUERY_PAGES; page += 1) {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk },
      ScanIndexForward: options.backwards !== true, Limit: QUERY_PAGE, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    start = response.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return items;
}

const spendPk = (orgId: OrgId, month: string): string => spendCounterKey(orgId, month, "ORG").pk;

export interface Figures { spentUsd: number; committedUsd: number; limitUsd?: number }

async function figuresOf(deps: Pick<Deps, "documentClient" | "tableName">, orgId: OrgId, month: string, scope: BudgetScope, limits: Map<string, number | undefined>): Promise<Figures> {
  const item = await getItem(deps, spendCounterKey(orgId, month, scopeKey(scope)));
  const limitUsd = limits.get(scopeKey(scope));
  return { spentUsd: num(item?.["spentUsd"]), committedUsd: num(item?.["committedUsd"]), ...(limitUsd === undefined ? {} : { limitUsd }) };
}

const limitsDeps = (deps: Pick<Deps, "documentClient" | "tableName" | "cloud">) => ({ documentClient: deps.documentClient, tableName: deps.tableName, ...(deps.cloud === true ? { cloud: true } : {}) });

// ---- the caller's budget

async function getBudget(deps: Deps, caller: AgentCaller, month: string): Promise<unknown> {
  const { orgId, developerId } = caller;
  const scopes: BudgetScope[] = [{ kind: "org" }, { kind: "member", developerId }, { kind: "testing", developerId }];
  const limits = await effectiveLimits(limitsDeps(deps), { orgId, month, scopes });
  const [member, org, testing, personal, alerts] = await Promise.all([
    figuresOf(deps, orgId, month, scopes[1]!, limits), figuresOf(deps, orgId, month, scopes[0]!, limits), figuresOf(deps, orgId, month, scopes[2]!, limits),
    getItem(deps, spendCounterKey(orgId, month, personalCounter(developerId))), queryPartition(deps, budgetAlertKey(orgId, month, "ORG", "80").pk),
  ]);
  // The caller's own alerts and the org's: another member's are theirs.
  const mine = new Set(scopes.map(scopeKey));
  return {
    month, member, org, testing, personalPlan: { tokens: num(personal?.["tokens"]) },
    alerts: alerts.filter((alert) => mine.has(String(alert["scope"]))).map((alert) => ({ scope: alert["scope"], level: alert["level"], spentUsd: alert["spentUsd"], limitUsd: alert["limitUsd"], at: alert["at"] })),
  };
}

/**
 * The org's and the caller's own figures for one month, as `GET /v1/app/budget` answers them (the same counters and limits), for the trial view. Both are keyed by the caller's checked org.
 * Reads only.
 */
export async function readOrgAndMemberFigures(deps: Pick<Deps, "documentClient" | "tableName" | "cloud">, who: { orgId: OrgId; developerId: string }, month: string): Promise<{ org: Figures; member: Figures }> {
  const scopes: BudgetScope[] = [{ kind: "org" }, { kind: "member", developerId: who.developerId }];
  const limits = await effectiveLimits(limitsDeps(deps), { orgId: who.orgId, month, scopes });
  const [org, member] = await Promise.all([figuresOf(deps, who.orgId, month, scopes[0]!, limits), figuresOf(deps, who.orgId, month, scopes[1]!, limits)]);
  return { org, member };
}

// ---- the org's spend and ledger

function requireOrgAdmin(caller: AgentCaller): void {
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "Only an org owner or admin can see the company's spend.");
}

const bySpent = <T extends { spentUsd: number }>(rows: T[], name: (row: T) => string): T[] => rows.sort((a, b) => b.spentUsd - a.spentUsd || name(a).localeCompare(name(b)));

async function getOrgSpend(deps: Deps, caller: AgentCaller, month: string): Promise<unknown> {
  requireOrgAdmin(caller);
  const items = await queryPartition(deps, spendPk(caller.orgId, month));
  const withPrefix = (prefix: string) => items.filter((item) => String(item["sk"]).startsWith(prefix)).map((item) => ({ name: String(item["sk"]).slice(prefix.length), item }));
  const org = items.find((item) => item["sk"] === "ORG");
  const limits = await effectiveLimits(limitsDeps(deps), { orgId: caller.orgId, month, scopes: [{ kind: "org" }] });
  const limitUsd = limits.get("ORG");
  return {
    month, totalUsd: num(org?.["spentUsd"]), committedUsd: num(org?.["committedUsd"]), ...(limitUsd === undefined ? {} : { limitUsd }),
    byProject: bySpent(withPrefix("PROJECT#").map(({ name, item }) => ({ project: name, spentUsd: num(item["spentUsd"]), committedUsd: num(item["committedUsd"]) })), (row) => row.project),
    byMember: bySpent(withPrefix("MEMBER#").map(({ name, item }) => ({ developerId: name, spentUsd: num(item["spentUsd"]) })), (row) => row.developerId),
    byAgent: bySpent(withPrefix(agentUsageCounter("")).map(({ name, item }) => ({ agentId: name, spentUsd: num(item["spentUsd"]) })), (row) => row.agentId),
    bySource: bySpent(withPrefix(sourceCounter("")).map(({ name, item }) => ({ source: name, spentUsd: num(item["spentUsd"]) })), (row) => row.source),
    byModel: bySpent(withPrefix(modelCounter("")).map(({ name, item }) => ({ model: name, spentUsd: num(item["spentUsd"]) })), (row) => row.model),
  };
}

/** The fields of a ledger line the routes show; the key's id, the table's keys and the org are left out. */
const LINE_FIELDS = ["at", "usd", "settledUsd", "finalized", "model", "taskId", "operationId", "stepId", "agentId", "chainId", "chainRunId", "project", "payerKind", "payerId", "source", "origin"] as const;

function decodeCursor(raw: string | null): { sk: string } | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    const sk = typeof parsed === "object" && parsed !== null ? (parsed as { sk?: unknown }).sk : undefined;
    if (typeof sk === "string" && CURSOR_SK.test(sk)) return { sk };
  } catch { /* not ours */ }
  throw agentXError("CONFIG_INVALID", "cursor: not a cursor from this list");
}

async function getLedger(deps: Deps, caller: AgentCaller, month: string, rawCursor: string | null): Promise<unknown> {
  requireOrgAdmin(caller);
  const start = decodeCursor(rawCursor);
  const pk = ledgerKey(caller.orgId, month, "2000-01-01T00:00:00.000Z", "0".repeat(64), 0).pk;
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk },
    ScanIndexForward: false, Limit: LEDGER_PAGE, ...(start === undefined ? {} : { ExclusiveStartKey: { pk, sk: start.sk } }),
  })) as { Items?: Item[]; LastEvaluatedKey?: { sk?: string } };
  const lines = (response.Items ?? []).map((item) => Object.fromEntries(LINE_FIELDS.flatMap((field) => (item[field] === undefined ? [] : [[field, item[field]] as const]))));
  const next = response.LastEvaluatedKey?.sk;
  return { month, lines, ...(next === undefined ? {} : { next: Buffer.from(JSON.stringify({ sk: next })).toString("base64url") }) };
}

// ---- a project's spend

async function getProjectSpend(deps: Deps, caller: AgentCaller, project: string, month: string): Promise<unknown> {
  const role = await roleOnProject(deps, caller, project);
  if (!projectAllows(role, "view_spend")) throw agentXError("FORBIDDEN", `Only a maintainer of ${project} can see its spend.`);
  const scope: BudgetScope = { kind: "project", project };
  const limits = await effectiveLimits(limitsDeps(deps), { orgId: caller.orgId, month, scopes: [scope] });
  return { month, project, ...await figuresOf(deps, caller.orgId, month, scope, limits) };
}

// ---- an agent's spend

async function getAgentSpend(deps: Deps, caller: AgentCaller, agentId: AgentId, month: string): Promise<unknown> {
  const { agent } = await requireAgentAccess(deps, caller, agentId, "view");
  const scope: BudgetScope = { kind: "agent", agentId };
  const orgId = caller.orgId;
  const [limits, usage, origins, own, runs, guardrails, settings] = await Promise.all([
    effectiveLimits(limitsDeps(deps), { orgId, month, scopes: [scope] }),
    getItem(deps, spendCounterKey(orgId, month, agentUsageCounter(agentId))),
    Promise.all(SPEND_ORIGIN_KINDS.map(async (kind) => [kind, num((await getItem(deps, spendCounterKey(orgId, month, originCounter(agentId, kind))))?.["spentUsd"])] as const)),
    getItem(deps, spendCounterKey(orgId, month, scopeKey(scope))),
    queryPartition(deps, agentRunsKey(orgId, month, agentId, "-").pk),
    readGuardrails(deps, orgId),
    isBuiltinAgentId(agentId) ? getItem(deps, builtinSettingsKey(orgId, agentId)) : Promise.resolve(undefined),
  ]);
  const limitUsd = limits.get(scopeKey(scope));
  const record = "owner" in agent ? agent : settings === undefined ? undefined : (settings as unknown as BuiltinSettings);
  const maxPerRunUsd = record === undefined ? undefined : effectiveMaxPerRun(record, guardrails);
  // A run is shown only where the caller has a role: an agent is visible to more people than the projects it works in.
  const seen = new Map<string, Promise<boolean>>();
  const mayShow = (project: string): Promise<boolean> => {
    let known = seen.get(project);
    if (known === undefined) {
      known = roleOnProject(deps, caller, project).then(() => true, () => false);
      seen.set(project, known);
    }
    return known;
  };
  const ordered = runs.sort((a, b) => String(b["lastAt"]).localeCompare(String(a["lastAt"])));
  const recentRuns: Array<Record<string, unknown>> = [];
  for (const run of ordered) {
    const project = text(run["project"]);
    if (project === undefined || !await mayShow(project)) continue;
    // The run item is keyed by the task, the operation or, for a Slack turn that has neither, the key's token id, so its key is never shown.
    recentRuns.push({ ...(text(run["taskId"]) === undefined ? {} : { taskId: run["taskId"] }), project, origin: run["origin"], usd: num(run["usd"]), lastAt: run["lastAt"] });
    if (recentRuns.length === RECENT_RUNS) break;
  }
  return {
    month, totalUsd: num(usage?.["spentUsd"]), byOrigin: Object.fromEntries(origins), recentRuns,
    ...(limitUsd === undefined ? {} : { budget: { limitUsd, spentUsd: num(own?.["spentUsd"]) } }),
    ...(maxPerRunUsd === undefined ? {} : { maxPerRunUsd }),
  };
}

// ---- routing

const PROJECT_SPEND = /^\/v1\/app\/projects\/([^/]+)\/spend$/;
const AGENT_SPEND = /^\/v1\/app\/agents\/([^/]+)\/spend$/;

/**
 * The spend routes. Answers `undefined` for a path that is not one of them, so the agent routes go on to theirs. All are reads; any other method on
 * them is a 404 like an unknown route.
 */
export async function routeSpendRequest(deps: Deps, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const path = url.pathname;
  const project = PROJECT_SPEND.exec(path);
  const agent = AGENT_SPEND.exec(path);
  if (path !== "/v1/app/budget" && path !== "/v1/app/org/spend" && path !== "/v1/app/org/spend/ledger" && project === null && agent === null) return undefined;
  if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
  const month = monthOf(deps, url);
  if (path === "/v1/app/budget") return getBudget(deps, caller, month);
  if (path === "/v1/app/org/spend") return getOrgSpend(deps, caller, month);
  if (path === "/v1/app/org/spend/ledger") return getLedger(deps, caller, month, url.searchParams.get("cursor"));
  if (project !== null) {
    let name: string;
    try { name = decodeURIComponent(project[1]!); } catch { throw agentXError("PROJECT_NOT_FOUND", "that is not a valid AgentX project name"); }
    return getProjectSpend(deps, caller, name, month);
  }
  const parsed = AgentIdSchema.safeParse(agent![1]);
  if (!parsed.success) throw agentXError("NOT_FOUND", "no agent has that ID");
  return getAgentSpend(deps, caller, parsed.data, month);
}
