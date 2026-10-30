// A project's page (Plan 5 Task 16): `GET /v1/app/projects/{name}/overview`. Everything is read now, for the reader. A person with no role in the project gets `PROJECT_NOT_FOUND`, in the same
// words as for a project that is not there. What the reader may do (`you`) comes from their role; the month's money (`budget`) is read, and is in the answer, only for a role that may see the
// project's spend (a maintainer), so no one else learns what the project spends or merges; the agents are the roster's, as the reader may see them; and `running` is the Live wall's `team`
// filter for this project, so each session in it passed the reader's own access check. Reads are bounded: one page of tiles, the roster capped, and four single-item reads.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXNameSchema, LIVE_PAGE_MAX, OrgRoleSchema, PROJECT_OVERVIEW_AGENTS_MAX, PROJECT_ROSTER_LIST_MAX, ProjectOverviewSchema, agentXError, orgMemberKey, projectAllows, projectMonthStatsKey, scopeKey, spendCounterKey,
  type BudgetScope, type ProjectOverview, type ProjectRole,
} from "@agentx/contracts";
import type { ApprovalDependencies } from "../agents/approvals.js";
import type { AgentRouteDependencies } from "../agents/routes.js";
import { listRoster } from "../agents/roster.js";
import { effectiveLimits } from "../spend/settings.js";
import { cleanUsd } from "../spend/top-ups.js";
import { batchGetItems, liveSessions } from "./live.js";
import type { SessionReadCaller, SessionReadDependencies } from "./read.js";

type Item = Record<string, unknown>;

/** The project's card, as the project code knows it: the part of the page that is not about sessions, money or agents. */
export interface ProjectPageParts {
  name: string;
  description?: string | undefined;
  status: "active" | "archived";
  latestRevision?: number | undefined;
  repositories: Array<{ fullName: string; defaultBranch: string }>;
  setup: { status: "unchecked" | "checking" | "ready" | "failed" | "outdated"; checkedRevision?: number | undefined; checkedAt?: string | undefined; failedStep?: string | undefined };
  channels: string[];
}

/** Reads the project's card for a reader who already has a role in it; undefined when the project has no record. */
export type ProjectPageReader = (caller: SessionReadCaller, name: string) => Promise<ProjectPageParts | undefined>;

export interface ProjectOverviewDependencies extends SessionReadDependencies {
  /** Plan 3's core: the roster of the project's agents, and the spend settings. Without it the page lists no agents and a maintainer's budget has no limit. */
  approvals?: (ApprovalDependencies & Partial<AgentRouteDependencies>) | undefined;
  projectPage?: ProjectPageReader | undefined;
}

const notFound = () => agentXError("PROJECT_NOT_FOUND", "project not found");
const isAgentXError = (error: unknown): boolean => error instanceof Error && error.name === "AgentXError";
const count = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0);
const money = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? cleanUsd(value) : 0);

async function getItem(deps: Pick<ProjectOverviewDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

/** The month's money on the project: what was spent (not what is held for open runs), its limit, the pull requests merged and what each cost. */
async function budgetOf(deps: ProjectOverviewDependencies, orgId: ProjectOverviewKeyOrg, project: string): Promise<NonNullable<ProjectOverview["budget"]>> {
  const month = new Date(deps.now()).toISOString().slice(0, 7);
  const scope: BudgetScope = { kind: "project", project };
  const [counter, stats, limit] = await Promise.all([
    getItem(deps, spendCounterKey(orgId, month, scopeKey(scope))),
    getItem(deps, projectMonthStatsKey(orgId, project, month)),
    deps.approvals === undefined ? Promise.resolve(undefined) : effectiveLimits({ documentClient: deps.documentClient, tableName: deps.tableName, ...(deps.approvals.cloud === true ? { cloud: true } : {}) }, { orgId, month, scopes: [scope] })
      .then((limits) => limits.get(scopeKey(scope)), (error: unknown) => { if (isAgentXError(error)) return undefined; throw error; }),
  ]);
  const spentUsd = counter === undefined || counter["orgId"] !== orgId ? 0 : money(counter["spentUsd"]);
  const mergedPullRequests = stats === undefined || stats["orgId"] !== orgId ? 0 : count(stats["mergedPullRequests"]);
  return {
    month, spentUsd, ...(limit === undefined ? {} : { limitUsd: limit }), mergedPullRequests,
    ...(mergedPullRequests === 0 ? {} : { costPerMergedPullRequestUsd: Math.round(spentUsd / mergedPullRequests * 100) / 100 }),
  };
}
type ProjectOverviewKeyOrg = SessionReadCaller["orgId"];

/**
 * `GET /v1/app/projects/{name}/overview`. The caller's project role is read now (`projectMembers`, as the spend and roster routes read it); with none, or with the project missing, the
 * answer is `PROJECT_NOT_FOUND`. An archived project refuses new work and settings changes, so its flags say so.
 */
export async function projectOverview(deps: ProjectOverviewDependencies, caller: SessionReadCaller, rawName: string): Promise<ProjectOverview> {
  if (deps.projectPage === undefined) throw agentXError("NOT_FOUND", "project pages are not set up in this deployment");
  const named = AgentXNameSchema.safeParse(rawName);
  if (!named.success) throw notFound();
  const name = named.data;
  const { orgId } = caller;

  const member = (await batchGetItems(deps, [orgMemberKey(orgId, caller.developerId)])).values().next().value as Item | undefined;
  const orgRole = OrgRoleSchema.safeParse(member?.["role"]);
  if (!orgRole.success) throw notFound();
  const asker: SessionReadCaller = { ...caller, orgRole: orgRole.data };
  const role: ProjectRole | undefined = await deps.projectMembers.roleOf(orgId, name, { developerId: caller.developerId, orgRole: orgRole.data });
  if (role === undefined) throw notFound();
  const page = await deps.projectPage(asker, name);
  if (page === undefined || page.name !== name) throw notFound();

  const wall = await liveSessions(deps, asker, { filter: "team", project: name, limit: LIVE_PAGE_MAX });
  const runningBy = new Map<string, number>();
  for (const tile of wall.tiles) if (tile.agent !== undefined) runningBy.set(tile.agent.agentId, (runningBy.get(tile.agent.agentId) ?? 0) + 1);

  let roster: Awaited<ReturnType<typeof listRoster>> = [];
  if (deps.approvals !== undefined) {
    try {
      roster = await listRoster(deps.approvals, { orgId, developerId: caller.developerId, orgRole: orgRole.data }, name, { max: PROJECT_ROSTER_LIST_MAX });
    } catch (error) {
      // A roster that cannot be read leaves the page without agents, never with another person's.
      if (!isAgentXError(error)) throw error;
    }
  }
  const agents = roster.filter((agent) => agent.status === "active").slice(0, PROJECT_OVERVIEW_AGENTS_MAX)
    .map((agent) => ({ agentId: agent.agentId, name: agent.name, description: agent.description, running: runningBy.get(agent.agentId) ?? 0 }));

  const open = page.status !== "archived";
  const canViewSpend = projectAllows(role, "view_spend");
  const answer = {
    orgId,
    project: {
      name, ...(page.description === undefined ? {} : { description: page.description }), status: page.status, ...(page.latestRevision === undefined ? {} : { latestRevision: page.latestRevision }),
      // The summary now carries the repository's registered name (lane B); the overview contract is unchanged and shows only these two fields.
      repositories: page.repositories.map(({ fullName, defaultBranch }) => ({ fullName, defaultBranch })),
      setup: {
        status: page.setup.status, ...(page.setup.checkedRevision === undefined ? {} : { checkedRevision: page.setup.checkedRevision }),
        ...(page.setup.checkedAt === undefined ? {} : { checkedAt: page.setup.checkedAt }), ...(page.setup.failedStep === undefined ? {} : { failedStep: page.setup.failedStep }),
      },
      channels: page.channels,
    },
    you: { role, canStartWork: open && projectAllows(role, "start_tasks"), canEditSettings: open && projectAllows(role, "edit_settings"), canViewSpend },
    agents,
    ...(canViewSpend ? { budget: await budgetOf(deps, orgId, name) } : {}),
    running: wall.tiles,
  };
  const checked = ProjectOverviewSchema.safeParse(answer);
  if (!checked.success) throw agentXError("RUNTIME_UNAVAILABLE", "This project's page can't be shown right now.");
  return checked.data;
}
