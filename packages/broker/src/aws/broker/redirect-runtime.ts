// Stop & redirect, the broker's side of the world (live-interaction design 3.7, switch `rd`): what the redirect needs that is not the table. Built once with the broker's dependencies and handed to
// the session routes as `redirect`; absent while the switch is off, and then the route does not exist, no terminal result looks for a redirect, and the sweep does nothing.
//   - the worker probe (phase 1 and phase 2 refuse a coding redirect for a worker that does not list `task.ownerRedirect.v1`);
//   - phase 2: the hook the terminal-result path and the stuck-cancel path call once a stop has landed (registered against the broker's table client), and the task module's restarts, acting as the
//     person who redirected;
//   - the sweep that closes a redirect nobody finished.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, agentXError, liveInteractionFlagOn, LIVE_INTERACTION_FLAGS, orgMemberKey, workspaceSessionKey, type DeveloperSignInMethod, type RedirectRecord } from "@agentx/contracts";
import { continueRedirect, sweepStoppingRedirects, type RedirectContinueDependencies, type RedirectRestartHost } from "../../agent-sessions/redirect-continue.js";
import { registerRedirectContinuation } from "../../agent-sessions/redirect-hook.js";
import { redirectRestartingCheck } from "../../agent-sessions/redirect-state.js";
import type { RedirectConfig } from "../../agent-sessions/redirect.js";
import { requireProjectSendBackRole } from "../../developer/task-access.js";
import { safeDisplayName } from "../../developer/person-name.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { developerTaskRouteDependencies, type DeveloperCaller } from "../developer-routes.js";
import { restartCodingForRedirect, restartPlanningForRedirect, revisePlanForRedirect, sendBackForRedirect } from "../developer-tasks/redirect-restart.js";
import type { DeveloperTaskRouteDependencies } from "../developer-tasks/types.js";
import { sharedAccessCheck } from "../developer-tasks/workflow-coding.js";
import { developerTaskActions } from "./dependency-wiring.js";
import type { AwsBrokerDependencies } from "./definitions.js";

/**
 * What the worker of the task's workspace listed on /ping when its session became READY, or `undefined` when that is not known: the workspace has no READY session, or the session was recorded without a list
 * (it became READY before the session manager recorded one). Nothing here reaches the worker (the broker has no network path to port 8080: the session manager, which does, records the list on the session,
 * LR-1) and nothing starts compute. Unknown is a refusal for the caller (fail closed), never a guess.
 */
export async function workspaceWorkerFeatures(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName">, task: Pick<DeveloperTaskRecord, "workspaceId">): Promise<readonly string[] | undefined> {
  const session = ((await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: workspaceSessionKey(task.workspaceId), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (session?.["state"] !== "READY") return undefined;
  const listed = session["workerFeatures"];
  // A list that is not an array of strings is damaged, not empty: unknown.
  if (!Array.isArray(listed) || !listed.every((feature): feature is string => typeof feature === "string")) return undefined;
  return listed;
}

/** What a person who is no longer a member, or whose sign-in was revoked, is told: not retryable (N4). */
const REDIRECT_AUTHOR_GONE = "You can't redirect this task: you are no longer a member of this organization, or your access was ended.";

/**
 * The person who redirected, as a task caller: their live org role and their name and Slack identity as the sign-in record keeps them. A person who is no longer a member of the org is no caller: the restart throws, and
 * the redirect ends with the step left stopped.
 */
async function redirectCaller(dependencies: AwsBrokerDependencies, record: Pick<RedirectRecord, "orgId" | "actorId">): Promise<DeveloperCaller> {
  const member = ((await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: orgMemberKey(record.orgId, record.actorId), ConsistentRead: true }))) as { Item?: { role?: unknown } }).Item;
  const role = member?.role;
  if (role !== "owner" && role !== "admin" && role !== "member") throw agentXError("FORBIDDEN", REDIRECT_AUTHOR_GONE);
  const developer = dependencies.developer === undefined ? undefined
    : ((await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.developer.signInTableName, Key: { pk: `DEVELOPER#${record.actorId}`, sk: "META" }, ConsistentRead: true }))) as { Item?: { displayName?: unknown; provider?: unknown; slackUserId?: unknown; revoked?: unknown } }).Item;
  // A person whose sign-in was revoked is no caller, as `callerFor` of the agent runs counts them (SB-1): the restart throws and the redirect ends with the step left stopped.
  if (developer?.revoked === true) throw agentXError("FORBIDDEN", REDIRECT_AUTHOR_GONE);
  const provider: DeveloperSignInMethod = developer?.provider === "slack" || developer?.provider === "cloud" || developer?.provider === "github" || developer?.provider === "saml" ? developer.provider : "oidc";
  return {
    developerId: record.actorId, sessionId: "redirect", amr: provider, name: safeDisplayName(typeof developer?.displayName === "string" ? developer.displayName : "", record.actorId), orgId: record.orgId, orgRole: role,
    // As a signed-in request carries it: the project access check reads a Slack channel's contributor access through it, and the send-back gate (0.4.27) needs that access.
    ...(typeof developer?.slackUserId === "string" && developer.slackUserId !== "" ? { slackUserId: developer.slackUserId } : {}),
  };
}

/**
 * The task module's dependencies for the person's restart: the broker's own, with the person as the session actor (see `isSessionActor`: the redirect checked that they own the task). Given the redirect, every
 * transaction that starts a run carries a condition that the redirect is still `restarting`, so a Stop that ended it between the claim and the commit stops the restart (LR-3, B1 residual).
 */
async function restartDependencies(dependencies: AwsBrokerDependencies, record: Pick<RedirectRecord, "orgId" | "actorId"> & Partial<Pick<RedirectRecord, "taskId" | "requestId">>): Promise<{ deps: DeveloperTaskRouteDependencies; caller: DeveloperCaller }> {
  if (dependencies.developer === undefined) throw new Error("developer sign-in is not set up in this deployment");
  const caller = await redirectCaller(dependencies, record);
  const tasks = developerTaskActions(dependencies);
  const guard = record.taskId === undefined || record.requestId === undefined ? undefined : redirectRestartingCheck(dependencies, { taskId: record.taskId, requestId: record.requestId });
  const guarded = guard === undefined ? tasks : {
    ...tasks,
    acceptTask: (...args: Parameters<typeof tasks.acceptTask>): ReturnType<typeof tasks.acceptTask> => {
      const [identity, workspaceId, request, extra, options] = args;
      return tasks.acceptTask(identity, workspaceId, request, (operation) => [...(extra?.(operation) ?? []), guard], options);
    },
  };
  const deps = developerTaskRouteDependencies({
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks: guarded,
    ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
  }, caller, undefined, null);
  return { deps: { ...deps, sessionActor: { developerId: record.actorId, requireOwner: true } }, caller };
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

/**
 * What the redirect asks of the world that is not the table: the worker's features and, for a redirect that restarts the checks or the review as a send-back, whether the person may send back (the gate of
 * 0.4.27, asked live for the person as the restart asks it). A person who cannot be read as a caller is refused as an unreadable role (retryable), never let through.
 */
function redirectProbe(dependencies: AwsBrokerDependencies): Pick<RedirectConfig, "workerFeatures" | "sendBackAllowed"> {
  return {
    workerFeatures: (task: DeveloperTaskRecord) => workspaceWorkerFeatures(dependencies, task),
    sendBackAllowed: async (task, who) => {
      let restart: Awaited<ReturnType<typeof restartDependencies>>;
      try {
        restart = await restartDependencies(dependencies, { orgId: who.orgId, actorId: who.developerId });
      } catch (error) {
        // A person who is gone or revoked is refused for good; anything else is a fault to try again (N4).
        if (error instanceof AgentXError && error.code === "FORBIDDEN") throw error;
        throw agentXError("RUNTIME_UNAVAILABLE", "your role in this project could not be checked; try again in a moment");
      }
      await requireProjectSendBackRole(sharedAccessCheck(restart.deps), task, restart.caller);
    },
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
 * and no terminal result looks for a redirect. Turn it on only after the dispatcher and the worker image that carry `task.ownerRedirect.v1` are deployed and the session manager records worker features on the session (workers already READY have none recorded until their next start, and a redirect on them is refused).
 */
export function redirectFromEnvironment(dependencies: AwsBrokerDependencies, env: Record<string, string | undefined> = process.env): RedirectConfig | undefined {
  if (!liveInteractionFlagOn(env[LIVE_INTERACTION_FLAGS.redirect.variable])) {
    registerRedirectContinuation(dependencies.documentClient, undefined);
    return undefined;
  }
  const probe = redirectProbe(dependencies);
  const continuation = async (taskId: string): Promise<void> => { await continueRedirect(continueDependencies(dependencies, probe), taskId); };
  registerRedirectContinuation(dependencies.documentClient, continuation);
  return { ...probe, continueRedirect: continuation };
}

/**
 * The session sweep's share: closes the redirects nobody finished. Does nothing (reads nothing) while the switch is off. Answers how many it closed. `budgetMs` is what is left of the broker's 30 seconds for it
 * (LR-3 N2): no redirect is started once it is used, and one that has started may run over by a probe and a restart.
 */
export async function sweepRedirects(dependencies: AwsBrokerDependencies, env: Record<string, string | undefined> = process.env, budgetMs?: number): Promise<number> {
  if (!liveInteractionFlagOn(env[LIVE_INTERACTION_FLAGS.redirect.variable])) return 0;
  const probe = redirectProbe(dependencies);
  // The Reconciler Lambda blocks a step whose cancel got stuck and runs no continuation of its own (it has no task wiring): this sweep, in the broker, picks the redirect up.
  return sweepStoppingRedirects({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) },
    (taskId) => continueRedirect(continueDependencies(dependencies, probe), taskId), budgetMs === undefined ? {} : { budgetMs });
}

/** What the session sweep leaves for the redirect sweep while `rd` is on: the broker's timeout is 30 s, the sweep and drain use up to 25, and one redirect (a 3 s probe and a restart) needs a few seconds. */
export const REDIRECT_SWEEP_RESERVE_MS = 5_000;
/** The redirect sweep's budget once the session sweep and drain are done: the broker's 30 seconds, less a safety margin for the redirect in flight, less what was used. At least a second, so every tick looks at one. */
export const redirectSweepBudgetMs = (usedMs: number): number => Math.max(1_000, 30_000 - 6_000 - usedMs);
/** What to hold back from the drain for the redirect sweep: nothing while the switch is off. */
export const redirectSweepReserveMs = (env: Record<string, string | undefined> = process.env): number => (liveInteractionFlagOn(env[LIVE_INTERACTION_FLAGS.redirect.variable]) ? REDIRECT_SWEEP_RESERVE_MS : 0);

