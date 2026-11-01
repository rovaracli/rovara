// Stop & redirect, the broker's side of the world (live-interaction design 3.7, switch `rd`): what the redirect needs that is not the table. Built once with the broker's dependencies and handed to
// the session routes as `redirect`; absent while the switch is off, and then the route does not exist, no terminal result looks for a redirect, and the sweep does nothing.
//   - the worker probe (phase 1 and phase 2 refuse a coding redirect for a worker that does not list `task.ownerRedirect.v1`);
//   - phase 2: the hook the terminal-result path and the stuck-cancel path call once a stop has landed (registered against the broker's table client), and the task module's restarts, acting as the
//     person who redirected;
//   - the sweep that closes a redirect nobody finished.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { WORKER_PING_FEATURES_FIELD, liveInteractionFlagOn, LIVE_INTERACTION_FLAGS, orgMemberKey, workspaceSessionKey, type DeveloperSignInMethod, type RedirectRecord } from "@agentx/contracts";
import { continueRedirect, sweepStoppingRedirects, type RedirectContinueDependencies, type RedirectRestartHost } from "../../agent-sessions/redirect-continue.js";
import { registerRedirectContinuation } from "../../agent-sessions/redirect-hook.js";
import type { RedirectConfig } from "../../agent-sessions/redirect.js";
import { safeDisplayName } from "../../developer/person-name.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { developerTaskRouteDependencies, type DeveloperCaller } from "../developer-routes.js";
import { restartCodingForRedirect, restartPlanningForRedirect, revisePlanForRedirect, sendBackForRedirect } from "../developer-tasks/redirect-restart.js";
import type { DeveloperTaskRouteDependencies } from "../developer-tasks/types.js";
import { developerTaskActions } from "./dependency-wiring.js";
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
 * The person who redirected, as a task caller: their live org role and their name as the sign-in record keeps it. A person who is no longer a member of the org is no caller: the restart throws, and
 * the redirect ends with the step left stopped.
 */
async function redirectCaller(dependencies: AwsBrokerDependencies, record: RedirectRecord): Promise<DeveloperCaller> {
  const member = ((await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: orgMemberKey(record.orgId, record.actorId), ConsistentRead: true }))) as { Item?: { role?: unknown } }).Item;
  const role = member?.role;
  if (role !== "owner" && role !== "admin" && role !== "member") throw new Error("the person who redirected is not a member of the organization any more");
  const developer = dependencies.developer === undefined ? undefined
    : ((await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.developer.signInTableName, Key: { pk: `DEVELOPER#${record.actorId}`, sk: "META" }, ConsistentRead: true }))) as { Item?: { displayName?: unknown; provider?: unknown } }).Item;
  const provider: DeveloperSignInMethod = developer?.provider === "slack" || developer?.provider === "cloud" || developer?.provider === "github" ? developer.provider : "oidc";
  return {
    developerId: record.actorId, sessionId: "redirect", amr: provider, name: safeDisplayName(typeof developer?.displayName === "string" ? developer.displayName : "", record.actorId), orgId: record.orgId, orgRole: role,
  };
}

/** The task module's dependencies for the person's restart: the broker's own, with the person as the session actor (see `isSessionActor`: the redirect checked that they own the task). */
async function restartDependencies(dependencies: AwsBrokerDependencies, record: RedirectRecord): Promise<{ deps: DeveloperTaskRouteDependencies; caller: DeveloperCaller }> {
  if (dependencies.developer === undefined) throw new Error("developer sign-in is not set up in this deployment");
  const caller = await redirectCaller(dependencies, record);
  const deps = developerTaskRouteDependencies({
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks: developerTaskActions(dependencies),
    ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
  }, caller, undefined, null);
  return { deps: { ...deps, sessionActor: { developerId: record.actorId } }, caller };
}

/** The task module's restarts for this broker. A task is read again by each (at the revision the redirect recorded); the `task` argument is only what the caller judged. */
export function redirectRestartHost(dependencies: AwsBrokerDependencies): RedirectRestartHost {
  return {
    planning: async (_task, record, text) => { const { deps, caller } = await restartDependencies(dependencies, record); await restartPlanningForRedirect(deps, caller, record, text); },
    coding: async (_task, record, ownerRedirect) => { const { deps, caller } = await restartDependencies(dependencies, record); await restartCodingForRedirect(deps, caller, record, ownerRedirect); },
    sendBack: async (_task, record, ownerRedirect) => { const { deps, caller } = await restartDependencies(dependencies, record); await sendBackForRedirect(deps, caller, record, ownerRedirect); },
    revise: async (_task, record, text) => { const { deps, caller } = await restartDependencies(dependencies, record); await revisePlanForRedirect(deps, caller, record, text); },
  };
}

function continueDependencies(dependencies: AwsBrokerDependencies, config: Pick<RedirectConfig, "workerFeatures">): RedirectContinueDependencies {
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, config, host: redirectRestartHost(dependencies),
    ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
  };
}

/**
 * The redirect's outside world, or undefined: the switch `rd` (the broker's `LIVE_REDIRECT_ENABLED`) is on only when it is exactly "1". Off, nothing is built or registered, the route does not exist
 * and no terminal result looks for a redirect. Turn it on only after the dispatcher and the worker image that carry `task.ownerRedirect.v1` are deployed, and the broker can reach the workers' /ping.
 */
export function redirectFromEnvironment(dependencies: AwsBrokerDependencies, env: Record<string, string | undefined> = process.env): RedirectConfig | undefined {
  if (!liveInteractionFlagOn(env[LIVE_INTERACTION_FLAGS.redirect.variable])) {
    registerRedirectContinuation(dependencies.documentClient, undefined);
    return undefined;
  }
  const probe = { workerFeatures: (task: DeveloperTaskRecord) => workspaceWorkerFeatures(dependencies, task) };
  const continuation = async (taskId: string): Promise<void> => { await continueRedirect(continueDependencies(dependencies, probe), taskId); };
  registerRedirectContinuation(dependencies.documentClient, continuation);
  return { ...probe, continueRedirect: continuation };
}

/** The session sweep's share: closes the redirects nobody finished. Does nothing (reads nothing) while the switch is off. Answers how many it closed. */
export async function sweepRedirects(dependencies: AwsBrokerDependencies, env: Record<string, string | undefined> = process.env): Promise<number> {
  if (!liveInteractionFlagOn(env[LIVE_INTERACTION_FLAGS.redirect.variable])) return 0;
  return sweepStoppingRedirects({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) });
}

