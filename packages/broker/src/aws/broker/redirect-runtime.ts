// Stop & redirect, the broker's side of the world (live-interaction design 3.7, switch `rd`): what the redirect route needs that is not the table. Built once with the broker's dependencies and handed to
// the session routes as `redirect`; absent while the switch is off, and then the route does not exist.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { WORKER_PING_FEATURES_FIELD, liveInteractionFlagOn, LIVE_INTERACTION_FLAGS, workspaceSessionKey } from "@agentx/contracts";
import type { RedirectConfig } from "../../agent-sessions/redirect.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import type { AwsBrokerDependencies } from "./definitions.js";

/** The worker's port and how long /ping may take: the same as every other delivery (ec2-delivery.ts, dispatcher.ts). */
const WORKER_PORT = 8080;
const PING_TIMEOUT_MS = 3_000;

/**
 * What the worker of the task's workspace lists on /ping, or `undefined` when there is no ready worker to ask. Rejects when the worker does not answer. Nothing here starts compute: a workspace whose
 * worker is stopped or starting has no one to ask, and a redirect is refused (fail closed). The broker needs a network path to the workers for this; without one every probe fails and every redirect is refused.
 */
export async function workspaceWorkerFeatures(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName">, task: Pick<DeveloperTaskRecord, "workspaceId">, fetchPing: typeof fetch = fetch): Promise<readonly string[] | undefined> {
  const session = ((await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: workspaceSessionKey(task.workspaceId), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (session?.["state"] !== "READY" || typeof session["privateIp"] !== "string") return undefined;
  const response = await fetchPing(`http://${session["privateIp"]}:${WORKER_PORT}/ping`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`worker /ping returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  const features = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[WORKER_PING_FEATURES_FIELD] : undefined;
  return Array.isArray(features) ? features.filter((feature): feature is string => typeof feature === "string") : [];
}

/**
 * The redirect's outside world, or undefined: the switch `rd` (the broker's `LIVE_REDIRECT_ENABLED`) is on only when it is exactly "1". Off, nothing is built, the route does not exist and no
 * terminal result looks for a redirect. Turn it on only after the dispatcher and the worker image that carry `task.ownerRedirect.v1` are deployed, and the broker can reach the workers' /ping.
 */
export function redirectFromEnvironment(dependencies: AwsBrokerDependencies, env: Record<string, string | undefined> = process.env): RedirectConfig | undefined {
  if (!liveInteractionFlagOn(env[LIVE_INTERACTION_FLAGS.redirect.variable])) return undefined;
  return { workerFeatures: (task) => workspaceWorkerFeatures(dependencies, task) };
}
