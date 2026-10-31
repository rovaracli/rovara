// Enterprise foundations I3 (wiring): the broker's side of erasing a person from the attribution change requests carry. The Team record's erase (`team-record/erase.ts`, step
// `attribution`) calls `attributionErasureOf(dependencies).erase(orgId, developerId)`; that cuts the person's reference rows, rewrites every description that names them to
// "a former member" (on the host, then in the broker's own copies of it), and only then deletes the person's rows (`eraseAttributionOfPerson`: order and retry rules there).
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { rewriteAttributionBody, type OrgId } from "@agentx/contracts";
import { dynamoAttributionLinkStore } from "../../attribution/links.js";
import { eraseAttributionOfPerson } from "../../wiring/enterprise-identity.js";
import { queryAllItems } from "../admin-reads.js";
import { taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { getItem } from "../cancellation.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { githubScopeOf } from "./scope-helpers.js";

type Role = "requester" | "approver";

/** The erase port of the Team record, over this broker's tables and GitHub access. */
export function attributionErasureOf(dependencies: AwsBrokerDependencies): { erase(orgId: OrgId, developerId: string): Promise<number> } {
  const links = dynamoAttributionLinkStore({ documentClient: dependencies.documentClient, tableName: dependencies.tableName });
  return { erase: (orgId, developerId) => eraseAttributionOfPerson(links, orgId, developerId, (taskId, role) => rewriteDescriptionsOfTask(dependencies, taskId, role)) };
}

/**
 * Rewrites the person's line in every change request description of a task: on the host first (the copy people read), then in the broker's own record of the pull request and of the
 * publication that opened it. A task that no longer exists has nothing to rewrite. Throws when the host cannot be read or written, so the erasure keeps the person's rows and is retried.
 * Idempotent: a description that no longer names them is left as it is.
 */
export async function rewriteDescriptionsOfTask(dependencies: AwsBrokerDependencies, taskId: string, role: Role): Promise<void> {
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (task === undefined) return;
  const scope = await githubScopeOf(dependencies, task);
  const pullRequests = await queryAllItems(dependencies, `WORKSPACE#${task.workspaceId}`, "PULL_REQUEST#");
  for (const record of pullRequests) {
    const repositoryUrl = String(record.repositoryUrl);
    const number = Number(record.number);
    const current = (await dependencies.githubPullRequests.getPullRequest(repositoryUrl, number, scope)).body;
    if (current !== undefined && current !== null) {
      const next = rewriteAttributionBody(current, role);
      if (next !== current) await dependencies.githubPullRequests.updatePullRequest(repositoryUrl, number, { body: next }, scope);
    }
    if (typeof record.body === "string") await rewriteStored(dependencies, { pk: String(record.pk), sk: String(record.sk) }, "body", record.body, role);
  }
  for (const operation of await queryAllItems(dependencies, `WORKSPACE#${task.workspaceId}`, "OPERATION#")) {
    const body = (operation.publication as { body?: unknown } | undefined)?.body;
    if (typeof body === "string") await rewriteStored(dependencies, { pk: String(operation.pk), sk: String(operation.sk) }, "publication.body", body, role);
  }
}

async function rewriteStored(dependencies: AwsBrokerDependencies, key: { pk: string; sk: string }, path: "body" | "publication.body", body: string, role: Role): Promise<void> {
  const next = rewriteAttributionBody(body, role);
  if (next === body) return;
  await dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName, Key: key,
    UpdateExpression: path === "body" ? "SET #body = :next" : "SET publication.#body = :next",
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeNames: { "#body": "body" }, ExpressionAttributeValues: { ":next": next },
  }));
}
