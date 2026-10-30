// Member removal (v1.1), task 5: what the removal dialog shows before anyone confirms. Bounded counts of what moves to the successor and what the person was for (their grants and
// maintained projects), and the fixed lines for what ends. Every count is capped (`COUNT_CAP`, "or more"), and one that cannot be read is left at zero with a warning, so a preview
// never blocks a removal.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { MEMBER_GRANT_SK_PREFIX, approverIndexKey, memberGithubKey, memberGrantsPk, openSpendRequestsKey, type OrgId } from "@agentx/contracts";
import type { AgentRouteDependencies } from "../../agents/routes.js";

export const COUNT_CAP = 1000;
const cap = (count: number) => Math.min(count, COUNT_CAP);

export interface PreviewDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  agents?: Pick<AgentRouteDependencies, "store" | "chains" | "triggers"> | undefined;
}

export interface RemovalMoves { agents: number; skills: number; chains: number; triggers: number; approvals: number; spendRequests: number }
export interface RemovalDuties { projectGrants: number; maintainerProjects: number }

/** What ends at once, in fixed words (no names). The GitHub line appears only when the person has a link. */
export function removalEnds(githubLinked: boolean): string[] {
  return [
    "Their sign-in on the web, in the CLI and in Slack ends, and so do their device sessions.",
    "Their project access and any monthly limit set for them are removed.",
    ...(githubLinked ? ["Their GitHub link is removed, so their GitHub approvals no longer count."] : []),
    "Their running tasks stop after their current step. None of them will open a pull request.",
  ];
}

/** Whether the person linked a GitHub account in this org. */
export async function hasGithubLink(deps: PreviewDeps, orgId: OrgId, developerId: string): Promise<boolean> {
  const answer = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: memberGithubKey(orgId, developerId), ConsistentRead: true })) as { Item?: unknown };
  return answer.Item !== undefined;
}

/** Reads a partition a page at a time and stops as soon as `onItem` says it has enough: a count that is capped never reads past the cap. */
async function pages(deps: PreviewDeps, pk: string, prefix: string | undefined, onItem: (item: Record<string, unknown>) => boolean | void): Promise<void> {
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: prefix === undefined ? { ":pk": pk } : { ":pk": pk, ":prefix": prefix }, ConsistentRead: true, Limit: COUNT_CAP, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) if (onItem(item) === true) return;
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
}

/** What the person owns or is listed for, which the existing movers hand to the successor. */
export async function countHandOffs(deps: PreviewDeps, orgId: OrgId, leaver: string): Promise<{ moves: RemovalMoves; warnings: string[] }> {
  const moves: RemovalMoves = { agents: 0, skills: 0, chains: 0, triggers: 0, approvals: 0, spendRequests: 0 };
  const warnings: string[] = [];
  const count = async (name: keyof RemovalMoves, read: () => Promise<number>) => {
    try { moves[name] = cap(await read()); } catch { warnings.push(`The number of ${name === "spendRequests" ? "spend requests" : name} could not be read.`); }
  };
  const agents = deps.agents;
  if (agents !== undefined) {
    await count("agents", async () => (await agents.store.list(orgId)).filter((agent) => (agent.owner.kind === "member" && agent.owner.developerId === leaver) || agent.accountable?.developerId === leaver).length);
    await count("skills", async () => (await agents.store.skills.list(orgId)).filter((skill) => skill.owner.kind === "member" && skill.owner.developerId === leaver).length);
    if (agents.chains !== undefined) {
      const chains = agents.chains;
      await count("chains", async () => (await chains.list(orgId)).filter((chain) => (chain.owner.kind === "member" && chain.owner.developerId === leaver) || chain.accountable?.developerId === leaver).length);
    }
    if (agents.triggers !== undefined) {
      const triggers = agents.triggers;
      await count("triggers", async () => (await triggers.listByCreator(orgId, leaver)).length);
    }
  }
  await count("approvals", async () => {
    let found = 0;
    await pages(deps, approverIndexKey(orgId, leaver, "apr_00000000000000000000").pk, undefined, () => { found += 1;return found >= COUNT_CAP; });
    return found;
  });
  await count("spendRequests", async () => {
    let found = 0;
    await pages(deps, openSpendRequestsKey(orgId, "2000-01-01T00:00:00.000Z", "spr_0").pk, undefined, (item) => {
      if (Array.isArray(item["approverIds"]) && (item["approverIds"] as unknown[]).includes(leaver)) found += 1;
      return found >= COUNT_CAP;
    });
    return found;
  });
  return { moves, warnings };
}

/** The projects they hold a grant on, and the ones they maintain: shown to the admin, never moved. */
export async function readDuties(deps: PreviewDeps, orgId: OrgId, leaver: string): Promise<RemovalDuties> {
  let projectGrants = 0, maintainerProjects = 0;
  await pages(deps, memberGrantsPk(orgId, leaver), MEMBER_GRANT_SK_PREFIX, (item) => {
    projectGrants += 1;
    if (item["projectRole"] === "maintainer") maintainerProjects += 1;
    return projectGrants >= COUNT_CAP;
  });
  return { projectGrants: cap(projectGrants), maintainerProjects: cap(maintainerProjects) };
}
