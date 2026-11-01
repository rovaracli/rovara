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
import { changeRequestRef, hostOfTaskRepository } from "./repository-hosts.js";

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
    // P5e: the description is read and rewritten on the code host the pull request's repository record names. An unknown host kind throws the router's fixed sentence, so the erasure keeps the
    // person's rows and is retried (as for any host that cannot be read); it is never done through GitHub.
    const host = await hostOfTaskRepository(dependencies, task, { name: typeof record.repository === "string" ? record.repository : undefined, url: repositoryUrl });
    const ref = changeRequestRef(repositoryUrl, number);
    const current = (await host.getChangeRequest(ref, scope)).body;
    if (current !== undefined && current !== null) {
      const next = rewriteAttributionBody(current, role);
      if (next !== current) await host.updateChangeRequest(ref, { body: next }, scope);
    }
    if (typeof record.body === "string") await rewriteStored(dependencies, { pk: String(record.pk), sk: String(record.sk) }, "body", record.body, role);
  }
  for (const operation of await queryAllItems(dependencies, `WORKSPACE#${task.workspaceId}`, "OPERATION#")) {
    const body = (operation.publication as { body?: unknown } | undefined)?.body;
    if (typeof body === "string") await rewriteStored(dependencies, { pk: String(operation.pk), sk: String(operation.sk) }, "publication.body", body, role);
    const outboxId = (operation.publication as { outboxId?: unknown } | undefined)?.outboxId;
    if (typeof outboxId === "string") await rewriteOutbox(dependencies, outboxId, role);
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

/**
 * The outbox item that carries a publication to the worker holds the description and the attribution in its payload. Pending or already queued, the stored copy is rewritten (the
 * worker, if it has not published yet, then publishes "a former member"); an item that is gone has nothing to do. Copies already on the queue are the queue's, and are short-lived.
 */
async function rewriteOutbox(dependencies: AwsBrokerDependencies, outboxId: string, role: Role): Promise<void> {
  const key = { pk: `OUTBOX#${outboxId}`, sk: "OUTBOX" };
  const item = await getItem<{ invocation?: { payload?: { body?: unknown; attribution?: Record<string, unknown> } } }>(dependencies, key);
  const invocation = item?.invocation;
  const payload = invocation?.payload;
  if (invocation === undefined || payload === undefined) return;
  const body = typeof payload.body === "string" ? rewriteAttributionBody(payload.body, role) : undefined;
  const named = (payload.attribution?.[role] as { state?: unknown } | undefined)?.state === "named";
  const bodyChanged = body !== undefined && body !== payload.body;
  if (!bodyChanged && !named) return;
  const next = {
    ...invocation,
    payload: {
      ...payload,
      ...(bodyChanged ? { body } : {}),
      ...(named ? { attribution: { ...payload.attribution, [role]: { state: "former" } } } : {}),
    },
  };
  // The whole invocation is written back (only the erasure changes it, and the status the publisher sets is another attribute).
  await dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName, Key: key,
    UpdateExpression: "SET invocation = :invocation", ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":invocation": next },
  }));
}
