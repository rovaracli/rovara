// S3 items a, b, c and f: how the broker's Lambda reaches the Cloud root. Everything here is behind the combined switch (`CLOUD_CORE_ENGINE`, off by default): with the switch off
// `createCloudCoreEntry` answers `undefined`, builds nothing, and no hook below is installed, so every start and every Slack request is exactly what it was.
//
//   a  the start hook     `createCoreIntentHook`: `startCodeIntent` (the one entry of every Rovara Code start: the app, Slack, the CLI, MCP) asks it first. When the switch says `core` for
//                         the company it starts the task on the core (`runtime.flow.start`) and answers as `startCodeIntent` answers; anything else stays on Cloud's path.
//   b  the Slack consumer `createCoreSlackConsumer`: a plain top-level Slack request, which the ingress would have sent to the classifier queue, goes to the core's channel sink when the switch
//                         says `core` for the company of the Slack team. A refusal the core throws is told in the thread (the ingress posts `reply`) and never escapes, so the queue does not retry it.
//                         `coreSlackFromIngress` is the ingress Lambda's half (a direct broker invoke, like `start-workflow`).
//   c  the Lambda entry   `createCloudCoreEntry`: builds the app once per container (the registry and each company's runtime build on first use), answers the scheduled core jobs and the Slack
//                         request, and hands the broker its start hook. Infrastructure (the stack parameter, the schedules, the Lambda wiring) is not here.
//   f  the wiring         `cloudCoreWiringFromBroker`: Cloud's own people, code settings, task end, channel rules, Slack standing and task access, from the broker's dependencies where they
//                         exist. What does not exist yet is an explicit input of `CloudCoreEntryInputs`, never a default.
import { AgentXError, SessionIdSchema, orgProjectCatalogKey, projectMemberKey, projectMetaKey, when, sessionLink, type CodeIntentRequest, type CodeIntentResult, type OrgId, type Principal, type SlackRequestMessage } from "@rovara-code/contracts";
import { recordTaskThread } from "@rovara-code/broker/core/channel";
import { taskSessionId } from "@rovara-code/broker/core/sessions";
import type { TaskAccess } from "@rovara-code/broker/core/task-flow";
import { SLACK_NOT_A_MEMBER_NOTICE, orgMemberKey, type DeveloperTaskView } from "@agentx/cloud-contracts";
import { agentRunStarterOf, developerTaskRouteDependencies } from "../../aws/developer-routes/dependencies.js";
import { authorizeTaskAction } from "../../aws/developer-tasks/access.js";
import { checkProjectAccess } from "../../aws/developer-routes/project-access.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../../aws/developer-routes/types.js";
import { slackRequesterStanding, slackTeamOrg } from "../../aws/broker/dependency-wiring.js";
import type { AwsBrokerDependencies } from "../../aws/broker/definitions.js";
import { readCodeSettings } from "../../rovara-code/code-settings.js";
import type { CoreIntentHook } from "../../rovara-code/intent.js";
import { requireNewWorkAllowed } from "../../developer/project-roles.js";
import { tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { onTaskEnded, type TaskEndHost } from "../../agents/task-end.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { createCloudIdentityProvider, principalOfCaller } from "../adapters/people/index.js";
import { createCloudApp, type CloudApp } from "./app.js";
import { CORE_SLACK_ACTION, type CoreSlackRequestEvent } from "./slack-ingress-hook.js";

export { CORE_SLACK_ACTION, coreSlackFromIngress, type CoreSlackFromIngressDeps, type CoreSlackRequestEvent } from "./slack-ingress-hook.js";
import { cloudAdapterModules, type CloudModuleDeps } from "./cloud-modules.js";
import { anyCoreAreaOn, coreAreaOn, readCoreEngineFlags } from "./flags.js";
import { isCoreJobEvent } from "./jobs.js";
import { createCloudMergePeople } from "./merge-people.js";
import { cloudWordsForCoreRefusal } from "./refusal-words.js";
import { cloudCoreRuntime, type CloudCoreWiring } from "./runtime.js";
import { cloudTaskFacts } from "./task-facts.js";
import { cloudSettingsFromEnvironment, type CloudCompanySettings } from "./settings-mapping.js";
import type { CloudAdapterContext } from "./registry.js";

// ---- a: the start hook ----

/** The sources that are a person's own coding start (the same set `startWithoutAgents` takes). Linear and offers need the payer rules and stay on Cloud's path. */
const CORE_INTENT_SOURCES: ReadonlySet<CodeIntentRequest["source"]> = new Set(["app", "cli", "mcp", "slack"]);

/**
 * Whether a Rovara Code intent is one the core takes. A follow-up (`retryOf`), a hand-off (`startAt`), a design-first start, a start with attached context and a source that needs
 * the payer rules stay on Cloud's path: each needs something the core's start does not carry.
 */
export function coreIntentApplies(request: CodeIntentRequest): boolean {
  return CORE_INTENT_SOURCES.has(request.source) && request.retryOf === undefined && request.startAt === undefined && request.designFirst !== true
    && (request.input.context === undefined || request.input.context.length === 0);
}

export interface CoreIntentHookDeps {
  app: CloudApp;
  /** Lane A6: the person as the core knows them (`principalOfCaller`). */
  principalOf: (caller: DeveloperCaller) => Promise<Principal>;
  /** The origin session links are made from. */
  origin: string;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}

export function createCoreIntentHook(deps: CoreIntentHookDeps): CoreIntentHook {
  return {
    async start({ caller, request, ownedTask }): Promise<CodeIntentResult<DeveloperTaskView> | undefined> {
      if (!deps.app.active || !coreIntentApplies(request)) return undefined;
      if (deps.app.engineForNewTask(caller.orgId) !== "core") return undefined;
      let runtime;
      try {
        runtime = await deps.app.runtimeFor(caller.orgId);
      } catch (error) {
        // A root that cannot be built (a point is empty, a client failed) leaves the switch effectively off: the start goes on Cloud's path, and a person is never refused for it.
        deps.log({ event: "core_entry.runtime_unavailable", component: "cloud_core", error: error instanceof Error ? error.name : "unknown" });
        return undefined;
      }
      const principal = await deps.principalOf(caller);
      const started = await runtime.flow.start({ principal, client: request.source }, {
        requestId: request.requestId, project: request.project, instructions: request.input.text, workflow: true, client: request.source,
        ...(request.path === undefined ? {} : { workflowPath: request.path }),
      });
      const taskId = started.task.taskId;
      const sessionId = SessionIdSchema.parse(taskSessionId(taskId));
      // A task started from a Slack thread is told there (the plan card, the milestones): the thread is remembered with the task, as the channel work does for a message.
      if (request.binding?.kind === "slack_thread") {
        const store = (await deps.app.registry()).require("storage");
        await recordTaskThread({ store, orgId: caller.orgId, now: deps.now }, {
          sessionId, conversation: { channel: "slack", tenant: request.binding.teamId, space: request.binding.channelId, thread: request.binding.threadTs }, personId: caller.developerId,
        });
      }
      return { task: await ownedTask(caller, taskId), sessionId, sessionUrl: sessionLink(deps.origin, sessionId) };
    },
  };
}

// ---- b: the Slack consumer ----


export function isCoreSlackRequestEvent(event: unknown): event is CoreSlackRequestEvent {
  if (event === null || typeof event !== "object") return false;
  const value = event as { source?: unknown; action?: unknown; message?: unknown; requestContext?: unknown };
  return value.source === "agentx.slack-ingress" && value.action === CORE_SLACK_ACTION && value.requestContext === undefined && typeof value.message === "object" && value.message !== null;
}

/** `handled: false`: the request is Cloud's, the ingress goes on as before. `reply`: what to say in the thread (a refusal, in Cloud's words); the request is handled either way. */
export type CoreSlackAnswer = { handled: false } | { handled: true; reply?: string };

/** A refusal is the core saying no in words for a person (a limit, a missing project, money): an `AgentXError`. A fault of the install or the network is not, and is allowed to fail the call. */
const isCoreRefusal = (error: unknown): error is AgentXError => error instanceof AgentXError && error.code !== "RUNTIME_UNAVAILABLE";

export interface CoreSlackConsumerDeps {
  app: CloudApp;
  /** `OrgStore.orgForSlackTeam`. */
  orgOfTeam: (teamId: string) => Promise<OrgId | undefined>;
  log: (entry: Record<string, unknown>) => void;
}

export function createCoreSlackConsumer(deps: CoreSlackConsumerDeps): (message: SlackRequestMessage) => Promise<CoreSlackAnswer> {
  return async (message) => {
    if (!deps.app.active) return { handled: false };
    const orgId = await deps.orgOfTeam(message.thread.teamId);
    if (orgId === undefined || !coreAreaOn(deps.app.flags, "flow", orgId)) return { handled: false };
    let intake: ((request: SlackRequestMessage) => Promise<void>) | undefined;
    try {
      intake = (await deps.app.runtimeFor(orgId)).inbound.slack;
    } catch (error) {
      deps.log({ event: "core_entry.runtime_unavailable", component: "cloud_core", error: error instanceof Error ? error.name : "unknown" });
      return { handled: false };
    }
    if (intake === undefined) return { handled: false };
    try {
      await intake(message);
      return { handled: true };
    } catch (error) {
      if (!isCoreRefusal(error)) throw error;
      deps.log({ event: "core_entry.slack_refused", component: "cloud_core", code: error.code });
      return { handled: true, reply: cloudWordsForCoreRefusal({ code: error.code, message: error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message }) };
    }
  };
}

// ---- f: Cloud's rules for the core, from the broker's dependencies ----

/**
 * Who may start work on a project and who may act on a task, for the core's flow (`TaskAccess`). The start is Cloud's own rule: the person's project role and `requireNewWorkAllowed`
 * (an archived project, a role that may not start work), the same two checks `startTask` makes. Acting on a task is v2's set, the task's owner and its co-owners; a project maintainer's one
 * seat (a coding plan) is the decision gate's live check at the moment of a decision. A person who cannot be found as a caller is refused.
 */
export function cloudTaskAccess(routesOf: () => DeveloperRouteDependencies): TaskAccess {
  const callerOf = async (principal: Principal): Promise<DeveloperCaller | undefined> => await agentRunStarterOf(routesOf())?.callerFor(principal.companyId, principal.personId);
  return {
    async checkStart(principal, project) {
      const caller = await callerOf(principal);
      if (caller === undefined) return { allowed: false, code: "FORBIDDEN", message: "you are not a member of this company" };
      try {
        const routes = routesOf();
        const access = await checkProjectAccess(routes, caller, project, undefined, undefined);
        await requireNewWorkAllowed(developerTaskRouteDependencies(routes, caller), caller.orgId, project, access.role, "task");
        return { allowed: true };
      } catch (error) {
        if (error instanceof AgentXError) return { allowed: false, code: error.code, message: error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message };
        throw error;
      }
    },
    // v2's set: the task's owner and its co-owners, and no one else (a company owner or admin included: a maintainer's one seat is the decision gate's, for a coding plan). Cloud's own `close` action,
    // read live: the task in the person's company, they own it or sit on its People list as an owner, and they are still a member.
    async canAct(principal, task) {
      const taskId = (task as { taskId?: unknown }).taskId;
      if (typeof taskId !== "string") return false;
      const caller = await callerOf(principal);
      if (caller === undefined) return false;
      try {
        await authorizeTaskAction(developerTaskRouteDependencies(routesOf(), caller), caller, taskId, "close");
        return true;
      } catch {
        return false;
      }
    },
    // Switch blocker 1: v2's dispatch check (aws/task-person-runtime.ts: the owner's membership, their project authority and the project's own switches, read now), fenced into the step's own
    // transaction. The person the step runs for is the task's owner NOW (a taker after a take-over), read as a live caller: removed, revoked, moved or demoted to Auditor, they are not found or hold no
    // project role; the project must still take new work (not archived; tasks on; a role that may start tasks). The fence is `items`: the owner's member record, their grant, the project's latest
    // revision and its archive status, as read here, so a change between this check and the step's commit refuses the step.
    async checkStep(task) {
      const record = task as unknown as DeveloperTaskRecord & { companyId?: string };
      const orgId = (record.orgId ?? record.companyId);
      const owner = tryEffectiveTaskOwner(record);
      if (orgId === undefined || owner === undefined) return { allowed: false, message: "the person this task runs for could not be found" };
      const routes = routesOf();
      const caller = await agentRunStarterOf(routes)?.callerFor(orgId, owner.developerId);
      if (caller === undefined) return { allowed: false, message: "the person this task runs for is no longer a member of the company" };
      try {
        const access = await checkProjectAccess(routes, caller, record.project, undefined, undefined);
        await requireNewWorkAllowed(developerTaskRouteDependencies(routes, caller), orgId, record.project, access.role, "task");
        const orgMaintainer = caller.orgRole === "owner" || caller.orgRole === "admin";
        return {
          allowed: true,
          items: [
            { kind: "check", key: orgMemberKey(orgId, owner.developerId), condition: when.eq("role", caller.orgRole) },
            ...(orgMaintainer ? [] : [{ kind: "check" as const, key: projectMemberKey(orgId, owner.developerId, record.project), condition: when.present() }]),
            { kind: "check", key: orgProjectCatalogKey(orgId, record.project), condition: when.eq("latestRevision", access.revision) },
            { kind: "check", key: projectMetaKey(orgId, record.project), condition: when.or(when.absent(), when.eq("status", "active")) },
          ],
        };
      } catch (error) {
        if (error instanceof AgentXError) return { allowed: false, message: error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message };
        throw error;
      }
    },
  };
}

/** What the entry needs that does not exist in Cloud yet, or exists only per request. Each is an explicit input; the entry builds nothing without them. */
export interface CloudCoreEntryInputs {
  /** The adapter modules' deployment inputs: the clients and option bags (`CloudModuleDeps`). Built once per container when the first core request arrives. */
  moduleDeps: () => CloudModuleDeps;
  /** What a task's session shows. Absent: Cloud's own (`cloudTaskFacts`, over the task rows the core writes). */
  sessionFacts?: CloudCoreWiring["sessionFacts"] | undefined;
  /** The company's pinned Rovara Code recipe's step kinds (decides Understand and the plan check); undefined: Cloud's journey install, which has none. */
  recipeStepKinds?: ((companyId: OrgId) => readonly string[] | undefined) | undefined;
  /** The agent runs host the end of a core task tells (`TaskEndHost`); absent: the end is recorded and the handlers told as Cloud's end bookkeeping does with none. */
  agentRuns?: TaskEndHost | undefined;
  /** The page link a notice carries, footer, address and urgency rules (Cloud's notifier words). Absent: the notice has no link and uses the install's fixed footer. */
  notices?: CloudCoreWiring["notices"];
  /** The chain runner's and the unattended door's dependencies for the `automation-stop` job (143c). Absent: the job is skipped. */
  automation?: CloudCoreWiring["automation"];
  /** The origin session links are made from. Default: the sign-in issuer's origin. */
  origin?: string;
}

export interface CloudCoreWiringSources {
  broker: AwsBrokerDependencies;
  routes: () => DeveloperRouteDependencies | undefined;
  inputs: CloudCoreEntryInputs;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
}

/** Cloud's wiring for the core's runtime (`CloudCoreWiring`) from what the broker already has. See `CloudCoreEntryInputs` for what it cannot supply. */
export function cloudCoreWiringFromBroker(sources: CloudCoreWiringSources): CloudCoreWiring {
  const { broker, inputs, env, now, log } = sources;
  const routes = (): DeveloperRouteDependencies => {
    const found = sources.routes();
    if (found === undefined) throw new Error("the developer API is not configured: the core has no people to decide with");
    return found;
  };
  const table = { documentClient: broker.documentClient, tableName: broker.tableName };
  const memberDeps = { ...table, now: () => now().getTime() };
  const identity = (): ReturnType<typeof createCloudIdentityProvider> => createCloudIdentityProvider(routes());
  const slackLimits = broker.slack === undefined ? undefined : { member: broker.slack.memberWorkspaceLimit, organization: broker.slack.organizationWorkspaceLimit };
  const settings = (companyId: OrgId): CloudCompanySettings => cloudSettingsFromEnvironment(env, {
    recipeStepKinds: inputs.recipeStepKinds?.(companyId),
    // Cloud serves a connector write behind a person's approval (its approvers adapter is registered).
    connectorWritesBehindApproval: true,
    ...(slackLimits === undefined ? {} : { workspaceLimits: slackLimits }),
  });
  return {
    settings,
    callbackSigningKey: broker.callbackSigningKey,
    repositoryGrantKey: Buffer.alloc(32),
    repositoryCredential: async () => { throw new Error("the core's repository grants are Cloud's (flowOptions.repositoryGrants)"); },
    access: cloudTaskAccess(routes),
    now, log,
    people: createCloudMergePeople(memberDeps),
    codeSettings: { read: async (orgId, project) => await readCodeSettings(table, orgId, project) },
    taskEnd: {
      readTask: async (taskId) => (await broker.documentClient.send(new GetCommand({ TableName: broker.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true }))).Item,
      onTaskEnded: async (task, outcome) => { await onTaskEnded({ ...table, now: memberDeps.now, log: (event, fields) => log({ event, ...fields }), ...(inputs.agentRuns === undefined ? {} : { agentRuns: inputs.agentRuns }) }, task as never, outcome); },
    },
    sessionFacts: inputs.sessionFacts ?? cloudTaskFacts(routes),
    ...(inputs.notices === undefined ? {} : { notices: inputs.notices }),
    channels: {
      // Owner decision 131: a chat tenant is the company the Slack team is bound to; nobody's otherwise.
      companyOf: async ({ tenant }) => await slackTeamOrg(broker, tenant).catch(() => undefined),
    },
    slack: {
      orgOfTeam: async (teamId) => await slackTeamOrg(broker, teamId).catch(() => undefined),
      // `slackRequesterStanding` reduced to the person it names: the survivor of the merges and links, or a throw for anyone it refuses (a removed, banned or unlinked account).
      standingOf: async (orgId, slackUserId) => {
        const standing = await slackRequesterStanding(broker, slackUserId, orgId);
        return standing.ids.at(-1)!;
      },
      principalOf: async (orgId, personId) => await identity().getPrincipal(orgId, personId),
      // Cloud cannot redeem a channel link code: the unlinked are told what Cloud tells them today, never a code (A8 gap).
      linkWords: () => SLACK_NOT_A_MEMBER_NOTICE,
    },
    ...(inputs.automation === undefined ? {} : { automation: inputs.automation }),
    flowOptions: { repositoryGrants: broker.repositoryGrants },
  };
}

// ---- c: the Lambda entry ----

export interface CloudCoreEntry {
  readonly app: CloudApp;
  /** Install this as `dependencies.coreStart`. */
  readonly intentHook: CoreIntentHook;
  /** The broker's answer to the ingress's `core-slack-request` event. */
  slackRequest(message: SlackRequestMessage): Promise<CoreSlackAnswer>;
  /** An EventBridge event: `undefined` when it is not a core job's. */
  handleScheduledJob(event: unknown): Promise<unknown>;
  isScheduledJob(event: unknown): boolean;
}

export interface CreateCloudCoreEntryOptions extends CloudCoreWiringSources {
  /** The company an install has (ruling R3); adapters still take the company from each call. */
  installCompanyId: OrgId;
}

/**
 * The broker's core entry, once per container. `undefined` while the combined switch is off everywhere: nothing is built, no hook is installed and the broker behaves exactly as before.
 * The registry and each company's runtime build on first use, so a deployment that has the switch on but is missing an input fails there (the point is named), and every start and Slack
 * request in the meantime stays on Cloud's path.
 */
export function createCloudCoreEntry(options: CreateCloudCoreEntryOptions): CloudCoreEntry | undefined {
  // Off (the default): nothing below runs.
  if (!anyCoreAreaOn(readCoreEngineFlags(options.env))) return undefined;
  let modules;
  try {
    modules = cloudAdapterModules(options.inputs.moduleDeps());
  } catch (error) {
    // An input the deployment has not given: the switch is effectively off here, and every start and Slack request stays on Cloud's path.
    options.log({ event: "core_entry.not_configured", component: "cloud_core", error: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
  const context = (): CloudAdapterContext => ({ installCompanyId: options.installCompanyId, now: options.now, env: options.env, clients: {}, log: options.log });
  const app = createCloudApp({ env: options.env, nowMs: () => options.now().getTime(), modules, context, runtime: cloudCoreRuntime(cloudCoreWiringFromBroker(options)) });
  const routesOf = (): DeveloperRouteDependencies => {
    const routes = options.routes();
    if (routes === undefined) throw new Error("the developer API is not configured");
    return routes;
  };
  const origin = options.inputs.origin ?? new URL(options.broker.developer?.issuer ?? "https://localhost").origin;
  return {
    app,
    intentHook: createCoreIntentHook({ app, principalOf: async (caller) => await principalOfCaller(routesOf(), caller), origin, now: () => options.now().getTime(), log: options.log }),
    slackRequest: createCoreSlackConsumer({ app, log: options.log, orgOfTeam: async (teamId) => await slackTeamOrg(options.broker, teamId).catch(() => undefined) }),
    isScheduledJob: isCoreJobEvent,
    handleScheduledJob: async (event) => await app.handleScheduledJob(event),
  };
}
