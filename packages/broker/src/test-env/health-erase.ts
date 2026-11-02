// Setup and test health SH28: deleting what the project health stored when a project is archived or a company closes. Three kinds of item live in a project's partition:
//   TESTENV#HEALTH            the project's health (also expires 60 days after its last write)
//   TESTENV#HEALTH#SETTINGS   `nightly.proposeFixTask` (a setting, no expiry)
//   TESTENV#PROPOSEDTASK#*    proposed fix tasks (also expire after 30 days)
// NOT behind the `nh` switch: what was stored while the switch was on is erased after it is turned off too. The erase of one project is a handful of deletes (the proposals are capped), so it runs whole. The
// company walk goes through the project catalog a page at a time up to a bounded number of pages; a company with more projects than that leaves only the settings item (a boolean) behind, and the two
// expiries take the rest. Best effort for the callers: they log a failure and never undo the archive or the close.
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXNameSchema, orgProjectCatalogPk, projectPk, type OrgId } from "@agentx/contracts";
import type { TestEnvDeps } from "../org/test-environment.js";
import { eraseProposedFixTasks } from "./proposed-tasks.js";

type EraseDeps = Pick<TestEnvDeps, "documentClient" | "tableName" | "now">;

/** Deletes one project's health, its setting and its proposed tasks. Idempotent. */
export async function eraseProjectHealth(deps: EraseDeps, orgId: OrgId, project: string): Promise<void> {
  const pk = projectPk(orgId, project);
  for (const sk of ["TESTENV#HEALTH", "TESTENV#HEALTH#SETTINGS"]) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk, sk } }));
  await eraseProposedFixTasks(deps, orgId, project);
}

export const HEALTH_ERASE_CATALOG_PAGE = 25;
export const HEALTH_ERASE_PAGES_MAX = 40;

/** Deletes the health of every project of a company (a company close): up to `HEALTH_ERASE_PAGES_MAX` pages of its project catalog. Returns whether the whole catalog was visited. */
export async function eraseOrgHealth(deps: EraseDeps, orgId: OrgId): Promise<"done" | "partial"> {
  const catalogPk = orgProjectCatalogPk(orgId);
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < HEALTH_ERASE_PAGES_MAX; page += 1) {
    const reply = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": catalogPk, ":prefix": "PROJECT#" },
      ConsistentRead: true, Limit: HEALTH_ERASE_CATALOG_PAGE, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const entry of reply.Items ?? []) {
      const name = typeof entry.sk === "string" ? entry.sk.slice("PROJECT#".length) : "";
      if (AgentXNameSchema.safeParse(name).success) await eraseProjectHealth(deps, orgId, name);
    }
    if (reply.LastEvaluatedKey === undefined) return "done";
    start = reply.LastEvaluatedKey;
  }
  return "partial";
}
